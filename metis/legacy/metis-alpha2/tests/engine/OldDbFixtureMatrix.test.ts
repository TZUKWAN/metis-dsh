/**
 * Old database fixture matrix (task 1 §十) + schema convergence (drift) check.
 *
 * Every fixture builds an old-shaped database WITH user data, then runs the real
 * startup path twice:   open → migrate → validate → reopen → validate.
 * "validate" = startup health report ok + the user data is intact and readable
 * through the migrated columns. The second open must apply nothing (idempotent).
 *
 * Convergence: after the pipeline, every upgraded fixture must have exactly the
 * same tables/columns/indexes as a freshly created database — the guarantee that
 * "fresh DB" and "old DB upgrade" are the same schema.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-olddb-'));
}

/** Windows: some handle in the test process still holds a file; retry, then diagnose. */
async function rmDirRetry(dir: string, attempts = 6): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt >= attempts) {
        let leftovers = '';
        try {
          leftovers = fs.readdirSync(dir, { recursive: true }).join(', ');
        } catch { /* dir already gone */ }
        throw new Error(`cleanup failed for ${dir}; leftover entries: [${leftovers}]`, { cause: err });
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

/** Stable schema signature: tables + their column sets + named indexes (order-free). */
function schemaSignature(dbPath: string): { tables: Record<string, string[]>; indexes: string[] } {
  const raw = new Database(dbPath, { readonly: true });
  try {
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
      .map((row) => row.name);
    const result: Record<string, string[]> = {};
    for (const table of tables) {
      result[table] = (raw.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
        .map((row) => row.name).sort();
    }
    const indexes = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name").all() as Array<{ name: string }>)
      .map((row) => row.name);
    return { tables: result, indexes };
  } finally {
    raw.close();
  }
}

/** open → migrate → validate → reopen → validate. Returns the first-open migration result. */
function upgradeTwice(dbPath: string, validate: (store: PersistenceStore) => void): { applied: number[]; baselineCreated: boolean } {
  const first = new PersistenceStore(dbPath);
  try {
    expect(first.getStartupHealthReport()?.ok).toBe(true);
    const result = first.getLastMigrationResult();
    expect(result?.failed).toBeUndefined();
    validate(first);
    const applied = result?.appliedVersions ?? [];
    const baselineCreated = (first.raw.prepare("SELECT COUNT(*) c FROM migration_log WHERE status = 'baseline_applied'").get() as { c: number }).c > 0;
    first.close();

    const second = new PersistenceStore(dbPath);
    try {
      expect(second.getStartupHealthReport()?.ok).toBe(true);
      expect(second.getLastMigrationResult()?.appliedVersions).toEqual([]);
      validate(second);
    } finally {
      second.close();
    }
    return { applied, baselineCreated };
  } catch (err) {
    try { first.close(); } catch { /* already closed */ }
    throw err;
  }
}

// ─── fixture builders (each returns the seeded database path) ────────────────

/** 1. The oldest baseline: only the original tables, none of the migrated columns. */
function buildOldBaseline(dir: string): string {
  const dbPath = path.join(dir, 'old-baseline.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_activity INTEGER NOT NULL, message_count INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', tool_calls TEXT, tool_call_id TEXT, name TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, FOREIGN KEY (session_id) REFERENCES sessions(id));
    CREATE INDEX idx_messages_session ON messages(session_id, created_at);
    CREATE TABLE tool_results (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, tool_call_id TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'ok', error TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, FOREIGN KEY (session_id) REFERENCES sessions(id));
    CREATE INDEX idx_tool_results_session ON tool_results(session_id, created_at);
    CREATE TABLE checkpoints (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL, turn_index INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, FOREIGN KEY (session_id) REFERENCES sessions(id));
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, status TEXT NOT NULL, current_step_id TEXT, step_results TEXT NOT NULL DEFAULT '{}', input TEXT NOT NULL DEFAULT '{}', errors TEXT NOT NULL DEFAULT '[]', started_at INTEGER NOT NULL, completed_at INTEGER, metadata TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE eval_runs (id TEXT PRIMARY KEY, suite_name TEXT NOT NULL, status TEXT NOT NULL, success_rate REAL NOT NULL DEFAULT 0, task_count INTEGER NOT NULL DEFAULT 0, passed_count INTEGER NOT NULL DEFAULT 0, results_json TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, completed_at INTEGER);
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    INSERT INTO schema_version (version) VALUES (5);
    CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT NOT NULL, authors TEXT NOT NULL DEFAULT '[]', year INTEGER NOT NULL DEFAULT 0, venue TEXT NOT NULL DEFAULT '', abstract TEXT NOT NULL DEFAULT '', doi TEXT, arxiv_id TEXT, pdf_path TEXT, tags TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '', read_status TEXT NOT NULL DEFAULT 'unread', rating INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL);
    CREATE TABLE collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', paper_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
    CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]', linked_paper_ids TEXT NOT NULL DEFAULT '[]', linked_note_ids TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL);
    CREATE TABLE experiments (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'planned', parameters TEXT NOT NULL DEFAULT '{}', metrics TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    CREATE TABLE memory (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'general', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX idx_memory_category ON memory(category);
    CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, command TEXT NOT NULL, args TEXT NOT NULL DEFAULT '[]', env TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'other', path TEXT, size TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE);
    CREATE INDEX idx_artifacts_session ON artifacts(session_id, created_at);

    INSERT INTO papers (id, title, authors, year, added_at) VALUES ('paper-old', '旧论文', '["作者"]', 2019, 100);
    INSERT INTO notes (id, title, content, updated_at) VALUES ('note-old', '旧笔记', '笔记正文', 100);
    INSERT INTO experiments (id, name, created_at) VALUES ('exp-old', '旧实验', 100);
    INSERT INTO memory (key, value, category, created_at, updated_at) VALUES ('mem-old', '记忆值', 'general', 100, 100);
    INSERT INTO sessions (id, created_at, last_activity, message_count) VALUES ('sess-old', 100, 100, 1);
    INSERT INTO messages (session_id, role, content, created_at) VALUES ('sess-old', 'user', '旧消息', 100);
    INSERT INTO artifacts (id, session_id, name, type, created_at) VALUES ('art-old', 'sess-old', '旧成果', 'other', 100);
  `);
  db.close();
  return dbPath;
}

function validateOldBaseline(store: PersistenceStore): void {
  const raw = store.raw;
  const paper = raw.prepare("SELECT * FROM papers WHERE id = 'paper-old'").get() as Record<string, unknown>;
  expect(paper.title).toBe('旧论文');
  expect(paper.pdf_text).toBe('');
  expect(paper.reference_ids).toBe('[]');
  expect(paper.citation_count).toBe(0);
  const note = raw.prepare("SELECT * FROM notes WHERE id = 'note-old'").get() as Record<string, unknown>;
  expect(note.content).toBe('笔记正文');
  expect(note.scope).toBe('global');
  expect(note.project_id).toBeNull();
  const experiment = raw.prepare("SELECT * FROM experiments WHERE id = 'exp-old'").get() as Record<string, unknown>;
  expect(experiment.name).toBe('旧实验');
  expect(experiment.starred).toBe(0);
  expect(experiment.linked_paper_ids).toBe('[]');
  const memory = raw.prepare("SELECT * FROM memory WHERE key = 'mem-old'").get() as Record<string, unknown>;
  expect(memory.value).toBe('记忆值');
  expect(memory.project_id).toBeNull();
  expect(store.getSession('sess-old')).toBeDefined();
  expect(store.getMessages('sess-old').map((m) => m.content)).toEqual(['旧消息']);
  expect(store.listArtifacts('sess-old').map((a) => a.id)).toEqual(['art-old']);
  // Legacy papers with no project → v100 backfilled the imported-legacy project.
  expect(raw.prepare("SELECT id FROM projects WHERE id = 'proj-imported-legacy'").get()).toBeDefined();
}

/** 2. Everything current except memory predates project_id. */
function buildMemoryWithoutProjectId(dir: string): string {
  const dbPath = path.join(dir, 'memory-no-project.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  db.exec('ALTER TABLE memory DROP COLUMN project_id');
  db.prepare("INSERT INTO memory (key, value, category, created_at, updated_at) VALUES ('k', 'v', 'general', 1, 1)").run();
  db.close();
  return dbPath;
}

/** 3. memory HAS project_id, office_prompt_profiles LACKS global_prompt (the §四 regression shape). */
function buildOfficeWithoutGlobalPrompt(dir: string): string {
  const dbPath = path.join(dir, 'office-no-global.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  db.exec('ALTER TABLE office_prompt_profiles DROP COLUMN global_prompt');
  db.prepare("INSERT INTO memory (key, value, category, project_id, created_at, updated_at) VALUES ('k', 'v', 'general', 'proj-1', 1, 1)").run();
  db.prepare(`
    INSERT INTO office_prompt_profiles (id, office_kind, name, description, builtin, slots_json, created_at, updated_at)
    VALUES ('profile-1', 'ppt', '历史Profile', '', 0, '{"ppt.generation":"历史 action prompt"}', 1, 1)
  `).run();
  db.close();
  return dbPath;
}

/** 4. Legacy session-owned artifacts with content, no project mirrors yet. */
function buildLegacyArtifactDb(dir: string): string {
  const dbPath = path.join(dir, 'legacy-artifacts.db');
  const bare = new Database(dbPath);
  // SCHEMA_SQL alone has no sessions.project_id (that column arrives with v106).
  bare.exec(SCHEMA_SQL);
  bare.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('proj-a', '项目A', 1, 1)").run();
  bare.prepare("INSERT INTO sessions (id, created_at, last_activity, message_count) VALUES ('s-proj', 1, 1, 0)").run();
  bare.prepare("INSERT INTO sessions (id, created_at, last_activity, message_count) VALUES ('s-free', 1, 1, 0)").run();
  bare.prepare("INSERT INTO artifacts (id, session_id, name, type, content, created_at) VALUES ('art-p', 's-proj', '项目成果', 'md', '# 内容', 1)").run();
  bare.prepare("INSERT INTO artifacts (id, session_id, name, type, content, created_at) VALUES ('art-f', 's-free', '自由成果', 'md', '# 自由', 1)").run();
  bare.close();
  // One real pipeline run upgrades the shape; then bind the session to its project so
  // the database represents the pre-dual-write era: legacy artifacts, no mirrors.
  const store = new PersistenceStore(dbPath);
  store.raw.prepare("UPDATE sessions SET project_id = 'proj-a' WHERE id = 's-proj'").run();
  store.close();
  return dbPath;
}

/** 5. Pre-topic-workspace database: the topic tables do not exist yet. */
function buildPreTopicDb(dir: string): string {
  const dbPath = path.join(dir, 'pre-topic.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  db.exec('DROP TABLE topic_messages; DROP TABLE topic_candidates; DROP TABLE topic_sessions;');
  db.prepare("INSERT INTO papers (id, title, added_at) VALUES ('p', '论文', 1)").run();
  db.close();
  return dbPath;
}

/** 6. Pre-capability-vault database. */
function buildPreCapabilityVaultDb(dir: string): string {
  const dbPath = path.join(dir, 'pre-capability.db');
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  db.exec('DROP TABLE capability_vault');
  db.prepare("INSERT INTO papers (id, title, added_at) VALUES ('p', '论文', 1)").run();
  db.close();
  return dbPath;
}

/** 7. Current schema — created by the app itself. */
function buildCurrentDb(dir: string): string {
  const dbPath = path.join(dir, 'current.db');
  const store = new PersistenceStore(dbPath);
  store.raw.prepare("INSERT INTO papers (id, title, added_at) VALUES ('p', '论文', 1)").run();
  store.close();
  return dbPath;
}

// ─── the matrix ──────────────────────────────────────────────

describe('old database fixture matrix — open → migrate → validate → reopen → validate', () => {
  it('1. oldest baseline upgrades with every legacy row intact', () => {
    const dir = tempDir();
    try {
      const dbPath = buildOldBaseline(dir);
      const { applied } = upgradeTwice(dbPath, validateOldBaseline);
      expect(applied.length).toBeGreaterThan(10);
      expect(applied).toContain(100); // legacy project backfill ran
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('2. memory without project_id gains the column and index; legacy memory stays global', () => {
    const dir = tempDir();
    try {
      const dbPath = buildMemoryWithoutProjectId(dir);
      upgradeTwice(dbPath, (store) => {
        const row = store.raw.prepare("SELECT * FROM memory WHERE key = 'k'").get() as Record<string, unknown>;
        expect(row.value).toBe('v');
        expect(row.project_id).toBeNull();
        expect(store.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_memory_project'").get()).toBeDefined();
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('3. memory has project_id but office profiles lack global_prompt → the fix applies independently', () => {
    const dir = tempDir();
    try {
      const dbPath = buildOfficeWithoutGlobalPrompt(dir);
      upgradeTwice(dbPath, (store) => {
        const profile = store.raw.prepare("SELECT * FROM office_prompt_profiles WHERE id = 'profile-1'").get() as Record<string, unknown>;
        expect(profile.global_prompt).toBe('');
        expect(profile.slots_json).toBe('{"ppt.generation":"历史 action prompt"}');
        expect((store.raw.prepare("SELECT project_id FROM memory WHERE key = 'k'").get() as { project_id: string }).project_id).toBe('proj-1');
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4. legacy artifacts survive the upgrade and migrate to project ownership on session deletion', async () => {
    const dir = tempDir();
    try {
      const dbPath = buildLegacyArtifactDb(dir);
      upgradeTwice(dbPath, (store) => {
        expect(store.listArtifacts('s-proj').map((a) => a.id)).toEqual(['art-p']);
        expect(store.getArtifactContent('art-p', 's-proj')?.content).toBe('# 内容');
        expect(store.listArtifacts('s-free').map((a) => a.id)).toEqual(['art-f']);
      });
      // Ownership invariant on the upgraded database.
      const store = new PersistenceStore(dbPath);
      try {
        store.deleteSession('s-proj');
        store.deleteSession('s-free');
        const mirrors = store.raw.prepare('SELECT id, project_id FROM research_artifacts ORDER BY id').all() as Array<{ id: string; project_id: string }>;
        expect(mirrors).toEqual([
          { id: 'ra-art-f', project_id: 'proj-unassigned-artifacts' },
          { id: 'ra-art-p', project_id: 'proj-a' },
        ]);
        expect(store.getStartupHealthReport()?.ok).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      await rmDirRetry(dir);
    }
  }, 90_000);
  it('5. pre-topic database gains the topic tables from the baseline', () => {
    const dir = tempDir();
    try {
      const dbPath = buildPreTopicDb(dir);
      const { baselineCreated } = upgradeTwice(dbPath, (store) => {
        for (const table of ['topic_sessions', 'topic_candidates', 'topic_messages']) {
          expect(store.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeDefined();
        }
        expect((store.raw.prepare("SELECT title FROM papers WHERE id = 'p'").get() as { title: string }).title).toBe('论文');
      });
      expect(baselineCreated).toBe(true); // observability: the baseline logged what it created
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('6. pre-capability-vault database gains capability_vault from the baseline', () => {
    const dir = tempDir();
    try {
      const dbPath = buildPreCapabilityVaultDb(dir);
      upgradeTwice(dbPath, (store) => {
        expect(store.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'capability_vault'").get()).toBeDefined();
        expect(store.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_capability_vault_source'").get()).toBeDefined();
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('7. current-schema database opens with nothing pending and stays healthy', () => {
    const dir = tempDir();
    try {
      const dbPath = buildCurrentDb(dir);
      const { applied } = upgradeTwice(dbPath, (store) => {
        expect((store.raw.prepare("SELECT title FROM papers WHERE id = 'p'").get() as { title: string }).title).toBe('论文');
      });
      expect(applied).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('schema convergence — every upgraded old database equals a fresh database', () => {
  // The convergence probe rebuilds seven databases and diffs the full
  // schema. Local runs finish well under 10s; CI runners are ~3x slower, so
  // the per-test budget is sized for the slowest supported runner instead of
  // the developer machine (resource calibration, not failure masking — the
  // assertion itself is unchanged).
  it('tables, columns and indexes match the fresh schema for all seven fixtures', async () => {
    const dir = tempDir();
    try {
      const freshPath = path.join(dir, 'fresh.db');
      const freshStore = new PersistenceStore(freshPath);
      freshStore.close();
      const fresh = schemaSignature(freshPath);

      const fixtures: Array<[string, (d: string) => string]> = [
        ['old-baseline', buildOldBaseline],
        ['memory-no-project', buildMemoryWithoutProjectId],
        ['office-no-global', buildOfficeWithoutGlobalPrompt],
        ['legacy-artifacts', buildLegacyArtifactDb],
        ['pre-topic', buildPreTopicDb],
        ['pre-capability', buildPreCapabilityVaultDb],
        ['current', buildCurrentDb],
      ];
      for (const [label, build] of fixtures) {
        const subdir = path.join(dir, label);
        fs.mkdirSync(subdir, { recursive: true });
        const dbPath = build(subdir);
        const upgradedStore = new PersistenceStore(dbPath);
        upgradedStore.close();
        const upgraded = schemaSignature(dbPath);
        expect(upgraded.tables, `${label}: table/column drift`).toEqual(fresh.tables);
        expect(upgraded.indexes, `${label}: index drift`).toEqual(fresh.indexes);
      }
    } finally {
      await rmDirRetry(dir);
    }
  }, 120_000);
});
