/** Versioned, transactional experiment attachment/run schema migration. */
import Database from 'better-sqlite3';

export const EXPERIMENT_SCRIPT_SCHEMA_VERSION = 3 as const;
export const EXPERIMENT_BINDING_SENTINEL = '0'.repeat(64);

const CREATE_MIGRATIONS = `CREATE TABLE IF NOT EXISTS experiment_script_migrations (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);`;

const CREATE_ATTACHMENTS = `CREATE TABLE IF NOT EXISTS experiment_attachments (
  experiment_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  runtime TEXT NOT NULL CHECK (runtime IN ('python','node')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  managed_path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  owner_binding TEXT NOT NULL DEFAULT '${EXPERIMENT_BINDING_SENTINEL}',
  session_binding TEXT NOT NULL DEFAULT '${EXPERIMENT_BINDING_SENTINEL}',
  attached_at INTEGER NOT NULL,
  PRIMARY KEY (experiment_id, attachment_id)
) WITHOUT ROWID;`;

const CREATE_RUNS = `CREATE TABLE IF NOT EXISTS experiment_runs (
  run_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','failed','timed_out','cancelled','rejected','runtime_unavailable')),
  exit_code INTEGER,
  metrics TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  stdout_log_path TEXT NOT NULL,
  stderr_log_path TEXT NOT NULL,
  cancel_owner_binding TEXT NOT NULL DEFAULT '${EXPERIMENT_BINDING_SENTINEL}',
  FOREIGN KEY (experiment_id, attachment_id)
    REFERENCES experiment_attachments(experiment_id, attachment_id)
    ON DELETE RESTRICT
) WITHOUT ROWID;`;

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function addColumnIfMissing(
  db: Database.Database,
  table: 'experiment_attachments' | 'experiment_runs',
  column: 'owner_binding' | 'session_binding' | 'cancel_owner_binding',
): void {
  if (hasColumn(db, table, column)) return;
  db.exec(
    `ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT '${EXPERIMENT_BINDING_SENTINEL}'`,
  );
}

export function applyExperimentScriptMigration(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec(CREATE_MIGRATIONS);
    db.exec(CREATE_ATTACHMENTS);
    db.exec(CREATE_RUNS);
    addColumnIfMissing(db, 'experiment_attachments', 'owner_binding');
    addColumnIfMissing(db, 'experiment_attachments', 'session_binding');
    addColumnIfMissing(db, 'experiment_runs', 'cancel_owner_binding');
    db.exec('CREATE INDEX IF NOT EXISTS idx_exp_attach_sha256 ON experiment_attachments(content_sha256)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_exp_runs_experiment ON experiment_runs(experiment_id, finished_at DESC)');
    db.prepare(
      `INSERT OR IGNORE INTO experiment_script_migrations (version, description, applied_at)
       VALUES (?, ?, ?)`,
    ).run(
      EXPERIMENT_SCRIPT_SCHEMA_VERSION,
      'explicit owner/session attachment bindings and owner-scoped cancellation',
      Date.now(),
    );
  });
  migrate();
}
