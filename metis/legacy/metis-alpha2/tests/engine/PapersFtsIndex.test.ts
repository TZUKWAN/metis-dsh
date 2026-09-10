/**
 * FTS5 full-text index for papers: creation, population, trigger sync, search.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('papers FTS5 index', () => {
  let dir: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-fts-'));
    store = new PersistenceStore(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the FTS5 virtual table on init', () => {
    const row = store.raw.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'papers_fts'",
    ).get();
    expect(row).toBeTruthy();
  });

  it('populates the index from existing papers', () => {
    store.raw.prepare(`
      INSERT INTO papers (id, title, authors, year, venue, abstract, pdf_text, citation_count, tags, notes, read_status, rating, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('p1', 'Attention Is All You Need', '["Vaswani"]', 2017, 'NeurIPS', 'Transformer architecture', 'multi-head self-attention mechanism', 0, '[]', '', 'unread', 0, 1000);

    store.reindexPapersFts();
    const results = store.raw.prepare(`
      SELECT p.id FROM papers p JOIN papers_fts ON papers_fts.rowid = p.rowid
      WHERE papers_fts MATCH '"attention"'
    `).all();
    expect(results).toHaveLength(1);
    expect((results[0] as { id: string }).id).toBe('p1');
  });

  it('keeps the index in sync after reindex (insert/update/delete)', () => {
    // Insert
    store.raw.prepare(`
      INSERT INTO papers (id, title, authors, year, venue, abstract, pdf_text, citation_count, tags, notes, read_status, rating, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('p2', 'New Paper', '[]', 2024, '', 'novel method', 'unique_term_xyz', 0, '[]', '', 'unread', 0, 2000);

    store.reindexPapersFts();
    let found = store.raw.prepare(`
      SELECT p.id FROM papers p JOIN papers_fts ON papers_fts.rowid = p.rowid
      WHERE papers_fts MATCH '"unique_term_xyz"'
    `).all();
    expect(found).toHaveLength(1);

    // Update
    store.raw.prepare('UPDATE papers SET pdf_text = ? WHERE id = ?').run('updated_term_abc', 'p2');
    store.reindexPapersFts();
    found = store.raw.prepare(`
      SELECT p.id FROM papers p JOIN papers_fts ON papers_fts.rowid = p.rowid
      WHERE papers_fts MATCH '"updated_term_abc"'
    `).all();
    expect(found).toHaveLength(1);

    // Delete
    store.raw.prepare('DELETE FROM papers WHERE id = ?').run('p2');
    store.reindexPapersFts();
    found = store.raw.prepare(`
      SELECT p.id FROM papers p JOIN papers_fts ON papers_fts.rowid = p.rowid
      WHERE papers_fts MATCH '"updated_term_abc"'
    `).all();
    expect(found).toHaveLength(0);
  });

  it('handles multi-term queries with implicit AND', () => {
    store.raw.prepare(`
      INSERT INTO papers (id, title, authors, year, venue, abstract, pdf_text, citation_count, tags, notes, read_status, rating, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('p3', 'Deep Learning for NLP', '["Devlin"]', 2019, 'ACL', 'neural approaches', 'transformer attention language model', 0, '[]', '', 'unread', 0, 3000);

    store.reindexPapersFts();
    const results = store.raw.prepare(`
      SELECT p.id FROM papers p JOIN papers_fts ON papers_fts.rowid = p.rowid
      WHERE papers_fts MATCH '"transformer" "attention"'
    `).all();
    expect(results).toHaveLength(1);
  });
});
