/**
 * Backup / Restore system acceptance (Task 5 §7).
 *
 * Consumes the real BackupService and PersistenceStore — no reimplementation.
 * The full acceptance flow: build a populated database → backup → mutate the
 * live database (new data + destructive delete) → restore → reopen (the app
 * restart proxy, mirroring main.ts's close-and-reopen restore path) → verify
 * every object survived field-accurate, the post-backup mutations are gone,
 * and PRAGMA quick_check / foreign_key_check are clean.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';
import { BackupService } from '../../electron/BackupService.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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

function makeProject(id: string, title: string) {
  return {
    id,
    title,
    originalIntent: '',
    researchQuestion: '',
    lifecycle: 'active',
    methodology: '',
    discipline: '',
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    version: 1,
    source: 'user',
    deletedAt: null,
  };
}

function assertIntegrityClean(dbPath: string): void {
  const inspector = new Database(dbPath, { readonly: true });
  try {
    expect(inspector.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
    expect(inspector.pragma('foreign_key_check')).toEqual([]);
  } finally {
    inspector.close();
  }
}

describe('Backup → mutate → restore → restart → verify (system acceptance)', () => {
  it('round-trips projects, sessions, messages, artifacts, papers, notes, memory, sources, evidence, and outcomes', async () => {
    const dir = tempDir('metis-backup-acceptance-');
    const dbPath = path.join(dir, 'metis.db');
    const backupsDir = path.join(dir, 'backups');
    let service: BackupService | null = null;
    try {
      // ── 1. Build a fully populated database ────────────────────────────
      const store = new PersistenceStore(dbPath);
      const repo = new ResearchRepository(store.raw);
      const outcomes = new OutcomeRepository(store.raw);
      service = new BackupService(store, backupsDir, dbPath);

      repo.createProject(makeProject('proj-ba', '备份验收项目'));
      store.createSession('sess-ba', { topic: 'acceptance' }, 'proj-ba');
      store.appendMessage('sess-ba', 'user', '验收消息一');
      store.appendMessage('sess-ba', 'assistant', '验收消息二');
      store.createArtifact({ id: 'artifact-ba', sessionId: 'sess-ba', name: 'a.json', type: 'json', content: '{"v":1}' });
      store.savePaper({
        id: 'paper-ba', title: 'Backup Paper', authors: ['李四'], year: 2026, venue: 'J. Acceptance',
        abstract: '备份测试', tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: 2,
      });
      store.saveNote({
        id: 'note-ba', title: 'Backup Note', content: '备份验收笔记', tags: [], linkedPaperIds: [], linkedNoteIds: [],
        updatedAt: 2, scope: 'research', projectId: 'proj-ba',
      });
      store.setMemoryScoped('proj-ba', 'ba-key', 'ba-value', 'key_decision');
      repo.saveSource({
        id: 'source-ba', projectId: 'proj-ba', kind: 'paper', title: 'Backup Source', authors: ['李四'],
        year: 2026, venue: '', identifier: '10.0000/backup', identifierType: 'doi', filePath: null,
        externalUrl: null, tags: [], metadata: {}, sourceVersionHash: null, provenance: {},
        createdAt: 2, updatedAt: 2, deletedAt: null,
      });
      repo.saveEvidence({
        id: 'evidence-ba', projectId: 'proj-ba', sourceId: 'source-ba', anchorType: 'page',
        anchorStart: 3, anchorEnd: 4, pageNumber: 2, snippet: '验收证据', snippetHash: 'hash-ba',
        sourceVersionHash: null, confidence: 0.95, metadata: {}, createdAt: 2, updatedAt: 2, deletedAt: null,
      });
      outcomes.create({
        projectId: 'proj-ba', categoryId: null, title: '验收成果', kind: 'other',
        content: { type: 'other', text: '成果正文备份验收', media: null }, note: 'v1', actor: 'human',
      });

      // ── 2. Backup ───────────────────────────────────────────────────────
      const backup = await service.runBackup();
      expect(backup.ok).toBe(true);
      expect(backup.destination).toBeTruthy();
      expect(fs.existsSync(backup.destination!)).toBe(true);
      expect(service.listBackups().length).toBe(1);

      // ── 3. Mutate the live database after the backup ────────────────────
      store.createSession('sess-after-backup', undefined, 'proj-ba');
      store.savePaper({
        id: 'paper-after-backup', title: 'Post Backup Paper', authors: [], year: 2026, venue: '',
        abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: 3,
      });
      outcomes.create({
        projectId: 'proj-ba', categoryId: null, title: '备份后新增成果', kind: 'other',
        content: { type: 'other', text: '不应在恢复后出现', media: null }, note: 'v1', actor: 'human',
      });
      // Destructive delete of pre-backup data (the class of damage restore must undo).
      store.raw.prepare("DELETE FROM artifacts WHERE id = 'artifact-ba'").run();

      // ── 4. Restore (BackupService closes the live store internally) ─────
      const restore = await service.restoreFrom(backup.destination!);
      expect(restore.ok).toBe(true);

      // ── 5. Reopen — the app-restart proxy — and verify every object ─────
      const reopened = new PersistenceStore(dbPath);
      try {
        const reopenedRepo = new ResearchRepository(reopened.raw);
        const reopenedOutcomes = new OutcomeRepository(reopened.raw);

        expect(reopenedRepo.getProject('proj-ba')?.title).toBe('备份验收项目');
        expect(reopened.getMessages('sess-ba').map((m) => m.content)).toEqual(['验收消息一', '验收消息二']);
        const artifacts = reopened.listArtifacts('sess-ba');
        expect(artifacts.map((a) => a.id)).toContain('artifact-ba'); // the delete is undone
        expect(artifacts.find((a) => a.id === 'artifact-ba')?.contentAvailable).toBe(true);
        const restoredContent = (reopened.raw.prepare("SELECT content FROM artifacts WHERE id = 'artifact-ba'").get() as { content: string } | undefined)?.content;
        expect(restoredContent).toBe('{"v":1}');
        const papers = reopened.getPapers().map((p) => p.id);
        expect(papers).toContain('paper-ba');
        expect(papers).not.toContain('paper-after-backup');
        expect(reopened.getNotes().map((n) => n.id)).toContain('note-ba');
        expect(reopened.getMemoryScoped('proj-ba', 'ba-key')?.value).toBe('ba-value');
        expect(reopenedRepo.getSource('source-ba')?.identifier).toBe('10.0000/backup');
        expect(reopenedRepo.getEvidence('evidence-ba')?.snippet).toBe('验收证据');
        const outcomeTitles = reopenedOutcomes.list('proj-ba').map((o) => o.title);
        expect(outcomeTitles).toContain('验收成果');
        expect(outcomeTitles).not.toContain('备份后新增成果');
        // Post-backup session must not survive the restore.
        expect(reopened.getMessages('sess-after-backup')).toEqual([]);

        // ── 6. Integrity after restore ─────────────────────────────────────
        assertIntegrityClean(dbPath);
      } finally {
        reopened.close();
      }
    } finally {
      try { service?.listBackups(); } catch { /* service store already closed by restoreFrom */ }
      rmTemp(dir);
    }
  }, 30_000);

  it('restore refuses a corrupt backup file and keeps the live database untouched', async () => {
    const dir = tempDir('metis-backup-corrupt-');
    const dbPath = path.join(dir, 'metis.db');
    const backupsDir = path.join(dir, 'backups');
    let service: BackupService | null = null;
    try {
      const store = new PersistenceStore(dbPath);
      store.savePaper({
        id: 'paper-c1', title: 'Before', authors: [], year: 2026, venue: '', abstract: '', tags: [],
        notes: '', readStatus: 'unread', rating: 0, addedAt: 1,
      });
      service = new BackupService(store, backupsDir, dbPath);
      const backup = await service.runBackup();
      expect(backup.ok).toBe(true);

      // Corrupt the backup file on disk.
      fs.writeFileSync(backup.destination!, Buffer.from('this is not a sqlite database', 'utf8'));

      const result = await service.restoreFrom(backup.destination!);
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();

      // The live database is still intact and openable.
      const verify = new PersistenceStore(dbPath);
      try {
        expect(verify.getPapers().map((p) => p.id)).toContain('paper-c1');
        assertIntegrityClean(dbPath);
      } finally {
        verify.close();
      }
    } finally {
      rmTemp(dir);
    }
  }, 30_000);
});

// ── P0-7: restore must await a REAL runtime drain, and abort before the swap on timeout ──

import { BackupService as DrainBackupService } from '../../electron/BackupService.js';

describe('restore runtime drain (P0-7)', () => {
  function makeDrainFixture() {
    const dir = tempDir('metis-backup-drain-');
    const dbPath = path.join(dir, 'metis.db');
    const backupsDir = path.join(dir, 'backups');
    const store = new PersistenceStore(dbPath);
    store.savePaper({ id: 'p-drain', title: 'Drain Fixture', authors: [], year: 2026, venue: '', abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: 1 });
    const service = new DrainBackupService(store, backupsDir, dbPath);
    return { dir, dbPath, backupsDir, store, service };
  }

  it('awaits a resolving drain and proceeds with the swap', async () => {
    const fx = makeDrainFixture();
    try {
      const backup = await fx.service.runBackup();
      expect(backup.ok).toBe(true);
      const result = await fx.service.restoreFrom(backup.destination!, {
        drain: async () => ({ timedOut: false }),
        restart: () => undefined,
        onFailure: () => undefined,
      });
      expect(result.ok).toBe(true);
    } finally {
      try { fx.store.close(); } catch { /* closed by restore */ }
      rmTemp(fx.dir);
    }
  }, 30_000);

  it('a drain TIMEOUT aborts BEFORE the swap: original DB stays live and intent is cleared', async () => {
    const fx = makeDrainFixture();
    try {
      const backup = await fx.service.runBackup();
      expect(backup.ok).toBe(true);
      let failureMessage = '';
      const result = await fx.service.restoreFrom(backup.destination!, {
        drain: async () => new Promise<{ timedOut: boolean }>((resolve) => setTimeout(() => resolve({ timedOut: true }), 50)),
        restart: () => undefined,
        onFailure: (message) => { failureMessage = message; },
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('restore_runtime_drain_timeout');

      // Original database untouched and still fully usable.
      const verify = new PersistenceStore(fx.dbPath);
      try {
        expect(verify.getPapers().map((p) => p.id)).toContain('p-drain');
      } finally {
        verify.close();
      }
      // No restore intent left behind for the next boot to trip over.
      expect(fs.existsSync(path.join(fx.dir, 'metis.db.restore-intent.json'))).toBe(false);
      expect(failureMessage).toBe('');
    } finally {
      try { fx.store.close(); } catch { /* still open (no swap happened) */ }
      rmTemp(fx.dir);
    }
  }, 30_000);

  it('a drain REJECTION aborts before the swap and surfaces a stable error', async () => {
    const fx = makeDrainFixture();
    try {
      const backup = await fx.service.runBackup();
      const result = await fx.service.restoreFrom(backup.destination!, {
        drain: async () => { throw new Error('coordinator unavailable'); },
        restart: () => undefined,
        onFailure: () => undefined,
      });
      expect(result.ok).toBe(false);
      expect(String(result.error)).toMatch(/restore_runtime_drain_failed/);
      const verify = new PersistenceStore(fx.dbPath);
      try {
        expect(verify.getPapers().length).toBeGreaterThan(0);
      } finally {
        verify.close();
      }
    } finally {
      try { fx.store.close(); } catch { /* still open */ }
      rmTemp(fx.dir);
    }
  }, 30_000);
});
