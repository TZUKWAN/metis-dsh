/**
 * UNIFIED_MIGRATIONS — the single source of truth for schema evolution beyond the
 * baseline shape (SCHEMA_SQL).
 *
 * Pipeline executed by PersistenceStore.initializeSchema():
 *   1. ensureBaselineSchema(db)   — SCHEMA_SQL, transactional, every startup, idempotent.
 *                                   Whole NEW tables keep being added to SCHEMA_SQL by
 *                                   feature work; the baseline creates them on any DB.
 *   2. MigrationRunner(UNIFIED_MIGRATIONS).run()
 *                                  — versioned, transactional, backup-aware, logged.
 *                                   Every COLUMN addition / index on a possibly-missing
 *                                   column / data backfill must live here, never as an
 *                                   ad-hoc "PRAGMA table_info + ALTER" at startup.
 *
 * Version numbering starts at 100: an earlier experimental METIS_MIGRATIONS list used
 * versions 1–3 but was never wired into production startup, so no production database
 * can carry those rows; starting at 100 additionally keeps any stray dev/test database
 * that recorded {1,2,3} from accidentally skipping migrations with reused meanings.
 *
 * Convergence rule: a fresh database (baseline creates every table WITH all columns)
 * and an old database (baseline creates missing tables; migrations add missing columns)
 * must end the pipeline with identical tables/columns/indexes — enforced by the
 * fresh-vs-upgraded drift test in the suite.
 */

import type Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';
import type { Migration } from './MigrationRunner.js';
import { applyExperimentScriptMigration } from './ExperimentScriptMigration.js';

// ─── helpers ─────────────────────────────────────────────────

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((row) => row.name === column);
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, ddl: string): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function hasIndex(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
}

/** Precondition helper: fail-closed with a readable message when a required table is absent. */
function requireTables(...tables: string[]) {
  return (db: Database.Database): void => {
    for (const table of tables) {
      if (!tableExists(db, table)) {
        throw new Error(`migration precondition failed: table '${table}' does not exist (baseline schema must run first)`);
      }
    }
  };
}

// ─── the registry ────────────────────────────────────────────

export const UNIFIED_MIGRATIONS: Migration[] = [
  {
    version: 100,
    description: 'METIS-402: backfill a default project for legacy papers (papers exist, no project yet)',
    up: (db) => {
      const hasData = db.prepare('SELECT 1 FROM papers LIMIT 1').get() as object | undefined;
      const hasProject = db.prepare('SELECT 1 FROM projects LIMIT 1').get() as object | undefined;
      if (hasData && !hasProject) {
        const now = Date.now();
        db.prepare(`INSERT INTO projects (id,title,original_intent,lifecycle,created_at,updated_at,source) VALUES (?,?,?,?,?,?,?)`)
          .run('proj-imported-legacy', '导入的历史资料', '从旧版本 Metis 导入', 'archived', now, now, 'migration');
      }
    },
  },
  {
    version: 101,
    description: 'papers: legacy columns pdf_text / citation_count / pdf_url',
    precondition: requireTables('papers'),
    up: (db) => {
      addColumnIfMissing(db, 'papers', 'pdf_text', "pdf_text TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(db, 'papers', 'citation_count', 'citation_count INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'papers', 'pdf_url', 'pdf_url TEXT');
    },
  },
  {
    version: 102,
    description: 'papers: reference_ids column',
    precondition: requireTables('papers'),
    up: (db) => {
      addColumnIfMissing(db, 'papers', 'reference_ids', "reference_ids TEXT NOT NULL DEFAULT '[]'");
    },
  },
  {
    version: 103,
    description: 'papers: project_id column + idx_papers_project_id',
    precondition: requireTables('papers'),
    up: (db) => {
      addColumnIfMissing(db, 'papers', 'project_id', 'project_id TEXT');
      if (!hasIndex(db, 'idx_papers_project_id')) {
        db.exec('CREATE INDEX idx_papers_project_id ON papers (project_id)');
      }
    },
  },
  {
    version: 104,
    description: 'notes: project_id / scope columns, scope backfill, idx_notes_project_scope',
    precondition: requireTables('notes'),
    up: (db) => {
      addColumnIfMissing(db, 'notes', 'project_id', 'project_id TEXT');
      addColumnIfMissing(db, 'notes', 'scope', "scope TEXT NOT NULL DEFAULT 'global'");
      db.exec(`
        UPDATE notes SET scope = 'global' WHERE project_id IS NULL AND scope <> 'global';
        UPDATE notes SET scope = 'research' WHERE project_id IS NOT NULL AND scope <> 'research';
      `);
      if (!hasIndex(db, 'idx_notes_project_scope')) {
        db.exec('CREATE INDEX idx_notes_project_scope ON notes(project_id, scope, updated_at DESC)');
      }
    },
  },
  {
    version: 105,
    description: 'library ↔ project many-to-many: paper_project_links + sources.library_paper_id backfill',
    precondition: requireTables('papers', 'projects', 'sources'),
    up: (db) => {
      addColumnIfMissing(db, 'sources', 'library_paper_id', 'library_paper_id TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS paper_project_links (
          paper_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          linked_at INTEGER NOT NULL,
          PRIMARY KEY (paper_id, project_id),
          FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_paper_project_links_project
          ON paper_project_links(project_id, linked_at DESC);
        INSERT OR IGNORE INTO paper_project_links (paper_id, project_id, linked_at)
          SELECT papers.id, papers.project_id, papers.added_at
          FROM papers
          INNER JOIN projects ON projects.id = papers.project_id
          WHERE papers.project_id IS NOT NULL;
        UPDATE sources
          SET library_paper_id = id
          WHERE library_paper_id IS NULL
            AND EXISTS (
              SELECT 1 FROM papers
              WHERE papers.id = sources.id
                AND papers.project_id = sources.project_id
            );
      `);
      if (!hasIndex(db, 'idx_sources_project_library_paper')) {
        db.exec('CREATE UNIQUE INDEX idx_sources_project_library_paper ON sources(project_id, library_paper_id) WHERE library_paper_id IS NOT NULL');
      }
    },
  },
  {
    version: 106,
    description: 'sessions: project_id column + idx_sessions_project_id',
    precondition: requireTables('sessions'),
    up: (db) => {
      addColumnIfMissing(db, 'sessions', 'project_id', 'project_id TEXT');
      if (!hasIndex(db, 'idx_sessions_project_id')) {
        db.exec('CREATE INDEX idx_sessions_project_id ON sessions (project_id)');
      }
    },
  },
  {
    version: 107,
    description: 'sessions: multi-conversation columns scenario_id / active_artifact_ids',
    precondition: requireTables('sessions'),
    up: (db) => {
      addColumnIfMissing(db, 'sessions', 'scenario_id', 'scenario_id TEXT');
      addColumnIfMissing(db, 'sessions', 'active_artifact_ids', 'active_artifact_ids TEXT');
    },
  },
  {
    version: 108,
    description: 'submission_cases: targeting_json column (投稿选刊前置条件)',
    precondition: requireTables('submission_cases'),
    up: (db) => {
      addColumnIfMissing(db, 'submission_cases', 'targeting_json', "targeting_json TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 109,
    description: 'submission_correspondence: attachment_names / attachment_texts columns',
    precondition: requireTables('submission_correspondence'),
    up: (db) => {
      addColumnIfMissing(db, 'submission_correspondence', 'attachment_names', "attachment_names TEXT NOT NULL DEFAULT '[]'");
      addColumnIfMissing(db, 'submission_correspondence', 'attachment_texts', "attachment_texts TEXT NOT NULL DEFAULT '[]'");
    },
  },
  {
    version: 110,
    description: 'collections table + experiments: linked_paper_ids / script_path / script_type / starred',
    precondition: requireTables('experiments'),
    up: (db) => {
      if (!tableExists(db, 'collections')) {
        db.exec(`
          CREATE TABLE collections (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            paper_ids TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL
          );
        `);
      }
      addColumnIfMissing(db, 'experiments', 'linked_paper_ids', "linked_paper_ids TEXT NOT NULL DEFAULT '[]'");
      addColumnIfMissing(db, 'experiments', 'script_path', 'script_path TEXT');
      addColumnIfMissing(db, 'experiments', 'script_type', 'script_type TEXT');
      addColumnIfMissing(db, 'experiments', 'starred', 'starred INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    version: 111,
    description: 'artifacts (legacy): content column',
    precondition: requireTables('artifacts'),
    up: (db) => {
      addColumnIfMissing(db, 'artifacts', 'content', 'content TEXT');
    },
  },
  {
    version: 112,
    description: 'memory: project_id column + idx_memory_project (decoupled from any other table state)',
    precondition: requireTables('memory'),
    up: (db) => {
      addColumnIfMissing(db, 'memory', 'project_id', 'project_id TEXT');
      if (!hasIndex(db, 'idx_memory_project')) {
        db.exec('CREATE INDEX idx_memory_project ON memory(project_id)');
      }
    },
  },
  {
    version: 113,
    description: 'office_prompt_profiles: global_prompt column — applied unconditionally, independent of the memory table state (regression: this patch used to be nested inside the memory project_id migration and never ran when memory already had project_id)',
    precondition: requireTables('office_prompt_profiles'),
    up: (db) => {
      addColumnIfMissing(db, 'office_prompt_profiles', 'global_prompt', "global_prompt TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 114,
    description: 'papers_fts FTS5 full-text index (contentless; optional when the SQLite build lacks FTS5)',
    precondition: requireTables('papers'),
    up: (db) => {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'papers_fts'").get()) return;
      try {
        db.exec(`
          CREATE VIRTUAL TABLE papers_fts USING fts5(
            title, authors, abstract, pdf_text,
            content='papers', content_rowid='rowid'
          );
        `);
      } catch {
        // FTS5 not available in this SQLite build — the store falls back to LIKE search.
        return;
      }
      try {
        db.exec(`INSERT INTO papers_fts(papers_fts) VALUES('rebuild');`);
      } catch {
        // An empty rebuild failure is non-fatal; the index can be rebuilt later.
      }
    },
  },
  {
    version: 115,
    description: 'experiment script attachments/runs: versioned owner/session bindings (delegates to the transactional experiment-script migration)',
    up: (db) => {
      applyExperimentScriptMigration(db);
    },
  },
  {
    version: 117,
    description: 'topic_sessions: category column (刘总 2026-09 选题会话分类;旧行默认 NULL=未分类)',
    precondition: requireTables('topic_sessions'),
    up: (db) => {
      addColumnIfMissing(db, 'topic_sessions', 'category', 'category TEXT');
    },
  },
];

/**
 * Baseline step: execute SCHEMA_SQL inside a transaction, on every startup.
 * Returns how many objects (tables + indexes) this run actually created, so the
 * caller can log a meaningful 'baseline_applied' entry when the database gained
 * new tables (e.g. a feature added a table to SCHEMA_SQL since the last start).
 */
export function ensureBaselineSchema(db: Database.Database): { createdObjects: number } {
  const countObjects = (): number => {
    const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table', 'index')").get() as { n: number };
    return row.n;
  };
  const before = countObjects();
  const run = db.transaction(() => {
    db.exec(SCHEMA_SQL);
  });
  run();
  return { createdObjects: Math.max(0, countObjects() - before) };
}
