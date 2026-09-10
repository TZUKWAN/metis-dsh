/**
 * Section Auditor — programmatic checks for academic paper structure.
 *
 * Inspired by claude-scholar's `critique-structure`. Detects missing expected
 * sections, out-of-order sections, empty sections, overly deep nesting, and
 * abstracts that are too short or too long.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type SectionIssueType =
  | 'missing_expected_section'
  | 'section_out_of_order'
  | 'empty_section'
  | 'too_many_subsections'
  | 'too_deep_nesting'
  | 'short_abstract'
  | 'long_abstract'
  | 'missing_abstract';

export interface SectionIssue {
  file: string;
  line: number;
  type: SectionIssueType;
  message: string;
}

export interface SectionInfo {
  sourceFile: string;
  line: number;
  level: number;
  title: string;
  hasContent: boolean;
}

export interface AbstractInfo {
  sourceFile: string;
  line: number;
  wordCount: number;
}

export interface SectionAuditResult {
  sections: SectionInfo[];
  abstract?: AbstractInfo;
  issueCounts: Record<SectionIssueType, number>;
  totalIssues: number;
  recommendations: string[];
}

const SECTION_REGEX = /\\(section|subsection|subsubsection|paragraph)\*?\s*\{([^}]*)\}/g;
const ABSTRACT_ENV_REGEX = /\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/g;

const EXPECTED_SECTIONS = [
  { key: 'introduction', variants: ['introduction', 'intro'] },
  { key: 'related work', variants: ['related work', 'related works', 'background', 'literature review'] },
  { key: 'methods', variants: ['methods', 'methodology', 'method', 'experimental setup', 'model'] },
  { key: 'results', variants: ['results', 'experiments', 'evaluation', 'experimental results'] },
  { key: 'discussion', variants: ['discussion'] },
  { key: 'conclusion', variants: ['conclusion', 'conclusions', 'future work'] },
];

const EXPECTED_ORDER = ['introduction', 'related work', 'methods', 'results', 'discussion', 'conclusion'];

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
}

function matchExpectedSection(title: string): string | undefined {
  const normalized = normalizeTitle(title);
  for (const expected of EXPECTED_SECTIONS) {
    for (const variant of expected.variants) {
      if (normalized.includes(variant)) return expected.key;
    }
  }
  return undefined;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

function extractAbstracts(content: string, sourceFile: string): AbstractInfo[] {
  const abstracts: AbstractInfo[] = [];
  let match: RegExpExecArray | null;
  ABSTRACT_ENV_REGEX.lastIndex = 0;
  while ((match = ABSTRACT_ENV_REGEX.exec(content)) !== null) {
    const line = content.slice(0, match.index).split('\n').length;
    abstracts.push({ sourceFile, line, wordCount: countWords(match[1] ?? '') });
  }
  return abstracts;
}

function extractSections(content: string, sourceFile: string): SectionInfo[] {
  const sections: SectionInfo[] = [];
  const lines = content.split('\n');
  let match: RegExpExecArray | null;

  SECTION_REGEX.lastIndex = 0;
  while ((match = SECTION_REGEX.exec(content)) !== null) {
    const command = match[1] ?? 'section';
    const title = match[2] ?? '';
    const line = content.slice(0, match.index).split('\n').length;
    const level =
      command === 'paragraph' ? 4 :
      command === 'subsubsection' ? 3 :
      command === 'subsection' ? 2 : 1;

    // Heuristic: a section has content if the next non-empty line is not another section command.
    let hasContent = false;
    for (let i = line; i < lines.length; i++) {
      const nextLine = lines[i]?.trim() ?? '';
      if (!nextLine) continue;
      if (/^\\(section|subsection|subsubsection|paragraph)/.test(nextLine)) break;
      hasContent = true;
      break;
    }

    sections.push({ sourceFile, line, level, title, hasContent });
  }

  return sections;
}

function addIssue(
  issues: SectionIssue[],
  counts: Record<SectionIssueType, number>,
  file: string,
  line: number,
  type: SectionIssueType,
  message: string,
) {
  issues.push({ file, line, type, message });
  counts[type] = (counts[type] ?? 0) + 1;
}

/**
 * Audit section structure of a LaTeX project.
 */
export async function auditSections(texDir: string): Promise<SectionAuditResult> {
  const entries = await fs.readdir(texDir, { recursive: true });
  const texFiles = entries.filter((e) => e.toLowerCase().endsWith('.tex'));

  const allSections: SectionInfo[] = [];
  const issues: SectionIssue[] = [];
  const issueCounts: Record<SectionIssueType, number> = {
    missing_expected_section: 0,
    section_out_of_order: 0,
    empty_section: 0,
    too_many_subsections: 0,
    too_deep_nesting: 0,
    short_abstract: 0,
    long_abstract: 0,
    missing_abstract: 0,
  };

  let abstract: AbstractInfo | undefined;

  for (const rel of texFiles) {
    const filePath = path.join(texDir, rel);
    const content = await fs.readFile(filePath, 'utf-8');

    const sections = extractSections(content, rel);
    allSections.push(...sections);

    for (const sec of sections) {
      if (!sec.hasContent) {
        addIssue(issues, issueCounts, rel, sec.line, 'empty_section', `Section "${sec.title}" appears empty`);
      }
      if (sec.level >= 4) {
        addIssue(issues, issueCounts, rel, sec.line, 'too_deep_nesting', `Deep nesting: \\paragraph "${sec.title}"`);
      }
    }

    const abstracts = extractAbstracts(content, rel);
    if (abstracts.length > 0 && !abstract) {
      abstract = abstracts[0];
    }
  }

  // Missing / ordering checks based on top-level sections only.
  const topLevel = allSections.filter((s) => s.level === 1);
  const matchedKeys = topLevel.map((s) => matchExpectedSection(s.title)).filter((k): k is string => Boolean(k));

  for (const expectedKey of EXPECTED_ORDER) {
    if (!matchedKeys.includes(expectedKey)) {
      addIssue(issues, issueCounts, topLevel[0]?.sourceFile ?? 'project', topLevel[0]?.line ?? 1, 'missing_expected_section', `Missing expected section: ${expectedKey}`);
    }
  }

  // Order check: compare indices of first appearance.
  let lastIndex = -1;
  for (const expectedKey of EXPECTED_ORDER) {
    const idx = matchedKeys.indexOf(expectedKey);
    if (idx === -1) continue;
    if (idx < lastIndex) {
      const sec = topLevel[idx]!;
      addIssue(issues, issueCounts, sec.sourceFile, sec.line, 'section_out_of_order', `Section "${sec.title}" appears out of the recommended order`);
    }
    lastIndex = idx;
  }

  // Subsection counts per top-level section.
  for (let i = 0; i < topLevel.length; i++) {
    const current = topLevel[i]!;
    const nextTop = topLevel[i + 1];
    const subsections = allSections.filter(
      (s) => s.level === 2 && s.sourceFile === current.sourceFile && s.line > current.line && (!nextTop || s.line < nextTop.line || s.sourceFile !== current.sourceFile),
    );
    if (subsections.length > 6) {
      addIssue(issues, issueCounts, current.sourceFile, current.line, 'too_many_subsections', `Section "${current.title}" has ${subsections.length} subsections; consider grouping`);
    }
  }

  // Abstract checks.
  if (!abstract) {
    addIssue(issues, issueCounts, 'project', 1, 'missing_abstract', 'No \\begin{abstract} environment found');
  } else {
    if (abstract.wordCount < 80) {
      addIssue(issues, issueCounts, abstract.sourceFile, abstract.line, 'short_abstract', `Abstract is only ${abstract.wordCount} words; consider expanding`);
    }
    if (abstract.wordCount > 300) {
      addIssue(issues, issueCounts, abstract.sourceFile, abstract.line, 'long_abstract', `Abstract is ${abstract.wordCount} words; consider shortening`);
    }
  }

  const recommendations: string[] = [];
  if (issueCounts.missing_expected_section > 0) recommendations.push('确保论文包含 Introduction、Related Work、Methods、Results、Discussion、Conclusion 等核心章节。');
  if (issueCounts.section_out_of_order > 0) recommendations.push('按 IMRaD 顺序组织章节：Introduction → Related Work → Methods → Results → Discussion → Conclusion。');
  if (issueCounts.empty_section > 0) recommendations.push('删除或填充空章节。');
  if (issueCounts.too_many_subsections > 0) recommendations.push('子章节过多时考虑合并或提升为一级章节。');
  if (issueCounts.too_deep_nesting > 0) recommendations.push('避免使用 \\paragraph 进行深层嵌套。');
  if (issueCounts.short_abstract > 0) recommendations.push('摘要建议不少于 80 词。');
  if (issueCounts.long_abstract > 0) recommendations.push('摘要建议不超过 300 词。');
  if (issueCounts.missing_abstract > 0) recommendations.push('添加 \\begin{abstract} 环境。');

  const totalIssues = Object.values(issueCounts).reduce((a, b) => a + b, 0);
  return { sections: allSections, abstract, issueCounts, totalIssues, recommendations };
}

export function sectionAuditResultToPlain(result: SectionAuditResult): Record<string, unknown> {
  return {
    totalIssues: result.totalIssues,
    issueCounts: result.issueCounts,
    abstract: result.abstract,
    sectionCount: result.sections.length,
    sections: result.sections.map((s) => ({
      sourceFile: s.sourceFile,
      line: s.line,
      level: s.level,
      title: s.title,
      hasContent: s.hasContent,
    })),
    recommendations: result.recommendations,
  };
}
