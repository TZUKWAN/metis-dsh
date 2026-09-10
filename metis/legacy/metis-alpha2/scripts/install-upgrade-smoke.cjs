#!/usr/bin/env node
/**
 * Windows install / upgrade / uninstall smoke (Task 5 §18).
 *
 * Exercises the REAL NSIS installer chain (real install, real upgrade, real
 * uninstall) with these isolation rules:
 *   - installs into a custom directory containing spaces AND non-ASCII chars;
 *   - launching the installed app uses its REAL userData (Electron resolves
 *     appData via the Windows known-folder API, NOT the %APPDATA% env var —
 *     there is no supported override). Therefore every assertion about user
 *     data is READ-ONLY: we hash the existing metis.db before and after the
 *     installer runs and assert the INSTALLER never touched it, and we never
 *     seed or delete anything under the real profile.
 *   - app boot evidence is captured from the app's own stdout
 *     ([METIS_RUNTIME_IDENTITY] + "[Main] PersistenceStore initialized.").
 *
 * Upgrade semantics: with --previous=older-setup.exe the smoke installs that
 * older build first and upgrades to the current one. Without it, the current
 * installer is re-run over an existing install (upgrade-in-place), which is
 * the NSIS path that must preserve user data and registry integrity.
 *
 * Usage:
 *   node scripts/install-upgrade-smoke.cjs [--installer=release4/...-Setup.exe]
 *        [--previous=older-setup.exe] [--keep-installed] [--report=logs/....json]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release4');

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
};
const KEEP_INSTALLED = process.argv.includes('--keep-installed');
const REPORT_PATH = path.resolve(argOf('--report') ?? path.join(ROOT, 'logs', `install-upgrade-smoke-${new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)}.json`));
const PREVIOUS_INSTALLER = argOf('--previous') ? path.resolve(argOf('--previous')) : null;

const INSTALL_DIR = path.join(os.tmpdir(), 'Metis Smoke 升级测试 dir');
const EXEC_TIMEOUT_MS = 10 * 60_000;

const report = {
  gate: 'install-upgrade-smoke',
  status: 'failed',
  startedAt: new Date().toISOString(),
  installer: null,
  previousInstaller: PREVIOUS_INSTALLER,
  installDir: INSTALL_DIR,
  realUserDataIsolation: 'read-only assertions only; the installer is never allowed to touch user data',
  assertions: [],
};
function check(name, ok, detail) {
  report.assertions.push({ name, ok: ok === true, detail: detail ?? null });
  console.log(`[install-smoke] ${ok === true ? 'ok  ' : 'FAIL'} ${name}${detail && !ok ? ` → ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  return ok === true;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function findLatestInstaller() {
  const explicit = argOf('--installer');
  if (explicit) return path.resolve(explicit);
  if (!fs.existsSync(RELEASE_DIR)) return null;
  const setups = fs.readdirSync(RELEASE_DIR)
    .filter((f) => /Setup-.*-x64\.exe$/iu.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(RELEASE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return setups[0] ? path.join(RELEASE_DIR, setups[0].f) : null;
}

function runInstaller(installer) {
  return new Promise((resolve, reject) => {
    // NSIS: /S = silent, /D=<dir> must be the LAST argument and UNQUOTED.
    const child = spawn(installer, ['/S', `/D=${INSTALL_DIR}`], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      try { execSync(`taskkill /PID ${child.pid} /T /F`, { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ }
      reject(new Error('installer timed out'));
    }, EXEC_TIMEOUT_MS);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function findInstalledExe() {
  const primary = path.join(INSTALL_DIR, 'Metis Research Workbench.exe');
  if (fs.existsSync(primary)) return primary;
  if (fs.existsSync(INSTALL_DIR)) {
    const exes = fs.readdirSync(INSTALL_DIR).filter((f) => f.toLowerCase().endsWith('.exe') && /metis/iu.test(f) && !/^uninstall/iu.test(f));
    if (exes.length > 0) return path.join(INSTALL_DIR, exes[0]);
  }
  return null;
}

/** Launch the installed app, capture stdout, resolve on the persistence-ready markers. */
function bootInstalled(exe, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(exe, [], { cwd: INSTALL_DIR, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    const t0 = Date.now();
    const done = (result) => {
      try { execSync(`taskkill /PID ${child.pid} /T /F`, { windowsHide: true, stdio: 'ignore' }); } catch { /* exiting */ }
      resolve({ ...result, pid: child.pid });
    };
    const timer = setTimeout(() => done({ ok: false, reason: `boot markers not seen within ${timeoutMs}ms`, stdout: stdout.slice(-1500) }), timeoutMs);
    const onChunk = (c) => {
      stdout += c.toString();
      if (stdout.includes('[METIS_RUNTIME_IDENTITY]') && stdout.includes('PersistenceStore initialized')) {
        clearTimeout(timer);
        const identity = /\[METIS_RUNTIME_IDENTITY\] (.*)/.exec(stdout)?.[1] ?? null;
        let parsed = null;
        try { parsed = JSON.parse(identity); } catch { /* keep raw */ }
        done({ ok: true, identity: parsed, durationMs: Date.now() - t0 });
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.once('exit', (code) => {
      clearTimeout(timer);
      done({ ok: false, reason: `app exited before persistence init (code=${code})`, stdout: stdout.slice(-1500) });
    });
  });
}

function sha256File(file) {
  const { createHash } = require('node:crypto');
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function realUserDb() {
  const candidates = [
    path.join(process.env.APPDATA ?? '', 'metis-workbench', 'metis-data', 'metis.db'),
    path.join(process.env.APPDATA ?? '', 'Metis Research Workbench', 'metis-data', 'metis.db'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function killTree(pid) {
  try { execSync(`taskkill /PID ${pid} /T /F`, { windowsHide: true, stdio: 'ignore' }); } catch { /* gone */ }
}

async function main() {
  try {
    const installer = findLatestInstaller();
    report.installer = installer;
    if (!installer || !fs.existsSync(installer)) {
      check('produced NSIS installer exists (run the release chain first)', false, { installer, releaseDir: RELEASE_DIR });
      report.status = 'blocked';
      writeReport(2);
      return;
    }
    console.log(`[install-smoke] installer: ${installer}`);

    // Snapshot the real user database (read-only) as the "user data" witness.
    const realDb = realUserDb();
    const beforeHash = realDb ? { path: realDb, sha256: sha256File(realDb), size: fs.statSync(realDb).size } : null;
    check('existing user database located for read-only witness', Boolean(beforeHash), { realDb });

    // 1. Install — previous alpha fixture if provided, else the current installer.
    const firstInstaller = PREVIOUS_INSTALLER && fs.existsSync(PREVIOUS_INSTALLER) ? PREVIOUS_INSTALLER : installer;
    const installCode = await runInstaller(firstInstaller);
    if (!check('silent install exits cleanly (custom dir: spaces + non-ASCII)', installCode === 0, { installer: firstInstaller, code: installCode })) throw new Error('install failed');
    const exe = findInstalledExe();
    if (!check('app executable present in the custom install dir', Boolean(exe), { installDir: INSTALL_DIR })) throw new Error('exe missing');

    // 2. First boot of the installed app: real persistence init, then kill.
    const boot1 = await bootInstalled(exe);
    check('installed app boots with [METIS_RUNTIME_IDENTITY] + PersistenceStore initialized', boot1.ok, boot1.ok ? { durationMs: boot1.durationMs, mode: boot1.identity?.mode, dataDir: boot1.identity?.dataDir } : boot1);
    if (!boot1.ok) throw new Error('first boot failed');
    check('booted in packaged mode', boot1.identity?.mode === 'packaged', boot1.identity?.mode);

    // 3. Upgrade in place — the installer must not touch the user database.
    const upgradeCode = await runInstaller(installer);
    if (!check('upgrade (installer re-run over existing install) exits cleanly', upgradeCode === 0, { code: upgradeCode })) throw new Error('upgrade failed');
    if (beforeHash) {
      const afterHash = { sha256: sha256File(realDb), size: fs.statSync(realDb).size };
      check('installer left the existing user database byte-identical (data-retention policy)',
        afterHash.sha256 === beforeHash.sha256 && afterHash.size === beforeHash.size,
        { before: beforeHash.sha256.slice(0, 12), after: afterHash.sha256.slice(0, 12) });
    }

    // 4. Boot again after the upgrade.
    const boot2 = await bootInstalled(exe);
    check('app boots with full persistence init after upgrade', boot2.ok, boot2.ok ? { durationMs: boot2.durationMs } : boot2);

    // 5. Silent uninstall — user data must survive (deleteAppDataOnUninstall:false).
    if (KEEP_INSTALLED) {
      console.log('[install-smoke] --keep-installed set: skipping uninstall phase');
      report.status = report.assertions.every((a) => a.ok) ? 'passed' : 'failed';
    } else {
      const uninstallers = fs.existsSync(INSTALL_DIR)
        ? fs.readdirSync(INSTALL_DIR).filter((f) => /^uninstall.*\.exe$/iu.test(f))
        : [];
      const uninstallPath = uninstallers[0] ? path.join(INSTALL_DIR, uninstallers[0]) : null;
      if (check('uninstaller present in install dir', Boolean(uninstallPath), { uninstallers })) {
        const uninstallCode = await new Promise((resolve) => {
          // Plain /S: the uninstaller deletes its own directory contents. The
          // `_?=` variant is only for a relocated copy and SKIPS deletion.
          const child = spawn(uninstallPath, ['/S'], { stdio: 'ignore', windowsHide: true, detached: false });
          const t = setTimeout(() => resolve(-1), EXEC_TIMEOUT_MS);
          child.once('exit', (c) => { clearTimeout(t); resolve(c); });
          child.once('error', () => resolve(-1));
        });
        // NSIS uninstaller hands off to a temp copy: poll until the exe is gone.
        let exeGone = false;
        for (let i = 0; i < 15; i++) {
          exeGone = !fs.existsSync(exe ?? path.join(INSTALL_DIR, 'Metis Research Workbench.exe'));
          if (exeGone) break;
          await sleep(2_000);
        }
        check('silent uninstall removes the installed executable', exeGone, { uninstallPath, code: uninstallCode });
        if (realDb) {
          check('real userData survives uninstall (explicit-user-action-only removal policy)', fs.existsSync(realDb), { realDb });
        }
      }
      report.status = report.assertions.every((a) => a.ok) ? 'passed' : 'failed';
    }
  } catch (err) {
    report.error = String(err && (err.stack || err.message) || err);
  }
  writeReport(report.status === 'passed' ? 0 : report.status === 'blocked' ? 2 : 1);
}

function writeReport(exitCode) {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  const failed = report.assertions.filter((a) => !a.ok);
  console.log(`--- install smoke: ${report.status.toUpperCase()} (${report.assertions.length - failed.length}/${report.assertions.length}) ---`);
  console.log(`report: ${REPORT_PATH}`);
  process.exit(exitCode);
}

main().catch((err) => { console.error('[install-smoke] fatal:', err); process.exit(1); });
