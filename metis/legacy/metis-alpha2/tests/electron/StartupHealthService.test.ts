/**
 * Startup health report tests — real SQLite probes, real writability probes,
 * real crash-marker files. No mocks.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import {
  clearCrashMarker,
  collectStartupHealth,
  crashMarkerPath,
  readCrashMarkerState,
  writeCrashMarker,
  type StartupHealthInput,
} from '../../electron/StartupHealthService.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmTemp(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function baseInput(dir: string, dbPath: string, overrides: Partial<StartupHealthInput> = {}): StartupHealthInput {
  return {
    appVersion: '0.1.0-alpha.3',
    buildId: 'metis-alpha2-release',
    dataDir: dir,
    dbPath,
    backupDir: path.join(dir, 'backups'),
    storeReady: true,
    providerConfigured: true,
    genofficeReady: true,
    browserReady: true,
    mcpSummary: '2/2 MCP servers connected',
    orphanRunningRuns: 0,
    reconciledOrphanRuns: 0,
    crashMarker: { previousRunUnclean: false, marker: null },
    lastMigration: { fromVersion: 0, toVersion: 116 },
    ...overrides,
  };
}

describe('collectStartupHealth', () => {
  it('a healthy store reports ok integrity, real schema/migration versions, and zero issues', () => {
    const dir = tempDir('metis-health-ok-');
    const dbPath = path.join(dir, 'metis.db');
    let store: PersistenceStore | null = null;
    try {
      store = new PersistenceStore(dbPath);
      store.close();
      store = null;

      const report = collectStartupHealth(baseInput(dir, dbPath));
      const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
      expect(byId.db_integrity?.status).toBe('ok');
      expect(byId.db_integrity?.detail).toContain('quick_check ok');
      expect(byId.schema_versions?.status).toBe('ok');
      expect(byId.schema_versions?.detail).toMatch(/schema_version: 18/);
      expect(byId.schema_versions?.detail).toMatch(/migrations applied to: 116/);
      expect(byId.data_dir_writable?.status).toBe('ok');
      expect(byId.provider?.status).toBe('ok');
      expect(report.issues).toEqual([]);
    } finally {
      try { store?.close(); } catch { /* closed */ }
      rmTemp(dir);
    }
  });

  it('a corrupt database file produces an integrity error with a recovery issue', () => {
    const dir = tempDir('metis-health-corrupt-');
    const dbPath = path.join(dir, 'metis.db');
    try {
      fs.writeFileSync(dbPath, Buffer.from('definitely not a sqlite database'.repeat(100), 'utf8'));
      const report = collectStartupHealth(baseInput(dir, dbPath, { storeReady: false }));
      expect(report.checks.find((c) => c.id === 'persistence')?.status).toBe('error');
      expect(report.issues.some((i) => i.severity === 'error' && i.message.includes('持久化'))).toBe(true);
    } finally {
      rmTemp(dir);
    }
  });

  it('an unwritable backup directory raises a warning issue without failing the whole report', () => {
    const dir = tempDir('metis-health-backup-');
    const dbPath = path.join(dir, 'metis.db');
    let store: PersistenceStore | null = null;
    try {
      store = new PersistenceStore(dbPath);
      store.close();
      store = null;
      // Create a FILE where the backup directory should be → mkdir/write fails.
      const backupDir = path.join(dir, 'backups');
      fs.writeFileSync(backupDir, 'not a directory');
      const report = collectStartupHealth(baseInput(dir, dbPath));
      expect(report.checks.find((c) => c.id === 'backup_dir_writable')?.status).toBe('warning');
      expect(report.issues.some((i) => i.id === 'backup_dir_writable' && i.severity === 'warning')).toBe(true);
    } finally {
      try { store?.close(); } catch { /* closed */ }
      rmTemp(dir);
    }
  });

  it('crash marker, orphan runs, unconfigured provider, and failed migrations each surface as issues', () => {
    const dir = tempDir('metis-health-issues-');
    const dbPath = path.join(dir, 'metis.db');
    let store: PersistenceStore | null = null;
    try {
      store = new PersistenceStore(dbPath);
      store.close();
      store = null;
      const report = collectStartupHealth(baseInput(dir, dbPath, {
        providerConfigured: false,
        genofficeReady: false,
        crashMarker: { previousRunUnclean: true, marker: { bootId: 'b-1' } },
        orphanRunningRuns: 2,
        reconciledOrphanRuns: null,
        lastMigration: { fromVersion: 0, toVersion: 103, failed: { version: 104, description: 'notes: scope columns' } },
      }));
      const issueIds = report.issues.map((i) => i.id);
      expect(issueIds).toContain('crash_marker');
      expect(issueIds).toContain('orphan_runs');
      expect(issueIds).toContain('provider');
      expect(issueIds).toContain('schema_versions');
      expect(report.issues.find((i) => i.id === 'schema_versions')?.severity).toBe('error');
    } finally {
      try { store?.close(); } catch { /* closed */ }
      rmTemp(dir);
    }
  });
});

describe('crash marker lifecycle', () => {
  it('boot writes a marker, an unclean previous run is detected, a clean shutdown clears it', () => {
    const dir = tempDir('metis-health-marker-');
    try {
      // Simulated previous unclean run: marker exists at boot.
      writeCrashMarker(dir, { bootId: 'boot-1', pid: 111, startedAt: new Date().toISOString() });
      const stale = readCrashMarkerState(dir, false);
      expect(stale.previousRunUnclean).toBe(true);

      // A real boot reads and clears the stale marker.
      const state = readCrashMarkerState(dir, true);
      expect(state.previousRunUnclean).toBe(true);
      expect(fs.existsSync(crashMarkerPath(dir))).toBe(false);

      // Current boot writes its own marker; the next startup sees clean.
      writeCrashMarker(dir, { bootId: 'boot-2', pid: 222, startedAt: new Date().toISOString() });
      clearCrashMarker(dir);
      const afterClean = readCrashMarkerState(dir, false);
      expect(afterClean.previousRunUnclean).toBe(false);
    } finally {
      rmTemp(dir);
    }
  });
});
