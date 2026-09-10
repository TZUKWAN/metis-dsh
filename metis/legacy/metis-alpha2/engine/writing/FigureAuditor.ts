/**
 * Figure Auditor — programmatic pre-submission checks for academic figures.
 *
 * Inspired by claude-scholar's `critique-figures`. Detects missing files,
 * raster plots, oversized bitmaps, raster-in-PDF wrappers, duplicate figures,
 * and missing captions/labels.
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export type FigureIssueType =
  | 'missing_file'
  | 'raster_plot'
  | 'raster_in_pdf'
  | 'oversized_bitmap'
  | 'low_resolution_bitmap'
  | 'duplicate_figure'
  | 'missing_caption'
  | 'missing_label'
  | 'unsupported_format';

export interface FigureIssue {
  file: string;
  line: number;
  type: FigureIssueType;
  message: string;
}

export interface FigureInfo {
  sourceFile: string;
  line: number;
  includePath: string;
  options?: string;
  resolvedPath?: string;
  format?: 'pdf' | 'png' | 'jpeg' | 'eps' | 'svg' | 'unknown';
  width?: number;
  height?: number;
  fileSize?: number;
  caption?: string;
  label?: string;
  issues: FigureIssue[];
}

export interface FigureAuditResult {
  figures: FigureInfo[];
  issueCounts: Record<FigureIssueType, number>;
  totalIssues: number;
  recommendations: string[];
}

const INCLUDE_GRAPHICS_REGEX = /\\includegraphics(?:\*\s*|\s*)(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g;
const CAPTION_REGEX = /\\caption(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
const LABEL_REGEX = /\\label\{([^}]+)\}/g;

const RASTER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif']);
const VECTOR_EXTENSIONS = new Set(['.pdf', '.eps', '.svg']);

function resolveFigurePath(baseDir: string, includePath: string): { resolvedPath?: string; format?: FigureInfo['format'] } {
  const candidates = [includePath];
  const ext = path.extname(includePath).toLowerCase();
  if (!ext) {
    candidates.push(`${includePath}.pdf`, `${includePath}.png`, `${includePath}.jpg`, `${includePath}.eps`, `${includePath}.svg`);
  }

  for (const candidate of candidates) {
    const full = path.resolve(baseDir, candidate);
    try {
      fsSync.accessSync(full, fsSync.constants.F_OK);
      const resolvedExt = path.extname(candidate).toLowerCase();
      const format: FigureInfo['format'] =
        resolvedExt === '.pdf' ? 'pdf' :
        resolvedExt === '.png' ? 'png' :
        resolvedExt === '.jpg' || resolvedExt === '.jpeg' ? 'jpeg' :
        resolvedExt === '.eps' ? 'eps' :
        resolvedExt === '.svg' ? 'svg' : 'unknown';
      return { resolvedPath: full, format };
    } catch {
      // try next extension
    }
  }

  return {};
}

function readImageDimensions(filePath: string, format: FigureInfo['format']): { width?: number; height?: number } {
  try {
    const buffer = fsSync.readFileSync(filePath);
    if (format === 'png') return readPngDimensions(buffer);
    if (format === 'jpeg') return readJpegDimensions(buffer);
  } catch {
    // ignore
  }
  return {};
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24) return { width: 0, height: 0 };
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < buffer.length) {
    if (buffer[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buffer[i + 1];
    if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS
    if (marker === 0xc0 || marker === 0xc2) {
      return {
        height: buffer.readUInt16BE(i + 5),
        width: buffer.readUInt16BE(i + 7),
      };
    }
    const segmentLength = buffer.readUInt16BE(i + 2);
    i += 2 + segmentLength;
  }
  return { width: 0, height: 0 };
}

function looksLikeRasterInPdf(filePath: string): boolean {
  try {
    const content = fsSync.readFileSync(filePath, 'utf-8');
    const hasImageXObject = /\/Subtype\s*\/Image/.test(content);
    const hasText = /\/Font\s*</.test(content) || /BT\s+/.test(content) || /\(\\[A-Za-z]\)/.test(content);
    return hasImageXObject && !hasText;
  } catch {
    return false;
  }
}

function approximateDpi(widthPx: number, options?: string): number | undefined {
  // Try to infer physical width from includegraphics option
  if (!options) return undefined;
  const widthMatch = options.match(/width=([0-9.]+)(cm|mm|in)/);
  if (!widthMatch) return undefined;
  const value = parseFloat(widthMatch[1] ?? '');
  const unit = widthMatch[2] ?? '';
  const inches = unit === 'cm' ? value / 2.54 : unit === 'mm' ? value / 25.4 : value;
  if (inches > 0) return Math.round(widthPx / inches);
  return undefined;
}

interface FigureBlock {
  startLine: number;
  includeGraphics: { path: string; options: string; line: number }[];
  caption?: { text: string; line: number };
  label?: { key: string; line: number };
}

function extractFigureBlocks(lines: string[]): FigureBlock[] {
  const blocks: FigureBlock[] = [];
  let current: FigureBlock | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineNumber = i + 1;

    if (line.includes('\\begin{figure}')) {
      current = { startLine: lineNumber, includeGraphics: [] };
      continue;
    }

    if (line.includes('\\end{figure}')) {
      if (current) {
        blocks.push(current);
        current = null;
      }
      continue;
    }

    if (!current) continue;

    INCLUDE_GRAPHICS_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INCLUDE_GRAPHICS_REGEX.exec(line)) !== null) {
      current.includeGraphics.push({ path: match[2] ?? '', options: match[1] ?? '', line: lineNumber });
    }

    CAPTION_REGEX.lastIndex = 0;
    if ((match = CAPTION_REGEX.exec(line)) !== null) {
      current.caption = { text: match[1] ?? '', line: lineNumber };
    }

    LABEL_REGEX.lastIndex = 0;
    if ((match = LABEL_REGEX.exec(line)) !== null) {
      current.label = { key: match[1] ?? '', line: lineNumber };
    }
  }

  return blocks;
}

function findIncludeGraphicsOutsideFigures(lines: string[]): { path: string; options: string; line: number }[] {
  const results: { path: string; options: string; line: number }[] = [];
  let inFigure = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.includes('\\begin{figure}')) inFigure++;
    if (line.includes('\\end{figure}')) {
      inFigure = Math.max(0, inFigure - 1);
      continue;
    }
    if (inFigure > 0) continue;

    INCLUDE_GRAPHICS_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INCLUDE_GRAPHICS_REGEX.exec(line)) !== null) {
      results.push({ path: match[2] ?? '', options: match[1] ?? '', line: i + 1 });
    }
  }

  return results;
}

/**
 * Audit figures in a LaTeX project.
 */
export async function auditFigures(texDir: string): Promise<FigureAuditResult> {
  const entries = await fs.readdir(texDir, { recursive: true });
  const texFiles = entries.filter((e) => e.toLowerCase().endsWith('.tex'));

  const figures: FigureInfo[] = [];
  const seenHashes = new Map<string, string>(); // hash -> first includePath
  const issueCounts: Record<FigureIssueType, number> = {
    missing_file: 0,
    raster_plot: 0,
    raster_in_pdf: 0,
    oversized_bitmap: 0,
    low_resolution_bitmap: 0,
    duplicate_figure: 0,
    missing_caption: 0,
    missing_label: 0,
    unsupported_format: 0,
  };

  function addIssue(figure: FigureInfo, type: FigureIssueType, message: string) {
    figure.issues.push({ file: figure.sourceFile, line: figure.line, type, message });
    issueCounts[type] = (issueCounts[type] ?? 0) + 1;
  }

  for (const rel of texFiles) {
    const filePath = path.join(texDir, rel);
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const blocks = extractFigureBlocks(lines);
    const standalone = findIncludeGraphicsOutsideFigures(lines);

    for (const block of blocks) {
      for (const inc of block.includeGraphics) {
        const { resolvedPath, format } = resolveFigurePath(path.dirname(filePath), inc.path);
        const info: FigureInfo = {
          sourceFile: rel,
          line: inc.line,
          includePath: inc.path,
          options: inc.options,
          resolvedPath,
          format,
          caption: block.caption?.text,
          label: block.label?.key,
          issues: [],
        };

        if (!block.caption) {
          addIssue(info, 'missing_caption', 'Figure environment has no \\caption');
        }
        if (!block.label) {
          addIssue(info, 'missing_label', 'Figure environment has no \\label');
        }

        await enrichFigure(info, seenHashes, addIssue);
        figures.push(info);
      }
    }

    for (const inc of standalone) {
      const { resolvedPath, format } = resolveFigurePath(path.dirname(filePath), inc.path);
      const info: FigureInfo = {
        sourceFile: rel,
        line: inc.line,
        includePath: inc.path,
        options: inc.options,
        resolvedPath,
        format,
        issues: [],
      };
      await enrichFigure(info, seenHashes, addIssue);
      figures.push(info);
    }
  }

  const recommendations: string[] = [];
  if (issueCounts.missing_file > 0) recommendations.push('补充缺失的图形文件或修正 \\includegraphics 路径。');
  if (issueCounts.raster_plot > 0) recommendations.push('数据图/示意图优先使用 PDF/EPS/SVG 矢量格式，避免使用 PNG/JPEG。');
  if (issueCounts.raster_in_pdf > 0) recommendations.push('避免把 PNG/JPEG 直接包进 PDF 外壳；请导出为原生矢量 PDF。');
  if (issueCounts.oversized_bitmap > 0) recommendations.push('缩小过大的位图，单张图片建议不超过 2 MB。');
  if (issueCounts.low_resolution_bitmap > 0) recommendations.push('位图分辨率建议 ≥300 DPI（印刷）或 ≥150 DPI（屏幕）。');
  if (issueCounts.duplicate_figure > 0) recommendations.push('删除重复图形文件或复用同一文件。');
  if (issueCounts.missing_caption > 0) recommendations.push('为每个 figure 环境添加 \\caption。');
  if (issueCounts.missing_label > 0) recommendations.push('为每个 figure 环境添加 \\label，以便交叉引用。');

  const totalIssues = Object.values(issueCounts).reduce((a, b) => a + b, 0);

  return { figures, issueCounts, totalIssues, recommendations };
}

async function enrichFigure(
  info: FigureInfo,
  seenHashes: Map<string, string>,
  addIssue: (figure: FigureInfo, type: FigureIssueType, message: string) => void,
): Promise<void> {
  if (!info.resolvedPath || !info.format) {
    addIssue(info, 'missing_file', `File not found: ${info.includePath}`);
    return;
  }

  try {
    const stat = await fs.stat(info.resolvedPath);
    info.fileSize = stat.size;

    if (info.format === 'png' || info.format === 'jpeg') {
      const dims = readImageDimensions(info.resolvedPath, info.format);
      info.width = dims.width;
      info.height = dims.height;

      if (stat.size > 2 * 1024 * 1024) {
        addIssue(info, 'oversized_bitmap', `Bitmap is ${(stat.size / 1024 / 1024).toFixed(1)} MB; consider compressing or using vector format`);
      }

      const dpi = approximateDpi(info.width ?? 0, info.options);
      if (dpi && dpi < 150) {
        addIssue(info, 'low_resolution_bitmap', `Approximate resolution is ${dpi} DPI`);
      }

      // Heuristic: if includegraphics path or caption suggests a plot/diagram/chart
      const context = `${info.includePath} ${info.caption ?? ''}`.toLowerCase();
      if (/(plot|chart|diagram|graph|curve|scatter|bar|line|figure|map|flow)/.test(context)) {
        addIssue(info, 'raster_plot', 'Plot/diagram should preferably be in vector format (PDF/EPS/SVG)');
      }
    }

    if (info.format === 'pdf' && looksLikeRasterInPdf(info.resolvedPath)) {
      addIssue(info, 'raster_in_pdf', 'PDF appears to wrap a raster image rather than native vector content');
    }

    if (!VECTOR_EXTENSIONS.has(path.extname(info.resolvedPath).toLowerCase()) && !RASTER_EXTENSIONS.has(path.extname(info.resolvedPath).toLowerCase())) {
      addIssue(info, 'unsupported_format', `Unsupported figure format: ${info.format}`);
    }

    // Duplicate detection by content hash
    const hash = createHash('sha256').update(await fs.readFile(info.resolvedPath)).digest('hex');
    if (seenHashes.has(hash)) {
      addIssue(info, 'duplicate_figure', `Duplicate content with ${seenHashes.get(hash)}`);
    } else {
      seenHashes.set(hash, info.includePath);
    }
  } catch (err) {
    addIssue(info, 'missing_file', `Could not read figure file: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function figureAuditResultToPlain(result: FigureAuditResult): Record<string, unknown> {
  return {
    totalIssues: result.totalIssues,
    issueCounts: result.issueCounts,
    figures: result.figures.map((f) => ({
      sourceFile: f.sourceFile,
      line: f.line,
      includePath: f.includePath,
      resolvedPath: f.resolvedPath,
      format: f.format,
      width: f.width,
      height: f.height,
      fileSize: f.fileSize,
      caption: f.caption,
      label: f.label,
      issues: f.issues,
    })),
    recommendations: result.recommendations,
  };
}
