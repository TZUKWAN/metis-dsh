/**
 * Table Auditor — programmatic pre-submission checks for academic tables.
 *
 * Inspired by claude-scholar's `critique-tables`. Detects missing captions/labels,
 * deprecated vertical rules, missing booktabs rules, numeric columns that should
 * use siunitx alignment, empty cells, and overly wide tables.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export type TableIssueType =
  | 'missing_caption'
  | 'missing_label'
  | 'no_booktabs'
  | 'vertical_rules'
  | 'numeric_misaligned'
  | 'empty_cells'
  | 'overly_wide_table'
  | 'duplicate_table';

export interface TableIssue {
  file: string;
  line: number;
  type: TableIssueType;
  message: string;
}

export interface TableInfo {
  sourceFile: string;
  line: number;
  environment: 'table' | 'table*' | 'standalone_tabular';
  columnSpec?: string;
  body?: string;
  columnCount?: number;
  rowCount?: number;
  caption?: string;
  label?: string;
  issues: TableIssue[];
}

export interface TableAuditResult {
  tables: TableInfo[];
  issueCounts: Record<TableIssueType, number>;
  totalIssues: number;
  recommendations: string[];
}

const TABLE_ENV_REGEX = /\\begin\{(table\*?)\}/g;
const END_TABLE_ENV_REGEX = /\\end\{(table\*?)\}/g;
const TABULAR_REGEX = /\\begin\{tabular\*?\}\s*\{([^}]*)\}([\s\S]*?)\\end\{tabular\*?\}/g;
const CAPTION_REGEX = /\\caption(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
const LABEL_REGEX = /\\label\{([^}]+)\}/g;
const BOOKTABS_RULES_REGEX = /\\(toprule|midrule|bottomrule|cmidrule)\b/;
const HLINE_REGEX = /\\hline\b/;
const EMPTY_CELL_REGEX = /(^|[^\\])&&|&\s*\\/gm;

interface RawTableBlock {
  startLine: number;
  environment: TableInfo['environment'];
  rawContent: string;
  caption?: { text: string; line: number };
  label?: { key: string; line: number };
}

function extractTableBlocks(content: string): RawTableBlock[] {
  const blocks: RawTableBlock[] = [];

  // Match table environments by tracking \begin{table} / \end{table} positions.
  let match: RegExpExecArray | null;
  const begins: { index: number; env: string; line: number }[] = [];
  TABLE_ENV_REGEX.lastIndex = 0;
  while ((match = TABLE_ENV_REGEX.exec(content)) !== null) {
    const line = content.slice(0, match.index).split('\n').length;
    begins.push({ index: match.index, env: match[1] ?? 'table', line });
  }

  const ends: { index: number; env: string }[] = [];
  END_TABLE_ENV_REGEX.lastIndex = 0;
  while ((match = END_TABLE_ENV_REGEX.exec(content)) !== null) {
    ends.push({ index: match.index, env: match[1] ?? 'table' });
  }

  // Pair begins with their nearest matching end using a simple stack.
  const endSet = new Set<number>();
  for (const b of begins) {
    const end = ends.find((e) => e.index > b.index && !endSet.has(e.index));
    if (!end) continue;
    endSet.add(end.index);
    const rawContent = content.slice(b.index, end.index + String(`\\end{${end.env}}`).length);

    // Find caption and label within the block.
    CAPTION_REGEX.lastIndex = 0;
    LABEL_REGEX.lastIndex = 0;
    const capMatch = CAPTION_REGEX.exec(rawContent);
    const labMatch = LABEL_REGEX.exec(rawContent);

    blocks.push({
      startLine: b.line,
      environment: (b.env === 'table*' ? 'table*' : 'table') as TableInfo['environment'],
      rawContent,
      caption: capMatch ? { text: capMatch[1] ?? '', line: b.line } : undefined,
      label: labMatch ? { key: labMatch[1] ?? '', line: b.line } : undefined,
    });
  }

  return blocks;
}

function getTableEnvironmentRanges(content: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  const begins: { index: number; env: string }[] = [];
  let match: RegExpExecArray | null;
  TABLE_ENV_REGEX.lastIndex = 0;
  while ((match = TABLE_ENV_REGEX.exec(content)) !== null) {
    begins.push({ index: match.index, env: match[1] ?? 'table' });
  }
  const ends: { index: number; env: string }[] = [];
  END_TABLE_ENV_REGEX.lastIndex = 0;
  while ((match = END_TABLE_ENV_REGEX.exec(content)) !== null) {
    ends.push({ index: match.index, env: match[1] ?? 'table' });
  }

  const endSet = new Set<number>();
  for (const b of begins) {
    const end = ends.find((e) => e.index > b.index && e.env === b.env && !endSet.has(e.index));
    if (!end) continue;
    endSet.add(end.index);
    ranges.push({ start: b.index, end: end.index + `\\end{${end.env}}`.length });
  }
  return ranges;
}

function extractStandaloneTabulars(content: string, sourceFile: string): TableInfo[] {
  const tables: TableInfo[] = [];
  const tableRanges = getTableEnvironmentRanges(content);
  let match: RegExpExecArray | null;
  TABULAR_REGEX.lastIndex = 0;
  while ((match = TABULAR_REGEX.exec(content)) !== null) {
    const insideTable = tableRanges.some((r) => match!.index >= r.start && match!.index < r.end);
    if (insideTable) continue;
    const line = content.slice(0, match.index).split('\n').length;
    const columnSpec = match[1] ?? '';
    const body = match[2] ?? '';
    tables.push(buildTableInfo(sourceFile, line, 'standalone_tabular', columnSpec, body));
  }
  return tables;
}

function parseColumnSpec(spec: string): { count: number; hasVerticalRules: boolean; hasNumericAlignment: boolean } {
  // Remove @{} and >{} and p/m/b widths for counting.
  const sanitized = spec
    .replace(/@[{][^}]*[}]/g, '')
    .replace(/[<>]{[^}]*}/g, '')
    .replace(/\{[^}]*\}/g, '');

  let count = 0;
  let hasVerticalRules = false;
  let hasNumericAlignment = false;
  for (const char of sanitized) {
    if ('lcrpmbSX'.includes(char)) {
      count++;
      if (char === 'S') hasNumericAlignment = true;
    }
    if (char === '|') hasVerticalRules = true;
  }
  return { count, hasVerticalRules, hasNumericAlignment };
}

function countRows(body: string): number {
  // Each newline-separated line ending with \\ is roughly a row.
  return body.split('\n').filter((line) => line.trim().endsWith('\\')).length;
}

function buildTableInfo(
  sourceFile: string,
  line: number,
  environment: TableInfo['environment'],
  columnSpec: string,
  body: string,
): TableInfo {
  const { count } = parseColumnSpec(columnSpec);
  return {
    sourceFile,
    line,
    environment,
    columnSpec,
    body,
    columnCount: count,
    rowCount: countRows(body),
    issues: [],
  };
}

function looksLikeNumericColumn(body: string): boolean {
  // Heuristic: cells contain decimals or percentages.
  const cells = body.split(/[&\\]/).map((c) => c.trim());
  const numericCells = cells.filter((c) => /^-?\d+(?:\.\d+)?\s*(?:%|\\%)?$/.test(c));
  return numericCells.length >= 2;
}

function addIssue(info: TableInfo, type: TableIssueType, message: string, counts: Record<TableIssueType, number>) {
  info.issues.push({ file: info.sourceFile, line: info.line, type, message });
  counts[type] = (counts[type] ?? 0) + 1;
}

/**
 * Audit tables in a LaTeX project.
 */
export async function auditTables(texDir: string): Promise<TableAuditResult> {
  const entries = await fs.readdir(texDir, { recursive: true });
  const texFiles = entries.filter((e) => e.toLowerCase().endsWith('.tex'));

  const tables: TableInfo[] = [];
  const seenHashes = new Map<string, string>();
  const issueCounts: Record<TableIssueType, number> = {
    missing_caption: 0,
    missing_label: 0,
    no_booktabs: 0,
    vertical_rules: 0,
    numeric_misaligned: 0,
    empty_cells: 0,
    overly_wide_table: 0,
    duplicate_table: 0,
  };

  for (const rel of texFiles) {
    const filePath = path.join(texDir, rel);
    const content = await fs.readFile(filePath, 'utf-8');

    const blocks = extractTableBlocks(content);
    for (const block of blocks) {
      let tabularMatch: RegExpExecArray | null;
      TABULAR_REGEX.lastIndex = 0;
      if ((tabularMatch = TABULAR_REGEX.exec(block.rawContent)) !== null) {
        const info = buildTableInfo(rel, block.startLine, block.environment, tabularMatch[1] ?? '', tabularMatch[2] ?? '');
        info.caption = block.caption?.text;
        info.label = block.label?.key;

        if (!block.caption) {
          addIssue(info, 'missing_caption', 'Table environment has no \\caption', issueCounts);
        }
        if (!block.label) {
          addIssue(info, 'missing_label', 'Table environment has no \\label', issueCounts);
        }

        enrichTable(info, issueCounts, seenHashes);
        tables.push(info);
      }
    }

    const standalone = extractStandaloneTabulars(content, rel);
    for (const info of standalone) {
      enrichTable(info, issueCounts, seenHashes);
      tables.push(info);
    }
  }

  const recommendations: string[] = [];
  if (issueCounts.missing_caption > 0) recommendations.push('为每个 table 环境添加 \\caption。');
  if (issueCounts.missing_label > 0) recommendations.push('为每个 table 环境添加 \\label，以便交叉引用。');
  if (issueCounts.no_booktabs > 0) recommendations.push('使用 booktabs 宏包的 \\toprule、\\midrule、\\bottomrule 替代 \\hline，表格更专业。');
  if (issueCounts.vertical_rules > 0) recommendations.push('避免在表格中使用竖线，学术排版通常推荐无竖线设计。');
  if (issueCounts.numeric_misaligned > 0) recommendations.push('数值列建议使用 siunitx 的 S 列对齐小数点。');
  if (issueCounts.empty_cells > 0) recommendations.push('检查表格中的空单元格，必要时填入 — 或说明。');
  if (issueCounts.overly_wide_table > 0) recommendations.push('过宽表格考虑转置、拆表或使用 table* / longtable。');
  if (issueCounts.duplicate_table > 0) recommendations.push('删除内容完全重复的表格或复用同一表格。');

  const totalIssues = Object.values(issueCounts).reduce((a, b) => a + b, 0);
  return { tables, issueCounts, totalIssues, recommendations };
}

function enrichTable(
  info: TableInfo,
  counts: Record<TableIssueType, number>,
  seenHashes: Map<string, string>,
): void {
  if (!info.columnSpec) return;
  const { hasVerticalRules, hasNumericAlignment } = parseColumnSpec(info.columnSpec);
  const body = info.body ?? '';

  if (hasVerticalRules) {
    addIssue(info, 'vertical_rules', 'Column spec contains vertical rules (|)', counts);
  }

  // Heuristic: numeric data without S columns.
  if (!hasNumericAlignment && looksLikeNumericColumn(body)) {
    addIssue(info, 'numeric_misaligned', 'Numeric columns should use siunitx S alignment', counts);
  }

  // Booktabs vs hline heuristic.
  const hasHline = HLINE_REGEX.test(body);
  const hasBooktabs = BOOKTABS_RULES_REGEX.test(body);
  if (hasHline && !hasBooktabs) {
    addIssue(info, 'no_booktabs', 'Use booktabs rules (\\toprule/\\midrule/\\bottomrule) instead of \\hline', counts);
  }

  // Empty cells.
  EMPTY_CELL_REGEX.lastIndex = 0;
  if (EMPTY_CELL_REGEX.test(body)) {
    addIssue(info, 'empty_cells', 'Table contains empty cells', counts);
  }

  // Overly wide tables.
  if ((info.columnCount ?? 0) > 8) {
    addIssue(info, 'overly_wide_table', `Table has ${info.columnCount} columns; consider transposing or splitting`, counts);
  }

  // Duplicate detection by normalized content hash.
  const normalized = body.replace(/\s+/g, ' ').trim();
  if (normalized.length > 0) {
    const hash = createHash('sha256').update(normalized).digest('hex');
    if (seenHashes.has(hash)) {
      addIssue(info, 'duplicate_table', `Duplicate content with ${seenHashes.get(hash)}`, counts);
    } else {
      seenHashes.set(hash, `${info.sourceFile}:${info.line}`);
    }
  }
}

export function tableAuditResultToPlain(result: TableAuditResult): Record<string, unknown> {
  return {
    totalIssues: result.totalIssues,
    issueCounts: result.issueCounts,
    tables: result.tables.map((t) => ({
      sourceFile: t.sourceFile,
      line: t.line,
      environment: t.environment,
      columnSpec: t.columnSpec,
      columnCount: t.columnCount,
      rowCount: t.rowCount,
      caption: t.caption,
      label: t.label,
      issues: t.issues,
    })),
    recommendations: result.recommendations,
  };
}
