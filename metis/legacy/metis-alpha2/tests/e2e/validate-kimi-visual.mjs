/**
 * VALIDATE-KIMI-201 v2: Static build + loadFile + lifecycle listeners.
 * No HMR, no dev server, no offscreen race conditions.
 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SITE = path.join(ROOT, 'test-results', 'kimi-visual-site');
const RESULTS = path.join(ROOT, 'test-results', `kimi-visual-${Date.now()}`);
fs.mkdirSync(RESULTS, { recursive: true });

const LOG = [];
function log(m) { const l = `[${new Date().toISOString()}] ${m}`; LOG.push(l); console.log(l); }

const CONFIGS = [
  { label: 'desktop-100pct', width: 1440, height: 900, zoom: 1 },
  { label: 'desktop-200pct', width: 1440, height: 900, zoom: 2 },
  { label: 'desktop-rtl', width: 1440, height: 900, zoom: 1, dir: 'rtl' },
  { label: 'desktop-forced-colors', width: 1440, height: 900, zoom: 1, forcedColors: true, reducedMotion: true },
  { label: 'narrow-400px', width: 400, height: 800, zoom: 1 },
  { label: 'narrow-rtl', width: 400, height: 800, zoom: 1, dir: 'rtl' },
];

async function capture(win, label) {
  const png = await win.webContents.capturePage();
  const p = path.join(RESULTS, `kimi-${label}.png`);
  fs.writeFileSync(p, png.toPNG());
  log(`  screenshot: ${p} (${png.toPNG().length} bytes)`);
  return p;
}

function waitForReady(win, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(async () => {
      try {
        const ready = await win.webContents.executeJavaScript('window.__KIMI_VISUAL_READY__');
        if (ready) { clearInterval(iv); resolve(); }
      } catch {}
      if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error('ready timeout')); }
    }, 200);
  });
}

app.whenReady().then(async () => {
  for (const cfg of CONFIGS) {
    log(`Config: ${cfg.label} (${cfg.width}x${cfg.height}, zoom=${cfg.zoom}${cfg.dir?', dir='+cfg.dir:''}${cfg.forcedColors?', forced-colors+reduced-motion':''})`);

    const win = new BrowserWindow({
      width: cfg.width, height: cfg.height, show: false,
      backgroundThrottling: false,
      webPreferences: { sandbox: false, contextIsolation: true, partition: `persist:kimi-visual-${Date.now()}-${Math.random().toString(36).slice(2)}` },
    });

    const events = [];
    win.webContents.on('console-message', (e, l, m) => { events.push(`console: ${m}`); });
    win.webContents.on('dom-ready', () => { events.push('dom-ready'); });
    win.webContents.on('did-finish-load', () => { events.push('did-finish-load'); });
    win.webContents.on('did-fail-load', (e, code, desc, url) => { events.push(`did-fail-load: ${code} ${desc} ${url}`); });
    win.on('unresponsive', () => { events.push('unresponsive'); });
    win.webContents.on('render-process-gone', (e, d) => { events.push(`render-process-gone: ${d.reason}`); });

    try {
      win.webContents.setZoomFactor(cfg.zoom);

      if (cfg.forcedColors) {
        win.webContents.insertCSS(`@media (forced-colors:active){*,*::after,*::before{forced-color-adjust:none}}`);
      }

      // Load the static build
      const htmlPath = path.join(SITE, 'index.html');
      log(`  loading: ${htmlPath}`);
      await win.loadFile(htmlPath);

      // Wait for React to commit
      await waitForReady(win);

      // Set RTL if needed
      if (cfg.dir === 'rtl') {
        await win.webContents.executeJavaScript(`document.documentElement.dir='rtl'`);
        await new Promise(r => setTimeout(r, 500));
      }

      // Emulate forced-colors + reduced-motion via CDP
      if (cfg.forcedColors) {
        try {
          await win.webContents.debugger.attach();
          await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
            features: [
              { name: 'forced-colors', value: 'active' },
              { name: 'prefers-reduced-motion', value: 'reduce' },
            ],
          });
          await new Promise(r => setTimeout(r, 800));
        } catch (e) { log(`  CDP: ${e.message}`); }
      }

      await capture(win, cfg.label);

      try { win.webContents.debugger.detach(); } catch {}
    } catch (e) {
      log(`  ERROR: ${e.message}`);
      events.forEach(ev => log(`  event: ${ev}`));
    } finally {
      win.destroy();
    }
  }

  const evidence = { timestamp: new Date().toISOString(), siteDir: SITE, configs: CONFIGS.map(c => c.label), screenshots: fs.readdirSync(RESULTS).filter(f => f.endsWith('.png')), log: LOG };
  fs.writeFileSync(path.join(RESULTS, 'evidence.json'), JSON.stringify(evidence, null, 2));
  log(`Done. ${evidence.screenshots.length} screenshots.`);
  app.exit(0);
});
