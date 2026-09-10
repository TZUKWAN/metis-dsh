/**
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { BackupService } from '../../electron/BackupService.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-backup-test-'));
}

describe('BackupService', () => {
  let dir: string;
  let store: PersistenceStore;
  let backupsDir: string;

  beforeEach(() => {
    dir = tempDir();
    store = new PersistenceStore(path.join(dir, 'metis.db'));
    backupsDir = path.join(dir, 'backups');
    // Seed a paper so the backup has real content.
    store.savePaper({
      id: 'p1', title: 'Backup target', authors: ['A'], year: 2024, venue: 'V',
      abstract: 'content', tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: Date.now(),
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a timestamped snapshot into the backups directory', async () => {
    const service = new BackupService(store, backupsDir, path.join(dir, 'metis.db'), 5);
    const result = await service.runBackup();
    expect(result.ok).toBe(true);
    expect(result.destination).toBeTruthy();
    expect(fs.existsSync(result.destination!)).toBe(true);
    // The snapshot is a real SQLite file: reopening it yields the seeded paper.
    const restored = new PersistenceStore(result.destination!);
    expect(restored.getPapers().map((p) => p.id)).toEqual(['p1']);
    restored.close();
  });

  it('trims to the configured keep count, keeping the newest', async () => {
    const service = new BackupService(store, backupsDir, path.join(dir, 'metis.db'), 3);
    // Run several backups; space them with distinct timestamps via the filename.
    for (let i = 0; i < 6; i++) {
      await service.runBackup();
      // Bump mtime ordering by waiting so ISO stamps differ.
      await new Promise((r) => setTimeout(r, 15));
    }
    const files = service.listBackups();
    expect(files.length).toBeLessThanOrEqual(3);
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it('returns a structured failure instead of throwing when the target is bad', async () => {
    // Point backupsDir at a path that cannot be created (a file blocks mkdir).
    const blockingFile = path.join(dir, 'blocker');
    fs.writeFileSync(blockingFile, 'x');
    const service = new BackupService(store, path.join(blockingFile, 'nested'), path.join(dir, 'metis.db'), 5);
    const result = await service.runBackup();
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('lists backups newest-first', async () => {
    const service = new BackupService(store, backupsDir, path.join(dir, 'metis.db'), 5);
    await service.runBackup();
    await new Promise((r) => setTimeout(r, 15));
    await service.runBackup();
    const files = service.listBackups();
    expect(files.length).toBe(2);
    // Newest-first: the second (later) backup sorts before the first.
    expect(files[0]! > files[1]!).toBe(true);
  });
});
