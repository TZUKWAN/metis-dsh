/**
 * BackupService — rolling automatic snapshots of the research SQLite database.
 *
 * Uses PersistenceStore.backupTo (better-sqlite3 online backup) to write a
 * timestamped copy into a backups/ directory, then trims to the most recent
 * N snapshots. Designed to run once on app startup and on a periodic timer.
 * Failures are non-fatal: a backup error must never block the app from running.
 *
 * Restore semantics (task 1 §八) — controlled restore through a full app restart,
 * never a hot rebind (a hot rebind would leave every other service holding the
 * closed store):
 *
 *   pick backup → validate SQLite (+ quick_check) → rollback snapshot of the
 *   current DB → write restore intent → drain runtime → atomically swap the DB
 *   file (copy to temp + rename) → full app restart → startup health checks →
 *   clear intent.
 *
 * The intent file lives next to the database (`<db>.restore-intent.json`) and
 * makes every crash window recoverable:
 *   - crash before the swap:            next boot finds the intent, DB is the old
 *                                       one and healthy → intent cleared;
 *   - crash after the swap, before the
 *     clear:                            next boot finds the intent, DB is the new
 *                                       one and healthy → intent cleared;
 *   - swap done but the restored DB
 *     fails startup health checks:      next boot offers rolling back to the
 *                                       rollback snapshot recorded in the intent.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PersistenceStore } from '../engine/persistence/PersistenceStore.js';

const DEFAULT_KEEP = 5;

export interface BackupResult {
  ok: boolean;
  destination?: string;
  totalPages?: number;
  error?: string;
}

export interface RestoreIntent {
  backupPath: string;
  rollbackPath: string;
  dbPath: string;
  requestedAt: number;
}

export interface RestoreHooks {
  /** Fully restart the application (relaunch + exit). Called after a successful swap.
   *  Optional: defaults to relaunching the packaged app after a short delay. */
  restart?: () => void;
  /** Surface a restore failure to the user; the app must not keep running with a
   *  half-restored database. Called when the swap failed after the store was closed.
   *  Optional: defaults to a native error dialog. */
  onFailure?: (message: string) => void;
  /**
   * Stop runtime writers (agent runs, scenario workflows, background queues)
   * before the store is closed. Must await real work: a resolved promise
   * means every writer has settled. `timedOut` true (or a rejection) aborts
   * the restore BEFORE the swap — the original database stays live and the
   * pending restore intent is cleared.
   */
  drain?: () => Promise<{ timedOut: boolean; pending?: unknown[] } | void>;
}

export function restoreIntentPathFor(dbPath: string): string {
  return `${dbPath}.restore-intent.json`;
}

export function readRestoreIntent(dbPath: string): RestoreIntent | null {
  try {
    const raw = fs.readFileSync(restoreIntentPathFor(dbPath), 'utf8');
    const parsed = JSON.parse(raw) as RestoreIntent;
    if (!parsed || typeof parsed.backupPath !== 'string' || typeof parsed.rollbackPath !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeRestoreIntent(dbPath: string, intent: RestoreIntent): void {
  fs.writeFileSync(restoreIntentPathFor(dbPath), JSON.stringify(intent, null, 2), 'utf8');
}

export function clearRestoreIntent(dbPath: string): void {
  try { fs.unlinkSync(restoreIntentPathFor(dbPath)); } catch { /* absent already */ }
}

/** Copy `from` over `to` atomically (same volume): write temp, drop stale WAL sidecars, rename. */
function atomicCopy(from: string, to: string): void {
  const tmp = `${to}.restore-tmp`;
  try {
    fs.copyFileSync(from, tmp);
    fs.rmSync(`${to}-wal`, { force: true });
    fs.rmSync(`${to}-shm`, { force: true });
    fs.renameSync(tmp, to);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
}

/** Validate a candidate backup file is readable SQLite with a clean quick_check. */
export function validateBackupFile(backupPath: string): { ok: boolean; error?: string } {
  let db: Database.Database;
  try {
    db = new Database(backupPath, { readonly: true });
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
  try {
    const check = db.pragma('quick_check', { simple: true }) as unknown;
    return check === 'ok' ? { ok: true } : { ok: false, error: `quick_check: ${String(check)}` };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  } finally {
    db.close();
  }
}

// Default restore hooks. `electron` is imported lazily so unit tests can exercise
// BackupService under plain Node without loading the electron package.
/** Relaunch + exit ~600ms later, letting the caller's IPC reply flush first.
 *  No-op outside a real Electron main process (e.g. unit tests under Node). */
function defaultRestartAfterDelay(): void {
  void import('electron').then((electron) => {
    const app = (electron as { app?: { relaunch(): void; exit(code: number): void } }).app;
    if (!app || typeof app.relaunch !== 'function') return;
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 600);
  }).catch(() => { /* not in an Electron main process */ });
}

/** Modal failure dialog; quitting is the only way out of a half-swapped database. */
function defaultRestoreFailureDialog(message: string): void {
  void import('electron').then((electron) => {
    const { app, dialog } = electron as {
      app?: { exit(code: number): void };
      dialog?: { showMessageBox(options: unknown): Promise<unknown> };
    };
    if (!dialog || !app) return;
    void dialog.showMessageBox({ type: 'error', title: 'METIS', buttons: ['退出'], noLink: true, message })
      .finally(() => app.exit(1));
  }).catch(() => { /* not in an Electron main process */ });
}

export class BackupService {
  constructor(
    private store: PersistenceStore,
    private readonly backupsDir: string,
    private readonly dbPath: string,
    private readonly keep = DEFAULT_KEEP,
  ) {
    try {
      fs.mkdirSync(this.backupsDir, { recursive: true });
    } catch {
      // Directory creation is best-effort; runBackup will report the failure.
    }
  }

  /** Run a single rolling backup and trim old snapshots. */
  async runBackup(): Promise<BackupResult> {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const destination = path.join(this.backupsDir, `metis-${stamp}.db`);
      const meta = await this.store.backupTo(destination);
      this.trimOldBackups();
      return { ok: true, destination: meta.destination, totalPages: meta.totalPages };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  }

  /** List existing backup files, newest first. */
  listBackups(): string[] {
    try {
      return fs.readdirSync(this.backupsDir)
        .filter((f) => /^metis-.+\.db$/u.test(f))
        .sort()
        .reverse()
        .map((f) => path.join(this.backupsDir, f));
    } catch {
      return [];
    }
  }

  /** Keep only the most recent `keep` backup files. */
  private trimOldBackups(): void {
    const files = this.listBackups();
    if (files.length <= this.keep) return;
    for (const stale of files.slice(this.keep)) {
      try { fs.unlinkSync(stale); } catch { /* best-effort */ }
    }
  }

  /**
   * Restore through a controlled restart (see the module doc for the state machine).
   *
   * `hooks` is optional: when a domain IPC registrar (Task 3) calls this without
   * wiring, sensible Electron defaults apply — the rolling-backup timer is not
   * drained (a backup attempt on the closed store fails harmlessly and is logged),
   * the restart happens ~600ms after this resolves so the IPC reply reaches the
   * renderer first, and swap failures show a modal error before quitting.
   *
   * The returned result is delivered to the renderer BEFORE the restart is scheduled.
   */
  async restoreFrom(backupPath: string, hooks?: RestoreHooks): Promise<BackupResult & { rollback?: string }> {
    const restart = hooks?.restart ?? defaultRestartAfterDelay;
    const onFailure = hooks?.onFailure ?? defaultRestoreFailureDialog;
    const drain = hooks?.drain;
    try {
      // 1. Validate the candidate backup BEFORE touching the live database. Opening
      //    alone is lazy — it accepts arbitrary garbage — so force a page read.
      const validation = validateBackupFile(backupPath);
      if (!validation.ok) {
        return { ok: false, error: `backup_invalid: ${validation.error ?? 'unreadable'}` };
      }

      // 2. Rollback snapshot of the current state.
      const rollback = await this.runBackup();
      if (!rollback.ok || !rollback.destination) {
        return { ok: false, error: `Rollback snapshot failed: ${rollback.error ?? 'unknown'}` };
      }

      // 3. Restore intent — written BEFORE the swap so every crash window is recoverable.
      writeRestoreIntent(this.dbPath, {
        backupPath,
        rollbackPath: rollback.destination,
        dbPath: this.dbPath,
        requestedAt: Date.now(),
      });

      // 4. Drain runtime writers — a REAL await: agent runs, scenario
      //    workflows and background queues must settle before the WAL is
      //    checkpointed and the store closes. A drain timeout aborts the
      //    restore BEFORE the swap: the intent is cleared, the original
      //    database stays open and live, and the caller can retry later.
      if (drain) {
        let drainResult: { timedOut: boolean; pending?: unknown[] } | void;
        try {
          drainResult = await drain();
        } catch (drainErr) {
          clearRestoreIntent(this.dbPath);
          return { ok: false, error: `restore_runtime_drain_failed: ${String((drainErr as Error).message ?? drainErr)}` };
        }
        if (drainResult && drainResult.timedOut) {
          clearRestoreIntent(this.dbPath);
          return { ok: false, error: 'restore_runtime_drain_timeout' };
        }
      }
      this.store.checkpointWal();
      this.store.close();

      // 5. Atomic swap (temp copy + rename on the same volume).
      try {
        atomicCopy(backupPath, this.dbPath);
      } catch (swapErr) {
        // The old DB file is untouched (the rename failed), but handles are released.
        // Continuing here would leave every service on a stale closed store —
        // fail closed instead.
        onFailure(`数据库替换失败，应用将退出：${String((swapErr as Error).message ?? swapErr)}`);
        return { ok: false, error: `swap_failed: ${String((swapErr as Error).message ?? swapErr)}` };
      }

      // 6. Full restart, delayed just enough for the IPC reply to reach the
      //    renderer. The next boot runs the startup health checks and clears the
      //    intent (or offers rollback when the restored DB fails them).
      setTimeout(() => restart(), 600);
      return { ok: true, destination: backupPath, rollback: rollback.destination };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  }

  /**
   * Roll the database back to the snapshot recorded in the restore intent. Used by
   * the next boot when a restored database fails its startup health checks, or when
   * the user chooses rollback. Returns the rolled-back-to path on success.
   * The caller must restart the app afterwards (no live store may touch the file).
   */
  static rollbackFromIntent(intent: RestoreIntent): { ok: boolean; destination?: string; error?: string } {
    try {
      if (!fs.existsSync(intent.rollbackPath)) {
        return { ok: false, error: `rollback snapshot missing: ${intent.rollbackPath}` };
      }
      atomicCopy(intent.rollbackPath, intent.dbPath);
      clearRestoreIntent(intent.dbPath);
      return { ok: true, destination: intent.rollbackPath };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  }
}
