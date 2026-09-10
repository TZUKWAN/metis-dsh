#!/usr/bin/env node
/** Minimal repro: personalization → settings switch renderer crash. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

const rendererExpression = (expr) => `(async () => { try { return await (${expr}); } catch (error) { return { __e2eError: String(error && (error.stack || error.message) || error) }; } })()`;

async function childMain() {
  const { app, BrowserWindow } = require('electron');
  app.setName('METIS diag');
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'metis-diag-switch-')));
  const mainEntry = path.join(ROOT, 'dist-electron', 'electron', 'main.js');
  await import(require('node:url').pathToFileURL(mainEntry).href);
  await app.whenReady();
  let win = null;
  const dl = Date.now() + 40_000;
  while (!win && Date.now() < dl) {
    win = BrowserWindow.getAllWindows().find((c) => !c.isDestroyed()) || null;
    if (!win) await new Promise((r) => setTimeout(r, 200));
  }
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  const run = (expr) => win.webContents.executeJavaScript(rendererExpression(expr), true);
  await run(`window.metis?.startupStatus?.().then((v) => v?.ready === true)`);
  console.log('[diag] ready');

  // to personalization
  let clicked = await run(`(() => { const n = document.querySelector('[data-nav-id="personalization"]'); if (!n) return false; n.click(); return true; })()`);
  console.log('[diag] personalization clicked:', clicked);
  await new Promise((r) => setTimeout(r, 4_000));
  console.log('[diag] scenario-workbench present:', await run(`Boolean(document.querySelector('[data-testid="scenario-workbench"]'))`));
  console.log('[diag] window.metis alive:', await run(`Boolean(window.metis)`));

  // to settings
  clicked = await run(`(() => { const n = document.querySelector('[data-nav-id="settings"]'); if (!n) return false; n.click(); return true; })()`);
  console.log('[diag] settings clicked:', clicked);
  await new Promise((r) => setTimeout(r, 4_000));
  console.log('[diag] settings panel present:', await run(`Boolean(document.querySelector('.settings-panel, [class*="settings"]'))`));
  console.log('[diag] window.metis alive:', await run(`Boolean(window.metis)`));
  console.log('[diag] document.title:', await run(`document.title`));
  console.log('[diag] body children:', await run(`document.body.children.length`));
  app.exit(0);
}

if (process.env.METIS_DIAG_CHILD === '1') {
  childMain().catch((err) => { console.error('[diag] fatal:', err); process.exit(1); });
} else {
  const exe = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const child = spawn(exe, [__filename], { cwd: ROOT, env: { ...process.env, METIS_DIAG_CHILD: '1', ELECTRON_ENABLE_LOGGING: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  child.stdout?.on('data', (c) => { out += c.toString(); process.stdout.write(c); });
  child.stderr?.on('data', (c) => { out += c.toString(); });
  const t = setTimeout(() => { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch {} }, 120_000);
  child.once('exit', () => { clearTimeout(t); const idx = out.indexOf('[diag] ready'); fs.writeFileSync(path.join(ROOT, 'logs', 'diag-switch.log'), out); void idx; process.exit(0); });
}
