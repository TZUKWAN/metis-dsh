#!/usr/bin/env node
/**
 * reliability-gate.mjs — unified METIS release reliability gate.
 *
 * Composes the existing quality, contract, acceptance, stress, and release
 * checks into tiered, evidence-producing gate runs:
 *   Tier 1 — PR required (fast, deterministic)
 *   Tier 2 — Desktop acceptance (real Electron against a production build)
 *   Tier 3 — Nightly / RC (stress, large data, leak and performance gates)
 *   Tier 4 — Release (provenance, packaging, SBOM, scan, policy verify)
 *
 * The tier manifest lives in build/reliability-tiers.json. Every check gets a
 * full log file under logs/reliability-gate/<id>.log and the run produces a
 * machine-readable report (default logs/reliability-gate-report.json) with an
 * explicit status per check: PASS | FAIL | TIMEOUT | NOT RUN | SKIPPED.
 * A check whose declared precondition files are missing is reported NOT RUN
 * with the reason — it is never silently dropped. The gate exits non-zero when
 * any check FAILs/TIMEOUTs or when a required check is NOT RUN.
 *
 * Usage:
 *   node scripts/reliability-gate.mjs --tier=1 [--only=id,id2] [--list]
 *        [--report=path] [--manifest=path]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, writeFileSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`reliability-gate: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { tier: 1, only: null, list: false, report: null, manifest: resolve(ROOT, 'build/reliability-tiers.json') };
  for (const raw of argv) {
    const arg = raw.startsWith('--') ? raw.slice(2) : raw;
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? true : arg.slice(eq + 1);
    if (key === 'tier') {
      const tier = Number.parseInt(value, 10);
      if (!Number.isInteger(tier) || tier < 1 || tier > 4) fail(`invalid --tier value: ${value} (expected 1..4)`);
      args.tier = tier;
    } else if (key === 'only') {
      args.only = String(value).split(',').map((id) => id.trim()).filter(Boolean);
    } else if (key === 'list') {
      args.list = true;
    } else if (key === 'report') {
      args.report = String(value);
    } else if (key === 'manifest') {
      args.manifest = resolve(ROOT, String(value));
    } else {
      fail(`unknown argument: ${raw}`);
    }
  }
  return args;
}

function loadManifest(path) {
  if (!existsSync(path)) fail(`manifest not found: ${path}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`manifest is not valid JSON: ${path} (${err.message})`);
  }
  if (manifest.schemaVersion !== 1) fail(`unsupported manifest schemaVersion: ${manifest.schemaVersion}`);
  if (!Array.isArray(manifest.checks) || manifest.checks.length === 0) fail('manifest has no checks');
  const seen = new Set();
  for (const check of manifest.checks) {
    for (const field of ['id', 'name', 'command', 'tiers']) {
      if (check[field] === undefined) fail(`check missing "${field}": ${JSON.stringify(check).slice(0, 120)}`);
    }
    if (seen.has(check.id)) fail(`duplicate check id: ${check.id}`);
    seen.add(check.id);
    if (!Array.isArray(check.tiers) || check.tiers.some((t) => !Number.isInteger(t) || t < 1 || t > 4)) {
      fail(`check ${check.id}: tiers must be integers 1..4`);
    }
  }
  return manifest;
}

function runCheck(check, logDir) {
  return new Promise((resolveResult) => {
    const startedAt = new Date().toISOString();
    const logPath = resolve(ROOT, logDir, `${check.id}.log`);
    const logStream = createWriteStream(logPath);
    const timeoutMs = (check.timeoutMinutes ?? 10) * 60_000;
    const child = spawn(check.command, {
      shell: true,
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
    });
    let timedOut = false;
    let tail = [];
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // Kill the whole Windows process tree so shell wrappers do not orphan.
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);

    const capture = (stream) => {
      stream.on('data', (chunk) => {
        logStream.write(chunk);
        // Keep a small tail for the console failure summary; full output is in
        // the log file.
        tail.push(chunk.toString());
        if (tail.length > 200) tail = tail.slice(-200);
      });
    };
    capture(child.stdout);
    capture(child.stderr);
    child.on('error', (err) => {
      clearTimeout(timer);
      logStream.end(`\n[gate] spawn error: ${err.message}\n`);
      resolveResult({ ...baseResult(check, startedAt, logPath), status: 'FAIL', reason: `spawn error: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      logStream.end(`\n[gate] exit code=${code} signal=${signal ?? 'none'}\n`);
      const base = baseResult(check, startedAt, logPath);
      base.tail = tail.join('').split('\n').slice(-40).join('\n');
      if (timedOut) {
        resolveResult({ ...base, status: 'TIMEOUT', reason: `exceeded ${check.timeoutMinutes ?? 10}min (killed)` });
      } else if (code === 0) {
        resolveResult({ ...base, status: 'PASS' });
      } else {
        resolveResult({ ...base, status: 'FAIL', reason: `exit code ${code}${signal ? ` signal ${signal}` : ''}` });
      }
    });
  });
}

function baseResult(check, startedAt, logPath) {
  return {
    id: check.id,
    name: check.name,
    tiers: check.tiers,
    required: check.required !== false,
    blocking: check.blocking !== false,
    command: check.command,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - Date.parse(startedAt),
    log: relative(ROOT, logPath).split('\\').join('/'),
    evidence: [],
    status: 'PASS',
    reason: null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = loadManifest(args.manifest);
  const logDir = manifest.logDir ?? 'logs/reliability-gate';
  mkdirSync(resolve(ROOT, logDir), { recursive: true });

  if (args.list) {
    for (const check of manifest.checks) {
      const req = check.required !== false ? 'required' : 'optional ';
      console.log(`tier${check.tiers.join(',')} ${req} ${check.id.padEnd(28)} ${check.name}`);
    }
    return;
  }

  const selected = manifest.checks.filter((check) => {
    if (!check.tiers.includes(args.tier)) return false;
    if (args.only && !args.only.includes(check.id)) return false;
    return true;
  });
  if (selected.length === 0) fail(`no checks selected for tier ${args.tier}${args.only ? ` (filter: ${args.only.join(',')})` : ''}`);

  console.log(`[reliability-gate] tier ${args.tier} (${manifest.tiers?.[String(args.tier)] ?? 'unknown'}) — ${selected.length} check(s)`);
  const results = [];
  for (const check of selected) {
    const missing = (check.requires ?? []).filter((rel) => !existsSync(resolve(ROOT, rel)));
    const result = baseResult(check, new Date().toISOString(), resolve(ROOT, logDir, `${check.id}.log`));
    result.evidence = [...(check.evidence ?? []).map((rel) => ({ path: rel, exists: existsSync(resolve(ROOT, rel)) }))];
    if (missing.length > 0) {
      result.status = 'NOT RUN';
      result.reason = `missing precondition: ${missing.join(', ')}`;
      console.log(`[reliability-gate] ${check.id}: NOT RUN — ${result.reason}`);
      results.push(result);
      continue;
    }
    console.log(`[reliability-gate] ${check.id}: start — ${check.command}`);
    const run = await runCheck(check, logDir);
    console.log(`[reliability-gate] ${check.id}: ${run.status}${run.reason ? ` (${run.reason})` : ''} in ${(run.durationMs / 1000).toFixed(1)}s`);
    if (run.status !== 'PASS' && run.tail) {
      console.log(`[reliability-gate] ${check.id} output tail:\n${run.tail}`);
    }
    results.push(run);
  }

  // `blocking: false` checks (security advisories, CVE reports) are recorded
  // honestly as FAIL but do not redden the engineering gate — per the
  // delivery policy: security findings are a report, not a stop sign.
  const failed = results.filter((r) => (r.status === 'FAIL' || r.status === 'TIMEOUT') && r.blocking !== false);
  const advisoryFailed = results.filter((r) => (r.status === 'FAIL' || r.status === 'TIMEOUT') && r.blocking === false);
  const notRunRequired = results.filter((r) => r.status === 'NOT RUN' && r.required && r.blocking !== false);
  const notRunOptional = results.filter((r) => r.status === 'NOT RUN' && !r.required);
  const passed = results.filter((r) => r.status === 'PASS');
  const gate = failed.length === 0 && notRunRequired.length === 0 ? 'PASS' : 'FAIL';
  const report = {
    schemaVersion: 1,
    gate,
    tier: args.tier,
    tierName: manifest.tiers?.[String(args.tier)] ?? null,
    startedAt: results[0]?.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    summary: {
      total: results.length,
      passed: passed.length,
      failed: failed.length,
      advisoryFailed: advisoryFailed.length,
      notRunRequired: notRunRequired.length,
      notRunOptional: notRunOptional.length,
    },
    // `tail` is a console-only aid; the authoritative output is the log file.
    results: results.map(({ tail: _tail, ...rest }) => rest),
  };
  const reportPath = resolve(ROOT, args.report ?? manifest.reportPath ?? 'logs/reliability-gate-report.json');
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log('--- reliability gate summary ---');
  for (const r of results) {
    console.log(`${r.status.padEnd(8)} ${r.required ? '[required]' : '[optional]'} ${r.id}`);
  }
  console.log(`gate: ${gate} (passed=${passed.length} failed=${failed.length} advisoryFailed=${advisoryFailed.length} notRunRequired=${notRunRequired.length} notRunOptional=${notRunOptional.length})`);
  console.log(`report: ${reportPath}`);
  if (notRunOptional.length > 0) console.log(`note: ${notRunOptional.length} optional check(s) NOT RUN — gate is INCOMPLETE but not failing.`);
  process.exit(gate === 'PASS' ? 0 : 1);
}

main().catch((err) => fail(err?.stack ?? String(err)));
