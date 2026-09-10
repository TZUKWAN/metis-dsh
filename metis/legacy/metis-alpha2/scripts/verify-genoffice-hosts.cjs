/*
 * Real GenOffice host smoke test.
 *
 * This script launches the built standalone Docs/Slides/Sheets/PDF apps with
 * real files, inspects their DevTools HTTP endpoint, and then terminates the
 * complete Windows process tree. It is verification tooling only; no result is
 * injected into METIS state.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const JSZip = require('jszip');

const ROOT = path.resolve(__dirname, '..');
const GENOFFICE_ROOT = process.env.METIS_GENOFFICE_ROOT
  ? path.resolve(process.env.METIS_GENOFFICE_ROOT)
  : path.resolve(ROOT, '..', 'tools', 'genoffice');
const ELECTRON = path.join(GENOFFICE_ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'Electron');
const METIS_WRAPPER = path.join(ROOT, 'dist-electron', 'electron', 'genofficeStandaloneWrapper.js');
const REPORT_INDEX = process.argv.indexOf('--report');
const REPORT = path.resolve(REPORT_INDEX >= 0 && process.argv[REPORT_INDEX + 1]
  ? process.argv[REPORT_INDEX + 1]
  : path.join(ROOT, 'test-results', 'genoffice-hosts-smoke.json'));

function assertFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`missing_file:${filePath}`);
}

async function makeRealXlsx(filePath) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Research" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Research</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>');
  await fs.promises.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  assertFile(filePath);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function getJson(port, endpoint) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`);
  if (!response.ok) throw new Error(`cdp_http_${response.status}`);
  return response.json();
}

async function openCdp(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('cdp_socket_open_failed')), { once: true });
    });
    return socket;
  } catch (error) {
    try { socket.close(); } catch {}
    throw error;
  }
}

async function cdpEvaluate(page, expression) {
  const socket = await openCdp(page);
  const requestId = cdpEvaluate.nextId++;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cdp_evaluate_timeout')), 15_000);
      const onMessage = (event) => {
        const value = JSON.parse(String(event.data));
        if (value.id !== requestId) return;
        clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        if (value.error) reject(new Error(JSON.stringify(value.error)));
        else resolve(value.result?.result?.value);
      };
      const onError = () => {
        clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        reject(new Error('cdp_socket_error'));
      };
      socket.addEventListener('message', onMessage);
      socket.addEventListener('error', onError, { once: true });
      socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
  } finally {
    try { socket.close(); } catch {}
  }
}

async function cdpDispatch(page, method, params = {}) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('cdp_socket_open_failed')), { once: true });
  });
  try {
    return await new Promise((resolve, reject) => {
      const id = 1;
      const timer = setTimeout(() => reject(new Error(`cdp_command_timeout:${method}`)), 30_000);
      const onMessage = (event) => {
        const value = JSON.parse(String(event.data));
        if (value.id !== id) return;
        clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        if (value.error) reject(new Error(JSON.stringify(value.error)));
        else resolve(value.result);
      };
      socket.addEventListener('message', onMessage);
      socket.send(JSON.stringify({ id, method, params }));
    });
  } finally {
    socket.close();
  }
}
cdpEvaluate.nextId = 1;

async function waitForReadySignal(child, entry, filePath, timeoutMs = 35_000) {
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('genoffice_ready_timeout'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const samePath = (left, right) => process.platform === 'win32'
      ? path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase()
      : path.normalize(left) === path.normalize(right);
    const onData = (chunk) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('METIS_GENOFFICE_READY ')) {
          try {
            const message = JSON.parse(line.slice('METIS_GENOFFICE_READY '.length));
            if (message.editorReady === true && samePath(message.entry, entry)
              && samePath(message.filePath, filePath)) {
              cleanup();
              resolve(message);
              return;
            }
          } catch {}
        }
        newline = buffer.indexOf('\n');
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`genoffice_ready_process_exit:${code ?? signal ?? 'unknown'}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
    void deadline;
  });
}

async function inspectCdp(port, filePath) {
  const deadline = Date.now() + 25_000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const version = await getJson(port, '/json/version');
      const pages = await getJson(port, '/json');
      if (Array.isArray(pages) && pages.length > 0) {
        const matching = pages.filter((page) => typeof page.url === 'string' && page.url.length > 0);
        return {
          debugBrowser: typeof version.Browser === 'string' ? version.Browser : null,
          pageCount: pages.length,
          pages: matching.map((page) => ({ title: page.title, url: page.url, type: page.type })),
          target: pages.find((page) => page.type === 'page') || null,
          filePath,
        };
      }
    } catch (error) {
      lastError = String(error && (error.message || error));
    }
    await sleep(250);
  }
  throw new Error(`cdp_timeout:${lastError}`);
}

async function runHost(spec, index) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `metis-genoffice-host-${spec.kind}-`));
  const port = 9300 + index;
  const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--disable-gpu', METIS_WRAPPER, spec.entry, ...(spec.kind === 'spreadsheet' ? [] : [spec.filePath])];
  const child = spawn(ELECTRON, args, {
    cwd: spec.cwd,
    env: { ...process.env, GENOFFICE_USER_DATA: profile, AI_OFFICE_USER_DATA: profile, XLSX_OPEN_PATH: spec.kind === 'spreadsheet' ? spec.filePath : '', GENOFFICE_DISABLE_ANALYTICS: '1', GENOFFICE_DISABLE_CLOUD: '1', METIS_GENOFFICE_DEBUG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    const readyMessage = await waitForReadySignal(child, spec.entry, spec.filePath);
    const cdp = await inspectCdp(port, spec.filePath);
    const page = cdp.target;
    if (!page) throw new Error('genoffice_page_missing');
    const expectedName = path.basename(spec.filePath);
    const readinessExpression = spec.kind === 'word'
      ? `document.title === ${JSON.stringify(expectedName)} && !!document.querySelector('.editor-scroll .ProseMirror')`
      : spec.kind === 'ppt'
        ? `!!document.querySelector('.stage-wrap') && !!document.querySelector('.slide-list') && document.querySelectorAll('.slide-list > *').length > 0`
        : spec.kind === 'spreadsheet'
          ? `!!document.querySelector('#univer-container') && /工作簿已完整加载|Workbook fully loaded|ブックを完全に読み込みました|ワークブック.*完全/u.test(document.querySelector('.workbook-status')?.textContent || '')`
          : `document.querySelectorAll('.pdf-page-content').length > 0`;
    const readiness = await cdpEvaluate(page, `({
      ready: Boolean(${readinessExpression}),
      title: document.title,
      body: document.body.innerText.slice(0, 1200),
      editor: Boolean(document.querySelector('.editor-scroll .ProseMirror')),
      stage: Boolean(document.querySelector('.stage-wrap')),
      slides: document.querySelectorAll('.slide-list > *').length,
      workbook: Boolean(document.querySelector('#univer-container')),
      workbookStatus: document.querySelector('.workbook-status')?.textContent || '',
      pdfPages: document.querySelectorAll('.pdf-page-content').length,
    })`);
    if (!readiness || readiness.ready !== true) throw new Error(`genoffice_target_not_ready:${spec.kind}:${JSON.stringify(readiness)}`);
    const rootPid = child.pid;
    execFileSync('taskkill', ['/PID', String(rootPid), '/T', '/F'], { encoding: 'utf8', stdio: 'ignore' });
    await waitForExit(child);
    await sleep(1000);
    return { kind: spec.kind, filePath: spec.filePath, port, rootPid, cdp, readyMessage, targetReady: true, rootRemaining: child.exitCode === null && child.signalCode === null, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) };
  } catch (error) {
    const detail = String(error && (error.stack || error.message || error));
    throw new Error(`${detail}\n[${spec.kind}] stdout:\n${stdout.slice(-4000)}\n[${spec.kind}] stderr:\n${stderr.slice(-4000)}`);
  } finally {
    if (!child.killed && child.exitCode === null) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ }
    }
    await waitForExit(child);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(500); }
    }
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('this_smoke_requires_windows');
  assertFile(ELECTRON);
  assertFile(METIS_WRAPPER);
  const xlsx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'metis-real-xlsx-')), 'research.xlsx');
  await makeRealXlsx(xlsx);
  const specs = [
    { kind: 'word', entry: path.join(GENOFFICE_ROOT, 'apps', 'docs', 'out', 'main', 'index.js'), cwd: path.join(GENOFFICE_ROOT, 'apps', 'docs'), filePath: path.join(ROOT, 'tests', 'fixtures', 'genoffice', 'kitchen-sink.docx') },
    { kind: 'ppt', entry: path.join(GENOFFICE_ROOT, 'apps', 'slides', 'out', 'main', 'index.js'), cwd: path.join(GENOFFICE_ROOT, 'apps', 'slides'), filePath: path.join(ROOT, 'tests', 'fixtures', 'genoffice', '01_standard_business.pptx') },
    { kind: 'spreadsheet', entry: path.join(GENOFFICE_ROOT, 'apps', 'sheets', 'out', 'main', 'index.js'), cwd: path.join(GENOFFICE_ROOT, 'apps', 'sheets'), filePath: xlsx },
    { kind: 'pdf', entry: path.join(GENOFFICE_ROOT, 'apps', 'pdf', 'out', 'main', 'index.js'), cwd: path.join(GENOFFICE_ROOT, 'apps', 'pdf'), filePath: 'D:\\LATEXTEST\\metis-paper\\main.pdf' },
  ];
  specs.forEach((spec) => { assertFile(spec.entry); assertFile(spec.filePath); });
  const results = [];
  for (const [index, spec] of specs.entries()) results.push(await runHost(spec, index));
  const report = { status: results.every((result) => result.cdp.pageCount > 0 && result.targetReady === true && result.rootRemaining === false) ? 'passed' : 'failed', generatedXlsx: xlsx, results };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error && (error.stack || error.message) || error}\n`);
  process.exitCode = 1;
});
