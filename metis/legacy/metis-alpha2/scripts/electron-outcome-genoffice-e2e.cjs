const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const REPORT = path.join(ROOT, 'test-results', 'outcome-genoffice-e2e.json');
const MAIN_PORT = 9471;
const GENOFFICE_PORT = 9472;
const EDIT_MARKER = 'METIS_REAL_GENOFFICE_E2E_EDIT';
const PPT_EDIT_MARKER = 'METIS_REAL_GENOFFICE_PPT_EDIT';
const XLSX_EDIT_MARKER = 'METIS_REAL_GENOFFICE_XLSX_EDIT';
const DIRTY_MARKER = 'METIS_REAL_GENOFFICE_DIRTY_ARCHIVE_GUARD';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(port, endpoint) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`);
  if (!response.ok) throw new Error(`cdp_http_${response.status}`);
  return response.json();
}

async function waitForTarget(port, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await json(port, '/json');
      const target = targets.find(predicate);
      if (target) return target;
    } catch {}
    await sleep(250);
  }
  throw new Error(`cdp_target_timeout:${port}`);
}

async function evaluate(target, expression, awaitPromise = true) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('cdp_socket_open_failed')), { once: true });
  });
  try {
    return await new Promise((resolve, reject) => {
      const id = 1;
      const timer = setTimeout(() => reject(new Error('cdp_evaluate_timeout')), 30_000);
      const onMessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== id) return;
        clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else if (message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.result.exceptionDetails)));
        else resolve(message.result?.result?.value);
      };
      socket.addEventListener('message', onMessage);
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise } }));
    });
  } finally {
    socket.close();
  }
}

async function sendKey(target, key, code, modifiers = 0) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('cdp_socket_open_failed')), { once: true });
  });
  let id = 1;
  const send = (type) => socket.send(JSON.stringify({ id: id++, method: 'Input.dispatchKeyEvent', params: { type, key, code, modifiers, windowsVirtualKeyCode: key === 's' ? 83 : undefined, nativeVirtualKeyCode: key === 's' ? 83 : undefined } }));
  send('keyDown');
  send('keyUp');
  socket.close();
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-outcome-genoffice-e2e-'));
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-outcome-genoffice-export-'));
  const report = { status: 'starting', profile, exportDir, assertions: [], steps: [] };
  const child = spawn(ELECTRON, [
    `--remote-debugging-port=${MAIN_PORT}`,
    `--user-data-dir=${profile}`,
    ROOT,
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      METIS_BACKGROUND_AUDIT: '1',
      METIS_GENOFFICE_DEBUG_PORT: String(GENOFFICE_PORT),
      METIS_GENOFFICE_DEBUG: '1',
      METIS_E2E_EXPORT_DIR: exportDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const check = (name, ok, detail) => {
    report.assertions.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
    if (!ok) throw new Error(`${name}:${JSON.stringify(detail)}`);
  };
  try {
    const mainTarget = await waitForTarget(MAIN_PORT, (target) => target.type === 'page' && target.url.includes('metis-app://renderer/index.html'));
    const ready = await evaluate(mainTarget, "window.metis.startupStatus().then((value) => value.ready === true)");
    check('METIS main renderer reaches startup ready', ready === true, ready);

    const project = await evaluate(mainTarget, "window.metis.createProjectForAutonomous({ title: 'GenOffice outcome E2E project', researchQuestion: 'Verify real external Word editing and CAS synchronization.' })");
    check('isolated project is created through real preload IPC', project?.ok === true && typeof project.projectId === 'string', project);
    const projectId = project.projectId;
    const word = { type: 'word', blocks: [{ id: 'p-e2e', kind: 'paragraph', text: 'Original METIS paragraph.' }], page: { paper: 'A4' }, header: '', footer: '' };
    const created = await evaluate(mainTarget, `window.metis.createOutcome({ projectId: ${JSON.stringify(projectId)}, title: 'Real GenOffice Word E2E', kind: 'word', categoryId: null, content: ${JSON.stringify(word)}, note: 'real genoffice e2e' })`);
    check('Word outcome is created as v1', created?.outcome?.currentVersion === 1 && created?.version?.version === 1, created);
    const outcomeId = created.outcome.id;

    const opened = await evaluate(mainTarget, `window.metis.openOutcomeInGenoffice({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(outcomeId)}, version: 1 })`);
    check('METIS opens a real GenOffice Word host', opened?.ok === true && opened.session?.kind === 'word', opened);
    const genofficeTarget = await waitForTarget(GENOFFICE_PORT, (target) => target.type === 'page' && target.url.includes('/apps/docs/out/renderer/index.html'));
    const beforeEdit = await evaluate(genofficeTarget, `({ title: document.title, editor: Boolean(document.querySelector('.editor-scroll .ProseMirror')), text: document.querySelector('.editor-scroll .ProseMirror')?.innerText || '' })`);
    check('GenOffice Word target contains the real editor and source content', beforeEdit.editor === true && beforeEdit.text.includes('Original METIS paragraph.'), beforeEdit);

    const edited = await evaluate(genofficeTarget, `(() => { const editor = document.querySelector('.editor-scroll .ProseMirror'); if (!editor) return false; editor.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, ${JSON.stringify(EDIT_MARKER)}); return editor.innerText.includes(${JSON.stringify(EDIT_MARKER)}); })()`);
    check('real GenOffice editor accepts an actual text edit', edited === true, edited);
    await sendKey(genofficeTarget, 's', 'KeyS', 2);
    await sleep(2_000);

    const synced = await evaluate(mainTarget, `window.metis.syncOutcomeFromGenoffice({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(outcomeId)}, token: ${JSON.stringify(opened.session.token)} })`);
    check('saved GenOffice Word file syncs into a new METIS version', synced?.ok === true && synced.detail?.version?.version === 2 && JSON.stringify(synced.detail.version.content).includes(EDIT_MARKER), synced);
    report.steps.push({ name: 'word-edit-sync', version: synced.detail.version.version, marker: EDIT_MARKER });

    const secondOpen = await evaluate(mainTarget, `window.metis.openOutcomeInGenoffice({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(outcomeId)}, version: 2 })`);
    check('current version can open a second external session', secondOpen?.ok === true, secondOpen);
    const localChange = { ...word, blocks: [{ id: 'p-e2e', kind: 'paragraph', text: 'Local METIS concurrent version.' }] };
    const localSaved = await evaluate(mainTarget, `window.metis.saveOutcome({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(outcomeId)}, baseVersion: 2, content: ${JSON.stringify(localChange)}, note: 'concurrent local version', actor: 'human', sources: [] })`);
    check('concurrent local METIS version is committed as v3', localSaved?.version?.version === 3, localSaved);
    const conflict = await evaluate(mainTarget, `window.metis.syncOutcomeFromGenoffice({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(outcomeId)}, token: ${JSON.stringify(secondOpen.session.token)} })`);
    check('stale external session is rejected by METIS CAS', conflict?.ok === false && conflict.code === 'external_editor_version_conflict', conflict);
    const closed = await evaluate(mainTarget, `window.metis.closeOutcomeGenofficeEditor({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(outcomeId)}, token: ${JSON.stringify(secondOpen.session.token)} })`);
    check('conflicted external session closes and cleans up', closed === true, closed);
    report.steps.push({ name: 'cas-conflict-cleanup', conflictCode: conflict.code, closed });

    // ── Word reopen + reparse from the committed package ──
    const wordReopen = await evaluate(mainTarget, `window.metis.openOutcomeInGenoffice({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(outcomeId)}, version: 3 })`);
    check('reopened Word external session loads the current version', wordReopen?.ok === true && wordReopen.session?.kind === 'word', wordReopen);
    const wordReopenTarget = await waitForTarget(GENOFFICE_PORT, (target) => target.type === 'page' && target.url.includes('/apps/docs/out/renderer/index.html'));
    const reopenedText = await evaluate(wordReopenTarget, `document.querySelector('.editor-scroll .ProseMirror')?.innerText || ''`);
    check('reopened GenOffice Word reparses the committed package text', String(reopenedText).includes('Local METIS concurrent version.'), { reopenedText });
    const wordReopenClosed = await evaluate(mainTarget, `window.metis.closeOutcomeGenofficeEditor({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(outcomeId)}, token: ${JSON.stringify(wordReopen.session.token)} })`);
    check('clean reopened Word session closes', wordReopenClosed === true, wordReopenClosed);
    report.steps.push({ name: 'word-reopen-reparse', marker: 'Local METIS concurrent version.' });

    // ── Dirty external draft blocks archive until explicitly discarded ──
    const dirtyOpen = await evaluate(mainTarget, `window.metis.openOutcomeInGenoffice({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(outcomeId)}, version: 3 })`);
    check('dirty-guard Word session opens', dirtyOpen?.ok === true, dirtyOpen);
    const dirtyTarget = await waitForTarget(GENOFFICE_PORT, (target) => target.type === 'page' && target.url.includes('/apps/docs/out/renderer/index.html'));
    const dirtyEdit = await evaluate(dirtyTarget, `(() => { const editor = document.querySelector('.editor-scroll .ProseMirror'); if (!editor) return false; editor.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, ${JSON.stringify(DIRTY_MARKER)}); return editor.innerText.includes(${JSON.stringify(DIRTY_MARKER)}); })()`);
    check('dirty-guard edit lands in the real editor', dirtyEdit === true, dirtyEdit);
    // Send the real save keystroke and wait for the on-disk hash to actually
    // diverge; a fixed sleep would race the app's own save pipeline.
    let dirtyOnDisk = false;
    for (let attempt = 0; attempt < 6 && !dirtyOnDisk; attempt += 1) {
      await sendKey(dirtyTarget, 's', 'KeyS', 2);
      await sleep(2_000);
      const state = await evaluate(mainTarget, `window.metis.stateOutcomeGenofficeEditor({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(outcomeId)} })`);
      dirtyOnDisk = state?.changed === true;
    }
    check('GenOffice save makes the external session dirty on disk', dirtyOnDisk === true, { dirtyOnDisk });
    const archiveBlocked = await evaluate(mainTarget, `window.metis.archiveOutcome({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(outcomeId)} })`);
    check('archiving is blocked while the external draft is dirty', archiveBlocked === false, archiveBlocked);
    const dirtyDiscarded = await evaluate(mainTarget, `window.metis.closeOutcomeGenofficeEditor({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(outcomeId)}, token: ${JSON.stringify(dirtyOpen.session.token)} })`);
    check('dirty external session can be explicitly discarded', dirtyDiscarded === true, dirtyDiscarded);
    const archiveAllowed = await evaluate(mainTarget, `window.metis.archiveOutcome({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(outcomeId)} })`);
    check('archiving succeeds once no dirty session remains', archiveAllowed === true, archiveAllowed);
    const trashRows = await evaluate(mainTarget, `window.metis.listOutcomeTrash({ projectId: ${JSON.stringify(projectId)} })`);
    check('archived outcome lands in the project trash', Array.isArray(trashRows) && trashRows.some((row) => (row?.outcome?.id ?? row?.id ?? row?.outcomeId) === outcomeId), { trashCount: Array.isArray(trashRows) ? trashRows.length : null });
    const restored = await evaluate(mainTarget, `window.metis.restoreOutcomeFromTrash({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(outcomeId)} })`);
    check('archived outcome restores from trash', restored === true, restored);
    report.steps.push({ name: 'word-dirty-archive-guard', archiveBlocked: true, archiveAllowed: true, restored: true });

    // ── DOCX export round-trip through the real IPC path ──
    const docxExport = await evaluate(mainTarget, `window.metis.exportOutcomeWordDocx({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(outcomeId)}, version: 3 })`);
    check('DOCX export via real IPC succeeds', docxExport?.ok === true, docxExport);
    const docxPath = path.join(exportDir, docxExport.fileName);
    const docxBytes = fs.existsSync(docxPath) ? fs.readFileSync(docxPath) : Buffer.alloc(0);
    check('exported DOCX exists with an OOXML signature', docxBytes.subarray(0, 2).toString('latin1') === 'PK' && docxBytes.length > 0, { docxPath, bytes: docxBytes.length });
    const JSZip = require('jszip');
    const docxXml = await JSZip.loadAsync(docxBytes).then((zip) => zip.file('word/document.xml')?.async('string') ?? '');
    check('exported DOCX document.xml contains the committed text', docxXml.includes('Local METIS concurrent version.'), { hasDocumentXml: docxXml.length > 0 });
    report.steps.push({ name: 'word-docx-export-roundtrip', fileName: docxExport.fileName, bytes: docxBytes.length });

    const ppt = {
      type: 'ppt', ratio: '16:9', theme: {}, templateId: null, generationSkillId: null,
      pages: [{ id: 'slide-e2e', title: 'GenOffice PPT E2E', pageType: 'cover', humanModified: false, status: 'complete', elements: [{ id: 'element-e2e', type: 'text', x: 3, y: 3, width: 20, height: 3, locked: false, props: { text: 'Original PPT paragraph.' } }] }],
    };
    const pptCreated = await evaluate(mainTarget, `window.metis.createOutcome({ projectId: ${JSON.stringify(projectId)}, title: 'Real GenOffice PPT E2E', kind: 'ppt', categoryId: null, content: ${JSON.stringify(ppt)}, note: 'real genoffice ppt e2e', applyDefaultTemplate: false })`);
    check('PPT outcome is created as v1', pptCreated?.outcome?.currentVersion === 1 && pptCreated?.version?.version === 1, pptCreated);
    const pptOpened = await evaluate(mainTarget, `window.metis.openOutcomeInGenoffice({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(pptCreated.outcome.id)}, version: 1 })`);
    check('METIS opens a real GenOffice PPT host', pptOpened?.ok === true && pptOpened.session?.kind === 'ppt', pptOpened);
    const pptTarget = await waitForTarget(GENOFFICE_PORT, (target) => target.type === 'page' && target.url.includes('/apps/slides/out/renderer/index.html'));
    const pptBefore = await evaluate(pptTarget, "window.slidesApi.getRenderSlides().then((slides) => ({ pages: slides?.length || 0, nodes: (slides?.[0]?.nodes || []).map((candidate) => ({ type: candidate.type, sourceId: candidate.sourceId, text: candidate.text?.lines?.flatMap((line) => line.runs?.map((run) => run.text) || []).join('') || null })) }))");
    const pptTextNode = pptBefore?.nodes?.find((candidate) => candidate.type === 'text' || candidate.type === 'shape' || candidate.text);
    check('GenOffice PPT target exposes the real loaded text object', pptBefore?.pages > 0 && typeof pptTextNode?.sourceId === 'string', pptBefore);
    const pptEdited = await evaluate(pptTarget, `window.slidesApi.editText({ slideIndex: 0, sourceId: ${JSON.stringify(pptTextNode.sourceId)}, paragraphs: [{ runs: [{ text: ${JSON.stringify(PPT_EDIT_MARKER)} }] }] }).then((value) => Boolean(value))`);
    check('real GenOffice PPT accepts an actual text edit', pptEdited === true, pptEdited);
    const pptSaved = await evaluate(pptTarget, 'window.slidesApi.save()');
    check('GenOffice PPT saves the edited package', pptSaved?.ok === true, pptSaved);
    await sleep(1_000);
    const pptSynced = await evaluate(mainTarget, `window.metis.syncOutcomeFromGenoffice({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(pptCreated.outcome.id)}, token: ${JSON.stringify(pptOpened.session.token)} })`);
    check('saved GenOffice PPT syncs into a new METIS version', pptSynced?.ok === true && pptSynced.detail?.version?.version === 2 && JSON.stringify(pptSynced.detail.version.content).includes(PPT_EDIT_MARKER), pptSynced);
    report.steps.push({ name: 'ppt-edit-sync', version: pptSynced.detail.version.version, marker: PPT_EDIT_MARKER });

    // ── PPT reopen + reparse, then PPTX export round-trip ──
    const pptReopen = await evaluate(mainTarget, `window.metis.openOutcomeInGenoffice({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(pptCreated.outcome.id)}, version: 2 })`);
    check('reopened PPT external session loads the synced version', pptReopen?.ok === true && pptReopen.session?.kind === 'ppt', pptReopen);
    const pptReopenTarget = await waitForTarget(GENOFFICE_PORT, (target) => target.type === 'page' && target.url.includes('/apps/slides/out/renderer/index.html'));
    const pptReopenText = await evaluate(pptReopenTarget, "window.slidesApi.getRenderSlides().then((slides) => (slides || []).map((slide) => (slide.nodes || []).flatMap((node) => node.text?.lines?.flatMap((line) => line.runs?.map((run) => run.text) || []) || []).join('|')).join('\\n'))");
    check('reopened GenOffice PPT reparses the saved package with the marker', String(pptReopenText).includes(PPT_EDIT_MARKER), { pptReopenText });
    const pptReopenClosed = await evaluate(mainTarget, `window.metis.closeOutcomeGenofficeEditor({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(pptCreated.outcome.id)}, token: ${JSON.stringify(pptReopen.session.token)} })`);
    check('clean reopened PPT session closes', pptReopenClosed === true, pptReopenClosed);
    report.steps.push({ name: 'ppt-reopen-reparse', marker: PPT_EDIT_MARKER });
    const pptxExport = await evaluate(mainTarget, `window.metis.exportOutcomePptx({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(pptCreated.outcome.id)}, version: 2 })`);
    check('PPTX export via real IPC succeeds', pptxExport?.ok === true, pptxExport);
    const pptxPath = path.join(exportDir, pptxExport.fileName);
    const pptxBytes = fs.existsSync(pptxPath) ? fs.readFileSync(pptxPath) : Buffer.alloc(0);
    check('exported PPTX exists with an OOXML signature', pptxBytes.subarray(0, 2).toString('latin1') === 'PK' && pptxBytes.length > 0, { pptxPath, bytes: pptxBytes.length });
    const pptxSlideXml = await JSZip.loadAsync(pptxBytes).then((zip) => zip.file('ppt/slides/slide1.xml')?.async('string') ?? '');
    check('exported PPTX slide XML contains the committed marker', pptxSlideXml.includes(PPT_EDIT_MARKER), { hasSlideXml: pptxSlideXml.length > 0 });
    report.steps.push({ name: 'ppt-pptx-export-roundtrip', fileName: pptxExport.fileName, bytes: pptxBytes.length });

    const spreadsheet = { type: 'spreadsheet', media: null, originalArchiveMediaId: null, workbook: { sheetNames: ['Sheet1'], activeSheet: 'Sheet1', activeCell: null, cells: {} } };
    const sheetCreated = await evaluate(mainTarget, `window.metis.createOutcome({ projectId: ${JSON.stringify(projectId)}, title: 'Real GenOffice XLSX E2E', kind: 'spreadsheet', categoryId: null, content: ${JSON.stringify(spreadsheet)}, note: 'real genoffice xlsx e2e', applyDefaultTemplate: false })`);
    check('Spreadsheet outcome is created with real blank XLSX media', sheetCreated?.outcome?.currentVersion === 1 && sheetCreated?.version?.version === 1 && sheetCreated.version.content.media?.mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sheetCreated);
    const sheetOpened = await evaluate(mainTarget, `window.metis.openOutcomeInGenoffice({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(sheetCreated.outcome.id)}, version: 1 })`);
    check('METIS opens a real GenOffice Sheets host', sheetOpened?.ok === true && sheetOpened.session?.kind === 'spreadsheet', sheetOpened);
    const sheetTarget = await waitForTarget(GENOFFICE_PORT, (target) => target.type === 'page' && target.url.includes('/apps/sheets/out/renderer/index.html'));
    const sheetBefore = await evaluate(sheetTarget, "window.desktopApi.selectWorkbook()", true);
    check('GenOffice Sheets returns a real workbook session', Boolean(sheetBefore?.sessionId && sheetBefore?.sheets?.[0]?.id), sheetBefore);
    const sheetRequest = {
      sessionId: sheetBefore.sessionId,
      mode: 'save',
      edits: [{ sheetId: sheetBefore.sheets[0].id, row: 0, column: 0, writeValue: true, value: XLSX_EDIT_MARKER }],
      bulkConstantFills: [], structuralOps: [], chartEdits: [], visualEdits: [], visualAdditions: [], tableAdditions: [], pivotAdditions: [], sheetOps: [],
      sheetOrder: sheetBefore.sheets.map((sheet) => sheet.id), filterStates: [], hyperlinkEdits: [], cfStates: [], dvStates: [], pageSetupStates: [], noteStates: [], formulaValues: [], pivotCacheRefreshPaths: [], pivotRefreshUpdates: [], sheetProtections: [], sparklineAdditions: [],
      definedNamesState: null, themeState: null, workbookProtectionState: null, protectedRangeStates: [],
    };
    const sheetSaved = await evaluate(sheetTarget, `window.desktopApi.saveWorkbookEdits(${JSON.stringify(sheetRequest)})`);
    check('GenOffice Sheets saves a real edited XLSX package', sheetSaved && sheetSaved.canceled !== true && sheetSaved.ok !== false, sheetSaved);
    await sleep(1_000);
    const sheetSynced = await evaluate(mainTarget, `window.metis.syncOutcomeFromGenoffice({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(sheetCreated.outcome.id)}, token: ${JSON.stringify(sheetOpened.session.token)} })`);
    check('saved GenOffice XLSX syncs into a new METIS version', sheetSynced?.ok === true && sheetSynced.detail?.version?.version === 2 && JSON.stringify(sheetSynced.detail.version.content).includes(XLSX_EDIT_MARKER), sheetSynced);
    report.steps.push({ name: 'spreadsheet-edit-sync', version: sheetSynced.detail.version.version, marker: XLSX_EDIT_MARKER });

    // ── Sheets reopen + reparse: the synced XLSX must open as a real workbook ──
    const sheetReopen = await evaluate(mainTarget, `window.metis.openOutcomeInGenoffice({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(sheetCreated.outcome.id)}, version: 2 })`);
    check('reopened Sheets external session loads the synced version', sheetReopen?.ok === true && sheetReopen.session?.kind === 'spreadsheet', sheetReopen);
    const sheetReopenTarget = await waitForTarget(GENOFFICE_PORT, (target) => target.type === 'page' && target.url.includes('/apps/sheets/out/renderer/index.html'));
    const sheetReopenWorkbook = await evaluate(sheetReopenTarget, 'window.desktopApi.selectWorkbook()');
    check('reopened GenOffice Sheets reparses the saved XLSX as a workbook', Boolean(sheetReopenWorkbook?.sessionId && sheetReopenWorkbook?.sheets?.[0]?.id), sheetReopenWorkbook);
    const sheetReopenClosed = await evaluate(mainTarget, `window.metis.closeOutcomeGenofficeEditor({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(sheetCreated.outcome.id)}, token: ${JSON.stringify(sheetReopen.session.token)} })`);
    check('clean reopened Sheets session closes', sheetReopenClosed === true, sheetReopenClosed);
    report.steps.push({ name: 'spreadsheet-reopen-reparse' });

    const pdf = { type: 'pdf', media: null, originalArchiveMediaId: null, pageCount: null, activePage: null };
    const pdfCreated = await evaluate(mainTarget, `window.metis.createOutcome({ projectId: ${JSON.stringify(projectId)}, title: 'Real GenOffice PDF E2E', kind: 'pdf', categoryId: null, content: ${JSON.stringify(pdf)}, note: 'real genoffice pdf e2e', applyDefaultTemplate: false })`);
    check('PDF outcome is created with real blank PDF media', pdfCreated?.outcome?.currentVersion === 1 && pdfCreated?.version?.version === 1 && pdfCreated.version.content.media?.mediaType === 'application/pdf', pdfCreated);
    const pdfOpened = await evaluate(mainTarget, `window.metis.openOutcomeInGenoffice({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(pdfCreated.outcome.id)}, version: 1 })`);
    check('METIS opens a real GenOffice PDF host', pdfOpened?.ok === true && pdfOpened.session?.kind === 'pdf', pdfOpened);
    const pdfTarget = await waitForTarget(GENOFFICE_PORT, (target) => target.type === 'page' && target.url.includes('/apps/pdf/out/renderer/index.html'));
    const pdfPath = await evaluate(pdfTarget, 'window.__metisStandaloneFilePath || null');
    check('GenOffice PDF exposes the real session file path', typeof pdfPath === 'string' && pdfPath.toLowerCase().endsWith('.pdf'), pdfPath);
    const pdfEdited = await evaluate(pdfTarget, `window.pdfApi.insertBlankPage({ path: ${JSON.stringify(pdfPath)}, afterPageIndex: 0 })`);
    check('real GenOffice PDF writes an actual page edit', pdfEdited?.ok === true, pdfEdited);
    await sleep(1_000);
    const pdfSynced = await evaluate(mainTarget, `window.metis.syncOutcomeFromGenoffice({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(pdfCreated.outcome.id)}, token: ${JSON.stringify(pdfOpened.session.token)} })`);
    check('edited GenOffice PDF syncs into a new METIS version', pdfSynced?.ok === true && pdfSynced.detail?.version?.version === 2 && pdfSynced.detail.version.content.pageCount === 2, pdfSynced);
    report.steps.push({ name: 'pdf-edit-sync', version: pdfSynced.detail.version.version, pageCount: pdfSynced.detail.version.content.pageCount });

    // ── PDF reopen + reparse: the synced 2-page PDF must render its second page ──
    const pdfReopen = await evaluate(mainTarget, `window.metis.openOutcomeInGenoffice({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(pdfCreated.outcome.id)}, version: 2 })`);
    check('reopened PDF external session loads the synced version', pdfReopen?.ok === true && pdfReopen.session?.kind === 'pdf', pdfReopen);
    const pdfReopenTarget = await waitForTarget(GENOFFICE_PORT, (target) => target.type === 'page' && target.url.includes('/apps/pdf/out/renderer/index.html'));
    const pdfReopenPath = await evaluate(pdfReopenTarget, 'window.__metisStandaloneFilePath || null');
    check('reopened PDF session exposes the session file path', typeof pdfReopenPath === 'string' && pdfReopenPath.toLowerCase().endsWith('.pdf'), { pdfReopenPath });
    // The PDF app gates file APIs behind per-view path grants, but a rendered
    // second page proves the synced two-page package was really reparsed.
    const pdfPageCount = await evaluate(pdfReopenTarget, 'document.querySelectorAll(\'.pdf-page-content\').length');
    check('reopened GenOffice PDF renders the synced second page', Number(pdfPageCount) >= 2, { pdfPageCount });
    const pdfReopenClosed = await evaluate(mainTarget, `window.metis.closeOutcomeGenofficeEditor({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(pdfCreated.outcome.id)}, token: ${JSON.stringify(pdfReopen.session.token)} })`);
    check('clean reopened PDF session closes', pdfReopenClosed === true, pdfReopenClosed);
    report.steps.push({ name: 'pdf-reopen-reparse', secondPageRendered: true });

    // ── Archive + permanent-delete cleanup across all four outcomes ──
    const outcomeIds = [pptCreated.outcome.id, sheetCreated.outcome.id, pdfCreated.outcome.id];
    // The Word outcome was restored from trash earlier, so archive it again.
    const wordArchived = await evaluate(mainTarget, `window.metis.archiveOutcome({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(outcomeId)} })`);
    check('word outcome archives cleanly before permanent deletion', wordArchived === true, wordArchived);
    for (const cleanupId of outcomeIds) {
      const archived = await evaluate(mainTarget, `window.metis.archiveOutcome({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(cleanupId)} })`);
      check(`outcome ${cleanupId} archives cleanly with no external session`, archived === true, archived);
    }
    for (const cleanupId of [outcomeId, ...outcomeIds]) {
      const deleted = await evaluate(mainTarget, `window.metis.deleteOutcomePermanent({ projectId: ${JSON.stringify(projectId)}, outcomeId: ${JSON.stringify(cleanupId)} })`);
      check(`outcome ${cleanupId} is permanently deleted with media purge`, deleted === true, deleted);
    }
    const remainingTrash = await evaluate(mainTarget, `window.metis.listOutcomeTrash({ projectId: ${JSON.stringify(projectId)} })`);
    check('project trash is empty after permanent deletion', Array.isArray(remainingTrash) && remainingTrash.length === 0, { remaining: Array.isArray(remainingTrash) ? remainingTrash.length : null });
    report.steps.push({ name: 'archive-delete-cleanup', deleted: outcomeIds.length + 1 });

    report.status = report.assertions.every((entry) => entry.ok) ? 'passed' : 'failed';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.stack || error.message : String(error);
  } finally {
    report.stdout = stdout.slice(-4_000);
    report.stderr = stderr.slice(-4_000);
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    await sleep(2_000);
    report.childExited = child.exitCode !== null || child.signalCode !== null;
    try { fs.rmSync(profile, { recursive: true, force: true }); report.profileRemoved = true; } catch (error) { report.profileRemoved = false; report.profileCleanupError = String(error); }
    try { fs.rmSync(exportDir, { recursive: true, force: true }); report.exportDirRemoved = true; } catch (error) { report.exportDirRemoved = false; report.exportDirCleanupError = String(error); }
    writeReport(report);
  }
  if (report.status !== 'passed' || report.profileRemoved !== true || report.childExited !== true) process.exitCode = 1;
}

main().catch((error) => {
  writeReport({ status: 'failed', error: error instanceof Error ? error.stack || error.message : String(error) });
  process.exitCode = 1;
});
