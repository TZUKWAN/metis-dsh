/**
 * Crash consistency fixtures (task 1 §九).
 *
 * For each failure window the requirement is identical: after the failure, a fresh
 * startup can open the database, quick_check and foreign_key_check pass, and no
 * half-applied state is visible.
 *
 *   1. migration aborts mid-pipeline        (duplicate library pointer → v105 fails)
 *   2. transaction aborts mid-write         (session deletion with a sabotaged trigger)
 *   3. restore fails before the swap        (invalid backup file)
 *   4. swap done, reopen fails              (garbage swapped in; intent → rollback)
 *   5. process dies before WAL checkpoint   (crash image: db + wal copied, replayed)
 *   6. outcome version save dies mid-write  (sabotaged trigger; version pointer intact)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { PersistenceStartupError } from '../../engine/persistence/errors.js';
import { BackupService, writeRestoreIntent, type RestoreIntent } from '../../electron/BackupService.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-crash-'));
}

/** quick_check + foreign_key_check on a raw connection; used to certify recovery. */
function assertDbHealthy(dbPath: string): void {
  const raw = new Database(dbPath);
  try {
    expect(raw.pragma('quick_check', { simple: true })).toBe('ok');
    expect(raw.pragma('foreign_key_check')).toEqual([]);
  } finally {
    raw.close();
  }
}

describe('crash window 1 — migration aborts mid-pipeline', () => {
  it('stops at the failed version; the database stays healthy and recoverable', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'metis.db');
    new PersistenceStore(dbPath).close();

    // Regress to pre-v105 and plant the duplicate pair that fails the unique index.
    const raw = new Database(dbPath);
    raw.prepare('DELETE FROM schema_migrations WHERE version >= 105').run();
    raw.exec('DROP INDEX IF EXISTS idx_sources_project_library_paper');
    raw.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('proj-dup', 'X', 1, 1)").run();
    raw.prepare(`
      INSERT INTO sources (id, project_id, kind, library_paper_id, created_at, updated_at)
      VALUES ('s1', 'proj-dup', 'paper', 'dup', 1, 1), ('s2', 'proj-dup', 'paper', 'dup', 1, 1)
    `).run();
    raw.close();

    expect(() => new PersistenceStore(dbPath)).toThrow(PersistenceStartupError);
    // The database is openable, structurally sound, and free of half-state.
    assertDbHealthy(dbPath);
    const check = new Database(dbPath);
    const maxApplied = (check.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number }).v;
    expect(maxApplied).toBeLessThan(105);
    check.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('crash window 2 — a transaction aborts mid-write (session deletion)', () => {
  let dir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dir = tempDir();
    dbPath = path.join(dir, 'metis.db');
    store = new PersistenceStore(dbPath);
    store.raw.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('proj-a', 'A', 1, 1)").run();
    store.createSession('s1', {}, 'proj-a');
    store.createArtifacts([{ id: 'art-1', sessionId: 's1', name: 'N', type: 'md', content: 'c' }]);
    store.appendMessage('s1', 'user', '消息');
  });

  afterEach(() => {
    try { store.close(); } catch { /* closed in test */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deleting the session fails atomically: nothing was removed and nothing was mirrored', () => {
    // Sabotage the final DELETE so the transaction aborts after doing real work.
    store.raw.exec(`
      CREATE TRIGGER fail_session_delete
      BEFORE DELETE ON sessions
      BEGIN
        SELECT RAISE(ABORT, 'injected session delete failure');
      END;
    `);
    expect(() => store.deleteSession('s1')).toThrow(/injected session delete failure/);

    // Everything is still there — and the project mirror created by the dual-write at
    // artifact creation time is exactly one row (the aborted deletion added nothing).
    expect(store.getSession('s1')).toBeDefined();
    expect((store.raw.prepare('SELECT COUNT(*) c FROM messages WHERE session_id = ?').get('s1') as { c: number }).c).toBe(1);
    expect((store.raw.prepare('SELECT COUNT(*) c FROM artifacts WHERE id = ?').get('art-1') as { c: number }).c).toBe(1);
    expect((store.raw.prepare("SELECT COUNT(*) c FROM research_artifacts WHERE project_id = 'proj-a'").get() as { c: number }).c).toBe(1);
    assertDbHealthy(dbPath);
  });
});

describe('crash windows 3+4 — restore failures', () => {
  it('window 3: an invalid backup fails before anything is touched', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'metis.db');
    const store = new PersistenceStore(dbPath);
    store.raw.prepare("INSERT INTO papers (id, title, added_at) VALUES ('p1', '在库数据', 1)").run();
    const service = new BackupService(store, path.join(dir, 'backups'), dbPath);
    const garbage = path.join(dir, 'garbage.db');
    fs.writeFileSync(garbage, 'not a database at all'.repeat(40));

    const result = await service.restoreFrom(garbage);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^backup_invalid/);
    // Live database untouched, intent absent, store still usable.
    expect((store.raw.prepare("SELECT title FROM papers WHERE id = 'p1'").get() as { title: string }).title).toBe('在库数据');
    expect(fs.existsSync(`${dbPath}.restore-intent.json`)).toBe(false);
    store.close();
    assertDbHealthy(dbPath);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('window 4: swap done but the database cannot reopen — the intent enables rollback', async () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'metis.db');
    // Pre-restore state, snapshotted.
    const store = new PersistenceStore(dbPath);
    store.raw.prepare("INSERT INTO papers (id, title, added_at) VALUES ('p1', '恢复前', 1)").run();
    const service = new BackupService(store, path.join(dir, 'backups'), dbPath);
    const snapshot = await service.runBackup();
    expect(snapshot.ok).toBe(true);
    store.close();

    // Simulate a restore that swapped in a corrupt file and crashed before cleanup.
    const corrupted = path.join(dir, 'corrupt.db');
    fs.writeFileSync(corrupted, 'definitely not a sqlite database'.repeat(30));
    fs.copyFileSync(corrupted, dbPath);
    const intent: RestoreIntent = {
      backupPath: corrupted,
      rollbackPath: snapshot.destination!,
      dbPath,
      requestedAt: 1,
    };
    writeRestoreIntent(dbPath, intent);

    // Next boot: the corruption is reported as a controlled integrity failure…
    let error: PersistenceStartupError | undefined;
    let unexpected: PersistenceStore | undefined;
    try { unexpected = new PersistenceStore(dbPath); } catch (err) {
      if (err instanceof PersistenceStartupError) error = err; else throw err;
    } finally { unexpected?.close(); }
    expect(error?.detail.code).toBe('integrity_check_failed');

    // …and the recorded rollback snapshot restores a healthy database.
    const rolled = BackupService.rollbackFromIntent(intent);
    expect(rolled.ok).toBe(true);
    const recovered = new PersistenceStore(dbPath);
    expect((recovered.raw.prepare("SELECT title FROM papers WHERE id = 'p1'").get() as { title: string }).title).toBe('恢复前');
    recovered.close();
    assertDbHealthy(dbPath);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('crash window 5 — process dies before the WAL checkpoint', () => {
  it('a copied db+wal crash image replays its committed transactions on open', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'live.db');
    const imagePath = path.join(dir, 'image.db');
    const raw = new Database(dbPath);
    try {
      raw.pragma('journal_mode = WAL');
      raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      raw.prepare("INSERT INTO t (v) VALUES ('已提交未checkpoint')").run();
      // NOT checkpointing on purpose; the committed row lives only in the -wal file.
      const walPath = `${dbPath}-wal`;
      expect(fs.existsSync(walPath)).toBe(true);
      expect(fs.statSync(walPath).size).toBeGreaterThan(0);

      // Crash image: copy both files while the process is still "alive" (a clean
      // close would checkpoint and delete the -wal file, which a crash never does).
      fs.copyFileSync(dbPath, imagePath);
      fs.copyFileSync(walPath, `${imagePath}-wal`);
    } finally {
      raw.close();
    }

    const image = new Database(imagePath);
    try {
      const value = (image.prepare('SELECT v FROM t LIMIT 1').get() as { v: string }).v;
      expect(value).toBe('已提交未checkpoint');
      expect(image.pragma('quick_check', { simple: true })).toBe('ok');
    } finally {
      image.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('crash window 6 — outcome version save dies mid-write', () => {
  it('the version pointer stays on the last fully-saved version', () => {
    const dir = tempDir();
    try {
      const dbPath = path.join(dir, 'metis.db');
      const store = new PersistenceStore(dbPath);
      store.raw.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('proj-a', 'A', 1, 1)").run();
      const outcomes = new OutcomeRepository(store.raw);
      const created = outcomes.create({
        projectId: 'proj-a',
        title: '结项报告',
        kind: 'other',
        content: { type: 'other', text: 'v1 内容', media: null },
        note: '初版',
      });
      expect(created.outcome.currentVersion).toBe(1);

      // Version 2 dies after the version row was inserted (sabotage the changes row).
      store.raw.exec(`
        CREATE TRIGGER fail_outcome_changes
        BEFORE INSERT ON outcome_changes
        BEGIN
          SELECT RAISE(ABORT, 'injected outcome save failure');
        END;
      `);
      expect(() => outcomes.save({
        projectId: 'proj-a',
        outcomeId: created.outcome.id,
        baseVersion: 1,
        content: { type: 'other', text: 'v2 内容', media: null },
        note: '第二版',
        actor: 'human',
        sources: [],
      })).toThrow(/injected outcome save failure/);

      // Pointer unchanged, no orphan version row, database healthy.
      const summary = outcomes.list('proj-a').find((item) => item.id === created.outcome.id);
      expect(summary?.currentVersion).toBe(1);
      const versions = (store.raw
        .prepare('SELECT COUNT(*) c FROM outcome_versions WHERE outcome_id = ?')
        .get(created.outcome.id) as { c: number }).c;
      expect(versions).toBe(1);
      store.close();
      assertDbHealthy(dbPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
