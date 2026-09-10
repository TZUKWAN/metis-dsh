/**
 * Startup crash reconciliation (P0-8): any agent_runs row still 'running'
 * when the store opens belongs to a dead process. The store must retire those
 * rows deterministically — interrupted / process_crash / completed_at — and
 * the operation must be idempotent (a second pass finds nothing).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';

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

function seedCrashedStore(dbPath: string): void {
  const store = new PersistenceStore(dbPath);
  try {
    store.createSession('sess-crash', undefined, undefined);
    store.appendMessage('sess-crash', 'user', 'crash while running');
    // Simulate a process hard-killed mid-turn: a 'running' row with no
    // terminal state (exactly what appendAgentRun writes).
    store.raw.prepare(
      `INSERT INTO agent_runs (run_id, session_id, turn_id, project_id, status, started_at, last_sequence, metadata)
       VALUES ('run-crash-1', 'sess-crash', 'turn-crash-1', NULL, 'running', 1000, 5, '{}')`,
    ).run();
    // A completed row must be left untouched.
    store.raw.prepare(
      `INSERT INTO agent_runs (run_id, session_id, turn_id, status, started_at, last_sequence, metadata, completed_at, terminal_reason)
       VALUES ('run-done-1', 'sess-crash', 'turn-done-1', 'completed', 900, 9, '{}', 950, 'normal')`,
    ).run();
  } finally {
    store.close();
  }
}

describe('reconcileOrphanRunningRuns (crash reconciliation)', () => {
  it('retires crash-era running rows to interrupted/process_crash and leaves finished rows alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-reconcile-'));
    const dbPath = path.join(dir, 'metis.db');
    try {
      seedCrashedStore(dbPath);
      const recoveredAt = 5_000;
      const store = new PersistenceStore(dbPath);
      try {
        const reconciled = store.reconcileOrphanRunningRuns(recoveredAt);
        expect(reconciled).toBe(1);

        const row = store.raw.prepare("SELECT * FROM agent_runs WHERE run_id = 'run-crash-1'").get() as Record<string, unknown>;
        expect(row.status).toBe('interrupted');
        expect(row.terminal_reason).toBe('process_crash');
        expect(row.completed_at).toBe(recoveredAt);

        const done = store.raw.prepare("SELECT * FROM agent_runs WHERE run_id = 'run-done-1'").get() as Record<string, unknown>;
        expect(done.status).toBe('completed');
        expect(done.terminal_reason).toBe('normal');
        expect(done.completed_at).toBe(950);
      } finally {
        store.close();
      }
      // Integrity survives the reconciliation write.
      const inspector = new Database(dbPath, { readonly: true });
      try {
        expect(inspector.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
      } finally {
        inspector.close();
      }
    } finally {
      rmTemp(dir);
    }
  });

  it('is idempotent: a second pass reconciles nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-reconcile-idem-'));
    const dbPath = path.join(dir, 'metis.db');
    try {
      seedCrashedStore(dbPath);
      const store = new PersistenceStore(dbPath);
      try {
        expect(store.reconcileOrphanRunningRuns(5_000)).toBe(1);
        expect(store.reconcileOrphanRunningRuns(6_000)).toBe(0);
        const stillRunning = store.raw.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'running'").get() as { n: number };
        expect(stillRunning.n).toBe(0);
      } finally {
        store.close();
      }
    } finally {
      rmTemp(dir);
    }
  });
});
