/**
 * METIS-403 — Unified Source service tests.
 *
 * Verifies all eight material types normalize into a unified Source, identifiers are
 * normalized (DOI/arXiv/ISBN/URL), dedup-by-identifier works, and CRUD + soft-delete behave.
 * One realistic sample per type (METIS-403: "at least one real sample per type").
 */

import { describe, it, expect } from 'vitest';
import { normalizeSource, SourceService, type SourceStore, type SourceInput } from './SourceService.js';
import type { Source } from '../persistence/researchModel.js';

class MemStore implements SourceStore {
  readonly byId = new Map<string, Source>();
  insert(s: Source) { this.byId.set(s.id, { ...s }); }
  get(id: string) { const s = this.byId.get(id); return s ? { ...s } : undefined; }
  listByProject(pid: string) { return [...this.byId.values()].filter((s) => s.projectId === pid && !s.deletedAt); }
  update(id: string, patch: Partial<Source>) { const s = this.byId.get(id); if (s) this.byId.set(id, { ...s, ...patch }); }
  softDelete(id: string, at: number) { const s = this.byId.get(id); if (s) this.byId.set(id, { ...s, deletedAt: at }); }
}

const FIXED = { generateId: (k: string) => `${k}-1`, now: () => 1000 };

describe('METIS-403 SourceService — eight material types normalize to unified Source', () => {
  const cases: Array<{ name: string; input: SourceInput; expectKind: string; expectIdType?: string }> = [
    { name: 'paper (with DOI)', input: { kind: 'paper', data: { title: 'Attention Is All You Need', authors: ['Vaswani'], year: 2017, doi: 'https://doi.org/10.5555/3295222.3295349', venue: 'NeurIPS' } }, expectKind: 'paper', expectIdType: 'doi' },
    { name: 'paper (arXiv only)', input: { kind: 'paper', data: { title: 'Test', arxivId: 'arXiv:2401.12345' } }, expectKind: 'paper', expectIdType: 'arxiv' },
    { name: 'book (ISBN)', input: { kind: 'book', data: { title: '想象的共同体', authors: ['Benedict Anderson'], year: 1983, isbn: '978-7-108-043490-5' } }, expectKind: 'book', expectIdType: 'isbn' },
    { name: 'pdf (local file)', input: { kind: 'pdf', data: { filePath: '/data/red_mansion.pdf', pageCount: 1200 } }, expectKind: 'pdf' },
    { name: 'web (URL)', input: { kind: 'web', data: { url: 'https://example.org/article', title: 'An Article' } }, expectKind: 'web', expectIdType: 'url' },
    { name: 'archive (local file)', input: { kind: 'archive', data: { filePath: '/data/gazetteer.json', title: '江南通志', archiveType: '地方志' } }, expectKind: 'archive' },
    { name: 'image (local file)', input: { kind: 'image', data: { filePath: '/data/fig1.png', caption: '事件研究图' } }, expectKind: 'image' },
    { name: 'audio (interview)', input: { kind: 'audio', data: { filePath: '/data/interview1.wav', durationSec: 1800, transcriptPath: '/data/interview1.txt' } }, expectKind: 'audio' },
    { name: 'data (CSV)', input: { kind: 'data', data: { filePath: '/data/cgss.csv', format: 'csv', rowCount: 5000 } }, expectKind: 'data' },
  ];

  for (const c of cases) {
    it(`normalizes ${c.name} into a unified Source`, () => {
      const s = normalizeSource('proj-1', c.input, FIXED);
      expect(s.kind).toBe(c.expectKind);
      expect(s.projectId).toBe('proj-1');
      expect(s.createdAt).toBe(1000);
      expect(s.deletedAt).toBeNull();
      if (c.expectIdType) expect(s.identifierType).toBe(c.expectIdType);
      expect(s.id).toBe(`${c.expectKind}-1`);
    });
  }
});

describe('METIS-403 SourceService — identifier normalization', () => {
  it('normalizes DOI (strips URL prefix, lowercases)', () => {
    const s = normalizeSource('p', { kind: 'paper', data: { title: 'T', doi: 'https://doi.org/10.5555/ABC' } }, FIXED);
    expect(s.identifier).toBe('10.5555/abc');
    expect(s.identifierType).toBe('doi');
  });
  it('normalizes arXiv ID (strips prefix)', () => {
    const s = normalizeSource('p', { kind: 'paper', data: { title: 'T', arxivId: 'arXiv: 2401.12345' } }, FIXED);
    expect(s.identifier).toBe('2401.12345');
    expect(s.identifierType).toBe('arxiv');
  });
  it('normalizes ISBN (strips dashes/space, uppercases)', () => {
    const s = normalizeSource('p', { kind: 'book', data: { title: 'T', isbn: '978-7-108-043490-5' } }, FIXED);
    expect(s.identifier).toBe('97871080434905');
    expect(s.identifierType).toBe('isbn');
  });
  it('marks a paper without DOI/arXiv as identifierType=other', () => {
    const s = normalizeSource('p', { kind: 'paper', data: { title: 'No identifiers' } }, FIXED);
    expect(s.identifierType).toBe('other');
    expect(s.identifier).toBe('');
  });
});

describe('METIS-403 SourceService — service CRUD + dedup', () => {
  it('registers, gets, lists, updates, and soft-deletes', () => {
    const svc = new SourceService(new MemStore());
    const s = svc.register('p1', { kind: 'paper', data: { title: 'A', doi: '10.1/x' } });
    expect(svc.get(s.id)?.title).toBe('A');
    expect(svc.listByProject('p1')).toHaveLength(1);
    svc.update(s.id, { title: 'A2' });
    expect(svc.get(s.id)?.title).toBe('A2');
    svc.softDelete(s.id);
    expect(svc.listByProject('p1')).toHaveLength(0); // soft-deleted excluded from list
    expect(svc.get(s.id)?.deletedAt).toBeGreaterThan(0); // but still retrievable
  });

  it('findByIdentifier dedups before re-importing (same DOI returns existing)', () => {
    const svc = new SourceService(new MemStore());
    const s1 = svc.register('p1', { kind: 'paper', data: { title: 'A', doi: '10.1/x' } });
    const found = svc.findByIdentifier('p1', s1.identifier);
    expect(found?.id).toBe(s1.id);
  });

  it('does not cross-pollute identifiers across projects', () => {
    const svc = new SourceService(new MemStore());
    svc.register('p1', { kind: 'paper', data: { title: 'A', doi: '10.1/x' } });
    expect(svc.findByIdentifier('p2', '10.1/x')).toBeUndefined();
  });
});
