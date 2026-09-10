/**
 * METIS-402 — Migration runner tests.
 *
 * Covers: ordered versioned application; idempotency (re-run skips applied); transaction
 * rollback on a failing migration; backup creation; non-destruction (failed migration does
 * not corrupt the original DB); empty/old/corrupt DB handling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { MigrationRunner, type Migration } from '../../engine/persistence/MigrationRunner.js';
import { UNIFIED_MIGRATIONS, ensureBaselineSchema } from '../../engine/persistence/migrations.js';

function makeMigrations(): Migration[] {
  return [
    { version: 1, description: 'create t1', up: (db) => db.exec('CREATE TABLE t1 (id INTEGER)') },
    { version: 2, description: 'create t2', up: (db) => db.exec('CREATE TABLE t2 (id INTEGER)') },
    { version: 3, description: 'create t3', up: (db) => db.exec('CREATE TABLE t3 (id INTEGER)') },
  ];
}

describe('METIS-402 MigrationRunner — versioned application', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-mig-'));
    dbPath = path.join(dir, 'test.db');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('applies migrations in order from an empty DB', () => {
    const db = new Database(dbPath);
    const runner = new MigrationRunner(db, dbPath, makeMigrations());
    const r = runner.run();
    expect(r.fromVersion).toBe(0);
    expect(r.toVersion).toBe(3);
    expect(r.appliedVersions).toEqual([1, 2, 3]);
    expect(r.failed).toBeUndefined();
    db.close();
  });

  it('is idempotent: re-running applies nothing', () => {
    const db = new Database(dbPath);
    const runner = new MigrationRunner(db, dbPath, makeMigrations());
    runner.run();
    const r2 = runner.run();
    expect(r2.appliedVersions).toEqual([]);
    expect(r2.fromVersion).toBe(3);
    expect(r2.toVersion).toBe(3);
    db.close();
  });

  it('records applied versions in schema_migrations', () => {
    const db = new Database(dbPath);
    const runner = new MigrationRunner(db, dbPath, makeMigrations());
    runner.run();
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
    db.close();
  });
});

describe('METIS-402 MigrationRunner — transaction + rollback on failure', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-mig-'));
    dbPath = path.join(dir, 'test.db');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('a failing migration rolls back its own changes and stops (earlier migrations persist)', () => {
    const db = new Database(dbPath);
    const failing: Migration[] = [
      { version: 1, description: 'ok1', up: (db) => db.exec('CREATE TABLE t1 (id INTEGER)') },
      {
        version: 2,
        description: 'fails',
        up: (db) => {
          db.exec('CREATE TABLE t2 (id INTEGER)');
          throw new Error('deliberate failure');
        },
      },
      { version: 3, description: 'ok3 (should NOT run)', up: (db) => db.exec('CREATE TABLE t3 (id INTEGER)') },
    ];
    const runner = new MigrationRunner(db, dbPath, failing);
    const r = runner.run();
    expect(r.failed?.version).toBe(2);
    expect(r.failed?.error).toMatch(/deliberate failure/);
    expect(r.recoveryAction).toBe('stopped_at_failed_version_original_preserved');
    // t1 applied (version 1 succeeded), t2 rolled back, t3 never ran
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='t1'").get()).toBeDefined();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='t2'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='t3'").get()).toBeUndefined();
    db.close();
  });

  it('a violated precondition stops the pipeline inside the migration transaction', () => {
    const db = new Database(dbPath);
    const failing: Migration[] = [
      {
        version: 1,
        description: 'needs the widget table',
        precondition: (db) => {
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='widget'").get()) {
            throw new Error("precondition failed: table 'widget' does not exist");
          }
        },
        up: () => { throw new Error('up must never run after a violated precondition'); },
      },
    ];
    const r = new MigrationRunner(db, dbPath, failing).run();
    expect(r.failed?.version).toBe(1);
    expect(r.failed?.error).toMatch(/precondition failed/);
    expect(r.appliedVersions).toEqual([]);
    db.close();
  });

  it('logs every run into migration_log (fromVersion/toVersion/elapsed/status)', () => {
    const db = new Database(dbPath);
    const runner = new MigrationRunner(db, dbPath, makeMigrations());
    runner.run();
    runner.run(); // no-op run is not logged (nothing pending) — only real runs are
    const rows = db.prepare('SELECT * FROM migration_log ORDER BY id').all() as Array<{
      status: string; from_version: number; to_version: number; applied_versions: string; elapsed_ms: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('applied');
    expect(rows[0]!.from_version).toBe(0);
    expect(rows[0]!.to_version).toBe(3);
    expect(JSON.parse(rows[0]!.applied_versions)).toEqual([1, 2, 3]);
    expect(rows[0]!.elapsed_ms).toBeGreaterThanOrEqual(0);
    db.close();
  });

  it('creates a backup before running', () => {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE preexisting (x INTEGER)');
    db.close();
    const db2 = new Database(dbPath);
    const runner = new MigrationRunner(db2, dbPath, makeMigrations());
    const r = runner.run();
    expect(r.backupPath).toBeTruthy();
    if (r.backupPath) expect(fs.existsSync(r.backupPath)).toBe(true);
    db2.close();
  });

  it('does NOT destroy the original DB when a migration fails (pre-existing data intact)', () => {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE precious (x INTEGER)');
    db.prepare('INSERT INTO precious (x) VALUES (?)').run(42);
    db.close();
    const failing: Migration[] = [
      { version: 1, description: 'fails', up: () => { throw new Error('boom'); } },
    ];
    const db2 = new Database(dbPath);
    const runner = new MigrationRunner(db2, dbPath, failing);
    const r = runner.run();
    expect(r.failed?.version).toBe(1);
    db2.close();
    // reopen and verify precious data is intact
    const db3 = new Database(dbPath);
    const row = db3.prepare('SELECT x FROM precious').get() as { x: number };
    expect(row.x).toBe(42);
    db3.close();
  });
});

describe('MigrationRunner — the real unified pipeline (baseline + UNIFIED_MIGRATIONS)', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-mig-'));
    dbPath = path.join(dir, 'test.db');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('applies every unified migration to a fresh DB after the baseline and records them', () => {
    const db = new Database(dbPath);
    ensureBaselineSchema(db);
    const runner = new MigrationRunner(db, dbPath, UNIFIED_MIGRATIONS);
    const r = runner.run();
    expect(r.failed).toBeUndefined();
    expect(r.fromVersion).toBe(0);
    expect(r.toVersion).toBe(runner.latestKnownVersion());
    expect(r.appliedVersions).toEqual(UNIFIED_MIGRATIONS.map((m) => m.version));
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='projects'").get()).toBeDefined();
    db.close();
  });

  it('unified versions start at 100 and are unique and ascending (no collision with the retired 1–3 series)', () => {
    const versions = UNIFIED_MIGRATIONS.map((m) => m.version);
    expect(Math.min(...versions)).toBeGreaterThanOrEqual(100);
    expect(new Set(versions).size).toBe(versions.length);
    expect([...versions].sort((a, b) => a - b)).toEqual(versions);
    for (const migration of UNIFIED_MIGRATIONS) expect(migration.description.length).toBeGreaterThan(10);
  });

  it('backfills a default project only when legacy papers exist and no project row exists yet (old DB)', () => {
    const db = new Database(dbPath);
    // simulate an OLD db: legacy papers table with data, no projects table at all
    db.exec(`CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT NOT NULL, authors TEXT NOT NULL DEFAULT '[]', year INTEGER NOT NULL DEFAULT 0, venue TEXT NOT NULL DEFAULT '', abstract TEXT NOT NULL DEFAULT '', doi TEXT, arxiv_id TEXT, pdf_path TEXT, tags TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '', read_status TEXT NOT NULL DEFAULT 'unread', rating INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL)`);
    db.prepare('INSERT INTO papers (id, title, added_at) VALUES (?, ?, ?)').run('p1', 'Legacy', 1);
    db.close();
    const db2 = new Database(dbPath);
    ensureBaselineSchema(db2);
    const r = new MigrationRunner(db2, dbPath, UNIFIED_MIGRATIONS).run();
    expect(r.failed).toBeUndefined();
    const proj = db2.prepare('SELECT id, title FROM projects').get() as { id: string; title: string };
    expect(proj.id).toBe('proj-imported-legacy');
    // the legacy paper gained every migrated column while keeping its data
    const paper = db2.prepare('SELECT title, pdf_text, reference_ids, project_id FROM papers WHERE id = ?').get('p1') as Record<string, unknown>;
    expect(paper.title).toBe('Legacy');
    expect(paper.pdf_text).toBe('');
    expect(paper.reference_ids).toBe('[]');
    db2.close();
  });

  it('does NOT backfill a default project when no legacy papers exist (empty DB)', () => {
    const db = new Database(dbPath);
    ensureBaselineSchema(db);
    new MigrationRunner(db, dbPath, UNIFIED_MIGRATIONS).run();
    const count = (db.prepare('SELECT COUNT(*) c FROM projects').get() as { c: number }).c;
    expect(count).toBe(0);
    db.close();
  });

  it('is idempotent on the real pipeline (second run applies nothing, baseline re-run creates nothing)', () => {
    const db = new Database(dbPath);
    ensureBaselineSchema(db);
    const runner = new MigrationRunner(db, dbPath, UNIFIED_MIGRATIONS);
    runner.run();
    const again = ensureBaselineSchema(db);
    expect(again.createdObjects).toBe(0);
    const r2 = runner.run();
    expect(r2.appliedVersions).toEqual([]);
    expect(r2.fromVersion).toBe(runner.latestKnownVersion());
    db.close();
  });
});
