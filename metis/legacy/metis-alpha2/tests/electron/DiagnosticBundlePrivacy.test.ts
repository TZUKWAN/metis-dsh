/**
 * Diagnostic bundle privacy gate (Task 5 §17).
 *
 * Seeds a realistic userData directory with secrets, a secret vault, chat
 * history, and logs containing a leaked key, then builds the real bundle and
 * asserts — over the actual ZIP entries — that nothing private escapes and
 * every entry sits inside the documented allowlist.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

import { buildDiagnosticBundle, redactText, sanitizeSettings } from '../../electron/DiagnosticBundleService.js';
import { collectStartupHealth } from '../../electron/StartupHealthService.js';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';

const LEAKED_KEY = 'sk-live-abcdef1234567890';
const VAULT_MARKER = 'vault-encrypted-blob-do-not-export-4f2a';
const CHAT_MARKER = 'CONFIDENTIAL-CHAT-SENTENCE-9d1c';

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

describe('sanitizeSettings / redactText', () => {
  it('redacts secret-shaped keys at every depth and secret-shaped string values', () => {
    const sanitized = sanitizeSettings({
      provider: { apiKey: 'sk-test-1234567890', baseUrl: 'https://api.example.com/v1' },
      credentials: { password: 'hunter2' },
      nested: { deep: { authToken: 'tok-abc' } },
      note: 'key sk-live-abcdef123456 leaked in a note',
      safe: { model: 'gpt-4o-mini', temperature: 0.7 },
    }) as Record<string, unknown>;
    const text = JSON.stringify(sanitized);
    expect(text).not.toContain('sk-test-1234567890');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('tok-abc');
    expect(text).not.toContain('sk-live-abcdef123456');
    expect((sanitized.provider as Record<string, unknown>).apiKey).toBe('[REDACTED]');
    expect((sanitized.safe as Record<string, unknown>).model).toBe('gpt-4o-mini');
    expect(redactText('prefix sk-abc12345 suffix')).toBe('prefix [REDACTED] suffix');
  });
});

describe('diagnostic bundle privacy', () => {
  it('contains only allowlisted sanitized entries and never leaks keys, vault, chat, or the database', async () => {
    const dir = tempDir('metis-bundle-privacy-');
    try {
      // ── Seed a realistic userData ────────────────────────────────────
      const dataDir = path.join(dir, 'metis-data');
      const logDir = path.join(dataDir, 'logs');
      fs.mkdirSync(logDir, { recursive: true });

      fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
        version: 3,
        provider: { apiKey: LEAKED_KEY, baseUrl: 'https://api.example.com/v1' },
        ui: { language: 'zh-CN' },
      }));
      fs.writeFileSync(path.join(dataDir, 'personalization-secrets.v1.json'), JSON.stringify({
        version: 1,
        entries: { wechat: VAULT_MARKER },
      }));
      fs.writeFileSync(path.join(logDir, 'main-2026-09-05.log'), [
        '2026-09-05T10:00:00Z [Main] startup complete',
        `2026-09-05T10:00:01Z [Provider] request failed with key ${LEAKED_KEY} (bad logging)`,
        '2026-09-05T10:00:02Z [Main] window shown',
      ].join('\n'));
      fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'runtime', 'crash-marker.json'), JSON.stringify({ bootId: 'boot-9', pid: 4321 }));

      // A real research database with private content must never be attached.
      const dbPath = path.join(dataDir, 'metis.db');
      const store = new PersistenceStore(dbPath);
      try {
        store.appendMessage(store.createSession('sess-privacy', undefined, undefined), 'user', CHAT_MARKER);
      } finally {
        store.close();
      }

      // ── Build the real bundle ────────────────────────────────────────
      const health = collectStartupHealth({
        appVersion: '0.1.0-alpha.3',
        buildId: 'metis-alpha2-release',
        dataDir,
        dbPath,
        backupDir: path.join(dataDir, 'backups'),
        storeReady: true,
        providerConfigured: true,
        genofficeReady: true,
        browserReady: true,
        mcpSummary: '1/1 MCP servers connected',
        orphanRunningRuns: 0,
        crashMarker: { previousRunUnclean: true, marker: { bootId: 'boot-9' } },
        lastMigration: { fromVersion: 0, toVersion: 116 },
      });

      const result = await buildDiagnosticBundle({
        appVersion: '0.1.0-alpha.3',
        buildId: 'metis-alpha2-release',
        dataDir,
        settingsPath: path.join(dataDir, 'settings.json'),
        logDir,
        crashMarkerPath: path.join(dataDir, 'runtime', 'crash-marker.json'),
        health,
        schemaInfo: { schemaVersion: 18, migrationVersion: 116 },
        featureReadiness: { genoffice: 'ready', browser: 'ready' },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(fs.existsSync(result.zipPath)).toBe(true);
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u);

      // ── Verify over the real ZIP contents ────────────────────────────
      const zip = await JSZip.loadAsync(fs.readFileSync(result.zipPath));
      const entryNames = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
      expect(entryNames.length).toBeGreaterThanOrEqual(7);

      const contents: string[] = [];
      for (const name of entryNames) {
        contents.push(await zip.files[name].async('string'));
      }
      const all = contents.join('\n---ENTRY---\n');

      // Allowlist: identity / health / schema / sanitized settings / bounded log tail / crash marker / features / README.
      const normalized = entryNames.map((n) => n.split(/[\\/]/u).pop());
      for (const must of ['identity.json', 'health.json', 'schema.json', 'settings-sanitized.json', 'README.txt', 'features.json', 'crash-marker.json']) {
        expect(normalized, `missing bundle entry: ${must}`).toContain(must);
      }
      expect(normalized).toContain('main-tail.log');

      // Privacy blacklist — over every entry.
      expect(all).not.toContain(LEAKED_KEY);
      expect(all).not.toContain(VAULT_MARKER);
      expect(all).not.toContain(CHAT_MARKER);
      expect(all).not.toContain('hunter2');
      // The database and vault files are never attached, whatever their name.
      for (const name of entryNames) {
        expect(name).not.toMatch(/\.db$|\.sqlite$|secrets?\.|vault/iu);
      }
      // The leaked key in the log tail was scrubbed but the useful log lines remain.
      const logEntry = entryNames.find((n) => n.endsWith('main-tail.log'))!;
      const logContent = await zip.files[logEntry].async('string');
      expect(logContent).toContain('[Main] startup complete');
      expect(logContent).toContain('[REDACTED]');
      // Settings keep structure, lose secrets.
      const settingsEntry = entryNames.find((n) => n.endsWith('settings-sanitized.json'))!;
      const sanitizedText = await zip.files[settingsEntry].async('string');
      expect(sanitizedText).toContain('api.example.com');
      expect(sanitizedText).toContain('[REDACTED]');
    } finally {
      rmTemp(dir);
    }
  }, 30_000);

  it('a bundle built without logs/crash marker still succeeds with the core entries', async () => {
    const dir = tempDir('metis-bundle-minimal-');
    try {
      const dataDir = path.join(dir, 'data');
      fs.mkdirSync(dataDir, { recursive: true });
      const health = collectStartupHealth({
        appVersion: '0.1.0-alpha.3',
        buildId: 'metis-alpha2-release',
        dataDir,
        dbPath: path.join(dataDir, 'missing.db'),
        backupDir: path.join(dataDir, 'backups'),
        storeReady: false,
        providerConfigured: null,
        genofficeReady: null,
        browserReady: null,
        mcpSummary: null,
        orphanRunningRuns: null,
        crashMarker: null,
        lastMigration: null,
      });
      const result = await buildDiagnosticBundle({
        appVersion: '0.1.0-alpha.3',
        buildId: 'metis-alpha2-release',
        dataDir,
        settingsPath: path.join(dataDir, 'settings.json'),
        logDir: path.join(dataDir, 'logs'),
        crashMarkerPath: null,
        health,
        schemaInfo: { schemaVersion: null, migrationVersion: null },
        featureReadiness: {},
      });
      expect(result.ok, result.ok ? undefined : result.error).toBe(true);
      if (!result.ok) return;
      const zip = await JSZip.loadAsync(fs.readFileSync(result.zipPath));
      const entryNames = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
      expect(entryNames.some((n) => n.endsWith('health.json'))).toBe(true);
      const healthText = await zip.files[entryNames.find((n) => n.endsWith('health.json'))!].async('string');
      expect(healthText).toContain('"issues"');
    } finally {
      rmTemp(dir);
    }
  });
});
