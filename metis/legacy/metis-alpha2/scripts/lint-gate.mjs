#!/usr/bin/env node
/**
 * lint-gate.mjs — legacy-aware lint gate (Task: Engineering Delivery Ready).
 *
 * The repo carries a large HISTORICAL lint debt (main-branch baseline was 174
 * errors before this effort). Failing every PR on that debt means main can
 * never pass, which trains everyone to ignore lint. Policy:
 *
 *   - Compare per-file/per-rule error COUNTS against the committed baseline
 *     (build/lint-baseline.json). Any file|rule ABOVE baseline → FAIL with
 *     the new offenders listed. At or below → PASS.
 *   - `--changed` mode: files added/modified by this change (git diff +
 *     untracked) must have ZERO errors — new code is held to the full bar.
 *   - Baseline may only go DOWN: regenerate with `npm run lint:baseline:update`
 *     after paying down debt; CI fails if a commit makes it worse.
 *
 * Banned shortcuts (and therefore not implemented): disabling eslint, demoting
 * severities, deleting rules.
 *
 * Usage:
 *   node scripts/lint-gate.mjs                # baseline comparison
 *   node scripts/lint-gate.mjs --changed      # zero errors on changed files
 *   node scripts/lint-gate.mjs --update       # regenerate baseline (debt paydown)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'build', 'lint-baseline.json');

const argv = process.argv.slice(2);
const update = argv.includes('--update');
const changedMode = argv.includes('--changed');

function eslintJson(targetArgs) {
  // Resolve the local eslint binary directly: spawning `npx` fails on some
  // Windows environments where npx lives outside the child PATH. eslint exits
  // non-zero whenever it FINDS errors — that is the normal path here, so read
  // stdout off the failure instead of treating it as fatal.
  const eslintBin = resolve(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [eslintBin, ...targetArgs, '-f', 'json'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    stdout = err.stdout ?? '';
    if (!stdout.trim().startsWith('[')) throw err;
  }
  return JSON.parse(stdout || '[]');
}

function stableKey(filePath) {
  // Machine-independent key: path relative to the repo root with forward
  // slashes. (Splitting on the checkout directory name breaks on CI where the
  // runner folder differs.)
  return relative(ROOT, filePath).split(sep).join('/');
}

function errorCounts(json) {
  const counts = new Map();
  let total = 0;
  for (const file of json) {
    for (const message of file.messages ?? []) {
      if ((message.severity ?? 1) < 2) continue;
      const key = `${stableKey(file.filePath)}|${message.ruleId ?? '(parse)'}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total += 1;
    }
  }
  return { counts, total };
}

function changedFiles() {
  const out = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  return [...out.split(/\r?\n/), ...untracked.split(/\r?\n/)]
    .map((f) => f.trim())
    .filter((f) => /\.(ts|tsx|js|mjs|cjs|jsx)$/u.test(f))
    .filter(Boolean);
}

async function main() {
  if (changedMode) {
    const files = changedFiles();
    if (files.length === 0) {
      console.log('[lint-gate] no changed lintable files');
      process.exit(0);
    }
    let json;
    try {
      json = eslintJson(files);
    } catch (err) {
      console.error('[lint-gate] eslint run failed:', err.message?.slice(0, 400));
      process.exit(2);
    }
    const offenders = [];
    let total = 0;
    for (const file of json) {
      for (const message of file.messages ?? []) {
        if ((message.severity ?? 1) < 2) continue;
        total += 1;
        offenders.push(`${stableKey(file.filePath)}:${message.line} [${message.ruleId}] ${message.message.slice(0, 120)}`);
      }
    }
    if (total > 0) {
      console.error(`[lint-gate] CHANGED FILES have ${total} lint error(s) — new code must be clean:`);
      for (const line of offenders.slice(0, 40)) console.error('  ' + line);
      process.exit(1);
    }
    console.log(`[lint-gate] changed files clean (${files.length} files)`);
    process.exit(0);
  }

  let json;
  try {
    json = eslintJson([]);
  } catch (err) {
    console.error('[lint-gate] eslint run failed:', err.message?.slice(0, 400));
    process.exit(2);
  }
  const { counts, total } = errorCounts(json);

  if (update) {
    mkdirSync(dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(BASELINE_PATH, `${JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      totalErrors: total,
      entries: Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b))),
    }, null, 2)}\n`);
    console.log(`[lint-gate] baseline updated: ${total} errors across ${counts.size} file|rule keys → ${BASELINE_PATH}`);
    process.exit(0);
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error(`[lint-gate] baseline missing: ${BASELINE_PATH} (run npm run lint:baseline:update)`);
    process.exit(2);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const baseEntries = baseline.entries ?? {};
  const regressions = [];
  const improvements = [];
  const keys = new Set([...Object.keys(baseEntries), ...counts.keys()]);
  for (const key of keys) {
    const base = baseEntries[key] ?? 0;
    const now = counts.get(key) ?? 0;
    if (now > base) regressions.push({ key, base, now });
    else if (now < base) improvements.push({ key, base, now });
  }

  console.log(`[lint-gate] total errors now: ${total} (baseline ${baseline.totalErrors ?? '?'})`);
  for (const item of improvements.slice(0, 20)) {
    console.log(`  improved: ${item.key} ${item.base} → ${item.now}`);
  }
  if (regressions.length > 0) {
    console.error(`[lint-gate] FAIL — ${regressions.length} file|rule key(s) above baseline:`);
    for (const item of regressions.slice(0, 40)) {
      console.error(`  ${item.key}: ${item.base} → ${item.now}`);
    }
    console.error('Fix the new errors (or pay down debt and npm run lint:baseline:update).');
    process.exit(1);
  }
  console.log('[lint-gate] PASS — no lint regression against baseline');
  process.exit(0);
}

main().catch((err) => {
  console.error('[lint-gate] fatal:', err);
  process.exit(2);
});
