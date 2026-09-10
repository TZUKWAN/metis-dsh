/**
 * Math Auditor — programmatic checks for LaTeX math environments.
 *
 * Inspired by claude-scholar's `critique-equations`. Flags deprecated $$...$$
 * display math, deprecated eqnarray environments, unlabeled numbered equations,
 * and inline math that uses display-style commands.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type MathIssueType =
  | 'double_dollar_display'
  | 'deprecated_eqnarray'
  | 'unlabeled_numbered_equation'
  | 'display_style_inline'
  | 'split_equation_no_label'
  | 'unicode_math_character';

export interface MathIssue {
  file: string;
  line: number;
  type: MathIssueType;
  message: string;
}

export interface MathEnvironment {
  sourceFile: string;
  line: number;
  environment: string;
  hasLabel: boolean;
  issues: MathIssue[];
}

export interface MathAuditResult {
  environments: MathEnvironment[];
  inlineIssues: MathIssue[];
  issueCounts: Record<MathIssueType, number>;
  totalIssues: number;
  recommendations: string[];
}

const NUMBERED_ENVIRONMENTS = new Set([
  'equation',
  'equation*',
  'align',
  'align*',
  'aligned',
  'alignedat',
  'alignat',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'flalign',
  'flalign*',
]);

const STARRED_ENVIRONMENTS = new Set([
  'equation*',
  'align*',
  'gather*',
  'multline*',
  'flalign*',
]);

const MATH_ENV_REGEX = /\\begin\{([A-Za-z]+\*?)\}/g;
const END_ENV_REGEX = /\\end\{([A-Za-z]+\*?)\}/g;
const DOUBLE_DOLLAR_REGEX = /\$\$[\s\S]*?\$\$/g;
const LABEL_REGEX = /\\label\{([^}]+)\}/;
const DISPLAY_STYLE_INLINE_REGEX = /\$[^$]*\\displaystyle[^$]*\$/g;
const UNICODE_MATH_REGEX = /\$[^$]*[^ -~][^$]*\$/g;

interface RawMathEnv {
  name: string;
  startLine: number;
  endLine: number;
  content: string;
}

function extractMathEnvironments(content: string): RawMathEnv[] {
  const envs: RawMathEnv[] = [];
  const begins: { index: number; name: string; line: number }[] = [];
  let match: RegExpExecArray | null;

  MATH_ENV_REGEX.lastIndex = 0;
  while ((match = MATH_ENV_REGEX.exec(content)) !== null) {
    const name = match[1] ?? '';
    if (!NUMBERED_ENVIRONMENTS.has(name)) continue;
    const line = content.slice(0, match.index).split('\n').length;
    begins.push({ index: match.index, name, line });
  }

  const ends: { index: number; name: string }[] = [];
  END_ENV_REGEX.lastIndex = 0;
  while ((match = END_ENV_REGEX.exec(content)) !== null) {
    const name = match[1] ?? '';
    if (!NUMBERED_ENVIRONMENTS.has(name)) continue;
    ends.push({ index: match.index, name });
  }

  const usedEnds = new Set<number>();
  for (const b of begins) {
    const end = ends.find((e) => e.name === b.name && e.index > b.index && !usedEnds.has(e.index));
    if (!end) continue;
    usedEnds.add(end.index);
    envs.push({
      name: b.name,
      startLine: b.line,
      endLine: content.slice(0, end.index).split('\n').length,
      content: content.slice(b.index, end.index + `\\end{${end.name}}`.length),
    });
  }

  return envs;
}

function addIssue(
  issues: MathIssue[],
  counts: Record<MathIssueType, number>,
  file: string,
  line: number,
  type: MathIssueType,
  message: string,
) {
  issues.push({ file, line, type, message });
  counts[type] = (counts[type] ?? 0) + 1;
}

/**
 * Audit math usage in a LaTeX project.
 */
export async function auditMath(texDir: string): Promise<MathAuditResult> {
  const entries = await fs.readdir(texDir, { recursive: true });
  const texFiles = entries.filter((e) => e.toLowerCase().endsWith('.tex'));

  const environments: MathEnvironment[] = [];
  const inlineIssues: MathIssue[] = [];
  const issueCounts: Record<MathIssueType, number> = {
    double_dollar_display: 0,
    deprecated_eqnarray: 0,
    unlabeled_numbered_equation: 0,
    display_style_inline: 0,
    split_equation_no_label: 0,
    unicode_math_character: 0,
  };

  for (const rel of texFiles) {
    const filePath = path.join(texDir, rel);
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    let match: RegExpExecArray | null;

    DOUBLE_DOLLAR_REGEX.lastIndex = 0;
    while ((match = DOUBLE_DOLLAR_REGEX.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      addIssue(inlineIssues, issueCounts, rel, line, 'double_dollar_display', 'Use \\[...\\] or a numbered environment instead of $$...$$');
    }

    DISPLAY_STYLE_INLINE_REGEX.lastIndex = 0;
    while ((match = DISPLAY_STYLE_INLINE_REGEX.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      addIssue(inlineIssues, issueCounts, rel, line, 'display_style_inline', 'Avoid \\displaystyle inside inline math $...$');
    }

    UNICODE_MATH_REGEX.lastIndex = 0;
    while ((match = UNICODE_MATH_REGEX.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      addIssue(inlineIssues, issueCounts, rel, line, 'unicode_math_character', 'Non-ASCII character in inline math; use proper LaTeX commands or unicode-math package');
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (/\\begin\{eqnarray\}/.test(line) || /\\begin\{eqnarray\*\}/.test(line)) {
        addIssue(inlineIssues, issueCounts, rel, i + 1, 'deprecated_eqnarray', 'Use align/align* instead of deprecated eqnarray');
      }
    }

    const rawEnvs = extractMathEnvironments(content);
    for (const raw of rawEnvs) {
      const hasLabel = LABEL_REGEX.test(raw.content);
      const env: MathEnvironment = {
        sourceFile: rel,
        line: raw.startLine,
        environment: raw.name,
        hasLabel,
        issues: [],
      };

      if (!STARRED_ENVIRONMENTS.has(raw.name) && !hasLabel) {
        addIssue(env.issues, issueCounts, rel, raw.startLine, 'unlabeled_numbered_equation', `Numbered environment ${raw.name} has no \\label`);
      }

      if (raw.name === 'split' && !hasLabel) {
        addIssue(env.issues, issueCounts, rel, raw.startLine, 'split_equation_no_label', 'split environment should be wrapped in a labeled equation');
      }

      if (env.issues.length > 0) {
        environments.push(env);
      }
    }
  }

  const recommendations: string[] = [];
  if (issueCounts.double_dollar_display > 0) recommendations.push('避免使用 $$...$$，改用 \\[...\\] 或 equation/align 环境。');
  if (issueCounts.deprecated_eqnarray > 0) recommendations.push('废弃的 eqnarray 环境应替换为 align/align*。');
  if (issueCounts.unlabeled_numbered_equation > 0) recommendations.push('为每个编号公式添加 \\label，便于交叉引用。');
  if (issueCounts.display_style_inline > 0) recommendations.push('行内公式中避免使用 \\displaystyle，以免影响行距。');
  if (issueCounts.unicode_math_character > 0) recommendations.push('行内数学中的非 ASCII 字符应使用 LaTeX 命令或加载 unicode-math。');
  if (issueCounts.split_equation_no_label > 0) recommendations.push('split 环境应放在带 \\label 的 equation 中。');

  const totalIssues = Object.values(issueCounts).reduce((a, b) => a + b, 0);
  return { environments, inlineIssues, issueCounts, totalIssues, recommendations };
}

export function mathAuditResultToPlain(result: MathAuditResult): Record<string, unknown> {
  return {
    totalIssues: result.totalIssues,
    issueCounts: result.issueCounts,
    environmentCount: result.environments.length,
    environments: result.environments.map((e) => ({
      sourceFile: e.sourceFile,
      line: e.line,
      environment: e.environment,
      hasLabel: e.hasLabel,
      issues: e.issues,
    })),
    inlineIssues: result.inlineIssues,
    recommendations: result.recommendations,
  };
}
