/**
 * CloudSync staged-restore sequencing (task 1 §八).
 *
 * The staged restore must run BEFORE any PersistenceStore is created, so no service
 * ever holds a stale handle. This test proves the new contract on the service itself:
 * the staged file replaces the DB, the pre-restore rollback snapshot path is returned
 * for the restore intent, and a non-SQLite staged file is rejected without touching
 * the live database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { CloudSyncService } from '../../electron/CloudSyncService.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-cloudsync-'));
}

describe('CloudSyncService.applyStagedRestoreIfNeeded', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = tempDir();
    dbPath = path.join(dir, 'metis.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeService(): CloudSyncService {
    return new CloudSyncService(dir, dbPath);
  }

  it('returns { applied: false } when nothing is staged', () => {
    expect(makeService().applyStagedRestoreIfNeeded()).toEqual({ applied: false });
  });

  it('replaces the DB, returns the rollback snapshot path, and deletes the staging file', () => {
    // Live database with data.
    const live = new Database(dbPath);
    live.exec('CREATE TABLE t (v TEXT)');
    live.prepare("INSERT INTO t VALUES ('在库数据')").run();
    live.close();
    // Staged replacement with different data.
    const staging = path.join(dir, 'metis.db.restore-staging');
    const staged = new Database(staging);
    staged.exec('CREATE TABLE t (v TEXT)');
    staged.prepare("INSERT INTO t VALUES ('云端数据')").run();
    staged.close();

    const result = makeService().applyStagedRestoreIfNeeded();

    expect(result.applied).toBe(true);
    expect(typeof result.rollbackPath).toBe('string');
    expect(fs.existsSync(result.rollbackPath!)).toBe(true);
    expect(fs.existsSync(staging)).toBe(false);
    const after = new Database(dbPath, { readonly: true });
    expect((after.prepare('SELECT v FROM t').get() as { v: string }).v).toBe('云端数据');
    after.close();
    // Rollback snapshot really holds the pre-restore state.
    const rollback = new Database(result.rollbackPath!, { readonly: true });
    expect((rollback.prepare('SELECT v FROM t').get() as { v: string }).v).toBe('在库数据');
    rollback.close();
  });

  it('rejects a non-SQLite staged file without touching the live database', () => {
    const live = new Database(dbPath);
    live.exec('CREATE TABLE t (v TEXT)');
    live.prepare("INSERT INTO t VALUES ('在库数据')").run();
    live.close();
    fs.writeFileSync(path.join(dir, 'metis.db.restore-staging'), 'definitely not sqlite'.repeat(20));

    const result = makeService().applyStagedRestoreIfNeeded();

    expect(result.applied).toBe(false);
    const after = new Database(dbPath, { readonly: true });
    expect((after.prepare('SELECT v FROM t').get() as { v: string }).v).toBe('在库数据');
    after.close();
  });

  it('on a fresh install (no existing DB) applies without a rollback snapshot', () => {
    const staging = path.join(dir, 'metis.db.restore-staging');
    const staged = new Database(staging);
    staged.exec('CREATE TABLE t (v TEXT)');
    staged.close();

    const result = makeService().applyStagedRestoreIfNeeded();

    expect(result.applied).toBe(true);
    expect(result.rollbackPath).toBeUndefined();
  });
});
