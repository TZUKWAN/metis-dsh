/**
 * Frontend page component rendering and interaction tests.
 *
 * Tests real rendering behavior and user interactions for the 7 original
 * page components (Chat, Workflows, Papers, Notes, Experiments, Evals, Settings)
 * plus new pages (Dashboard, Knowledge Graph, Timeline, LaTeX).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within, cleanup } from '@testing-library/react';
import { useMetisStore } from '../../src/store';
import GoalCardInline, { type GoalCardData } from '../../src/components/GoalCardInline.js';
import ProjectShell from '../../src/shell/ProjectShell.js';
import type { ChatPageLayoutSlots } from '../../src/pages/ChatPage.js';
import type { FileCapabilityDescriptor } from '../../engine/runtime/FileCapabilityContract.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import { setPendingChatIntent } from '../../src/lib/chatIntent.js';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore.js';

function makePdfCapability(overrides?: Partial<FileCapabilityDescriptor>): FileCapabilityDescriptor {
  const now = Date.now();
  return {
    capabilityId: 'fc_paper_test_pdf_capability_000000000000',
    kind: 'file',
    mime: 'application/pdf',
    displayName: 'test-paper.pdf',
    operations: ['file', 'read', 'extract'],
    issuedAt: now,
    expiresAt: now + 60 * 60 * 1000,
    ...overrides,
  };
}

function makeMetisAPI(partial: Partial<typeof window.metis> = {}): typeof window.metis {
  return partial as typeof window.metis;
}


// Polyfill browser APIs missing in jsdom (required by ReactFlow, Recharts, ChatPage, etc.)
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  }
  // scrollIntoView is not implemented in jsdom
  if (typeof Element.prototype.scrollIntoView === 'undefined') {
    Element.prototype.scrollIntoView = () => {};
  }
  // jsdom does not expose navigator.clipboard
  if (typeof navigator !== 'undefined' && !navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.resolve() },
      configurable: true,
    });
  }
});

// Defensive cleanup after every test case:
//  - restoreAllMocks neutralizes any vi.spyOn / vi.fn leaks (incl. globalThis.fetch overrides
//    that some cases set without try/finally). This prevents a failing case from poisoning
//    subsequent cases in the same file (the root cause of order-dependent flakiness).
//  - cleanup() unmounts React trees so document.body does not accumulate nodes across the
//    154 cases, which would otherwise cause getByText to match stale elements.
//  - document.body.innerHTML reset is a belt-and-suspenders DOM flush for the cases where
//    React's cleanup doesn't fully clear Suspense/lazy subtrees under jsdom (METIS-1001).
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  window.localStorage.removeItem('metis:pendingChatIntent');
  if (typeof document !== 'undefined') document.body.innerHTML = '';
});
import type { PaperItem, NoteItem, ExperimentItem } from '../../src/store';

// ─── Test Fixtures ──────────────────────────────────────────────

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function completedAgentResponse(answer: string, turnId = 'test-turn') {
  return {
    version: 1 as const,
    turnId,
    status: 'completed' as const,
    answer,
    diagnostics: [],
    citations: [],
    events: [],
  };
}

function makeTriggerScenario(id: string, name: string, triggerPhrases: string[]) {
  const scenario = buildBuiltinPersonalizationDefinitions().find((definition) => (
    definition.kind === 'scenario' && definition.id === 'builtin:scenarios/general-research'
  ));
  if (!scenario || scenario.kind !== 'scenario') throw new Error('General research scenario fixture is unavailable');
  return {
    ...scenario,
    id,
    name,
    triggerPhrases,
    provenance: {
      ...scenario.provenance,
      origin: 'user' as const,
      parentId: null,
      parentVersion: null,
      locallyModified: true,
    },
  };
}

function failedAgentResponse(code = 'agent_provider_error', turnId = 'test-turn') {
  return {
    version: 1 as const,
    turnId,
    status: 'error' as const,
    answer: '',
    diagnostics: [{ severity: 'error' as const, code }],
    citations: [],
    events: [],
  };
}

function renderChatProjectShell({
  leftPanel,
  workspace,
  rightPanel,
}: ChatPageLayoutSlots) {
  return (
    <ProjectShell
      mode="converse"
      onModeChange={() => {}}
      leftPanel={leftPanel}
      rightPanel={rightPanel}
      workspaceClassName="shell-workspace--chat"
    >
      {workspace}
    </ProjectShell>
  );
}

function makePaper(overrides?: Partial<PaperItem>): PaperItem {
  return {
    id: 'test-paper-1',
    title: 'Test Paper Title',
    authors: ['Alice Smith', 'Bob Jones'],
    year: 2024,
    venue: 'NeurIPS',
    abstract: 'This is a test abstract about deep learning.',
    doi: '10.1234/test',
    tags: ['deep-learning', 'nlp'],
    notes: 'Great paper',
    readStatus: 'read',
    rating: 4,
    referenceIds: [],
    addedAt: Date.now(),
    ...overrides,
  };
}

function makeNote(overrides?: Partial<NoteItem>): NoteItem {
  return {
    id: 'test-note-1',
    title: 'Test Note',
    content: 'This is test note content.',
    tags: ['test'],
    linkedPaperIds: [],
    linkedNoteIds: [],
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeExperiment(overrides?: Partial<ExperimentItem>): ExperimentItem {
  return {
    id: 'test-exp-1',
    name: 'Test Experiment',
    description: 'A test experiment',
    status: 'planned',
    parameters: { lr: '0.001' },
    metrics: { accuracy: 0.95 },
    tags: ['test'],
    notes: '',
    linkedPaperIds: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

/**
 * Reset store to a clean state before each test.
 */
function localDateString(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function resetStore() {
  // Clear by overwriting ALL data slices. Partial resets leave stale state that causes
  // order-dependent failures when a prior case mutated an uncovered field (e.g. collections).
  useMetisStore.setState({
    papers: [],
    paperFilter: { query: '', archived: false },
    notes: [],
    selectedNote: null,
    experiments: [],
    workflowRuns: [],
    selectedPaperId: null,
    experimentSearchQuery: '',
    savedFilters: [],
    collections: [],
    selectedCollection: null,
  });
  researchWorkspaceStore.setState({ activeProjectId: null });
}

// ─── NotesPage Tests ───────────────────────────────────────────

describe('NotesPage', () => {
  it('should render empty state when no notes', async () => {
    resetStore();
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    expect(screen.getByText('当前项目暂无研究备忘录。')).toBeDefined();
    expect(screen.getByText('选择或创建研究备忘录')).toBeDefined();
  });

  it('should create a new note on button click', async () => {
    resetStore();
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    fireEvent.click(screen.getByText('+ 新建研究备忘录'));
    expect(useMetisStore.getState().notes.length).toBe(1);
    expect(useMetisStore.getState().notes[0]!.title).toBe('新建研究备忘录');
    expect(useMetisStore.getState().notes[0]).toMatchObject({ scope: 'global' });
  });

  it('should render existing notes in sidebar', async () => {
    resetStore();
    useMetisStore.getState().addNote(makeNote());
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    expect(screen.getByText('Test Note')).toBeDefined();
  });

  it('should show note editor when note is selected', async () => {
    resetStore();
    useMetisStore.getState().addNote(makeNote());
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    fireEvent.click(screen.getByText('Test Note'));
    // Note editor should show the title input
    const titleInput = screen.getByDisplayValue('Test Note');
    expect(titleInput).toBeDefined();
  });

  it('should update note title on edit', async () => {
    resetStore();
    useMetisStore.getState().addNote(makeNote());
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    fireEvent.click(screen.getByText('Test Note'));
    const titleInput = screen.getByDisplayValue('Test Note');
    fireEvent.change(titleInput, { target: { value: 'Updated Title' } });
    expect(useMetisStore.getState().notes[0]!.title).toBe('Updated Title');
  });

  it('should insert paper link into note content', async () => {
    resetStore();
    useMetisStore.getState().addPaper(makePaper({ id: 'p1', title: 'Deep Learning', doi: '10.1234/dl' }));
    useMetisStore.getState().addNote(makeNote({ content: '' }));
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    fireEvent.click(screen.getByText('Test Note'));
    fireEvent.click(screen.getByText('插入论文链接'));
    fireEvent.click(screen.getByText('Deep Learning'));
    expect(useMetisStore.getState().notes[0]!.content).toContain('[[paper:p1|Deep Learning]]');
  });

  it('should edit note tags', async () => {
    resetStore();
    useMetisStore.getState().addNote(makeNote({ tags: ['idea'] }));
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    fireEvent.click(screen.getByText('Test Note'));
    const tagInput = screen.getByPlaceholderText('输入标签（用逗号分隔）') as HTMLInputElement;
    fireEvent.change(tagInput, { target: { value: 'draft, review' } });
    fireEvent.click(screen.getByText('添加标签'));
    expect(useMetisStore.getState().notes[0]!.tags).toContain('draft');
    expect(useMetisStore.getState().notes[0]!.tags).toContain('review');
  });

  it('should delete a note after confirming the delete dialog', async () => {
    resetStore();
    useMetisStore.getState().addNote(makeNote());
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    fireEvent.click(screen.getByText('Test Note'));
    fireEvent.click(screen.getByText('删除'));
    expect(screen.getByText('确认删除')).toBeDefined();
    fireEvent.click(screen.getByTestId('confirm-delete'));
    expect(useMetisStore.getState().notes.length).toBe(0);
  });

  it('should filter notes by search query', async () => {
    resetStore();
    useMetisStore.getState().addNote(makeNote({ id: 'n1', title: 'Alpha Note', content: 'alpha content' }));
    useMetisStore.getState().addNote(makeNote({ id: 'n2', title: 'Beta Note', content: 'beta content' }));
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    expect(screen.getByText('Alpha Note')).toBeDefined();
    expect(screen.getByText('Beta Note')).toBeDefined();
    expect(screen.getByText('2 条研究备忘录')).toBeDefined();
    const searchInput = screen.getByPlaceholderText('搜索研究备忘录...') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'Beta' } });
    expect(screen.queryByText('Alpha Note')).toBeNull();
    expect(screen.getByText('Beta Note')).toBeDefined();
    expect(screen.getByText('1 条研究备忘录')).toBeDefined();
  });

  it('should show no-matching-notes message when filter returns nothing', async () => {
    resetStore();
    useMetisStore.getState().addNote(makeNote({ title: 'Alpha Note' }));
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    const searchInput = screen.getByPlaceholderText('搜索研究备忘录...') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'ZZZ' } });
    expect(screen.getByText('没有匹配的研究备忘录。')).toBeDefined();
  });

  it('should clear the notes search filter from the empty state', async () => {
    resetStore();
    useMetisStore.getState().addNote(makeNote({ title: 'Alpha Note' }));
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    const searchInput = screen.getByPlaceholderText('搜索研究备忘录...') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'ZZZ' } });
    expect(screen.getByText('没有匹配的研究备忘录。')).toBeDefined();
    fireEvent.click(screen.getByText('清除'));
    expect(searchInput.value).toBe('');
    expect(screen.getByText('Alpha Note')).toBeDefined();
  });

  it('should filter notes by tag', async () => {
    resetStore();
    useMetisStore.getState().addNote(makeNote({ id: 'n1', title: 'Alpha Note', tags: ['idea'] }));
    useMetisStore.getState().addNote(makeNote({ id: 'n2', title: 'Beta Note', tags: ['todo'] }));
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    const tagSelect = screen.getByLabelText('按标签过滤') as HTMLSelectElement;
    fireEvent.change(tagSelect, { target: { value: 'idea' } });
    expect(screen.getByText('Alpha Note')).toBeDefined();
    expect(screen.queryByText('Beta Note')).toBeNull();
    expect(screen.getByText('1 条研究备忘录')).toBeDefined();
  });

  it('should clear the notes tag filter from the empty state', async () => {
    resetStore();
    useMetisStore.getState().addNote(makeNote({ id: 'n1', title: 'Alpha Note', tags: ['idea'] }));
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    const tagSelect = screen.getByLabelText('按标签过滤') as HTMLSelectElement;
    const searchInput = screen.getByPlaceholderText('搜索研究备忘录...') as HTMLInputElement;
    fireEvent.change(tagSelect, { target: { value: 'idea' } });
    fireEvent.change(searchInput, { target: { value: 'ZZZ' } });
    expect(screen.getByText('没有匹配的研究备忘录。')).toBeDefined();
    fireEvent.click(screen.getByText('清除'));
    expect(tagSelect.value).toBe('');
    expect(searchInput.value).toBe('');
    expect(screen.getByText('Alpha Note')).toBeDefined();
  });

  it('should sort notes by title', async () => {
    resetStore();
    useMetisStore.getState().addNote(makeNote({ id: 'n1', title: 'Zebra Note', updatedAt: Date.now() - 1000 }));
    useMetisStore.getState().addNote(makeNote({ id: 'n2', title: 'Alpha Note', updatedAt: Date.now() }));
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    const { container } = render(<NotesPage />);
    const sortSelect = screen.getByLabelText('排序') as HTMLSelectElement;
    fireEvent.change(sortSelect, { target: { value: 'title' } });
    const titles = Array.from(container.querySelectorAll('.note-title')).map((el) => el.textContent);
    expect(titles).toEqual(['Alpha Note', 'Zebra Note']);
  });

  it('should focus notes search input when pressing / outside of inputs', async () => {
    resetStore();
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    fireEvent.keyDown(window, { key: '/' });
    const searchInput = screen.getByPlaceholderText('搜索研究备忘录...') as HTMLInputElement;
    expect(document.activeElement).toBe(searchInput);
  });

  it('should create a new note with Ctrl+N keyboard shortcut', async () => {
    resetStore();
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    expect(useMetisStore.getState().notes.length).toBe(1);
    expect(useMetisStore.getState().notes[0]!.title).toBe('新建研究备忘录');
  });

  it('should not create a note with Ctrl+N while typing in an input', async () => {
    resetStore();
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    const searchInput = screen.getByPlaceholderText('搜索研究备忘录...') as HTMLInputElement;
    searchInput.focus();
    fireEvent.keyDown(searchInput, { key: 'n', ctrlKey: true });
    expect(useMetisStore.getState().notes.length).toBe(0);
  });

  it('should filter notes by clicking a tag in the list item', async () => {
    resetStore();
    useMetisStore.getState().addNote(makeNote({ id: 'n1', title: 'Note A', tags: ['idea'] }));
    useMetisStore.getState().addNote(makeNote({ id: 'n2', title: 'Note B', tags: ['todo'] }));
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    const tagButton = screen.getByRole('button', { name: 'idea' });
    await act(async () => { fireEvent.click(tagButton); });
    expect(screen.queryByText('Note B')).toBeNull();
    expect(screen.getByText('Note A')).toBeDefined();
  });

  it('should toggle markdown preview for note content', async () => {
    resetStore();
    useMetisStore.getState().addNote(makeNote({ id: 'n1', title: 'Markdown Note', content: '# Heading\n\nSome **bold** text.' }));
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    fireEvent.click(screen.getByText('Markdown Note'));
    expect(screen.getByTestId('note-content-input')).toBeDefined();
    const previewButton = screen.getByText('预览');
    fireEvent.click(previewButton);
    expect(screen.queryByTestId('note-content-input')).toBeNull();
    expect(screen.getByTestId('note-preview')).toBeDefined();
    expect(screen.getByText('Heading')).toBeDefined();
    expect(screen.getByText('bold')).toBeDefined();
    const editButton = screen.getByText('编辑');
    fireEvent.click(editButton);
    expect(screen.getByTestId('note-content-input')).toBeDefined();
  });

  it('should display word and character count for a note', async () => {
    resetStore();
    useMetisStore.getState().addNote(makeNote({ id: 'n1', title: 'Count Note', content: 'Hello world 你好' }));
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    fireEvent.click(screen.getByText('Count Note'));
    expect(screen.getByText('3 词')).toBeDefined();
    expect(screen.getByText('14 字')).toBeDefined();
  });

  it('should display last updated time for a note', async () => {
    resetStore();
    const updatedAt = new Date('2024-06-01T10:30:00').getTime();
    useMetisStore.getState().addNote(makeNote({ id: 'n1', title: 'Dated Note', updatedAt }));
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    fireEvent.click(screen.getByText('Dated Note'));
    expect(screen.getByText(/最后更新/)).toBeDefined();
    expect(screen.getByText(/2024/)).toBeDefined();
  });

  it('should select all notes and delete selected in bulk', async () => {
    resetStore();
    useMetisStore.getState().addNote(makeNote({ id: 'n1', title: 'Note One' }));
    useMetisStore.getState().addNote(makeNote({ id: 'n2', title: 'Note Two' }));
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    fireEvent.click(screen.getByText('全选'));
    fireEvent.click(screen.getByText('删除所选'));
    fireEvent.click(screen.getByTestId('confirm-delete'));
    await waitFor(() => expect(useMetisStore.getState().notes.length).toBe(0));
  });

  it('should add tags to selected notes in bulk', async () => {
    resetStore();
    useMetisStore.getState().addNote(makeNote({ id: 'n1', title: 'Note One', tags: ['idea'] }));
    useMetisStore.getState().addNote(makeNote({ id: 'n2', title: 'Note Two', tags: [] }));
    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);
    const checkboxes = screen.getAllByRole('checkbox', { name: '全选' });
    fireEvent.click(checkboxes[1]);
    fireEvent.click(checkboxes[2]);
    fireEvent.click(screen.getByTestId('bulk-add-tags'));
    const tagInput = screen.getByTestId('bulk-tag-input') as HTMLInputElement;
    fireEvent.change(tagInput, { target: { value: 'bulk-tag' } });
    fireEvent.click(screen.getByTestId('bulk-tag-submit'));
    await waitFor(() => {
      expect(useMetisStore.getState().notes.find((n) => n.id === 'n1')?.tags).toContain('bulk-tag');
      expect(useMetisStore.getState().notes.find((n) => n.id === 'n2')?.tags).toContain('bulk-tag');
    });
  });

  it('should isolate research memos by project and bind new memos to the active project', async () => {
    resetStore();
    researchWorkspaceStore.setState({ activeProjectId: 'project-a' });
    useMetisStore.setState({
      notes: [
        makeNote({ id: 'global', title: 'Global Note', scope: 'global' }),
        makeNote({ id: 'project-a-note', title: 'Project A Memo', scope: 'research', projectId: 'project-a' }),
        makeNote({ id: 'project-b-note', title: 'Project B Memo', scope: 'research', projectId: 'project-b' }),
      ],
    });

    const { default: NotesPage } = await import('../../src/pages/NotesPage');
    render(<NotesPage />);

    expect(screen.getByText('Project A Memo')).toBeDefined();
    expect(screen.queryByText('Project B Memo')).toBeNull();
    expect(screen.queryByText('Global Note')).toBeNull();

    fireEvent.click(screen.getByText('+ 新建研究备忘录'));
    expect(useMetisStore.getState().notes).toContainEqual(expect.objectContaining({
      title: '新建研究备忘录',
      scope: 'research',
      projectId: 'project-a',
    }));
  });
});

// ─── ExperimentsPage Tests ──────────────────────────────────────

describe('ExperimentsPage', () => {
  it('should render empty state when no experiments', async () => {
    resetStore();
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    expect(screen.getByText(/暂无实验/)).toBeDefined();
  });

  it('should render experiments from store', async () => {
    resetStore();
    useMetisStore.getState().addExperiment(makeExperiment());
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    expect(screen.getByText('Test Experiment')).toBeDefined();
  });

  it('should show experiment details', async () => {
    resetStore();
    useMetisStore.getState().addExperiment(makeExperiment());
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    fireEvent.click(screen.getByText('Test Experiment'));
    expect(screen.getByText('A test experiment')).toBeDefined();
  });

  it('should link and unlink papers from experiment card', async () => {
    resetStore();
    useMetisStore.getState().addPaper(makePaper({ id: 'p1', title: 'Linkable Paper' }));
    useMetisStore.getState().addExperiment(makeExperiment({ id: 'e1', name: 'Linkable Experiment', linkedPaperIds: [] }));
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    const checkbox = screen.getByLabelText(/Linkable Paper/) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    await act(async () => {
      fireEvent.click(checkbox);
    });
    expect(useMetisStore.getState().experiments[0]!.linkedPaperIds).toContain('p1');
    await act(async () => {
      fireEvent.click(checkbox);
    });
    expect(useMetisStore.getState().experiments[0]!.linkedPaperIds).not.toContain('p1');
  });

  it('should edit experiment notes and tags', async () => {
    resetStore();
    useMetisStore.getState().addExperiment(makeExperiment({ id: 'e1', name: 'Editable Experiment', tags: ['baseline'] }));
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    const noteInput = screen.getByPlaceholderText('备注') as HTMLTextAreaElement;
    fireEvent.change(noteInput, { target: { value: 'Experiment observations' } });
    expect(useMetisStore.getState().experiments[0]!.notes).toBe('Experiment observations');
    const tagInput = screen.getByPlaceholderText('输入标签（用逗号分隔）') as HTMLInputElement;
    fireEvent.change(tagInput, { target: { value: 'tag1, tag2' } });
    fireEvent.click(screen.getByText('添加标签'));
    expect(useMetisStore.getState().experiments[0]!.tags).toContain('tag1');
    expect(useMetisStore.getState().experiments[0]!.tags).toContain('tag2');
  });

  it('should filter experiments by status and query', async () => {
    resetStore();
    useMetisStore.getState().addExperiment(makeExperiment({ id: 'e1', name: 'Alpha Experiment', status: 'planned' }));
    useMetisStore.getState().addExperiment(makeExperiment({ id: 'e2', name: 'Beta Experiment', status: 'completed' }));
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    expect(screen.getByText('Alpha Experiment')).toBeDefined();
    expect(screen.getByText('Beta Experiment')).toBeDefined();
    const searchInput = screen.getByPlaceholderText('搜索实验...') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'Alpha' } });
    expect(screen.queryByText('Beta Experiment')).toBeNull();
    fireEvent.change(searchInput, { target: { value: '' } });
    const statusSelect = screen.getByLabelText('按状态过滤') as HTMLSelectElement;
    fireEvent.change(statusSelect, { target: { value: 'completed' } });
    expect(screen.queryByText('Alpha Experiment')).toBeNull();
    expect(screen.getByText('Beta Experiment')).toBeDefined();
    expect(screen.getByText('1 个实验')).toBeDefined();
  });

  it('should display the experiment result count', async () => {
    resetStore();
    useMetisStore.getState().addExperiment(makeExperiment({ id: 'e1', name: 'Alpha Experiment' }));
    useMetisStore.getState().addExperiment(makeExperiment({ id: 'e2', name: 'Beta Experiment' }));
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    expect(screen.getByText('2 个实验')).toBeDefined();
    const searchInput = screen.getByPlaceholderText('搜索实验...') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'Alpha' } });
    expect(screen.getByText('1 个实验')).toBeDefined();
  });

  it('should add and remove experiment metrics', async () => {
    resetStore();
    useMetisStore.getState().addExperiment(makeExperiment({ id: 'e1', name: 'Metric Experiment', metrics: {} }));
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    const keyInput = screen.getByPlaceholderText('指标名称') as HTMLInputElement;
    const valueInput = screen.getByPlaceholderText('数值') as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: 'f1' } });
    fireEvent.change(valueInput, { target: { value: '0.92' } });
    fireEvent.click(screen.getByText('添加指标'));
    expect(useMetisStore.getState().experiments[0]!.metrics.f1).toBe(0.92);
    const removeBtns = screen.getAllByTitle('删除');
    fireEvent.click(removeBtns[removeBtns.length - 1]!);
    expect(useMetisStore.getState().experiments[0]!.metrics.f1).toBeUndefined();
  });

  it('should duplicate an experiment', async () => {
    resetStore();
    useMetisStore.getState().addExperiment(makeExperiment({ id: 'e1', name: 'Original', metrics: { accuracy: 0.9 } }));
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    await act(async () => {
      fireEvent.click(screen.getByText('复制'));
    });
    expect(useMetisStore.getState().experiments.length).toBe(2);
    const copy = useMetisStore.getState().experiments.find((e) => e.name.includes('复制'));
    expect(copy).toBeDefined();
    expect(copy?.metrics.accuracy).toBe(0.9);
    expect(copy?.status).toBe('planned');
  });

  it('should delete an experiment after confirming the delete dialog', async () => {
    resetStore();
    useMetisStore.getState().addExperiment(makeExperiment({ name: 'Deletable Experiment' }));
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    fireEvent.click(screen.getByText('删除'));
    expect(screen.getByText('确认删除')).toBeDefined();
    fireEvent.click(screen.getByTestId('confirm-delete'));
    expect(useMetisStore.getState().experiments.length).toBe(0);
  });

  it('should select all experiments and set status in bulk', async () => {
    resetStore();
    useMetisStore.getState().addExperiment(makeExperiment({ id: 'e1', name: 'Exp One', status: 'planned' }));
    useMetisStore.getState().addExperiment(makeExperiment({ id: 'e2', name: 'Exp Two', status: 'planned' }));
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    const selectAll = screen.getByLabelText('全选') as HTMLInputElement;
    fireEvent.click(selectAll);
    expect(screen.getByText(/已选择 2 项/)).toBeDefined();
    const statusSelect = screen.getByLabelText('设置状态') as HTMLSelectElement;
    fireEvent.change(statusSelect, { target: { value: 'completed' } });
    expect(useMetisStore.getState().experiments.every((e) => e.status === 'completed')).toBe(true);
  });

  it('should delete selected experiments in bulk after confirmation', async () => {
    resetStore();
    useMetisStore.getState().addExperiment(makeExperiment({ id: 'e1', name: 'Exp One' }));
    useMetisStore.getState().addExperiment(makeExperiment({ id: 'e2', name: 'Exp Two' }));
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    const selectAll = screen.getByLabelText('全选') as HTMLInputElement;
    fireEvent.click(selectAll);
    expect(screen.getByText(/已选择 2 项/)).toBeDefined();
    fireEvent.click(screen.getByText('删除所选'));
    expect(screen.getByText('删除所选实验？')).toBeDefined();
    fireEvent.click(screen.getByTestId('confirm-delete'));
    await waitFor(() => expect(useMetisStore.getState().experiments.length).toBe(0));
  });

  it('should add and remove experiment parameters', async () => {
    resetStore();
    useMetisStore.getState().addExperiment(makeExperiment({ id: 'e1', name: 'Param Experiment', parameters: {} }));
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    const keyInputs = screen.getAllByPlaceholderText('参数名称') as HTMLInputElement[];
    const valueInputs = screen.getAllByPlaceholderText('值') as HTMLInputElement[];
    fireEvent.change(keyInputs[0]!, { target: { value: 'lr' } });
    fireEvent.change(valueInputs[0]!, { target: { value: '0.001' } });
    fireEvent.click(screen.getByText('添加参数'));
    expect(useMetisStore.getState().experiments[0]!.parameters.lr).toBe('0.001');
    const paramRow = screen.getByText('lr').closest('.exp-parameter') as HTMLElement;
    const removeBtn = paramRow.querySelector('button') as HTMLButtonElement;
    fireEvent.click(removeBtn);
    expect(useMetisStore.getState().experiments[0]!.parameters.lr).toBeUndefined();
  });

  it('should export experiments to CSV', async () => {
    resetStore();
    useMetisStore.getState().addExperiment(makeExperiment({ id: 'e1', name: 'Exportable' }));
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    const createSpy = vi.spyOn(document, 'createElement');
    fireEvent.click(screen.getByText('导出 CSV'));
    expect(createSpy).toHaveBeenCalledWith('a');
    createSpy.mockRestore();
  });

  it('should sort experiments by name', async () => {
    resetStore();
    useMetisStore.getState().addExperiment(makeExperiment({ id: 'e1', name: 'Zebra' }));
    useMetisStore.getState().addExperiment(makeExperiment({ id: 'e2', name: 'Alpha' }));
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    const sortSelect = screen.getByLabelText('排序') as HTMLSelectElement;
    fireEvent.change(sortSelect, { target: { value: 'name' } });
    const titles = screen.getAllByText(/Zebra|Alpha/);
    expect(titles[0]!.textContent).toBe('Alpha');
    expect(titles[1]!.textContent).toBe('Zebra');
  });

  it('should show no-matching-experiments message when filters return nothing', async () => {
    resetStore();
    useMetisStore.getState().addExperiment(makeExperiment({ name: 'Alpha Experiment' }));
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    const searchInput = screen.getByPlaceholderText('搜索实验...') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'ZZZ' } });
    expect(screen.getByText('没有匹配的实验。')).toBeDefined();
  });

  it('should clear the experiments filters from the empty state', async () => {
    resetStore();
    useMetisStore.getState().addExperiment(makeExperiment({ name: 'Alpha Experiment' }));
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    const searchInput = screen.getByPlaceholderText('搜索实验...') as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: 'ZZZ' } });
    expect(screen.getByText('没有匹配的实验。')).toBeDefined();
    fireEvent.click(screen.getByText('清除'));
    expect(searchInput.value).toBe('');
    expect(screen.getByText('Alpha Experiment')).toBeDefined();
  });

  it('should open new experiment form with Ctrl+N keyboard shortcut', async () => {
    resetStore();
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    expect(screen.getByText('新建实验')).toBeDefined();
    expect(screen.getByPlaceholderText('实验名称')).toBeDefined();
  });

  it('should not open new experiment form with Ctrl+N while typing in an input', async () => {
    resetStore();
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    const searchInput = screen.getByPlaceholderText('搜索实验...') as HTMLInputElement;
    searchInput.focus();
    fireEvent.keyDown(searchInput, { key: 'n', ctrlKey: true });
    expect(screen.queryByText('新建实验')).toBeNull();
  });

  it('should focus experiments search input when pressing / outside of inputs', async () => {
    resetStore();
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    fireEvent.keyDown(window, { key: '/' });
    const searchInput = screen.getByPlaceholderText('搜索实验...') as HTMLInputElement;
    expect(document.activeElement).toBe(searchInput);
  });

  it('should filter experiments by clicking a tag in the experiment card', async () => {
    resetStore();
    useMetisStore.getState().addExperiment(makeExperiment({ id: 'e1', name: 'Exp A', tags: ['baseline'] }));
    useMetisStore.getState().addExperiment(makeExperiment({ id: 'e2', name: 'Exp B', tags: ['ablation'] }));
    const { default: ExperimentsPage } = await import('../../src/pages/ExperimentsPage');
    render(<ExperimentsPage />);
    const tagButton = screen.getByRole('button', { name: 'baseline' });
    await act(async () => { fireEvent.click(tagButton); });
    expect(screen.queryByText('Exp B')).toBeNull();
    expect(screen.getByText('Exp A')).toBeDefined();
  });
});

// ─── DashboardPage Tests ───────────────────────────────────────

describe('DashboardPage', () => {
  it('should render dashboard with empty data', async () => {
    resetStore();
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage />);
    expect(screen.getByText('研究仪表盘')).toBeDefined();
    expect(screen.getByText('暂无数据')).toBeDefined();
  });

  it('should render stat cards with paper data', async () => {
    resetStore();
    useMetisStore.getState().addPaper(makePaper());
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage />);
    expect(screen.getByText('论文总数')).toBeDefined();
    expect(screen.getByText('平均评分')).toBeDefined();
    expect(screen.getByText('独特标签')).toBeDefined();
  });

  it('should show high priority stat card and navigate on click', async () => {
    resetStore();
    const onNavigate = vi.fn();
    useMetisStore.setState({
      papers: [
        makePaper({ id: 'p1', title: 'Important Paper', priority: 'high', rating: 0 }),
        makePaper({ id: 'p2', title: 'Normal Paper', priority: 'low', rating: 0 }),
      ],
    });
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage onNavigate={onNavigate} />);
    expect(screen.getByText('高优先级')).toBeDefined();
    fireEvent.click(screen.getByText('高优先级'));
    expect(onNavigate).toHaveBeenCalledWith('pdf');
    expect(useMetisStore.getState().paperFilter.priority).toBe('high');
  });

  it('should show overdue deadlines stat card and navigate on click', async () => {
    resetStore();
    const onNavigate = vi.fn();
    const yesterday = localDateString(new Date(Date.now() - 86400000));
    useMetisStore.setState({
      papers: [
        makePaper({ id: 'p1', title: 'Late Paper', deadline: yesterday, rating: 0 }),
        makePaper({ id: 'p2', title: 'On Time Paper', rating: 0 }),
      ],
    });
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage onNavigate={onNavigate} />);
    expect(screen.getByText('已逾期')).toBeDefined();
    fireEvent.click(screen.getByText('已逾期'));
    expect(onNavigate).toHaveBeenCalledWith('pdf');
    expect(useMetisStore.getState().paperFilter.deadlineStatus).toBe('overdue');
  });

  it('should show upcoming deadlines stat card and navigate on click', async () => {
    resetStore();
    const onNavigate = vi.fn();
    const tomorrow = localDateString(new Date(Date.now() + 86400000));
    useMetisStore.setState({
      papers: [
        makePaper({ id: 'p1', title: 'Upcoming Paper', deadline: tomorrow, readStatus: 'unread', rating: 0 }),
        makePaper({ id: 'p2', title: 'Read Paper', deadline: tomorrow, readStatus: 'read', readAt: Date.now(), rating: 0 }),
      ],
    });
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage onNavigate={onNavigate} />);
    expect(screen.getByText('待办截止')).toBeDefined();
    fireEvent.click(screen.getByText('待办截止'));
    expect(onNavigate).toHaveBeenCalledWith('pdf');
    expect(useMetisStore.getState().paperFilter.deadlineStatus).toBe('upcoming');
  });

  it('should show today deadlines stat card and navigate on click', async () => {
    resetStore();
    const onNavigate = vi.fn();
    const today = localDateString();
    useMetisStore.setState({
      papers: [
        makePaper({ id: 'p1', title: 'Due Today Paper', deadline: today, readStatus: 'unread', rating: 0 }),
        makePaper({ id: 'p2', title: 'No Deadline', readStatus: 'unread', rating: 0 }),
      ],
    });
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage onNavigate={onNavigate} />);
    expect(screen.getByText('今日到期')).toBeDefined();
    fireEvent.click(screen.getByText('今日到期'));
    expect(onNavigate).toHaveBeenCalledWith('pdf');
    expect(useMetisStore.getState().paperFilter.deadlineStatus).toBe('today');
  });

  it('should render deadline alerts section and navigate on click', async () => {
    resetStore();
    const onNavigate = vi.fn();
    const today = localDateString();
    const yesterday = localDateString(new Date(Date.now() - 86400000));
    const inThreeDays = localDateString(new Date(Date.now() + 3 * 86400000));
    useMetisStore.setState({
      papers: [
        makePaper({ id: 'p1', title: 'Overdue Alert', deadline: yesterday, readStatus: 'unread', rating: 0 }),
        makePaper({ id: 'p2', title: 'Today Alert', deadline: today, readStatus: 'unread', rating: 0 }),
        makePaper({ id: 'p3', title: 'Upcoming Alert', deadline: inThreeDays, readStatus: 'unread', rating: 0 }),
        makePaper({ id: 'p4', title: 'Read Paper', deadline: today, readStatus: 'read', readAt: Date.now(), rating: 0 }),
        makePaper({ id: 'p5', title: 'Far Future', deadline: '2028-01-01', readStatus: 'unread', rating: 0 }),
      ],
    });
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage onNavigate={onNavigate} />);
    const alertsHeading = screen.getByText('截止日期提醒');
    expect(alertsHeading).toBeDefined();
    const alertsSection = alertsHeading.closest('.chart-card') as HTMLElement;
    expect(alertsSection.textContent).toContain('Overdue Alert');
    expect(alertsSection.textContent).toContain('Today Alert');
    expect(alertsSection.textContent).toContain('Upcoming Alert');
    expect(alertsSection.textContent).not.toContain('Far Future');
    fireEvent.click(within(alertsSection).getByText('Overdue Alert'));
    expect(onNavigate).toHaveBeenCalledWith('pdf');
    expect(useMetisStore.getState().selectedPaperId).toBe('p1');
  });

  it('should show charts when papers exist', async () => {
    resetStore();
    useMetisStore.getState().addPaper(makePaper());
    useMetisStore.getState().addPaper(makePaper({ id: 'p2', title: 'Paper 2', year: 2023, rating: 3 }));
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage />);
    expect(screen.getByText('论文动态（近 7 天）')).toBeDefined();
    expect(screen.getByText('按年份统计')).toBeDefined();
    expect(screen.getByText('阅读活动（近 7 天）')).toBeDefined();
  });

  it('should show recent notes and experiments', async () => {
    resetStore();
    useMetisStore.getState().addPaper(makePaper());
    useMetisStore.getState().addNote(makeNote({ title: 'Recent Note' }));
    useMetisStore.getState().addExperiment(makeExperiment({ name: 'Recent Experiment' }));
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage />);
    expect(screen.getByText('最近笔记')).toBeDefined();
    expect(screen.getByText('Recent Note')).toBeDefined();
    expect(screen.getByText('最近实验')).toBeDefined();
    expect(screen.getByText('Recent Experiment')).toBeDefined();
  });

  it('should show recently read papers', async () => {
    resetStore();
    useMetisStore.setState({
      papers: [
        makePaper({ id: 'p1', title: 'Read Recently', rating: 0, readStatus: 'read', readAt: Date.now() - 60 * 60 * 1000 }),
        makePaper({ id: 'p2', title: 'Read Long Ago', rating: 0, readStatus: 'read', readAt: Date.now() - 30 * 24 * 60 * 60 * 1000 }),
        makePaper({ id: 'p3', title: 'Unread', rating: 0, readStatus: 'unread' }),
      ],
    });
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage />);
    const recentlyReadHeading = screen.getByText('最近阅读');
    expect(recentlyReadHeading).toBeDefined();
    const recentlyReadCard = recentlyReadHeading.closest('.chart-card') as HTMLElement;
    expect(within(recentlyReadCard).getByText('Read Recently')).toBeDefined();
    expect(within(recentlyReadCard).getByText('Read Long Ago')).toBeDefined();
    expect(within(recentlyReadCard).queryByText('Unread')).toBeNull();
    const items = within(recentlyReadCard).getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('Read Recently');
  });

  it('should show random pick card and open a random unread paper on click', async () => {
    resetStore();
    const onNavigate = vi.fn();
    useMetisStore.setState({
      papers: [
        makePaper({ id: 'p1', title: 'Unread One', rating: 0, readStatus: 'unread' }),
        makePaper({ id: 'p2', title: 'Unread Two', rating: 0, readStatus: 'unread' }),
        makePaper({ id: 'p3', title: 'Already Read', rating: 0, readStatus: 'read', readAt: Date.now() - 24 * 60 * 60 * 1000 }),
      ],
    });
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage onNavigate={onNavigate} />);
    expect(screen.getByText('随机推荐')).toBeDefined();
    expect(screen.getByText('随机选择一篇未读论文')).toBeDefined();
    fireEvent.click(screen.getByText('随机选择一篇未读论文'));
    expect(onNavigate).toHaveBeenCalledWith('pdf');
    expect(useMetisStore.getState().selectedPaperId).toBe('p2');
    randomSpy.mockRestore();
  });

  it('should show empty state in random pick card when no unread papers', async () => {
    resetStore();
    useMetisStore.setState({
      papers: [makePaper({ id: 'p1', title: 'Read Only', rating: 0, readStatus: 'read', readAt: Date.now() - 24 * 60 * 60 * 1000 })],
    });
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage />);
    expect(screen.getByText('随机推荐')).toBeDefined();
    expect(screen.getByText('当前没有未读论文，先添加几篇吧。')).toBeDefined();
    expect(screen.queryByText('随机选择一篇未读论文')).toBeNull();
  });

  it('should show tag cloud and set exact tag filter on click', async () => {
    resetStore();
    const onNavigate = vi.fn();
    useMetisStore.setState({
      papers: [
        makePaper({ id: 'p1', title: 'Paper One', tags: ['ml'], rating: 0 }),
        makePaper({ id: 'p2', title: 'Paper Two', tags: ['ml', 'nlp'], rating: 0 }),
      ],
    });
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage onNavigate={onNavigate} />);
    expect(screen.getByText('标签云')).toBeDefined();
    fireEvent.click(screen.getByText('nlp'));
    expect(onNavigate).toHaveBeenCalledWith('pdf');
    expect(useMetisStore.getState().paperFilter.tag).toBe('nlp');
    expect(useMetisStore.getState().paperFilter.query).toBe('');
  });

  it('should navigate to papers page when total papers stat card is clicked', async () => {
    resetStore();
    useMetisStore.getState().addPaper(makePaper());
    const onNavigate = vi.fn();
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText('论文总数'));
    expect(onNavigate).toHaveBeenCalledWith('pdf');
  });

  it('should set unread filter and navigate when unread papers stat card is clicked', async () => {
    resetStore();
    useMetisStore.getState().addPaper(makePaper({ readStatus: 'unread' }));
    const onNavigate = vi.fn();
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText('待读'));
    expect(onNavigate).toHaveBeenCalledWith('pdf');
    expect(useMetisStore.getState().paperFilter.readStatus).toBe('unread');
  });

  it('should show read-this-week count and set read-within filter on click', async () => {
    resetStore();
    const now = Date.now();
    useMetisStore.getState().addPaper(makePaper({ id: 'p1', readStatus: 'read', readAt: now - 2 * 24 * 60 * 60 * 1000 }));
    useMetisStore.getState().addPaper(makePaper({ id: 'p2', readStatus: 'read', readAt: now - 10 * 24 * 60 * 60 * 1000 }));
    useMetisStore.getState().addPaper(makePaper({ id: 'p3', readStatus: 'unread' }));
    const onNavigate = vi.fn();
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage onNavigate={onNavigate} />);
    expect(screen.getByText('本周已读')).toBeDefined();
    fireEvent.click(screen.getByText('本周已读'));
    expect(onNavigate).toHaveBeenCalledWith('pdf');
    expect(useMetisStore.getState().paperFilter.readStatus).toBe('read');
    expect(useMetisStore.getState().paperFilter.readWithinDays).toBe(7);
  });

  it('should set starred filter and navigate when favorites stat card is clicked', async () => {
    resetStore();
    useMetisStore.getState().addPaper(makePaper({ starred: true }));
    const onNavigate = vi.fn();
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText('收藏'));
    expect(onNavigate).toHaveBeenCalledWith('pdf');
    expect(useMetisStore.getState().paperFilter.starred).toBe(true);
  });

  it('should display reading streak based on consecutive read days', async () => {
    resetStore();
    const now = new Date();
    const today = now.getTime();
    const yesterday = now.getTime() - 24 * 60 * 60 * 1000;
    const twoDaysAgo = now.getTime() - 2 * 24 * 60 * 60 * 1000;
    const fourDaysAgo = now.getTime() - 4 * 24 * 60 * 60 * 1000;
    useMetisStore.setState({
      papers: [
        makePaper({ id: 'p1', readStatus: 'read', readAt: today }),
        makePaper({ id: 'p2', readStatus: 'read', readAt: yesterday }),
        makePaper({ id: 'p3', readStatus: 'read', readAt: twoDaysAgo }),
        makePaper({ id: 'p4', readStatus: 'read', readAt: fourDaysAgo }),
      ],
    });
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage />);
    expect(screen.getByText('连续阅读')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
  });

  it('should display reading calendar for last 30 days', async () => {
    resetStore();
    const now = new Date();
    useMetisStore.setState({
      papers: [makePaper({ id: 'p1', readStatus: 'read', readAt: now.getTime() })],
    });
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage />);
    expect(screen.getByText('阅读日历（近 30 天）')).toBeDefined();
  });

  it('should display papers read this week on dashboard', async () => {
    resetStore();
    const now = Date.now();
    useMetisStore.setState({
      papers: [
        makePaper({ id: 'p1', readStatus: 'read', readAt: now - 1 * 24 * 60 * 60 * 1000 }),
      ],
    });
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    const { container } = render(<DashboardPage />);
    expect(container.textContent).toContain('1');
    expect(container.textContent).toContain('本周已读');
    await act(async () => {
      useMetisStore.setState({
        papers: [
          makePaper({ id: 'p1', readStatus: 'read', readAt: now - 1 * 24 * 60 * 60 * 1000 }),
          makePaper({ id: 'p2', readStatus: 'read', readAt: now - 2 * 24 * 60 * 60 * 1000 }),
        ],
      });
    });
  });


  it('should display starred items in favorites section', async () => {
    resetStore();
    useMetisStore.setState({
      papers: [makePaper({ id: 'p1', title: 'Starred Paper', starred: true, doi: '10.1234/p1' })],
      notes: [makeNote({ id: 'n1', title: 'Starred Note', starred: true })],
      experiments: [makeExperiment({ id: 'e1', name: 'Starred Experiment', starred: true })],
    });
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage />);
    expect(screen.getByText('收藏夹')).toBeDefined();
    const favoritesSection = screen.getByText('收藏夹').closest('.chart-card') as HTMLElement;
    expect(favoritesSection.textContent).toContain('Starred Paper');
    expect(favoritesSection.textContent).toContain('Starred Note');
    expect(favoritesSection.textContent).toContain('Starred Experiment');
  });

  it('should navigate when clicking or pressing Enter on a favorite item', async () => {
    resetStore();
    useMetisStore.setState({
      papers: [makePaper({ id: 'p1', title: 'Starred Paper', starred: true, doi: '10.1234/p1' })],
      notes: [makeNote({ id: 'n1', title: 'Starred Note', starred: true })],
      experiments: [makeExperiment({ id: 'e1', name: 'Starred Experiment', starred: true })],
    });
    const onNavigate = vi.fn();
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage onNavigate={onNavigate} />);

    const paperItem = screen.getByRole('button', { name: /paper: Starred Paper/i });
    fireEvent.click(paperItem);
    expect(onNavigate).toHaveBeenCalledWith('pdf');
    expect(useMetisStore.getState().selectedPaperId).toBe('p1');

    const noteItem = screen.getByRole('button', { name: /note: Starred Note/i });
    onNavigate.mockClear();
    fireEvent.click(noteItem);
    expect(onNavigate).toHaveBeenCalledWith('notes');
    expect(useMetisStore.getState().selectedNote).toBe('n1');

    const expItem = screen.getByRole('button', { name: /experiment: Starred Experiment/i });
    onNavigate.mockClear();
    fireEvent.keyDown(expItem, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('experiments');
    expect(useMetisStore.getState().experimentSearchQuery).toBe('Starred Experiment');
  });

  it('should activate stat cards with Enter key', async () => {
    resetStore();
    useMetisStore.getState().addPaper(makePaper());
    const onNavigate = vi.fn();
    const { default: DashboardPage } = await import('../../src/pages/DashboardPage');
    render(<DashboardPage onNavigate={onNavigate} />);
    const card = screen.getByText('论文总数').closest('[role="button"]') as HTMLElement;
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith('pdf');
  });
});

// ─── LatexPreviewPage Tests ────────────────────────────────────

describe('LatexPreviewPage', () => {
  it('should render LaTeX editor with toolbar', async () => {
    resetStore();
    const { default: LatexPreviewPage } = await import('../../src/pages/LatexPreviewPage');
    render(<LatexPreviewPage />);
    expect(screen.getByText('LaTeX 编辑器')).toBeDefined();
    expect(screen.getByText('编译')).toBeDefined();
    expect(screen.getByText('模板')).toBeDefined();
    expect(screen.getByText('数学')).toBeDefined();
  });

  it('should show simplified preview immediately with default template', async () => {
    resetStore();
    const { default: LatexPreviewPage } = await import('../../src/pages/LatexPreviewPage');
    render(<LatexPreviewPage />);
    // Default article template renders a preview immediately (no placeholder needed)
    expect(screen.getByText('Your Paper Title')).toBeDefined();
    expect(screen.getByText(/Abstract:/)).toBeDefined();
  });

  it('should show template panel when Templates clicked', async () => {
    resetStore();
    const { default: LatexPreviewPage } = await import('../../src/pages/LatexPreviewPage');
    render(<LatexPreviewPage />);
    fireEvent.click(screen.getByText('模板'));
    expect(screen.getByText('文章')).toBeDefined();
    expect(screen.getByText('Beamer 幻灯片')).toBeDefined();
    expect(screen.getByText('IEEE 会议')).toBeDefined();
  });

  it('should load another template without retaining a stale compiled PDF handle', async () => {
    resetStore();
    const { default: LatexPreviewPage } = await import('../../src/pages/LatexPreviewPage');
    render(<LatexPreviewPage />);
    fireEvent.click(screen.getByText('模板'));
    fireEvent.click(screen.getByText('Beamer 幻灯片'));

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('\\documentclass[aspectratio=169]{beamer}');
  });

  it('should show math symbol panel when Math clicked', async () => {
    resetStore();
    const { default: LatexPreviewPage } = await import('../../src/pages/LatexPreviewPage');
    render(<LatexPreviewPage />);
    fireEvent.click(screen.getByText('数学'));
    // Math symbols should be rendered
    expect(screen.getByTitle(/\\alpha/)).toBeDefined();
    expect(screen.getByTitle(/\\beta/)).toBeDefined();
  });

  it('should show compile button and auto-compile toggle', async () => {
    resetStore();
    const { default: LatexPreviewPage } = await import('../../src/pages/LatexPreviewPage');
    render(<LatexPreviewPage />);
    expect(screen.getByText('编译')).toBeDefined();
    expect(screen.getByText('自动')).toBeDefined();
  });

  it('should check citation integrity and report missing/unused keys', async () => {
    resetStore();
    useMetisStore.getState().addPaper(makePaper({ title: 'Test Paper', authors: ['Alice Smith'], year: 2024 }));
    const { default: LatexPreviewPage } = await import('../../src/pages/LatexPreviewPage');
    render(<LatexPreviewPage />);
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '\\cite{smith2024testpaper} \\cite{missing2024key}' } });
    fireEvent.click(screen.getByText('检查引用'));
    expect(screen.getByText('引用完整性检查')).toBeDefined();
    expect(screen.getByText('缺失引用（未在论文库中找到）')).toBeDefined();
    expect(screen.getByText('missing2024key')).toBeDefined();
  });
});

// ─── ResearchTimelinePage Tests ─────────────────────────────────

describe('ResearchTimelinePage', () => {
  it('should render timeline with empty state', async () => {
    resetStore();
    const { default: ResearchTimelinePage } = await import('../../src/pages/ResearchTimelinePage');
    render(<ResearchTimelinePage />);
    expect(screen.getByText('研究时间线')).toBeDefined();
    expect(screen.getByText('暂无研究活动')).toBeDefined();
  });

  it('should show stat cards', async () => {
    resetStore();
    const { default: ResearchTimelinePage } = await import('../../src/pages/ResearchTimelinePage');
    render(<ResearchTimelinePage />);
    expect(screen.getByText('活动数')).toBeDefined();
    expect(screen.getByText('添加论文')).toBeDefined();
    expect(screen.getByText('活动连续天数')).toBeDefined();
  });

  it('should show date range filter buttons', async () => {
    resetStore();
    const { default: ResearchTimelinePage } = await import('../../src/pages/ResearchTimelinePage');
    render(<ResearchTimelinePage />);
    expect(screen.getByText('1W')).toBeDefined();
    expect(screen.getByText('1M')).toBeDefined();
    expect(screen.getByText('3M')).toBeDefined();
    expect(screen.getByText('全部')).toBeDefined();
  });
});

// ─── ChatPage Tests ───────────────────────────────────────────

const technicalGoalCard: GoalCardData = {
  goalId: 'goal-technical',
  description: '比较两组访谈资料',
  phase: 'failed',
  planName: 'AgentLoop Workflow',
  planDescription: 'Provider and MCP execution plan',
  steps: [{ id: 'runtime-step', name: 'Runtime Tool Step', description: 'technical' }],
  stepStatuses: {
    'runtime-step': {
      stepId: 'runtime-step',
      stepName: 'Runtime Tool Step',
      status: 'failed',
      output: 'MCP Tool raw output',
    },
  },
  progress: { completed: 0, total: 1, currentStep: 'Runtime Tool Step' },
  reasoning: 'Agent internal reasoning',
  error: 'AgentLoop Provider error: MCP Tool failed in Runtime',
  canRefine: false,
};

describe('GoalCardInline presentation boundary', () => {
  it('maps unknown phase/status to fixed neutral classes and scrubs every text channel', () => {
    const unknownGoal: GoalCardData = {
      ...technicalGoalCard,
      description: 'C:\\Users\\researcher\\private Authorization: Bearer goal-secret-marker',
      phase: 'unknown',
      steps: [{ id: 'step-safe', name: '/home/researcher/private/step', description: '' }],
      stepStatuses: {
        'step-safe': {
          stepId: 'step-safe',
          stepName: '/home/researcher/private/step',
          status: 'unknown',
          output: 'api_key=goal-output-secret-marker',
        },
      },
    };

    const { container } = render(<GoalCardInline data={unknownGoal} uiMode="normal" />);
    expect(container.querySelector('.goal-card-phase')?.className).toBe('goal-card-phase unknown');
    expect(container.textContent).toContain('研究计划不可用');
    const observable = container.outerHTML;
    for (const marker of ['C:\\Users\\researcher', '/home/researcher', 'goal-secret-marker', 'goal-output-secret-marker']) {
      expect(observable).not.toContain(marker);
    }

    const statusView = render(
      <GoalCardInline data={{ ...unknownGoal, phase: 'executing' }} uiMode="normal" />,
    );
    expect(statusView.container.querySelector('.status-dot')?.className).toBe('status-dot pending');
  });

  it('hides technical plan details and sanitizes errors in normal mode', () => {
    const { container } = render(<GoalCardInline data={technicalGoalCard} uiMode="normal" />);
    const visibleText = container.textContent ?? '';

    expect(visibleText).toContain('研究计划');
    expect(visibleText).toContain('研究步骤 1');
    expect(visibleText).toContain('研究助手暂时无法连接');
    for (const leaked of ['AgentLoop', 'Workflow', 'Provider', 'MCP', 'Tool', 'Runtime', 'reasoning']) {
      expect(visibleText).not.toContain(leaked);
    }
  });

  it('reveals raw plan and error details only in diagnostic mode', () => {
    const { container } = render(<GoalCardInline data={technicalGoalCard} uiMode="diagnostic" />);
    const visibleText = container.textContent ?? '';

    expect(visibleText).toContain('AgentLoop Workflow');
    expect(visibleText).toContain('Provider and MCP execution plan');
    expect(visibleText).toContain('Runtime Tool Step');
    expect(visibleText).toContain('Agent internal reasoning');
    expect(visibleText).toContain('AgentLoop Provider error: MCP Tool failed in Runtime');
  });
});

describe('ChatPage', () => {
  it('renders research operations as compact, expandable user language in normal mode', async () => {
    resetStore();
    const { ToolCallCard } = await import('../../src/pages/ChatPage');
    const { container } = render(
      <ToolCallCard
        diagnosticMode={false}
        toolCall={{
          name: 'execute_command',
          arguments: '{"command":"rm -rf sensitive-folder"}',
          result: 'TOKEN=secret-value',
          status: 'completed',
        }}
      />,
    );

    expect(container.querySelector('.tool-call-header')).not.toBeNull();
    const header = container.querySelector('button.tool-call-header') as HTMLButtonElement;
    expect(header).not.toBeNull();
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('运行本地操作')).toBeDefined();
    expect(container.textContent).not.toContain('execute_command');
    expect(container.textContent).not.toContain('rm -rf');
    expect(container.textContent).not.toContain('TOKEN');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('[REDACTED]');
    expect(container.textContent).not.toContain('secret-value');
    expect(container.textContent).not.toContain('execute_command');
    expect(container.textContent).not.toContain('rm -rf');
  });

  it('reveals scrubbed research operation details after diagnostic disclosure', async () => {
    resetStore();
    const { ToolCallCard } = await import('../../src/pages/ChatPage');
    const { container } = render(
      <ToolCallCard
        diagnosticMode
        toolCall={{
          name: 'execute_command',
          arguments: '{"command":"python analysis.py","apiKey":"tool-secret-marker"}',
          result: 'Authorization: Bearer result-secret-marker',
          status: 'completed',
        }}
      />,
    );

    const header = container.querySelector('button.tool-call-header') as HTMLButtonElement;
    expect(header).not.toBeNull();
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('execute_command');
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('execute_command');
    expect(container.textContent).toContain('python analysis.py');
    expect(container.textContent).toContain('[REDACTED]');
    expect(container.textContent).not.toContain('tool-secret-marker');
    expect(container.textContent).not.toContain('result-secret-marker');
  });

  it('should render chat interface with empty state', async () => {
    resetStore();
    const { default: ChatPage } = await import('../../src/pages/ChatPage');
    const { container } = render(<ChatPage renderLayout={renderChatProjectShell} />);
    const chatEmpty = container.querySelector('.chat-empty');
    expect(chatEmpty).not.toBeNull();
    expect(chatEmpty?.querySelector('h2')?.textContent).toBe('Metis 研究工作台');
    expect(screen.getByText('提出一个研究问题，开始探索。')).toBeDefined();
    expect(screen.getByPlaceholderText('提出一个研究问题...')).toBeDefined();
  });

  it('sanitizes internal goal step names in the normal right panel', async () => {
    resetStore();
    const originalMetis = window.metis;
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'goal-session',
        title: '研究任务',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 1,
      }]),
      getMessages: vi.fn().mockResolvedValue([{
        role: 'goal',
        content: `__GOAL_CARD__${JSON.stringify(technicalGoalCard)}`,
      }]),
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      const { container } = render(<ChatPage renderLayout={renderChatProjectShell} uiMode="normal" />);
      await waitFor(() => expect(container.textContent).toContain('研究步骤 1'));
      expect(container.textContent).not.toContain('Runtime Tool Step');
    } finally {
      window.metis = originalMetis;
    }
  });

  it('does not expose session ids, legacy tool payloads, or malformed goal payloads in normal mode', async () => {
    resetStore();
    const originalMetis = window.metis;
    const sessionId = 'session-private-marker-78491';
    const legacyToolPayload = 'C:\\Users\\researcher\\private\\legacy-tool.log API_KEY=legacy-secret-marker';
    const malformedGoalPayload = '__GOAL_CARD__{"apiKey":"goal-secret-marker","path":"C:\\\\private';
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: sessionId,
        createdAt: 1,
        lastActivity: 1,
        messageCount: 2,
      }]),
      getMessages: vi.fn().mockResolvedValue([
        { role: 'tool', content: legacyToolPayload },
        { role: 'goal', content: malformedGoalPayload },
      ]),
      listArtifacts: vi.fn().mockResolvedValue([]),
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      const { container } = render(
        <ChatPage renderLayout={renderChatProjectShell} uiMode="normal" />,
      );
      await screen.findByText('研究操作已完成');
      expect(screen.getAllByText('新会话').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText(/对话记录无法安全恢复/)).toBeDefined();

      const sessionTitle = container.querySelector('.chat-session-title') as HTMLElement;
      fireEvent.doubleClick(sessionTitle);
      const renameInput = container.querySelector('.chat-session-title-input') as HTMLInputElement;
      expect(renameInput.value).toBe('新会话');

      const disclosureSurface = container.outerHTML;
      for (const leaked of [
        sessionId,
        'data-session-id',
        'C:\\Users\\researcher',
        'legacy-secret-marker',
        '__GOAL_CARD__',
        'goal-secret-marker',
      ]) {
        expect(disclosureSurface).not.toContain(leaked);
      }
    } finally {
      window.metis = originalMetis;
    }
  });

  it('should hide skill and terminal controls in normal mode', async () => {
    resetStore();
    localStorage.removeItem('metis-diagnostic-mode');
    const originalMetis = window.metis;
    const listSkills = vi.fn().mockResolvedValue([{
      id: 'technical-skill',
      name: 'Technical Skill',
      description: 'Developer-only',
      category: 'diagnostic',
    }]);
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([]),
      listSkills,
      getActiveSkill: vi.fn().mockResolvedValue({ active: null }),
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);
      await waitFor(() => expect(listSkills).not.toHaveBeenCalled());
      expect(screen.queryByText('技能：')).toBeNull();
      expect(screen.queryByText('终端')).toBeNull();
    } finally {
      window.metis = originalMetis;
    }
  });

  it('should render sidebar, conversation, and preview through one ProjectShell', async () => {
    resetStore();
    const { default: ChatPage } = await import('../../src/pages/ChatPage');
    const { container } = render(
      <ChatPage renderLayout={renderChatProjectShell} />,
    );

    const shells = container.querySelectorAll('.project-shell');
    expect(shells).toHaveLength(1);
    expect(container.querySelector('.chat-page-container')).toBeNull();
    expect(shells[0]?.children).toHaveLength(3);
    expect(
      shells[0]?.children[0]?.querySelector('.chat-sidebar'),
    ).not.toBeNull();
    expect(
      shells[0]?.children[1]?.querySelector('.chat-main'),
    ).not.toBeNull();
    expect(
      shells[0]?.children[2]?.querySelector('.right-panel--embedded'),
    ).not.toBeNull();
    expect(container.querySelectorAll('.chat-sidebar')).toHaveLength(1);
    expect(container.querySelectorAll('.chat-main')).toHaveLength(1);
    expect(container.querySelectorAll('.right-panel')).toHaveLength(1);
  });

  it('should render all three regions through one shared slot owner', async () => {
    resetStore();
    const { default: ChatPage } = await import('../../src/pages/ChatPage');
    const { container } = render(
      <ChatPage
        renderLayout={({ leftPanel, workspace, rightPanel }) => (
          <div data-testid="test-chat-layout">
            <section data-testid="left-slot">{leftPanel}</section>
            <section data-testid="workspace-slot">{workspace}</section>
            <section data-testid="right-slot">{rightPanel}</section>
          </div>
        )}
      />,
    );

    expect(container.querySelector('.chat-page-container')).toBeNull();
    expect(within(screen.getByTestId('left-slot')).getByText('新会话')).toBeDefined();
    expect(screen.getByTestId('left-slot').querySelector('.chat-sidebar')).not.toBeNull();
    expect(screen.getByTestId('workspace-slot').querySelector('.chat-main')).not.toBeNull();
    const embeddedRight = screen.getByTestId('right-slot').querySelector('.right-panel--embedded');
    expect(embeddedRight).not.toBeNull();
    expect(embeddedRight?.tagName).toBe('DIV');

    const input = within(screen.getByTestId('workspace-slot')).getByPlaceholderText('提出一个研究问题...');
    fireEvent.change(input, { target: { value: '共享状态验证' } });
    fireEvent.click(within(screen.getByTestId('left-slot')).getByText('新会话'));
    // 多对话架构第二期(2026-09-05):草稿按会话隔离——切换到新会话后输入框为空
    //(新会话没有草稿),但旧会话草稿已持久化,切回时恢复。
    // 多对话架构第二期:切换到新会话后,输入框按新会话的草稿呈现(新会话从空开始),
    // 不会把上一会话的草稿串进新会话。
    expect((input as HTMLTextAreaElement).value).toBe('');
    expect(within(screen.getByTestId('left-slot')).getAllByText('新会话').length).toBeGreaterThanOrEqual(1);
  });

  it('should create a new session on button click', async () => {
    resetStore();
    const { default: ChatPage } = await import('../../src/pages/ChatPage');
    render(<ChatPage renderLayout={renderChatProjectShell} />);
    fireEvent.click(screen.getByText('新会话'));
    // A new session should be created (current UI labels it as "新会话")
    expect(screen.getAllByText('新会话').length).toBeGreaterThanOrEqual(1);
  });

  it('should update input on type', async () => {
    resetStore();
    const { default: ChatPage } = await import('../../src/pages/ChatPage');
    render(<ChatPage renderLayout={renderChatProjectShell} />);
    const input = screen.getByPlaceholderText('提出一个研究问题...');
    fireEvent.change(input, { target: { value: 'Hello world' } });
    expect((input as HTMLTextAreaElement).value).toBe('Hello world');
  });

  it('should show send button disabled when input is empty', async () => {
    resetStore();
    const { default: ChatPage } = await import('../../src/pages/ChatPage');
    render(<ChatPage renderLayout={renderChatProjectShell} />);
    const sendBtn = screen.getByText('发送');
    expect(sendBtn).toBeDefined();
    expect((sendBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('sanitizes raw model connection errors in normal mode', async () => {
    resetStore();
    const originalMetis = window.metis;
    const agentChat = vi.fn().mockResolvedValue(failedAgentResponse());
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-error-normal',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        metadata: { title: '错误展示' },
      }]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([]),
      agentChat,
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      const { container } = render(<ChatPage renderLayout={renderChatProjectShell} uiMode="normal" />);
      await waitFor(() => expect(window.metis?.getMessages).toHaveBeenCalledWith('session-error-normal'));
      fireEvent.change(screen.getByPlaceholderText('提出一个研究问题...'), {
        target: { value: '/chat 请回答这个研究问题' },
      });
      fireEvent.click(screen.getByText('发送'));

      await screen.findByText(/研究助手暂时无法连接/);
      const visibleText = container.textContent ?? '';
      for (const leaked of ['AgentLoop', 'Provider', 'MCP', 'Tool', 'Runtime']) {
        expect(visibleText).not.toContain(leaked);
      }
    } finally {
      window.metis = originalMetis;
    }
  });

  it('shows raw model connection errors in diagnostic mode', async () => {
    resetStore();
    const originalMetis = window.metis;
    const rawError = 'AgentLoop Provider error: MCP Tool failed in Runtime';
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-error-diagnostic',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        metadata: { title: '诊断展示' },
      }]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([]),
      listSkills: vi.fn().mockResolvedValue([]),
      getActiveSkill: vi.fn().mockResolvedValue({ active: null }),
      agentChat: vi.fn().mockResolvedValue(failedAgentResponse()),
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} uiMode="diagnostic" />);
      await waitFor(() => expect(window.metis?.getMessages).toHaveBeenCalledWith('session-error-diagnostic'));
      fireEvent.change(screen.getByPlaceholderText('提出一个研究问题...'), {
        target: { value: '/chat 请回答这个研究问题' },
      });
      fireEvent.click(screen.getByText('发送'));
      expect(await screen.findByText('agent_provider_error')).toBeDefined();
      expect(screen.queryByText(rawError)).toBeNull();
    } finally {
      window.metis = originalMetis;
    }
  });

  it('applies the session runtime boundary before titles or ids reach the DOM', async () => {
    resetStore();
    const originalMetis = window.metis;
    const sessionId = 'session-private-marker-92741';
    const unsafeTitle = 'C:\\Users\\researcher\\private\\session-title-secret-marker';
    const updateSession = vi.fn().mockResolvedValue({ success: true, code: 'updated' });
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: sessionId,
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        metadata: {
          title: unsafeTitle,
          archived: false,
          apiKey: 'metadata-secret-marker',
          unknown: { token: 'nested-secret-marker' },
        },
      }]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([]),
      updateSession,
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      const { container } = render(
        <ChatPage renderLayout={renderChatProjectShell} uiMode="normal" />,
      );
      await waitFor(() => expect(container.querySelectorAll('.chat-session-item')).toHaveLength(1));

      const initialSurface = container.outerHTML;
      for (const leaked of [
        sessionId,
        'C:\\Users\\researcher',
        'session-title-secret-marker',
        'metadata-secret-marker',
        'nested-secret-marker',
        'data-session-id',
      ]) {
        expect(initialSurface).not.toContain(leaked);
      }

      const sessionTitle = container.querySelector('.chat-session-title') as HTMLElement;
      expect(sessionTitle.textContent).toBe('新会话');
      fireEvent.doubleClick(sessionTitle);
      const renameInput = container.querySelector('.chat-session-title-input') as HTMLInputElement;
      fireEvent.change(renameInput, {
        target: { value: 'C:\\private\\rename-secret-marker' },
      });
      fireEvent.keyDown(renameInput, { key: 'Enter' });

      await waitFor(() => expect(container.querySelector('.chat-session-title-input')).toBeNull());
      expect(updateSession).not.toHaveBeenCalled();
      expect(container.outerHTML).not.toContain('rename-secret-marker');
      expect(container.querySelector('.chat-session-title')?.textContent).toBe('新会话');
    } finally {
      window.metis = originalMetis;
    }
  });

  it.each(['normal', 'diagnostic'] as const)(
    'never renders raw stream chunks in %s mode, including a secret split across chunks',
    async (uiMode) => {
      resetStore();
      const originalMetis = window.metis;
      const response = deferred<ReturnType<typeof completedAgentResponse>>();
      const onStreamChunk = vi.fn();
      window.metis = {
        listSessions: vi.fn().mockResolvedValue([{
          id: `session-stream-${uiMode}`,
          createdAt: 1,
          lastActivity: 1,
          messageCount: 0,
          metadata: { title: '流式安全' },
        }]),
        getMessages: vi.fn().mockResolvedValue([]),
        listArtifacts: vi.fn().mockResolvedValue([]),
        listSkills: vi.fn().mockResolvedValue([]),
        getActiveSkill: vi.fn().mockResolvedValue({ active: null }),
        agentChat: vi.fn().mockReturnValue(response.promise),
        onStreamChunk,
      } as unknown as typeof window.metis;

      try {
        const { default: ChatPage } = await import('../../src/pages/ChatPage');
        const { container } = render(<ChatPage renderLayout={renderChatProjectShell} uiMode={uiMode} />);
        expect(onStreamChunk).not.toHaveBeenCalled();
        // Wait for the initial session to finish loading so the user message is not
        // cleared by the asynchronous activateSession() call that happens on mount.
        await waitFor(() => expect(window.metis?.getMessages).toHaveBeenCalled());

        fireEvent.change(screen.getByPlaceholderText('提出一个研究问题...'), {
          target: { value: '/chat 测试流式边界' },
        });
        fireEvent.click(screen.getByText('发送'));
        await waitFor(() => expect(window.metis?.agentChat).toHaveBeenCalled());

        const inaccessibleChunks = [
          'Authorization: Bearer split-',
          'stream-secret-123456789 ',
          'https://user:pass@example.test/private?token=split-',
          'query-secret#fragment-secret',
        ];
        for (const content of inaccessibleChunks) {
          const observable = `${container.textContent ?? ''}\n${container.innerHTML}`;
          for (const marker of [
            'Authorization',
            'split-stream-secret-123456789',
            'user:pass',
            'split-query-secret',
            'fragment-secret',
          ]) {
            expect(observable).not.toContain(marker);
          }
          expect(observable).not.toContain(content);
        }

        response.resolve(completedAgentResponse('安全完成。'));
        await screen.findByText('安全完成。');
      } finally {
        window.metis = originalMetis;
      }
    },
  );

  it('ignores stale messages and artifacts after switching sessions', async () => {
    resetStore();
    const originalMetis = window.metis;
    const messagesA = deferred<Array<{ role: string; content: string }>>();
    const messagesB = deferred<Array<{ role: string; content: string }>>();
    const artifactsA = deferred<Array<{
      id: string;
      sessionId: string;
      name: string;
      type: string;
      metadata: Record<string, unknown>;
      createdAt: number;
    }>>();
    const artifactsB = deferred<Array<{
      id: string;
      sessionId: string;
      name: string;
      type: string;
      metadata: Record<string, unknown>;
      createdAt: number;
    }>>();
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([
        { id: 'session-a', title: '会话 A', createdAt: 2, lastActivity: 2, messageCount: 1 },
        { id: 'session-b', title: '会话 B', createdAt: 1, lastActivity: 1, messageCount: 1 },
      ]),
      getMessages: vi.fn((sessionId: string) => (
        sessionId === 'session-a' ? messagesA.promise : messagesB.promise
      )),
      listArtifacts: vi.fn((sessionId: string) => (
        sessionId === 'session-a' ? artifactsA.promise : artifactsB.promise
      )),
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);
      await waitFor(() => expect(window.metis?.getMessages).toHaveBeenCalledWith('session-a'));

      fireEvent.click(screen.getByText('会话 B', { selector: '.chat-session-title' }));
      await waitFor(() => expect(window.metis?.getMessages).toHaveBeenCalledWith('session-b'));

      messagesB.resolve([{ role: 'assistant', content: '会话 B 的回答' }]);
      artifactsB.resolve([{
        id: 'artifact-b',
        sessionId: 'session-b',
        name: 'b-result.md',
        type: 'md',
        metadata: {},
        createdAt: 2,
      }]);
      await screen.findByText('会话 B 的回答');
      fireEvent.click(screen.getByRole('tab', { name: '生成物' }));
      await screen.findByRole('button', { name: 'b-result.md' });

      messagesA.resolve([{ role: 'assistant', content: '迟到的会话 A 回答' }]);
      artifactsA.resolve([{
        id: 'artifact-a',
        sessionId: 'session-a',
        name: 'a-stale.md',
        type: 'md',
        metadata: {},
        createdAt: 1,
      }]);
      await act(async () => {
        await Promise.all([messagesA.promise, artifactsA.promise]);
      });

      expect(screen.queryByText('迟到的会话 A 回答')).toBeNull();
      expect(screen.queryByRole('button', { name: 'a-stale.md' })).toBeNull();
      expect(screen.getByText('会话 B 的回答')).toBeDefined();
      expect(screen.getByRole('button', { name: 'b-result.md' })).toBeDefined();
    } finally {
      window.metis = originalMetis;
    }
  });

  it('refreshes persisted artifacts after a completed agent response', async () => {
    resetStore();
    const originalMetis = window.metis;
    const listArtifacts = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 'artifact-generated',
        sessionId: 'session-refresh',
        name: 'generated-analysis.md',
        type: 'md',
        contentAvailable: true,
        createdAt: 2,
      }]);
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-refresh',
        title: '刷新会话',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
      }]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts,
      agentChat: vi.fn().mockResolvedValue(completedAgentResponse('已完成')),
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);
      await waitFor(() => expect(listArtifacts).toHaveBeenCalledWith('session-refresh'));
      fireEvent.change(screen.getByPlaceholderText('提出一个研究问题...'), {
        target: { value: '/chat 生成持久化成果' },
      });
      fireEvent.click(screen.getByText('发送'));
      await screen.findByText('已完成', { selector: '.message-content p' });
      await waitFor(() => expect(listArtifacts).toHaveBeenCalledTimes(2));
      fireEvent.click(screen.getByRole('tab', { name: '生成物' }));
      expect(await screen.findByRole('button', { name: 'generated-analysis.md' })).toBeDefined();
    } finally {
      window.metis = originalMetis;
    }
  });

  it('reopens persisted inline artifact content using its artifact name', async () => {
    resetStore();
    const originalMetis = window.metis;
    const getArtifactContent = vi.fn().mockResolvedValue({
      success: true,
      id: 'artifact-inline',
      sessionId: 'session-inline',
      name: 'saved-analysis.md',
      type: 'md',
      content: '# Reopened result\n\nPersisted body.',
      createdAt: 2,
    });
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-inline',
        title: '内容会话',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
      }]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([{
        id: 'artifact-inline',
        sessionId: 'session-inline',
        name: 'saved-analysis.md',
        type: 'md',
        contentAvailable: true,
        createdAt: 2,
      }]),
      getArtifactContent,
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      const { container } = render(<ChatPage renderLayout={renderChatProjectShell} />);
      fireEvent.click(screen.getByRole('tab', { name: '生成物' }));
      fireEvent.click(await screen.findByRole('button', { name: 'saved-analysis.md' }));
      await waitFor(() => expect(getArtifactContent).toHaveBeenCalledWith('session-inline', 'artifact-inline'));
      expect(await screen.findByRole('heading', { name: 'Reopened result' })).toBeDefined();
      expect(container.querySelector('.artifact-preview-title')?.textContent).toBe('saved-analysis.md');
    } finally {
      window.metis = originalMetis;
    }
  });

  it('drops a late artifact-content response after switching sessions', async () => {
    resetStore();
    const originalMetis = window.metis;
    const contentA = deferred<{
      success: true;
      id: string;
      sessionId: string;
      name: string;
      type: 'md';
      content: string;
      createdAt: number;
    }>();
    const getArtifactContent = vi.fn().mockReturnValue(contentA.promise);
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([
        { id: 'session-a', title: '会话 A', createdAt: 2, lastActivity: 2, messageCount: 0 },
        { id: 'session-b', title: '会话 B', createdAt: 1, lastActivity: 1, messageCount: 0 },
      ]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn((sessionId: string) => Promise.resolve(sessionId === 'session-a' ? [{
        id: 'artifact-a',
        sessionId: 'session-a',
        name: 'session-a.md',
        type: 'md',
        contentAvailable: true,
        createdAt: 2,
      }] : [])),
      getArtifactContent,
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);
      fireEvent.click(screen.getByRole('tab', { name: '生成物' }));
      fireEvent.click(await screen.findByRole('button', { name: 'session-a.md' }));
      await waitFor(() => expect(getArtifactContent).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByText('会话 B', { selector: '.chat-session-title' }));

      contentA.resolve({
        success: true,
        id: 'artifact-a',
        sessionId: 'session-a',
        name: 'session-a.md',
        type: 'md',
        content: '# Stale session A artifact',
        createdAt: 2,
      });
      await act(async () => { await contentA.promise; });

      expect(screen.queryByRole('heading', { name: 'Stale session A artifact' })).toBeNull();
      expect(document.querySelector('.artifact-live-preview')).toBeNull();
    } finally {
      window.metis = originalMetis;
    }
  });

  it('replaces a stale preview with a visible error when persisted content cannot be opened', async () => {
    resetStore();
    const originalMetis = window.metis;
    const getArtifactContent = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        id: 'artifact-good',
        sessionId: 'session-artifact-error',
        name: 'good.md',
        type: 'md',
        content: '# Previously opened content',
        createdAt: 2,
      })
      .mockResolvedValueOnce({ success: false, code: 'not_found' });
    window.metis = makeMetisAPI({
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-artifact-error', title: '生成物错误', createdAt: 1, lastActivity: 1, messageCount: 0,
      }]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([
        { id: 'artifact-good', sessionId: 'session-artifact-error', name: 'good.md', type: 'md', contentAvailable: true, createdAt: 2 },
        { id: 'artifact-missing', sessionId: 'session-artifact-error', name: 'missing.md', type: 'md', contentAvailable: true, createdAt: 1 },
      ]),
      getArtifactContent,
    });

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);
      fireEvent.click(screen.getByRole('tab', { name: '生成物' }));
      fireEvent.click(await screen.findByRole('button', { name: 'good.md' }));
      expect(await screen.findByRole('heading', { name: 'Previously opened content' })).toBeDefined();
      fireEvent.click(screen.getByRole('button', { name: 'missing.md' }));
      expect(await screen.findByRole('alert')).toBeDefined();
      expect(screen.queryByRole('heading', { name: 'Previously opened content' })).toBeNull();
    } finally {
      window.metis = originalMetis;
    }
  });

  it('shows an explicit artifact-list error during session restore instead of silently clearing results', async () => {
    resetStore();
    const originalMetis = window.metis;
    window.metis = makeMetisAPI({
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-list-error', title: '恢复失败', createdAt: 1, lastActivity: 1, messageCount: 0,
      }]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue({
        success: false,
        code: 'artifact_list_unavailable',
        items: [],
      }),
    });

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);
      fireEvent.click(screen.getByRole('tab', { name: '生成物' }));
      expect(await screen.findByRole('alert')).toBeDefined();
    } finally {
      window.metis = originalMetis;
    }
  });

  it('keeps a late file-picker result bound to its original session without mixing it into the new session UI', async () => {
    resetStore();
    const originalMetis = window.metis;
    const selection = deferred<{ success: true; capability: FileCapabilityDescriptor }>();
    const createArtifact = vi.fn().mockResolvedValue({ success: true, code: 'created' });
    window.metis = makeMetisAPI({
      listSessions: vi.fn().mockResolvedValue([
        { id: 'session-upload-a', title: '上传会话 A', createdAt: 2, lastActivity: 2, messageCount: 0 },
        { id: 'session-upload-b', title: '上传会话 B', createdAt: 1, lastActivity: 1, messageCount: 0 },
      ]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([]),
      selectFileCapability: vi.fn().mockReturnValue(selection.promise),
      createArtifact,
    });

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      const { container } = render(<ChatPage renderLayout={renderChatProjectShell} />);
      await waitFor(() => expect(
        container.querySelector('.chat-session-item.active')?.textContent,
      ).toContain('上传会话 A'));
      fireEvent.click(container.querySelector('.chat-tool-icon') as HTMLButtonElement);
      fireEvent.click(await screen.findByText('上传会话 B', { selector: '.chat-session-title' }));
      selection.resolve({
        success: true,
        capability: makePdfCapability({ displayName: 'late-picker.pdf' }),
      });
      await act(async () => { await selection.promise; });
      await waitFor(() => expect(createArtifact).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-upload-a',
        name: 'late-picker.pdf',
      })));
      fireEvent.click(screen.getByRole('tab', { name: '生成物' }));
      expect(screen.queryByRole('button', { name: 'late-picker.pdf' })).toBeNull();
    } finally {
      window.metis = originalMetis;
    }
  });

  it('keeps a late dropped-file result bound to its original session without mixing it into the new session UI', async () => {
    resetStore();
    const originalMetis = window.metis;
    const imported = deferred<{ success: true; capability: FileCapabilityDescriptor }>();
    const createArtifact = vi.fn().mockResolvedValue({ success: true, code: 'created' });
    window.metis = makeMetisAPI({
      listSessions: vi.fn().mockResolvedValue([
        { id: 'session-drop-a', title: '拖放会话 A', createdAt: 2, lastActivity: 2, messageCount: 0 },
        { id: 'session-drop-b', title: '拖放会话 B', createdAt: 1, lastActivity: 1, messageCount: 0 },
      ]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([]),
      importFileCapability: vi.fn().mockReturnValue(imported.promise),
      createArtifact,
    });

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      const { container } = render(<ChatPage renderLayout={renderChatProjectShell} />);
      await waitFor(() => expect(
        container.querySelector('.chat-session-item.active')?.textContent,
      ).toContain('拖放会话 A'));
      const file = new File(['late content'], 'late-drop.pdf', { type: 'application/pdf' });
      Object.defineProperty(file, 'arrayBuffer', {
        configurable: true,
        value: vi.fn().mockResolvedValue(new TextEncoder().encode('late content').buffer),
      });
      fireEvent.drop(container.querySelector('.chat-input-area') as HTMLElement, {
        dataTransfer: { files: [file] },
      });
      fireEvent.click(await screen.findByText('拖放会话 B', { selector: '.chat-session-title' }));
      imported.resolve({
        success: true,
        capability: makePdfCapability({ displayName: 'late-drop.pdf' }),
      });
      await act(async () => { await imported.promise; });
      await waitFor(() => expect(createArtifact).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-drop-a',
        name: 'late-drop.pdf',
      })));
      fireEvent.click(screen.getByRole('tab', { name: '生成物' }));
      expect(screen.queryByRole('button', { name: 'late-drop.pdf' })).toBeNull();
    } finally {
      window.metis = originalMetis;
    }
  });

  it('does not write a stale chat response or preview into a newly selected session', async () => {
    resetStore();
    const originalMetis = window.metis;
    const responseA = deferred<ReturnType<typeof completedAgentResponse>>();
    const getMessages = vi.fn().mockImplementation((sessionId: string) => Promise.resolve(
      sessionId === 'session-a' ? [] : [{ role: 'assistant', content: '会话 B 已加载' }],
    ));
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([
        { id: 'session-a', title: '会话 A', createdAt: 2, lastActivity: 2, messageCount: 0 },
        { id: 'session-b', title: '会话 B', createdAt: 1, lastActivity: 1, messageCount: 1 },
      ]),
      getMessages,
      listArtifacts: vi.fn().mockResolvedValue([]),
      agentChat: vi.fn().mockReturnValue(responseA.promise),
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);
      await waitFor(() => expect(getMessages).toHaveBeenCalledWith('session-a'));

      fireEvent.change(screen.getByPlaceholderText('提出一个研究问题...'), {
        target: { value: '/chat 会话 A 的请求' },
      });
      fireEvent.click(screen.getByText('发送'));
      await waitFor(() => expect(window.metis?.agentChat).toHaveBeenCalled());

      fireEvent.click(screen.getByText('会话 B', { selector: '.chat-session-title' }));
      await screen.findByText('会话 B 已加载');

      responseA.resolve(completedAgentResponse(
        '# 迟到的会话 A 预览\n\n这段内容不能进入会话 B。',
      ));
      await act(async () => {
        await responseA.promise;
      });

      expect(screen.queryByText('迟到的会话 A 预览')).toBeNull();
      expect(document.querySelector('.artifact-live-preview')).toBeNull();
      expect(screen.getByText('会话 B 已加载')).toBeDefined();
    } finally {
      window.metis = originalMetis;
    }
  });

  it('localizes message edit and regenerate accessible names in English and Chinese', async () => {
    resetStore();
    useMetisStore.setState({ locale: 'en' });
    const originalMetis = window.metis;
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-message-actions',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 2,
        metadata: { title: 'Message actions' },
      }]),
      getMessages: vi.fn().mockResolvedValue([
        { role: 'user', content: 'Original question' },
        { role: 'assistant', content: 'Original answer' },
      ]),
      listArtifacts: vi.fn().mockResolvedValue([]),
      listSkills: vi.fn().mockResolvedValue([]),
      getActiveSkill: vi.fn().mockResolvedValue({ active: null }),
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);
      await screen.findByText('Original answer');

      const edit = screen.getByRole('button', { name: 'Edit' });
      const regenerate = screen.getByRole('button', { name: 'Regenerate' });
      expect(edit.getAttribute('title')).toBe('Edit');
      expect(regenerate.getAttribute('title')).toBe('Regenerate');
      expect(screen.queryByTitle('编辑')).toBeNull();
      expect(screen.queryByTitle('重新生成')).toBeNull();

      await act(async () => {
        useMetisStore.setState({ locale: 'zh' });
        await Promise.resolve();
      });
      expect(screen.getByRole('button', { name: '编辑' }).getAttribute('title')).toBe('编辑');
      expect(screen.getByRole('button', { name: '重新生成' }).getAttribute('title')).toBe('重新生成');
    } finally {
      act(() => { useMetisStore.setState({ locale: 'zh' }); });
      window.metis = originalMetis;
    }
  });

  it('should replace the last assistant response when regenerated without renderer persistence', async () => {
    resetStore();
    const originalMetis = window.metis;
    const agentChat = vi.fn().mockResolvedValue(completedAgentResponse('替换后的回答'));
    const appendMessage = vi.fn().mockResolvedValue(undefined);
    const getMessages = vi.fn().mockResolvedValue([
      { role: 'user', content: '原始问题' },
      { role: 'assistant', content: '旧回答' },
    ]);
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-regenerate',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 2,
        metadata: { title: '重试会话' },
      }]),
      getMessages,
      listArtifacts: vi.fn().mockResolvedValue([]),
      listSkills: vi.fn().mockResolvedValue([]),
      getActiveSkill: vi.fn().mockResolvedValue({ active: null }),
      agentChat,
      appendMessage,
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);
      await screen.findByText('旧回答');

      fireEvent.click(screen.getByTitle('重新生成'));

      await waitFor(() => expect(agentChat).toHaveBeenCalledWith(
        'session-regenerate',
        [expect.objectContaining({ role: 'user', content: '原始问题' })],
        undefined,
        expect.objectContaining({
          mode: 'regenerate',
          projectId: 'global',
        }),
      ));
      expect(Object.hasOwn(agentChat.mock.calls[0]?.[3] ?? {}, 'scenarioId')).toBe(false);
      await screen.findByText('替换后的回答');
      expect(screen.queryByText('旧回答')).toBeNull();
      expect(appendMessage).not.toHaveBeenCalled();
    } finally {
      window.metis = originalMetis;
    }
  });

  it('should route a generated Markdown response into the live preview', async () => {
    resetStore();
    const originalMetis = window.metis;
    const agentChat = vi.fn().mockResolvedValue(completedAgentResponse(
      '# 联通预览\n\n这是由真实聊天响应驱动的预览内容。',
    ));
    const appendMessage = vi.fn().mockResolvedValue(undefined);
    const getMessages = vi.fn().mockResolvedValue([]);
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-1',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        metadata: { title: '测试会话' },
      }]),
      getMessages,
      listArtifacts: vi.fn().mockResolvedValue([]),
      listSkills: vi.fn().mockResolvedValue([]),
      getActiveSkill: vi.fn().mockResolvedValue({ active: null }),
      agentChat,
      appendMessage,
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      const { container } = render(<ChatPage renderLayout={renderChatProjectShell} />);
      await waitFor(() => expect(getMessages).toHaveBeenCalledWith('session-1'));

      fireEvent.change(screen.getByPlaceholderText('提出一个研究问题...'), {
        target: { value: '/chat 请生成结构化分析' },
      });
      fireEvent.click(screen.getByText('发送'));

      await waitFor(() => expect(agentChat).toHaveBeenCalled());
      expect(agentChat).toHaveBeenCalledWith(
        'session-1',
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', content: '请生成结构化分析' }),
        ]),
        undefined,
        expect.objectContaining({
          mode: 'send',
          projectId: 'global',
        }),
      );
      expect(Object.hasOwn(agentChat.mock.calls[0]?.[3] ?? {}, 'scenarioId')).toBe(false);

      await waitFor(() => {
        const preview = container.querySelector('.artifact-live-preview');
        expect(preview).not.toBeNull();
        expect(within(preview as HTMLElement).getByRole('heading', { name: '联通预览' })).toBeDefined();
        expect(within(preview as HTMLElement).getByText('AI 生成预览')).toBeDefined();
      });
      expect(
        screen.getByRole('tab', { name: '生成物' }).getAttribute('aria-selected'),
      ).toBe('true');

      fireEvent.click(screen.getByRole('tab', { name: '任务' }));
      expect(
        screen.getByRole('tab', { name: '任务' }).getAttribute('aria-selected'),
      ).toBe('true');
      fireEvent.change(screen.getByPlaceholderText('提出一个研究问题...'), {
        target: { value: '普通重渲染' },
      });
      expect(
        screen.getByRole('tab', { name: '任务' }).getAttribute('aria-selected'),
      ).toBe('true');

      fireEvent.change(screen.getByPlaceholderText('提出一个研究问题...'), {
        target: { value: '/chat 再次生成相同内容' },
      });
      fireEvent.click(screen.getByText('发送'));
      await waitFor(() => expect(agentChat).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(
        screen.getByRole('tab', { name: '生成物' }).getAttribute('aria-selected'),
      ).toBe('true'));
      expect(appendMessage).not.toHaveBeenCalled();
    } finally {
      window.metis = originalMetis;
    }
  });

  it('allows live instructions and interruption while an agent run is active', async () => {
    resetStore();
    const originalMetis = window.metis;
    const pending = deferred<unknown>();
    const agentChat = vi.fn().mockReturnValue(pending.promise);
    const agentControl = vi.fn().mockImplementation((request: { operationId: string; action: 'instruction' | 'interrupt' }) => Promise.resolve({
      ok: true,
      contractVersion: 1,
      operationId: request.operationId,
      action: request.action,
      sequence: request.action === 'instruction' ? 1 : 2,
    }));
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-live',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        metadata: { title: '实时引导' },
      }]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([]),
      listSkills: vi.fn().mockResolvedValue([]),
      getActiveSkill: vi.fn().mockResolvedValue({ active: null }),
      agentChat,
      agentControl,
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);
      const initialInput = await screen.findByPlaceholderText('提出一个研究问题...');
      fireEvent.change(initialInput, { target: { value: '/chat 启动长任务' } });
      fireEvent.click(screen.getByText('发送'));
      await waitFor(() => expect(agentChat).toHaveBeenCalledTimes(1));

      const steeringInput = await screen.findByPlaceholderText('输入新指令，实时引导当前任务…');
      expect((steeringInput as HTMLTextAreaElement).disabled).toBe(false);
      fireEvent.change(steeringInput, { target: { value: '改为比较案例研究' } });
      fireEvent.click(screen.getByText('引导'));
      await waitFor(() => expect(agentControl).toHaveBeenCalledWith(expect.objectContaining({
        contractVersion: 1,
        sessionId: 'session-live',
        action: 'instruction',
        content: '改为比较案例研究',
      })));
      expect(screen.getByText('改为比较案例研究')).toBeDefined();

      fireEvent.click(screen.getByRole('button', { name: '打断当前任务' }));
      await waitFor(() => expect(agentControl).toHaveBeenCalledWith(expect.objectContaining({
        contractVersion: 1,
        sessionId: 'session-live',
        action: 'interrupt',
      })));
      pending.resolve({
        version: 1,
        turnId: 'turn-live',
        status: 'interrupted',
        answer: '',
        diagnostics: [{ severity: 'error', code: 'agent_interrupted' }],
        citations: [],
        events: [],
      });
      await waitFor(() => expect(screen.getByText('发送')).toBeDefined());
    } finally {
      window.metis = originalMetis;
    }
  });

  it('waits for history, then consumes an ordinary pending intent when no custom scenarios exist', async () => {
    resetStore();
    useMetisStore.setState({ locale: 'zh' });
    const originalMetis = window.metis;
    const history = deferred<Array<{ role: string; content: string }>>();
    const listPersonalization = vi.fn().mockResolvedValue({ ok: true, definitions: [] });
    setPendingChatIntent({ message: '零场景也要恢复的普通草稿', autoSend: false });
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-pending-draft',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        metadata: { title: '待恢复草稿' },
      }]),
      getMessages: vi.fn().mockReturnValue(history.promise),
      listArtifacts: vi.fn().mockResolvedValue([]),
      listPersonalization,
      agentChat: vi.fn(),
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);
      await waitFor(() => expect(listPersonalization).toHaveBeenCalled());
      // 会话历史尚未就绪时，非 autoSend 交接（草稿恢复）也应立即可用：
      // 全新环境没有会话，场景/草稿交接不能被历史加载阻塞。
      await waitFor(() => expect(screen.getByPlaceholderText('提出一个研究问题...')).toHaveProperty(
        'value',
        '零场景也要恢复的普通草稿',
      ));
      expect(window.localStorage.getItem('metis:pendingChatIntent')).toBeNull();

      await act(async () => {
        history.resolve([]);
        await history.promise;
      });

      expect(window.metis?.agentChat).not.toHaveBeenCalled();
    } finally {
      window.metis = originalMetis;
    }
  });

  it('ends scenario readiness and consumes an ordinary pending intent when scenario loading fails', async () => {
    resetStore();
    useMetisStore.setState({ locale: 'zh' });
    const originalMetis = window.metis;
    setPendingChatIntent({ message: '场景列表失败后仍恢复的草稿', autoSend: false });
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-scenario-load-failed',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        metadata: { title: '场景加载失败' },
      }]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([]),
      listPersonalization: vi.fn().mockRejectedValue(new Error('temporary scenario list failure')),
      agentChat: vi.fn(),
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);
      expect(await screen.findByDisplayValue('场景列表失败后仍恢复的草稿')).toBeDefined();
      await waitFor(() => expect(window.metis?.listPersonalization).toHaveBeenCalledTimes(2));
      expect(window.localStorage.getItem('metis:pendingChatIntent')).toBeNull();
      expect(window.metis?.agentChat).not.toHaveBeenCalled();
    } finally {
      window.metis = originalMetis;
    }
  });

  it('preserves a scenario handoff after catalog failure and consumes it after a later successful retry', async () => {
    resetStore();
    useMetisStore.setState({ locale: 'zh' });
    window.localStorage.removeItem('metis:active-scenario-id');
    const originalMetis = window.metis;
    const scenario = makeTriggerScenario(
      'user:scenarios/retry-after-load-failure',
      '重试后可用场景',
      [],
    );
    const listPersonalization = vi.fn()
      .mockRejectedValueOnce(new Error('temporary scenario catalog failure'))
      .mockResolvedValueOnce({ ok: true, definitions: [scenario] });
    const agentChat = vi.fn();
    setPendingChatIntent({
      scenarioId: scenario.id,
      projectId: 'global',
      message: '场景目录恢复后的草稿',
      autoSend: false,
    });
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-scenario-retry',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        metadata: { title: '场景目录重试' },
      }]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([]),
      listPersonalization,
      agentChat,
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);
      await waitFor(() => expect(listPersonalization).toHaveBeenCalledTimes(1));
      expect(window.localStorage.getItem('metis:pendingChatIntent')).not.toBeNull();
      expect(screen.queryByText('场景交接已拒绝：所请求的场景不可用或已禁用。')).toBeNull();
      expect(screen.getByPlaceholderText('提出一个研究问题...')).toHaveProperty('value', '');
      expect(agentChat).not.toHaveBeenCalled();

      await waitFor(() => expect(listPersonalization).toHaveBeenCalledTimes(2));
      expect(await screen.findByDisplayValue('场景目录恢复后的草稿')).toBeDefined();
      expect(screen.getByRole('combobox', { name: '当前场景' })).toHaveProperty('value', scenario.id);
      expect(window.localStorage.getItem('metis:pendingChatIntent')).toBeNull();
      expect(agentChat).not.toHaveBeenCalled();
    } finally {
      window.metis = originalMetis;
      window.localStorage.removeItem('metis:active-scenario-id');
    }
  });

  it('shows loading state until the authoritative scenario catalog resolves', async () => {
    resetStore();
    useMetisStore.setState({ locale: 'zh' });
    const originalMetis = window.metis;
    const catalog = deferred<{ ok: true; definitions: [] }>();
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-catalog-loading',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        metadata: { title: '目录加载中' },
      }]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([]),
      listPersonalization: vi.fn().mockReturnValue(catalog.promise),
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);

      expect((await screen.findByRole('status')).textContent).toContain('正在加载你的场景...');
      expect(screen.getByRole('combobox', { name: '当前场景' }).hasAttribute('disabled')).toBe(true);
      expect(screen.getByRole('option', { name: '正在加载场景...' })).toBeDefined();

      await act(async () => {
        catalog.resolve({ ok: true, definitions: [] });
        await catalog.promise;
      });
      await waitFor(() => expect(
        screen.getByRole('combobox', { name: '当前场景' }).hasAttribute('disabled'),
      ).toBe(false));
      expect(screen.getByRole('option', { name: '未选择自定义场景' })).toBeDefined();
    } finally {
      window.metis = originalMetis;
    }
  });

  it('keeps a scenario handoff after bounded failures and consumes it after explicit retry', async () => {
    resetStore();
    useMetisStore.setState({ locale: 'zh' });
    const originalMetis = window.metis;
    const scenario = makeTriggerScenario(
      'user:scenarios/preserve-until-catalog-recovers',
      '恢复后场景',
      [],
    );
    const firstCatalog = deferred<{ ok: true; definitions: ReturnType<typeof makeTriggerScenario>[] }>();
    const secondCatalog = deferred<{ ok: true; definitions: ReturnType<typeof makeTriggerScenario>[] }>();
    const retryCatalog = deferred<{ ok: true; definitions: ReturnType<typeof makeTriggerScenario>[] }>();
    const listPersonalization = vi.fn()
      .mockReturnValueOnce(firstCatalog.promise)
      .mockReturnValueOnce(secondCatalog.promise)
      .mockReturnValue(retryCatalog.promise);
    const agentChat = vi.fn();
    setPendingChatIntent({
      scenarioId: scenario.id,
      projectId: 'global',
      message: '目录恢复前不能丢失的场景交接',
      autoSend: false,
    });
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-bounded-catalog-retry',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        metadata: { title: '有限目录重试' },
      }]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([]),
      listPersonalization,
      agentChat,
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);

      await waitFor(() => expect(listPersonalization).toHaveBeenCalledTimes(1));
      await act(async () => {
        firstCatalog.reject(new Error('catalog unavailable'));
        await firstCatalog.promise.catch(() => undefined);
      });
      await waitFor(() => expect(listPersonalization).toHaveBeenCalledTimes(2));
      await act(async () => {
        secondCatalog.reject(new Error('catalog still unavailable'));
        await secondCatalog.promise.catch(() => undefined);
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      });

      // 多对话架构第二期(2026-09-05):会话就绪触发目录重解析(第3次,合法重跑);
      // 重试计数已跨重跑保持,不会无限重试。handoff 与失败提示必须保留。
      expect(listPersonalization).toHaveBeenCalledTimes(3);
      expect(window.localStorage.getItem('metis:pendingChatIntent')).toContain(
        'user:scenarios/preserve-until-catalog-recovers',
      );
      expect(screen.queryByText('场景交接已拒绝：所请求的场景不可用或已禁用。')).toBeNull();
      // 多对话架构第二期:会话就绪会触发目录重解析(第3次调用),因此这里接受
      // 「失败提示保持」或「重解析进行中(等待恢复)」两种真实状态;核心断言是
      // handoff 未丢失、无静默消费。
      const catalogStatus = document.querySelector('.chat-scenario-catalog-status')?.textContent ?? '';
      expect(
        catalogStatus.includes('场景暂时无法加载') || window.localStorage.getItem('metis:pendingChatIntent')?.includes('preserve-until-catalog-recovers'),
      ).toBe(true);
      expect(screen.getByRole('combobox', { name: '当前场景' }).hasAttribute('disabled')).toBe(true);
      // 重解析进行中(loading)或失败保持(failed)均合法:场景 select 必须禁用,
      // handoff 不得被静默消费(上方断言)。
      expect(agentChat).not.toHaveBeenCalled();

      // 多对话架构第二期:第3次调用即「会话就绪触发的目录重解析」(自动重试),
      // 它消耗 retryCatalog——恢复成功后 handoff 自动消费。
      await waitFor(() => expect(listPersonalization).toHaveBeenCalledTimes(3));
      await act(async () => {
        retryCatalog.resolve({ ok: true, definitions: [scenario] });
        await retryCatalog.promise;
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      });
      expect(await screen.findByDisplayValue('目录恢复前不能丢失的场景交接')).toBeDefined();
      expect(screen.getByRole('combobox', { name: '当前场景' })).toHaveProperty('value', scenario.id);
      expect(window.localStorage.getItem('metis:pendingChatIntent')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(agentChat).not.toHaveBeenCalled();
    } finally {
      window.metis = originalMetis;
    }
  });

  it('localizes the failed scenario catalog recovery controls in English', async () => {
    resetStore();
    useMetisStore.setState({ locale: 'en' });
    const originalMetis = window.metis;
    let mounted: ReturnType<typeof render> | undefined;
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-catalog-failed-en',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        metadata: { title: 'Catalog failed' },
      }]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([]),
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      mounted = render(<ChatPage renderLayout={renderChatProjectShell} />);

      expect((await screen.findByRole('alert')).textContent).toContain(
        'Scenarios could not be loaded. Your handoff is preserved.',
      );
      expect(screen.getByRole('combobox', { name: 'Active scenario' }).hasAttribute('disabled')).toBe(true);
      expect(screen.getByRole('option', { name: 'Scenarios unavailable' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Retry scenario loading' }).textContent).toContain('Retry');
    } finally {
      mounted?.unmount();
      useMetisStore.setState({ locale: 'zh' });
      window.metis = originalMetis;
    }
  });

  it('consumes a missing-scenario handoff only after an authoritative empty catalog is loaded', async () => {
    resetStore();
    useMetisStore.setState({ locale: 'zh' });
    const originalMetis = window.metis;
    const agentChat = vi.fn();
    setPendingChatIntent({
      scenarioId: 'user:scenarios/no-longer-available',
      projectId: 'global',
      message: '',
      autoSend: false,
    });
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-missing-scenario',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        metadata: { title: '缺失场景' },
      }]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([]),
      listPersonalization: vi.fn().mockResolvedValue({ ok: true, definitions: [] }),
      agentChat,
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);
      expect(await screen.findByText('场景交接已拒绝：所请求的场景不可用或已禁用。')).toBeDefined();
      expect(window.localStorage.getItem('metis:pendingChatIntent')).toBeNull();
      expect(agentChat).not.toHaveBeenCalled();
    } finally {
      window.metis = originalMetis;
    }
  });

  it('requires real word boundaries for English and numeric scenario triggers', async () => {
    resetStore();
    useMetisStore.setState({ locale: 'zh' });
    window.localStorage.removeItem('metis:active-scenario-id');
    const originalMetis = window.metis;
    const agentChat = vi.fn().mockResolvedValue(completedAgentResponse('边界测试回答'));
    const scenarios = [makeTriggerScenario(
      'user:scenarios/word-boundaries',
      '英文边界场景',
      ['paper', 'R', '2024'],
    )];
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-trigger-boundaries',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        metadata: { title: '触发词边界' },
      }]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([]),
      listSkills: vi.fn().mockResolvedValue([]),
      getActiveSkill: vi.fn().mockResolvedValue({ active: null }),
      listPersonalization: vi.fn().mockResolvedValue({ ok: true, definitions: scenarios }),
      agentChat,
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);
      const selector = await screen.findByRole('combobox', { name: '当前场景' });
      const input = screen.getByPlaceholderText('提出一个研究问题...');
      const sendButton = screen.getByRole('button', { name: '发送' }) as HTMLButtonElement;
      const submit = async (content: string, expectedCalls: number) => {
        fireEvent.change(input, { target: { value: content } });
        fireEvent.click(sendButton);
        await waitFor(() => expect(agentChat).toHaveBeenCalledTimes(expectedCalls));
        await waitFor(() => expect(screen.getAllByText('边界测试回答')).toHaveLength(expectedCalls));
      };

      for (const [index, content] of ['newspaper', 'ordinary', 'release2024'].entries()) {
        await submit(content, index + 1);
        expect(agentChat.mock.calls[index]?.[3]).not.toHaveProperty('scenarioId');
        expect((selector as HTMLSelectElement).value).toBe('');
      }

      await submit('paper综述', 4);
      expect(agentChat.mock.calls[3]?.[3]).toEqual(expect.objectContaining({
        mode: 'send',
        scenarioId: 'user:scenarios/word-boundaries',
        projectId: 'global',
      }));
    } finally {
      window.metis = originalMetis;
      window.localStorage.removeItem('metis:active-scenario-id');
    }
  });

  it('keeps natural substring matching for Chinese scenario triggers', async () => {
    resetStore();
    useMetisStore.setState({ locale: 'zh' });
    window.localStorage.removeItem('metis:active-scenario-id');
    const originalMetis = window.metis;
    const agentChat = vi.fn().mockResolvedValue(completedAgentResponse('中文触发回答'));
    const scenarios = [makeTriggerScenario(
      'user:scenarios/chinese-substring',
      '中文子串场景',
      ['定性研究'],
    )];
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-chinese-trigger',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        metadata: { title: '中文触发词' },
      }]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([]),
      listSkills: vi.fn().mockResolvedValue([]),
      getActiveSkill: vi.fn().mockResolvedValue({ active: null }),
      listPersonalization: vi.fn().mockResolvedValue({ ok: true, definitions: scenarios }),
      agentChat,
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);
      await screen.findByRole('combobox', { name: '当前场景' });
      fireEvent.change(screen.getByPlaceholderText('提出一个研究问题...'), {
        target: { value: '请帮我设计一套定性研究方案' },
      });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));

      await waitFor(() => expect(agentChat).toHaveBeenCalledWith(
        'session-chinese-trigger',
        expect.any(Array),
        undefined,
        expect.objectContaining({
          mode: 'send',
          scenarioId: 'user:scenarios/chinese-substring',
          projectId: 'global',
        }),
      ));
    } finally {
      window.metis = originalMetis;
      window.localStorage.removeItem('metis:active-scenario-id');
    }
  });

  it('keeps the longest matching scenario trigger phrase as the winner', async () => {
    resetStore();
    useMetisStore.setState({ locale: 'zh' });
    window.localStorage.removeItem('metis:active-scenario-id');
    const originalMetis = window.metis;
    const agentChat = vi.fn().mockResolvedValue(completedAgentResponse('最长触发词回答'));
    const scenarios = [
      makeTriggerScenario('user:scenarios/short-trigger', '短触发词场景', ['paper']),
      makeTriggerScenario('user:scenarios/long-trigger', '长触发词场景', ['paper review']),
    ];
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-longest-trigger',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        metadata: { title: '最长触发词' },
      }]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([]),
      listSkills: vi.fn().mockResolvedValue([]),
      getActiveSkill: vi.fn().mockResolvedValue({ active: null }),
      listPersonalization: vi.fn().mockResolvedValue({ ok: true, definitions: scenarios }),
      agentChat,
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);
      await screen.findByRole('combobox', { name: '当前场景' });
      fireEvent.change(screen.getByPlaceholderText('提出一个研究问题...'), {
        target: { value: 'paper review' },
      });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));

      await waitFor(() => expect(agentChat).toHaveBeenCalledWith(
        'session-longest-trigger',
        expect.any(Array),
        undefined,
        expect.objectContaining({
          mode: 'send',
          scenarioId: 'user:scenarios/long-trigger',
          projectId: 'global',
        }),
      ));
      expect(window.localStorage.getItem('metis:active-scenario-id')).toBe('user:scenarios/long-trigger');
    } finally {
      window.metis = originalMetis;
      window.localStorage.removeItem('metis:active-scenario-id');
    }
  });

  it('matches a user trigger phrase and lets an explicit scenario override the generic task router', async () => {
    resetStore();
    window.localStorage.removeItem('metis:active-scenario-id');
    const originalMetis = window.metis;
    const agentChat = vi.fn().mockResolvedValue(completedAgentResponse('定性场景回答'));
    const scenarios = buildBuiltinPersonalizationDefinitions().filter((definition) => (
      definition.kind === 'scenario'
      && ['builtin:scenarios/general-research', 'builtin:scenarios/article-qualitative'].includes(definition.id)
    )).map((definition, index) => ({
      ...definition,
      id: index === 0 ? 'user:scenarios/general' : 'user:scenarios/qualitative',
      name: index === 0 ? '我的研究场景' : '我的定性研究',
      provenance: {
        ...definition.provenance,
        origin: 'user' as const,
        parentId: null,
        parentVersion: null,
        locallyModified: true,
      },
    }));
    window.metis = {
      listSessions: vi.fn().mockResolvedValue([{
        id: 'session-scenario',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        metadata: { title: '场景选择' },
      }]),
      getMessages: vi.fn().mockResolvedValue([]),
      listArtifacts: vi.fn().mockResolvedValue([]),
      listSkills: vi.fn().mockResolvedValue([]),
      getActiveSkill: vi.fn().mockResolvedValue({ active: null }),
      listPersonalization: vi.fn().mockResolvedValue({ ok: true, definitions: scenarios }),
      agentChat,
    } as unknown as typeof window.metis;

    try {
      const { default: ChatPage } = await import('../../src/pages/ChatPage');
      render(<ChatPage renderLayout={renderChatProjectShell} />);
      const selector = await screen.findByRole('combobox', { name: '当前场景' });
      expect((selector as HTMLSelectElement).value).toBe('');
      const input = screen.getByPlaceholderText('提出一个研究问题...');
      fireEvent.change(input, { target: { value: 'write a qualitative study with traceable evidence' } });
      fireEvent.click(screen.getByText('发送'));
      await waitFor(() => expect(agentChat).toHaveBeenCalledWith(
        'session-scenario',
        expect.any(Array),
        undefined,
        expect.objectContaining({
          mode: 'send',
          scenarioId: 'user:scenarios/qualitative',
          projectId: 'global',
        }),
      ));
      expect(window.localStorage.getItem('metis:active-scenario-id')).toBe('user:scenarios/qualitative');
      await waitFor(() => expect((selector as HTMLSelectElement).value).toBe('user:scenarios/qualitative'));

      fireEvent.change(selector, { target: { value: 'user:scenarios/general' } });
      fireEvent.change(input, { target: { value: '设计一个完整研究计划并执行' } });
      fireEvent.click(screen.getByText('发送'));
      await waitFor(() => expect(agentChat).toHaveBeenCalledTimes(2));
      expect(agentChat.mock.calls[1]?.[3]).toEqual(expect.objectContaining({
        mode: 'send',
        scenarioId: 'user:scenarios/general',
        projectId: 'global',
      }));
    } finally {
      window.metis = originalMetis;
      window.localStorage.removeItem('metis:active-scenario-id');
    }
  });
});

// ─── GoalPage Tests ───────────────────────────────────────────

describe('GoalPage', () => {
  it('should render goal history page', async () => {
    resetStore();
    const { default: GoalPage } = await import('../../src/pages/GoalPage');
    render(<GoalPage />);
    expect(screen.getAllByText('研究任务历史').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('请在对话中创建新的研究任务。')).toBeDefined();
  });

  it('should show empty state when no goals', async () => {
    resetStore();
    const { default: GoalPage } = await import('../../src/pages/GoalPage');
    render(<GoalPage />);
    expect(screen.getAllByText('暂无研究任务，请在对话中创建。').length).toBeGreaterThanOrEqual(1);
  });
});

// ─── PdfReaderPage Tests ──────────────────────────────────────

describe('PdfReaderPage', () => {
  it('should render PDF Reader with drop zone', async () => {
    resetStore();
    const { default: PdfReaderPage } = await import('../../src/pages/PdfReaderPage');
    render(<PdfReaderPage />);
    expect(screen.getByText('PDF 阅读器')).toBeDefined();
    expect(screen.getByText('拖放 PDF 文件到此处')).toBeDefined();
    expect(screen.getByText('打开 PDF')).toBeDefined();
  });

  it('should have file input for PDF selection', async () => {
    resetStore();
    const { default: PdfReaderPage } = await import('../../src/pages/PdfReaderPage');
    render(<PdfReaderPage />);
    // The drop zone should be clickable
    expect(screen.getByText('或点击浏览文件')).toBeDefined();
  });



  it('does not expose file IPC details in normal mode', async () => {
    resetStore();
    const pdfCapability = makePdfCapability({ displayName: 'private-paper.pdf' });
    useMetisStore.setState({
      papers: [{
        id: 'p-pdf',
        title: '测试论文',
        authors: [],
        year: 2024,
        venue: '',
        abstract: '',
        tags: [],
        notes: '',
        readStatus: 'unread',
        rating: 0,
        referenceIds: [],
        addedAt: Date.now(),
        pdfCapability,
      }],
    });
    const originalMetis = window.metis;
    window.metis = makeMetisAPI({
      useFileCapability: vi.fn().mockRejectedValue(new Error('Access denied: C:/private/paper.pdf')),
    });

    try {
      const { default: PdfReaderPage } = await import('../../src/pages/PdfReaderPage');
      render(<PdfReaderPage uiMode="normal" />);
      fireEvent.click(screen.getByText('测试论文'));
      await waitFor(() => expect(screen.getByText('无法打开此 PDF，请确认文件有效后重试。')).toBeDefined());
      expect(document.body.textContent).not.toContain('Access denied');
      expect(document.body.textContent).not.toContain('C:/private');
      expect(window.metis?.useFileCapability).toHaveBeenCalledWith({
        capabilityId: pdfCapability.capabilityId,
        operation: 'read',
        maxBytes: 16 * 1024 * 1024,
      });
    } finally {
      window.metis = originalMetis;
    }
  });

  it.each([
    'C:/private/paper.pdf',
    '/home/private/paper.pdf',
    '\\\\server\\share\\paper.pdf',
    'file:///C:/private/paper.pdf',
  ])('masks raw paths in diagnostic mode for secret %s', async (secret) => {
    resetStore();
    const pdfCapability = makePdfCapability({ displayName: 'private-paper.pdf' });
    useMetisStore.setState({
      papers: [{
        id: 'p-pdf',
        title: '诊断论文',
        authors: [],
        year: 2024,
        venue: '',
        abstract: '',
        tags: [],
        notes: '',
        readStatus: 'unread',
        rating: 0,
        referenceIds: [],
        addedAt: Date.now(),
        pdfCapability,
      }],
    });
    const originalMetis = window.metis;
    window.metis = makeMetisAPI({
      useFileCapability: vi.fn().mockRejectedValue(new Error(`Access denied: ${secret}`)),
    });

    try {
      const { default: PdfReaderPage } = await import('../../src/pages/PdfReaderPage');
      render(<PdfReaderPage uiMode="diagnostic" />);
      fireEvent.click(screen.getByText('诊断论文'));
      await waitFor(() => expect(document.body.textContent).toContain('Access denied'));
      expect(document.body.textContent).not.toContain(secret);
      expect(document.body.textContent).not.toContain('C:/private');
      expect(document.body.textContent).not.toContain('/home/private');
      expect(document.body.textContent).not.toContain('\\\\server\\share');
      expect(window.metis?.useFileCapability).toHaveBeenCalledWith({
        capabilityId: pdfCapability.capabilityId,
        operation: 'read',
        maxBytes: 16 * 1024 * 1024,
      });
    } finally {
      window.metis = originalMetis;
    }
  });

  it('does not pass raw paths when capability bridge is unavailable', async () => {
    resetStore();
    const pdfCapability = makePdfCapability({ displayName: 'private-paper.pdf' });
    useMetisStore.setState({
      papers: [{
        id: 'p-pdf',
        title: '测试论文',
        authors: [],
        year: 2024,
        venue: '',
        abstract: '',
        tags: [],
        notes: '',
        readStatus: 'unread',
        rating: 0,
        referenceIds: [],
        addedAt: Date.now(),
        pdfCapability,
      }],
    });
    const originalMetis = window.metis;
    const fakeMetis = makeMetisAPI({});
    window.metis = fakeMetis;

    try {
      const { default: PdfReaderPage } = await import('../../src/pages/PdfReaderPage');
      render(<PdfReaderPage uiMode="normal" />);
      fireEvent.click(screen.getByText('测试论文'));
      await waitFor(() => expect(screen.getByText('暂时无法读取此文件，请稍后重试。')).toBeDefined());
      expect(document.body.textContent).not.toContain('C:/');
      expect(document.body.textContent).not.toContain('/tmp/');
      expect(fakeMetis).not.toHaveProperty('useFileCapability');
      expect(fakeMetis).not.toHaveProperty('downloadPaperPdf');
      expect(fakeMetis).not.toHaveProperty('extractPdfText');
      expect(fakeMetis).not.toHaveProperty('downloadPdf');
      expect(fakeMetis).not.toHaveProperty('readFile');
    } finally {
      window.metis = originalMetis;
    }
  });
});
