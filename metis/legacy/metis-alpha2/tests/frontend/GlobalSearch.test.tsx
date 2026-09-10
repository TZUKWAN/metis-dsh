/**
 * GlobalSearch keyboard navigation and selection tests.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeAll, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import GlobalSearch from '../../src/components/GlobalSearch';
import { useMetisStore, type PaperItem, type NoteItem, type ExperimentItem } from '../../src/store';
import { setDiagnosticMode } from '../../engine/capabilities/DiagnosticMode';

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
  if (typeof navigator !== 'undefined' && !navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.resolve() },
      configurable: true,
    });
  }
});

function localDateString(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

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
    doi: '',
    tags: ['nlp'],
    notes: '',
    readStatus: 'read',
    rating: 5,
    addedAt: Date.now(),
    ...overrides,
  };
}

function makeNote(overrides?: Partial<NoteItem>): NoteItem {
  return {
    id: 'note-1',
    title: 'Transformer notes',
    content: 'Notes about attention mechanism.',
    tags: ['deep-learning'],
    linkedPaperIds: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeExperiment(overrides?: Partial<ExperimentItem>): ExperimentItem {
  return {
    id: 'exp-1',
    name: 'Attention ablation',
    description: 'Ablation study on attention heads.',
    status: 'running',
    parameters: { heads: 8 },
    metrics: {},
    tags: ['transformer'],
    notes: '',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('GlobalSearch', () => {
  beforeEach(() => {
    resetStore();
  });

  it('navigates results with arrow keys and selects with Enter', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    useMetisStore.setState({
      papers: [makePaper({ title: 'Paper One' })],
      notes: [makeNote({ title: 'Note One' })],
      experiments: [makeExperiment({ name: 'Experiment One' })],
    });

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'one' } });

    // Three results should be rendered.
    const results = screen.getAllByTestId('search-result');
    expect(results.length).toBe(3);

    // First item selected by default.
    expect(results[0].getAttribute('data-selected')).toBe('true');

    // Arrow down twice wraps? With 3 items: 0->1, 1->2.
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(results[1].getAttribute('data-selected')).toBe('true');

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(results[2].getAttribute('data-selected')).toBe('true');

    // Arrow up once: 2 -> 1.
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(results[1].getAttribute('data-selected')).toBe('true');

    // Press Enter to select second item (notes).
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('notes');
    expect(onClose).toHaveBeenCalled();
    expect(useMetisStore.getState().selectedNote).toBe('note-1');
  });

  it('highlights matching query text in results', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    useMetisStore.setState({
      papers: [makePaper({ title: 'Highlight Me' })],
    });

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'highlight' } });

    const marks = screen.getAllByText('Highlight');
    expect(marks.length).toBeGreaterThan(0);
    const mark = marks.find((el) => el.tagName.toLowerCase() === 'mark');
    expect(mark).toBeDefined();
  });

  it('clamps selected index when the result list shrinks', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    useMetisStore.setState({
      papers: [
        makePaper({ id: 'paper-a', title: 'Alpha One' }),
        makePaper({ id: 'paper-b', title: 'Alpha Two' }),
      ],
    });

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'alpha' } });
    fireEvent.keyDown(window, { key: 'ArrowDown' });

    let results = screen.getAllByTestId('search-result');
    expect(results[1].getAttribute('data-selected')).toBe('true');

    // Shrink results while selectedIndex is still 1.
    act(() => {
      useMetisStore.setState({ papers: [makePaper({ id: 'paper-a', title: 'Alpha One' })] });
    });

    results = screen.getAllByTestId('search-result');
    expect(results.length).toBe(1);
    expect(results[0].getAttribute('data-selected')).toBe('true');

    // Enter should safely select the only remaining result.
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('pdf');
    expect(useMetisStore.getState().selectedPaperId).toBe('paper-a');
  });

  it('includes page navigation results and jumps to a page', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'settings' } });

    const results = screen.getAllByTestId('search-result');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].textContent).toContain('Settings');

    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('settings');
    expect(onClose).toHaveBeenCalled();
    expect(useMetisStore.getState().selectedPaperId).toBeNull();
  });

  it('exposes implemented research destinations while keeping diagnostics hidden', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'research' } });
    expect(screen.getAllByTestId('search-result').some((result) =>
      result.textContent?.includes('Research'),
    )).toBe(true);

    fireEvent.change(input, { target: { value: 'latex' } });
    expect(screen.getAllByTestId('search-result').some((result) =>
      result.textContent?.includes('LaTeX'),
    )).toBe(true);

    fireEvent.change(input, { target: { value: 'eval' } });
    expect(screen.queryAllByTestId('search-result')).toHaveLength(0);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('exposes Evals page navigation only in diagnostic mode', () => {
    setDiagnosticMode('diagnostic');
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);
    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'eval' } });

    expect(screen.getAllByTestId('search-result')[0]?.textContent).toContain('Evals');
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('evals');
  });

  it('ranks title matches higher than body matches', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    useMetisStore.setState({
      papers: [
        makePaper({ id: 'body', title: 'Something else', abstract: 'neural networks are great' }),
        makePaper({ id: 'title', title: 'Neural Architecture Search' }),
      ],
    });

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'neural' } });

    const results = screen.getAllByTestId('search-result');
    expect(results[0].textContent).toContain('Neural Architecture Search');
    expect(results[1].textContent).toContain('Something else');
  });

  it('closes on Escape', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('resets selection when query changes', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    useMetisStore.setState({
      papers: [makePaper({ title: 'Alpha paper' })],
      notes: [makeNote({ title: 'Alpha note' })],
    });

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'alpha' } });
    fireEvent.keyDown(window, { key: 'ArrowDown' });

    const results = screen.getAllByTestId('search-result');
    expect(results[1].getAttribute('data-selected')).toBe('true');

    // Changing query resets selectedIndex to 0.
    fireEvent.change(input, { target: { value: 'alpha paper' } });
    const resultsAfter = screen.getAllByTestId('search-result');
    expect(resultsAfter[0].getAttribute('data-selected')).toBe('true');
  });

  it('filters results by entity type', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    useMetisStore.setState({
      papers: [makePaper({ id: 'paper-a', title: 'Alpha paper' })],
      notes: [makeNote({ id: 'note-a', title: 'Alpha note' })],
      experiments: [makeExperiment({ id: 'exp-a', name: 'Alpha experiment' })],
      collections: [{ id: 'col-a', name: 'Alpha collection', description: '', paperIds: [], createdAt: Date.now() }],
    });

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'alpha' } });

    // All matching results are shown (paper, note, experiment and page results).
    expect(screen.getAllByTestId('search-result').length).toBeGreaterThan(2);

    fireEvent.click(screen.getByTestId('type-filter-paper'));
    expect(screen.getAllByTestId('search-result').length).toBe(1);
    expect(screen.getAllByTestId('search-result')[0].textContent).toContain('Alpha paper');

    fireEvent.click(screen.getByTestId('type-filter-note'));
    expect(screen.getAllByTestId('search-result').length).toBe(1);
    expect(screen.getAllByTestId('search-result')[0].textContent).toContain('Alpha note');

    fireEvent.click(screen.getByTestId('type-filter-experiment'));
    expect(screen.getAllByTestId('search-result').length).toBe(1);
    expect(screen.getAllByTestId('search-result')[0].textContent).toContain('Alpha experiment');

    fireEvent.click(screen.getByTestId('type-filter-page'));
    const pageResults = screen.queryAllByTestId('search-result');
    expect(pageResults.every((el) => el.textContent?.includes('Alpha') === false)).toBe(true);
  });

  it('filters results to starred items only', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    useMetisStore.setState({
      papers: [
        makePaper({ id: 'paper-star', title: 'Starred paper', starred: true }),
        makePaper({ id: 'paper-plain', title: 'Plain paper' }),
      ],
      notes: [makeNote({ id: 'note-plain', title: 'Plain note' })],
    });

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('type-filter-paper'));

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'paper' } });

    expect(screen.getAllByTestId('search-result').length).toBe(2);

    fireEvent.click(screen.getByRole('checkbox', { name: /starred only/i }));

    const results = screen.getAllByTestId('search-result');
    expect(results.length).toBe(1);
    expect(results[0].textContent).toContain('Starred paper');
  });

  it('filters results by tag using tag: prefix or hash syntax', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    useMetisStore.setState({
      papers: [makePaper({ id: 'paper-a', title: 'Alpha paper', tags: ['nlp'] })],
      notes: [makeNote({ id: 'note-a', title: 'Alpha note', tags: ['nlp'] })],
      experiments: [makeExperiment({ id: 'exp-a', name: 'Alpha experiment', tags: ['cv'] })],
    });

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'tag:nlp' } });

    const results = screen.getAllByTestId('search-result');
    expect(results.length).toBe(2);
    expect(results[0].textContent).toContain('Alpha paper');
    expect(results[1].textContent).toContain('Alpha note');

    fireEvent.change(input, { target: { value: '#cv' } });
    expect(screen.getAllByTestId('search-result').length).toBe(1);
    expect(screen.getAllByTestId('search-result')[0].textContent).toContain('Alpha experiment');
  });

  it('finds papers by PDF full text', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    useMetisStore.setState({
      papers: [makePaper({ id: 'paper-pdf', title: 'PDF Paper', abstract: 'short abstract', pdfText: 'This paper introduces a novel attention mechanism for long sequences.' })],
    });

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'long sequences' } });

    const results = screen.getAllByTestId('search-result');
    expect(results.length).toBe(1);
    expect(results[0].textContent).toContain('PDF Paper');
  });

  it('filters papers by priority using priority: prefix', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    useMetisStore.setState({
      papers: [
        makePaper({ id: 'paper-high', title: 'High Priority Paper', priority: 'high' }),
        makePaper({ id: 'paper-low', title: 'Low Priority Paper', priority: 'low' }),
      ],
    });

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'priority:high' } });

    const results = screen.getAllByTestId('search-result');
    expect(results.length).toBe(1);
    expect(results[0].textContent).toContain('High Priority Paper');
  });

  it('filters papers by deadline status using deadline: prefix', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    useMetisStore.setState({
      papers: [
        makePaper({ id: 'paper-overdue', title: 'Overdue Paper', deadline: yesterday }),
        makePaper({ id: 'paper-future', title: 'Future Paper', deadline: '2026-12-31' }),
      ],
    });

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'deadline:overdue' } });

    const results = screen.getAllByTestId('search-result');
    expect(results.length).toBe(1);
    expect(results[0].textContent).toContain('Overdue Paper');
  });

  it('supports p: alias for priority filter', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    useMetisStore.setState({
      papers: [
        makePaper({ id: 'paper-high', title: 'High Priority Paper', priority: 'high' }),
        makePaper({ id: 'paper-medium', title: 'Medium Priority Paper', priority: 'medium' }),
      ],
    });

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'p:medium' } });

    const results = screen.getAllByTestId('search-result');
    expect(results.length).toBe(1);
    expect(results[0].textContent).toContain('Medium Priority Paper');
  });

  it('supports d: alias for deadline filter', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    const tomorrow = localDateString(new Date(Date.now() + 86400000));

    useMetisStore.setState({
      papers: [
        makePaper({ id: 'paper-today', title: 'Due Today Paper', deadline: localDateString() }),
        makePaper({ id: 'paper-tomorrow', title: 'Due Tomorrow Paper', deadline: tomorrow }),
      ],
    });

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'd:today' } });

    const results = screen.getAllByTestId('search-result');
    expect(results.length).toBe(1);
    expect(results[0].textContent).toContain('Due Today Paper');
  });

  it('filters papers by read status using status: prefix', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    useMetisStore.setState({
      papers: [
        makePaper({ id: 'paper-unread', title: 'Unread Paper', readStatus: 'unread' }),
        makePaper({ id: 'paper-read', title: 'Read Paper', readStatus: 'read' }),
      ],
    });

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'status:unread' } });

    const results = screen.getAllByTestId('search-result');
    expect(results.length).toBe(1);
    expect(results[0].textContent).toContain('Unread Paper');
  });

  it('filters papers by is:starred and is:archived', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    useMetisStore.setState({
      papers: [
        makePaper({ id: 'paper-star', title: 'Starred Paper', starred: true }),
        makePaper({ id: 'paper-archive', title: 'Archived Paper', archived: true }),
        makePaper({ id: 'paper-plain', title: 'Plain Paper' }),
      ],
    });

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'is:starred' } });
    expect(screen.getAllByTestId('search-result').length).toBe(1);
    expect(screen.getAllByTestId('search-result')[0].textContent).toContain('Starred Paper');

    fireEvent.change(input, { target: { value: 'is:archived' } });
    expect(screen.getAllByTestId('search-result').length).toBe(1);
    expect(screen.getAllByTestId('search-result')[0].textContent).toContain('Archived Paper');
  });

  it('filters papers by year using year: prefix', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    useMetisStore.setState({
      papers: [
        makePaper({ id: 'paper-2017', title: '2017 Paper', year: 2017 }),
        makePaper({ id: 'paper-2020', title: '2020 Paper', year: 2020 }),
      ],
    });

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'year:2020' } });

    const results = screen.getAllByTestId('search-result');
    expect(results.length).toBe(1);
    expect(results[0].textContent).toContain('2020 Paper');
  });

  it('filters papers by rating using rating: prefix', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    useMetisStore.setState({
      papers: [
        makePaper({ id: 'paper-3', title: 'Three Star Paper', rating: 3 }),
        makePaper({ id: 'paper-5', title: 'Five Star Paper', rating: 5 }),
      ],
    });

    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'rating:4+' } });

    const results = screen.getAllByTestId('search-result');
    expect(results.length).toBe(1);
    expect(results[0].textContent).toContain('Five Star Paper');
  });

  it('shows recent searches from localStorage when query is empty', () => {
    localStorage.setItem('metis:recentSearches', JSON.stringify(['neural', 'alpha']));
    render(<GlobalSearch onNavigate={vi.fn()} onClose={vi.fn()} />);

    const items = screen.getAllByTestId('recent-search-item');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toBe('neural');
    expect(items[1].textContent).toBe('alpha');
  });

  it('saves a query to recent searches when a result is selected', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    useMetisStore.setState({ papers: [makePaper({ title: 'Neural Paper' })] });
    render(<GlobalSearch onNavigate={onNavigate} onClose={onClose} />);

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'neural' } });
    fireEvent.keyDown(window, { key: 'Enter' });

    expect(onClose).toHaveBeenCalled();
    const saved = JSON.parse(localStorage.getItem('metis:recentSearches') || '[]');
    expect(saved).toEqual(['neural']);
  });

  it('clicking a recent search fills the input and filters results', () => {
    localStorage.setItem('metis:recentSearches', JSON.stringify(['alpha']));
    const onNavigate = vi.fn();

    useMetisStore.setState({ papers: [makePaper({ title: 'Alpha paper' })] });
    render(<GlobalSearch onNavigate={onNavigate} onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId('recent-search-item'));

    const input = screen.getByPlaceholderText(/search papers/i) as HTMLInputElement;
    expect(input.value).toBe('alpha');
    expect(screen.getAllByTestId('search-result').length).toBe(1);
    expect(screen.getAllByTestId('search-result')[0].textContent).toContain('Alpha paper');
  });

  it('clears recent searches when clear button is clicked', () => {
    localStorage.setItem('metis:recentSearches', JSON.stringify(['alpha']));
    render(<GlobalSearch onNavigate={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getAllByTestId('recent-search-item').length).toBe(1);
    fireEvent.click(screen.getByTestId('clear-recent-searches'));
    expect(screen.queryAllByTestId('recent-search-item').length).toBe(0);
    expect(localStorage.getItem('metis:recentSearches')).toBeNull();
  });
});
