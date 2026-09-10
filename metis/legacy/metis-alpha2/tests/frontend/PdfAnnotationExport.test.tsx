/**
 * PDF annotation export: bundle all highlights/annotations of the open PDF
 * into a single literature note (linked to the paper).
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
      getTextContent: vi.fn(async () => ({ items: [{ str: 'x' }] })),
      streamTextContent: vi.fn(async () => ({ items: [{ str: 'x' }] })),
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
  tags: ['nlp'],
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

async function renderLoadedPage(snapshotOverrides: Record<string, unknown>) {
  researchWorkspaceStore.setState({
    activeProjectId: 'project-pdf',
    snapshot: {
      project: { id: 'project-pdf', name: 'PDF project' },
      sources: [{ id: 'paper-1', deletedAt: null, sourceVersionHash: null }],
      evidence: [],
      noteCodes: [],
      ...snapshotOverrides,
    } as unknown as NonNullable<ReturnType<typeof researchWorkspaceStore.getState>['snapshot']>,
  });
  const { default: PdfReaderPage } = await import('../../src/pages/PdfReaderPage');
  const { container } = render(<PdfReaderPage />);
  const libraryCard = Array.from(container.querySelectorAll('div'))
    .reverse()
    .find((el) => el.textContent?.includes('fixture paper'));
  await act(async () => { libraryCard!.click(); });
  await waitFor(() => expect(renderPageMock).toHaveBeenCalledTimes(1));
  return container;
}

describe('PdfReaderPage annotation export', () => {
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
      saveNote: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof window.metis;
  });

  it('disables the export button when the PDF has no annotations', async () => {
    const container = await renderLoadedPage({});
    const exportBtn = container.querySelector('[data-testid="pdf-export-annotations"]') as HTMLButtonElement;
    expect(exportBtn).toBeTruthy();
    expect(exportBtn.disabled).toBe(true);
  });

  it('exports every highlight and note as a literature note linked to the paper', async () => {
    const addNote = vi.fn().mockResolvedValue(undefined);
    useMetisStore.setState({ addNote } as never);
    const container = await renderLoadedPage({
      evidence: [
        {
          id: 'evidence-1',
          sourceId: 'paper-1',
          deletedAt: null,
          anchorType: 'char_range',
          anchorStart: 0,
          anchorEnd: 10,
          pageNumber: 1,
          snippet: 'Transformer attention',
          sourceVersionHash: null,
        },
        {
          id: 'evidence-2',
          sourceId: 'paper-1',
          deletedAt: null,
          anchorType: 'region',
          anchorStart: 1000,
          anchorEnd: 5000,
          pageNumber: 1,
          snippet: '',
          sourceVersionHash: null,
        },
      ],
      noteCodes: [
        {
          id: 'note-1',
          evidenceId: 'evidence-1',
          code: 'pdf-annotation',
          content: '自注意力的关键机制',
          deletedAt: null,
        },
      ],
    });

    const exportBtn = container.querySelector('[data-testid="pdf-export-annotations"]') as HTMLButtonElement;
    expect(exportBtn.disabled).toBe(false);
    await act(async () => { fireEvent.click(exportBtn); });

    await waitFor(() => {
      expect(addNote).toHaveBeenCalledTimes(1);
    });
    const note = addNote.mock.calls[0]![0] as {
      title: string;
      content: string;
      linkedPaperIds: string[];
      tags: string[];
    };
    expect(note.title).toContain('fixture paper');
    expect(note.linkedPaperIds).toEqual(['paper-1']);
    expect(note.content).toContain('Transformer attention');
    expect(note.content).toContain('自注意力的关键机制');
    expect(note.content).toContain('第 1 页');
    // Region annotation without note is included with a placeholder.
    expect(note.content).toContain('区域批注');
    // Feedback line confirms the export.
    await waitFor(() => {
      expect(container.textContent).toContain('批注已导出');
    });
  });
});
