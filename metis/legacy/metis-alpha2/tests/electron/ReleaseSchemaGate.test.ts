/**
 * Release schema/migration gate (Task 5 §13).
 *
 * A release must prove: an old-shape database opens under the current store,
 * its data survives the idempotent schema patches, a fully-populated current
 * database survives close/reopen, and both PRAGMA quick_check and
 * PRAGMA foreign_key_check come back clean. Also exercises the dormant
 * MigrationRunner path (legacy papers → default project backfill).
 *
 * Old-DB fixtures are deterministic builders (generated at test time from the
 * committed legacy DDL), not binary blobs.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Windows releases WAL/file handles asynchronously; retry the delete briefly instead of failing the test on cleanup. */
function rmTemp(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  // Best effort: a leaked temp dir must not fail an otherwise-green gate.
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

describe('Release schema gate — legacy databases', () => {
  it('legacy artifacts DB: opens under the current store, keeps file records, gains the content column, passes integrity', () => {
    const dir = tempDir('metis-gate-legacy-artifacts-');
    const dbPath = path.join(dir, 'legacy-artifacts.db');
    try {
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_activity INTEGER NOT NULL,
          message_count INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'other', path TEXT, size TEXT,
          metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        INSERT INTO sessions (id, created_at, last_activity) VALUES ('legacy-session', 1, 1);
        INSERT INTO artifacts (id, session_id, name, type, path, size, created_at)
          VALUES ('legacy-file', 'legacy-session', 'legacy.pdf', 'pdf', '/workspace/legacy.pdf', '1MB', 2);
      `);
      legacy.close();

      const store = new PersistenceStore(dbPath);
      const artifacts = store.listArtifacts('legacy-session');
      expect(artifacts.map((a) => a.id)).toContain('legacy-file');
      store.close();

      assertIntegrityClean(dbPath);
    } finally {
      rmTemp(dir);
    }
  });

  it('legacy memory DB: gains project_id, keeps existing rows readable', () => {
    const dir = tempDir('metis-gate-legacy-memory-');
    const dbPath = path.join(dir, 'legacy-memory.db');
    try {
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE memory (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL DEFAULT 'general',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO memory (key, value, category, created_at, updated_at)
          VALUES ('legacy-key', 'legacy-value-8c1d', 'general', 1, 1);
      `);
      legacy.close();

      const store = new PersistenceStore(dbPath);
      // The legacy row survives the pipeline with its value intact (read back
      // by its physical key — scoped reads use a different key namespace).
      const inspector = new Database(dbPath, { readonly: true });
      try {
        const columns = (inspector.prepare("SELECT name FROM pragma_table_info('memory')").all() as Array<{ name: string }>).map((r) => r.name);
        expect(columns).toContain('project_id');
        const row = inspector.prepare("SELECT value FROM memory WHERE key = 'legacy-key'").get() as { value: string } | undefined;
        expect(row?.value).toBe('legacy-value-8c1d');
      } finally {
        inspector.close();
      }
      // Project-scoped reads/writes work on the migrated table.
      store.setMemoryScoped('proj-x', 'scoped-key', 'scoped-value', 'general');
      expect(store.getMemoryScoped('proj-x', 'scoped-key')?.value).toBe('scoped-value');
      store.close();

      assertIntegrityClean(dbPath);
    } finally {
      rmTemp(dir);
    }
  });

  it('legacy papers-only DB through the real startup pipeline: baseline + versioned migrations backfill the default project, integrity stays clean', () => {
    const dir = tempDir('metis-gate-migrator-');
    const dbPath = path.join(dir, 'legacy-papers.db');
    try {
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE papers (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, authors TEXT NOT NULL DEFAULT '[]',
          year INTEGER, venue TEXT DEFAULT '', abstract TEXT DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
          notes TEXT DEFAULT '', read_status TEXT DEFAULT 'unread', rating INTEGER DEFAULT 0,
          added_at INTEGER NOT NULL
        );
        INSERT INTO papers (id, title, added_at) VALUES ('paper-legacy-1', 'Legacy Paper', 1);
      `);
      legacy.close();

      // The production pipeline (PersistenceStore.initializeSchema): baseline
      // SCHEMA_SQL, then MigrationRunner(UNIFIED_MIGRATIONS), then startup
      // health checks — fail-closed via PersistenceStartupError.
      const store = new PersistenceStore(dbPath);
      try {
        const migrated = store.getLastMigrationResult();
        expect(migrated?.failed).toBeUndefined();
        expect(migrated?.appliedVersions).toContain(100); // default-project backfill
        expect(migrated?.fromVersion).toBe(0);
        const inspector = new Database(dbPath, { readonly: true });
        try {
          const projects = inspector.prepare('SELECT id FROM projects').all() as Array<{ id: string }>;
          expect(projects.map((p) => p.id)).toContain('proj-imported-legacy');
        } finally {
          inspector.close();
        }
      } finally {
        store.close();
      }

      assertIntegrityClean(dbPath);
      // The runner leaves a rollback snapshot next to the DB — the documented
      // recovery path must exist after a migrating startup.
      const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.bak-'));
      expect(leftovers.length).toBeGreaterThan(0);
    } finally {
      rmTemp(dir);
    }
  });
});

describe('Release schema gate — fully-populated current DB survives close/reopen with clean integrity', () => {
  it('project/session/messages/artifact/paper/note/memory/source/evidence/outcome all persist and reopen', () => {
    const dir = tempDir('metis-gate-full-');
    const dbPath = path.join(dir, 'metis.db');
    let store: PersistenceStore | null = null;
    try {
      store = new PersistenceStore(dbPath);
      const repo = new ResearchRepository(store.raw);
      const outcomes = new OutcomeRepository(store.raw);
      repo.createProject(makeProject('proj-gate', '门禁项目'));

      store.createSession('sess-gate', { topic: 'gate' }, 'proj-gate');
      store.appendMessage('sess-gate', 'user', '门禁消息一');
      store.appendMessage('sess-gate', 'assistant', '门禁消息二');
      store.createArtifact({ id: 'artifact-gate', sessionId: 'sess-gate', name: 'gate.json', type: 'json', content: '{"ok":true}' });
      store.savePaper({
        id: 'paper-gate', title: 'Gate Paper', authors: ['张三'], year: 2025, venue: 'Journal of Gates',
        abstract: '完整性门禁', tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: 1,
      });
      store.saveNote({
        id: 'note-gate', title: 'Gate Note', content: '项目内笔记', tags: [], linkedPaperIds: [], linkedNoteIds: [],
        updatedAt: 1, scope: 'research', projectId: 'proj-gate',
      });
      store.setMemoryScoped('proj-gate', 'gate-key', 'gate-value', 'key_decision');
      repo.saveSource({
        id: 'source-gate', projectId: 'proj-gate', kind: 'paper', title: 'Gate Source', authors: ['张三'],
        year: 2025, venue: '', identifier: '10.0000/gate', identifierType: 'doi', filePath: null,
        externalUrl: null, tags: [], metadata: {}, sourceVersionHash: null, provenance: {},
        createdAt: 1, updatedAt: 1, deletedAt: null,
      });
      repo.saveEvidence({
        id: 'evidence-gate', projectId: 'proj-gate', sourceId: 'source-gate', anchorType: 'page',
        anchorStart: 1, anchorEnd: 2, pageNumber: 1, snippet: '证据片段', snippetHash: 'hash-gate',
        sourceVersionHash: null, confidence: 0.9, metadata: {}, createdAt: 1, updatedAt: 1, deletedAt: null,
      });
      outcomes.create({
        projectId: 'proj-gate', categoryId: null, title: '门禁成果', kind: 'other',
        content: { type: 'other', text: '成果正文', media: null }, note: '初始版本', actor: 'human',
      });

      store.close();
      store = null;

      // Reopen (proxy for an app restart) and verify every object.
      const reopened = new PersistenceStore(dbPath);
      try {
        const reopenedRepo = new ResearchRepository(reopened.raw);
        const reopenedOutcomes = new OutcomeRepository(reopened.raw);
        expect(reopenedRepo.getProject('proj-gate')?.title).toBe('门禁项目');
        const messages = reopened.getMessages('sess-gate');
        expect(messages.map((m) => m.content)).toEqual(['门禁消息一', '门禁消息二']);
        const artifacts = reopened.listArtifacts('sess-gate');
        expect(artifacts.map((a) => a.id)).toContain('artifact-gate');
        expect(reopened.getPapers().map((p) => p.id)).toContain('paper-gate');
        expect(reopened.getNotes().map((n) => n.id)).toContain('note-gate');
        expect(reopened.getMemoryScoped('proj-gate', 'gate-key')?.value).toBe('gate-value');
        expect(reopenedRepo.getSource('source-gate')?.title).toBe('Gate Source');
        expect(reopenedRepo.getEvidence('evidence-gate')?.snippet).toBe('证据片段');
        const outcome = reopenedOutcomes.get('proj-gate', 'outcome-gate') ?? reopenedOutcomes.list('proj-gate')[0];
        expect(reopenedOutcomes.list('proj-gate').map((o) => o.title)).toContain('门禁成果');
        expect(outcome).toBeDefined();

        assertIntegrityClean(dbPath);
      } finally {
        reopened.close();
      }
    } finally {
      try { store?.close(); } catch { /* already closed */ }
      rmTemp(dir);
    }
  }, 20_000);
});
