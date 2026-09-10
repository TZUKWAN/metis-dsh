/**
 * Tests for BackupService.restoreFrom — the controlled-restore state machine
 * (task 1 §八): validate → rollback snapshot → restore intent → drain → atomic
 * swap → full app restart → next-boot health check → clear intent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import {
  BackupService,
  clearRestoreIntent,
  readRestoreIntent,
  restoreIntentPathFor,
  validateBackupFile,
  writeRestoreIntent,
  type RestoreIntent,
} from '../../electron/BackupService.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-backup-restore-'));
}

describe('BackupService.restoreFrom', () => {
  let dir: string;
  let dbPath: string;
  let backupsDir: string;
  let service: BackupService;

  beforeEach(() => {
    dir = tempDir();
    dbPath = path.join(dir, 'metis.db');
    backupsDir = path.join(dir, 'backups');
    const store = new PersistenceStore(dbPath);
    store.savePaper({
      id: 'p-original', title: 'Original', authors: [], year: 2024, venue: '',
      abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: 1,
    });
    store.close();
    service = new BackupService(new PersistenceStore(dbPath), backupsDir, dbPath);
  });

  afterEach(() => {
    // Close any open database connections before removing the directory.
    try { (service as unknown as { store: PersistenceStore }).store.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore EPERM */ }
  });

  it('restores the database from a valid backup', async () => {
    // Create a backup first.
    const backup = await service.runBackup();
    expect(backup.ok).toBe(true);
    expect(backup.destination).toBeTruthy();

    // Mutate the current db (add a different paper).
    const current = new PersistenceStore(dbPath);
    current.savePaper({
      id: 'p-mutated', title: 'Mutated', authors: [], year: 2024, venue: '',
      abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: 1,
    });
    current.close();

    // Restore from the backup — should roll back the mutation.
    const result = await service.restoreFrom(backup.destination!);
    expect(result.ok).toBe(true);

    // Verify the restored db has the original paper, not the mutated one.
    const restored = new PersistenceStore(dbPath);
    const papers = restored.getPapers().map((p) => p.id);
    expect(papers).toContain('p-original');
    expect(papers).not.toContain('p-mutated');
    restored.close();
  });

  it('creates a rollback snapshot before restoring', async () => {
    const backup = await service.runBackup();
    expect(backup.ok).toBe(true);
    const before = service.listBackups();
    await service.restoreFrom(backup.destination!);
    const after = service.listBackups();
    // A new backup should have been created as rollback (count increases).
    expect(after.length).toBeGreaterThanOrEqual(before.length);
  });

  it('fails closed when the backup file is not a valid SQLite database', async () => {
    const badPath = path.join(dir, 'bad.db');
    fs.writeFileSync(badPath, 'not a sqlite database');
    const result = await service.restoreFrom(badPath);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('fails closed when the backup file does not exist', async () => {
    const result = await service.restoreFrom(path.join(dir, 'nonexistent.db'));
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ─── task 1 §八: the controlled-restore state machine ────────────────────────

describe('BackupService.restoreFrom — restart semantics and intent', () => {
  let dir: string;
  let dbPath: string;
  let backupsDir: string;
  let store: PersistenceStore;
  let service: BackupService;
  let calls: { drain: number; restart: number; failure: string[] };

  beforeEach(() => {
    dir = tempDir();
    dbPath = path.join(dir, 'metis.db');
    backupsDir = path.join(dir, 'backups');
    store = new PersistenceStore(dbPath);
    service = new BackupService(store, backupsDir, dbPath);
    calls = { drain: 0, restart: 0, failure: [] };
  });

  afterEach(() => {
    try { store.close(); } catch { /* already closed by the restore flow */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore EPERM */ }
  });

  it('drains → writes intent → swaps atomically → requests a full restart (no hot rebind)', async () => {
    store.raw.prepare("INSERT INTO papers (id, title, added_at) VALUES ('p1', '旧数据', 1)").run();
    const backup = await service.runBackup();
    expect(backup.ok).toBe(true);

    // The live database moves on after the snapshot was taken.
    store.raw.prepare("UPDATE papers SET title = '新数据' WHERE id = 'p1'").run();

    const result = await service.restoreFrom(backup.destination!, {
      restart: () => { calls.restart += 1; },
      onFailure: (message) => { calls.failure.push(message); },
      drain: () => { calls.drain += 1; },
    });

    expect(result.ok).toBe(true);
    expect(result.rollback).toBeTruthy();
    expect(calls.drain).toBe(1);
    expect(calls.failure).toEqual([]);
    // The restart is scheduled ~600ms out so the IPC reply can flush first.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(calls.restart).toBe(1);
    // The intent survives the swap on purpose: the NEXT boot clears it after its
    // startup health checks pass — no service was ever rebound to a new store.
    const intent = readRestoreIntent(dbPath);
    expect(intent).not.toBeNull();
    expect(intent?.backupPath).toBe(backup.destination);

    // Verify the swapped file through a fresh connection (as the next boot would).
    store.close();
    const reopened = new PersistenceStore(dbPath);
    const title = (reopened.raw.prepare("SELECT title FROM papers WHERE id = 'p1'").get() as { title: string }).title;
    expect(title).toBe('旧数据');
    expect(reopened.getStartupHealthReport()?.ok).toBe(true);
    clearRestoreIntent(dbPath);
    reopened.close();
  });

  it('an invalid backup leaves no intent behind and never touches the live database', async () => {
    const garbage = path.join(dir, 'garbage.db');
    fs.writeFileSync(garbage, 'not a database'.repeat(50));
    store.raw.prepare("INSERT INTO papers (id, title, added_at) VALUES ('p1', '重要数据', 1)").run();

    const result = await service.restoreFrom(garbage, {
      restart: () => { calls.restart += 1; },
      onFailure: (message) => { calls.failure.push(message); },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^backup_invalid/);
    expect(calls.restart).toBe(0);
    expect(readRestoreIntent(dbPath)).toBeNull();
    const title = (store.raw.prepare("SELECT title FROM papers WHERE id = 'p1'").get() as { title: string }).title;
    expect(title).toBe('重要数据');
  });

  it('validateBackupFile accepts a real database and rejects garbage', async () => {
    expect(validateBackupFile(dbPath).ok).toBe(true);
    const garbage = path.join(dir, 'garbage.db');
    fs.writeFileSync(garbage, 'this is definitely not sqlite'.repeat(10));
    expect(validateBackupFile(garbage).ok).toBe(false);
  });
});

describe('restore intent — crash windows and rollback', () => {
  it('round-trips the intent; malformed files read as absent', () => {
    const dir = tempDir();
    try {
      const dbPath = path.join(dir, 'metis.db');
      expect(readRestoreIntent(dbPath)).toBeNull();
      const intent: RestoreIntent = {
        backupPath: path.join(dir, 'want.db'),
        rollbackPath: path.join(dir, 'rollback.db'),
        dbPath,
        requestedAt: 12345,
      };
      writeRestoreIntent(dbPath, intent);
      expect(readRestoreIntent(dbPath)).toEqual(intent);
      fs.writeFileSync(restoreIntentPathFor(dbPath), '{ broken json');
      expect(readRestoreIntent(dbPath)).toBeNull();
      clearRestoreIntent(dbPath);
      expect(readRestoreIntent(dbPath)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rollbackFromIntent restores the pre-restore snapshot and clears the intent', async () => {
    const dir = tempDir();
    try {
      const dbPath = path.join(dir, 'metis.db');
      const backupsDir = path.join(dir, 'backups');

      const first = new PersistenceStore(dbPath);
      first.raw.prepare("INSERT INTO papers (id, title, added_at) VALUES ('p1', '恢复前状态', 1)").run();
      const snapshotService = new BackupService(first, backupsDir, dbPath);
      const snapshot = await snapshotService.runBackup();
      expect(snapshot.ok).toBe(true);
      first.close();

      // A failed restore leaves its (bad) data plus the intent behind.
      const broken = path.join(dir, 'broken.db');
      fs.copyFileSync(dbPath, broken);
      const raw = new Database(broken);
      raw.prepare("UPDATE papers SET title = '恢复后损坏数据' WHERE id = 'p1'").run();
      raw.close();
      fs.copyFileSync(broken, dbPath);
      const intent: RestoreIntent = { backupPath: broken, rollbackPath: snapshot.destination!, dbPath, requestedAt: 1 };
      writeRestoreIntent(dbPath, intent);

      const rolled = BackupService.rollbackFromIntent(intent);
      expect(rolled.ok).toBe(true);
      expect(readRestoreIntent(dbPath)).toBeNull();

      const recovered = new PersistenceStore(dbPath);
      const title = (recovered.raw.prepare("SELECT title FROM papers WHERE id = 'p1'").get() as { title: string }).title;
      expect(title).toBe('恢复前状态');
      recovered.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails the rollback when the recorded snapshot file is gone', () => {
    const dir = tempDir();
    try {
      const dbPath = path.join(dir, 'metis.db');
      const intent: RestoreIntent = { backupPath: 'x', rollbackPath: path.join(dir, 'missing.db'), dbPath, requestedAt: 1 };
      writeRestoreIntent(dbPath, intent);
      const rolled = BackupService.rollbackFromIntent(intent);
      expect(rolled.ok).toBe(false);
      expect(rolled.error).toMatch(/missing/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
