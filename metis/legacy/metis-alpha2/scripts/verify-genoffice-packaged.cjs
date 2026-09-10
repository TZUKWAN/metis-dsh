/*
 * Packaged GenOffice runtime verification.
 *
 * Runs against a real electron-builder --dir output directory and proves the
 * shipped resources/genoffice is self-contained: four app hosts, its own
 * Electron runtime, the Sheets xlsx-sidecar and the main-process node_modules
 * are all inside the package, with no symlink escaping into the workspace.
 * It then launches the Word and Sheets hosts from the packaged root through
 * the packaged wrapper and asserts the real readiness signal.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const JSZip = require('jszip');

const ROOT = path.resolve(__dirname, '..');
const UNPACKED_INDEX = process.argv.indexOf('--unpacked');
const UNPACKED = path.resolve(UNPACKED_INDEX >= 0 && process.argv[UNPACKED_INDEX + 1]
  ? process.argv[UNPACKED_INDEX + 1]
  : path.join(ROOT, 'dist', 'win-unpacked'));
const PACKAGED_GENOFFICE = path.join(UNPACKED, 'resources', 'genoffice');
const PACKAGED_WRAPPER = path.join(PACKAGED_GENOFFICE, 'wrapper', 'genofficeStandaloneWrapper.js');
const REPORT_INDEX = process.argv.indexOf('--report');
const REPORT = path.resolve(REPORT_INDEX >= 0 && process.argv[REPORT_INDEX + 1]
  ? process.argv[REPORT_INDEX + 1]
  : path.join(ROOT, 'test-results', 'genoffice-packaged-smoke.json'));

const REQUIRED_HOST_ENTRIES = [
  'apps/docs/out/main/index.js',
  'apps/slides/out/main/index.js',
  'apps/sheets/out/main/index.js',
  'apps/pdf/out/main/index.js',
];
const REQUIRED_RUNTIME = [
  'electron/electron.exe',
  'apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar.exe',
];
const REQUIRED_DEPENDENCY_MARKERS = [
  'node_modules/jszip/package.json',
];

function assertFile(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error(`missing_packaged_file:${filePath}`);
}

/** Plain Node cannot see inside an asar archive; list it explicitly instead. */
function assertAsarContains(archive, internalPath) {
  let asar;
  try { asar = require('@electron/asar'); } catch { asar = require('asar'); }
  const wanted = internalPath.split(path.sep).join('/');
  const listed = asar.listPackage(archive).map((entry) => entry.split(path.sep).join('/').replace(/^\//, ''));
  if (!listed.includes(wanted)) throw new Error(`missing_in_asar:${wanted}`);
}
void assertAsarContains;

function countSymlinks(rootDir) {
  let symlinks = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        symlinks += 1;
        continue;
      }
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(rootDir);
  return symlinks;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function makeRealDocx(filePath) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Packaged runtime smoke</w:t></w:r></w:p></w:body></w:document>');
  await fs.promises.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  assertFile(filePath);
}

async function makeRealXlsx(filePath) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Packaged" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  zip.file('xl/worksheets/sheet1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Packaged</t></is></c></row></sheetData></worksheet>');
  await fs.promises.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
  assertFile(filePath);
}

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function waitForReadySignal(child, entry, filePath, timeoutMs = 35_000) {
  const deadline = Date.now() + timeoutMs;
  let buffer = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('genoffice_ready_timeout')); }, timeoutMs);
    const samePath = (left, right) => path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
    const onData = (chunk) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, '');
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('METIS_GENOFFICE_READY ')) {
          try {
            const message = JSON.parse(line.slice('METIS_GENOFFICE_READY '.length));
            if (message.editorReady === true && samePath(message.entry, entry) && samePath(message.filePath, filePath)) {
              cleanup();
              resolve(message);
              return;
            }
          } catch {}
        }
        newline = buffer.indexOf('\n');
      }
    };
    const onExit = (code, signal) => { cleanup(); reject(new Error(`genoffice_ready_process_exit:${code ?? signal ?? 'unknown'}`)); };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
    void deadline;
  });
}

async function inspectCdp(port) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      if (response.ok) {
        const pages = await response.json();
        const target = Array.isArray(pages) ? pages.find((page) => page.type === 'page') : null;
        if (target) return { url: target.url, title: target.title };
      }
    } catch {}
    await sleep(250);
  }
  throw new Error('packaged_cdp_timeout');
}

async function runPackagedHost(spec, port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `metis-genoffice-packaged-${spec.kind}-`));
  const electron = path.join(PACKAGED_GENOFFICE, 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--disable-gpu', PACKAGED_WRAPPER, spec.entry, ...(spec.kind === 'spreadsheet' ? [] : [spec.filePath])];
  const child = spawn(electron, args, {
    cwd: spec.cwd,
    env: {
      ...process.env,
      GENOFFICE_USER_DATA: profile,
      AI_OFFICE_USER_DATA: profile,
      XLSX_OPEN_PATH: spec.kind === 'spreadsheet' ? spec.filePath : '',
      GENOFFICE_DISABLE_ANALYTICS: '1',
      GENOFFICE_DISABLE_CLOUD: '1',
      METIS_GENOFFICE_DEBUG: '1',
      METIS_GENOFFICE_DEBUG_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    const ready = await waitForReadySignal(child, spec.entry, spec.filePath);
    const cdp = await inspectCdp(port);
    return { kind: spec.kind, entry: spec.entry, ready, cdp, launched: true };
  } catch (error) {
    throw new Error(`${error && (error.stack || error.message || error)}\n[${spec.kind}] stderr:\n${stderr.slice(-3000)}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    }
    await waitForExit(child);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(500); }
    }
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('packaged_smoke_requires_windows');
  const report = { unpacked: UNPACKED, packagedGenoffice: PACKAGED_GENOFFICE, checks: {}, hosts: [] };
  try {
    for (const relative of [...REQUIRED_HOST_ENTRIES, ...REQUIRED_RUNTIME, ...REQUIRED_DEPENDENCY_MARKERS]) {
      assertFile(path.join(PACKAGED_GENOFFICE, relative));
    }
    assertAsarContains(path.join(UNPACKED, 'resources', 'app.asar'), 'dist-electron/electron/genofficeStandaloneWrapper.js');
    report.checks.fourHostEntries = true;
    report.checks.electronRuntime = true;
    report.checks.sheetsSidecar = true;
    report.checks.dependencies = true;
    report.checks.packagedWrapper = true;

    const symlinks = countSymlinks(PACKAGED_GENOFFICE);
    report.checks.symlinks = symlinks;
    if (symlinks !== 0) throw new Error(`packaged_symlinks_present:${symlinks}`);
    report.checks.selfContained = true;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-genoffice-packaged-files-'));
    const docx = path.join(tempDir, 'packaged.docx');
    const xlsx = path.join(tempDir, 'packaged.xlsx');
    await makeRealDocx(docx);
    await makeRealXlsx(xlsx);
    report.hosts.push(await runPackagedHost({ kind: 'word', entry: path.join(PACKAGED_GENOFFICE, 'apps', 'docs', 'out', 'main', 'index.js'), cwd: path.join(PACKAGED_GENOFFICE, 'apps', 'docs'), filePath: docx }, 9341));
    report.hosts.push(await runPackagedHost({ kind: 'spreadsheet', entry: path.join(PACKAGED_GENOFFICE, 'apps', 'sheets', 'out', 'main', 'index.js'), cwd: path.join(PACKAGED_GENOFFICE, 'apps', 'sheets'), filePath: xlsx }, 9342));
    fs.rmSync(tempDir, { recursive: true, force: true });
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.stack || error.message : String(error);
  }
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${report.status} ${JSON.stringify(report.checks)}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error && (error.stack || error.message) || error}\n`);
  process.exitCode = 1;
});
