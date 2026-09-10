/**
 * Unified schema migration pipeline — PersistenceStore startup path.
 *
 * Covers the regression fixture from task 1 §四 (global_prompt), migration failure
 * rollback on the REAL startup path, and the startup health checks (quick_check /
 * foreign_key_check / schema invariants) that must stop the app fail-closed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { PersistenceStartupError } from '../../engine/persistence/errors.js';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-schema-'));
}

/** Pre-v113 office_prompt_profiles shape: exists, but WITHOUT global_prompt. */
const LEGACY_OFFICE_PROFILES_SQL = `
  CREATE TABLE office_prompt_profiles (
    id TEXT PRIMARY KEY,
    office_kind TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    builtin INTEGER NOT NULL DEFAULT 0,
    slots_json TEXT NOT NULL DEFAULT '{}',
    deleted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

describe('global_prompt migration regression (task 1 §四)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = tempDir();
    dbPath = path.join(dir, 'regression.db');
    const db = new Database(dbPath);
    // The exact fixture: memory ALREADY has project_id (the F12 memory migration ran in
    // an earlier version) while office_prompt_profiles lacks global_prompt. The old
    // migrateMemoryProjectId() nested the global_prompt patch inside
    // `if (!memoryCols.includes('project_id'))` and therefore never applied it here.
    db.exec(`
      CREATE TABLE memory (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'general',
        project_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO memory (key, value, category, project_id, created_at, updated_at)
        VALUES ('k', 'v', 'general', 'proj-1', 1, 1);
      ${LEGACY_OFFICE_PROFILES_SQL}
      INSERT INTO office_prompt_profiles (id, office_kind, name, description, builtin, slots_json, created_at, updated_at)
        VALUES ('profile-action-1', 'review', '审稿行动提示词', '历史 action prompt', 0, '{"action":"请严格审稿"}', 100, 100);
    `);
    db.close();
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('adds global_prompt even when memory already has project_id (decoupled)', () => {
    const store = new PersistenceStore(dbPath);
    const cols = (store.raw.prepare('PRAGMA table_info(office_prompt_profiles)').all() as Array<{ name: string }>)
      .map((row) => row.name);
    expect(cols).toContain('global_prompt');
    store.close();
  });

  it('keeps the original action prompt data intact', () => {
    const store = new PersistenceStore(dbPath);
    const row = store.raw.prepare('SELECT * FROM office_prompt_profiles WHERE id = ?').get('profile-action-1') as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.name).toBe('审稿行动提示词');
    expect(row.slots_json).toBe('{"action":"请严格审稿"}');
    expect(row.global_prompt).toBe('');
    store.close();
  });

  it('never re-runs the ALTER on the second startup (idempotent)', () => {
    const first = new PersistenceStore(dbPath);
    first.close();
    const second = new PersistenceStore(dbPath);
    expect(second.getLastMigrationResult()?.appliedVersions).toEqual([]);
    const logRows = second.raw.prepare("SELECT COUNT(*) c FROM migration_log WHERE status IN ('applied','failed')").get() as { c: number };
    expect(logRows.c).toBe(1); // exactly one real migration run across both startups
    second.close();
  });

  it('records version 113 as the migration that owns the fix', () => {
    const store = new PersistenceStore(dbPath);
    const row = store.raw.prepare('SELECT version, description FROM schema_migrations WHERE version = 113').get() as { description: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.description).toContain('global_prompt');
    store.close();
  });
});

describe('migration failure on the real startup path', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = tempDir();
    dbPath = path.join(dir, 'fail-mid.db');
    // Full healthy database first.
    const store = new PersistenceStore(dbPath);
    store.close();
    // Regression to "mid-pipeline": pretend v105+ never ran (the version rows), drop
    // the index v105 owns (reverting versions does not revert schema objects), and
    // plant dirty legacy data — two sources sharing one (project_id, library_paper_id)
    // pair. v105's CREATE UNIQUE INDEX fails on this shape; the baseline cannot heal data.
    const db = new Database(dbPath);
    try {
      db.prepare('DELETE FROM schema_migrations WHERE version >= 105').run();
      db.exec('DROP INDEX IF EXISTS idx_sources_project_library_paper');
      db.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('proj-dup', '重复数据项目', 1, 1)").run();
      db.prepare(`
        INSERT INTO sources (id, project_id, kind, library_paper_id, created_at, updated_at)
        VALUES ('s1', 'proj-dup', 'paper', 'dup-1', 1, 1), ('s2', 'proj-dup', 'paper', 'dup-1', 1, 1)
      `).run();
    } finally {
      db.close();
    }
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('throws PersistenceStartupError with code schema_migration_failed and the failed version', () => {
    let error: PersistenceStartupError | undefined;
    try {
      new PersistenceStore(dbPath);
    } catch (err) {
      error = err as PersistenceStartupError;
    }
    expect(error).toBeInstanceOf(PersistenceStartupError);
    expect(error?.detail.code).toBe('schema_migration_failed');
    expect(error?.detail.failedVersion).toBe(105);
    expect(error?.userMessage).toContain('数据库升级失败');
    expect(error?.userMessage).not.toMatch(/sqlite|SQL|ALTER/i);
  });

  it('leaves the original database untouched (data readable after the failure)', () => {
    try { new PersistenceStore(dbPath); } catch { /* expected */ }
    const db = new Database(dbPath);
    // Pre-existing rows survive bit-for-bit, including the dirty pair (rollback, not cleanup).
    const sources = db.prepare("SELECT COUNT(*) c FROM sources WHERE project_id = 'proj-dup'").get() as { c: number };
    expect(sources.c).toBe(2);
    const project = db.prepare("SELECT title FROM projects WHERE id = 'proj-dup'").get() as { title: string };
    expect(project.title).toBe('重复数据项目');
    // The pipeline stopped at the failed version: later migrations never ran.
    const maxApplied = (db.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number }).v;
    expect(maxApplied).toBeLessThan(105);
    db.close();
  });

  it('succeeds after the underlying problem is fixed (recovery path)', () => {
    expect(() => new PersistenceStore(dbPath)).toThrow(PersistenceStartupError);
    const db = new Database(dbPath);
    // Deduplicate: the second source loses its (wrong) library pointer.
    db.prepare("UPDATE sources SET library_paper_id = NULL WHERE id = 's2'").run();
    db.close();
    const store = new PersistenceStore(dbPath);
    expect(store.getStartupHealthReport()?.ok).toBe(true);
    expect(store.getLastMigrationResult()?.failed).toBeUndefined();
    store.close();
  });
});

describe('startup health checks (fail-closed)', () => {
  let dir: string;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('fails with integrity_check_failed when foreign keys are violated', { timeout: 90_000 }, () => {
    const dbPath = path.join(dir, 'fk-broken.db');
    const db = new Database(dbPath);
    try {
      db.exec(SCHEMA_SQL);
      // Write a referentially broken message while FK enforcement is off.
      db.pragma('foreign_keys = OFF');
      db.prepare(`
        INSERT INTO messages (id, session_id, role, content, created_at)
        VALUES (1, 'no-such-session', 'user', 'orphan', 1)
      `).run();
    } finally {
      db.close();
    }

    let error: PersistenceStartupError | undefined;
    let unexpected: PersistenceStore | undefined;
    try { unexpected = new PersistenceStore(dbPath); } catch (err) { error = err as PersistenceStartupError; } finally { unexpected?.close(); }
    expect(error).toBeInstanceOf(PersistenceStartupError);
    expect(error?.detail.code).toBe('integrity_check_failed');
    expect(error?.userMessage).toContain('完整性检查失败');
  });

  it('fails with schema_invariant_violation on a half-migrated shape (column recorded as applied but missing)', () => {
    const dbPath = path.join(dir, 'invariant.db');
    // Full pipeline first so every version (incl. v113) is recorded as applied.
    new PersistenceStore(dbPath).close();
    const db = new Database(dbPath);
    try {
      // Simulate a database that was tampered with (or half-copied): the migration
      // ledger claims v113 ran, but the column is gone. Baseline cannot re-add
      // columns and the runner sees no pending work — only the invariant check
      // can catch this before running code hits `no such column`.
      db.exec('ALTER TABLE office_prompt_profiles DROP COLUMN global_prompt');
    } finally {
      db.close();
    }

    let error: PersistenceStartupError | undefined;
    let unexpected: PersistenceStore | undefined;
    try { unexpected = new PersistenceStore(dbPath); } catch (err) { error = err as PersistenceStartupError; } finally { unexpected?.close(); }
    expect(error).toBeInstanceOf(PersistenceStartupError);
    expect(error?.detail.code).toBe('schema_invariant_violation');
    expect(error?.userMessage).toContain('结构校验失败');
    expect(JSON.stringify(error?.detail.report)).toContain("missing column 'office_prompt_profiles.global_prompt'");
  });

  it('passes on a healthy database and reports versions', () => {
    const dbPath = path.join(dir, 'healthy.db');
    const store = new PersistenceStore(dbPath);
    const report = store.getStartupHealthReport();
    expect(report?.ok).toBe(true);
    expect(report?.migrationVersion).toBeGreaterThan(0);
    expect(report?.checks.map((c) => c.name)).toContain('quick_check');
    expect(report?.checks.map((c) => c.name)).toContain('foreign_key_check');
    store.close();
  });
});
