#!/usr/bin/env node
/**
 * ABI-agnostic vitest runner for this shared workspace.
 *
 * better-sqlite3 is compiled against either the Node ABI (after `npm run
 * rebuild:node`, e.g. by `npm test`) or the Electron ABI (after `npm run
 * rebuild:electron`). Several agents share node_modules and toggle it, so a
 * fixed runner keeps breaking. This script probes which runtime can load the
 * compiled module and runs vitest with it — it never rebuilds, so it never
 * breaks a running Electron instance.
 *
 * Usage: node scripts/run-vitest-any-abi.mjs [vitest args...]
 *   e.g. node scripts/run-vitest-any-abi.mjs engine/persistence
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function canLoadSqlite(execPath, env) {
  const probe = spawnSync(execPath, ['-e', "require('better-sqlite3')"], {
    cwd: root, env, encoding: 'utf8',
  });
  return probe.status === 0;
}

const candidates = [
  { label: 'node', execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } },
  {
    label: 'electron-as-node',
    execPath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  },
];

for (const candidate of candidates) {
  if (!canLoadSqlite(candidate.execPath, candidate.env)) continue;
  if (process.env.METIS_VITEST_RUNNER_VERBOSE) {
    console.log(`[run-vitest-any-abi] using ${candidate.label} (${candidate.execPath})`);
  }
  const child = spawnSync(
    candidate.execPath,
    [path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'vitest.electron-node.config.ts', ...args],
    { stdio: 'inherit', cwd: root, env: candidate.env },
  );
  process.exit(child.status ?? 1);
}

console.error(
  '[run-vitest-any-abi] neither node nor Electron can load the compiled better-sqlite3 ABI. ' +
  'Run `npm run rebuild:node` (Node-ABI; breaks running Electron) or `npm run rebuild:electron` (Electron-ABI).',
);
process.exit(1);
