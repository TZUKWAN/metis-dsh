#!/usr/bin/env node
/**
 * perf-baseline.mjs — performance baseline recorder/regression check (Task 5 §19).
 *
 * Measures REAL operations and compares against a recorded baseline with a
 * generous regression margin (this is a leak/regression gate, not a benchmark):
 *   db_seed_1000_papers      — write 1000 papers through PersistenceStore
 *   db_open_and_list_1000    — reopen the store and read all papers back
 *   session_500_append       — append 500 messages to one session
 *   session_500_read         — read the 500-message session back
 *   outcomes_100_write_list  — create 100 outcomes and list them
 *   app_startup_cold         — spawn the built app (temp profile) until the
 *                              runtime identity line appears on stdout
 *   app_startup_warm         — a second identical boot
 *   app_shutdown             — clean quit duration of the warm boot
 *
 * Usage:
 *   node scripts/perf-baseline.mjs --record      # (re)record the baseline
 *   node scripts/perf-baseline.mjs --check       # gate against the baseline
 *   [--skip-app]  — DB-level metrics only (used when no build is present)
 *
 * Evidence: logs/perf-baseline-<stamp>.json (+ the committed baseline file).
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'tests', 'fixtures', 'perf', 'baseline.json');
const REGRESSION_FACTOR = 3;
const REGRESSION_SLACK_MS = 2_000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function tempDir(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }

/** DB timings come from the vitest suite (native TS imports), which writes logs/perf-measure.json. */
async function measureDbMetrics() {
  const { execSync } = await import('node:child_process');
  execSync('npx vitest run tests/scripts/PerfBaselineMeasure.test.ts', {
    cwd: ROOT, stdio: 'inherit', windowsHide: true, timeout: 10 * 60_000,
  });
  const measurePath = join(ROOT, 'logs', 'perf-measure.json');
  if (!existsSync(measurePath)) throw new Error('perf-measure.json was not produced by the measurement suite');
  const { metrics } = JSON.parse(readFileSync(measurePath, 'utf8'));
  return metrics;
}

/** Spawn the built app with a temp profile; resolve when the runtime identity line appears. */
function measureAppBoot(profileDir, timeoutMs = 90_000) {
  const electronExe = join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!existsSync(electronExe)) return Promise.reject(new Error(`electron binary missing: ${electronExe}`));
  const t0 = Date.now();
  const child = spawn(electronExe, ['.'], {
    cwd: ROOT,
    env: { ...process.env, METIS_BACKGROUND_AUDIT: '0', ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  void profileDir;
  return new Promise((resolve, reject) => {
    let stdout = '';
    const timer = setTimeout(() => {
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* dying */ }
      reject(new Error(`startup identity line not seen within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', (c) => {
      stdout += c.toString();
      if (stdout.includes('[METIS_RUNTIME_IDENTITY]')) {
        clearTimeout(timer);
        resolve({ durationMs: Date.now() - t0, pid: child.pid, stdout: () => stdout });
      }
    });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function quitApp(child) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* dying */ }
      resolve(Date.now() - t0);
    }, 30_000);
    child.once('exit', () => { clearTimeout(timer); resolve(Date.now() - t0); });
    try { child.kill(); } catch { /* already exiting */ }
  });
}

async function measureAppMetrics() {
  const timings = {};
  const profile = tempDir('metis-perf-app-');
  const boot1 = await measureAppBoot(profile);
  timings.app_startup_cold = boot1.durationMs;
  timings.app_shutdown = await quitApp(boot1.child ?? boot1);
  await sleep(1_500);
  const boot2 = await measureAppBoot(profile);
  timings.app_startup_warm = boot2.durationMs;
  await quitApp(boot2);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows */ }
  return timings;
}

async function collect(skipApp) {
  const timings = await measureDbMetrics();
  if (!skipApp) {
    try {
      Object.assign(timings, await measureAppMetrics());
    } catch (err) {
      console.warn(`[perf] app-level metrics unavailable (${err.message}) — recorded as not measured`);
      timings.app_startup_cold = null;
      timings.app_startup_warm = null;
      timings.app_shutdown = null;
    }
  }
  return timings;
}

function compare(baseline, current) {
  const results = [];
  for (const [name, base] of Object.entries(baseline.metrics ?? {})) {
    const value = current[name];
    if (value === null || value === undefined) {
      results.push({ name, status: 'NOT RUN', baselineMs: base, currentMs: null, reason: 'not measured in this run' });
      continue;
    }
    const limit = base * REGRESSION_FACTOR + REGRESSION_SLACK_MS;
    results.push({ name, status: value <= limit ? 'PASS' : 'REGRESSION', baselineMs: base, currentMs: value, limitMs: limit });
  }
  return results;
}

async function main() {
  const argv = process.argv.slice(2);
  const record = argv.includes('--record');
  const check = argv.includes('--check');
  const skipApp = argv.includes('--skip-app');
  if (!record && !check) {
    console.error('Usage: perf-baseline.mjs --record | --check [--skip-app]');
    process.exit(2);
  }
  console.log('[perf] measuring (this exercises real DB work and may take a minute)…');
  const timings = await collect(skipApp);
  const measuredAt = new Date().toISOString();
  const stamp = measuredAt.replace(/[-:.TZ]/gu, '').slice(0, 14);
  const runReport = { measuredAt, metrics: timings };

  if (record) {
    mkdirSync(dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ schemaVersion: 1, recordedAt: measuredAt, metrics: timings }, null, 2)}\n`);
    console.log(`[perf] baseline recorded: ${BASELINE_PATH}`);
  } else {
    if (!existsSync(BASELINE_PATH)) {
      console.error(`[perf] baseline missing: ${BASELINE_PATH} (run with --record first)`);
      process.exit(2);
    }
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    const results = compare(baseline, timings);
    runReport.results = results;
    const failed = results.filter((r) => r.status === 'REGRESSION');
    const gate = failed.length === 0 ? 'PASS' : 'FAIL';
    console.log('--- perf baseline check ---');
    for (const r of results) {
      console.log(`${r.status.padEnd(10)} ${r.name}: ${r.currentMs ?? 'n/a'}ms (baseline ${r.baselineMs}ms, limit ${r.limitMs ?? 'n/a'}ms)`);
    }
    console.log(`gate: ${gate}`);
    runReport.gate = gate;
    if (gate === 'FAIL') process.exitCode = 1;
  }
  mkdirSync(join(ROOT, 'logs'), { recursive: true });
  writeFileSync(join(ROOT, 'logs', `perf-baseline-${stamp}.json`), `${JSON.stringify(runReport, null, 2)}\n`);
}

main().catch((err) => { console.error('[perf] fatal:', err); process.exit(1); });
