/**
 * PDF / Web / Image viewer models (METIS-701).
 *
 * Core logic for integrated source reading: page navigation, text-layer extraction, region
 * selection → evidence anchor (METIS-404), in-place citation creation, and thumbnail
 * virtualization for very long PDFs. The React rendering lives in src/viewers/; this module
 * holds the testable data model + navigation math + evidence-creation bridge.
 */

import type { AnchorSpec } from '../sources/EvidenceAnchor.js';

// ─── PDF viewer model ─────────────────────────────────────────

export interface PdfPageInfo {
  pageNumber: number;
  /** Extracted text layer (per-page, for search + selection). */
  text: string;
  width: number;
  height: number;
  /** Pre-rendered thumbnail data URL (lazy: null until requested). */
  thumbnail: string | null;
}

export interface PdfDocument {
  sourceId: string;
  pageCount: number;
  pages: Map<number, PdfPageInfo>;
}

export interface PdfSearchHit {
  pageNumber: number;
  charStart: number;
  charEnd: number;
  snippet: string;
}

/** Search the PDF text layer across pages; returns bounded hits (not the whole doc). */
export function searchPdf(doc: PdfDocument, query: string, maxHits = 50): PdfSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: PdfSearchHit[] = [];
  for (let p = 1; p <= doc.pageCount && hits.length < maxHits; p++) {
    const page = doc.pages.get(p);
    if (!page) continue;
    const lower = page.text.toLowerCase();
    let idx = lower.indexOf(q);
    while (idx >= 0 && hits.length < maxHits) {
      hits.push({
        pageNumber: p,
        charStart: idx,
        charEnd: idx + q.length,
        snippet: page.text.slice(Math.max(0, idx - 20), idx + q.length + 20),
      });
      idx = lower.indexOf(q, idx + 1);
    }
  }
  return hits;
}

/** Which thumbnail rows are visible given scroll position (virtualization for long PDFs). */
export function visibleThumbnailRange(scrollTop: number, viewportHeight: number, thumbHeight: number, pageCount: number): { start: number; end: number } {
  const start = Math.max(0, Math.floor(scrollTop / thumbHeight) - 2);
  const visible = Math.ceil(viewportHeight / thumbHeight) + 4;
  return { start, end: Math.min(pageCount, start + visible) };
}

/** Build an evidence anchor from a text selection on a page. */
export function anchorFromPdfSelection(sourceId: string, pageNumber: number, charStart: number, charEnd: number, snippet: string): { sourceId: string; anchor: AnchorSpec; snippet: string } {
  return {
    sourceId,
    anchor: { type: 'char_range', pageNumber, start: charStart, end: charEnd },
    snippet,
  };
}

/** Build an evidence anchor from a drawn region on a page. */
export function anchorFromPdfRegion(sourceId: string, pageNumber: number, x: number, y: number, w: number, h: number): { sourceId: string; anchor: AnchorSpec } {
  return {
    sourceId,
    // region encoded via char_range-style start/end (x,y as start; w,h folded into end)
    anchor: { type: 'region', pageNumber, start: x * 10000 + y, end: w * 10000 + h },
  };
}

// ─── Web page viewer model ────────────────────────────────────

export interface WebPageSnapshot {
  sourceId: string;
  url: string;
  title: string;
  capturedText: string;
  capturedAt: number;
}

/** Extract a clean text selection range from a captured web page. */
export function webSelectionAnchor(sourceId: string, capturedText: string, selectedText: string): { sourceId: string; anchor: AnchorSpec; snippet: string } | null {
  const charStart = capturedText.indexOf(selectedText);
  if (charStart < 0) return null;
  return {
    sourceId,
    anchor: { type: 'char_range', start: charStart, end: charStart + selectedText.length },
    snippet: selectedText,
  };
}

// ─── Image viewer model ───────────────────────────────────────

export interface ImageRegion {
  x: number; y: number; w: number; h: number;
}

/** Build an evidence anchor from a bounding-box region on an image. */
export function imageRegionAnchor(sourceId: string, region: ImageRegion): { sourceId: string; anchor: AnchorSpec } {
  return {
    sourceId,
    anchor: { type: 'region', start: region.x * 10000 + region.y, end: region.w * 10000 + region.h },
  };
}

/** Robustness: classify a PDF as scannable (needs OCR) vs text-based. */
export function classifyPdfTextQuality(doc: PdfDocument): 'text' | 'scanned' | 'mixed' {
  let textPages = 0; let emptyPages = 0;
  for (const page of doc.pages.values()) {
    // CJK text is dense; a meaningful page has at least 20 non-space chars.
    if (page.text.trim().length >= 20) textPages++; else emptyPages++;
  }
  if (textPages === 0) return 'scanned';
  if (emptyPages > textPages) return 'mixed';
  return 'text';
}
