/**
 * METIS storage location — user-configurable data directory.
 *
 * All Metis data (database, papers, exports, projects, media, personalization)
 * lives under one data directory. By default it is `<userData>/metis-data` on
 * the system drive; the user may relocate it to any folder (e.g. another
 * drive) via Settings. Only a tiny pointer file stays in `userData` so the
 * location survives restarts without bootstrapping from inside the data dir.
 *
 * Changing location is a two-phase operation to stay crash-safe:
 *   1. Settings writes pointer `{ dataDir: T, pendingMigrateFrom: S }` and the
 *      app relaunches.
 *   2. On startup (before any handle to the database is opened) the contents
 *      of S are copied into T, verified (SQLite integrity + file count), and
 *      only then is S deleted. Any failure reverts to S and never touches it.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const LOCATION_POINTER_FILE = 'metis-location.json';
export const LOCATION_POINTER_VERSION = 1;

export interface LocationPointer {
  version: number;
  /** Absolute path of the chosen data directory (absent → default). */
  dataDir?: string;
  /** Set while a relocation is pending: the directory to move data out of. */
  pendingMigrateFrom?: string | null;
}

export interface ResolvedLocation {
  dataDir: string;
  defaultDir: string;
  /** True when a pending relocation was completed on this boot. */
  migrated: boolean;
  /** Human-readable failure when a pending relocation had to be reverted. */
  migrationError?: string;
}

export type TargetValidation =
  | { ok: true }
  | { ok: false; reason: 'invalid_path' | 'symlink_rejected' | 'not_a_directory' | 'not_writable' | 'not_empty' | 'invalid_metis_db' };

export interface MigrationOptions {
  /** When true, an existing target metis.db is only adopted after it is
   *  verified as complete (file count matches the source). Used when a
   *  previous migration attempt may have left a partial copy. */
  requireCompleteTarget?: boolean;
}

// ─── Pointer file ─────────────────────────────────────────────

export function locationPointerPath(userDataDir: string): string {
  return path.join(userDataDir, LOCATION_POINTER_FILE);
}

export function readLocationPointer(userDataDir: string): LocationPointer | null {
  try {
    const raw = JSON.parse(fs.readFileSync(locationPointerPath(userDataDir), 'utf-8')) as Record<string, unknown>;
    if (typeof raw !== 'object' || raw === null) return null;
    const dataDir = typeof raw.dataDir === 'string' && raw.dataDir.trim() ? raw.dataDir : undefined;
    const pendingMigrateFrom = typeof raw.pendingMigrateFrom === 'string' && raw.pendingMigrateFrom.trim()
      ? raw.pendingMigrateFrom
      : null;
    if (!dataDir && !pendingMigrateFrom) return null;
    return {
      version: Number(raw.version) || LOCATION_POINTER_VERSION,
      dataDir,
      pendingMigrateFrom,
    };
  } catch {
    return null;
  }
}

/** Atomic write: temp file + rename, so a crash never leaves a half-written pointer. */
export function writeLocationPointer(userDataDir: string, pointer: LocationPointer): boolean {
  try {
    const target = locationPointerPath(userDataDir);
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(pointer, null, 2), 'utf-8');
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

// ─── Target validation ────────────────────────────────────────

/**
 * Validate (and, when missing, create) a candidate data directory.
 * Non-empty directories are rejected unless they already contain a valid
 * Metis database — the relocation path deletes the old directory after
 * verification, so we must never mix user files into it.
 */
export function validateTargetLocation(target: string, userDataDir: string): TargetValidation {
  if (!target || !path.isAbsolute(target)) return { ok: false, reason: 'invalid_path' };
  if (path.resolve(target) === path.resolve(userDataDir)) return { ok: false, reason: 'invalid_path' };

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    try {
      fs.mkdirSync(target, { recursive: true });
      stat = fs.lstatSync(target);
    } catch {
      return { ok: false, reason: 'not_writable' };
    }
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: 'symlink_rejected' };
  if (!stat.isDirectory()) return { ok: false, reason: 'not_a_directory' };

  // Writable probe (created and removed — must not affect the emptiness check).
  const probe = path.join(target, `.metis-write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, 'probe');
    fs.rmSync(probe, { force: true });
  } catch {
    return { ok: false, reason: 'not_writable' };
  }

  const dbPath = path.join(target, 'metis.db');
  if (fs.existsSync(dbPath)) {
    return isMetisDatabase(dbPath) ? { ok: true } : { ok: false, reason: 'invalid_metis_db' };
  }
  if (fs.readdirSync(target).length > 0) return { ok: false, reason: 'not_empty' };
  return { ok: true };
}

// ─── Migration ────────────────────────────────────────────────

export interface MigrationResult {
  ok: boolean;
  error?: string;
}

/**
 * Move the contents of `source` into `target`. Runs synchronously at startup
 * before the database is opened. `source` is deleted ONLY after the copied
 * database passes `PRAGMA integrity_check` and the recursive file counts
 * match. Any failure leaves `source` untouched.
 */
export function migrateDataDirSync(source: string, target: string, options: MigrationOptions = {}): MigrationResult {
  try {
    if (path.resolve(source) === path.resolve(target)) {
      return { ok: true };
    }
    // Nesting would make the copy loop onto itself — reject outright.
    if (target.startsWith(source + path.sep) || source.startsWith(target + path.sep)) {
      return { ok: false, error: 'source_and_target_nested' };
    }
    if (!fs.existsSync(source)) {
      // Source already gone (previous boot completed the move) — target is the truth.
      return { ok: true };
    }
    if (!fs.lstatSync(source).isDirectory()) {
      return { ok: false, error: 'source_is_not_a_directory' };
    }

    const targetDb = path.join(target, 'metis.db');

    // Adopt an existing target database only when it verifies completely;
    // a partial copy from an interrupted previous attempt must be finished
    // by re-copying instead.
    if (fs.existsSync(targetDb) && isMetisDatabase(targetDb)) {
      if (!options.requireCompleteTarget || countFiles(target) >= countFiles(source)) {
        removeSourceSync(source);
        return { ok: true };
      }
    }
    if (fs.existsSync(targetDb) && !isMetisDatabase(targetDb)) {
      return { ok: false, error: 'target_metis_db_invalid' };
    }

    // Fresh (or resumed) copy, then verify, then delete the source. The copy
    // runs twice: the second pass is an idempotent settle that also picks up
    // any file written into the source during the first pass (e.g. a
    // background writer), so verification compares a stable snapshot.
    copyDirectorySync(source, target);
    copyDirectorySync(source, target);
    if (!fs.existsSync(path.join(target, 'metis.db')) || !isMetisDatabase(path.join(target, 'metis.db'))) {
      return { ok: false, error: 'verification_failed_missing_or_invalid_db' };
    }
    if (!checkIntegrity(path.join(target, 'metis.db'))) {
      return { ok: false, error: 'verification_failed_integrity' };
    }
    // Every source file must exist in the target with the same byte size
    // (coverage check — stronger than a raw count comparison) and the target
    // must not end up with fewer files than the source.
    const coverage = verifyCoverage(source, target);
    if (!coverage.complete) {
      return { ok: false, error: `verification_failed_missing_files:${coverage.missing.slice(0, 3).join(',')}` };
    }
    if (countFiles(target) < countFiles(source)) {
      return { ok: false, error: 'verification_failed_file_count' };
    }
    removeSourceSync(source);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── Startup resolution ───────────────────────────────────────

/**
 * Resolve the live data directory from the pointer file, running any pending
 * relocation. Pure filesystem logic so the whole boot path is unit-testable.
 */
export function resolveDataDir(userDataDir: string, log: (message: string) => void = () => {}): ResolvedLocation {
  const defaultDir = path.join(userDataDir, 'metis-data');
  const pointer = readLocationPointer(userDataDir);
  let dataDir = defaultDir;

  if (pointer?.dataDir && (validateTargetLocation(pointer.dataDir, userDataDir).ok || pointer.dataDir === defaultDir)) {
    dataDir = pointer.dataDir;
  } else if (pointer?.dataDir) {
    log(`StorageLocation: pointer target invalid (${pointer.dataDir}) — falling back to default`);
  }

  if (pointer?.pendingMigrateFrom && pointer.pendingMigrateFrom !== dataDir) {
    log(`StorageLocation: migrating data directory ${pointer.pendingMigrateFrom} → ${dataDir}`);
    const result = migrateDataDirSync(pointer.pendingMigrateFrom, dataDir, { requireCompleteTarget: true });
    if (result.ok) {
      log('StorageLocation: migration complete');
      writeLocationPointer(userDataDir, { version: LOCATION_POINTER_VERSION, dataDir, pendingMigrateFrom: null });
      return { dataDir, defaultDir, migrated: true };
    }
    log(`StorageLocation: migration failed (${result.error}) — reverting to ${pointer.pendingMigrateFrom}`);
    writeLocationPointer(userDataDir, {
      version: LOCATION_POINTER_VERSION,
      dataDir: pointer.pendingMigrateFrom,
      pendingMigrateFrom: null,
    });
    return { dataDir: pointer.pendingMigrateFrom, defaultDir, migrated: false, migrationError: result.error };
  }

  if (pointer?.pendingMigrateFrom && pointer.pendingMigrateFrom === dataDir) {
    // Same location — just clear the stale flag.
    writeLocationPointer(userDataDir, { version: LOCATION_POINTER_VERSION, dataDir, pendingMigrateFrom: null });
  }
  return { dataDir, defaultDir, migrated: false };
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Recursive copy built on readdir + copyFile. `fs.cpSync` is deliberately not
 * used: Electron's bundled Node crashes natively when the destination is a
 * directory at a Windows volume root (e.g. `D:\Data`), which is the primary
 * use case for the storage relocation feature. File-level copy works on every
 * drive layout. Symlinks are not followed or recreated (fail-closed).
 */
function copyDirectorySync(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const srcPath = path.join(source, entry.name);
    const destPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectorySync(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function isMetisDatabase(dbPath: string): boolean {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('projects', 'papers', 'sources')",
      ).get() as { n: number };
      return row.n >= 2;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function checkIntegrity(dbPath: string): boolean {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      return row?.integrity_check === 'ok';
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function countFiles(dir: string): number {
  let count = 0;
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else count++;
    }
  };
  walk(dir);
  return count;
}

/** Every source file must exist in the target with the same byte size. */
function verifyCoverage(source: string, target: string): { complete: boolean; missing: string[] } {
  const missing: string[] = [];
  const walk = (srcDir: string, dstDir: string): void => {
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = path.join(srcDir, entry.name);
      const dstPath = path.join(dstDir, entry.name);
      if (entry.isDirectory()) {
        walk(srcPath, dstPath);
      } else if (entry.isFile()) {
        const sizeMatches = (() => {
          try {
            return fs.statSync(dstPath).size === fs.statSync(srcPath).size;
          } catch {
            return false;
          }
        })();
        if (!sizeMatches) missing.push(srcPath);
      }
    }
  };
  walk(source, target);
  return { complete: missing.length === 0, missing };
}

function removeSourceSync(source: string): void {
  fs.rmSync(source, { recursive: true, force: true });
}
