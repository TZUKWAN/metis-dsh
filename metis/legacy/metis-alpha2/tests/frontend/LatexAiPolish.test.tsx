/**
 * LatexPreviewPage AI polish: select text in the editor → AI polish →
 * review the result → replace the selection.
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMetisStore } from '../../src/store';

function resetStore() {
  useMetisStore.setState({
    papers: [],
    paperFilter: { query: '' },
    notes: [],
    selectedNote: null,
    experiments: [],
    collections: [],
    selectedCollection: null,
    workflowRuns: [],
    locale: 'zh',
    theme: 'light',
    isHydrated: true,
    selectedPaperId: null,
  });
}

describe('LatexPreviewPage AI polish', () => {
  beforeEach(() => {
    resetStore();
    window.metis = {
      aiPolishLatex: vi.fn().mockResolvedValue({
        ok: true,
        text: '这段文字已被润色为更流畅的学术表达。',
      }),
    } as unknown as typeof window.metis;
  });

  it('polishes the selected editor text and replaces it on apply', async () => {
    const { default: LatexPreviewPage } = await import('../../src/pages/LatexPreviewPage');
    const { container } = render(<LatexPreviewPage />);

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    const original = textarea.value;
    // Select the first 10 characters of the template source.
    await act(async () => {
      textarea.setSelectionRange(0, 10);
      fireEvent.select(textarea);
    });

    const polishBtn = container.querySelector('[data-testid="latex-ai-polish"]') as HTMLButtonElement;
    expect(polishBtn).toBeTruthy();
    await act(async () => { fireEvent.click(polishBtn); });

    await waitFor(() => {
      expect(window.metis?.aiPolishLatex).toHaveBeenCalledWith(expect.objectContaining({
        text: original.slice(0, 10),
        action: 'polish',
      }));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="latex-ai-polish-modal"]')).toBeTruthy();
    });

    // Apply replaces the captured range with the polished text.
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="latex-ai-polish-apply"]')!);
    });
    await waitFor(() => {
      expect(textarea.value).toContain('这段文字已被润色为更流畅的学术表达');
    });
    expect(container.querySelector('[data-testid="latex-ai-polish-modal"]')).toBeNull();
  });

  it('shows an error when the provider call fails', async () => {
    (window.metis as unknown as { aiPolishLatex: unknown }).aiPolishLatex =
      vi.fn().mockResolvedValue({ ok: false, error: 'provider_unavailable' });
    const { default: LatexPreviewPage } = await import('../../src/pages/LatexPreviewPage');
    const { container } = render(<LatexPreviewPage />);

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      textarea.setSelectionRange(0, 10);
      fireEvent.select(textarea);
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="latex-ai-polish"]')!);
    });

    await waitFor(() => {
      expect(container.textContent).toContain('AI 润色失败');
    });
    expect(container.querySelector('[data-testid="latex-ai-polish-modal"]')).toBeNull();
  });
});
