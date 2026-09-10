/**
 * PDF Reader Page — multi-modal PDF reading with text extraction,
 * page navigation, zoom, search, and outline (TOC) support.
 *
 * Uses pdfjs-dist for client-side PDF rendering via Canvas.
 * All colors use CSS variables for light/dark theme support.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useMetisStore } from '../store';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import { useTranslation } from '../i18n';
import { presentDiagnosticText } from '../presentation/executionPresentation';
import { SafeMarkdown } from '../presentation/SafeMarkdown';
import { anchorFromPdfSelection, anchorFromPdfRegion } from '../../engine/viewers/DocumentViewers';
import type { AnchorSpec } from '../../engine/sources/EvidenceAnchor';
import type { UIMode } from '../../engine/capabilities/DiagnosticMode';
import { findReferenceSection, findReferencePage } from '../../engine/research/ReferenceLocator.js';
import './PdfReaderPage.css';

// ─── Types ────────────────────────────────────────────────────

interface PageInfo {
  num: number;
  width: number;
  height: number;
}

interface SearchResult {
  pageNum: number;
  text: string;
  position: number;
}

/** A persisted highlight/annotation for one PDF source, decoded from evidence. */
interface PdfAnnotation {
  id: string;
  anchor: AnchorSpec;
  snippet: string;
  note: string;
  highlightOnly: boolean;
  sourceVersionHash: string | null;
}

/** An in-progress selection before the user picks highlight vs annotate. */
interface PendingSelection {
  anchor: AnchorSpec;
  snippet: string;
  rects: Array<{ left: number; top: number; width: number; height: number }>;
  menuLeft: number;
  menuTop: number;
}

// ─── PDF Reader Component ─────────────────────────────────────

interface PdfReaderPageProps {
  uiMode?: UIMode;
  /** Open a specific library paper by id (my-papers list / message citations).
   *  Project-linked papers keep full annotation; unlinked ones open read-only. */
  openPaperId?: string | null;
}

export default function PdfReaderPage({ uiMode = 'normal', openPaperId = null }: PdfReaderPageProps) {
  const { papers } = useMetisStore();
  const activeProjectId = useResearchWorkspaceStore((state) => state.activeProjectId);
  const snapshot = useResearchWorkspaceStore((state) => state.snapshot);
  const applyCrud = useResearchWorkspaceStore((state) => state.applyCrud);
  const { t, locale } = useTranslation();

  // PDF state
  const [pdfDoc, setPdfDoc] = useState<unknown>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [, setPageInfo] = useState<PageInfo | null>(null);
  const [zoom, setZoom] = useState(1.0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('');

  // UI state
  const [showOutline, setShowOutline] = useState(false);
  const [outline, setOutline] = useState<Array<{ title: string; dest: unknown }>>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [currentSearchIdx, setCurrentSearchIdx] = useState(0);
  const [extractedText, setExtractedText] = useState<string>('');
  const [showText, setShowText] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'pages' | 'outline' | 'text'>('pages');

  // Thumbnail pages for sidebar
  const [thumbnails, setThumbnails] = useState<Array<{ num: number; loaded: boolean }>>([]);

  // ─── Annotation state ──────────────────────────────────────
  // Per-page extracted text, keyed by page number. Used both for search and
  // for converting a text-layer DOM selection into a page-local char offset
  // that anchorFromPdfSelection expects.
  const [pageTextMap, setPageTextMap] = useState<Map<number, string>>(new Map());
  // The library paper this PDF belongs to (null when opened from a bare file).
  const [currentPaperId, setCurrentPaperId] = useState<string | null>(null);
  // A fresh selection waiting for the user to pick highlight vs annotate.
  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);
  // The annotation being edited (note text), keyed by pending action.
  const [noteDraft, setNoteDraft] = useState('');
  const [notePreview, setNotePreview] = useState(false);
  const [annotateMode, setAnnotateMode] = useState(false);
  // Region-select mode: drag a rectangle over the page to annotate an area.
  const [regionMode, setRegionMode] = useState(false);
  const [regionDragRect, setRegionDragRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  // AI explanation of the pending selection (one-shot provider call via IPC).
  const [aiResult, setAiResult] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  // Export feedback shown below the toolbar after annotation export.
  const [exportFeedback, setExportFeedback] = useState<string | null>(null);

  // Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const highlightLayerRef = useRef<HTMLDivElement>(null);
  const pageWrapperRef = useRef<HTMLDivElement>(null);
  const regionDragRef = useRef<{ startX: number; startY: number; active: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfjsRef = useRef<unknown>(null);

  // Papers with a main-process-issued PDF capability only.
  const papersWithPdf = papers.filter((p) => p.pdfCapability);

  // ─── Load pdfjs-dist ─────────────────────────────────────

  const loadPdfjs = useCallback(async () => {
    if (pdfjsRef.current) return pdfjsRef.current;
    try {
      const pdfjs = await import('pdfjs-dist');
      // Set worker source
      const workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString();
      pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
      pdfjsRef.current = pdfjs;
      return pdfjs;
    } catch {
      setError(t('pdf.errorLibraryLoadFailed'));
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Render a single page to canvas ─────────────────────

  const renderPage = useCallback(async (doc: unknown, pageNum: number, scale: number) => {
    const pdfjs = pdfjsRef.current as typeof import('pdfjs-dist') | null;
    if (!pdfjs || !canvasRef.current) return;

    const pdfDocument = doc as import('pdfjs-dist').PDFDocumentProxy;
    const page = await pdfDocument.getPage(pageNum);
    const viewport = page.getViewport({ scale });

    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    if (!context) return;

    canvas.height = viewport.height;
    canvas.width = viewport.width;

    await page.render({
      canvasContext: context,
      viewport,
    }).promise;

    // Render an invisible text layer on top of the canvas so the user can
    // select text. This is required for highlight/annotation capture.
    if (textLayerRef.current) {
      const container = textLayerRef.current;
      container.innerHTML = '';
      container.style.setProperty('--scale-factor', String(scale));
      try {
        const textLayer = new pdfjs.TextLayer({
          textContentSource: page.streamTextContent(),
          container,
          viewport,
        });
        await textLayer.render();
      } catch {
        // Text layer rendering is best-effort; annotation capture degrades
        // gracefully to region-only mode if it fails.
      }
    }

    setPageInfo({ num: pageNum, width: viewport.width, height: viewport.height });
  }, []);

  // ─── Load PDF from file ─────────────────────────────────

  const loadPdfFromData = useCallback(async (data: Uint8Array, name: string) => {
    setIsLoading(true);
    setError(null);
    setFileName(name);

    const pdfjs = await loadPdfjs();
    if (!pdfjs) { setIsLoading(false); return; }

    try {
      const loadingTask = (pdfjs as typeof import('pdfjs-dist')).getDocument({ data });
      const doc = await loadingTask.promise;

      setPdfDoc(doc);
      setTotalPages(doc.numPages);
      // O8: honor a citation backlink's target page when opening.
      const pendingPage = useMetisStore.getState().pendingPaperPage;
      if (pendingPage !== null && pendingPage >= 1 && pendingPage <= doc.numPages) {
        setCurrentPage(pendingPage);
        useMetisStore.setState({ pendingPaperPage: null });
      } else {
        setCurrentPage(1);
      }

      // Reset annotation state whenever a different PDF is opened.
      setPendingSelection(null);
      setNoteDraft('');
      setAnnotateMode(false);

      // Initialize thumbnails
      const thumbs = Array.from({ length: doc.numPages }, (_, i) => ({
        num: i + 1,
        loaded: false,
      }));
      setThumbnails(thumbs);

      // Extract outline
      try {
        const outlineData = await doc.getOutline();
        if (outlineData) {
          setOutline(outlineData.map((item: { title: string; dest: unknown }) => ({
            title: item.title ?? '',
            dest: item.dest,
          })));
        }
      } catch {
        // Outline extraction failed — non-critical
      }

      // Extract full text for search, and keep a per-page map so that text
      // selections can be converted into page-local char offsets for anchors.
      try {
        const textParts: string[] = [];
        const pageMap = new Map<number, string>();
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const textContent = await page.getTextContent();
          const pageText = textContent.items
            .map((item) => ('str' in item ? (item as { str: string }).str : ''))
            .join('');
          textParts.push(pageText);
          pageMap.set(i, pageText);
        }
        setExtractedText(textParts.join('\n\n'));
        setPageTextMap(pageMap);
      } catch {
        // Text extraction failed — non-critical
      }
    } catch (err) {
      setError(
        uiMode === 'diagnostic'
          ? t('pdf.errorLoadFailedDiagnostic', { error: presentDiagnosticText(String(err)) })
          : t('pdf.errorLoadFailed'),
      );
    } finally {
      setIsLoading(false);
    }
  }, [loadPdfjs, t, uiMode]);

  // The canvas is intentionally absent while loading. Render only after the
  // loading state commits and the canvas ref exists; rendering directly from
  // loadPdfFromData races that mount and leaves a permanently blank page.
  useEffect(() => {
    if (!pdfDoc || isLoading) return;
    void renderPage(pdfDoc, currentPage, zoom).catch((err: unknown) => {
      setError(
        uiMode === 'diagnostic'
          ? t('pdf.errorLoadFailedDiagnostic', { error: presentDiagnosticText(String(err)) })
          : t('pdf.errorLoadFailed'),
      );
    });
  }, [currentPage, isLoading, pdfDoc, renderPage, t, uiMode, zoom]);

  const loadPdfFromFile = useCallback(async (file: File) => {
    // A bare file has no library paper, so highlights cannot be persisted as
    // project evidence. Keep annotation state cleared for this path.
    setCurrentPaperId(null);
    const arrayBuffer = await file.arrayBuffer();
    await loadPdfFromData(new Uint8Array(arrayBuffer), file.name);
  }, [loadPdfFromData]);

  // ─── Navigate pages ─────────────────────────────────────

  const goToPage = useCallback((pageNum: number) => {
    if (pageNum < 1 || pageNum > totalPages || !pdfDoc) return;
    setCurrentPage(pageNum);
  }, [pdfDoc, totalPages]);

  // O9: locate the References/Bibliography section so users can jump to it and
  // from a citation number to the matching reference entry (Smart Jump subset).
  const referenceSection = useMemo(() => {
    if (pageTextMap.size === 0) return null;
    return findReferenceSection(pageTextMap);
  }, [pageTextMap]);

  // O9: back-jump stack. Citation/reference jumps record the page they came
  // from so the user can return to the reading position (Sioyek-style).
  const [jumpStack, setJumpStack] = useState<number[]>([]);

  const pushJump = useCallback((fromPage: number) => {
    setJumpStack((prev) => [...prev.slice(-19), fromPage]);
  }, []);

  const jumpBack = useCallback(() => {
    setJumpStack((prev) => {
      if (prev.length === 0) return prev;
      const target = prev[prev.length - 1];
      const rest = prev.slice(0, -1);
      if (target !== undefined) {
        goToPage(target);
      }
      return rest;
    });
  }, [goToPage]);

  const jumpToReferences = useCallback(() => {
    if (referenceSection) {
      pushJump(currentPage);
      goToPage(referenceSection.startPage);
    }
  }, [referenceSection, currentPage, pushJump, goToPage]);

  // O9: jump from a citation number "[n]" / "(n)" to the reference entry page.
  // Exposed for the text-layer selection affordance wired below.
  const jumpToReference = useCallback((refNumber: number) => {
    if (!referenceSection) return;
    const page = findReferencePage(pageTextMap, referenceSection, refNumber);
    if (page) {
      pushJump(currentPage);
      goToPage(page);
    }
  }, [referenceSection, pageTextMap, currentPage, pushJump, goToPage]);

  // ─── Zoom controls ──────────────────────────────────────

  const handleZoom = useCallback((newZoom: number) => {
    const clamped = Math.max(0.25, Math.min(4.0, newZoom));
    setZoom(clamped);
  }, []);

  // ─── Search in PDF ──────────────────────────────────────

  const handleSearch = useCallback(() => {
    if (!searchQuery.trim() || !extractedText) return;

    const query = searchQuery.toLowerCase();
    const pages = extractedText.split('\n\n');
    const results: SearchResult[] = [];

    pages.forEach((pageText, idx) => {
      let pos = pageText.toLowerCase().indexOf(query);
      while (pos !== -1) {
        const start = Math.max(0, pos - 30);
        const end = Math.min(pageText.length, pos + query.length + 30);
        results.push({
          pageNum: idx + 1,
          text: `...${pageText.slice(start, end)}...`,
          position: pos,
        });
        pos = pageText.toLowerCase().indexOf(query, pos + 1);
      }
    });

    setSearchResults(results);
    setCurrentSearchIdx(0);

    // Navigate to first result
    if (results.length > 0 && results[0]) {
      goToPage(results[0].pageNum);
    }
  }, [searchQuery, extractedText, goToPage]);

  const goToNextSearchResult = useCallback(() => {
    if (searchResults.length === 0) return;
    const nextIdx = (currentSearchIdx + 1) % searchResults.length;
    setCurrentSearchIdx(nextIdx);
    const result = searchResults[nextIdx];
    if (result) goToPage(result.pageNum);
  }, [searchResults, currentSearchIdx, goToPage]);

  // ─── Keyboard shortcuts ─────────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.key) {
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault();
          goToPage(currentPage - 1);
          break;
        case 'ArrowRight':
        case 'PageDown':
          e.preventDefault();
          goToPage(currentPage + 1);
          break;
        case 'Home':
          e.preventDefault();
          goToPage(1);
          break;
        case 'End':
          e.preventDefault();
          goToPage(totalPages);
          break;
        case '+':
        case '=':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            handleZoom(zoom + 0.25);
          }
          break;
        case '-':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            handleZoom(zoom - 0.25);
          }
          break;
        case 'Enter':
          if (searchQuery) {
            e.preventDefault();
            goToNextSearchResult();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentPage, totalPages, zoom, searchQuery, goToPage, handleZoom, goToNextSearchResult]);

  // ─── Annotation helpers ───────────────────────────────────

  /** Resolve the research source that corresponds to a library paper.
   * Prefers an existing source whose id matches the paper id (the convention
   * used when we create one); falls back to DOI/arXiv/title matching. Creates
   * the source if none exists. Returns null when persistence is unavailable.
   */
  const resolveSourceForPaper = useCallback(async (
    paper: (typeof papers)[number],
    projectId: string,
  ): Promise<string | null> => {
    const normalizeDoi = (doi: string | undefined) =>
      doi ? doi.toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim() : '';
    const paperDoi = normalizeDoi(paper.doi);
    // Prefer a source already in the loaded snapshot.
    const sources = snapshot?.sources ?? [];
    const match = sources.find((s) => s.id === paper.id)
      ?? sources.find((s) => paperDoi && s.identifierType === 'doi' && normalizeDoi(s.identifier) === paperDoi)
      ?? sources.find((s) => paper.arxivId && s.identifierType === 'arxiv' && s.identifier === paper.arxivId)
      ?? sources.find((s) => s.title === paper.title && s.year === paper.year);
    if (match) return match.id;

    // No match — create a source reusing the paper id for a stable mapping.
    const identifierType = paper.doi ? 'doi' : paper.arxivId ? 'arxiv' : 'other';
    const identifier = paper.doi ?? paper.arxivId ?? '';
    const createResult = await applyCrud({
      operation: 'create',
      entityKind: 'source',
      projectId,
      value: {
        id: paper.id,
        kind: 'paper',
        title: paper.title,
        authors: paper.authors,
        year: paper.year,
        venue: paper.venue,
        identifier,
        identifierType,
        externalUrl: paper.pdfUrl ?? paper.url ?? null,
        tags: paper.tags,
        deliverableSourceKind: null,
        deliverableRuleKind: null,
        sourceVersionHash: null,
      },
    });
    if (createResult.success) return createResult.resourceId;
    // A conflict means another run created it concurrently; the id is ours.
    if (createResult.code === 'conflict') return paper.id;
    return null;
  }, [snapshot, applyCrud]);

  /** Resolve (and cache) the research source id for the current paper. Runs in
   * an effect because it may create the source as a side effect. The cached
   * value carries its paper id so stale results are filtered at read time
   * instead of being cleared synchronously inside the effect. */
  const [sourceResolution, setSourceResolution] = useState<{ paperId: string; sourceId: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const paper = papers.find((p) => p.id === currentPaperId);
    if (!activeProjectId || !paper) return;
    void resolveSourceForPaper(paper, activeProjectId).then((id) => {
      if (!cancelled) setSourceResolution({ paperId: paper.id, sourceId: id });
    });
    return () => { cancelled = true; };
  }, [activeProjectId, currentPaperId, papers, resolveSourceForPaper]);

  // The resolved source id for the *current* paper only; null while resolving
  // or when no paper is active.
  const resolvedSourceId = sourceResolution?.paperId === currentPaperId
    ? sourceResolution.sourceId
    : null;

  // The source's own version hash (null for sources that never received one).
  // Persisted evidence carries the hash it was saved against; when both exist
  // and differ, the annotation predates a source update and is shown as stale.
  const currentSourceHash = snapshot?.sources.find((s) => s.id === resolvedSourceId)?.sourceVersionHash ?? null;

  // Annotations are derived (not stored) from the resolved source and the
  // workspace snapshot: evidence anchors joined with their note_code text.
  const annotations: PdfAnnotation[] = useMemo(() => {
    if (!resolvedSourceId) return [];
    const noteByEvidence = new Map<string, string>();
    for (const note of snapshot?.noteCodes ?? []) {
      if (note.evidenceId && note.code === 'pdf-annotation' && note.deletedAt === null) {
        noteByEvidence.set(note.evidenceId, note.content);
      }
    }
    return (snapshot?.evidence ?? [])
      .filter((row) => row.sourceId === resolvedSourceId && row.deletedAt === null)
      .map((row) => {
        const note = noteByEvidence.get(row.id) ?? '';
        return {
          id: row.id,
          anchor: {
            type: row.anchorType,
            pageNumber: row.pageNumber ?? undefined,
            start: row.anchorStart ?? undefined,
            end: row.anchorEnd ?? undefined,
          },
          snippet: row.snippet,
          note,
          highlightOnly: note.trim() === '',
          sourceVersionHash: row.sourceVersionHash,
        };
      });
  }, [resolvedSourceId, snapshot]);

  /** Persist a highlight/annotation: an evidence record for the anchor, plus a
   * note_code carrying the comment text when the user wrote one. */
  const persistAnnotation = useCallback(async (
    anchor: AnchorSpec,
    snippet: string,
    note: string,
    highlightOnly: boolean,
  ): Promise<void> => {
    const projectId = activeProjectId;
    const sourceId = resolvedSourceId;
    if (!projectId || !sourceId) {
      setError(t('pdf.annotationSaveFailed'));
      return;
    }

    // Renderer must compute the snippet hash (main does not). WebCrypto is
    // async; produce the SHA-256 hex digest expected by the schema.
    let snippetHash: string;
    try {
      const bytes = new TextEncoder().encode(snippet);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      snippetHash = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      setError(t('pdf.annotationSaveFailed'));
      return;
    }

    const evidenceId = `evidence_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const evResult = await applyCrud({
      operation: 'create',
      entityKind: 'evidence',
      projectId,
      value: {
        id: evidenceId,
        sourceId,
        anchorType: anchor.type,
        anchorStart: anchor.start ?? null,
        anchorEnd: anchor.end ?? null,
        pageNumber: anchor.pageNumber ?? null,
        snippet,
        snippetHash,
        // Record the source hash the annotation was saved against, so the
        // reader can flag stale highlights after a source update.
        sourceVersionHash: snapshot?.sources.find((s) => s.id === sourceId)?.sourceVersionHash ?? null,
        confidence: 1,
      },
    });
    if (!evResult.success) {
      setError(t('pdf.annotationSaveFailed'));
      return;
    }

    // When the user wrote a comment, persist it as a note_code bound to the
    // evidence. highlightOnly markers skip this step.
    if (!highlightOnly && note.trim()) {
      const noteId = `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const noteResult = await applyCrud({
        operation: 'create',
        entityKind: 'note_code',
        projectId,
        value: {
          id: noteId,
          evidenceId,
          code: 'pdf-annotation',
          content: note.trim(),
          author: 'human',
          confidence: 1,
          accepted: 'accepted',
          tags: ['pdf-annotation'],
        },
      });
      if (!noteResult.success) {
        setError(t('pdf.annotationSaveFailed'));
        return;
      }
    }
    // applyCrud already refreshes the workspace snapshot on success, so the
    // derived `annotations` memo picks up the new record without local state.
  }, [activeProjectId, resolvedSourceId, applyCrud, snapshot, t]);

  // ─── Selection capture ────────────────────────────────────

  /** Convert the current window selection (inside the text layer) into a
   * pending annotation: derive page-local char offsets and screen rects.
   */
  const captureTextSelection = useCallback(() => {
    const pageText = pageTextMap.get(currentPage);
    const wrapper = pageWrapperRef.current;
    const textLayer = textLayerRef.current;
    if (!pageText || !wrapper || !textLayer) return;

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const selectedText = selection.toString();
    if (!selectedText.trim()) return;

    // The selection must live inside this page's text layer.
    if (!textLayer.contains(range.commonAncestorContainer)) return;

    // Derive the page-local char offset by walking text-layer spans in order
    // and summing their text lengths up to the selection start.
    let charStart = -1;
    let charEnd = -1;
    let offset = 0;
    const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const len = node.textContent?.length ?? 0;
      if (charStart < 0 && node === range.startContainer) charStart = offset + range.startOffset;
      if (charEnd < 0 && node === range.endContainer) charEnd = offset + range.endOffset;
      offset += len;
      if (charStart >= 0 && charEnd >= 0) break;
      node = walker.nextNode();
    }
    if (charStart < 0 || charEnd < 0 || charStart >= charEnd) return;

    const wrapperRect = wrapper.getBoundingClientRect();
    const rects = Array.from(range.getClientRects())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({
        left: r.left - wrapperRect.left,
        top: r.top - wrapperRect.top,
        width: r.width,
        height: r.height,
      }));
    if (rects.length === 0) return;

    const built = anchorFromPdfSelection(currentPaperId ?? 'file', currentPage, charStart, charEnd, selectedText);
    const firstRect = rects[0]!;
    setPendingSelection({
      anchor: built.anchor,
      snippet: built.snippet,
      rects,
      menuLeft: firstRect.left,
      menuTop: firstRect.top + firstRect.height + 6,
    });
  }, [currentPage, currentPaperId, pageTextMap]);

  /** Convert a drawn region (in wrapper coordinates) into a pending region
   * annotation. */
  const captureRegionSelection = useCallback((x: number, y: number, w: number, h: number) => {
    // anchorFromPdfRegion encodes x*10000+y / w*10000+h, so clamp to 9999.
    const cx = Math.min(9999, Math.max(0, Math.round(x)));
    const cy = Math.min(9999, Math.max(0, Math.round(y)));
    const cw = Math.min(9999, Math.max(1, Math.round(w)));
    const ch = Math.min(9999, Math.max(1, Math.round(h)));
    const built = anchorFromPdfRegion(currentPaperId ?? 'file', currentPage, cx, cy, cw, ch);
    setPendingSelection({
      anchor: built.anchor,
      snippet: '',
      rects: [{ left: cx, top: cy, width: cw, height: ch }],
      menuLeft: cx,
      menuTop: cy + ch + 6,
    });
  }, [currentPage, currentPaperId]);

  // ─── Region-drag selection ────────────────────────────────

  /** Start a region drag: record the anchor point in wrapper coordinates. */
  const handleRegionMouseDown = useCallback((e: React.MouseEvent) => {
    if (!regionMode) return;
    const wrapper = pageWrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    regionDragRef.current = {
      startX: e.clientX - rect.left,
      startY: e.clientY - rect.top,
      active: true,
    };
    setRegionDragRect(null);
    setPendingSelection(null);
    e.preventDefault();
  }, [regionMode]);

  /** Update the live drag rectangle. */
  const handleRegionMouseMove = useCallback((e: React.MouseEvent) => {
    const drag = regionDragRef.current;
    if (!regionMode || !drag?.active) return;
    const wrapper = pageWrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    const curX = e.clientX - rect.left;
    const curY = e.clientY - rect.top;
    setRegionDragRect({
      left: Math.min(drag.startX, curX),
      top: Math.min(drag.startY, curY),
      width: Math.abs(curX - drag.startX),
      height: Math.abs(curY - drag.startY),
    });
  }, [regionMode]);

  /** Finish the drag and turn it into a pending region annotation. */
  const handleRegionMouseUp = useCallback((e: React.MouseEvent) => {
    const drag = regionDragRef.current;
    if (!regionMode || !drag?.active) return;
    regionDragRef.current = null;
    const rect = regionDragRect;
    setRegionDragRect(null);
    // Ignore accidental tiny drags.
    if (!rect || rect.width < 8 || rect.height < 8) return;
    captureRegionSelection(rect.left, rect.top, rect.width, rect.height);
    e.preventDefault();
  }, [regionMode, regionDragRect, captureRegionSelection]);

  /** Finalize the pending selection as a highlight (no note) or annotation. */
  const commitSelection = useCallback(async (annotate: boolean) => {
    const pending = pendingSelection;
    if (!pending) return;
    if (annotate) {
      // Keep the pending anchor but open the note editor.
      setAnnotateMode(true);
      return;
    }
    await persistAnnotation(pending.anchor, pending.snippet, '', true);
    setPendingSelection(null);
    try { window.getSelection()?.removeAllRanges(); } catch { /* jsdom stub may lack removeAllRanges */ }
  }, [pendingSelection, persistAnnotation]);

  /** Save the note for the pending selection, then clear it. */
  const saveNote = useCallback(async () => {
    const pending = pendingSelection;
    if (!pending) return;
    await persistAnnotation(pending.anchor, pending.snippet, noteDraft.trim(), false);
    setPendingSelection(null);
    setNoteDraft('');
    setAnnotateMode(false);
    setNotePreview(false);
    try { window.getSelection()?.removeAllRanges(); } catch { /* jsdom stub may lack removeAllRanges */ }
  }, [pendingSelection, noteDraft, persistAnnotation]);

  const cancelPending = useCallback(() => {
    setPendingSelection(null);
    setNoteDraft('');
    setAnnotateMode(false);
    setNotePreview(false);
    setAiResult(null);
    setAiLoading(false);
  }, []);

  // ─── AI explanation of the pending selection ─────────────

  /** Ask the provider (via main) to explain/translate the selected passage. */
  const runAiExplain = useCallback(async (action: 'explain' | 'translate' | 'summarize') => {
    const pending = pendingSelection;
    const metis = window.metis;
    if (!pending || !metis?.aiExplainPaper) return;
    setAiLoading(true);
    setAiResult(null);
    try {
      const paper = papers.find((p) => p.id === currentPaperId);
      const result = await metis.aiExplainPaper({
        passage: pending.snippet,
        paperTitle: paper?.title ?? fileName,
        action,
      });
      if (result.ok && result.text) {
        setAiResult(result.text);
      } else {
        setError(t('pdf.aiExplainFailed'));
      }
    } catch {
      setError(t('pdf.aiExplainFailed'));
    } finally {
      setAiLoading(false);
    }
  }, [pendingSelection, currentPaperId, fileName, papers, t]);

  /** Save the AI explanation as the annotation note for the selection. */
  const saveAiAsNote = useCallback(async () => {
    const pending = pendingSelection;
    if (!pending || !aiResult) return;
    await persistAnnotation(pending.anchor, pending.snippet, aiResult, false);
    setPendingSelection(null);
    setAiResult(null);
    setNoteDraft('');
    setAnnotateMode(false);
    setNotePreview(false);
    try { window.getSelection()?.removeAllRanges(); } catch { /* jsdom stub may lack removeAllRanges */ }
  }, [pendingSelection, aiResult, persistAnnotation]);

  // ─── Export annotations to a literature note ─────────────

  /** Bundle every highlight/annotation of this PDF into one literature note. */
  const exportAnnotationsToNote = async () => {
    const paper = papers.find((p) => p.id === currentPaperId);
    if (!paper || annotations.length === 0) return;
    try {
      const byPage = new Map<number, PdfAnnotation[]>();
      for (const a of annotations) {
        const page = a.anchor.pageNumber ?? 0;
        byPage.set(page, [...(byPage.get(page) ?? []), a]);
      }
      const sections = [...byPage.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([page, items]) => {
          const lines = items.map((a) => {
            const snippet = a.snippet ? `> ${a.snippet}` : `> ${t('pdf.annotationRegionSnippet')}`;
            return `${snippet}\n\n${a.note || t('pdf.annotationHighlightOnly')}`;
          });
          return `## ${t('pdf.annotationExportPage', { page })}\n\n${lines.join('\n\n---\n\n')}`;
        })
        .join('\n\n');
      const content = [
        `> ${t('pdf.annotationExportMeta', { date: new Date().toLocaleString() })}`,
        '',
        sections,
      ].join('\n');
      const noteId = `note_pdf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      await useMetisStore.getState().addNote({
        id: noteId,
        title: `${paper.title} · ${t('pdf.annotationExportTitle')}`,
        content,
        tags: [t('pdf.annotationExportTitle'), ...paper.tags.slice(0, 3)],
        linkedPaperIds: [paper.id],
        linkedNoteIds: [],
        starred: false,
        updatedAt: Date.now(),
      });
      setExportFeedback(t('pdf.annotationExported'));
    } catch {
      setExportFeedback(t('pdf.annotationExportFailed'));
    }
  };

  // ─── File input handler ─────────────────────────────────

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === 'application/pdf') {
      loadPdfFromFile(file);
    } else if (file) {
      setError(t('pdf.errorInvalidFile'));
    }
  };

  // ─── Drop zone handler ──────────────────────────────────

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') {
      loadPdfFromFile(file);
    } else {
      setError(t('pdf.errorInvalidDrop'));
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleLoadFromLibrary = useCallback(async (paper: (typeof papers)[number]) => {
    try {
      const metis = window.metis;
      const capability = paper.pdfCapability;
      if (!metis?.useFileCapability || !capability) {
        setError(t('pdf.errorFileAccessUnavailable'));
        return;
      }
      const result = await metis.useFileCapability({
        capabilityId: capability.capabilityId,
        operation: 'read',
        maxBytes: 16 * 1024 * 1024,
      });
      if (!result.success || result.operation !== 'read') {
        setError(t('pdf.errorFileAccessUnavailable'));
        return;
      }
      // Bind this PDF to its library paper so highlights/annotations persist
      // as evidence tied to the paper's source and project.
      setCurrentPaperId(paper.id);
      await loadPdfFromData(new Uint8Array(result.data), paper.title);
    } catch (err) {
      setError(
        uiMode === 'diagnostic'
          ? t('pdf.errorLoadFailedDiagnostic', { error: presentDiagnosticText(String(err)) })
          : t('pdf.errorLoadFailed'),
      );
    }
  }, [loadPdfFromData, t, uiMode]);

  // Open-by-id: requested by the browser "my papers" list or a message
  // citation. The library paper carries a main-process PDF capability.
  useEffect(() => {
    if (!openPaperId) return;
    const paper = papers.find((candidate) => candidate.id === openPaperId);
    if (!paper) return;
    let cancelled = false;
    void (async () => {
      const metis = window.metis;
      const capability = paper.pdfCapability;
      if (!metis?.useFileCapability || !capability) {
        setError(t('pdf.errorFileAccessUnavailable'));
        return;
      }
      const result = await metis.useFileCapability({
        capabilityId: capability.capabilityId,
        operation: 'read',
        maxBytes: 16 * 1024 * 1024,
      });
      if (cancelled || !result.success || result.operation !== 'read') return;
      setCurrentPaperId(paper.id);
      await loadPdfFromData(new Uint8Array(result.data), paper.title);
    })();
    return () => { cancelled = true; };
  }, [openPaperId, papers, loadPdfFromData, t]);


  // ─── Render ─────────────────────────────────────────────

  // No PDF loaded — show drop zone
  if (!pdfDoc) {
    return (
      <div
        className="pdf-reader-page"
        style={{ padding: 24, height: '100%', display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ margin: 0 }}>{t('pdf.pageTitle')}</h2>
          <button
            className="btn-primary"
            onClick={() => fileInputRef.current?.click()}
          >
            {t('pdf.openPdf')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            style={{ display: 'none' }}
            onChange={handleFileInput}
          />
        </div>

        {/* Drop zone */}
        <div
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          style={{
            flex: 1,
            border: '2px dashed var(--border)',
            borderRadius: 12,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
            background: 'var(--bg-hover)',
            cursor: 'pointer',
            transition: 'border-color 0.2s',
          }}
          onClick={() => fileInputRef.current?.click()}
        >
          <svg viewBox="0 0 24 24" width="48" height="48" stroke="var(--text-muted)" fill="none" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 16 }}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
          </svg>
          <h3 style={{ margin: '0 0 8px 0', color: 'var(--text-secondary)' }}>{t('pdf.dropZoneTitle')}</h3>
          <p style={{ margin: 0, color: 'var(--text-muted)' }}>{t('pdf.dropZoneSubtitle')}</p>
        </div>

        {/* Papers with PDF paths */}
        {papersWithPdf.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <h3 style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8 }}>{t('pdf.fromLibrary')}</h3>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {papersWithPdf.map((p) => (
                <div
                  key={p.id}
                  onClick={() => { void handleLoadFromLibrary(p); }}
                  style={{
                    padding: '8px 12px',
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    fontSize: 12,
                    cursor: 'pointer',
                    color: 'var(--text-primary)',
                  }}
                >
                  {p.title.slice(0, 40)}{p.title.length > 40 ? '...' : ''}
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div style={{ marginTop: 12, padding: '8px 12px', background: 'var(--status-failed-bg)', color: 'var(--status-failed)', borderRadius: 6, fontSize: 13 }}>
            {error}
          </div>
        )}
      </div>
    );
  }

  // PDF loaded — show reader
  return (
    <div
      className="pdf-reader-page"
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      {/* Toolbar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-card)',
        flexShrink: 0,
      }}>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="toolbar-btn"
        >
          {t('pdf.toolbarOpen')}
        </button>
        <input ref={fileInputRef} type="file" accept=".pdf" style={{ display: 'none' }} onChange={handleFileInput} />

        <div className="toolbar-separator" />

        {/* Page navigation */}
        <button onClick={() => goToPage(1)} disabled={currentPage <= 1} className="toolbar-btn" title="First page">
          <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 17l-5-5 5-5" /><path d="M18 17l-5-5 5-5" /></svg>
        </button>
        <button onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} className="toolbar-btn" title="Previous page">
          <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 80, textAlign: 'center' }}>
          {t('pdf.toolbarPageInfo', { current: currentPage, total: totalPages })}
        </span>
        <button onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= totalPages} className="toolbar-btn" title="Next page">
          <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
        </button>
        <button onClick={() => goToPage(totalPages)} disabled={currentPage >= totalPages} className="toolbar-btn" title="Last page">
          <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 17l5-5-5-5" /><path d="M6 17l5-5-5-5" /></svg>
        </button>

        {/* O9: jump to References / jump from citation number to reference entry */}
        {referenceSection && (
          <button
            onClick={jumpToReferences}
            className="toolbar-btn"
            title={t('pdf.jumpToReferences')}
            data-testid="pdf-jump-to-references"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>
            <span style={{ marginLeft: 4 }}>{t('pdf.references')}</span>
          </button>
        )}

        {/* O9: back to the reading position after a reference jump. */}
        {jumpStack.length > 0 && (
          <button
            onClick={jumpBack}
            className="toolbar-btn"
            title={t('pdf.jumpBack')}
            data-testid="pdf-jump-back"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14l-4-4 4-4" /><path d="M5 10h11a4 4 0 0 1 0 8h-3" /></svg>
            <span style={{ marginLeft: 4 }}>{t('pdf.jumpBack')}</span>
          </button>
        )}

        <div className="toolbar-separator" />

        {/* Zoom controls */}
        <button onClick={() => handleZoom(zoom - 0.25)} className="toolbar-btn">
          −
        </button>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)', minWidth: 50, textAlign: 'center' }}>
          {Math.round(zoom * 100)}%
        </span>
        <button onClick={() => handleZoom(zoom + 0.25)} className="toolbar-btn">
          +
        </button>
        <button onClick={() => handleZoom(1.0)} className="toolbar-btn">
          {t('pdf.toolbarFit')}
        </button>

        <div className="toolbar-separator" />

        {/* Annotation mode toggles */}
        <button
          onClick={() => { setRegionMode((v) => !v); setPendingSelection(null); }}
          className={`toolbar-btn ${regionMode ? 'active' : ''}`}
          title={t('pdf.annotationRegionTooltip')}
        >
          {t('pdf.annotationRegionMode')}
        </button>
        <button
          onClick={() => { setExportFeedback(null); void exportAnnotationsToNote(); }}
          className="toolbar-btn"
          data-testid="pdf-export-annotations"
          disabled={annotations.length === 0 || !currentPaperId}
          title={t('pdf.annotationExportTooltip')}
        >
          {t('pdf.annotationExport')}
        </button>

        <div className="toolbar-separator" />

        {/* Search */}
        <input
          type="text"
          placeholder={t('pdf.toolbarSearchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
          style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border)', fontSize: 12, width: 160, background: 'var(--bg-input)', color: 'var(--text-primary)' }}
        />
        <button onClick={handleSearch} className="toolbar-btn">
          {t('pdf.toolbarFind')}
        </button>
        {searchResults.length > 0 && (
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {currentSearchIdx + 1}/{searchResults.length}
          </span>
        )}

        <div style={{ flex: 1 }} />

        {/* Sidebar toggles */}
        <button
          onClick={() => { setSidebarTab('pages'); setShowOutline(!showOutline); }}
          className={`toolbar-btn ${sidebarTab === 'pages' && showOutline ? 'active' : ''}`}
        >
          {t('pdf.toolbarPages')}
        </button>
        <button
          onClick={() => { setSidebarTab('outline'); setShowOutline(!showOutline); }}
          className={`toolbar-btn ${sidebarTab === 'outline' && showOutline ? 'active' : ''}`}
        >
          {t('pdf.toolbarOutline')}
        </button>
        <button
          onClick={() => { setSidebarTab('text'); setShowText(!showText); }}
          className={`toolbar-btn ${showText ? 'active' : ''}`}
        >
          {t('pdf.toolbarText')}
        </button>

        {/* File name */}
        <span style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {fileName}
        </span>
      </div>

      {/* Content area */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Sidebar */}
        {showOutline && (
          <div style={{
            width: 200,
            borderRight: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
            overflow: 'auto',
            flexShrink: 0,
          }}>
            {sidebarTab === 'pages' && (
              <div style={{ padding: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>{t('pdf.sidebarPagesTitle')}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                  {thumbnails.map((thumb) => (
                    <div
                      key={thumb.num}
                      onClick={() => goToPage(thumb.num)}
                      style={{
                        padding: '8px 4px',
                        textAlign: 'center',
                        background: currentPage === thumb.num ? 'var(--bg-active)' : 'var(--bg-card)',
                        border: currentPage === thumb.num ? '1px solid var(--primary)' : '1px solid var(--border)',
                        borderRadius: 4,
                        cursor: 'pointer',
                        fontSize: 11,
                        color: currentPage === thumb.num ? 'var(--primary)' : 'var(--text-secondary)',
                      }}
                    >
                      {thumb.num}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {sidebarTab === 'outline' && (
              <div style={{ padding: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, fontWeight: 600 }}>{t('pdf.sidebarOutlineTitle')}</div>
                {outline.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('pdf.sidebarNoOutline')}</div>
                ) : (
                  outline.map((item, idx) => (
                    <div
                      key={idx}
                      style={{
                        padding: '6px 8px',
                        fontSize: 12,
                        color: 'var(--text-primary)',
                        cursor: 'pointer',
                        borderRadius: 4,
                        marginBottom: 2,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      {item.title}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {/* PDF Canvas */}
        <div style={{
          flex: 1,
          overflow: 'auto',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-start',
          padding: 16,
          background: 'var(--bg-secondary)',
        }}>
          {isLoading ? (
            <div style={{ color: 'var(--text-secondary)', marginTop: 40 }}>Loading PDF...</div>
          ) : (
            <div
              ref={pageWrapperRef}
              className={`pdf-page-wrapper ${regionMode ? 'pdf-page-wrapper--region' : ''}`}
              onMouseUp={regionMode ? handleRegionMouseUp : captureTextSelection}
              onMouseDown={regionMode ? handleRegionMouseDown : undefined}
              onMouseMove={regionMode ? handleRegionMouseMove : undefined}
            >
              <canvas
                ref={canvasRef}
                style={{
                  boxShadow: 'var(--shadow-card)',
                  background: 'var(--bg-card)',
                  display: 'block',
                }}
              />
              {/* Invisible text layer that makes PDF text selectable. */}
              <div ref={textLayerRef} className="textLayer" />
              {/* Persistent highlight overlay. */}
              <div ref={highlightLayerRef} className="pdf-highlight-layer">
                {annotations
                  .filter((a) => a.anchor.pageNumber === currentPage)
                  .map((a) => (
                    <HighlightRect
                      key={a.id}
                      annotation={a}
                      stale={a.sourceVersionHash !== null && a.sourceVersionHash !== currentSourceHash}
                    />
                  ))}
              </div>
              {/* Live drag rectangle while region-selecting. */}
              {regionDragRect && (
                <div
                  className="pdf-highlight-rect pdf-highlight-rect--pending"
                  style={{
                    position: 'absolute',
                    left: regionDragRect.left,
                    top: regionDragRect.top,
                    width: regionDragRect.width,
                    height: regionDragRect.height,
                    zIndex: 5,
                  }}
                />
              )}
              {/* Pending selection overlay + action menu. */}
              {pendingSelection && (
                <>
                  <div className="pdf-highlight-layer pdf-highlight-layer--pending">
                    {pendingSelection.rects.map((r, i) => (
                      <div
                        key={i}
                        className="pdf-highlight-rect pdf-highlight-rect--pending"
                        style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
                      />
                    ))}
                  </div>
                  <div
                    className="pdf-annotation-menu"
                    style={{ left: pendingSelection.menuLeft, top: pendingSelection.menuTop }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {!annotateMode ? (
                      <>
                        <button className="toolbar-btn" onClick={() => void commitSelection(false)}>
                          {t('pdf.annotationHighlight')}
                        </button>
                        <button className="toolbar-btn" onClick={() => void commitSelection(true)}>
                          {t('pdf.annotationAdd')}
                        </button>
                        <button
                          className="toolbar-btn"
                          data-testid="pdf-ai-explain"
                          disabled={aiLoading || !pendingSelection.snippet}
                          onClick={() => void runAiExplain('explain')}
                        >
                          {aiLoading ? t('pdf.aiExplainLoading') : t('pdf.aiExplain')}
                        </button>
                        {/* O9: when the selection is a citation marker like [12] or (12), offer a jump to the reference entry. */}
                        {referenceSection && (() => {
                          const refMatch = pendingSelection.snippet.match(/\[(\d+)\]|\((\d+)\)/);
                          const refNum = refMatch ? Number(refMatch[1] ?? refMatch[2]) : null;
                          return refNum !== null ? (
                            <button
                              className="toolbar-btn"
                              data-testid="pdf-jump-to-ref"
                              title={t('pdf.jumpToReference')}
                              onClick={() => jumpToReference(refNum)}
                            >
                              {t('pdf.jumpToReference')}
                            </button>
                          ) : null;
                        })()}
                        <button className="toolbar-btn" onClick={cancelPending}>
                          {t('common.cancel')}
                        </button>
                      </>
                    ) : (
                      <div className="pdf-annotation-editor" onMouseUp={(e) => e.stopPropagation()}>
                        {notePreview ? (
                          <div className="pdf-annotation-preview">
                            <SafeMarkdown content={noteDraft || t('pdf.annotationEmptyNote')} uiMode={uiMode} locale={locale} />
                          </div>
                        ) : (
                          <textarea
                            className="pdf-annotation-input"
                            value={noteDraft}
                            onChange={(e) => setNoteDraft(e.target.value)}
                            placeholder={t('pdf.annotationPlaceholder')}
                            rows={3}
                            autoFocus
                          />
                        )}
                        <div className="pdf-annotation-editor-actions">
                          <button className="toolbar-btn" onClick={() => setNotePreview((v) => !v)}>
                            {notePreview ? t('common.edit') : t('common.preview')}
                          </button>
                          <button className="toolbar-btn" onClick={() => void saveNote()} disabled={!noteDraft.trim()}>
                            {t('pdf.annotationSave')}
                          </button>
                          <button className="toolbar-btn" onClick={cancelPending}>
                            {t('common.cancel')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}
              {/* AI explanation panel for the pending selection. */}
              {aiResult && pendingSelection && (
                <div
                  className="pdf-ai-result"
                  data-testid="pdf-ai-result"
                  style={{
                    position: 'absolute',
                    left: Math.max(0, pendingSelection.menuLeft),
                    top: pendingSelection.menuTop + 44,
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onMouseUp={(e) => e.stopPropagation()}
                >
                  <div className="pdf-ai-result__title">{t('pdf.aiExplain')}</div>
                  <div className="pdf-ai-result__body">
                    <SafeMarkdown content={aiResult} uiMode={uiMode} locale={locale} />
                  </div>
                  <div className="pdf-ai-result__actions">
                    <button className="toolbar-btn" data-testid="pdf-ai-save-note" onClick={() => void saveAiAsNote()}>
                      {t('pdf.aiExplainSaveNote')}
                    </button>
                    <button className="toolbar-btn" onClick={() => setAiResult(null)}>
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Text extraction panel */}
        {showText && (
          <div style={{
            width: 300,
            borderLeft: '1px solid var(--border)',
            background: 'var(--bg-card)',
            overflow: 'auto',
            flexShrink: 0,
          }}>
            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
              {t('pdf.extractedTextTitle')}
            </div>
            <div style={{ padding: 12, fontSize: 12, color: 'var(--text-primary)', lineHeight: 1.6, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
              {extractedText || t('pdf.extractedTextEmpty')}
            </div>
          </div>
        )}
      </div>

      {/* Search results bar */}
      {searchResults.length > 0 && (
        <div style={{
          padding: '6px 16px',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          flexShrink: 0,
        }}>
          <span style={{ color: 'var(--text-secondary)' }}>
            {searchResults.length} result{searchResults.length !== 1 ? 's' : ''} found
          </span>
          <button
            onClick={goToNextSearchResult}
            className="toolbar-btn"
          >
            Next
          </button>
          <span style={{ color: 'var(--text-muted)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {searchResults[currentSearchIdx]?.text}
          </span>
          <button
            onClick={() => { setSearchResults([]); setSearchQuery(''); }}
            className="toolbar-btn" style={{ color: 'var(--status-failed)' }}
          >
            Clear
          </button>
        </div>
      )}

      {/* Export feedback */}
      {exportFeedback && (
        <div style={{ padding: '6px 16px', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', fontSize: 12, borderTop: '1px solid var(--border)' }} role="status">
          {exportFeedback}
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ padding: '6px 16px', background: 'var(--status-failed-bg)', color: 'var(--status-failed)', fontSize: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}

// ─── Highlight rectangle renderer ────────────────────────────

/** Render a persisted annotation as an overlay rect. For char_range anchors
 * the rect is derived from the text layer spans spanning the char offsets;
 * for region anchors the stored coordinates are decoded directly. The rect is
 * recomputed on mount and whenever the text layer re-renders (page/zoom
 * change) via a ResizeObserver on the text layer. */
function HighlightRect({ annotation, stale = false }: { annotation: PdfAnnotation; stale?: boolean }) {
  const [rects, setRects] = useState<Array<{ left: number; top: number; width: number; height: number }>>([]);
  const [showNote, setShowNote] = useState(false);
  const { t, locale } = useTranslation();
  const { anchor } = annotation;

  useEffect(() => {
    const wrapper = document.querySelector<HTMLElement>('.pdf-page-wrapper');
    const textLayer = wrapper?.querySelector<HTMLElement>('.textLayer');
    if (!wrapper) return;

    const compute = () => {
      if (anchor.type === 'region' && anchor.start != null && anchor.end != null) {
        // Region encoding: start = x*10000+y, end = w*10000+h.
        const x = Math.floor(anchor.start / 10000);
        const y = anchor.start % 10000;
        const w = Math.floor(anchor.end / 10000);
        const h = anchor.end % 10000;
        setRects([{ left: x, top: y, width: w, height: h }]);
        return;
      }
      if (anchor.type === 'char_range' && anchor.start != null && anchor.end != null && textLayer) {
        const wrapperRect = wrapper.getBoundingClientRect();
        const range = document.createRange();
        const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
        let offset = 0;
        let startNode: Node | null = null;
        let startOffset = 0;
        let endNode: Node | null = null;
        let endOffset = 0;
        let node = walker.nextNode();
        while (node) {
          const len = node.textContent?.length ?? 0;
          if (startNode === null && anchor.start < offset + len) {
            startNode = node;
            startOffset = anchor.start - offset;
          }
          if (endNode === null && anchor.end <= offset + len) {
            endNode = node;
            endOffset = anchor.end - offset;
            break;
          }
          offset += len;
          node = walker.nextNode();
        }
        if (!startNode || !endNode) { setRects([]); return; }
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
        const out = Array.from(range.getClientRects())
          .filter((r) => r.width > 0 && r.height > 0)
          .map((r) => ({
            left: r.left - wrapperRect.left,
            top: r.top - wrapperRect.top,
            width: r.width,
            height: r.height,
          }));
        setRects(out);
        range.detach();
        return;
      }
      setRects([]);
    };

    compute();
    // Recompute when the text layer (re)lays out — page/zoom changes.
    const observer = textLayer ? new ResizeObserver(() => compute()) : null;
    if (observer && textLayer) observer.observe(textLayer);
    return () => observer?.disconnect();
  }, [anchor]);

  if (rects.length === 0) return null;
  const rectClass = stale
    ? 'pdf-highlight-rect--stale'
    : annotation.highlightOnly
      ? 'pdf-highlight-rect--mark'
      : 'pdf-highlight-rect--note';
  return (
    <>
      {rects.map((r, i) => (
        <div
          key={i}
          className={`pdf-highlight-rect ${rectClass}`}
          style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
          title={stale ? t('pdf.annotationStale') : undefined}
          onClick={(e) => { e.stopPropagation(); setShowNote((v) => !v); }}
        />
      ))}
      {showNote && !annotation.highlightOnly && rects[0] && (
        <div
          className="pdf-annotation-popover"
          style={{ left: rects[0].left, top: rects[0].top + rects[0].height + 6 }}
          onClick={(e) => e.stopPropagation()}
        >
          {stale && <div className="pdf-annotation-stale-badge">{t('pdf.annotationStale')}</div>}
          <SafeMarkdown content={annotation.note} uiMode="normal" locale={locale} />
        </div>
      )}
    </>
  );
}
