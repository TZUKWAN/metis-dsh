/**
 * Performance measurement suite (Task 5 §19).
 *
 * Measures REAL persistence operations and writes the raw timings to
 * logs/perf-measure.json for scripts/perf-baseline.mjs (record/check modes).
 * The assertions here are SANITY-only (operations complete with expected
 * data) — the regression comparison against the committed baseline happens in
 * the perf gate (nightly), not in every test run, because absolute times are
 * hardware-dependent.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';

function rmTemp(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

describe('performance measurement (real persistence work)', () => {
  it('times 1000-paper seed/read, 500-message session, and 100-outcome list', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-perf-measure-'));
    const dbPath = path.join(dir, 'metis.db');
    let store: PersistenceStore | null = null;
    try {
      const timings: Record<string, number> = {};

      store = new PersistenceStore(dbPath);
      const repo = new ResearchRepository(store.raw);
      repo.createProject({
        id: 'proj-perf', title: 'perf', originalIntent: '', researchQuestion: '', lifecycle: 'active',
        methodology: '', discipline: '', metadata: {}, createdAt: 1, updatedAt: 1, archivedAt: null,
        version: 1, source: 'user', deletedAt: null,
      });

      let t0 = Date.now();
      for (let i = 0; i < 1000; i++) {
        store.savePaper({
          id: `perf-paper-${i}`, title: `Paper ${i}`, authors: ['A'], year: 2026, venue: 'V',
          abstract: 'x'.repeat(400), tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: i,
        });
      }
      timings.db_seed_1000_papers = Date.now() - t0;

      store.close();
      store = null;
      t0 = Date.now();
      store = new PersistenceStore(dbPath);
      const papers = store.getPapers();
      timings.db_open_and_list_1000 = Date.now() - t0;
      expect(papers.length).toBeGreaterThanOrEqual(1000);

      store.createSession('sess-perf', undefined, 'proj-perf');
      t0 = Date.now();
      for (let i = 0; i < 500; i++) store.appendMessage('sess-perf', 'user', `message ${i} ${'y'.repeat(200)}`);
      timings.session_500_append = Date.now() - t0;
      t0 = Date.now();
      const messages = store.getMessages('sess-perf');
      timings.session_500_read = Date.now() - t0;
      expect(messages).toHaveLength(500);

      const outcomes = new OutcomeRepository(store.raw);
      t0 = Date.now();
      for (let i = 0; i < 100; i++) {
        outcomes.create({
          projectId: 'proj-perf', categoryId: null, title: `Outcome ${i}`, kind: 'other',
          content: { type: 'other', text: 'z'.repeat(500), media: null }, note: 'perf', actor: 'human',
        });
      }
      const listed = outcomes.list('proj-perf');
      timings.outcomes_100_write_list = Date.now() - t0;
      expect(listed).toHaveLength(100);

      const outDir = path.resolve(__dirname, '../../logs');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(
        path.join(outDir, 'perf-measure.json'),
        JSON.stringify({ measuredAt: new Date().toISOString(), metrics: timings }, null, 2),
      );
    } finally {
      try { store?.close(); } catch { /* closed */ }
      rmTemp(dir);
    }
  }, 120_000);
});
