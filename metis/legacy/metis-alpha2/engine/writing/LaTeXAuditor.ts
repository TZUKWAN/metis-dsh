/**
 * LaTeX Auditor — pre-submission cleanup and sanity checks for LaTeX projects.
 *
 * Detects broken citations, broken cross-references, duplicate labels,
 * TODO/FIXME comments, draft artifacts, empty sections, and common style issues.
 *
 * Inspired by claude-scholar's `latex-cleanup` and ARS LaTeX hardening.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseBibTeX } from '../research/BibTeXAuditor.js';

export type LaTeXIssueType =
  | 'undefined_citation'
  | 'unused_citation'
  | 'undefined_reference'
  | 'unused_label'
  | 'duplicate_label'
  | 'empty_citation'
  | 'empty_reference'
  | 'todo_comment'
  | 'draft_artifact'
  | 'empty_section'
  | 'style_issue';

export interface LaTeXIssue {
  file: string;
  line: number;
  type: LaTeXIssueType;
  message: string;
}

export interface LaTeXCleanupResult {
  filesScanned: number;
  issueCounts: Record<LaTeXIssueType, number>;
  issues: LaTeXIssue[];
  recommendations: string[];
}

const CITE_REGEX = /\\(?:cite[pt]?|citeauthor|citeyear|parencite|textcite|footcite|autocite|citealp|citealt)\*?\s*(?:\[[^\]]*\])?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
const LABEL_REGEX = /\\label\{([^}]+)\}/g;
const REF_REGEX = /\\(?:ref|eqref|cref|Cref|pageref)\{([^}]+)\}/g;
const EMPTY_CITE_REGEX = /\\(?:cite[pt]?|citeauthor|citeyear|parencite|textcite|footcite|autocite|citealp|citealt)\*?\s*(?:\[[^\]]*\])?\s*(?:\[[^\]]*\])?\s*\{\s*\}/g;
const EMPTY_REF_REGEX = /\\(?:ref|eqref|cref|Cref|pageref)\{\s*\}/g;
const TODO_REGEX = /%\s*(TODO|FIXME|XXX)\b/gi;
const DRAFT_ARTIFACTS = [
  { regex: /\\usepackage\{draftwatermark\}/g, name: 'draftwatermark' },
  { regex: /\\usepackage\{showkeys\}/g, name: 'showkeys' },
  { regex: /\\linenumbers\b/g, name: '\\linenumbers' },
  { regex: /\\usepackage\{lineno\}/g, name: 'lineno' },
];
const STYLE_ISSUES = [
  { regex: /~\\\\/g, message: 'Use \\newline or a blank line instead of ~\\\\' },
  { regex: /(?<!\\)\.\.\.(?![.])/g, message: 'Use \\dots{} instead of three periods' },
];

interface FileScan {
  filePath: string;
  lines: string[];
  citations: Map<string, number>;
  labels: Map<string, number>;
  refs: Map<string, number>;
}

async function scanTexFiles(texDir: string): Promise<FileScan[]> {
  const results: FileScan[] = [];
  const entries = await fs.readdir(texDir, { recursive: true });
  const texFiles = entries.filter((e) => e.toLowerCase().endsWith('.tex'));

  for (const rel of texFiles) {
    const filePath = path.join(texDir, rel);
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const citations = new Map<string, number>();
    const labels = new Map<string, number>();
    const refs = new Map<string, number>();

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx] ?? '';
      const lineNumber = lineIdx + 1;

      // Citations
      let match: RegExpExecArray | null;
      CITE_REGEX.lastIndex = 0;
      while ((match = CITE_REGEX.exec(line)) !== null) {
        const keyList = match[1] ?? '';
        for (const key of keyList.split(',')) {
          const trimmed = key.trim();
          if (trimmed && !citations.has(trimmed)) citations.set(trimmed, lineNumber);
        }
      }

      // Labels
      LABEL_REGEX.lastIndex = 0;
      while ((match = LABEL_REGEX.exec(line)) !== null) {
        const key = match[1]?.trim();
        if (key && !labels.has(key)) labels.set(key, lineNumber);
      }

      // Refs
      REF_REGEX.lastIndex = 0;
      while ((match = REF_REGEX.exec(line)) !== null) {
        const key = match[1]?.trim();
        if (key && !refs.has(key)) refs.set(key, lineNumber);
      }
    }

    results.push({ filePath: rel, lines, citations, labels, refs });
  }

  return results;
}

export async function auditLaTeX(options: {
  texDir: string;
  bibPath?: string;
}): Promise<LaTeXCleanupResult> {
  const scans = await scanTexFiles(options.texDir);
  const issues: LaTeXIssue[] = [];

  // Global label/citation indexes
  const allLabels = new Map<string, { file: string; line: number }>();
  const allLabelFiles = new Map<string, string>();
  const allCitations = new Map<string, { file: string; line: number }>();
  const allRefs = new Map<string, { file: string; line: number }>();

  for (const scan of scans) {
    for (const [key, line] of scan.labels) {
      if (allLabels.has(key)) {
        const first = allLabels.get(key)!;
        issues.push({
          file: scan.filePath,
          line,
          type: 'duplicate_label',
          message: `Label "${key}" is already defined in ${first.file}:${first.line}`,
        });
      } else {
        allLabels.set(key, { file: scan.filePath, line });
        allLabelFiles.set(key, scan.filePath);
      }
    }

    for (const [key, line] of scan.citations) {
      if (!allCitations.has(key)) allCitations.set(key, { file: scan.filePath, line });
    }

    for (const [key, line] of scan.refs) {
      if (!allRefs.has(key)) allRefs.set(key, { file: scan.filePath, line });
    }
  }

  // Undefined references
  for (const [key, { file, line }] of allRefs) {
    if (!allLabels.has(key)) {
      issues.push({ file, line, type: 'undefined_reference', message: `Reference "${key}" has no corresponding \\label` });
    }
  }

  // Unused labels
  for (const [key, { file, line }] of allLabels) {
    if (!allRefs.has(key)) {
      issues.push({ file, line, type: 'unused_label', message: `Label "${key}" is defined but never referenced` });
    }
  }

  // Citation cross-check against .bib if provided
  let bibKeys: Set<string> | undefined;
  if (options.bibPath) {
    try {
      const bibText = await fs.readFile(options.bibPath, 'utf-8');
      bibKeys = new Set(parseBibTeX(bibText).map((e) => e.key));

      for (const [key, { file, line }] of allCitations) {
        if (!bibKeys.has(key)) {
          issues.push({ file, line, type: 'undefined_citation', message: `Citation key "${key}" not found in .bib file` });
        }
      }

      for (const entry of parseBibTeX(bibText)) {
        if (!allCitations.has(entry.key)) {
          issues.push({
            file: path.basename(options.bibPath),
            line: 0,
            type: 'unused_citation',
            message: `.bib entry "${entry.key}" is never cited in LaTeX source`,
          });
        }
      }
    } catch (err) {
      issues.push({
        file: path.basename(options.bibPath),
        line: 0,
        type: 'style_issue',
        message: `Could not read .bib file: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Per-file checks
  for (const scan of scans) {
    for (let lineIdx = 0; lineIdx < scan.lines.length; lineIdx++) {
      const line = scan.lines[lineIdx] ?? '';
      const lineNumber = lineIdx + 1;

      // Empty citations/refs
      EMPTY_CITE_REGEX.lastIndex = 0;
      if (EMPTY_CITE_REGEX.test(line)) {
        issues.push({ file: scan.filePath, line: lineNumber, type: 'empty_citation', message: 'Empty \\cite{} command' });
      }
      EMPTY_REF_REGEX.lastIndex = 0;
      if (EMPTY_REF_REGEX.test(line)) {
        issues.push({ file: scan.filePath, line: lineNumber, type: 'empty_reference', message: 'Empty \\ref{} command' });
      }

      // TODO/FIXME comments
      TODO_REGEX.lastIndex = 0;
      if (TODO_REGEX.test(line)) {
        issues.push({ file: scan.filePath, line: lineNumber, type: 'todo_comment', message: `Unresolved TODO/FIXME comment: ${line.trim()}` });
      }

      // Draft artifacts
      for (const artifact of DRAFT_ARTIFACTS) {
        artifact.regex.lastIndex = 0;
        if (artifact.regex.test(line)) {
          issues.push({ file: scan.filePath, line: lineNumber, type: 'draft_artifact', message: `Draft artifact detected: ${artifact.name}` });
        }
      }

      // Style issues
      for (const style of STYLE_ISSUES) {
        style.regex.lastIndex = 0;
        if (style.regex.test(line)) {
          issues.push({ file: scan.filePath, line: lineNumber, type: 'style_issue', message: style.message });
        }
      }
    }

    // Empty sections
    const sectionRegex = /\\section\{([^}]*)\}/g;
    let sectionMatch: RegExpExecArray | null;
    const content = scan.lines.join('\n');
    sectionRegex.lastIndex = 0;
    while ((sectionMatch = sectionRegex.exec(content)) !== null) {
      const title = sectionMatch[1] ?? '';
      const matchIndex = sectionMatch.index;
      const before = content.slice(0, matchIndex);
      const lineNumber = before.split('\n').length;

      // Content between this section and the next section/subsection/end
      const after = content.slice(matchIndex + sectionMatch[0].length);
      const nextSectionMatch = after.match(/\\(?:section|subsection|subsubsection|bibliography|end\{document\})/);
      const sectionBody = nextSectionMatch ? after.slice(0, nextSectionMatch.index) : after;
      const substantiveLines = sectionBody
        .split('\n')
        .filter((l) => l.trim().length > 0 && !l.trim().startsWith('%') && !l.trim().startsWith('\\label'));

      if (substantiveLines.length === 0) {
        issues.push({
          file: scan.filePath,
          line: lineNumber,
          type: 'empty_section',
          message: `Section "${title}" appears to be empty`,
        });
      }
    }
  }

  // Recommendations
  const recommendations: string[] = [];
  const counts: Record<LaTeXIssueType, number> = {
    undefined_citation: 0,
    unused_citation: 0,
    undefined_reference: 0,
    unused_label: 0,
    duplicate_label: 0,
    empty_citation: 0,
    empty_reference: 0,
    todo_comment: 0,
    draft_artifact: 0,
    empty_section: 0,
    style_issue: 0,
  };

  for (const issue of issues) {
    counts[issue.type] = (counts[issue.type] ?? 0) + 1;
  }

  if (counts.undefined_citation > 0) recommendations.push('补充 .bib 中缺失的引用条目，或删除正文中错误的 citation key。');
  if (counts.unused_citation > 0) recommendations.push('删除 .bib 中未被引用的条目，或检查是否遗漏了引用。');
  if (counts.undefined_reference > 0) recommendations.push('为未定义的 \\ref 添加对应的 \\label，或修正引用名称。');
  if (counts.duplicate_label > 0) recommendations.push('重命名重复的标签，确保每个 \\label 全局唯一。');
  if (counts.todo_comment > 0) recommendations.push('处理所有 TODO/FIXME 注释后再提交。');
  if (counts.draft_artifact > 0) recommendations.push('移除 draftwatermark、lineno、showkeys 等草稿辅助包后再提交。');
  if (counts.empty_section > 0) recommendations.push('补充空章节内容，或删除未完成的 \\section。');
  if (counts.style_issue > 0) recommendations.push('按建议修复排版和风格问题（如 ~\\\\、... 等）。');

  return { filesScanned: scans.length, issueCounts: counts, issues, recommendations };
}

export function cleanupResultToPlain(result: LaTeXCleanupResult): Record<string, unknown> {
  return {
    filesScanned: result.filesScanned,
    issueCounts: result.issueCounts,
    issues: result.issues,
    recommendations: result.recommendations,
  };
}
