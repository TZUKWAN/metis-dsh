/**
 * StartupHealthService — internal startup/system health report (Task 5 §16).
 *
 * Collects REAL probes: SQLite quick_check/foreign_key_check over a read-only
 * connection, data/backup directory writability, schema + migration versions,
 * crash-marker state, orphan run count, and feature readiness supplied by the
 * caller. The report carries a user-facing `issues` list containing only the
 * problems that need action — everything healthy stays internal detail.
 *
 * This module deliberately avoids importing electron so it is unit-testable
 * in plain vitest; main.ts wires live values in.
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

export type HealthStatus = 'ok' | 'warning' | 'error' | 'unknown';

export interface HealthCheck {
  id: string;
  status: HealthStatus;
  detail: string;
}

export interface HealthIssue {
  id: string;
  severity: 'warning' | 'error';
  message: string;
}

export interface StartupHealthInput {
  appVersion: string;
  buildId: string;
  dataDir: string;
  dbPath: string;
  backupDir: string;
  /** Whether the production PersistenceStore constructed successfully. */
  storeReady: boolean;
  providerConfigured: boolean | null;
  genofficeReady: boolean | null;
  browserReady: boolean | null;
  /** e.g. "3/4 MCP servers connected"; null when MCP is not initialized. */
  mcpSummary: string | null;
  /** Rows still marked running after an unclean previous exit; null = not probed. */
  orphanRunningRuns: number | null;
  /** Orphan rows retired to interrupted/process_crash at startup; null = reconciliation did not run. */
  reconciledOrphanRuns: number | null;
  crashMarker: { previousRunUnclean: boolean; marker: unknown } | null;
  lastMigration: { fromVersion: number; toVersion: number; failed?: { version: number; description: string } } | null;
  /**
   * Authoritative store-level startup checks (engine/persistence/StartupHealth,
   * run inside the PersistenceStore constructor). When present they are the
   * source of truth for integrity + schema versions; the independent read-only
   * probe is only the fallback for a store that never came up.
   */
  storeHealth: {
    ok: boolean;
    checks: Array<{ name: string; ok: boolean; detail: string }>;
    schemaVersion: number | null;
    migrationVersion: number;
  } | null;
}

export interface StartupHealthReport {
  collectedAt: string;
  appVersion: string;
  buildId: string;
  checks: HealthCheck[];
  /** Only the problems a normal user needs to act on. */
  issues: HealthIssue[];
}

interface DbIntegrityResult {
  reachable: boolean;
  quickCheck: string | null;
  fkViolations: number | null;
  schemaVersion: number | null;
  migrationVersion: number | null;
  error: string | null;
}

function probeDatabase(dbPath: string): DbIntegrityResult {
  const result: DbIntegrityResult = {
    reachable: false, quickCheck: null, fkViolations: null,
    schemaVersion: null, migrationVersion: null, error: null,
  };
  if (!existsSync(dbPath)) {
    result.error = 'database file does not exist yet';
    return result;
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    result.reachable = true;
    const quick = db.pragma('quick_check') as Array<{ quick_check: string }>;
    result.quickCheck = quick[0]?.quick_check ?? null;
    result.fkViolations = (db.pragma('foreign_key_check') as unknown[]).length;
    const schemaRow = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null } | undefined;
    result.schemaVersion = schemaRow?.v ?? null;
    try {
      const migrationRow = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
      result.migrationVersion = migrationRow?.v ?? null;
    } catch {
      // Pre-migration-era database — the versioned table does not exist yet.
      result.migrationVersion = null;
    }
  } catch (err) {
    result.error = (err as Error).message;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
  return result;
}

function probeWritable(dir: string): { writable: boolean; error: string | null } {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.write-probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, 'probe');
    unlinkSync(probe);
    return { writable: true, error: null };
  } catch (err) {
    return { writable: false, error: (err as Error).message };
  }
}

export function collectStartupHealth(input: StartupHealthInput): StartupHealthReport {
  const checks: HealthCheck[] = [];
  const issues: HealthIssue[] = [];
  const push = (id: string, status: HealthStatus, detail: string, issue?: { severity: 'warning' | 'error'; message: string }) => {
    checks.push({ id, status, detail });
    if (issue) issues.push({ id, severity: issue.severity, message: issue.message });
  };

  // ── Database integrity (store-level checks first, probe as fallback) ──
  const db = probeDatabase(input.dbPath);
  const integrityDetail = input.storeHealth
    ? `${input.storeHealth.checks.filter((c) => c.ok).length}/${input.storeHealth.checks.length} startup checks passed (quick_check + foreign_key_check run on every startup)`
    : null;
  if (input.storeHealth && !input.storeHealth.ok) {
    push('db_integrity', 'error', `startup checks failed: ${input.storeHealth.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join('; ')}`, {
      severity: 'error',
      message: '数据库完整性检查未通过。为防止数据损坏，请从最近一次备份恢复（设置 → 备份）。',
    });
  } else if (input.storeHealth) {
    push('db_integrity', 'ok', integrityDetail ?? 'startup checks passed');
  } else if (!input.storeReady) {
    push('persistence', 'error', `store not ready: ${db.error ?? 'PersistenceStore failed to initialize'}`, {
      severity: 'error',
      message: '数据库未能加载，应用正以无持久化模式运行。数据不会被保存，请重启应用；若重启后仍失败，请导出诊断信息。',
    });
  } else if (!db.reachable) {
    push('db_integrity', 'unknown', db.error ?? 'database not probed');
  } else if (db.quickCheck !== 'ok') {
    push('db_integrity', 'error', `quick_check: ${db.quickCheck ?? 'no result'}${db.error ? ` (${db.error})` : ''}`, {
      severity: 'error',
      message: '数据库完整性检查未通过。为防止数据损坏，请从最近一次备份恢复（设置 → 备份）。',
    });
  } else {
    push('db_integrity', 'ok', `quick_check ok, foreign_key_check violations: ${db.fkViolations ?? 0}`);
    if ((db.fkViolations ?? 0) > 0) {
      issues.push({
        id: 'db_integrity',
        severity: 'warning',
        message: '数据库存在外键一致性告警，建议从最近一次备份恢复。',
      });
    }
  }

  // ── Schema / migration versions ──────────────────────────────────────
  const migrationFailed = input.lastMigration?.failed;
  const schemaVersionShown = input.storeHealth ? input.storeHealth.schemaVersion : db.schemaVersion;
  const migrationVersionShown = input.storeHealth ? input.storeHealth.migrationVersion : (db.migrationVersion ?? input.lastMigration?.toVersion ?? null);
  push(
    'schema_versions',
    migrationFailed ? 'error' : 'ok',
    `schema_version: ${schemaVersionShown ?? 'n/a'}, migrations applied to: ${migrationVersionShown ?? 'n/a'}`
      + (migrationFailed ? `, FAILED at v${migrationFailed.version} (${migrationFailed.description})` : ''),
    migrationFailed ? {
      severity: 'error',
      message: `数据库迁移在 v${migrationFailed.version} 失败，应用已停止以免损坏数据。请导出诊断信息并联系支持。`,
    } : undefined,
  );

  // ── Directory writability ────────────────────────────────────────────
  const dataWritable = probeWritable(input.dataDir);
  push('data_dir_writable', dataWritable.writable ? 'ok' : 'error', dataWritable.writable ? 'writable' : `not writable: ${dataWritable.error}`, dataWritable.writable ? undefined : {
    severity: 'error',
    message: '数据目录不可写，设置与数据可能无法保存。请检查磁盘空间或文件夹权限。',
  });
  const backupWritable = probeWritable(input.backupDir);
  push('backup_dir_writable', backupWritable.writable ? 'ok' : 'warning', backupWritable.writable ? 'writable' : `not writable: ${backupWritable.error}`, backupWritable.writable ? undefined : {
    severity: 'warning',
    message: '备份目录不可写，自动备份无法进行。请检查磁盘空间或文件夹权限。',
  });

  // ── Provider ─────────────────────────────────────────────────────────
  if (input.providerConfigured === null) {
    push('provider', 'unknown', 'not probed');
  } else if (input.providerConfigured) {
    push('provider', 'ok', 'configured');
  } else {
    push('provider', 'warning', 'no active provider profile', {
      severity: 'warning',
      message: '尚未配置模型服务，AI 功能暂不可用。请在设置中完成模型配置。',
    });
  }

  // ── Features (null = deliberately not probed) ────────────────────────
  push('genoffice', input.genofficeReady === null ? 'unknown' : input.genofficeReady ? 'ok' : 'warning',
    input.genofficeReady === null ? 'not probed' : input.genofficeReady ? 'ready' : 'not ready',
    input.genofficeReady === false ? { severity: 'warning', message: '文档编辑组件未能就绪，Office 相关功能可能不可用。' } : undefined);
  push('browser', input.browserReady === null ? 'unknown' : input.browserReady ? 'ok' : 'warning',
    input.browserReady === null ? 'not probed' : input.browserReady ? 'ready' : 'not ready',
    input.browserReady === false ? { severity: 'warning', message: '内嵌浏览器未能就绪，网页研究功能可能不可用。' } : undefined);
  if (input.mcpSummary === null) push('mcp', 'unknown', 'not initialized');
  else push('mcp', 'ok', input.mcpSummary);

  // ── Crash marker / orphan reconciliation ─────────────────────────────
  if (input.crashMarker?.previousRunUnclean) {
    push('crash_marker', 'warning', `previous run did not shut down cleanly: ${JSON.stringify(input.crashMarker.marker)}`, {
      severity: 'warning',
      message: '检测到上次未正常退出。数据已自动保护；如发现异常请从备份恢复。',
    });
  } else {
    push('crash_marker', 'ok', 'clean');
  }
  if (input.reconciledOrphanRuns !== null && input.reconciledOrphanRuns > 0) {
    push('orphan_runs', 'ok', `reconciled ${input.reconciledOrphanRuns} orphan run(s) from the previous session (marked interrupted/process_crash)`);
  } else if (input.orphanRunningRuns !== null && input.orphanRunningRuns > 0) {
    // Rows still running WITH no reconciliation having run: a real zombie risk.
    push('orphan_runs', 'warning', `${input.orphanRunningRuns} run(s) still marked running from a previous session`, {
      severity: 'warning',
      message: '上次异常退出留下了未完结的任务记录，本次启动已可安全重试。',
    });
  } else {
    push('orphan_runs', input.orphanRunningRuns === null ? 'unknown' : 'ok',
      input.orphanRunningRuns === null ? 'not probed' : 'none');
  }

  return {
    collectedAt: new Date().toISOString(),
    appVersion: input.appVersion,
    buildId: input.buildId,
    checks,
    issues,
  };
}

/** Default crash-marker location helpers shared with main.ts instrumentation. */
export function crashMarkerPath(dataDir: string): string {
  return join(dataDir, 'runtime', 'crash-marker.json');
}

export function readCrashMarkerState(dataDir: string, clearStaleMarker: boolean): { previousRunUnclean: boolean; marker: unknown } {
  const markerFile = crashMarkerPath(dataDir);
  let previousRunUnclean = false;
  let marker: unknown = null;
  try {
    if (existsSync(markerFile)) {
      previousRunUnclean = true;
      try { marker = JSON.parse(readFileSync(markerFile, 'utf8')); } catch { marker = 'unreadable-marker'; }
      if (clearStaleMarker) rmSync(markerFile, { force: true });
    }
  } catch {
    // Marker handling must never break startup.
  }
  return { previousRunUnclean, marker };
}

/** Write a fresh boot marker; call early in startup. Never throws. */
export function writeCrashMarker(dataDir: string, payload: { bootId: string; pid: number; startedAt: string }): void {
  try {
    const markerFile = crashMarkerPath(dataDir);
    mkdirSync(dirname(markerFile), { recursive: true });
    writeFileSync(markerFile, JSON.stringify(payload));
  } catch {
    // Non-fatal by design.
  }
}

/** Remove the boot marker on a clean shutdown; call in before-quit. Never throws. */
export function clearCrashMarker(dataDir: string): void {
  try {
    rmSync(crashMarkerPath(dataDir), { force: true });
  } catch {
    // Non-fatal by design.
  }
}
