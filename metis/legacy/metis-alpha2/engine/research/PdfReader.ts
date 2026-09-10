/**
 * PDF Reader Engine — multi-modal PDF parsing, text extraction, metadata reading.
 *
 * Uses pdfjs-dist for cross-platform PDF processing.
 * Supports: text extraction, page-by-page reading, metadata extraction,
 * outline (TOC) extraction, and structured content output.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// pdfjs-dist types — loaded dynamically to handle both ESM and CJS contexts
type PDFDocumentProxy = import('pdfjs-dist').PDFDocumentProxy;
type PDFPageProxy = import('pdfjs-dist').PDFPageProxy;

// ─── Types ────────────────────────────────────────────────────

export interface PdfMetadata {
  title: string;
  author: string;
  subject: string;
  keywords: string[];
  creator: string;
  producer: string;
  creationDate: string | null;
  modDate: string | null;
  pageCount: number;
}

export interface PdfPageContent {
  pageNumber: number;
  text: string;
  width: number;
  height: number;
}

export interface PdfOutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items: PdfOutlineItem[];
}

export interface PdfReadResult {
  metadata: PdfMetadata;
  pages: PdfPageContent[];
  outline: PdfOutlineItem[];
  filePath: string;
  totalPages: number;
}

export interface PdfReadOptions {
  /** Page range to extract (e.g., "1-5" or "3"). Default: all pages. */
  pages?: string;
  /** Whether to include metadata. Default: true. */
  includeMetadata?: boolean;
  /** Whether to include outline/TOC. Default: true. */
  includeOutline?: boolean;
  /** Maximum characters per page (0 = unlimited). Default: 0. */
  maxCharsPerPage?: number;
}

// ─── Page Range Parsing ───────────────────────────────────────

/**
 * Parse a page range string like "1-5" or "3" or "1,3,5-7" into an array
 * of 1-based page numbers.
 */
export function parsePageRange(range: string, totalPages: number): number[] {
  const pages: number[] = [];
  const parts = range.split(',');

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if (trimmed.includes('-')) {
      const [startStr, endStr] = trimmed.split('-', 2);
      const start = Math.max(1, parseInt(startStr ?? '1', 10));
      const end = Math.min(totalPages, parseInt(endStr ?? String(totalPages), 10));
      for (let i = start; i <= end; i++) {
        if (!pages.includes(i)) pages.push(i);
      }
    } else {
      const num = parseInt(trimmed, 10);
      if (num >= 1 && num <= totalPages && !pages.includes(num)) {
        pages.push(num);
      }
    }
  }

  return pages.sort((a, b) => a - b);
}

// ─── PDF Reader Class ────────────────────────────────────────

export class PdfReader {
  private pdfjsLib: typeof import('pdfjs-dist') | null = null;
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? path.join(process.cwd(), 'data', 'pdfs');
  }

  /**
   * Lazy-load pdfjs-dist library.
   * This avoids import failures in environments where it's not yet installed.
   */
  private async loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
    if (this.pdfjsLib) return this.pdfjsLib;

    try {
      // pdfjs-dist v4 uses ESM — dynamic import
      const lib = await import('pdfjs-dist');
      this.pdfjsLib = lib;
      return lib;
    } catch {
      throw new Error(
        'pdfjs-dist is not installed. Run: npm install pdfjs-dist',
      );
    }
  }

  /**
   * Extract text content from a single PDF page.
   */
  private async extractPageText(page: PDFPageProxy): Promise<string> {
    const textContent = await page.getTextContent();
    const lines: string[] = [];
    let lastY: number | null = null;

    for (const item of textContent.items) {
      if (!('str' in item)) continue;
      const textItem = item as { str: string; transform: number[] };
      const y = textItem.transform[5] ?? 0;

      // Detect line breaks based on Y position change
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push('');
      }
      lines.push(textItem.str);
      lastY = y;
    }

    return lines.join('');
  }

  /**
   * Parse PDF metadata from the document.
   */
  private async parseMetadata(doc: PDFDocumentProxy): Promise<PdfMetadata> {
    const raw = await doc.getMetadata();
    const info = (raw as unknown as { info: Record<string, unknown> })?.info ?? {};

    const getString = (key: string): string => {
      const val = info[key];
      return typeof val === 'string' ? val : '';
    };

    const getDate = (key: string): string | null => {
      const raw = getString(key);
      if (!raw) return null;
      // PDF dates look like "D:20240101120000+08'00'"
      const match = raw.match(/D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
      if (match?.[1]) {
        return `${match[1]}-${match[2] ?? '01'}-${match[3] ?? '01'}`;
      }
      return raw;
    };

    const keywordsStr = getString('Keywords');
    const keywords = keywordsStr
      .split(/[,;]/)
      .map((k: string) => k.trim())
      .filter(Boolean);

    return {
      title: getString('Title'),
      author: getString('Author'),
      subject: getString('Subject'),
      keywords,
      creator: getString('Creator'),
      producer: getString('Producer'),
      creationDate: getDate('CreationDate'),
      modDate: getDate('ModDate'),
      pageCount: doc.numPages,
    };
  }

  /**
   * Recursively extract PDF outline (table of contents).
   */
  private async extractOutline(doc: PDFDocumentProxy): Promise<PdfOutlineItem[]> {
    const outlineData = await doc.getOutline();
    if (!outlineData) return [];

    const processItems = async (items: typeof outlineData): Promise<PdfOutlineItem[]> => {
      const result: PdfOutlineItem[] = [];
      for (const item of items) {
        const childItems = item.items && item.items.length > 0
          ? await processItems(item.items)
          : [];
        result.push({
          title: item.title ?? '',
          dest: item.dest ?? null,
          items: childItems,
        });
      }
      return result;
    };

    return processItems(outlineData);
  }

  /**
   * Read a PDF file and extract its content.
   *
   * @param filePath - Absolute or sandbox-validated path to the PDF file
   * @param options - Reading options (page range, metadata, outline)
   * @returns Structured PDF read result
   */
  async readFile(filePath: string, options: PdfReadOptions = {}): Promise<PdfReadResult> {
    const {
      pages: pageRange,
      includeMetadata = true,
      includeOutline = true,
      maxCharsPerPage = 0,
    } = options;

    // Read file as ArrayBuffer
    const resolvedPath = path.resolve(filePath);
    const data = await fs.readFile(resolvedPath);

    // Load PDF document
    const pdfjs = await this.loadPdfjs();
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      useSystemFonts: true,
    });

    const doc = await loadingTask.promise as PDFDocumentProxy;
    const totalPages = doc.numPages;

    // Determine which pages to extract
    const targetPages = pageRange
      ? parsePageRange(pageRange, totalPages)
      : Array.from({ length: totalPages }, (_, i) => i + 1);

    // Extract text from each target page
    const pages: PdfPageContent[] = [];
    for (const pageNum of targetPages) {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.0 });
      let text = await this.extractPageText(page);

      if (maxCharsPerPage > 0 && text.length > maxCharsPerPage) {
        text = text.slice(0, maxCharsPerPage) + `\n... [truncated at ${maxCharsPerPage} chars]`;
      }

      pages.push({
        pageNumber: pageNum,
        text,
        width: viewport.width,
        height: viewport.height,
      });
    }

    // Extract metadata
    const metadata = includeMetadata
      ? await this.parseMetadata(doc)
      : {
          title: '', author: '', subject: '', keywords: [],
          creator: '', producer: '', creationDate: null, modDate: null,
          pageCount: totalPages,
        };

    // Extract outline
    const outline = includeOutline
      ? await this.extractOutline(doc)
      : [];

    // Clean up
    doc.destroy();

    return {
      metadata,
      pages,
      outline,
      filePath: resolvedPath,
      totalPages,
    };
  }

  /**
   * Quick text-only extraction from a PDF file.
   * Returns concatenated text of all pages.
   */
  async extractText(filePath: string, pageRange?: string): Promise<string> {
    const result = await this.readFile(filePath, {
      pages: pageRange,
      includeMetadata: false,
      includeOutline: false,
    });

    return result.pages
      .map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`)
      .join('\n\n');
  }

  /**
   * Extract only metadata from a PDF file (no text extraction).
   */
  async getMetadata(filePath: string): Promise<PdfMetadata> {
    const result = await this.readFile(filePath, {
      includeMetadata: true,
      includeOutline: false,
    });
    return result.metadata;
  }

  /**
   * Get the table of contents (outline) from a PDF.
   */
  async getOutline(filePath: string): Promise<PdfOutlineItem[]> {
    const result = await this.readFile(filePath, {
      includeMetadata: false,
      includeOutline: true,
    });
    return result.outline;
  }

  /**
   * Ensure the PDF data directory exists.
   */
  async ensureDataDir(): Promise<string> {
    await fs.mkdir(this.dataDir, { recursive: true });
    return this.dataDir;
  }

  /**
   * List all PDF files in the data directory.
   */
  async listPdfs(): Promise<string[]> {
    try {
      await fs.access(this.dataDir);
    } catch {
      return [];
    }
    const entries = await fs.readdir(this.dataDir);
    return entries
      .filter((e) => e.toLowerCase().endsWith('.pdf'))
      .map((e) => path.join(this.dataDir, e));
  }

  /**
   * Import (copy) a PDF file into the managed data directory.
   * Returns the new path within the data directory.
   */
  async importPdf(sourcePath: string): Promise<string> {
    const dir = await this.ensureDataDir();
    const basename = path.basename(sourcePath);
    const destPath = path.join(dir, basename);

    // Avoid overwriting by adding a suffix if needed
    let finalPath = destPath;
    let counter = 1;
    while (true) {
      try {
        await fs.access(finalPath);
        const ext = path.extname(basename);
        const name = path.basename(basename, ext);
        finalPath = path.join(dir, `${name}_${counter}${ext}`);
        counter++;
      } catch {
        break;
      }
    }

    await fs.copyFile(sourcePath, finalPath);
    return finalPath;
  }
}

// ─── Singleton ────────────────────────────────────────────────

let _instance: PdfReader | null = null;

export function getPdfReader(dataDir?: string): PdfReader {
  if (!_instance) {
    _instance = new PdfReader(dataDir);
  }
  return _instance;
}
