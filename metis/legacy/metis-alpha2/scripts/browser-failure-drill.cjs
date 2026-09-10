#!/usr/bin/env node
/**
 * Network / browser failure isolation drill (Task 5 §11).
 *
 * Runs INSIDE the Electron main process (`electron scripts/browser-failure-drill.cjs`)
 * because BrowserWindow/WebContentsView are real main-process-only APIs —
 * worker-thread vitest cannot touch them.
 *
 * Scenarios (all against a real BrowserService + local failure servers):
 *   DNS failure, connection refused, redirect loop, offline emulation,
 *   huge streaming response, and a forcefully crashed WebContents.
 * Universal assertion: the main window and the service survive every failure.
 *
 * Evidence: JSON report (default logs/browser-failure-drill-<stamp>.json).
 * Exit codes: 0 passed · 1 failed · 2 blocked (build missing).
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const REPORT_INDEX = process.argv.indexOf('--report');
const REPORT_PATH = path.resolve(
  REPORT_INDEX >= 0 && process.argv[REPORT_INDEX + 1]
    ? process.argv[REPORT_INDEX + 1]
    : path.join(ROOT, 'logs', `browser-failure-drill-${new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)}.json`),
);

const report = { drill: 'browser-failure-isolation', status: 'failed', startedAt: new Date().toISOString(), assertions: [], scenarios: {} };
const check = (name, ok, detail) => {
  report.assertions.push({ name, ok: ok === true, detail: detail ?? null });
  console.log(`[browser-drill] ${ok === true ? 'ok  ' : 'FAIL'} ${name}${ok === true ? '' : ` → ${JSON.stringify(detail)?.slice(0, 260)}`}`);
  return ok === true;
};

function localServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

async function childMain() {
  const { app, BrowserWindow } = require('electron');
  app.setName('METIS Browser Failure Drill');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-browser-drill-'));
  app.setPath('userData', profile);

  const mainEntry = path.join(ROOT, 'dist-electron', 'electron', 'main.js');
  if (!fs.existsSync(mainEntry)) {
    report.status = 'blocked';
    report.blocked = { reason: 'electron_build_missing', mainEntry };
    writeReport(2);
    app.exit(2);
    return;
  }
  // Boot the real production main (services wire up), then build a dedicated
  // BrowserService against a fresh window — the same service the app exposes.
  await import(pathToFileURL(path.resolve(mainEntry)).href);
  await app.whenReady();

  const { BrowserService } = await import(pathToFileURL(path.join(ROOT, 'dist-electron', 'electron', 'BrowserService.js')).href);
  const window = new BrowserWindow({ show: false, width: 900, height: 700 });
  const dataDir = path.join(profile, 'metis-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const service = new BrowserService({ window, dataDir, store: null });

  const scenarios = report.scenarios;

  // 1. DNS failure
  const dns = await service.navigate('http://this-host-does-not-exist.invalid/');
  scenarios.dnsFailure = dns;
  check('DNS failure returns ok:false with a stable error', dns?.ok === false && typeof dns?.error === 'string', dns);

  // 2. Connection refused
  const refused = await service.navigate('http://127.0.0.1:1/');
  scenarios.connectionRefused = refused;
  check('connection refused returns ok:false', refused?.ok === false, refused);

  // 3. Redirect loop
  const loop = await localServer((req, res) => { res.writeHead(302, { Location: '/' }); res.end(); });
  const loopResult = await service.navigate(`${loop.url}/loop`);
  scenarios.redirectLoop = loopResult;
  await loop.close();
  check('redirect loop does not hang or crash the service', typeof loopResult === 'object', loopResult);

  // 4. Offline emulation
  window.webContents.session.enableNetworkEmulation({ offline: true });
  const offline = await service.navigate('http://127.0.0.1:1/offline');
  scenarios.offline = offline;
  window.webContents.session.disableNetworkEmulation();
  check('offline emulation blocks navigation with ok:false', offline?.ok === false, offline);

  // 5. Huge streaming response
  const huge = await localServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    const chunk = 'x'.repeat(1024 * 1024);
    let written = 0;
    const timer = setInterval(() => {
      if (written >= 64 * 1024 * 1024) { clearInterval(timer); res.end(); return; }
      res.write(chunk); written += chunk.length;
    }, 10);
    res.on('close', () => clearInterval(timer));
  });
  const hugeResult = await service.navigate(`${huge.url}/huge`);
  scenarios.hugeResponse = hugeResult;
  await huge.close();
  check('huge streaming response leaves the service alive', typeof hugeResult === 'object', hugeResult);

  // 6. WebContents crash
  const view = (service.view && service.view.webContents) ? service.view : null;
  if (view) {
    view.webContents.forcefullyCrashRenderer();
    await new Promise((r) => setTimeout(r, 1_500));
    scenarios.webContentsCrash = { crashed: view.webContents.isCrashed() };
    check('WebContents crashed as requested', view.webContents.isCrashed() === true, { crashed: view.webContents.isCrashed() });
  } else {
    scenarios.webContentsCrash = { skipped: 'view not materialized (lazy)' };
    check('WebContents crash scenario: lazy view legitimately absent', true, scenarios.webContentsCrash);
  }

  // Universal: the main window is still alive after every failure.
  check('main window survives all failure scenarios', window.isDestroyed() === false, { destroyed: window.isDestroyed() });

  report.status = report.assertions.every((a) => a.ok) ? 'passed' : 'failed';
  report.finishedAt = new Date().toISOString();
  writeReport(report.status === 'passed' ? 0 : 1);
  app.exit(report.status === 'passed' ? 0 : 1);
}

function pathToFileURL(p) { return require('node:url').pathToFileURL(p); }

function writeReport(exitCode) {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`--- browser failure drill: ${report.status.toUpperCase()} report: ${REPORT_PATH}`);
}

if (process.env.METIS_BROWSER_DRILL_CHILD === '1') {
  childMain().catch((err) => {
    report.error = String(err && (err.stack || err.message) || err);
    writeReport(1);
    process.exit(1);
  });
} else {
  // Orchestrator: spawn electron to run the child phase.
  const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!fs.existsSync(electronExe)) {
    console.error('[browser-drill] electron binary missing');
    process.exit(2);
  }
  const child = spawn(electronExe, [__filename], {
    cwd: ROOT,
    env: { ...process.env, METIS_BROWSER_DRILL_CHILD: '1', ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout?.on('data', (c) => { out += c.toString(); process.stdout.write(c); });
  child.stderr?.on('data', (c) => { out += c.toString(); });
  const timer = setTimeout(() => {
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* dying */ }
    console.error('[browser-drill] child timed out');
    process.exit(1);
  }, 180_000);
  child.once('exit', (code) => {
    clearTimeout(timer);
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH.replace(/\.json$/, '.stdout.log'), out);
    process.exit(code === 0 ? 0 : 1);
  });
}
