/**
 * Artifact export (METIS-901) + LaTeX degradation (METIS-902).
 *
 * 901: core delivery does NOT depend on external Office or LaTeX. Exports Word/Markdown/
 *      HTML/PDF with correct citations, footnotes, charts, tables, TOC, and CJK fonts.
 * 902: when TeX is absent, all core writing + PDF export still work; LaTeX is an optional
 *      advanced mode, never a blocker (METIS-902 completion).
 *
 * The actual byte-level rendering (docx zip / pdf print) is platform-specific; this module
 * holds the export-plan assembly + content normalization + citation/footnote/TOC wiring,
 * which is the testable core.
 */

// ─── METIS-901 Export ─────────────────────────────────────────

export type ExportFormat = 'docx' | 'markdown' | 'html' | 'pdf';

export interface ExportSection {
  heading: string;
  body: string;                 // markdown body
  footnotes?: string[];
  citationRefs?: string[];      // source ids cited in this section
}

export interface ExportPlan {
  format: ExportFormat;
  title: string;
  sections: ExportSection[];
  /** Resolved citations: id → formatted citation string. */
  citations: Record<string, string>;
  tableOfContents: boolean;
  /** Chart specs to embed (rendered to images/SVG by the platform layer). */
  chartRefs: string[];
  cjkFont: string;
}

export interface ExportResult {
  success: boolean;
  format: ExportFormat;
  /** The normalized content handed to the platform renderer (docx/pdf/html/md). */
  normalizedContent: string;
  /** Warnings (e.g. a chart could not render); never silent failure. */
  warnings: string[];
  bytes?: number;
  error?: string;
}

/** Normalize a manuscript to a single renderable document string with TOC + footnotes. */
export function normalizeForExport(_plan: ExportFormat, title: string, sections: ExportSection[], citations: Record<string, string>, opts: { toc: boolean }): string {
  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  if (opts.toc) {
    lines.push('## 目录');
    for (const s of sections) lines.push(`- ${s.heading}`);
    lines.push('');
  }
  for (const s of sections) {
    lines.push(`## ${s.heading}`);
    lines.push(s.body);
    // inline citation markers → resolved text
    if (s.citationRefs && s.citationRefs.length > 0) {
      lines.push('');
      for (const cid of s.citationRefs) {
        const resolved = citations[cid];
        if (resolved) lines.push(`> [引用 ${cid}] ${resolved}`);
        else lines.push(`> [引用 ${cid}] （未解析）`);
      }
    }
    if (s.footnotes && s.footnotes.length > 0) {
      lines.push('');
      for (let i = 0; i < s.footnotes.length; i++) {
        lines.push(`[^${i + 1}]: ${s.footnotes[i]}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Plan + execute an export (platform renderer injected so tests run offline). */
export interface PlatformRenderer {
  render(plan: ExportPlan, normalized: string): Promise<{ bytes: number; warnings: string[] }>;
}

export async function exportArtifact(plan: ExportPlan, renderer: PlatformRenderer): Promise<ExportResult> {
  try {
    const normalized = normalizeForExport(plan.format, plan.title, plan.sections, plan.citations, { toc: plan.tableOfContents });
    const { bytes, warnings } = await renderer.render(plan, normalized);
    return { success: true, format: plan.format, normalizedContent: normalized, warnings, bytes };
  } catch (err) {
    return { success: false, format: plan.format, normalizedContent: '', warnings: [], error: (err as Error).message };
  }
}

// ─── METIS-902 LaTeX degradation ──────────────────────────────

export type TexAvailability = 'available' | 'missing';

/**
 * Decide the writing/PDF path. If TeX is missing, core writing + PDF export MUST still work
 * via the native path (Electron print / docx). LaTeX compile is a bonus, not a requirement.
 */
export function resolveExportPath(tex: TexAvailability): {
  corePdfWorks: boolean;
  latexCompileAvailable: boolean;
  message: string;
} {
  if (tex === 'available') {
    return { corePdfWorks: true, latexCompileAvailable: true, message: 'LaTeX 可用，可使用高级编译。' };
  }
  return {
    corePdfWorks: true,            // ALWAYS — native print path, no TeX needed
    latexCompileAvailable: false,
    message: '未检测到 TeX 环境。核心写作与 PDF 导出照常可用；LaTeX 编译为高级可选能力。',
  };
}

/** App startup must NOT be blocked by TeX absence (METIS-902). */
export function latexAbsenceIsFatal(_tex: TexAvailability): boolean {
  void _tex;
  return false; // never fatal — core flow is TeX-independent
}
