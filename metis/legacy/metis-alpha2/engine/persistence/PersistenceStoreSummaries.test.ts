/**
 * Tests for PersistenceStore.listPaperSummaries — lightweight paginated list
 * that excludes heavy pdfText/abstract columns.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PersistenceStore } from './PersistenceStore.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-summaries-test-'));
}

function makePaper(id: string, addedAt: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Paper ${id}`,
    authors: ['Author A'],
    year: 2020,
    venue: 'Venue',
    abstract: 'x'.repeat(5000),
    doi: `10.1/${id}`,
    pdfText: 'y'.repeat(40000),
    tags: ['t'],
    notes: '',
    readStatus: 'unread',
    rating: 0,
    addedAt,
    ...overrides,
  };
}

describe('PersistenceStore.listPaperSummaries', () => {
  let dir: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dir = tempDir();
    store = new PersistenceStore(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns papers newest-first without the heavy pdfText/abstract fields', () => {
    store.savePaper(makePaper('old', 1000));
    store.savePaper(makePaper('new', 2000));
    const summaries = store.listPaperSummaries();
    expect(summaries.map((s) => s.id)).toEqual(['new', 'old']);
    // The summary type intentionally omits abstract and pdfText.
    expect(summaries[0]).not.toHaveProperty('pdfText');
    expect(summaries[0]).not.toHaveProperty('abstract');
    // Light metadata is still present.
    expect(summaries[0]!.doi).toBe('10.1/new');
    expect(summaries[0]!.tags).toEqual(['t']);
  });

  it('respects the limit option (clamped to 1..500)', () => {
    for (let i = 0; i < 10; i++) store.savePaper(makePaper(`p${i}`, 1000 + i));
    expect(store.listPaperSummaries({ limit: 3 })).toHaveLength(3);
    expect(store.listPaperSummaries({ limit: 0 })).toHaveLength(1);
  });

  it('paginates with beforeAddedAt keyset', () => {
    for (let i = 0; i < 5; i++) store.savePaper(makePaper(`p${i}`, 1000 + i));
    const first = store.listPaperSummaries({ limit: 2 });
    expect(first.map((s) => s.id)).toEqual(['p4', 'p3']);
    const next = store.listPaperSummaries({ limit: 2, beforeAddedAt: first[1]!.addedAt });
    expect(next.map((s) => s.id)).toEqual(['p2', 'p1']);
  });

  it('scales to a large library without pulling pdfText into the row objects', () => {
    // Seed 1000 papers with 40KB pdfText each (~40MB of text in the table).
    const start = Date.now();
    for (let i = 0; i < 1000; i++) store.savePaper(makePaper(`big${i}`, 5000 + i));
    const seedMs = Date.now() - start;

    // Summaries must be fast and must NOT carry pdfText into JS memory.
    const t0 = Date.now();
    const page = store.listPaperSummaries({ limit: 100 });
    const elapsed = Date.now() - t0;

    expect(page).toHaveLength(100);
    expect(page.every((s) => !('pdfText' in s))).toBe(true);
    // Generous bound: pagination over a 1000-row table should be well under a
    // second even on a slow CI box; this guards against accidental full scans.
    expect(elapsed).toBeLessThan(2000);
    expect(seedMs).toBeGreaterThan(0);
  });
});
