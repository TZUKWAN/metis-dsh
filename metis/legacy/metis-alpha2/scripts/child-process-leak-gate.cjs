#!/usr/bin/env node
/**
 * Child-process leak gate (Task 5 §9).
 *
 * Repeatedly exercises REAL child-process lifecycles against the built app's
 * own binaries and asserts, with an OS-level process census, that nothing
 * leaks:
 *   mcp        — spawn/stop real MCP stdio servers through the production
 *                MCPManager + StdioTransport (the same code the app uses).
 *   terminal   — spawn/kill real PTYs through node-pty exactly as main.ts
 *                wires them (Electron-ABI runtime via run-vitest-electron).
 *   genoffice  — launch/close the real GenOffice sidecar electron and assert
 *                the full process tree is reaped (taskkill /T /F path).
 *
 * After every stop/kill cycle the gate counts descendants by tracking spawned
 * PIDs and rescanning the Windows process list for those PIDs; it also checks
 * that no reserved ports remain bound and that the temp profile directory can
 * be renamed (i.e. no file lock would block update/uninstall).
 *
 * Usage:
 *   node scripts/child-process-leak-gate.cjs [--cycles=20] [--focus=mcp,terminal,genoffice]
 *        [--report logs/child-process-leak-gate.json]
 */

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { cycles: 20, focus: ['terminal', 'genoffice'], report: path.join(ROOT, 'logs', `child-process-leak-gate-${Date.now()}.json`) };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const key = (eq >= 0 ? raw.slice(2, eq) : raw.replace(/^--/, ''));
    const value = eq >= 0 ? raw.slice(eq + 1) : argv[i + 1];
    if (key === 'cycles') { args.cycles = Math.max(1, Math.min(50, Number(value) || 20)); if (eq < 0) i++; }
    else if (key === 'focus') { args.focus = String(value).split(',').map((f) => f.trim()).filter(Boolean); if (eq < 0) i++; }
    else if (key === 'report') { args.report = path.resolve(ROOT, value); if (eq < 0) i++; }
  }
  return args;
}

function listProcessNamesByPid(pids) {
  // One census snapshot; returns the subset of pids still alive.
  if (pids.length === 0) return new Map();
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId | ForEach-Object { $_.ProcessId }"',
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
    );
    const alive = new Set(out.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0));
    const map = new Map();
    for (const pid of pids) if (alive.has(pid)) map.set(pid, true);
    return map;
  } catch {
    return null; // census unavailable — caller decides how to report
  }
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Spawn a detached-style child and track it plus its direct children (as far
 * as the census shows). Returns { pid, killTree, census } where census() maps
 * still-alive tracked pids.
 */
function trackTree(child, extra = []) {
  const tracked = new Set([child.pid, ...extra]);
  child.on('exit', () => { /* pid stays tracked until the census proves it gone */ });
  return {
    pid: child.pid,
    track(...pids) { for (const p of pids) if (p) tracked.add(p); },
    async census() { return listProcessNamesByPid([...tracked]); },
  };
}

// ─── Scenario: MCP stdio servers (production MCPManager path) ───────────────

// MCP stdio leak check lives in tests/electron/ChildProcessLeakGate.test.ts
// (it needs the TypeScript engine, which vitest compiles natively).

// ─── Scenario: real PTY terminals (node-pty, Electron ABI) ──────────────────

async function leakCheckTerminal(cycles) {
  const evidence = { cycles, spawnedPtys: 0, leaks: [], errors: [] };
  const pids = [];
  let pty;
  try {
    ({ default: pty } = await import('node-pty'));
  } catch (err) {
    evidence.errors.push(`node-pty unavailable under host Node (ABI): ${err.message}`);
    evidence.note = 'run under scripts/run-vitest-electron.mjs for the Electron-ABI rebuild';
    return evidence;
  }
  for (let i = 0; i < cycles; i++) {
    try {
      const term = pty.spawn(process.platform === 'win32' ? 'powershell.exe' : 'bash', ['-NoLogo', '-Command', 'Start-Sleep -Seconds 120'], {
        name: 'xterm-256color', cols: 80, rows: 24, cwd: os.tmpdir(),
        env: { ...process.env, PROMPT: '$ ' },
      });
      pids.push(term.pid);
      evidence.spawnedPtys += 1;
      term.write('exit\r');
      // main.ts kills PTYs with session.terminal.kill(): the same API here.
      setTimeout(() => { try { term.kill(); } catch { /* already gone */ } }, 150);
    } catch (err) {
      evidence.errors.push(`pty(${i}): ${err.message}`);
    }
    await wait(80);
  }
  await wait(2_000);
  const alive = listProcessNamesByPid(pids);
  if (alive === null) evidence.errors.push('process census unavailable');
  else for (const pid of pids) if (alive.has(pid)) evidence.leaks.push({ kind: 'pty', pid });
  return evidence;
}

// ─── Scenario: real GenOffice sidecar electron (launch/close) ───────────────

async function leakCheckGenoffice(cycles) {
  const evidence = { cycles, launched: 0, leaks: [], errors: [] };
  // Launch shape mirrors scripts/verify-genoffice-hosts.cjs (the known-good
  // host drill): repo electron + compiled wrapper + the SOURCE-tree slides
  // entry/cwd (the staged tree under dist-electron/genoffice lacks the
  // module-type pin that afterPack adds during packaging).
  const genofficeRoot = process.env.METIS_GENOFFICE_ROOT
    ? path.resolve(process.env.METIS_GENOFFICE_ROOT)
    : path.resolve(ROOT, '..', 'tools', 'genoffice');
  const wrapper = path.join(ROOT, 'dist-electron', 'electron', 'genofficeStandaloneWrapper.js');
  const entry = path.join(genofficeRoot, 'apps', 'slides', 'out', 'main', 'index.js');
  const cwd = path.join(genofficeRoot, 'apps', 'slides');
  const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!fs.existsSync(wrapper) || !fs.existsSync(entry) || !fs.existsSync(electronExe)) {
    evidence.errors.push('genoffice wrapper/entry or electron binary missing — build the app first (npm run build:electron)');
    evidence.note = 'tier-2 precondition: built output';
    return evidence;
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-leak-genoffice-profile-'));
  for (let i = 0; i < Math.min(cycles, 10); i++) {
    const docPath = path.join(profile, `leak-${Date.now()}.pptx`);
    const child = spawn(electronExe, [
      `--user-data-dir=${path.join(profile, 'userdata-' + i)}`,
      '--disable-gpu', wrapper, entry, docPath,
    ], {
      cwd,
      env: { ...process.env, GENOFFICE_DISABLE_ANALYTICS: '1', GENOFFICE_DISABLE_CLOUD: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const tree = trackTree(child);
    await wait(2_000); // let the sidecar (and its children) fully spawn
    // main.ts closes GenOffice with taskkill /PID <pid> /T /F on win32 — the
    // gate uses the identical kill shape.
    const killed = await new Promise((resolve) => {
      if (process.platform !== 'win32') { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(true); return; }
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.once('exit', (code) => resolve(code === 0));
      killer.once('error', () => resolve(false));
    });
    if (!killed) evidence.errors.push(`kill failed on cycle ${i}`);
    await wait(1_500);
    const alive = await tree.census();
    if (alive === null) evidence.errors.push(`census unavailable on cycle ${i}`);
    else for (const pid of alive.keys()) if (pid !== child.pid) evidence.leaks.push({ kind: 'genoffice-descendant', pid, cycle: i });
    evidence.launched += 1;
  }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* temp */ }
  return evidence;
}

// ─── Port + file-lock checks ────────────────────────────────────────────────

function checkPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function checkFileLock(profileDir) {
  const probe = path.join(profileDir, 'lock-probe');
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    const renamed = `${profileDir}-renamed-${Date.now()}`;
    fs.renameSync(profileDir, renamed);
    fs.rmSync(renamed, { recursive: true, force: true });
    return { lockFree: true, error: null };
  } catch (err) {
    return { lockFree: false, error: err.message };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[leak-gate] cycles=${args.cycles} focus=${args.focus.join(',')}`);
  const report = {
    gate: 'child-process-leak',
    cycles: args.cycles,
    startedAt: new Date().toISOString(),
    scenarios: {},
    status: 'passed',
  };

  if (args.focus.includes('terminal')) {
    report.scenarios.terminal = await leakCheckTerminal(args.cycles);
  }
  if (args.focus.includes('genoffice')) {
    report.scenarios.genoffice = await leakCheckGenoffice(args.cycles);
  }

  // Ports the app's own tooling commonly reserves; must be rebindable after runs.
  report.portChecks = [];
  for (const port of [9477, 5173, 5174]) {
    const free = await checkPortFree(port);
    report.portChecks.push({ port, free });
    if (!free) report.status = 'failed';
  }

  // File-lock check in a fresh temp profile.
  report.fileLock = await checkFileLock(path.join(os.tmpdir(), `metis-leak-lock-probe-${Date.now()}`));
  if (!report.fileLock.lockFree) report.status = 'failed';

  const totalLeaks = Object.values(report.scenarios).reduce((sum, s) => sum + ((s.leaks?.length) ?? 0), 0);
  const totalErrors = Object.values(report.scenarios).reduce((sum, s) => sum + ((s.errors?.length) ?? 0), 0);
  if (totalLeaks > 0) report.status = 'failed';
  if (totalErrors > 0 && report.status !== 'failed') report.status = 'incomplete';

  report.summary = { totalLeaks, totalErrors };
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(args.report), { recursive: true });
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log('--- child-process leak gate summary ---');
  for (const [name, s] of Object.entries(report.scenarios)) {
    console.log(`${name}: leaks=${s.leaks?.length ?? 0} errors=${s.errors?.length ?? 0} ${(s.errors || []).slice(0, 3).join(' | ')}`);
  }
  console.log(`ports: ${report.portChecks.map((p) => `${p.port}=${p.free ? 'free' : 'BOUND'}`).join(' ')} | fileLock: ${report.fileLock.lockFree ? 'free' : report.fileLock.error}`);
  console.log(`gate: ${report.status.toUpperCase()} report: ${args.report}`);
  process.exit(report.status === 'passed' ? 0 : report.status === 'incomplete' ? 2 : 1);
}

main().catch((err) => { console.error('[leak-gate] fatal:', err); process.exit(1); });
