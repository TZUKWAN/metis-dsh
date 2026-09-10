/**
 * VALIDATE-DEEPSEEK-301: Visual CJK verification of generated PDF.
 * Uses Electron's built-in PDF viewer + capturePage() to render each
 * page to PNG, then reports files for manual inspection.
 * Also tries pdftotext -enc UTF-8 -layout for better text extraction.
 */
import { app, BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const RESULTS = path.join(ROOT, 'test-results', `pdf-visual-${Date.now()}`);
fs.mkdirSync(RESULTS, { recursive: true });

const LOG = [];
function log(m) { const l = `[${new Date().toISOString()}] ${m}`; LOG.push(l); console.log(l); }

// Find the most recent PDF from a previous validation run
const resultsRoot = path.join(ROOT, 'test-results');
const dirs = fs.readdirSync(resultsRoot).filter(d => d.startsWith('validate-') && fs.existsSync(path.join(resultsRoot, d, 'cjk-test.pdf'))).sort().reverse();
if (dirs.length === 0) { log('FATAL: no previous PDF found in test-results'); app.exit(1); }
const pdfPath = path.join(resultsRoot, dirs[0], 'cjk-test.pdf');
log(`Using PDF: ${pdfPath} (${fs.statSync(pdfPath).size} bytes)`);

// pdftotext with UTF-8 encoding
try {
  const txtPath = path.join(RESULTS, 'cjk-utf8.txt');
  execSync(`pdftotext -enc UTF-8 -layout "${pdfPath}" "${txtPath}"`, { stdio: 'pipe', timeout: 15000 });
  if (fs.existsSync(txtPath)) {
    const text = fs.readFileSync(txtPath, 'utf-8');
    const sha = createHash('sha256').update(text).digest('hex');
    const hasCJK = /[一-鿿]/.test(text);
    const hasFullwidth = /[＀-￯]/.test(text);
    const hasCommonPunct = /[，。；：、！？（）【】《》]/.test(text);
    log(`pdftotext -enc UTF-8 -layout: ${text.length} chars, sha256=${sha}`);
    log(`  CJK chars (U+4E00-9FFF): ${hasCJK ? 'FOUND' : 'NONE'}`);
    log(`  Fullwidth: ${hasFullwidth ? 'FOUND' : 'NONE'}`);
    log(`  Common CJK punct: ${hasCommonPunct ? 'FOUND' : 'NONE'}`);
    log(`  First 200 chars: ${text.slice(0, 200)}`);
    fs.writeFileSync(path.join(RESULTS, 'cjk-utf8.txt'), text, 'utf-8');
    fs.writeFileSync(path.join(RESULTS, 'cjk-utf8-hash.txt'), sha, 'utf-8');
  }
} catch (e) { log(`pdftotext: ${e.message}`); }

// Try pdftotext -raw as well (different extraction strategy)
try {
  const rawPath = path.join(RESULTS, 'cjk-raw.txt');
  execSync(`pdftotext -raw "${pdfPath}" "${rawPath}"`, { stdio: 'pipe', timeout: 15000 });
  if (fs.existsSync(rawPath)) {
    const raw = fs.readFileSync(rawPath, 'utf-8');
    const hasCJK = /[一-鿿]/.test(raw);
    log(`pdftotext -raw: ${raw.length} chars, CJK=${hasCJK ? 'FOUND' : 'NONE'}`);
  }
} catch (e) { log(`pdftotext -raw: ${e.message}`); }

// Electron PDF viewer: load file:// PDF, capture each page as PNG
app.whenReady().then(async () => {
  log(`Electron PDF viewer: loading ${pdfPath}`);
  const win = new BrowserWindow({
    show: false,
    width: 1200, height: 1600,
    webPreferences: { offscreen: true, sandbox: false, contextIsolation: true, plugins: true },
  });

  try {
    // Load PDF via file:// URL — Electron's built-in PDF viewer handles this
    const fileUrl = `file:///${pdfPath.replace(/\\/g, '/')}`;
    await win.loadURL(fileUrl);
    // Wait for PDF to render
    await new Promise(r => setTimeout(r, 3000));

    // Get page count via JavaScript in the renderer
    const pageCount = await win.webContents.executeJavaScript(`
      (function() {
        const viewer = document.querySelector('embed[type="application/pdf"], iframe, object');
        if (viewer && viewer.contentDocument) {
          const pages = viewer.contentDocument.querySelectorAll('.page');
          return pages.length || 1;
        }
        // Fallback: check if PDF.js plugin is active
        const plugin = document.querySelector('embed');
        return plugin ? 1 : 0;
      })()
    `).catch(() => 0);
    log(`PDF viewer detected pages: ${pageCount || 'unknown (capturing single viewport)'}`);

    // Capture full page as PNG
    const png = await win.webContents.capturePage();
    const pngPath = path.join(RESULTS, 'cjk-page-full.png');
    fs.writeFileSync(pngPath, png.toPNG());
    const pngSize = fs.statSync(pngPath).size;
    const pngSha = createHash('sha256').update(png.toPNG()).digest('hex');
    log(`Full page capture: ${pngPath} (${pngSize} bytes, sha256=${pngSha})`);
    log(`VISUAL VERIFICATION: Open ${pngPath} and check:`);
    log(`  - Chinese title (一级标题) visible?`);
    log(`  - Chinese body text (中英混排/社会科学/因果识别) visible?`);
    log(`  - Table text (方法/样本量/p值/DID基准) visible?`);
    log(`  - If Chinese characters appear as boxes/tofu/????, the PDF has a font embedding issue (P0)`);
    log(`  - If Chinese is clearly visible but pdftotext can't extract it, the PDF has ToUnicode CMap gap (accessibility risk)`);

    // If multiple pages, try scrolling
    let morePages = 0;
    for (let i = 0; i < 5; i++) {
      try {
        const hasMore = await win.webContents.executeJavaScript(`
          (function() {
            const scroller = document.querySelector('embed')?.parentElement || document.body;
            const maxScroll = scroller.scrollHeight - scroller.clientHeight;
            if (maxScroll <= 10) return false;
            scroller.scrollTop = Math.min(scroller.scrollTop + scroller.clientHeight, maxScroll);
            return scroller.scrollTop > 100;
          })()
        `);
        if (!hasMore) break;
        await new Promise(r => setTimeout(r, 500));
        const p = await win.webContents.capturePage();
        const pp = path.join(RESULTS, `cjk-page-${i + 2}.png`);
        fs.writeFileSync(pp, p.toPNG());
        log(`Page ${i + 2} capture: ${pp} (${fs.statSync(pp).size} bytes)`);
        morePages++;
      } catch { break; }
    }
    log(`Total pages captured: ${1 + morePages}`);

    const evidence = { timestamp: new Date().toISOString(), pdf: pdfPath, pages: 1 + morePages, captures: fs.readdirSync(RESULTS).filter(f => f.endsWith('.png')), log: LOG };
    fs.writeFileSync(path.join(RESULTS, 'visual-evidence.json'), JSON.stringify(evidence, null, 2));
    log(`Evidence saved to ${path.join(RESULTS, 'visual-evidence.json')}`);
    app.exit(0);
  } catch (e) {
    log(`Electron PDF viewer error: ${e.message}`);
    app.exit(1);
  } finally {
    win.destroy();
  }
});
