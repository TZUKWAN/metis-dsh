/**
 * LaTeX Integrity Reporter — unified pre-submission report for a LaTeX project.
 *
 * Orchestrates latex_cleanup, figure_audit, table_audit, and (optionally)
 * bibtex_audit into a single severity-ranked report with consolidated
 * recommendations.
 */

import { auditLaTeX, type LaTeXCleanupResult } from './LaTeXAuditor.js';
import { auditFigures, type FigureAuditResult } from './FigureAuditor.js';
import { auditTables, type TableAuditResult } from './TableAuditor.js';
import { auditBibTeX, type BibTeXAuditResult } from '../research/BibTeXAuditor.js';

export interface SeverityCounts {
  total: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface FileIssueSummary {
  file: string;
  count: number;
  types: string[];
}

export interface LaTeXIntegrityReport {
  texDir: string;
  bibPath?: string;
  severity: SeverityCounts;
  filesWithIssues: FileIssueSummary[];
  sections: {
    latex: LaTeXCleanupResult;
    figures: FigureAuditResult;
    tables: TableAuditResult;
    bib?: BibTeXAuditResult;
  };
  recommendations: string[];
}


const LATEX_CRITICAL = new Set(['undefined_citation', 'undefined_reference', 'duplicate_label']);
const LATEX_HIGH = new Set(['empty_citation', 'empty_reference', 'draft_artifact', 'todo_comment']);
const LATEX_MEDIUM = new Set(['empty_section', 'unused_citation', 'unused_label', 'style_issue']);

const FIGURE_CRITICAL = new Set(['missing_file']);
const FIGURE_HIGH = new Set(['raster_plot', 'raster_in_pdf', 'oversized_bitmap']);
const FIGURE_MEDIUM = new Set(['low_resolution_bitmap', 'duplicate_figure', 'missing_caption', 'missing_label', 'unsupported_format']);

const TABLE_CRITICAL = new Set<string>([]);
const TABLE_HIGH = new Set<string>([]);
const TABLE_MEDIUM = new Set(['missing_caption', 'missing_label', 'vertical_rules', 'no_booktabs', 'numeric_misaligned', 'empty_cells', 'overly_wide_table', 'duplicate_table']);

function severityFromType(
  type: string,
  critical: Set<string>,
  high: Set<string>,
  medium: Set<string>,
): 'critical' | 'high' | 'medium' | 'low' {
  if (critical.has(type)) return 'critical';
  if (high.has(type)) return 'high';
  if (medium.has(type)) return 'medium';
  return 'low';
}

function collectLaTeXSeverity(result: LaTeXCleanupResult, counts: SeverityCounts, fileMap: Map<string, FileIssueSummary>) {
  for (const issue of result.issues) {
    const sev = severityFromType(issue.type, LATEX_CRITICAL, LATEX_HIGH, LATEX_MEDIUM);
    counts.total++;
    counts[sev]++;
    const summary = fileMap.get(issue.file) ?? { file: issue.file, count: 0, types: [] };
    summary.count++;
    if (!summary.types.includes(issue.type)) summary.types.push(issue.type);
    fileMap.set(issue.file, summary);
  }
}

function collectFigureSeverity(result: FigureAuditResult, counts: SeverityCounts, fileMap: Map<string, FileIssueSummary>) {
  for (const fig of result.figures) {
    for (const issue of fig.issues) {
      const sev = severityFromType(issue.type, FIGURE_CRITICAL, FIGURE_HIGH, FIGURE_MEDIUM);
      counts.total++;
      counts[sev]++;
      const summary = fileMap.get(fig.sourceFile) ?? { file: fig.sourceFile, count: 0, types: [] };
      summary.count++;
      if (!summary.types.includes(issue.type)) summary.types.push(issue.type);
      fileMap.set(fig.sourceFile, summary);
    }
  }
}

function collectTableSeverity(result: TableAuditResult, counts: SeverityCounts, fileMap: Map<string, FileIssueSummary>) {
  for (const table of result.tables) {
    for (const issue of table.issues) {
      const sev = severityFromType(issue.type, TABLE_CRITICAL, TABLE_HIGH, TABLE_MEDIUM);
      counts.total++;
      counts[sev]++;
      const summary = fileMap.get(table.sourceFile) ?? { file: table.sourceFile, count: 0, types: [] };
      summary.count++;
      if (!summary.types.includes(issue.type)) summary.types.push(issue.type);
      fileMap.set(table.sourceFile, summary);
    }
  }
}

function collectBibSeverity(result: BibTeXAuditResult, counts: SeverityCounts) {
  counts.total += result.summary.orphanCitations + result.summary.orphanBibEntries + result.summary.duplicateKeys + result.summary.duplicateDois + result.summary.missingIdentifierCount + result.summary.notFoundCount + result.summary.errorCount;
  counts.critical += result.summary.orphanCitations + result.summary.notFoundCount + result.summary.errorCount;
  counts.high += result.summary.missingIdentifierCount + result.summary.duplicateKeys + result.summary.duplicateDois;
  counts.medium += result.summary.orphanBibEntries;
}

function mergeRecommendations(...sources: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rec of sources.flat()) {
    if (!seen.has(rec)) {
      seen.add(rec);
      out.push(rec);
    }
  }
  return out;
}

/**
 * Run a unified integrity report over a LaTeX project.
 */
export async function runLaTeXIntegrityReport(options: { texDir: string; bibPath?: string }): Promise<LaTeXIntegrityReport> {
  const [latex, figures, tables] = await Promise.all([
    auditLaTeX({ texDir: options.texDir, bibPath: options.bibPath }),
    auditFigures(options.texDir),
    auditTables(options.texDir),
  ]);

  const bib = options.bibPath ? await auditBibTeX({ filePath: options.bibPath, texDir: options.texDir }) : undefined;

  const severity: SeverityCounts = { total: 0, critical: 0, high: 0, medium: 0, low: 0 };
  const fileMap = new Map<string, FileIssueSummary>();

  collectLaTeXSeverity(latex, severity, fileMap);
  collectFigureSeverity(figures, severity, fileMap);
  collectTableSeverity(tables, severity, fileMap);
  if (bib) collectBibSeverity(bib, severity);

  const recommendations = mergeRecommendations(
    latex.recommendations,
    figures.recommendations,
    tables.recommendations,
    bib?.recommendations ?? [],
  );

  // Add cross-cutting recommendations based on aggregated severity.
  if (severity.critical > 0) {
    recommendations.unshift('存在严重问题（缺失文件、失效引用等），请先修复后再提交。');
  } else if (severity.high > 0) {
    recommendations.unshift('存在较多高风险问题，建议优先处理后再提交。');
  }

  const filesWithIssues = Array.from(fileMap.values()).sort((a, b) => b.count - a.count);

  return {
    texDir: options.texDir,
    bibPath: options.bibPath,
    severity,
    filesWithIssues,
    sections: { latex, figures, tables, bib },
    recommendations,
  };
}

export function integrityReportToPlain(report: LaTeXIntegrityReport): Record<string, unknown> {
  return {
    texDir: report.texDir,
    bibPath: report.bibPath,
    severity: report.severity,
    filesWithIssues: report.filesWithIssues,
    recommendations: report.recommendations,
    sections: {
      latex: {
        filesScanned: report.sections.latex.filesScanned,
        issueCounts: report.sections.latex.issueCounts,
        issueCount: report.sections.latex.issues.length,
      },
      figures: {
        figureCount: report.sections.figures.figures.length,
        totalIssues: report.sections.figures.totalIssues,
        issueCounts: report.sections.figures.issueCounts,
      },
      tables: {
        tableCount: report.sections.tables.tables.length,
        totalIssues: report.sections.tables.totalIssues,
        issueCounts: report.sections.tables.issueCounts,
      },
      bib: report.sections.bib
        ? {
            entryCount: report.sections.bib.summary.entryCount,
            citedCount: report.sections.bib.summary.citedCount,
            orphanCitations: report.sections.bib.summary.orphanCitations,
            orphanBibEntries: report.sections.bib.summary.orphanBibEntries,
            duplicateKeys: report.sections.bib.summary.duplicateKeys,
            missingIdentifierCount: report.sections.bib.summary.missingIdentifierCount,
            verifiedCount: report.sections.bib.summary.verifiedCount,
            notFoundCount: report.sections.bib.summary.notFoundCount,
          }
        : undefined,
    },
  };
}
