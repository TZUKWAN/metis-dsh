/**
 * GlobalSearch full-text mode: paper bodies are searched in the main process
 * (searchPapersFullText) and hits are merged into the result list.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeAll, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import GlobalSearch from '../../src/components/GlobalSearch';
import { useMetisStore, type PaperItem } from '../../src/store';

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  }
  if (typeof Element.prototype.scrollIntoView === 'undefined') {
    Element.prototype.scrollIntoView = () => {};
  }
});

function resetStore() {
  useMetisStore.setState({
    papers: [],
    paperFilter: { query: '' },
    notes: [],
    selectedNote: null,
    experiments: [],
    collections: [],
    workflowRuns: [],
    selectedPaperId: null,
    experimentSearchQuery: '',
    locale: 'en',
    savedFilters: [],
  });
  localStorage.clear();
}

function makePaper(overrides?: Partial<PaperItem>): PaperItem {
  return {
    id: 'paper-1',
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani'],
    year: 2017,
    venue: 'NeurIPS',
    abstract: 'Transformer architecture',
    pdfCapability: undefined,
    tags: ['nlp'],
    notes: '',
    readStatus: 'unread',
    rating: 0,
    starred: false,
    deadline: undefined,
    priority: undefined,
    archived: false,
    addedAt: 0,
    ...overrides,
  };
}

function setMockMetis() {
  (window as Window).metis = {
    searchPapersFullText: vi.fn().mockResolvedValue({
      results: [{
        id: 'paper-1',
        title: 'Attention Is All You Need',
        snippet: '…the attention mechanism is central…',
      }],
    }),
  } as unknown as Window['metis'];
}

function clearMockMetis() {
  (window as Window).metis = undefined;
}

describe('GlobalSearch full-text mode', () => {
  beforeEach(() => {
    resetStore();
    setMockMetis();
  });

  afterEach(() => {
    cleanup();
    clearMockMetis();
  });

  it('searches paper bodies in the main process when full text is enabled', async () => {
    useMetisStore.setState({ papers: [makePaper()] });
    const { unmount } = render(<GlobalSearch onNavigate={() => {}} onClose={() => {}} />);

    // Enable full-text mode, then type a query.
    fireEvent.click(screen.getByTestId('fulltext-toggle'));
    fireEvent.change(screen.getByPlaceholderText('Search papers, notes, experiments...'), {
      target: { value: 'attention mechanism' },
    });

    // Debounce fires after 300ms; wait for the real timer and IPC promise.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await waitFor(() => {
      expect((window as Window).metis?.searchPapersFullText).toHaveBeenCalledWith('attention mechanism');
    });

    // The main-process hit is merged into the results with its snippet.
    await waitFor(() => {
      const hit = screen.getAllByTestId('search-result')
        .find((el) => el.textContent?.includes('the attention mechanism is central'));
      expect(hit).toBeTruthy();
    });

    unmount();
  });

  it('does not call the main process when full-text mode is off', async () => {
    useMetisStore.setState({ papers: [makePaper()] });
    render(<GlobalSearch onNavigate={() => {}} onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('Search papers, notes, experiments...'), {
      target: { value: 'attention' },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect((window as Window).metis?.searchPapersFullText).not.toHaveBeenCalled();
  });

  it('selecting a full-text hit opens the underlying paper', async () => {
    useMetisStore.setState({ papers: [makePaper()] });
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('fulltext-toggle'));
    fireEvent.change(screen.getByPlaceholderText('Search papers, notes, experiments...'), {
      target: { value: 'attention mechanism' },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('search-result').length).toBeGreaterThan(0);
    });

    // Enter selects the (first) result — the full-text hit with selectId.
    fireEvent.keyDown(document.body, { key: 'Enter' });

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith('pdf');
      expect(onClose).toHaveBeenCalled();
    });
    // The paper selected is the real id, not the prefixed display key.
    expect(useMetisStore.getState().selectedPaperId).toBe('paper-1');
  });

  it('replaces a local metadata match with the richer full-text hit', async () => {
    // The paper matches locally via title, and via full text as well.
    useMetisStore.setState({ papers: [makePaper()] });
    const { unmount } = render(<GlobalSearch onNavigate={() => {}} onClose={() => {}} />);

    fireEvent.click(screen.getByTestId('fulltext-toggle'));
    fireEvent.change(screen.getByPlaceholderText('Search papers, notes, experiments...'), {
      target: { value: 'attention' },
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    await waitFor(() => {
      const hits = screen.getAllByTestId('search-result');
      // Only one paper result — the merged full-text hit (snippet shown).
      const paperHits = hits.filter((el) => el.textContent?.includes('Attention Is All You Need'));
      expect(paperHits).toHaveLength(1);
      expect(paperHits[0]?.textContent).toContain('the attention mechanism is central');
    });

    unmount();
  });
});
