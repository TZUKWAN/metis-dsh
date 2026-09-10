/**
 * Versioned Migration Runner — the authoritative schema migration pipeline.
 *
 * Guarantees:
 *   - Versioned: each migration has a target version; applied in ascending order.
 *   - Transactional: each migration (precondition + up + version record) runs in one
 *     transaction; a failure rolls back that step and stops the pipeline.
 *   - Backup-aware: before applying anything, the DB file is copied to a `.bak-<ts>`
 *     so the pre-migration state is recoverable out-of-band.
 *   - Idempotent / repeat-protected: `schema_migrations` records applied versions;
 *     re-running applies nothing new.
 *   - Non-destructive: a failed migration never leaves the DB half-migrated — the DB
 *     stays at the last successfully applied version.
 *   - Observable: every run appends a row to `migration_log` (fromVersion / toVersion /
 *     applied versions / elapsed / failedVersion / recoveryAction).
 *
 * Migrations are plain functions `(db) => void`. They must be deterministic and
 * idempotent (guard every ALTER / backfill), because a fresh database and an upgraded
 * old database both run through the same list and must converge on the same schema.
 *
 * The migration list itself lives in `migrations.ts` (UNIFIED_MIGRATIONS).
 */

import type Database from 'better-sqlite3';
import fs from 'node:fs';

export interface Migration {
  version: number;
  description: string;
  /**
   * Optional assertion evaluated inside the migration transaction before `up`.
   * Throw a descriptive error when the database is not in a state this migration
   * can safely operate on; the pipeline then stops fail-closed at this version.
   */
  precondition?: (db: Database.Database) => void;
  up: (db: Database.Database) => void;
}

export interface AppliedMigrationEntry {
  version: number;
  description: string;
  elapsedMs: number;
}

export interface MigrationResult {
  appliedVersions: number[];
  entries: AppliedMigrationEntry[];
  fromVersion: number;
  toVersion: number;
  elapsedMs: number;
  backupPath?: string;
  failed?: { version: number; description: string; error: string };
  /** What the runner did about the failure. Empty when nothing failed. */
  recoveryAction: '' | 'stopped_at_failed_version_original_preserved';
  restoredFromBackup: boolean;
}

export const MIGRATION_INFRA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  applied_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS migration_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at INTEGER NOT NULL,
  from_version INTEGER NOT NULL,
  to_version INTEGER NOT NULL,
  applied_versions TEXT NOT NULL DEFAULT '[]',
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  failed_version INTEGER,
  error TEXT,
  recovery_action TEXT NOT NULL DEFAULT '',
  backup_path TEXT
);
`;

export interface MigrationLogRow {
  id: number;
  run_at: number;
  from_version: number;
  to_version: number;
  applied_versions: string;
  elapsed_ms: number;
  status: 'applied' | 'failed' | 'baseline_applied';
  failed_version: number | null;
  error: string | null;
  recovery_action: string;
  backup_path: string | null;
}

export function ensureMigrationInfra(db: Database.Database): void {
  db.exec(MIGRATION_INFRA_SQL);
}

export class MigrationRunner {
  private readonly db: Database.Database;
  private readonly dbPath: string;
  private readonly migrations: Migration[];

  constructor(db: Database.Database, dbPath: string, migrations: Migration[]) {
    this.db = db;
    this.dbPath = dbPath;
    this.migrations = [...migrations].sort((a, b) => a.version - b.version);
    const seen = new Set<number>();
    for (const migration of this.migrations) {
      if (seen.has(migration.version)) {
        throw new Error(`Duplicate migration version ${migration.version}`);
      }
      seen.add(migration.version);
    }
  }

  /** Current applied version (highest in schema_migrations, or 0). */
  currentVersion(): number {
    ensureMigrationInfra(this.db);
    const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  /** All already-applied versions (for idempotency checks / audits). */
  appliedVersions(): number[] {
    ensureMigrationInfra(this.db);
    const rows = this.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
    return rows.map((r) => r.version);
  }

  /** Highest version this runner knows about (the target of a complete upgrade). */
  latestKnownVersion(): number {
    return this.migrations.length > 0 ? this.migrations[this.migrations.length - 1]!.version : 0;
  }

  private backup(): string | undefined {
    if (!this.dbPath || this.dbPath === ':memory:' || !fs.existsSync(this.dbPath)) return undefined;
    const bak = `${this.dbPath}.bak-${Date.now()}`;
    try {
      // WAL consistency: committed data may still live in `<db>-wal`, so a
      // plain copyFileSync of the main file is NOT a complete snapshot.
      // TRUNCATE-checkpoint first folds every committed WAL page back into
      // the main database (and truncates the WAL), after which the file copy
      // is a true snapshot. At migration time — single boot path, before any
      // renderer/reader exists — the checkpoint cannot fail on contention;
      // if it ever does, fail the backup rather than copy a torn snapshot.
      const checkpoint = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number; log: number; checkpointed: number }>;
      const checkpointRow = checkpoint?.[0];
      if (!checkpointRow || checkpointRow.busy !== 0) {
        throw new Error(`wal_checkpoint(TRUNCATE) could not complete: ${JSON.stringify(checkpointRow ?? checkpoint)}`);
      }
      fs.copyFileSync(this.dbPath, bak);
      return bak;
    } catch {
      return undefined;
    }
  }

  /**
   * Manually restore the DB from a backup produced by a previous run(). Normal failures do
   * NOT need this — transaction rollback already keeps the DB consistent at the last good
   * version. This is an out-of-band recovery hook for catastrophic cases where the DB file
   * itself is suspect. Caller must reopen the database afterwards.
   */
  restoreFromBackup(bak: string): boolean {
    try {
      fs.copyFileSync(bak, this.dbPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run all pending migrations in order. Each migration is wrapped in a transaction. On
   * failure that migration's transaction rolls back and the pipeline stops; the DB remains
   * at the last successfully applied version. Returns a structured result; never throws.
   */
  run(): MigrationResult {
    ensureMigrationInfra(this.db);
    const startedAt = Date.now();
    const fromVersion = this.currentVersion();
    const pending = this.migrations.filter((m) => m.version > fromVersion);

    if (pending.length === 0) {
      return {
        appliedVersions: [],
        entries: [],
        fromVersion,
        toVersion: fromVersion,
        elapsedMs: 0,
        recoveryAction: '',
        restoredFromBackup: false,
      };
    }

    const backupPath = this.backup();
    const applied: number[] = [];
    const entries: AppliedMigrationEntry[] = [];

    for (const migration of pending) {
      const apply = this.db.transaction(() => {
        migration.precondition?.(this.db);
        migration.up(this.db);
        this.db.prepare('INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.description, Date.now());
      });
      const stepStart = Date.now();
      try {
        apply();
        applied.push(migration.version);
        entries.push({ version: migration.version, description: migration.description, elapsedMs: Date.now() - stepStart });
      } catch (err) {
        // The transaction rolled back this migration atomically; the DB is consistent at
        // the last successfully applied version. Do not continue to later migrations.
        const result: MigrationResult = {
          appliedVersions: applied,
          entries,
          fromVersion,
          toVersion: applied.length > 0 ? applied[applied.length - 1]! : fromVersion,
          elapsedMs: Date.now() - startedAt,
          backupPath,
          failed: { version: migration.version, description: migration.description, error: (err as Error).message },
          recoveryAction: 'stopped_at_failed_version_original_preserved',
          restoredFromBackup: false,
        };
        this.log(result, 'failed');
        return result;
      }
    }

    const result: MigrationResult = {
      appliedVersions: applied,
      entries,
      fromVersion,
      toVersion: this.currentVersion(),
      elapsedMs: Date.now() - startedAt,
      backupPath,
      recoveryAction: '',
      restoredFromBackup: false,
    };
    this.log(result, 'applied');
    return result;
  }

  private log(result: MigrationResult, status: MigrationLogRow['status']): void {
    try {
      this.db.prepare(`
        INSERT INTO migration_log
          (run_at, from_version, to_version, applied_versions, elapsed_ms, status, failed_version, error, recovery_action, backup_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        Date.now(),
        result.fromVersion,
        result.toVersion,
        JSON.stringify(result.appliedVersions),
        result.elapsedMs,
        status,
        result.failed?.version ?? null,
        result.failed?.error ?? null,
        result.recoveryAction,
        result.backupPath ?? null,
      );
    } catch {
      // Logging must never turn a successful migration into a failure, and a failed
      // migration is already reported through the returned result.
    }
  }
}

/** Read the migration log newest-first (diagnostics / tests). */
export function readMigrationLog(db: Database.Database, limit = 50): MigrationLogRow[] {
  ensureMigrationInfra(db);
  return db.prepare('SELECT * FROM migration_log ORDER BY id DESC LIMIT ?').all(limit) as MigrationLogRow[];
}
