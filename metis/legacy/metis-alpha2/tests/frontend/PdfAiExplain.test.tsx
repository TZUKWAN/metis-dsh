/**
 * PDF reader AI explanation: select a passage → AI 解读 → one-shot provider
 * call (via main-process IPC) → explanation panel → optionally save as note.
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, waitFor, act } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMetisStore } from '../../src/store';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore';

const renderPageMock = vi.fn(() => ({ promise: Promise.resolve() }));
const getDocumentMock = vi.fn(() => ({
  promise: Promise.resolve({
    numPages: 1,
    getPage: vi.fn(async () => ({
      getViewport: vi.fn(() => ({ width: 612, height: 792 })),
      render: renderPageMock,
      getTextContent: vi.fn(async () => ({ items: [{ str: 'Transformer attention' }] })),
      streamTextContent: vi.fn(async () => ({ items: [{ str: 'Transformer attention' }] })),
    })),
    getOutline: vi.fn(async () => []),
  }),
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: getDocumentMock,
  TextLayer: vi.fn().mockImplementation(() => ({ render: vi.fn(async () => {}) })),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'w.mjs' }));

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  }
});

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

function installSelection(container: HTMLElement) {
  const textLayer = container.querySelector('.textLayer') as HTMLElement;
  textLayer.innerHTML = '';
  textLayer.appendChild(document.createTextNode('Transformer attention'));
  const startNode = textLayer.firstChild as Text;
  const range = document.createRange();
  range.setStart(startNode, 0);
  range.setEnd(startNode, 10);
  range.getClientRects = () => [{ left: 10, top: 20, width: 100, height: 14, right: 110, bottom: 34 }] as unknown as DOMRectList;
  Object.defineProperty(window, 'getSelection', {
    configurable: true,
    value: () => ({
      rangeCount: 1,
      isCollapsed: false,
      toString: () => 'Transformer',
      getRangeAt: () => range,
      removeAllRanges: () => {},
    }),
  });
}

async function renderLoadedPage() {
  researchWorkspaceStore.setState({
    activeProjectId: 'project-pdf',
    snapshot: {
      project: { id: 'project-pdf', name: 'PDF project' },
      sources: [{ id: 'paper-1', deletedAt: null, sourceVersionHash: null }],
      evidence: [],
      noteCodes: [],
    } as unknown as NonNullable<ReturnType<typeof researchWorkspaceStore.getState>['snapshot']>,
  });
  const { default: PdfReaderPage } = await import('../../src/pages/PdfReaderPage');
  const { container } = render(<PdfReaderPage />);
  const libraryCard = Array.from(container.querySelectorAll('div'))
    .reverse()
    .find((el) => el.textContent?.includes('fixture paper'));
  await act(async () => { libraryCard!.click(); });
  await waitFor(() => expect(renderPageMock).toHaveBeenCalledTimes(1));
  installSelection(container);
  const wrapper = container.querySelector('.pdf-page-wrapper') as HTMLElement;
  await act(async () => { fireEvent.mouseUp(wrapper); });
  return container;
}

describe('PdfReaderPage AI explanation', () => {
  beforeEach(() => {
    renderPageMock.mockClear();
    getDocumentMock.mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    researchWorkspaceStore.setState({ activeProjectId: null });
    useMetisStore.setState({ papers: [fixturePaper as never] });
    window.metis = {
      useFileCapability: vi.fn().mockResolvedValue({
        success: true,
        operation: 'read',
        data: new TextEncoder().encode('%PDF fixture').buffer,
      }),
      aiExplainPaper: vi.fn().mockResolvedValue({ ok: true, text: '这段文字描述了 Transformer 的自注意力机制。' }),
    } as unknown as typeof window.metis;
  });

  it('offers an AI explain button on a fresh selection and calls the main process', async () => {
    const container = await renderLoadedPage();

    const explainBtn = container.querySelector('[data-testid="pdf-ai-explain"]') as HTMLButtonElement;
    expect(explainBtn).toBeTruthy();
    await act(async () => { explainBtn.click(); });

    await waitFor(() => {
      expect(window.metis?.aiExplainPaper).toHaveBeenCalledWith(
        expect.objectContaining({ passage: 'Transformer', action: 'explain' }),
      );
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="pdf-ai-result"]')).toBeTruthy();
      expect(container.querySelector('.pdf-ai-result__body')?.textContent).toContain('Transformer');
    });
  });

  it('saves the AI explanation as an annotation note', async () => {
    const applyCrud = vi.fn().mockResolvedValue({ success: true, resourceId: 'evidence-x' });
    researchWorkspaceStore.setState({ applyCrud } as never);
    const container = await renderLoadedPage();

    const explainBtn = container.querySelector('[data-testid="pdf-ai-explain"]') as HTMLButtonElement;
    await act(async () => { explainBtn.click(); });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="pdf-ai-result"]')).toBeTruthy();
    });

    const saveBtn = container.querySelector('[data-testid="pdf-ai-save-note"]') as HTMLButtonElement;
    await act(async () => { saveBtn.click(); });

    await waitFor(() => {
      expect(applyCrud).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'create',
        entityKind: 'evidence',
      }));
    });
    await waitFor(() => {
      expect(applyCrud).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'create',
        entityKind: 'note_code',
        value: expect.objectContaining({ content: '这段文字描述了 Transformer 的自注意力机制。' }),
      }));
    });
    // Panel clears after saving.
    await waitFor(() => {
      expect(container.querySelector('[data-testid="pdf-ai-result"]')).toBeNull();
    });
  });

  it('surfaces an error when the provider call fails', async () => {
    (window.metis as unknown as { aiExplainPaper: unknown }).aiExplainPaper =
      vi.fn().mockResolvedValue({ ok: false, error: 'provider_unavailable' });
    const container = await renderLoadedPage();

    const explainBtn = container.querySelector('[data-testid="pdf-ai-explain"]') as HTMLButtonElement;
    await act(async () => { explainBtn.click(); });

    await waitFor(() => {
      expect(container.querySelector('[data-testid="pdf-ai-result"]')).toBeNull();
    });
    expect(container.textContent).toMatch(/AI 解读失败|explanation failed/i);
  });
});
