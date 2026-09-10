/**
 * Tests for PersistenceStore duplicate paper detection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PersistenceStore, setSharedStore } from './PersistenceStore.js';
import {
  findLibraryDuplicatesHandler,
  deleteLibraryDuplicatesHandler,
  libraryStatsHandler,
  exportLibraryHandler,
  importPapersHandler,
  experimentStatsHandler,
  experimentCompareHandler,
  experimentExportHandler,
  collectionStatsHandler,
  noteStatsHandler,
  tagsAuditHandler,
  tagsMergeHandler,
  citationNetworkHandler,
  literatureTriageHandler,
  interestProfileHandler,
  rankCandidatesHandler,
  fulltextSearchHandler,
} from '../tools/builtin/academic-tools.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-persistence-test-'));
}

function basePaper(overrides: Partial<Parameters<PersistenceStore['savePaper']>[0]> = {}) {
  return {
    id: `paper-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'],
    year: 2017,
    venue: 'NeurIPS',
    abstract: 'We propose a new simple network architecture...',
    doi: undefined,
    arxivId: undefined,
    tags: ['nlp'],
    notes: '',
    readStatus: 'unread',
    rating: 0,
    addedAt: Date.now(),
    ...overrides,
  };
}

describe('PersistenceStore.findDuplicatePapers', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns an empty array when the library is empty', () => {
    expect(store.findDuplicatePapers()).toEqual([]);
  });

  it('returns an empty array when there are no duplicates', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Paper A', doi: '10.1/a', arxivId: 'a' }));
    store.savePaper(basePaper({ id: 'b', title: 'Paper B', doi: '10.1/b', arxivId: 'b' }));
    expect(store.findDuplicatePapers()).toEqual([]);
  });

  it('detects duplicates by DOI', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Paper A', doi: '10.1/dup' }));
    store.savePaper(basePaper({ id: 'b', title: 'Paper B', doi: '10.1/dup' }));
    const groups = store.findDuplicatePapers();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.type).toBe('doi');
    expect(groups[0]!.key).toBe('10.1/dup');
    expect(groups[0]!.papers.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('detects duplicates by arXiv ID', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Paper A', doi: '10.1/a', arxivId: '2301.00001' }));
    store.savePaper(basePaper({ id: 'b', title: 'Paper B', doi: '10.1/b', arxivId: '2301.00001' }));
    const groups = store.findDuplicatePapers();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.type).toBe('arxiv');
    expect(groups[0]!.key).toBe('2301.00001');
  });

  it('detects duplicates by normalized title', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Transformers in Medical Imaging', doi: '10.1/a' }));
    store.savePaper(basePaper({ id: 'b', title: 'Transformers in Medical Imaging!', doi: '10.1/b' }));
    const groups = store.findDuplicatePapers();
    expect(groups.length).toBeGreaterThanOrEqual(1);
    const titleGroup = groups.find((g) => g.type === 'title');
    expect(titleGroup).toBeDefined();
    expect(titleGroup!.papers.map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('ignores short normalized titles', () => {
    store.savePaper(basePaper({ id: 'a', title: 'AI', doi: '10.1/a' }));
    store.savePaper(basePaper({ id: 'b', title: 'AI!', doi: '10.1/b' }));
    expect(store.findDuplicatePapers()).toEqual([]);
  });

  it('returns multiple independent groups', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', doi: '10.1/dup', arxivId: 'a' }));
    store.savePaper(basePaper({ id: 'b', title: 'Beta', doi: '10.1/dup', arxivId: 'b' }));
    store.savePaper(basePaper({ id: 'c', title: 'Gamma', doi: '10.1/c', arxivId: 'c' }));
    const groups = store.findDuplicatePapers();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.type).toBe('doi');
    expect(groups[0]!.papers).toHaveLength(2);
  });
});

describe('findLibraryDuplicatesHandler', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
    setSharedStore(store);
  });

  afterEach(() => {
    setSharedStore(null as unknown as PersistenceStore);
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('reports no duplicates when library is empty', async () => {
    const result = await findLibraryDuplicatesHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    const r = JSON.parse(result);
    expect(r.totalGroups).toBe(0);
    expect(r.groups).toEqual([]);
  });

  it('reports duplicate groups in JSON', async () => {
    store.savePaper(basePaper({ id: 'a', title: 'Paper A Unique Title One', doi: '10.1/dup' }));
    store.savePaper(basePaper({ id: 'b', title: 'Paper B Unique Title Two', doi: '10.1/dup' }));
    const result = await findLibraryDuplicatesHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    const r = JSON.parse(result);
    expect(r.totalGroups).toBe(1);
    expect(r.groups[0].type).toBe('doi');
    expect(r.groups[0].key).toBe('10.1/dup');
    expect(r.groups[0].papers.map((p: {id: string}) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('returns an error when shared store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const result = await findLibraryDuplicatesHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('not initialized');
  });
});

describe('PersistenceStore.deleteDuplicatePapers', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns an empty array when there are no duplicates', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Paper A', doi: '10.1/a' }));
    store.savePaper(basePaper({ id: 'b', title: 'Paper B', doi: '10.1/b' }));
    expect(store.deleteDuplicatePapers()).toEqual([]);
  });

  it('keeps the most complete paper and deletes the rest', () => {
    store.savePaper(basePaper({
      id: 'a',
      title: 'Title A',
      doi: '10.1/dup',
      abstract: '',
      citationCount: 0,
      pdfText: '',
    }));
    store.savePaper(basePaper({
      id: 'b',
      title: 'Title B',
      doi: '10.1/dup',
      abstract: 'Rich abstract here.',
      citationCount: 50,
      pdfText: 'Long pdf text content that is definitely longer than one hundred characters.',
    }));

    const result = store.deleteDuplicatePapers();
    expect(result).toHaveLength(1);
    expect(result[0]!.keptId).toBe('b');
    expect(result[0]!.deletedIds.sort()).toEqual(['a']);
    expect(store.getPapers().map((p) => p.id)).toEqual(['b']);
  });

  it('respects keepId when provided', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Same Title', doi: '10.1/dup', citationCount: 100 }));
    store.savePaper(basePaper({ id: 'b', title: 'Same Title', doi: '10.1/dup', citationCount: 0 }));

    const result = store.deleteDuplicatePapers('b');
    expect(result[0]!.keptId).toBe('b');
    expect(result[0]!.deletedIds).toEqual(['a']);
    expect(store.getPapers().map((p) => p.id)).toEqual(['b']);
  });

  it('handles multiple duplicate groups', () => {
    store.savePaper(basePaper({ id: 'a1', title: 'Alpha', doi: '10.1/dup1' }));
    store.savePaper(basePaper({ id: 'a2', title: 'Alpha', doi: '10.1/dup1' }));
    store.savePaper(basePaper({ id: 'b1', title: 'Beta', doi: '10.1/dup2' }));
    store.savePaper(basePaper({ id: 'b2', title: 'Beta', doi: '10.1/dup2' }));

    const result = store.deleteDuplicatePapers();
    expect(result).toHaveLength(2);
    expect(store.getPapers()).toHaveLength(2);
  });
});

describe('deleteLibraryDuplicatesHandler', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
    setSharedStore(store);
  });

  afterEach(() => {
    setSharedStore(null as unknown as PersistenceStore);
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('reports no duplicates when library has none', async () => {
    store.savePaper(basePaper({ id: 'a', title: 'Paper A', doi: '10.1/a' }));
    const result = await deleteLibraryDuplicatesHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('No duplicate papers found');
  });

  it('deletes duplicates and reports kept/deleted IDs', async () => {
    store.savePaper(basePaper({ id: 'a', title: 'Same Title', doi: '10.1/dup' }));
    store.savePaper(basePaper({ id: 'b', title: 'Same Title', doi: '10.1/dup' }));

    const result = await deleteLibraryDuplicatesHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('Local Library Duplicate Cleanup');
    expect(result).toContain('Kept:');
    expect(result).toContain('Deleted:');
    expect(store.getPapers()).toHaveLength(1);
  });

  it('supports dryRun without deleting anything', async () => {
    store.savePaper(basePaper({ id: 'a', title: 'Same Title', doi: '10.1/dup' }));
    store.savePaper(basePaper({ id: 'b', title: 'Same Title', doi: '10.1/dup' }));

    const result = await deleteLibraryDuplicatesHandler({ dryRun: true }, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('dry run');
    expect(store.getPapers()).toHaveLength(2);
  });

  it('returns an error when shared store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const result = await deleteLibraryDuplicatesHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('not initialized');
  });
});

describe('PersistenceStore.getLibraryStats', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns zeroed stats for an empty library', () => {
    const stats = store.getLibraryStats();
    expect(stats.totalPapers).toBe(0);
    expect(stats.duplicateGroupCount).toBe(0);
    expect(stats.metadataCompleteness).toEqual({
      withDoi: 0,
      withArxivId: 0,
      withPdfText: 0,
      withAbstract: 0,
      withVenue: 0,
    });
  });

  it('counts read status, years, tags, and venues', () => {
    store.savePaper(basePaper({
      id: 'a', title: 'Alpha', year: 2020, readStatus: 'read', rating: 5, tags: ['ml', 'nlp'], venue: 'ICML',
    }));
    store.savePaper(basePaper({
      id: 'b', title: 'Beta', year: 2021, readStatus: 'unread', rating: 0, tags: ['nlp'], venue: 'NeurIPS',
    }));
    store.savePaper(basePaper({
      id: 'c', title: 'Gamma', year: 2020, readStatus: 'read', rating: 4, tags: ['vision'], venue: 'ICML',
    }));

    const stats = store.getLibraryStats();
    expect(stats.totalPapers).toBe(3);
    expect(stats.readStatusCounts).toEqual({ read: 2, unread: 1 });
    expect(stats.yearDistribution).toEqual({ 2020: 2, 2021: 1 });
    expect(stats.tagDistribution).toEqual({ nlp: 2, ml: 1, vision: 1 });
    expect(stats.venueTopN).toEqual([
      { venue: 'ICML', count: 2 },
      { venue: 'NeurIPS', count: 1 },
    ]);
  });

  it('tracks metadata completeness', () => {
    store.savePaper(basePaper({
      id: 'a', title: 'Complete', doi: '10.1/a', arxivId: '1234.56789', pdfText: 'long pdf text content that is definitely longer than fifty characters', abstract: 'Abstract', venue: 'Venue',
    }));
    store.savePaper(basePaper({
      id: 'b', title: 'Sparse', doi: undefined, arxivId: undefined, pdfText: '', abstract: '', venue: '',
    }));

    const stats = store.getLibraryStats();
    expect(stats.metadataCompleteness).toEqual({
      withDoi: 1,
      withArxivId: 1,
      withPdfText: 1,
      withAbstract: 1,
      withVenue: 1,
    });
  });

  it('reports duplicate groups count', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Same', doi: '10.1/dup' }));
    store.savePaper(basePaper({ id: 'b', title: 'Same', doi: '10.1/dup' }));
    expect(store.getLibraryStats().duplicateGroupCount).toBe(1);
  });
});

describe('libraryStatsHandler', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
    setSharedStore(store);
  });

  afterEach(() => {
    setSharedStore(null as unknown as PersistenceStore);
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns a human-readable report for an empty library', async () => {
    const result = await libraryStatsHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('Local Library Statistics');
    expect(result).toContain('Total papers: 0');
    expect(result).toContain('Duplicate groups: 0');
  });

  it('includes metadata completeness and top venues', async () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', venue: 'ICML', doi: '10.1/a' }));
    store.savePaper(basePaper({ id: 'b', title: 'Beta', venue: 'ICML' }));

    const result = await libraryStatsHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('Total papers: 2');
    expect(result).toContain('ICML: 2');
    expect(result).toContain('With DOI: 1');
  });

  it('returns an error when shared store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const result = await libraryStatsHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('not initialized');
  });
});

describe('PersistenceStore.exportPapers', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('exports all papers as JSON', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha' }));
    const result = store.exportPapers('json');
    expect(result.count).toBe(1);
    expect(JSON.parse(result.content)[0].id).toBe('a');
  });

  it('exports selected papers only', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha' }));
    store.savePaper(basePaper({ id: 'b', title: 'Beta' }));
    const result = store.exportPapers('json', ['b']);
    expect(result.count).toBe(1);
    expect(JSON.parse(result.content)[0].id).toBe('b');
  });

  it('generates valid BibTeX entries', () => {
    store.savePaper(basePaper({
      id: 'a',
      title: 'Alpha & Beta: A Study of $x$',
      authors: ['Alice Smith', 'Bob Jones'],
      year: 2024,
      venue: 'NeurIPS',
      doi: '10.1234/alpha',
      arxivId: '2401.00001',
      tags: ['ml', 'nlp'],
      abstract: 'We study alpha.',
    }));

    const result = store.exportPapers('bibtex');
    expect(result.count).toBe(1);
    expect(result.content).toContain('@article{smith2024,');
    expect(result.content).toContain('title = {Alpha \\& Beta: A Study of \\$x\\$},');
    expect(result.content).toContain('author = {Alice Smith and Bob Jones},');
    expect(result.content).toContain('year = {2024},');
    expect(result.content).toContain('journal = {NeurIPS},');
    expect(result.content).toContain('doi = {10.1234/alpha},');
    expect(result.content).toContain('eprint = {2401.00001},');
    expect(result.content).toContain('archiveprefix = {arXiv},');
    expect(result.content).toContain('keywords = {ml, nlp},');
  });

  it('deduplicates BibTeX keys', () => {
    store.savePaper(basePaper({ id: 'a', title: 'One', authors: ['Alice Smith'], year: 2024 }));
    store.savePaper(basePaper({ id: 'b', title: 'Two', authors: ['Alice Smith'], year: 2024 }));
    const result = store.exportPapers('bibtex');
    expect(result.count).toBe(2);
    expect(result.content).toContain('@article{smith2024,');
    expect(result.content).toContain('@article{smith2024_1,');
  });
});

describe('exportLibraryHandler', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
    setSharedStore(store);
  });

  afterEach(() => {
    setSharedStore(null as unknown as PersistenceStore);
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns bibtex content inline', async () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', authors: ['Alice Smith'], year: 2024 }));
    const result = await exportLibraryHandler({ format: 'bibtex' }, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('@article{');
    expect(result).toContain('Alpha');
  });

  it('writes to a file when filePath is provided', async () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha' }));
    const outPath = path.join(dataDir, 'lib.json');
    const result = await exportLibraryHandler({ format: 'json', filePath: outPath }, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain(outPath);
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it('rejects invalid format', async () => {
    const result = await exportLibraryHandler({ format: 'csv' }, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('format must be');
  });

  it('returns an error when shared store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const result = await exportLibraryHandler({ format: 'json' }, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('not initialized');
  });
});

describe('PersistenceStore.importPapers', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('imports new papers and skips duplicates by DOI', () => {
    store.savePaper(basePaper({ id: 'existing', title: 'Existing', doi: '10.1/existing' }));

    const result = store.importPapers([
      { title: 'Existing', authors: ['A'], year: 2024, doi: '10.1/existing' },
      { title: 'New Paper', authors: ['B'], year: 2024, doi: '10.1/new' },
    ]);

    expect(result.total).toBe(2);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(store.getPapers()).toHaveLength(2);
  });

  it('skips duplicates by normalized title', () => {
    store.savePaper(basePaper({ id: 'existing', title: 'Same Title!' }));

    const result = store.importPapers([
      { title: 'Same Title?', authors: ['A'], year: 2024 },
      { title: 'Different Title', authors: ['B'], year: 2024 },
    ]);

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('imports papers with all metadata fields', () => {
    const result = store.importPapers([{
      title: 'Full Paper',
      authors: ['Alice Smith', 'Bob Jones'],
      year: 2023,
      venue: 'ICML',
      abstract: 'Abstract text.',
      doi: '10.1/full',
      arxivId: '2301.00001',
      pdfUrl: 'https://example.com/full.pdf',
      tags: ['ml'],
    }]);

    expect(result.imported).toBe(1);
    const paper = store.getPapers()[0]!;
    expect(paper.title).toBe('Full Paper');
    expect(paper.authors).toEqual(['Alice Smith', 'Bob Jones']);
    expect(paper.year).toBe(2023);
    expect(paper.venue).toBe('ICML');
    expect(paper.doi).toBe('10.1/full');
    expect(paper.arxivId).toBe('2301.00001');
    expect(paper.pdfUrl).toBe('https://example.com/full.pdf');
    expect(paper.tags).toEqual(['ml']);
    expect(paper.readStatus).toBe('unread');
  });
});

describe('importPapersHandler', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
    setSharedStore(store);
  });

  afterEach(() => {
    setSharedStore(null as unknown as PersistenceStore);
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('imports from a BibTeX string', async () => {
    const bibtex = `@article{smith2024,
  title = {Alpha Beta},
  author = {Alice Smith and Bob Jones},
  year = {2024},
  journal = {NeurIPS},
  doi = {10.1/alpha}
}`;
    const result = await importPapersHandler({ source: 'bibtex', bibtex }, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    const r = JSON.parse(result); expect(r.imported).toBe(1);
    expect(store.getPapers()).toHaveLength(1);
    expect(store.getPapers()[0]!.title).toBe('Alpha Beta');
  });

  it('imports from a JSON file', async () => {
    const jsonPath = path.join(dataDir, 'papers.json');
    fs.writeFileSync(jsonPath, JSON.stringify([
      { title: 'JSON Paper', authors: ['A'], year: 2024, doi: '10.1/json' },
    ]));

    const result = await importPapersHandler({ source: 'json', filePath: jsonPath }, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    const r = JSON.parse(result); expect(r.imported).toBe(1);
    expect(store.getPapers()[0]!.doi).toBe('10.1/json');
  });

  it('applies shared tags', async () => {
    const bibtex = `@article{a,
  title = {T},
  author = {A},
  year = {2024}
}`;
    const result = await importPapersHandler({ source: 'bibtex', bibtex, tags: ['seed'] }, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    const r = JSON.parse(result); expect(r.imported).toBe(1);
    expect(store.getPapers()[0]!.tags).toContain('seed');
  });

  it('rejects invalid source', async () => {
    const result = await importPapersHandler({ source: 'csv' }, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('source must be');
  });

  it('returns an error when shared store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const result = await importPapersHandler({ source: 'json', bibtex: '[]' }, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('not initialized');
  });
});

describe('PersistenceStore.getExperimentStats', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns zeroed stats for no experiments', () => {
    const stats = store.getExperimentStats();
    expect(stats.totalExperiments).toBe(0);
    expect(stats.withScript).toBe(0);
    expect(stats.metricKeys).toEqual([]);
  });

  it('counts status, script coverage, tags, and metrics', () => {
    store.saveExperiment({
      id: 'a', name: 'Exp A', description: '', status: 'completed',
      parameters: {}, metrics: { accuracy: 0.9, loss: 0.1 }, tags: ['ml', 'vision'],
      notes: '', linkedPaperIds: [], scriptPath: '/tmp/a.py', createdAt: Date.now() - 1000,
    });
    store.saveExperiment({
      id: 'b', name: 'Exp B', description: '', status: 'running',
      parameters: {}, metrics: { accuracy: 0.85 }, tags: ['ml'],
      notes: '', linkedPaperIds: [], createdAt: Date.now(),
    });

    const stats = store.getExperimentStats();
    expect(stats.totalExperiments).toBe(2);
    expect(stats.statusCounts).toEqual({ completed: 1, running: 1 });
    expect(stats.withScript).toBe(1);
    expect(stats.withoutScript).toBe(1);
    expect(stats.tagDistribution).toEqual({ ml: 2, vision: 1 });
    expect(stats.metricKeys).toEqual(['accuracy', 'loss']);
    expect(stats.recentlyUpdated[0]!.id).toBe('b');
  });
});

describe('experimentStatsHandler', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
    setSharedStore(store);
  });

  afterEach(() => {
    setSharedStore(null as unknown as PersistenceStore);
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns a human-readable report', async () => {
    store.saveExperiment({
      id: 'a', name: 'Exp A', description: '', status: 'completed',
      parameters: {}, metrics: { accuracy: 0.9 }, tags: ['ml'],
      notes: '', linkedPaperIds: [], createdAt: Date.now(),
    });

    const result = await experimentStatsHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('Experiment Statistics');
    expect(result).toContain('Total experiments: 1');
    expect(result).toContain('accuracy');
    expect(result).toContain('ml: 1');
  });

  it('returns an error when shared store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const result = await experimentStatsHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('not initialized');
  });
});

describe('PersistenceStore.compareExperiments', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns empty results when no IDs match', () => {
    const result = store.compareExperiments(['missing']);
    expect(result.experiments).toEqual([]);
    expect(result.parameterKeys).toEqual([]);
  });

  it('detects varying parameters and metrics', () => {
    store.saveExperiment({
      id: 'a', name: 'Exp A', description: '', status: 'completed',
      parameters: { lr: '0.01', batch: '32' }, metrics: { accuracy: 0.9, loss: 0.1 },
      tags: [], notes: '', linkedPaperIds: [], createdAt: Date.now() - 1000,
    });
    store.saveExperiment({
      id: 'b', name: 'Exp B', description: '', status: 'completed',
      parameters: { lr: '0.001', batch: '32' }, metrics: { accuracy: 0.85, loss: 0.15 },
      tags: [], notes: '', linkedPaperIds: [], createdAt: Date.now(),
    });

    const result = store.compareExperiments(['a', 'b']);
    expect(result.experiments).toHaveLength(2);
    expect(result.varyingParameters).toEqual(['lr']);
    expect(result.varyingMetrics).toEqual(['accuracy', 'loss']);
    expect(result.parameterKeys).toEqual(['batch', 'lr']);
    expect(result.metricKeys).toEqual(['accuracy', 'loss']);
  });
});

describe('experimentCompareHandler', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
    setSharedStore(store);
  });

  afterEach(() => {
    setSharedStore(null as unknown as PersistenceStore);
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('requires at least two experiment IDs', async () => {
    const result = await experimentCompareHandler({ experimentIds: ['a'] }, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('at least two');
  });

  it('compares two experiments', async () => {
    store.saveExperiment({
      id: 'a', name: 'Exp A', description: '', status: 'completed',
      parameters: { lr: '0.01' }, metrics: { accuracy: 0.9 },
      tags: [], notes: '', linkedPaperIds: [], createdAt: Date.now(),
    });
    store.saveExperiment({
      id: 'b', name: 'Exp B', description: '', status: 'completed',
      parameters: { lr: '0.001' }, metrics: { accuracy: 0.85 },
      tags: [], notes: '', linkedPaperIds: [], createdAt: Date.now(),
    });

    const result = await experimentCompareHandler({ experimentIds: ['a', 'b'] }, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('Experiment Comparison');
    expect(result).toContain('Varying parameters');
    expect(result).toContain('lr');
    expect(result).toContain('accuracy');
  });

  it('returns an error when shared store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const result = await experimentCompareHandler({ experimentIds: ['a', 'b'] }, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('not initialized');
  });
});

describe('PersistenceStore.exportExperiments', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('exports all experiments as JSON', () => {
    store.saveExperiment({
      id: 'a', name: 'Exp A', description: '', status: 'completed',
      parameters: {}, metrics: {}, tags: [], notes: '', linkedPaperIds: [], createdAt: Date.now(),
    });
    const result = store.exportExperiments();
    expect(result.count).toBe(1);
    expect(JSON.parse(result.content)[0].id).toBe('a');
  });

  it('exports selected experiments only', () => {
    store.saveExperiment({
      id: 'a', name: 'Exp A', description: '', status: 'completed',
      parameters: {}, metrics: {}, tags: [], notes: '', linkedPaperIds: [], createdAt: Date.now(),
    });
    store.saveExperiment({
      id: 'b', name: 'Exp B', description: '', status: 'completed',
      parameters: {}, metrics: {}, tags: [], notes: '', linkedPaperIds: [], createdAt: Date.now(),
    });
    const result = store.exportExperiments(['b']);
    expect(result.count).toBe(1);
    expect(JSON.parse(result.content)[0].id).toBe('b');
  });
});

describe('experimentExportHandler', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
    setSharedStore(store);
  });

  afterEach(() => {
    setSharedStore(null as unknown as PersistenceStore);
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns JSON content inline', async () => {
    store.saveExperiment({
      id: 'a', name: 'Exp A', description: '', status: 'completed',
      parameters: {}, metrics: {}, tags: [], notes: '', linkedPaperIds: [], createdAt: Date.now(),
    });
    const result = await experimentExportHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('Experiment Export');
    expect(result).toContain('"id": "a"');
  });

  it('writes to a file when filePath is provided', async () => {
    store.saveExperiment({
      id: 'a', name: 'Exp A', description: '', status: 'completed',
      parameters: {}, metrics: {}, tags: [], notes: '', linkedPaperIds: [], createdAt: Date.now(),
    });
    const outPath = path.join(dataDir, 'experiments.json');
    const result = await experimentExportHandler({ filePath: outPath }, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain(outPath);
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it('returns an error when shared store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const result = await experimentExportHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('not initialized');
  });
});

describe('PersistenceStore.getCollectionStats', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns zeroed stats for no collections', () => {
    const stats = store.getCollectionStats();
    expect(stats.totalCollections).toBe(0);
    expect(stats.totalPapersInCollections).toBe(0);
    expect(stats.emptyCollections).toBe(0);
  });

  it('counts papers per collection and ignores missing paper IDs', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha' }));
    store.savePaper(basePaper({ id: 'b', title: 'Beta' }));
    store.saveCollection({ id: 'c1', name: 'Reading List', description: '', paperIds: ['a', 'b', 'missing'], createdAt: Date.now() });
    store.saveCollection({ id: 'c2', name: 'Empty', description: '', paperIds: [], createdAt: Date.now() });

    const stats = store.getCollectionStats();
    expect(stats.totalCollections).toBe(2);
    expect(stats.totalPapersInCollections).toBe(2);
    expect(stats.emptyCollections).toBe(1);

    const readingList = stats.collections.find((c) => c.id === 'c1');
    expect(readingList?.paperCount).toBe(2);
    expect(readingList?.paperIds).toEqual(['a', 'b']);
  });
});

describe('collectionStatsHandler', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
    setSharedStore(store);
  });

  afterEach(() => {
    setSharedStore(null as unknown as PersistenceStore);
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns a human-readable report', async () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha' }));
    store.saveCollection({ id: 'c1', name: 'Reading List', description: '', paperIds: ['a'], createdAt: Date.now() });

    const result = await collectionStatsHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('Collection Statistics');
    expect(result).toContain('Reading List (1 papers)');
  });

  it('returns an error when shared store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const result = await collectionStatsHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('not initialized');
  });
});

describe('PersistenceStore.getNoteStats', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns zeroed stats for no notes', () => {
    const stats = store.getNoteStats();
    expect(stats.totalNotes).toBe(0);
    expect(stats.orphanNotes).toBe(0);
  });

  it('counts links and orphan notes', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha' }));
    store.saveNote({
      id: 'n1', title: 'Note One', content: '', tags: ['idea'],
      linkedPaperIds: ['a'], linkedNoteIds: [], updatedAt: Date.now() - 1000,
    });
    store.saveNote({
      id: 'n2', title: 'Note Two', content: '', tags: ['idea', 'todo'],
      linkedPaperIds: ['missing'], linkedNoteIds: ['n1'], updatedAt: Date.now(),
    });
    store.saveNote({
      id: 'n3', title: 'Orphan', content: '', tags: [],
      linkedPaperIds: [], linkedNoteIds: [], updatedAt: Date.now() - 2000,
    });

    const stats = store.getNoteStats();
    expect(stats.totalNotes).toBe(3);
    expect(stats.totalLinkedPapers).toBe(1);
    expect(stats.totalLinkedNotes).toBe(1);
    expect(stats.orphanNotes).toBe(1);
    expect(stats.tagDistribution).toEqual({ idea: 2, todo: 1 });
    expect(stats.recentlyUpdated[0]!.id).toBe('n2');
  });
});

describe('noteStatsHandler', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
    setSharedStore(store);
  });

  afterEach(() => {
    setSharedStore(null as unknown as PersistenceStore);
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns a human-readable report', async () => {
    store.saveNote({
      id: 'n1', title: 'Note One', content: '', tags: ['idea'],
      linkedPaperIds: [], linkedNoteIds: [], updatedAt: Date.now(),
    });

    const result = await noteStatsHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('Note Statistics');
    expect(result).toContain('Total notes: 1');
    expect(result).toContain('idea: 1');
  });

  it('returns an error when shared store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const result = await noteStatsHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('not initialized');
  });
});

describe('PersistenceStore.auditTags', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns zeroed stats when no tags exist', () => {
    const audit = store.auditTags();
    expect(audit.totalUniqueTags).toBe(0);
    expect(audit.emptyTags).toBe(0);
    expect(audit.caseConflicts).toEqual([]);
    expect(audit.similarTags).toEqual([]);
    expect(audit.tagsByType).toEqual({ papers: {}, notes: {}, experiments: {} });
  });

  it('counts tags across papers, notes, and experiments', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', tags: ['nlp', 'transformer'] }));
    store.saveNote({
      id: 'n1', title: 'Note', content: '', tags: ['nlp', 'idea'],
      linkedPaperIds: [], linkedNoteIds: [], updatedAt: Date.now(),
    });
    store.saveExperiment({
      id: 'e1', name: 'Exp', description: '', status: 'planned',
      parameters: {}, metrics: {}, tags: ['transformer', 'benchmark'], notes: '',
      linkedPaperIds: [], createdAt: Date.now(),
    });

    const audit = store.auditTags();
    expect(audit.totalUniqueTags).toBe(4);
    expect(audit.tagCounts).toEqual({
      nlp: 2, transformer: 2, idea: 1, benchmark: 1,
    });
    expect(audit.tagsByType.papers).toEqual({ nlp: 1, transformer: 1 });
    expect(audit.tagsByType.notes).toEqual({ nlp: 1, idea: 1 });
    expect(audit.tagsByType.experiments).toEqual({ transformer: 1, benchmark: 1 });
  });

  it('detects case conflicts', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', tags: ['NLP', 'nlp'] }));

    const audit = store.auditTags();
    expect(audit.caseConflicts).toHaveLength(1);
    expect(audit.caseConflicts[0]!).toEqual({ canonical: 'nlp', variants: ['NLP', 'nlp'] });
  });

  it('detects similar tags ignoring separators', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', tags: ['machine-learning', 'machine_learning'] }));

    const audit = store.auditTags();
    expect(audit.similarTags).toHaveLength(1);
    expect(audit.similarTags[0]!).toMatchObject({
      tagA: 'machine-learning', tagB: 'machine_learning', reason: 'Same letters ignoring separators',
    });
  });

  it('detects similar tags by single-character edit distance', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', tags: ['attention', 'attentions'] }));

    const audit = store.auditTags();
    expect(audit.similarTags).toHaveLength(1);
    expect(audit.similarTags[0]!).toMatchObject({
      tagA: 'attention', tagB: 'attentions', reason: 'Single-character edit distance',
    });
  });

  it('counts empty tags', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', tags: ['valid', ''] }));

    const audit = store.auditTags();
    expect(audit.emptyTags).toBe(1);
    expect(audit.tagCounts).toEqual({ valid: 1 });
  });
});

describe('tagsAuditHandler', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
    setSharedStore(store);
  });

  afterEach(() => {
    setSharedStore(null as unknown as PersistenceStore);
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns a human-readable audit report', async () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', tags: ['NLP', 'nlp', 'attention', 'attentions'] }));

    const result = await tagsAuditHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('# Tags Audit');
    expect(result).toContain('Unique tags: 4');
    expect(result).toContain('Empty tag occurrences: 0');
    expect(result).toContain('## Case conflicts');
    expect(result).toContain('nlp: NLP, nlp');
    expect(result).toContain('## Similar tags');
    expect(result).toContain('"attention" vs "attentions"');
  });

  it('returns an error when shared store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const result = await tagsAuditHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('not initialized');
  });
});

describe('PersistenceStore.mergeTags', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns zero changes when mapping is empty', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', tags: ['nlp'] }));
    const result = store.mergeTags({});
    expect(result.merged).toBe(0);
    expect(store.getPapers()[0]!.tags).toEqual(['nlp']);
  });

  it('renames a tag across papers, notes, and experiments', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', tags: ['ml'] }));
    store.saveNote({
      id: 'n1', title: 'Note', content: '', tags: ['ml', 'idea'],
      linkedPaperIds: [], linkedNoteIds: [], updatedAt: Date.now(),
    });
    store.saveExperiment({
      id: 'e1', name: 'Exp', description: '', status: 'planned',
      parameters: {}, metrics: {}, tags: ['ml'], notes: '',
      linkedPaperIds: [], createdAt: Date.now(),
    });

    const result = store.mergeTags({ ml: 'machine-learning' });
    expect(result.merged).toBe(3);
    expect(result.papersUpdated).toBe(1);
    expect(result.notesUpdated).toBe(1);
    expect(result.experimentsUpdated).toBe(1);
    expect(store.getPapers()[0]!.tags).toEqual(['machine-learning']);
    expect(store.getNotes()[0]!.tags).toEqual(['machine-learning', 'idea']);
    expect(store.getExperiments()[0]!.tags).toEqual(['machine-learning']);
  });

  it('removes source tag when target already exists', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', tags: ['NLP', 'nlp'] }));

    const result = store.mergeTags({ NLP: 'nlp' });
    expect(result.merged).toBe(1);
    expect(store.getPapers()[0]!.tags).toEqual(['nlp']);
  });

  it('supports batch mappings', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', tags: ['ai', 'ml'] }));

    const result = store.mergeTags({ ai: 'artificial-intelligence', ml: 'machine-learning' });
    expect(result.merged).toBe(1);
    expect(store.getPapers()[0]!.tags).toEqual(['artificial-intelligence', 'machine-learning']);
  });

  it('dryRun does not persist changes', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', tags: ['old'] }));

    const result = store.mergeTags({ old: 'new' }, true);
    expect(result.merged).toBe(1);
    expect(store.getPapers()[0]!.tags).toEqual(['old']);
  });

  it('ignores mappings where source equals target or is empty', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', tags: ['nlp'] }));

    const result = store.mergeTags({ nlp: 'nlp', '': 'empty' });
    expect(result.merged).toBe(0);
    expect(store.getPapers()[0]!.tags).toEqual(['nlp']);
  });
});

describe('tagsMergeHandler', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
    setSharedStore(store);
  });

  afterEach(() => {
    setSharedStore(null as unknown as PersistenceStore);
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('merges a single tag pair', async () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', tags: ['ml'] }));

    const result = await tagsMergeHandler(
      { sourceTag: 'ml', targetTag: 'machine-learning' },
      { sessionId: 'test', workspace: '.', turnIndex: 0 },
    );
    expect(result).toContain('# Tags Merge Report');
    expect(result).toContain('Entities updated: 1');
    expect(result).toContain('"ml" -> "machine-learning"');
    expect(store.getPapers()[0]!.tags).toEqual(['machine-learning']);
  });

  it('supports batch mappings with dryRun', async () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', tags: ['ai', 'ml'] }));

    const result = await tagsMergeHandler(
      {
        mappings: [
          { sourceTag: 'ai', targetTag: 'artificial-intelligence' },
          { sourceTag: 'ml', targetTag: 'machine-learning' },
        ],
        dryRun: true,
      },
      { sessionId: 'test', workspace: '.', turnIndex: 0 },
    );
    expect(result).toContain('Mode: dry run');
    expect(result).toContain('Entities updated: 1');
    expect(store.getPapers()[0]!.tags).toEqual(['ai', 'ml']);
  });

  it('returns an error when sourceTag is missing', async () => {
    const result = await tagsMergeHandler(
      { targetTag: 'machine-learning' },
      { sessionId: 'test', workspace: '.', turnIndex: 0 },
    );
    expect(result).toContain('Error: sourceTag is required');
  });

  it('returns an error when shared store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const result = await tagsMergeHandler(
      { sourceTag: 'ml', targetTag: 'machine-learning' },
      { sessionId: 'test', workspace: '.', turnIndex: 0 },
    );
    expect(result).toContain('not initialized');
  });
});

describe('PersistenceStore.getLocalPaperNetwork', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns empty network for no papers', () => {
    const network = store.getLocalPaperNetwork();
    expect(network.nodeCount).toBe(0);
    expect(network.edgeCount).toBe(0);
    expect(network.components).toEqual([]);
  });

  it('connects papers by shared tags', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', authors: ['Alice'], tags: ['nlp'] }));
    store.savePaper(basePaper({ id: 'b', title: 'Beta', authors: ['Bob'], tags: ['nlp'] }));
    store.savePaper(basePaper({ id: 'c', title: 'Gamma', authors: ['Carol'], tags: ['vision'] }));

    const network = store.getLocalPaperNetwork();
    expect(network.nodeCount).toBe(3);
    expect(network.edgeCount).toBe(1);
    const edge = network.edges[0]!;
    expect([edge.source, edge.target].sort()).toEqual(['a', 'b']);
    expect(edge.weight).toBe(1);
    expect(network.isolatedNodes).toEqual(['c']);
    expect(network.components).toHaveLength(2);
    expect(network.components[0]!.size).toBe(2);
  });

  it('connects papers by shared authors', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', authors: ['Alice'], tags: [] }));
    store.savePaper(basePaper({ id: 'b', title: 'Beta', authors: ['Alice'], tags: [] }));

    const network = store.getLocalPaperNetwork({ includeSharedTags: false, includeSharedAuthors: true });
    expect(network.edgeCount).toBe(1);
    expect(network.edges[0]!.reasons[0]).toContain('shared authors');
  });

  it('connects papers by collection co-occurrence', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', tags: [] }));
    store.savePaper(basePaper({ id: 'b', title: 'Beta', tags: [] }));
    store.saveCollection({ id: 'c1', name: 'Reading', description: '', paperIds: ['a', 'b'], createdAt: Date.now() });

    const network = store.getLocalPaperNetwork({ includeSharedTags: false, includeSharedAuthors: false });
    expect(network.edgeCount).toBe(1);
    expect(network.edges[0]!.reasons[0]).toContain('shared collections');
  });

  it('respects minWeight threshold', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', authors: ['Alice'], tags: ['nlp'] }));
    store.savePaper(basePaper({ id: 'b', title: 'Beta', authors: ['Bob'], tags: ['nlp'] }));

    const network = store.getLocalPaperNetwork({ minWeight: 2 });
    expect(network.edgeCount).toBe(0);
  });

  it('ranks top nodes by weighted degree', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', authors: ['Alice'], tags: ['nlp', 'ml'] }));
    store.savePaper(basePaper({ id: 'b', title: 'Beta', authors: ['Bob'], tags: ['nlp'] }));
    store.savePaper(basePaper({ id: 'c', title: 'Gamma', authors: ['Carol'], tags: ['ml'] }));

    const network = store.getLocalPaperNetwork();
    expect(network.topNodes[0]!.id).toBe('a');
    expect(network.topNodes[0]!.degree).toBe(2);
    expect(network.topNodes[0]!.weightedDegree).toBe(2);
  });
});

describe('citationNetworkHandler', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
    setSharedStore(store);
  });

  afterEach(() => {
    setSharedStore(null as unknown as PersistenceStore);
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns a human-readable network report', async () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', tags: ['nlp'] }));
    store.savePaper(basePaper({ id: 'b', title: 'Beta', tags: ['nlp'] }));

    const result = await citationNetworkHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('# Local Paper Network Analysis');
    expect(result).toContain('Nodes (papers): 2');
    expect(result).toContain('Edges (associations): 1');
    expect(result).toContain('Alpha');
    expect(result).toContain('Beta');
  });

  it('respects options', async () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', authors: ['Alice'], tags: ['nlp'] }));
    store.savePaper(basePaper({ id: 'b', title: 'Beta', authors: ['Bob'], tags: ['nlp'] }));

    const result = await citationNetworkHandler(
      { minWeight: 2 },
      { sessionId: 'test', workspace: '.', turnIndex: 0 },
    );
    expect(result).toContain('Edges (associations): 0');
  });

  it('returns an error when shared store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const result = await citationNetworkHandler({}, { sessionId: 'test', workspace: '.', turnIndex: 0 });
    expect(result).toContain('not initialized');
  });
});

describe('PersistenceStore.fullTextSearch', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns empty results for empty query', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha' }));
    expect(store.fullTextSearch('')).toEqual([]);
    expect(store.fullTextSearch('   ')).toEqual([]);
  });

  it('matches papers by title with higher score', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Transformer Architecture', authors: ['Alice'] }));
    store.savePaper(basePaper({ id: 'b', title: 'Neural Networks', authors: ['Bob'], notes: 'Compare with transformer work' }));

    const results = store.fullTextSearch('transformer');
    expect(results).toHaveLength(2);
    expect(results[0]!.paper.id).toBe('a');
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    expect(results[0]!.matchedFields).toContain('title');
  });

  it('matches papers by abstract and pdfText', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', abstract: 'We introduce attention mechanism.', pdfText: 'Attention is all you need.' }));

    const results = store.fullTextSearch('attention');
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBeGreaterThan(0);
    expect(results[0]!.matchedFields).toContain('abstract');
  });

  it('supports exclusion terms', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Medical Imaging' }));
    store.savePaper(basePaper({ id: 'b', title: 'General Vision' }));

    const results = store.fullTextSearch('vision -medical');
    expect(results).toHaveLength(1);
    expect(results[0]!.paper.id).toBe('b');
  });

  it('requires all inclusion terms by default', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Transformer Architecture', abstract: 'Attention mechanism' }));
    store.savePaper(basePaper({ id: 'b', title: 'Transformer Survey', abstract: 'Overview' }));

    const results = store.fullTextSearch('transformer attention');
    expect(results).toHaveLength(1);
    expect(results[0]!.paper.id).toBe('a');
  });

  it('respects the limit option', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha One' }));
    store.savePaper(basePaper({ id: 'b', title: 'Alpha Two' }));
    store.savePaper(basePaper({ id: 'c', title: 'Alpha Three' }));

    const results = store.fullTextSearch('alpha', { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it('returns snippets when enabled', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', abstract: 'This paper discusses attention mechanisms in detail.' }));

    const results = store.fullTextSearch('attention', { includeSnippet: true });
    expect(results[0]!.snippet).toContain('attention');
  });

  it('returns no snippets when disabled', () => {
    store.savePaper(basePaper({ id: 'a', title: 'Alpha', abstract: 'This paper discusses attention mechanisms.' }));

    const results = store.fullTextSearch('attention', { includeSnippet: false });
    expect(results[0]!.snippet).toBeUndefined();
  });
});

describe('fulltextSearchHandler', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
    setSharedStore(store);
  });

  afterEach(() => {
    setSharedStore(null as unknown as PersistenceStore);
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('returns a human-readable search report', async () => {
    store.savePaper(basePaper({ id: 'a', title: 'Transformer Architecture' }));

    const result = await fulltextSearchHandler(
      { query: 'transformer' },
      { sessionId: 'test', workspace: '.', turnIndex: 0 },
    );
    const r = JSON.parse(result);
    expect(r.total).toBe(1);
    expect(r.matches[0].id).toBe('a');
    expect(r.matches[0].matchedFields).toContain('title');
  });

  it('returns no-match message when nothing matches', async () => {
    const result = await fulltextSearchHandler(
      { query: 'nonexistent' },
      { sessionId: 'test', workspace: '.', turnIndex: 0 },
    );
    expect(result).toContain('No local papers matched');
  });

  it('returns an error when shared store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const result = await fulltextSearchHandler(
      { query: 'transformer' },
      { sessionId: 'test', workspace: '.', turnIndex: 0 },
    );
    expect(result).toContain('not initialized');
  });
});

// --- Round 304: literature triage ---

describe('PersistenceStore.triageLiterature', () => {
  let dir: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dir = tempDir();
    store = new PersistenceStore(path.join(dir, 'test.db'));
    setSharedStore(store);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function triagePaper(id: string, overrides: Partial<Parameters<PersistenceStore['savePaper']>[0]> = {}) {
    return basePaper({
      id,
      title: `${id} title`,
      authors: ['Alice Author'],
      year: 2023,
      abstract: 'We propose a method. We test on a benchmark dataset. We show 95% accuracy.',
      tags: ['ml'],
      rating: 3,
      ...overrides,
    });
  }

  it('triages all papers when no filter is given', () => {
    store.savePaper(triagePaper('p1', { title: 'Paper One' }));
    store.savePaper(triagePaper('p2', { title: 'Paper Two' }));

    const result = store.triageLiterature({ limit: 10 });
    expect(result.papersAnalyzed).toBe(2);
    expect(result.matrix.map((m) => m.id).sort()).toEqual(['p1', 'p2']);
    expect(result.queryUsed).toBeNull();
  });

  it('extracts the 9 columns with heuristic content', () => {
    store.savePaper(triagePaper('p1', {
      abstract: 'Can models reason? We propose a new architecture. We use the GLUE benchmark. We show our model outperforms baselines by 3%.',
    }));

    const matrix = store.triageLiterature({ limit: 1 }).matrix;
    expect(matrix.length).toBe(1);
    const row = matrix[0]!;
    expect(row.citation).toContain('Alice Author');
    expect(row.citation).toContain('2023');
    expect(row.question).toContain('reason');
    expect(row.method).toContain('propose');
    expect(row.data).toContain('benchmark');
    expect(row.claim).toContain('outperform');
    expect(['empirical', 'theoretical', 'mixed', 'unknown']).toContain(row.evidenceType);
    expect(row.limitation).toBe('requires analysis');
    expect(row.whereToUse).toBe('requires analysis');
    expect(row.relevance).toBeGreaterThanOrEqual(0);
    expect(row.relevance).toBeLessThanOrEqual(1);
  });

  it('classifies evidence type from abstract signals', () => {
    store.savePaper(triagePaper('emp', {
      abstract: 'We achieve 99% accuracy on the ImageNet dataset with strong ablation results.',
    }));
    store.savePaper(triagePaper('theo', {
      abstract: 'We prove a theorem establishing an upper bound on convergence complexity.',
    }));

    const byId = new Map(store.triageLiterature({ limit: 10 }).matrix.map((m) => [m.id, m]));
    expect(byId.get('emp')?.evidenceType).toBe('empirical');
    expect(byId.get('theo')?.evidenceType).toBe('theoretical');
  });

  it('filters and ranks by query relevance', () => {
    store.savePaper(triagePaper('onTopic', { title: 'Diffusion models', tags: ['diffusion'], abstract: 'diffusion diffusion diffusion' }));
    store.savePaper(triagePaper('offTopic', { title: 'Cooking recipes', tags: ['food'], abstract: 'pasta and sauce' }));

    const result = store.triageLiterature({ query: 'diffusion', limit: 10 });
    expect(result.papersAnalyzed).toBe(1);
    expect(result.matrix[0]!.id).toBe('onTopic');
    expect(result.queryUsed).toBe('diffusion');
  });

  it('respects explicit paperIds selection', () => {
    store.savePaper(triagePaper('a'));
    store.savePaper(triagePaper('b'));
    store.savePaper(triagePaper('c'));

    const result = store.triageLiterature({ paperIds: ['a', 'c'] });
    expect(result.papersAnalyzed).toBe(2);
    expect(result.matrix.map((m) => m.id).sort()).toEqual(['a', 'c']);
  });

  it('respects the limit cap', () => {
    for (let i = 0; i < 5; i++) store.savePaper(triagePaper(`p${i}`));
    expect(store.triageLiterature({ limit: 2 }).papersAnalyzed).toBe(2);
  });

  it('returns an empty matrix when no papers match', () => {
    store.savePaper(triagePaper('a', { title: 'Cats' }));
    const result = store.triageLiterature({ query: 'quantum computing that does not exist' });
    expect(result.papersAnalyzed).toBe(0);
    expect(result.matrix).toEqual([]);
  });

  it('literatureTriageHandler renders a markdown table', async () => {
    store.savePaper(triagePaper('p1', { title: 'Sample Paper' }));
    const output = await literatureTriageHandler(
      { limit: 5 },
      { sessionId: 'test', workspace: '.', turnIndex: 0 },
    );
    expect(output).toContain('Literature Triage Matrix');
    expect(output).toContain('| # | Citation |');
    expect(output).toContain('Raw JSON');
  });

  it('literatureTriageHandler reports empty library', async () => {
    const output = await literatureTriageHandler(
      { limit: 5 },
      { sessionId: 'test', workspace: '.', turnIndex: 0 },
    );
    expect(output).toContain('No papers');
  });

  it('literatureTriageHandler errors when store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const output = await literatureTriageHandler(
      { limit: 5 },
      { sessionId: 'test', workspace: '.', turnIndex: 0 },
    );
    expect(output).toContain('not initialized');
  });
});

// --- Round 307: interest profiling ---

describe('PersistenceStore.buildInterestProfile', () => {
  let dir: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dir = tempDir();
    store = new PersistenceStore(path.join(dir, 'test.db'));
    setSharedStore(store);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns a zeroed profile for an empty library', () => {
    const profile = store.buildInterestProfile();
    expect(profile.paperCount).toBe(0);
    expect(profile.topTags).toEqual([]);
    expect(profile.topAuthors).toEqual([]);
    expect(profile.yearRange.earliest).toBeNull();
    expect(profile.avgRating).toBe(0);
  });

  it('aggregates top tags with count and average rating', () => {
    store.savePaper(basePaper({ id: 'p1', tags: ['nlp', 'transformer'], rating: 5 }));
    store.savePaper(basePaper({ id: 'p2', tags: ['nlp'], rating: 3 }));
    store.savePaper(basePaper({ id: 'p3', tags: ['cv'], rating: 4 }));

    const profile = store.buildInterestProfile();
    expect(profile.paperCount).toBe(3);
    const nlp = profile.topTags.find((t) => t.tag === 'nlp');
    expect(nlp?.count).toBe(2);
    expect(nlp?.avgRating).toBe(4); // (5+3)/2
    expect(profile.topTags[0]!.tag).toBe('nlp'); // most frequent first
  });

  it('aggregates top authors by frequency', () => {
    store.savePaper(basePaper({ id: 'p1', authors: ['Alice', 'Bob'] }));
    store.savePaper(basePaper({ id: 'p2', authors: ['Alice', 'Carol'] }));
    store.savePaper(basePaper({ id: 'p3', authors: ['Bob'] }));

    const profile = store.buildInterestProfile();
    const alice = profile.topAuthors.find((a) => a.author === 'alice');
    expect(alice?.count).toBe(2);
    expect(profile.topAuthors[0]!.author).toBe('alice');
  });

  it('aggregates top venues', () => {
    store.savePaper(basePaper({ id: 'p1', venue: 'NeurIPS' }));
    store.savePaper(basePaper({ id: 'p2', venue: 'NeurIPS' }));
    store.savePaper(basePaper({ id: 'p3', venue: 'ICLR' }));

    const profile = store.buildInterestProfile();
    expect(profile.topVenues[0]!.venue).toBe('NeurIPS');
    expect(profile.topVenues[0]!.count).toBe(2);
  });

  it('computes year range, median, read ratio, and avg rating', () => {
    store.savePaper(basePaper({ id: 'p1', year: 2018, rating: 4, readStatus: 'read' }));
    store.savePaper(basePaper({ id: 'p2', year: 2020, rating: 5, readStatus: 'read' }));
    store.savePaper(basePaper({ id: 'p3', year: 2022, rating: 1, readStatus: 'unread' }));

    const profile = store.buildInterestProfile();
    expect(profile.yearRange.earliest).toBe(2018);
    expect(profile.yearRange.latest).toBe(2022);
    expect(profile.yearRange.medianYear).toBe(2020);
    expect(profile.readRatio).toBeCloseTo(0.67, 1); // 2/3 read
    expect(profile.avgRating).toBeCloseTo(3.33, 1); // (4+5+1)/3
  });

  it('computes recency bias for the 2020+ signal', () => {
    store.savePaper(basePaper({ id: 'p1', year: 2019 }));
    store.savePaper(basePaper({ id: 'p2', year: 2021 }));
    store.savePaper(basePaper({ id: 'p3', year: 2023 }));
    store.savePaper(basePaper({ id: 'p4', year: 2024 }));

    const profile = store.buildInterestProfile();
    expect(profile.recencyBias.since2020Ratio).toBe(0.75); // 3/4 from 2020+
    expect(profile.recencyBias.medianRecencyWeight).toBeGreaterThan(0);
    expect(profile.recencyBias.medianRecencyWeight).toBeLessThanOrEqual(1);
  });

  it('respects the topN option', () => {
    for (let i = 0; i < 5; i++) {
      store.savePaper(basePaper({ id: `p${i}`, tags: [`tag${i}`] }));
    }
    const profile = store.buildInterestProfile({ topN: 2 });
    expect(profile.topTags.length).toBeLessThanOrEqual(2);
    expect(profile.topAuthors.length).toBeLessThanOrEqual(2);
  });

  it('normalizes tags to lowercase and ignores empty tags', () => {
    store.savePaper(basePaper({ id: 'p1', tags: ['NLP', ''] }));
    store.savePaper(basePaper({ id: 'p2', tags: ['nlp'] }));

    const profile = store.buildInterestProfile();
    const nlp = profile.topTags.find((t) => t.tag === 'nlp');
    expect(nlp?.count).toBe(2); // 'NLP' and 'nlp' merged
  });

  it('interestProfileHandler renders the profile with all sections', async () => {
    store.savePaper(basePaper({ id: 'p1', tags: ['nlp'], authors: ['Alice'], venue: 'NeurIPS', year: 2023, rating: 5, readStatus: 'read' }));
    const out = await interestProfileHandler(
      { topN: 5 },
      { sessionId: 't', workspace: dir, turnIndex: 0 },
    );
    expect(out).toContain('Interest Profile');
    expect(out).toContain('nlp');
    expect(out).toContain('alice');
    expect(out).toContain('NeurIPS');
    expect(out).toContain('Year range');
    expect(out).toContain('Recency bias');
    expect(out).toContain('Raw JSON');
  });

  it('interestProfileHandler reports empty library', async () => {
    const out = await interestProfileHandler(
      {},
      { sessionId: 't', workspace: dir, turnIndex: 0 },
    );
    expect(out).toContain('empty');
  });

  it('interestProfileHandler errors when store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const out = await interestProfileHandler(
      {},
      { sessionId: 't', workspace: dir, turnIndex: 0 },
    );
    expect(out).toContain('not initialized');
  });
});

// --- Round 308: candidate ranking ---

describe('PersistenceStore.rankCandidates', () => {
  let dir: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dir = tempDir();
    store = new PersistenceStore(path.join(dir, 'test.db'));
    setSharedStore(store);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty ranking for an empty library', () => {
    const result = store.rankCandidates();
    expect(result.profilePaperCount).toBe(0);
    expect(result.ranked).toEqual([]);
  });

  it('ranks papers and returns scores in 0–1', () => {
    store.savePaper(basePaper({ id: 'p1', tags: ['nlp'], year: 2020, rating: 4 }));
    const result = store.rankCandidates();
    expect(result.ranked.length).toBe(1);
    const r = result.ranked[0]!;
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.dimensions).toBeDefined();
    expect(['id', 'title', 'score', 'dimensions', 'matchedTags', 'matchedAuthors'])
      .toEqual(expect.arrayContaining(Object.keys(r)));
  });

  it('ranks a tag-matching paper above a non-matching one', () => {
    // Profile established by p1, p2 (both nlp).
    store.savePaper(basePaper({ id: 'p1', tags: ['nlp'], year: 2020, rating: 5, authors: ['Alice'] }));
    store.savePaper(basePaper({ id: 'p2', tags: ['nlp'], year: 2020, rating: 5, authors: ['Alice'] }));
    // p3 matches the profile (nlp, Alice, 2020); p4 does not.
    store.savePaper(basePaper({ id: 'p3', tags: ['nlp'], year: 2020, rating: 5, authors: ['Alice'] }));
    store.savePaper(basePaper({ id: 'p4', tags: ['cooking'], year: 2010, rating: 1, authors: ['Chef'], venue: 'FoodMag' }));

    const result = store.rankCandidates({ paperIds: ['p3', 'p4'] });
    const byId = new Map(result.ranked.map((r) => [r.id, r]));
    expect(byId.get('p3')!.score).toBeGreaterThan(byId.get('p4')!.score);
  });

  it('surfaces matched tags and authors', () => {
    store.savePaper(basePaper({ id: 'p1', tags: ['nlp'], authors: ['Alice'], year: 2020, rating: 5 }));
    store.savePaper(basePaper({ id: 'p2', tags: ['nlp'], authors: ['Alice'], year: 2020, rating: 5 }));
    store.savePaper(basePaper({ id: 'p3', tags: ['nlp', 'transformer'], authors: ['Alice', 'Bob'], year: 2020, rating: 5 }));

    const result = store.rankCandidates({ paperIds: ['p3'] });
    expect(result.ranked[0]!.matchedTags).toContain('nlp');
    expect(result.ranked[0]!.matchedAuthors).toContain('alice');
  });

  it('respects explicit paperIds selection', () => {
    store.savePaper(basePaper({ id: 'a' }));
    store.savePaper(basePaper({ id: 'b' }));
    store.savePaper(basePaper({ id: 'c' }));

    const result = store.rankCandidates({ paperIds: ['a', 'c'] });
    expect(result.ranked.map((r) => r.id).sort()).toEqual(['a', 'c']);
  });

  it('filters by query before ranking', () => {
    store.savePaper(basePaper({ id: 'p1', title: 'Diffusion Models', tags: ['diffusion'] }));
    store.savePaper(basePaper({ id: 'p2', title: 'Cooking Recipes', tags: ['food'] }));

    const result = store.rankCandidates({ query: 'diffusion' });
    expect(result.ranked.length).toBe(1);
    expect(result.ranked[0]!.id).toBe('p1');
  });

  it('respects the limit', () => {
    for (let i = 0; i < 5; i++) store.savePaper(basePaper({ id: `p${i}` }));
    expect(store.rankCandidates({ limit: 2 }).ranked.length).toBe(2);
  });

  it('rankCandidatesHandler renders a ranked table', async () => {
    store.savePaper(basePaper({ id: 'p1', title: 'Test Paper', tags: ['nlp'], year: 2020, rating: 5 }));
    const out = await rankCandidatesHandler(
      { limit: 5 },
      { sessionId: 't', workspace: dir, turnIndex: 0 },
    );
    expect(out).toContain('Candidate Ranking');
    expect(out).toContain('| # | Score |');
    expect(out).toContain('How scores work');
    expect(out).toContain('Raw JSON');
  });

  it('rankCandidatesHandler reports no candidates', async () => {
    const out = await rankCandidatesHandler(
      { limit: 5 },
      { sessionId: 't', workspace: dir, turnIndex: 0 },
    );
    expect(out).toContain('No candidates');
  });

  it('rankCandidatesHandler errors when store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const out = await rankCandidatesHandler(
      { limit: 5 },
      { sessionId: 't', workspace: dir, turnIndex: 0 },
    );
    expect(out).toContain('not initialized');
  });
});

describe('PersistenceStore.getPaper (METIS-OPT-2 lazy detail)', () => {
  it('returns a full single paper including pdfText by id', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-getpaper-'));
    const store = new PersistenceStore(path.join(dir, 'metis.db'));
    try {
      store.savePaper({
        id: 'lazy-1', title: 'Lazy detail', authors: ['A'], year: 2024, venue: 'V',
        abstract: 'abs', tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: 1,
        pdfText: 'full extracted text that the summary must not carry',
      });
      const full = store.getPaper('lazy-1');
      expect(full?.id).toBe('lazy-1');
      expect(full?.pdfText).toContain('full extracted text');
      expect(store.getPaper('missing')).toBeUndefined();
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
