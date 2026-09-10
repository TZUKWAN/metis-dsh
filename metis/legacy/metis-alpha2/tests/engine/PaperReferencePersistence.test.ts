/**
 * Paper reference persistence — citation relations (referenceIds) survive
 * restarts via the papers.reference_ids column.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';

describe('Paper reference persistence', () => {
  let dir: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-ref-test-'));
    store = new PersistenceStore(path.join(dir, 'metis.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists referenceIds and restores them after a restart', () => {
    store.savePaper({
      id: 'p1', title: '主文献', authors: [], year: 2024, venue: '', abstract: '',
      tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: 1,
      referenceIds: ['p2', 'p3'],
    });
    store.savePaper({ id: 'p2', title: '被引文献', authors: [], year: 2023, venue: '', abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: 1 });

    const before = store.getPapers().find((p) => p.id === 'p1');
    expect(before?.referenceIds).toEqual(['p2', 'p3']);

    // "Restart": fresh store over the same file.
    store.close();
    store = new PersistenceStore(path.join(dir, 'metis.db'));
    const after = store.getPapers().find((p) => p.id === 'p1');
    expect(after?.referenceIds).toEqual(['p2', 'p3']);
  });

  it('defaults missing reference lists to empty', () => {
    store.savePaper({
      id: 'p1', title: '无引用', authors: [], year: 2024, venue: '', abstract: '',
      tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: 1,
    });
    expect(store.getPapers().find((p) => p.id === 'p1')?.referenceIds).toEqual([]);
  });
});
