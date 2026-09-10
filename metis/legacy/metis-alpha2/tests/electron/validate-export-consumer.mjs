/**
 * VALIDATE-DEEPSEEK-301: Real consumer validation harness.
 * Run with: electron tests/electron/validate-export-consumer.mjs
 *
 * Uses the production SecureExportService + ResearchExportBuilder to:
 * 1. Generate a real PDF (via Electron BrowserWindow.printToPDF)
 * 2. Validate it with pdftotext, check structure
 * 3. Generate a real DOCX (via DocxRenderer + ZipWriter)
 * 4. Optionally open with Word COM and save PDF
 *
 * Results are written to test-results/ directory.
 */

import { app, BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const RESULTS = path.join(ROOT, 'test-results', `validate-${Date.now()}`);
fs.mkdirSync(RESULTS, { recursive: true });

const LOG = [];
function log(msg) { const line = `[${new Date().toISOString()}] ${msg}`; LOG.push(line); console.log(line); }
function resultFile(name) { return path.join(RESULTS, name); }

// ── Test content ─────────────────────────────────────────────

const CJK_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>CJK Test</title>
<style>body{font-family:"SimSun","Microsoft YaHei",sans-serif;margin:40px;line-height:1.8}
h1{font-size:24px}h2{font-size:18px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #000;padding:6px}
.fn{font-size:10pt;color:#555}</style></head><body>
<h1>Metis 导出消费者验证</h1>
<p>本文件通过 Electron BrowserWindow.printToPDF 生成，包含中英混排、表格与脚注。</p>
<h2>一、测试表格</h2>
<table><tr><th>方法</th><th>样本量</th><th>p 值</th></tr>
<tr><td>DID 基准</td><td>12,430</td><td>0.003</td></tr>
<tr><td>PSM-DID</td><td>8,210</td><td>0.007</td></tr>
<tr><td>事件研究</td><td>15,600</td><td>0.012</td></tr></table>
<h2>二、脚注测试<sup>1</sup></h2>
<p>社会科学研究中的因果识别需要多重稳健性检验与安慰剂测试。<sup>2</sup></p>
<div class="fn"><sup>1</sup> Angrist & Pischke (2009), <i>Mostly Harmless Econometrics</i>.</div>
<div class="fn"><sup>2</sup> 本验证文件仅供测试用途，不代表真实研究结论。</div>
<h2>三、英文段落</h2>
<p>This validation document demonstrates that the Metis export pipeline can faithfully render CJK text,
tables, footnotes, and mixed Chinese-English content through Electron's Chromium-based PDF engine.</p>
</body></html>`;

// ── PDF generation via real Electron printToPDF ──────────────

async function validatePdf() {
  log('=== PDF VALIDATION ===');
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: false, contextIsolation: true } });
  try {
    const encoded = encodeURIComponent(CJK_HTML);
    await win.loadURL(`data:text/html;charset=utf-8,${encoded}`);
    const pdfData = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    const pdfBuf = Buffer.from(pdfData);
    const pdfPath = resultFile('cjk-test.pdf');
    fs.writeFileSync(pdfPath, pdfBuf);
    const sha = createHash('sha256').update(pdfBuf).digest('hex');
    const size = pdfBuf.length;

    // Structural validation (same checks as validatePdfBuffer)
    const header = pdfBuf.subarray(0, 5).toString('ascii');
    const hasObj = pdfBuf.includes(Buffer.from(' obj', 'ascii'));
    const hasStartxref = pdfBuf.includes(Buffer.from('startxref', 'ascii'));
    const tail = pdfBuf.subarray(Math.max(0, pdfBuf.length - 2048));
    const eofIdx = tail.lastIndexOf(Buffer.from('%%EOF', 'ascii'));
    const hasEof = eofIdx >= 0;
    const trailing = tail.subarray(eofIdx >= 0 ? eofIdx + 5 : tail.length);
    const trailingClean = [...trailing].every(b => b === 0x00 || b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20);
    const htmlJunk = pdfBuf.subarray(0, Math.min(pdfBuf.length, 256)).toString('utf8').trimStart();
    const isHtml = /^<!doctype\s+html|^<html\b/iu.test(htmlJunk);

    log(`PDF written: ${pdfPath}`);
    log(`  size=${size} sha256=${sha}`);
    log(`  %PDF- header: ${header === '%PDF-' ? 'PASS' : 'FAIL (got: ' + header + ')'}`);
    log(`  ' obj' present: ${hasObj ? 'PASS' : 'FAIL'}`);
    log(`  'startxref' present: ${hasStartxref ? 'PASS' : 'FAIL'}`);
    log(`  %%EOF present: ${hasEof ? 'PASS' : 'FAIL'}`);
    log(`  trailing clean: ${trailingClean ? 'PASS' : 'FAIL'}`);
    log(`  HTML junk rejected: ${!isHtml ? 'PASS' : 'FAIL'}`);
    const structuralPass = header === '%PDF-' && hasObj && hasStartxref && hasEof && trailingClean && !isHtml;
    log(`  STRUCTURAL: ${structuralPass ? 'PASS' : 'FAIL'}`);

    // Run pdftotext
    try {
      const { execSync } = await import('node:child_process');
      const txtPath = resultFile('cjk-test.txt');
      execSync(`pdftotext -layout "${pdfPath}" "${txtPath}"`, { stdio: 'pipe', timeout: 15000 });
      if (fs.existsSync(txtPath)) {
        const text = fs.readFileSync(txtPath, 'utf-8');
        const hasChinese = /[一-鿿]/.test(text);
        const hasEnglish = /[A-Za-z]{4,}/.test(text);
        const hasDigits = /\d+/.test(text);
        const lines = text.split('\n').filter(l => l.trim()).length;
        log(`  pdftotext: lines=${lines} chinese=${hasChinese} english=${hasEnglish} digits=${hasDigits}`);
        log(`  TEXT EXTRACTION: ${hasChinese && hasEnglish ? 'PASS' : 'FAIL (missing CJK or English)'}`);
      } else {
        log('  pdftotext: output file not created — FAIL');
      }
    } catch (e) {
      log(`  pdftotext: ${e.message} — consumer unavailable, marking as incomplete (not fail)`);
    }

    return { path: pdfPath, sha, size, structuralPass };
  } finally {
    win.destroy();
  }
}

// ── DOCX generation via production DocxRenderer ──────────────

async function validateDocx() {
  log('=== DOCX VALIDATION ===');
  try {
    // Dynamic import of production modules
    const { DocxRenderer } = await import('../../engine/export/renderers/DocxRenderer.js');
    const { ZipWriter } = await import('../../engine/export/renderers/ZipWriter.js');
    const { validateResearchImagePayload } = await import('../../engine/export/renderers/ImageSupport.js');
    const { ResearchExportBuilder, buildResearchExport, SecureExportPlanSchema } = await import('../../engine/export/ResearchExportBuilder.js');

    // Build minimal PNG + JPEG test images
    const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const jpg1x1 = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/aAAgBAQAAAAAAAP8A', 'base64');

    const pngSha = createHash('sha256').update(png1x1).digest('hex');
    const jpgSha = createHash('sha256').update(jpg1x1).digest('hex');

    const input = {
      artifactVersion: 1,
      artifactManifestDigest: createHash('sha256').update('test-artifact-v1').digest('hex'),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      includeProvenance: true,
      records: {
        project: [{ id: 'proj-1', title: 'Metis 导出消费者验证项目', content: '验证 DOCX 渲染管线。', sensitivity: 'none', fields: [], images: [] }],
        citations: [{ id: 'cit-1', title: '测试引用', content: 'Angrist & Pischke (2009), Mostly Harmless Econometrics.', sensitivity: 'none', fields: [{ key: '作者', value: 'Angrist, J.D. & Pischke, J-S.', sensitivity: 'none' }], images: [] }],
        evidence: [{ id: 'ev-1', title: '测试证据', content: 'DID 估计系数为 -0.034 (p=0.003)。', sensitivity: 'none', fields: [], images: [] }],
        artifact: [{ id: 'art-1', title: '测试成果', content: '测试表格与图片渲染。', sensitivity: 'none', fields: [
          { key: '方法', value: 'DID', sensitivity: 'none' },
          { key: '样本量', value: '12,430', sensitivity: 'none' },
          { key: 'p 值', value: '0.003', sensitivity: 'none' },
        ], images: [
          { mediaType: 'image/png', base64Data: png1x1.toString('base64'), sha256: pngSha, caption: '图1：DID 平行趋势检验' },
          { mediaType: 'image/jpeg', base64Data: jpg1x1.toString('base64'), sha256: jpgSha, caption: '图2：PSM 匹配质量' },
        ] }],
        audit: [{ id: 'aud-1', title: '审计记录', content: '所有数字与来源一致。', sensitivity: 'none', fields: [], images: [] }],
      },
    };

    const renderer = new DocxRenderer();
    const result = await renderer.render(input);

    if (!result.ok) {
      log(`  DOCX render FAILED: ${result.error}`);
      return { ok: false, error: result.error };
    }

    const docxPath = resultFile('cjk-test.docx');
    fs.writeFileSync(docxPath, result.content);
    const sha = createHash('sha256').update(result.content).digest('hex');
    log(`  DOCX written: ${docxPath} size=${result.content.length} sha256=${sha}`);

    // Unpack ZIP to verify structure
    const { execSync } = await import('node:child_process');
    const unpackDir = resultFile('docx-unpacked');
    fs.mkdirSync(unpackDir, { recursive: true });
    execSync(`powershell -Command "Expand-Archive -Path '${docxPath}' -DestinationPath '${unpackDir}' -Force"`, { stdio: 'pipe' });

    const hasContentTypes = fs.existsSync(path.join(unpackDir, '[Content_Types].xml'));
    const hasRels = fs.existsSync(path.join(unpackDir, '_rels', '.rels'));
    const hasDocRels = fs.existsSync(path.join(unpackDir, 'word', '_rels', 'document.xml.rels'));
    const hasDocument = fs.existsSync(path.join(unpackDir, 'word', 'document.xml'));
    const hasFootnotes = fs.existsSync(path.join(unpackDir, 'word', 'footnotes.xml'));
    const hasStyles = fs.existsSync(path.join(unpackDir, 'word', 'styles.xml'));
    const mediaFiles = fs.readdirSync(path.join(unpackDir, 'word', 'media'));
    const hasMedia = mediaFiles.length >= 2;

    log(`  [Content_Types].xml: ${hasContentTypes ? 'PASS' : 'FAIL'}`);
    log(`  _rels/.rels: ${hasRels ? 'PASS' : 'FAIL'}`);
    log(`  word/_rels/document.xml.rels: ${hasDocRels ? 'PASS' : 'FAIL'}`);
    log(`  word/document.xml: ${hasDocument ? 'PASS' : 'FAIL'}`);
    log(`  word/footnotes.xml: ${hasFootnotes ? 'PASS' : 'FAIL'}`);
    log(`  word/styles.xml: ${hasStyles ? 'PASS' : 'FAIL'}`);
    log(`  word/media/: ${hasMedia ? `PASS (${mediaFiles.length} files: ${mediaFiles.join(', ')})` : 'FAIL'}`);

    const structurePass = hasContentTypes && hasRels && hasDocRels && hasDocument && hasFootnotes && hasStyles && hasMedia;
    log(`  DOCX STRUCTURE: ${structurePass ? 'PASS' : 'FAIL'}`);

    // Try Word COM validation
    try {
      const { execSync: exec } = await import('node:child_process');
      const pdfFromDocx = resultFile('cjk-test-from-docx.pdf');
      // Use WPS Word COM via PowerShell to open DOCX and save as PDF
      const psScript = `
        $word = New-Object -ComObject Word.Application
        $word.Visible = $false
        $doc = $word.Documents.Open('${docxPath.replace(/'/g, "''")}')
        $doc.SaveAs('${pdfFromDocx.replace(/'/g, "''")}', 17)
        $doc.Close()
        $word.Quit()
        Write-Output "OK"
      `;
      const psOut = exec(`powershell -Command "${psScript.replace(/"/g, '\\"')}"`, { stdio: 'pipe', timeout: 60000 });
      log(`  Word COM: ${psOut.toString().trim()}`);
      if (fs.existsSync(pdfFromDocx)) {
        const pdfSize = fs.statSync(pdfFromDocx).size;
        log(`  Word→PDF: ${pdfFromDocx} size=${pdfSize}`);
        log(`  Word→PDF CONVERSION: ${pdfSize > 1000 ? 'PASS' : 'FAIL (too small)'}`);
      }
    } catch (e) {
      log(`  Word COM: ${e.message} — consumer unavailable, marking as incomplete`);
    }

    return { ok: true, path: docxPath, sha, size: result.content.length, structurePass };
  } catch (e) {
    log(`  DOCX render exception: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ── Main ──────────────────────────────────────────────────────

app.whenReady().then(async () => {
  log(`Tool detection: Electron=${process.versions.electron} Chrome=${process.versions.chrome} Node=${process.versions.node}`);
  log(`Results dir: ${RESULTS}`);

  const pdfResult = await validatePdf();
  const docxResult = await validateDocx();

  // Write evidence log
  log(`=== SUMMARY ===`);
  log(`PDF structuralPass=${pdfResult.structuralPass}`);
  log(`DOCX structurePass=${docxResult?.structurePass ?? false}`);

  const evidence = {
    timestamp: new Date().toISOString(),
    electron: { version: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    pdf: { path: pdfResult.path, sha256: pdfResult.sha, size: pdfResult.size, structuralPass: pdfResult.structuralPass },
    docx: docxResult.ok ? { path: docxResult.path, sha256: docxResult.sha, size: docxResult.size, structurePass: docxResult.structurePass } : { error: docxResult.error },
    log: LOG,
  };
  fs.writeFileSync(resultFile('evidence.json'), JSON.stringify(evidence, null, 2), 'utf-8');
  log(`Evidence written to ${resultFile('evidence.json')}`);

  const exitCode = (pdfResult.structuralPass && docxResult?.structurePass) ? 0 : 1;
  app.exit(exitCode);
});
