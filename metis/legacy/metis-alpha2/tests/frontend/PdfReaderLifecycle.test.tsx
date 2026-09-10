/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const renderPageMock = vi.fn(() => ({ promise: Promise.resolve() }));
const getDocumentMock = vi.fn(() => ({
  promise: Promise.resolve({
    numPages: 1,
    getPage: vi.fn(async () => ({
      getViewport: vi.fn(() => ({ width: 612, height: 792 })),
      render: renderPageMock,
      getTextContent: vi.fn(async () => ({
        items: [{ str: 'Metis live PDF acceptance' }],
      })),
    })),
    getOutline: vi.fn(async () => []),
  }),
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: getDocumentMock,
}));

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'pdf.worker.test.mjs',
}));

describe('PdfReaderPage render lifecycle', () => {
  beforeEach(() => {
    renderPageMock.mockClear();
    getDocumentMock.mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  });

  it('renders the first page only after the loading canvas has mounted', async () => {
    const { default: PdfReaderPage } = await import('../../src/pages/PdfReaderPage');
    const { container } = render(<PdfReaderPage />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF fixture'], 'fixture.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: vi.fn(async () => new TextEncoder().encode('%PDF fixture').buffer),
    });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(renderPageMock).toHaveBeenCalledTimes(1));
    const canvas = container.querySelector('canvas');
    expect(canvas).toBeTruthy();
    expect(canvas?.width).toBe(612);
    expect(canvas?.height).toBe(792);
  });
});
