/**
 * Figure Reference Checker — cross-consistency between figures, their labels,
 * and in-text references.
 *
 * Complements `FigureAuditor` (which checks per-figure file/caption/label
 * health) by checking the THREE-WAY relationship:
 *   1. Every figure/table label defined should be referenced in prose.
 *   2. Every \ref / \cref / \autoref / \eqref in prose should resolve to a
 *      defined label.
 *   3. Figure numbering (1, 2, 3 ...) should be continuous and references
 *      should use the right callout verb (Figure vs Fig. vs Table).
 *
 * Inspired by CheckMyManuscript's figure/table/caption checker and
 * andrehuang/academic-writing-agents D3 (Figure-Text-Caption Consistency).
 *
 * Added round 309.
 */

export type FigureReferenceIssueType =
  | 'unreferenced_label'      // label defined but never \ref'd in prose
  | 'dangling_reference'      // \ref points to a label that doesn't exist
  | 'figure_number_gap'       // figure numbering is non-continuous
  | 'inconsistent_callout'    // mixed "Figure X" and "Fig. X" styles
  | 'caption_too_short'       // caption under 20 chars — likely not self-contained
  | 'figure_without_label'    // figure environment has no \label (cannot be referenced)
  | 'table_without_label';

export interface FigureReferenceIssue {
  line: number;
  type: FigureReferenceIssueType;
  message: string;
}

export interface FigureReferenceRecord {
  label: string;
  kind: 'figure' | 'table' | 'equation' | 'other';
  caption: string;
  line: number;
  referenced: boolean;
}

export interface ReferenceCallout {
  label: string;
  line: number;
  raw: string;
  resolved: boolean;
}

export interface FigureReferenceResult {
  figures: FigureReferenceRecord[];
  references: ReferenceCallout[];
  issues: FigureReferenceIssue[];
  issueCounts: Record<FigureReferenceIssueType, number>;
  totalIssues: number;
  recommendations: string[];
}

const ENV_BEGIN_REGEX = /\\begin\{(figure|table|equation)\*?\}/;
const ENV_END_REGEX = /\\end\{(figure|table|equation)\*?\}/;
const CAPTION_REGEX = /\\caption(?:\[[^\]]*\])?\s*\{([^}]*)\}/;
const LABEL_REGEX = /\\label\{([^}]+)\}/;
// Reference commands: \ref{lab}, \cref{lab}, \autoref{lab}, \eqref{lab},
// \ref{lab1,lab2} (cleveref multi), and plain "Figure X" / "Fig. X" prose.
const REF_COMMAND_REGEX = /\\(?:ref|cref|autoref|eqref|Cref|pageref)\s*\{([^}]+)\}/g;
const PROSE_CALLOUT_REGEX = /\b(Figure|Fig\.|Table|Tab\.|Equation|Eq\.|Eq:)\s+(\d+)/g;

function emptyIssueCounts(): Record<FigureReferenceIssueType, number> {
  return {
    unreferenced_label: 0,
    dangling_reference: 0,
    figure_number_gap: 0,
    inconsistent_callout: 0,
    caption_too_short: 0,
    figure_without_label: 0,
    table_without_label: 0,
  };
}

function stripComments(line: string): string {
  // Remove LaTeX line comments (a single % not escaped as \%).
  let out = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '%' && (i === 0 || line[i - 1] !== '\\')) break;
    out += line[i];
  }
  return out;
}

/**
 * Check figure/table/equation label ↔ reference consistency in LaTeX source.
 */
export function checkFigureReferences(source: string): FigureReferenceResult {
  const lines = source.split(/\r?\n/);
  const issues: FigureReferenceIssue[] = [];
  const records: FigureReferenceRecord[] = [];
  const references: ReferenceCallout[] = [];
  const issueCounts = emptyIssueCounts();

  // Pass 1: walk environments, collect labels + captions.
  let i = 0;
  while (i < lines.length) {
    const clean = stripComments(lines[i]!);
    const beginMatch = clean.match(ENV_BEGIN_REGEX);
    if (!beginMatch) {
      i++;
      continue;
    }
    const kind = (beginMatch[1] ?? 'other') as FigureReferenceRecord['kind'];
    const startLine = i + 1;
    let caption = '';
    let label: string | null = null;
    let depth = 1;
    i++;
    // Scan until matching \end
    while (i < lines.length && depth > 0) {
      const l = stripComments(lines[i]!);
      const cap = l.match(CAPTION_REGEX);
      if (cap && !caption) caption = (cap[1] ?? '').trim();
      const lab = l.match(LABEL_REGEX);
      if (lab && !label) label = lab[1] ?? null;
      const begins = l.match(ENV_BEGIN_REGEX);
      if (begins) depth++;
      if (ENV_END_REGEX.test(l)) depth--;
      i++;
    }

    if (kind === 'figure' || kind === 'table') {
      if (!label) {
        const type: FigureReferenceIssueType = kind === 'figure' ? 'figure_without_label' : 'table_without_label';
        issues.push({
          line: startLine,
          type,
          message: `${kind[0]!.toUpperCase()}${kind.slice(1)} environment starting at line ${startLine} has no \\label — it cannot be cross-referenced from prose.`,
        });
        issueCounts[type]++;
      } else {
        records.push({ label, kind, caption, line: startLine, referenced: false });
      }
    } else if (kind === 'equation' && label) {
      records.push({ label, kind, caption, line: startLine, referenced: false });
    }
  }

  // Pass 2: collect all reference commands across the document.
  for (let ln = 0; ln < lines.length; ln++) {
    const clean = stripComments(lines[ln]!);
    let m: RegExpExecArray | null;
    REF_COMMAND_REGEX.lastIndex = 0;
    while ((m = REF_COMMAND_REGEX.exec(clean)) !== null) {
      // cleveref allows comma-separated lists: \cref{fig:a,fig:b}
      const raw = m[1] ?? '';
      for (const part of raw.split(',')) {
        const lab = part.trim();
        if (!lab) continue;
        references.push({ label: lab, line: ln + 1, raw: m[0], resolved: false });
      }
    }
  }

  // Resolve: which labels are referenced, which refs are dangling.
  const labelSet = new Set(records.map((r) => r.label));
  for (const ref of references) {
    if (labelSet.has(ref.label)) {
      ref.resolved = true;
      const rec = records.find((r) => r.label === ref.label);
      if (rec) rec.referenced = true;
    } else {
      issues.push({
        line: ref.line,
        type: 'dangling_reference',
        message: `\\ref to "${ref.label}" at line ${ref.line} does not match any defined label.`,
      });
      issueCounts.dangling_reference++;
    }
  }

  // Unreferenced labels.
  for (const rec of records) {
    if (!rec.referenced && rec.kind !== 'equation') {
      issues.push({
        line: rec.line,
        type: 'unreferenced_label',
        message: `${rec.kind} "${rec.label}" (line ${rec.line}) is defined but never referenced in prose.`,
      });
      issueCounts.unreferenced_label++;
    }
    if (rec.caption && rec.caption.length > 0 && rec.caption.length < 20) {
      issues.push({
        line: rec.line,
        type: 'caption_too_short',
        message: `${rec.kind} "${rec.label}" caption is only ${rec.caption.length} chars — captions should be self-contained.`,
      });
      issueCounts.caption_too_short++;
    }
  }

  // Figure numbering continuity: extract figure numbers from prose callouts
  // and check for gaps.
  const figureNumbers: number[] = [];
  for (let ln = 0; ln < lines.length; ln++) {
    const clean = stripComments(lines[ln]!);
    PROSE_CALLOUT_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PROSE_CALLOUT_REGEX.exec(clean)) !== null) {
      const num = parseInt(m[2] ?? '', 10);
      if (!Number.isNaN(num)) figureNumbers.push(num);
    }
  }
  if (figureNumbers.length > 0) {
    const uniqueSorted = [...new Set(figureNumbers)].sort((a, b) => a - b);
    for (let k = 1; k < uniqueSorted.length; k++) {
      if (uniqueSorted[k]! - uniqueSorted[k - 1]! > 1) {
        issues.push({
          line: 0,
          type: 'figure_number_gap',
          message: `Figure/table numbering jumps from ${uniqueSorted[k - 1]} to ${uniqueSorted[k]} — a number may be missing.`,
        });
        issueCounts.figure_number_gap++;
      }
    }
  }

  // Callout style consistency: Figure vs Fig.
  const hasFigure = /\bFigure\s+\d/.test(source);
  const hasFig = /\bFig\.\s+\d/.test(source);
  if (hasFigure && hasFig) {
    issues.push({
      line: 0,
      type: 'inconsistent_callout',
      message: 'Mixed callout styles detected ("Figure X" and "Fig. X"). Pick one and use it consistently.',
    });
    issueCounts.inconsistent_callout++;
  }

  const totalIssues = issues.length;
  const recommendations: string[] = [];
  if (issueCounts.dangling_reference > 0) {
    recommendations.push(`Fix ${issueCounts.dangling_reference} dangling reference(s) — they point to labels that do not exist.`);
  }
  if (issueCounts.unreferenced_label > 0) {
    recommendations.push(`${issueCounts.unreferenced_label} figure/table(s) are defined but never cited in prose. Either cite them or remove them.`);
  }
  if (issueCounts.figure_without_label > 0 || issueCounts.table_without_label > 0) {
    recommendations.push('Add \\label to every figure/table you intend to cross-reference.');
  }
  if (issueCounts.caption_too_short > 0) {
    recommendations.push('Expand short captions so each is self-contained (target ≥ 20 chars).');
  }
  if (issueCounts.inconsistent_callout > 0) {
    recommendations.push('Standardize callout style (e.g. always "Figure X", never "Fig. X").');
  }
  if (recommendations.length === 0) {
    recommendations.push('No figure/table reference inconsistencies found.');
  }

  return {
    figures: records,
    references,
    issues,
    issueCounts,
    totalIssues,
    recommendations,
  };
}

export function figureReferenceResultToPlain(result: FigureReferenceResult): Record<string, unknown> {
  return {
    figureCount: result.figures.length,
    referenceCount: result.references.length,
    totalIssues: result.totalIssues,
    issueCounts: result.issueCounts,
    issues: result.issues,
    recommendations: result.recommendations,
  };
}
