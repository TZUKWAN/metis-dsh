/**
 * Frontend unit tests — Zustand store logic.
 * Tests the core state management: papers, notes, experiments, filters.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useMetisStore, filterPapers, findSimilarPapers, suggestTags } from '../../src/store';
import type { PaperItem, NoteItem, ExperimentItem } from '../../src/store';
import type { FileCapabilityDescriptor } from '../../engine/runtime/FileCapabilityContract.js';

// Reset store between tests
function resetStore() {
  const { setState } = useMetisStore;
  setState({
    papers: [],
    paperFilter: { query: '' },
    notes: [],
    selectedNote: null,
    experiments: [],
    collections: [],
    selectedCollection: null,
    workflowRuns: [],
  });
}

// ─── Paper Tests ─────────────────────────────────────────────

describe('useMetisStore — Papers', () => {
  beforeEach(resetStore);

  const samplePaper: PaperItem = {
    id: 'paper_1',
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Noam Shazeer'],
    year: 2017,
    venue: 'NeurIPS',
    abstract: 'We propose a new simple network architecture, the Transformer.',
    doi: '10.48550/arXiv.1706.03762',
    tags: ['deep-learning', 'transformer', 'attention'],
    notes: 'Foundation of modern NLP',
    readStatus: 'read',
    rating: 5,
    referenceIds: [],
    addedAt: Date.now(),
  };

  it('should add a paper', () => {
    const store = useMetisStore.getState();
    store.addPaper(samplePaper);
    expect(useMetisStore.getState().papers).toHaveLength(1);
    expect(useMetisStore.getState().papers[0]?.title).toBe('Attention Is All You Need');
  });

  it('should remove a paper', () => {
    const store = useMetisStore.getState();
    store.addPaper(samplePaper);
    store.removePaper('paper_1');
    expect(useMetisStore.getState().papers).toHaveLength(0);
  });

  it('should not remove a non-existent paper', () => {
    const store = useMetisStore.getState();
    store.addPaper(samplePaper);
    store.removePaper('nonexistent');
    expect(useMetisStore.getState().papers).toHaveLength(1);
  });

  it('should add and remove paper references', async () => {
    const store = useMetisStore.getState();
    store.addPaper(samplePaper);
    store.addPaper({ ...samplePaper, id: 'paper_2', title: 'BERT', doi: '10.1234/bert', referenceIds: [] });
    await store.addPaperReference('paper_1', 'paper_2');
    expect(useMetisStore.getState().papers.find((p) => p.id === 'paper_1')?.referenceIds).toEqual(['paper_2']);
    await store.addPaperReference('paper_1', 'paper_2');
    expect(useMetisStore.getState().papers.find((p) => p.id === 'paper_1')?.referenceIds).toEqual(['paper_2']);
    await store.removePaperReference('paper_1', 'paper_2');
    expect(useMetisStore.getState().papers.find((p) => p.id === 'paper_1')?.referenceIds).toEqual([]);
  });

  it('should ignore self-references and references to missing papers', async () => {
    const store = useMetisStore.getState();
    store.addPaper(samplePaper);
    await store.addPaperReference('paper_1', 'paper_1');
    await store.addPaperReference('paper_1', 'missing');
    expect(useMetisStore.getState().papers.find((p) => p.id === 'paper_1')?.referenceIds).toEqual([]);
  });

  it('should merge referenceIds when merging duplicate papers', async () => {
    const store = useMetisStore.getState();
    store.addPaper({ ...samplePaper, referenceIds: ['paper_2'] });
    await store.addPaper({ ...samplePaper, id: 'paper_1_dup', referenceIds: ['paper_3'] });
    expect(useMetisStore.getState().papers.find((p) => p.id === 'paper_1')?.referenceIds).toEqual(['paper_2', 'paper_3']);
  });

  it('should filter papers by query', () => {
    const store = useMetisStore.getState();
    store.addPaper(samplePaper);
    store.addPaper({ ...samplePaper, id: 'paper_2', title: 'BERT', authors: ['Jacob Devlin'], tags: ['bert'], doi: undefined, arxivId: undefined });
    
    store.setPaperFilter({ query: 'attention' });
    expect(filterPapers(useMetisStore.getState().papers, useMetisStore.getState().paperFilter)).toHaveLength(1);
  });

  it('should filter papers by year range', () => {
    const store = useMetisStore.getState();
    store.addPaper(samplePaper);
    store.addPaper({ ...samplePaper, id: 'paper_2', title: 'GPT-4', year: 2023, doi: undefined, arxivId: undefined });
    
    store.setPaperFilter({ yearFrom: 2020 });
    expect(filterPapers(useMetisStore.getState().papers, useMetisStore.getState().paperFilter)).toHaveLength(1);
    expect(filterPapers(useMetisStore.getState().papers, useMetisStore.getState().paperFilter)[0]?.title).toBe('GPT-4');
  });

  it('should filter papers by read status', () => {
    const store = useMetisStore.getState();
    store.addPaper(samplePaper);
    store.addPaper({ ...samplePaper, id: 'paper_2', title: 'BERT', readStatus: 'unread', doi: undefined, arxivId: undefined });

    store.setPaperFilter({ readStatus: 'unread' });
    expect(filterPapers(useMetisStore.getState().papers, useMetisStore.getState().paperFilter)).toHaveLength(1);
  });

  it('should filter papers read within the last N days', () => {
    const store = useMetisStore.getState();
    const now = Date.now();
    store.addPaper({ ...samplePaper, id: 'paper_1', readAt: now - 2 * 24 * 60 * 60 * 1000 });
    store.addPaper({ ...samplePaper, id: 'paper_2', title: 'BERT', readAt: now - 10 * 24 * 60 * 60 * 1000, doi: undefined, arxivId: undefined });
    store.addPaper({ ...samplePaper, id: 'paper_3', title: 'Old unread', readStatus: 'unread', readAt: undefined, doi: undefined, arxivId: undefined });

    store.setPaperFilter({ readWithinDays: 7 });
    const filtered = filterPapers(useMetisStore.getState().papers, useMetisStore.getState().paperFilter);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe('paper_1');
  });



  it('should filter papers by minimum rating', () => {
    const store = useMetisStore.getState();
    store.addPaper(samplePaper); // rating 5
    store.addPaper({ ...samplePaper, id: 'paper_2', title: 'Low Rating Paper', rating: 2, doi: undefined, arxivId: undefined });
    
    store.setPaperFilter({ minRating: 4 });
    expect(filterPapers(useMetisStore.getState().papers, useMetisStore.getState().paperFilter)).toHaveLength(1);
  });

  it('should filter papers by venue', () => {
    const store = useMetisStore.getState();
    store.addPaper(samplePaper); // NeurIPS
    store.addPaper({ ...samplePaper, id: 'paper_2', title: 'BERT', venue: 'ICML', doi: undefined, arxivId: undefined });
    
    store.setPaperFilter({ venue: 'neurips' });
    expect(filterPapers(useMetisStore.getState().papers, useMetisStore.getState().paperFilter)).toHaveLength(1);
  });

  it('should filter papers by exact tag', () => {
    const store = useMetisStore.getState();
    store.addPaper({ ...samplePaper, id: 'paper_1', tags: ['transformer', 'nlp'] });
    store.addPaper({ ...samplePaper, id: 'paper_2', title: 'BERT', tags: ['nlp'], doi: undefined, arxivId: undefined });
    store.addPaper({ ...samplePaper, id: 'paper_3', title: 'RL', tags: ['reinforcement-learning'], doi: undefined, arxivId: undefined });

    store.setPaperFilter({ tag: 'nlp' });
    const filtered = filterPapers(useMetisStore.getState().papers, useMetisStore.getState().paperFilter);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((p) => p.id).sort()).toEqual(['paper_1', 'paper_2']);

    store.setPaperFilter({ tag: 'NLP' });
    expect(filterPapers(useMetisStore.getState().papers, useMetisStore.getState().paperFilter)).toHaveLength(2);

    store.setPaperFilter({ tag: 'np' });
    expect(filterPapers(useMetisStore.getState().papers, useMetisStore.getState().paperFilter)).toHaveLength(0);
  });

  it('should filter papers by minimum citation count', () => {
    const store = useMetisStore.getState();
    store.addPaper({ ...samplePaper, id: 'paper_1', citationCount: 100 });
    store.addPaper({ ...samplePaper, id: 'paper_2', citationCount: 10, doi: undefined, arxivId: undefined });

    store.setPaperFilter({ minCitations: 50 });
    const filtered = filterPapers(useMetisStore.getState().papers, useMetisStore.getState().paperFilter);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.citationCount).toBe(100);
  });

  it('should suggest tags based on paper text and existing tags', () => {
    const store = useMetisStore.getState();
    store.addPaper({ ...samplePaper, id: 'paper_1', tags: ['transformer', 'attention'] });
    store.addPaper({ ...samplePaper, id: 'paper_2', tags: ['reinforcement-learning'], doi: undefined, arxivId: undefined });
    const target: PaperItem = { ...samplePaper, id: 'paper_3', title: 'Attention in Transformers', tags: [], doi: undefined, arxivId: undefined };
    const suggestions = suggestTags(target, useMetisStore.getState().papers, 5);
    expect(suggestions).toContain('transformer');
    expect(suggestions).toContain('attention');
    expect(suggestions).not.toContain('reinforcement-learning');
  });

  it('should return all papers when no filter is active', async () => {
    const store = useMetisStore.getState();
    await store.addPaper(samplePaper);
    await store.addPaper({ ...samplePaper, id: 'paper_2', title: 'BERT', doi: undefined, arxivId: undefined });
    
    expect(filterPapers(useMetisStore.getState().papers, { query: '' })).toHaveLength(2);
  });

  it('should rank papers by semantic relevance', () => {
    const p1: PaperItem = { ...samplePaper, id: 'p1', title: 'Neural Machine Translation', abstract: 'We introduce a neural approach to machine translation.', tags: ['nmt'] };
    const p2: PaperItem = { ...samplePaper, id: 'p2', title: 'Transformers for NLP', abstract: 'Attention mechanisms for natural language processing.', tags: ['transformer'] };
    const p3: PaperItem = { ...samplePaper, id: 'p3', title: 'Reinforcement Learning', abstract: 'Q-learning and policy gradients.', tags: ['rl'] };
    const ranked = filterPapers([p1, p2, p3], { query: 'attention transformer nlp', semantic: true });
    expect(ranked[0]?.id).toBe('p2');
  });

  it('should rank papers by semantic relevance including indexed PDF text', () => {
    const p1: PaperItem = {
      ...samplePaper, id: 'p1', title: 'Neural Machine Translation',
      abstract: 'We introduce a neural approach to machine translation.', tags: ['nmt'], pdfText: 'Our model uses recurrent layers.',
    };
    const p2: PaperItem = {
      ...samplePaper, id: 'p2', title: 'Transformers for NLP',
      abstract: 'Attention mechanisms for natural language processing.', tags: ['transformer'], pdfText: 'The attention mechanism outperforms recurrent models.',
    };
    const p3: PaperItem = {
      ...samplePaper, id: 'p3', title: 'Reinforcement Learning',
      abstract: 'Q-learning and policy gradients.', tags: ['rl'], pdfText: 'Policy gradient methods converge faster.',
    };
    const ranked = filterPapers([p1, p2, p3], { query: 'attention mechanism transformer', semantic: true });
    expect(ranked[0]?.id).toBe('p2');
  });

  it('should find similar papers in library by cosine similarity', () => {
    const p1: PaperItem = {
      ...samplePaper, id: 'p1', title: 'Neural Machine Translation',
      authors: ['Alice'], abstract: 'neural attention mechanisms machine translation', tags: ['nmt'], notes: '',
    };
    const p2: PaperItem = {
      ...samplePaper, id: 'p2', title: 'Transformers for NLP',
      authors: ['Bob'], abstract: 'neural attention mechanisms language processing', tags: ['transformer'], notes: '',
    };
    const p3: PaperItem = {
      ...samplePaper, id: 'p3', title: 'Reinforcement Learning',
      authors: ['Carol'], abstract: 'policy gradients reinforcement', tags: ['rl'], notes: '',
    };
    const similar = findSimilarPapers([p1, p2, p3], 'p2', 2);
    expect(similar).toHaveLength(1);
    expect(similar[0]?.paper.id).toBe('p1');
    expect(similar[0]?.score).toBeGreaterThan(0);
  });

  it('should merge duplicate papers by DOI', async () => {
    const store = useMetisStore.getState();
    const first = { ...samplePaper, id: 'paper_1' };
    const duplicate = { ...samplePaper, id: 'paper_2', title: 'Different title', tags: ['new-tag'] };
    await store.addPaper(first);
    const result = await store.addPaper(duplicate);

    expect(result.merged).toBe(true);
    expect(useMetisStore.getState().papers).toHaveLength(1);
    expect(useMetisStore.getState().papers[0]?.title).toBe('Attention Is All You Need');
    expect(useMetisStore.getState().papers[0]?.tags).toContain('new-tag');
  });

  it('should merge duplicate papers by arXiv ID', async () => {
    const store = useMetisStore.getState();
    const first = { ...samplePaper, id: 'paper_1', doi: undefined, arxivId: '1706.03762' };
    const duplicate = { ...samplePaper, id: 'paper_2', doi: undefined, arxivId: 'arXiv:1706.03762', title: 'Attention Is All You Need' };
    await store.addPaper(first);
    const result = await store.addPaper(duplicate);

    expect(result.merged).toBe(true);
    expect(useMetisStore.getState().papers).toHaveLength(1);
  });

  it('should merge duplicate papers by normalized title', async () => {
    const store = useMetisStore.getState();
    const first = { ...samplePaper, id: 'paper_1', doi: undefined, arxivId: undefined };
    const duplicate = { ...samplePaper, id: 'paper_2', doi: undefined, arxivId: undefined, title: 'Attention Is All You Need!' };
    await store.addPaper(first);
    const result = await store.addPaper(duplicate);

    expect(result.merged).toBe(true);
    expect(useMetisStore.getState().papers).toHaveLength(1);
  });

  it('should merge incoming fields into existing paper', async () => {
    const store = useMetisStore.getState();
    const pdfCapability: FileCapabilityDescriptor = {
      capabilityId: 'fc_paper_merge_test_0000000000000000000000000000',
      kind: 'file',
      mime: 'application/pdf',
      displayName: 'merged-paper.pdf',
      operations: ['file', 'read', 'extract'],
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60 * 60 * 1000,
    };
    const first: PaperItem = { ...samplePaper, id: 'paper_1', abstract: '', pdfCapability, tags: ['a'], notes: '' };
    const duplicate: PaperItem = { ...samplePaper, id: 'paper_2', abstract: 'We propose the Transformer.', pdfCapability: undefined, tags: ['b', 'c'], notes: 'incoming note' };
    await store.addPaper(first);
    await store.addPaper(duplicate);

    const merged = useMetisStore.getState().papers[0];
    expect(merged?.abstract).toBe('We propose the Transformer.');
    expect(merged?.pdfCapability?.capabilityId).toBe(pdfCapability.capabilityId);
    expect(merged?.tags).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(merged?.notes).toBe('incoming note');
  });
});

// ─── Note Tests ──────────────────────────────────────────────

describe('useMetisStore — Notes', () => {
  beforeEach(resetStore);

  const sampleNote: NoteItem = {
    id: 'note_1',
    title: 'Transformer Architecture Notes',
    content: '# Key Ideas\n- Self-attention mechanism\n- Positional encoding',
    tags: ['transformer', 'architecture'],
    linkedPaperIds: ['paper_1'],
    linkedNoteIds: [],
    updatedAt: Date.now(),
  };

  it('should add a note and select it', () => {
    const store = useMetisStore.getState();
    store.addNote(sampleNote);
    expect(useMetisStore.getState().notes).toHaveLength(1);
    expect(useMetisStore.getState().selectedNote).toBe('note_1');
  });

  it('should update note content', () => {
    const store = useMetisStore.getState();
    store.addNote(sampleNote);
    store.updateNote('note_1', { content: 'Updated content' });
    expect(useMetisStore.getState().notes[0]?.content).toBe('Updated content');
  });

  it('should update note title', () => {
    const store = useMetisStore.getState();
    store.addNote(sampleNote);
    store.updateNote('note_1', { title: 'New Title' });
    expect(useMetisStore.getState().notes[0]?.title).toBe('New Title');
  });

  it('should select a note', () => {
    const store = useMetisStore.getState();
    store.addNote(sampleNote);
    store.addNote({ ...sampleNote, id: 'note_2' });
    store.selectNote('note_1');
    expect(useMetisStore.getState().selectedNote).toBe('note_1');
  });

  it('should handle selecting null', () => {
    const store = useMetisStore.getState();
    store.addNote(sampleNote);
    store.selectNote(null);
    expect(useMetisStore.getState().selectedNote).toBeNull();
  });
});

// ─── Experiment Tests ────────────────────────────────────────

describe('useMetisStore — Experiments', () => {
  beforeEach(resetStore);

  const sampleExp: ExperimentItem = {
    id: 'exp_1',
    name: 'Transformer Training Run',
    description: 'Training a transformer model on WMT dataset',
    status: 'planned',
    parameters: { lr: '0.0001', batch_size: '32' },
    metrics: { bleu: 0.0 },
    tags: ['nmt', 'transformer'],
    notes: 'First training run',
  };

  it('should add an experiment', () => {
    const store = useMetisStore.getState();
    store.addExperiment(sampleExp);
    expect(useMetisStore.getState().experiments).toHaveLength(1);
  });

  it('should update experiment status to running', () => {
    const store = useMetisStore.getState();
    store.addExperiment(sampleExp);
    store.updateExperimentStatus('exp_1', 'running');
    expect(useMetisStore.getState().experiments[0]?.status).toBe('running');
  });

  it('should update experiment status with metrics', () => {
    const store = useMetisStore.getState();
    store.addExperiment(sampleExp);
    store.updateExperimentStatus('exp_1', 'completed', { bleu: 27.5, loss: 0.03 });
    const exp = useMetisStore.getState().experiments[0]!;
    expect(exp.status).toBe('completed');
    expect(exp.metrics.bleu).toBe(27.5);
    expect(exp.metrics.loss).toBe(0.03);
  });

  it('should preserve existing metrics when updating with partial metrics', () => {
    const store = useMetisStore.getState();
    store.addExperiment({ ...sampleExp, metrics: { bleu: 25.0, rouge: 0.5 } });
    store.updateExperimentStatus('exp_1', 'running', { bleu: 27.5 });
    const exp = useMetisStore.getState().experiments[0]!;
    expect(exp.metrics.bleu).toBe(27.5);
    expect(exp.metrics.rouge).toBe(0.5);
  });
});

// ─── Theme Tests ───────────────────────────────────────────────

describe('useMetisStore — Theme', () => {
  beforeEach(resetStore);

  it('should default to light theme', () => {
    expect(useMetisStore.getState().theme).toBe('light');
  });

  it('should set theme to dark', () => {
    const store = useMetisStore.getState();
    store.setTheme('dark');
    expect(useMetisStore.getState().theme).toBe('dark');
  });

  it('should set theme to light', () => {
    const store = useMetisStore.getState();
    store.setTheme('dark');
    store.setTheme('light');
    expect(useMetisStore.getState().theme).toBe('light');
  });
});

// ─── Hydration Tests ───────────────────────────────────────────

describe('useMetisStore — Hydration', () => {
  beforeEach(resetStore);

  it('should not be hydrated initially', () => {
    expect(useMetisStore.getState().isHydrated).toBe(false);
  });

  it('should hydrate from persistence data', () => {
    const store = useMetisStore.getState();
    store.hydrateFromPersistence({
      papers: [{
        id: 'p1',
        title: 'Hydrated Paper',
        authors: ['Author'],
        year: 2024,
        venue: 'Test',
        abstract: 'Abstract',
        tags: [],
        notes: '',
        readStatus: 'unread',
        rating: 0,
        referenceIds: [],
        addedAt: Date.now(),
      }],
      notes: [{
        id: 'n1',
        title: 'Hydrated Note',
        content: 'Content',
        tags: [],
        linkedPaperIds: [],
        linkedNoteIds: [],
        updatedAt: Date.now(),
      }],
      experiments: [{
        id: 'e1',
        name: 'Hydrated Exp',
        description: 'Desc',
        status: 'planned',
        parameters: {},
        metrics: {},
        tags: [],
        notes: '',
        createdAt: Date.now(),
      }],
    });
    expect(useMetisStore.getState().isHydrated).toBe(true);
    expect(useMetisStore.getState().papers).toHaveLength(1);
    expect(useMetisStore.getState().papers[0]!.title).toBe('Hydrated Paper');
    expect(useMetisStore.getState().notes).toHaveLength(1);
    expect(useMetisStore.getState().experiments).toHaveLength(1);
  });

  it('should hydrate with empty data', () => {
    const store = useMetisStore.getState();
    store.hydrateFromPersistence({ papers: [], notes: [], experiments: [] });
    expect(useMetisStore.getState().isHydrated).toBe(true);
    expect(useMetisStore.getState().papers).toHaveLength(0);
    expect(useMetisStore.getState().notes).toHaveLength(0);
    expect(useMetisStore.getState().experiments).toHaveLength(0);
  });
});

// ─── Locale Tests ──────────────────────────────────────────────

describe('useMetisStore — Locale', () => {
  beforeEach(resetStore);

  it('should default to zh locale', () => {
    expect(useMetisStore.getState().locale).toBe('zh');
  });

  it('should set locale to zh', () => {
    const store = useMetisStore.getState();
    store.setLocale('zh');
    expect(useMetisStore.getState().locale).toBe('zh');
  });
});

// ─── Collection Tests ────────────────────────────────────────

describe('useMetisStore — Collections', () => {
  beforeEach(resetStore);

  const sampleCollection = {
    id: 'col_1',
    name: 'Transformers',
    description: 'Papers about transformers',
    paperIds: [],
    createdAt: Date.now(),
  };

  const sampleCollectionPaper: PaperItem = {
    id: 'paper_col_1',
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Noam Shazeer'],
    year: 2017,
    venue: 'NeurIPS',
    abstract: 'We propose a new simple network architecture, the Transformer.',
    doi: '10.48550/arXiv.1706.03762',
    tags: ['deep-learning', 'transformer', 'attention'],
    notes: 'Foundation of modern NLP',
    readStatus: 'read',
    rating: 5,
    addedAt: Date.now(),
  };

  it('should add a collection', () => {
    const store = useMetisStore.getState();
    store.addCollection(sampleCollection);
    expect(useMetisStore.getState().collections).toHaveLength(1);
    expect(useMetisStore.getState().selectedCollection).toBe('col_1');
  });

  it('should add and remove paper from collection', () => {
    const store = useMetisStore.getState();
    store.addCollection(sampleCollection);
    store.addPaperToCollection('col_1', 'paper_1');
    expect(useMetisStore.getState().collections[0]?.paperIds).toContain('paper_1');
    store.removePaperFromCollection('col_1', 'paper_1');
    expect(useMetisStore.getState().collections[0]?.paperIds).not.toContain('paper_1');
  });

  it('should filter papers by collection', () => {
    const store = useMetisStore.getState();
    store.addPaper(sampleCollectionPaper);
    store.addCollection({ ...sampleCollection, paperIds: [sampleCollectionPaper.id] });
    store.setPaperFilter({ collectionId: 'col_1' });
    const filtered = filterPapers(useMetisStore.getState().papers, useMetisStore.getState().paperFilter, useMetisStore.getState().collections);
    expect(filtered).toHaveLength(1);
  });
});
