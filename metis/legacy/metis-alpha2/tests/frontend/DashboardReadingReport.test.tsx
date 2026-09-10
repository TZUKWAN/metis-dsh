/**
 * DashboardPage AI reading report: papers read this week → one-shot report
 * generation → inline modal → optionally save as a literature note.
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, waitFor, act } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMetisStore, type PaperItem } from '../../src/store';

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  }
});

function makePaper(overrides: Partial<PaperItem> & { id: string; title: string }): PaperItem {
  return {
    authors: [],
    year: 2024,
    venue: '',
    abstract: '',
    tags: [],
    notes: '',
    readStatus: 'unread',
    rating: 0,
    starred: false,
    archived: false,
    referenceIds: [],
    addedAt: 0,
    ...overrides,
  };
}

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

describe('DashboardPage AI reading report', () => {
  beforeEach(() => {
    resetStore();
    window.metis = {
      aiSynthesis: vi.fn().mockResolvedValue({
        ok: true,
        text: '## 本周阅读报告\n本周完成了 2 篇论文的阅读…',
      }),
      saveNote: vi.fn().mockResolvedValue(undefined),
    } as unknown as typeof window.metis;
  });

  it('generates a report from papers read this week and saves it as a note', async () => {
    const addNote = vi.fn().mockResolvedValue(undefined);
    const recent = Date.now() - 2 * 86400000; // 2 days ago
    useMetisStore.setState({
      addNote,
      papers: [
        makePaper({ id: 'p1', title: 'Paper Alpha', readStatus: 'read', readAt: recent, abstract: 'Alpha abstract.' }),
        makePaper({ id: 'p2', title: 'Paper Beta', readStatus: 'read', readAt: recent, abstract: 'Beta abstract.' }),
        // Not read this week — must be excluded.
        makePaper({ id: 'p3', title: 'Paper Gamma', readStatus: 'read', readAt: Date.now() - 30 * 86400000 }),
      ],
    } as never);

    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    const { container } = render(<DashboardPage />);

    const btn = await waitFor(() => {
      const found = container.querySelector('[data-testid="dashboard-reading-report"]') as HTMLButtonElement | null;
      expect(found).toBeTruthy();
      return found!;
    });
    await act(async () => { fireEvent.click(btn); });

    await waitFor(() => {
      expect(window.metis?.aiSynthesis).toHaveBeenCalledWith(expect.objectContaining({
        mode: 'report',
        papers: expect.arrayContaining([
          expect.objectContaining({ title: 'Paper Alpha' }),
          expect.objectContaining({ title: 'Paper Beta' }),
        ]),
      }));
    });
    // Gamma (read a month ago) is not part of the report.
    const call = (window.metis!.aiSynthesis as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { papers: Array<{ title: string }> };
    expect(call.papers.map((p) => p.title)).not.toContain('Paper Gamma');

    await waitFor(() => {
      expect(container.querySelector('[data-testid="reading-report-modal"]')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="reading-report-save-note"]')!);
    });
    await waitFor(() => {
      expect(addNote).toHaveBeenCalledWith(expect.objectContaining({
        linkedPaperIds: ['p1', 'p2'],
        content: expect.stringContaining('本周阅读报告'),
      }));
    });
  });

  it('hides the report button when nothing was read this week', async () => {
    useMetisStore.setState({
      papers: [makePaper({ id: 'p1', title: 'Paper Alpha' })],
    });
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    const { container } = render(<DashboardPage />);
    expect(container.querySelector('[data-testid="dashboard-reading-report"]')).toBeNull();
  });
});
