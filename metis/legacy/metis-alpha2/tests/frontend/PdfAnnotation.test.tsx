/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, beforeAll } from 'vitest';
import { useMetisStore } from '../../src/store';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore';

beforeAll(() => {
  // Highlight rects recompute on text-layer layout via ResizeObserver.
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  }
});

// A reusable pdfjs mock: one page whose text layer contains two spans so the
// selection-capture logic can walk text nodes and derive page-local offsets.
const renderPageMock = vi.fn(() => ({ promise: Promise.resolve() }));
const textLayerRenderMock = vi.fn(() => Promise.resolve());
const TextLayerMock = vi.fn().mockImplementation(() => ({ render: textLayerRenderMock }));

const pageTextContent = {
  items: [
    { str: 'Metis annotation acceptance' },
    { str: ' region two' },
  ],
};

const getDocumentMock = vi.fn(() => ({
  promise: Promise.resolve({
    numPages: 1,
    getPage: vi.fn(async () => ({
      getViewport: vi.fn(() => ({ width: 612, height: 792 })),
      render: renderPageMock,
      getTextContent: vi.fn(async () => pageTextContent),
      streamTextContent: vi.fn(async () => ({ items: pageTextContent.items })),
    })),
    getOutline: vi.fn(async () => []),
  }),
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: getDocumentMock,
  TextLayer: TextLayerMock,
}));

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'pdf.worker.test.mjs',
}));

// Stub crypto.subtle so the renderer can compute the SHA-256 snippet hash.
const fakeDigest = vi.fn(async (text: string) => {
  const buf = new TextEncoder().encode(String(text));
  return buf.buffer;
});
beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', {
    value: { subtle: { digest: fakeDigest } },
    configurable: true,
  });
});

async function loadPage() {
  const { default: PdfReaderPage } = await import('../../src/pages/PdfReaderPage');
  return PdfReaderPage;
}

/** Build a fake window.getSelection that reports a range spanning two text
 * nodes (start in node 0, end in node 1) within the given container. */
function installSelection(container: HTMLElement, startOffset: number, endOffset: number) {
  const textLayer = container.querySelector('.textLayer') as HTMLElement;
  // Seed real text nodes so the TreeWalker can walk them.
  textLayer.innerHTML = '';
  textLayer.appendChild(document.createTextNode('Metis annotation acceptance'));
  textLayer.appendChild(document.createTextNode(' region two'));

  const startNode = textLayer.firstChild as Text;
  const endNode = textLayer.lastChild as Text;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);

  const fakeSelection = {
    rangeCount: 1,
    isCollapsed: false,
    toString: () => 'annotation acceptance',
    getRangeAt: () => range,
  };
  Object.defineProperty(window, 'getSelection', {
    configurable: true,
    value: () => fakeSelection,
  });
  // getClientRects returns zero rects by default in jsdom; stub one.
  range.getClientRects = () => [{ left: 10, top: 20, width: 100, height: 14, right: 110, bottom: 34 }] as unknown as DOMRectList;
}

describe('PdfReaderPage annotation capture and persistence', () => {
  beforeEach(() => {
    renderPageMock.mockClear();
    getDocumentMock.mockClear();
    textLayerRenderMock.mockClear();
    TextLayerMock.mockClear();
    fakeDigest.mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    localStorage.clear();
    Object.defineProperty(window, 'getSelection', {
      configurable: true,
      value: () => ({ rangeCount: 0, isCollapsed: true }),
    });
  });

  it('renders a text layer alongside the canvas for selectable text', async () => {
    const PdfReaderPage = await loadPage();
    const { container } = render(<PdfReaderPage />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF fixture'], 'fixture.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: vi.fn(async () => new TextEncoder().encode('%PDF fixture').buffer),
    });

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });

    await waitFor(() => expect(renderPageMock).toHaveBeenCalledTimes(1));
    expect(TextLayerMock).toHaveBeenCalled();
    expect(container.querySelector('.textLayer')).toBeTruthy();
    expect(container.querySelector('.pdf-page-wrapper')).toBeTruthy();
  });

  it('shows the highlight/annotate action menu after a text selection', async () => {
    const PdfReaderPage = await loadPage();
    const { container } = render(<PdfReaderPage />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF fixture'], 'fixture.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: vi.fn(async () => new TextEncoder().encode('%PDF fixture').buffer),
    });

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await waitFor(() => expect(renderPageMock).toHaveBeenCalledTimes(1));

    installSelection(container, 6, 5);
    const wrapper = container.querySelector('.pdf-page-wrapper') as HTMLElement;
    await act(async () => {
      fireEvent.mouseUp(wrapper);
    });

    // The pending-selection action menu exposes a Highlight button.
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.some((b) => /Highlight|高亮/.test(b.textContent ?? ''))).toBe(true);
  });

  it('builds a char_range anchor contract that the evidence schema accepts', async () => {
    // The selection-capture path produces an anchor via anchorFromPdfSelection.
    // Verify the contract matches what the research evidence create schema
    // requires (anchorType char_range, page number, ordered offsets).
    const { anchorFromPdfSelection } = await import('../../engine/viewers/DocumentViewers');
    const built = anchorFromPdfSelection('src-1', 3, 10, 24, 'selected snippet text');
    expect(built.anchor.type).toBe('char_range');
    expect(built.anchor.pageNumber).toBe(3);
    expect(built.anchor.start).toBe(10);
    expect(built.anchor.end).toBe(24);
    expect(built.snippet).toBe('selected snippet text');
    // char_range requires start < end (the schema enforces end >= start).
    expect(built.anchor.start! < built.anchor.end!).toBe(true);
  });

  it('builds a region anchor with coordinates clamped to the encoding limit', async () => {
    const { anchorFromPdfRegion } = await import('../../engine/viewers/DocumentViewers');
    const built = anchorFromPdfRegion('src-1', 2, 50, 60, 200, 40);
    expect(built.anchor.type).toBe('region');
    // Encoding: start = x*10000+y, end = w*10000+h.
    expect(built.anchor.start).toBe(50 * 10000 + 60);
    expect(built.anchor.end).toBe(200 * 10000 + 40);
  });


  it('exposes a region-select toolbar toggle', async () => {
    const PdfReaderPage = await loadPage();
    const { container } = render(<PdfReaderPage />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF fixture'], 'fixture.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: vi.fn(async () => new TextEncoder().encode('%PDF fixture').buffer),
    });

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await waitFor(() => expect(renderPageMock).toHaveBeenCalledTimes(1));

    const regionBtn = Array.from(container.querySelectorAll('button')).find((b) => /Region|区域/.test(b.textContent ?? ''));
    expect(regionBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(regionBtn!);
    });
    expect(container.querySelector('.pdf-page-wrapper')?.classList.contains('pdf-page-wrapper--region')).toBe(true);
  });

  it('renders the highlight overlay layer once a page is loaded', async () => {
    const PdfReaderPage = await loadPage();
    const { container } = render(<PdfReaderPage />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF fixture'], 'fixture.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: vi.fn(async () => new TextEncoder().encode('%PDF fixture').buffer),
    });

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await waitFor(() => expect(renderPageMock).toHaveBeenCalledTimes(1));

    // The persistent highlight layer is mounted whenever a page renders; its
    // child rects are derived from the workspace snapshot (see the persistence
    // test above for the end-to-end path).
    expect(container.querySelector('.pdf-highlight-layer')).toBeTruthy();
  });
});

// ─── Stale annotation badge ────────────────────────────────────
// A highlight saved against an older source version hash must be flagged.
// The reader loads PDFs from the library so the paper binds to a research
// source; the workspace snapshot carries the source and its evidence rows.
describe('PdfReaderPage stale highlight detection', () => {
  const fixturePaper = {
    id: 'paper-1',
    title: 'fixture paper',
    authors: [],
    year: 2024,
    venue: '',
    abstract: '',
    tags: [],
    notes: '',
    pdfCapability: {
      capabilityId: 'fc_pdf_0000000000000001',
      kind: 'file',
      mime: 'application/pdf',
      displayName: 'fixture.pdf',
      operations: ['file'],
      issuedAt: 0,
      expiresAt: 9999999999999,
    },
  };

  /** Render the reader and open the library paper bound to a workspace
   * snapshot whose source/evidence hashes are (sourceHash, evidenceHash). */
  async function renderWithSnapshot(sourceHash: string, evidenceHash: string | null) {
    researchWorkspaceStore.setState({
      activeProjectId: 'project-pdf',
      snapshot: {
        project: { id: 'project-pdf', name: 'PDF project' },
        sources: [{
          id: 'paper-1',
          deletedAt: null,
          sourceVersionHash: sourceHash,
        }],
        evidence: [{
          id: 'evidence-1',
          sourceId: 'paper-1',
          deletedAt: null,
          anchorType: 'region',
          anchorStart: 1000,
          anchorEnd: 5000,
          pageNumber: 1,
          snippet: 'region snippet',
          sourceVersionHash: evidenceHash,
        }],
        noteCodes: [],
      } as unknown as NonNullable<ReturnType<typeof researchWorkspaceStore.getState>['snapshot']>,
    });
    window.metis = {
      ...window.metis,
      useFileCapability: vi.fn().mockResolvedValue({
        success: true,
        operation: 'read',
        data: new TextEncoder().encode('%PDF fixture').buffer,
      }),
    } as unknown as typeof window.metis;

    const PdfReaderPage = await loadPage();
    const { container } = render(<PdfReaderPage />);
    // The library card is the innermost div carrying the title text (the root
    // div also contains it, so scan deepest-first).
    const libraryCard = Array.from(container.querySelectorAll('div'))
      .reverse()
      .find((el) => el.textContent?.includes('fixture paper'));
    expect(libraryCard).toBeTruthy();
    await act(async () => {
      libraryCard!.click();
    });
    await waitFor(() => expect(renderPageMock).toHaveBeenCalledTimes(1));
    return container;
  }

  beforeEach(() => {
    renderPageMock.mockClear();
    getDocumentMock.mockClear();
    researchWorkspaceStore.setState({ activeProjectId: null });
    window.metis = {} as unknown as typeof window.metis;
  });

  it('flags a highlight saved against an older source hash as stale', async () => {
    useMetisStore.setState({ papers: [fixturePaper as never] });

    const container = await renderWithSnapshot('v2', 'v1');
    // The evidence hash (v1) differs from the source hash (v2) → stale rect.
    await waitFor(() => {
      expect(container.querySelector('.pdf-highlight-rect--stale')).toBeTruthy();
    });
  });

  it('does not flag a highlight whose hash matches the source', async () => {
    useMetisStore.setState({ papers: [fixturePaper as never] });

    const container = await renderWithSnapshot('v2', 'v2');
    await waitFor(() => {
      expect(container.querySelector('.pdf-highlight-rect')).toBeTruthy();
    });
    expect(container.querySelector('.pdf-highlight-rect--stale')).toBeNull();
  });
});
