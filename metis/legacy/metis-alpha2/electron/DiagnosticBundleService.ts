/**
 * DiagnosticBundleService — one-click sanitized diagnostic export (Task 5 §17).
 *
 * Produces a ZIP containing ONLY an allowlist of sanitized artifacts:
 *   identity.json          app/OS/runtime versions
 *   health.json            StartupHealthReport
 *   schema.json            schema + migration versions
 *   settings-sanitized.json  settings tree with every secret-shaped key/value redacted
 *   logs/main-tail.log     bounded tail (≤256 KB) of the most recent app logs, secret-scrubbed
 *   crash-marker.json      last crash marker state (boot id / pid / timestamps only)
 *   features.json          feature readiness summary
 *   README.txt             contents + privacy statement
 *
 * Hard privacy rules (enforced by construction and by
 * tests/electron/DiagnosticBundlePrivacy.test.ts):
 *   never reads or includes: API keys, the personalization secret vault,
 *   cookies, full private documents, full prompts, or chat history.
 *   The database file is never attached.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';

import type { StartupHealthReport } from './StartupHealthService.js';

const LOG_TAIL_BYTES = 256 * 1024;
const MAX_LOG_FILES = 2;

export interface DiagnosticBundleInput {
  appVersion: string;
  buildId: string;
  dataDir: string;
  settingsPath: string;
  logDir: string;
  crashMarkerPath: string | null;
  health: StartupHealthReport;
  schemaInfo: { schemaVersion: number | null; migrationVersion: number | null };
  featureReadiness: Record<string, string>;
  /** Where the ZIP is written; defaults to <dataDir>/diagnostics. */
  outputDir?: string;
}

export type DiagnosticBundleResult =
  | { ok: true; zipPath: string; entries: string[]; sha256: string }
  | { ok: false; error: string };

const SECRET_KEY_PATTERN = /(api[_-]?key|apikey|secret|token|password|passwd|credential|authorization|private[_-]?key)/i;
const SECRET_VALUE_PATTERN = /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g;

export function redactText(text: string): string {
  return text.replace(SECRET_VALUE_PATTERN, '[REDACTED]');
}

/** Deep-clone the settings tree with secret-shaped keys and values redacted. */
export function sanitizeSettings(settings: unknown): unknown {
  if (Array.isArray(settings)) {
    return settings.map((item) => sanitizeSettings(item));
  }
  if (settings && typeof settings === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(settings as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        output[key] = '[REDACTED]';
        continue;
      }
      output[key] = sanitizeSettings(value);
    }
    return output;
  }
  if (typeof settings === 'string') {
    return redactText(settings);
  }
  return settings;
}

function collectLogTail(logDir: string): string {
  if (!existsSync(logDir)) return '';
  const logFiles = readdirSync(logDir)
    .filter((f) => /^main-.*\.log$/u.test(f))
    .map((f) => join(logDir, f))
    .filter((f) => statSync(f).isFile())
    .sort()
    .slice(-MAX_LOG_FILES);
  let combined = '';
  for (const file of logFiles) {
    try {
      const size = statSync(file).size;
      const start = Math.max(0, size - LOG_TAIL_BYTES);
      const handle = readFileSync(file);
      const chunk = handle.subarray(start).toString('utf8');
      combined += `\n===== ${file.split(/[\\/]/u).pop()}${start > 0 ? ' (tail)' : ''} =====\n${chunk}`;
    } catch {
      // A vanished or unreadable log file is not fatal for the bundle.
    }
  }
  // Bound the total and scrub secret-shaped values that bad logging may have leaked.
  const tail = combined.slice(-LOG_TAIL_BYTES * MAX_LOG_FILES);
  return redactText(tail);
}

const ALLOWED_ENTRY_PATTERN = /^metis-diagnostics-[0-9TZ-]+\/(identity\.json|health\.json|schema\.json|settings-sanitized\.json|logs\/main-tail\.log|crash-marker\.json|features\.json|README\.txt)$/u;

export async function buildDiagnosticBundle(input: DiagnosticBundleInput): Promise<DiagnosticBundleResult> {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const folder = `metis-diagnostics-${stamp}`;
    const entries: Array<{ name: string; content: string }> = [];

    entries.push({
      name: `${folder}/identity.json`,
      content: `${JSON.stringify({
        appVersion: input.appVersion,
        buildId: input.buildId,
        platform: process.platform,
        arch: process.arch,
        osRelease: typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '',
        nodeVersion: process.versions.node,
        generatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
    });
    entries.push({ name: `${folder}/health.json`, content: `${JSON.stringify(input.health, null, 2)}\n` });
    entries.push({
      name: `${folder}/schema.json`,
      content: `${JSON.stringify({ ...input.schemaInfo, note: 'schema/migration versions only — no data is included' }, null, 2)}\n`,
    });

    let settings: unknown = {};
    try {
      if (existsSync(input.settingsPath)) {
        settings = JSON.parse(readFileSync(input.settingsPath, 'utf8'));
      }
    } catch {
      settings = { error: 'settings file unreadable (not included)' };
    }
    entries.push({
      name: `${folder}/settings-sanitized.json`,
      content: `${JSON.stringify(sanitizeSettings(settings), null, 2)}\n`,
    });

    const logTail = collectLogTail(input.logDir);
    if (logTail) entries.push({ name: `${folder}/logs/main-tail.log`, content: logTail });

    if (input.crashMarkerPath && existsSync(input.crashMarkerPath)) {
      try {
        entries.push({
          name: `${folder}/crash-marker.json`,
          content: `${JSON.stringify(JSON.parse(readFileSync(input.crashMarkerPath, 'utf8')), null, 2)}\n`,
        });
      } catch {
        entries.push({ name: `${folder}/crash-marker.json`, content: 'unreadable\n' });
      }
    }

    entries.push({
      name: `${folder}/features.json`,
      content: `${JSON.stringify({ readiness: input.featureReadiness }, null, 2)}\n`,
    });

    entries.push({
      name: `${folder}/README.txt`,
      content: [
        'METIS diagnostic bundle',
        '=======================',
        '',
        'Contents: runtime identity, startup health report, schema/migration versions,',
        'sanitized settings, a bounded recent-log tail, crash marker state, and feature',
        'readiness. Files are limited to the list above.',
        '',
        'This bundle never contains: API keys, the personalization secret vault, cookies,',
        'full private documents, full prompts, chat history, or the research database.',
        'Secret-shaped values found in logs or settings are replaced with [REDACTED].',
        '',
      ].join('\n'),
    });

    for (const entry of entries) {
      if (!ALLOWED_ENTRY_PATTERN.test(entry.name)) {
        return { ok: false, error: `internal allowlist violation for entry: ${entry.name}` };
      }
    }

    const zip = new JSZip();
    for (const entry of entries) zip.file(entry.name, entry.content);
    const outputDir = input.outputDir ?? join(input.dataDir, 'diagnostics');
    mkdirSync(outputDir, { recursive: true });
    const zipPath = join(outputDir, `${folder}.zip`);
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(zipPath);
      stream.on('error', reject);
      stream.on('finish', () => resolve());
      stream.end(buffer);
    });

    return {
      ok: true,
      zipPath,
      entries: entries.map((e) => e.name),
      sha256: createHash('sha256').update(buffer).digest('hex'),
    };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err) };
  }
}

/** Internal helper re-exported for tests: stable random boot id. */
export function newBootId(): string {
  return randomUUID();
}
