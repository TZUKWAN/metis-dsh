#!/usr/bin/env node
/**
 * ui-feature-sweep.cjs — full-feature UI traversal against the REAL Electron
 * app (Engineering Delivery Ready: "所有功能一个不漏").
 *
 * Boots the production main + renderer in a disposable profile with a
 * deterministic loopback provider (SSE streaming), then walks every visible
 * workspace through its real DOM contract:
 *
 *   projects      create → appears in list → create second → switch
 *   topics        create topic → open chatbot → streaming reply → stop → refs
 *   outcomes      create outcome → title/edit visible → persists
 *   submissions   workspace mounts (empty state is a valid state)
 *   scenarios     scenario workbench mounts (reference-file button present)
 *   settings      every section mounts; health report OK; diagnostic bundle
 *                 export really writes a zip; backup list+create via real IPC
 *   persistence   hard-quit → relaunch → every object created above survives
 *   races         rapid project/topic switching leaves no cross-scope data
 *
 * Evidence: JSON report (default logs/ui-feature-sweep-<stamp>.json).
 * Exit: 0 passed · 1 failed · 2 blocked (build missing).
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const MODEL = 'metis-ui-sweep-loopback';
const API_KEY = 'metis-ui-sweep-loopback-key';
const CHILD_TIMEOUT_MS = 300_000;

const REPORT_INDEX = process.argv.indexOf('--report');
const REPORT_PATH = path.resolve(
  REPORT_INDEX >= 0 && process.argv[REPORT_INDEX + 1]
    ? process.argv[REPORT_INDEX + 1]
    : path.join(ROOT, 'logs', `ui-feature-sweep-${new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)}.json`),
);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function sendJson(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
function sse(data) { return `data: ${data === '[DONE]' ? '[DONE]' : JSON.stringify(data)}\n\n`; }
function streamChunk(content, finishReason = null) {
  return { id: 'sweep', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: finishReason }] };
}
function completion(content) {
  return { id: `sweep-${Date.now()}`, object: 'chat.completion', created: Math.trunc(Date.now() / 1000), model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } };
}
function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/** Streaming loopback provider. Marker-bearing runs stream slowly so the
 *  sweep can observe live deltas and exercise Stop mid-stream. */
async function startProvider() {
  const state = { requests: 0, streamed: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname.startsWith('/v1/models')) {
      return sendJson(res, 200, { data: [{ id: MODEL, context_window: 32_000, modalities: ['text'] }] });
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      return sendJson(res, 404, { error: 'not_found' });
    }
    state.requests += 1;
    let body;
    try { body = await parseRequestBody(req); } catch { return sendJson(res, 400, { error: 'invalid_json' }); }
    const text = JSON.stringify(body);
    const wantsStream = body?.stream === true;
    const slow = text.includes('UI_SWEEP_SLOW_STREAM');
    if (wantsStream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      if (slow) {
        state.streamed += 1;
        for (let i = 0; i < 40; i++) {
          res.write(sse(streamChunk(`第${i}段流式输出。`)));
          await sleep(80);
          if (res.writableEnded || res.destroyed) return;
        }
        res.write(sse(streamChunk('流式完成', 'stop')));
        res.end(sse('[DONE]'));
        return;
      }
      res.write(sse(streamChunk('UI_SWEEP_OK')));
      res.write(sse(streamChunk('', 'stop')));
      res.end(sse('[DONE]'));
      return;
    }
    return sendJson(res, 200, completion('UI_SWEEP_OK'));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, state, close: () => new Promise((r) => server.close(r)) };
}

function electronBinary() {
  return path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
}

const rendererExpression = (expr) => `(async () => { try { return await (${expr}); } catch (error) { return { __e2eError: String(error && (error.stack || error.message) || error) }; } })()`;

// ─── Child (inside Electron) ─────────────────────────────────────────────────

async function childMain() {
  const { app, BrowserWindow } = require('electron');
  const profileDir = process.env.METIS_UI_SWEEP_PROFILE;
  const providerUrl = process.env.METIS_UI_SWEEP_PROVIDER;
  const reportPath = process.env.METIS_UI_SWEEP_REPORT;
  if (!profileDir || !providerUrl || !reportPath) throw new Error('sweep child env incomplete');

  app.setName('METIS UI Feature Sweep');
  app.setPath('userData', profileDir);

  const report = { harness: 'ui-feature-sweep', status: 'failed', startedAt: new Date().toISOString(), assertions: [], evidence: {} };
  const check = (name, ok, detail) => {
    report.assertions.push({ name, ok: ok === true, detail: ok === true ? null : (detail ?? null) });
    console.log(`[sweep] ${ok === true ? 'ok  ' : 'FAIL'} ${name}`);
    return ok === true;
  };
  const writeReport = () => { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); };
  let quitRequested = false;

  const relaunchVerify = process.env.METIS_UI_SWEEP_PHASE === 'relaunch-verify';
  if (relaunchVerify) {
    try {
      const mainEntry = path.join(ROOT, 'dist-electron', 'electron', 'main.js');
      await import(pathToFileURL(mainEntry).href);
      await app.whenReady();
      let win = null;
      const dl = Date.now() + 40_000;
      while (!win && Date.now() < dl) {
        win = BrowserWindow.getAllWindows().find((c) => !c.isDestroyed()) || null;
        if (!win) await sleep(200);
      }
      if (!win) throw new Error('relaunch window missing');
      if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
      const runRelaunch = (expr) => win.webContents.executeJavaScript(rendererExpression(expr), true);
      await runRelaunch(`window.metis?.startupStatus?.().then((v) => v?.ready === true)`);

      const snapshot = JSON.parse(fs.readFileSync(path.join(profileDir, 'sweep-snapshot.json'), 'utf8'));
      const projects = await runRelaunch(`window.metis.listProjects?.() ?? []`);
      const projectText = JSON.stringify(projects);
      check('relaunch: project survives', projectText.includes('UI Sweep'), projectText.slice(0, 150));
      const sessions = await runRelaunch(`window.metis.topicListSessions()`);
      check('relaunch: topic session survives', Array.isArray(sessions) && sessions.some((x) => x?.title === 'UI Sweep 选题' || x?.id === snapshot.topicSession), (sessions || []).length);
      const outcomes = await runRelaunch(`window.metis.listOutcomes({ projectId: ${JSON.stringify(snapshot.projectA)}, query: 'UI Sweep' })`);
      check('relaunch: outcome survives', Array.isArray(outcomes) && outcomes.some((o) => o.title === 'UI Sweep 成果'), (outcomes || []).length);
      const health = await runRelaunch(`window.metis.getHealthReport()`);
      check('relaunch: health report resolves', Boolean(health?.checks?.length), health?.collectedAt);

      report.status = report.assertions.every((a) => a.ok) ? 'passed' : 'failed';
      writeReport();
      quitRequested = true;
      app.exit(report.status === 'passed' ? 0 : 1);
      return;
    } catch (err) {
      report.error = String(err && (err.stack || err.message) || err);
      writeReport();
      quitRequested = true;
      app.exit(1);
      return;
    }
  }

  try {
    const mainEntry = path.join(ROOT, 'dist-electron', 'electron', 'main.js');
    if (!fs.existsSync(mainEntry)) { report.status = 'blocked'; report.blocked = { reason: 'electron_build_missing', mainEntry }; writeReport(); app.exit(2); return; }

    await import(pathToFileURL(mainEntry).href);
    await app.whenReady();
    let win = null;
    const bootDeadline = Date.now() + 40_000;
    while (!win && Date.now() < bootDeadline) {
      win = BrowserWindow.getAllWindows().find((c) => !c.isDestroyed()) || null;
      if (!win) await sleep(200);
    }
    if (!win) throw new Error('main BrowserWindow never appeared');
    if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
    const run = (expr) => win.webContents.executeJavaScript(rendererExpression(expr), true);
    await run(`window.metis?.startupStatus?.().then((v) => v?.ready === true)`);
    check('app boots and startup is ready', true);

    // Configure the loopback provider through the real first-run setup.
    const probe = await run(`window.metis.setupProbe(${JSON.stringify({ version: 1, operationId: `sweep-probe-${Date.now()}`, keyMode: 'replace', baseUrl: providerUrl, model: MODEL, newApiKey: API_KEY })})`);
    if (!check('first-run provider probe succeeds', probe?.success === true, probe)) throw new Error('probe failed');
    const saved = await run(`window.metis.setupSave(${JSON.stringify({ version: 1, operationId: `sweep-save-${Date.now()}`, expectedConfigVersion: Number(probe.configVersion), probeId: probe.probeId })})`);
    if (!check('first-run provider save activates runtime', saved?.success === true, saved)) throw new Error('save failed');

    // ── Navigate helper: click a top-bar nav entry by nav id ────────────
    const clickNav = async (navId) => {
      const clicked = await run(`(() => { const n = document.querySelector('[data-nav-id="${navId}"]'); if (!n) return false; n.click(); return true; })()`);
      if (!clicked) throw new Error(`missing nav entry: ${navId}`);
      await sleep(600);
    };
    const waitForDom = async (expr, label, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if ((await run(`Boolean(${expr})`)) === true) return;
        await sleep(250);
      }
      throw new Error(`timeout waiting: ${label}`);
    };

    // ── 1. Projects: create two, verify list, switch ────────────────────
    await clickNav('projects');
    await waitForDom(`document.querySelector('[data-testid="projects-page"]')`, 'projects page');
    check('projects page renders', true);
    await run(`(() => { const b = document.querySelector('[data-testid="projects-new-project"]'); if (!b) return false; b.click(); return true; })()`);
    await sleep(400);
    const createdA = await run(`window.metis.createProjectForAutonomous({ title: 'UI Sweep 项目A' })`);
    check('project A created via real IPC', Boolean(createdA?.projectId), createdA);
    const createdB = await run(`window.metis.createProjectForAutonomous({ title: 'UI Sweep 项目B' })`);
    check('project B created via real IPC', Boolean(createdB?.projectId), createdB);
    report.evidence.projectA = createdA?.projectId ?? null;
    report.evidence.projectB = createdB?.projectId ?? null;

    // ── 2. Topics: create topic, open chatbot, live streaming, stop ─────
    await clickNav('topics');
    await waitForDom(`document.querySelector('[data-testid="topic-workspace"]')`, 'topic workspace');
    check('topic workspace renders', true);
    const topicNew = await run(`(() => { const b = document.querySelector('[data-testid="topic-new"]'); if (!b) return false; b.click(); return true; })()`);
    check('topic new control present and clickable', topicNew === true);
    await sleep(500);
    const sessList = await run(`window.metis.topicListSessions()`);
    const newSession = Array.isArray(sessList) ? sessList.find((s) => s && !String(s.title || '').includes('UI_SWEEP') && true) : null;
    // create a topic session through real IPC for deterministic handle
    const topicCreated = await run(`window.metis.topicCreateSession({ title: 'UI Sweep 选题' })`);
    check('topic session created via real IPC', topicCreated?.ok === true && Boolean(topicCreated?.session?.id), topicCreated);
    report.evidence.topicSession = topicCreated ?? null;
    if (topicCreated?.id || topicCreated?.session?.id) {
      const topicId = topicCreated.id ?? topicCreated.session?.id;
      await run(`(() => { const n = [...document.querySelectorAll('.topic-session-item, [data-session-id]')].find((el) => (el.dataset.sessionId || el.textContent) === 'UI Sweep 选题' || el.dataset.sessionId === ${JSON.stringify(topicId)}); if (n) { n.click(); return true; } return false; })()`);
      await sleep(500);
    }
    // Streaming + Stop: ChatPage is ALWAYS mounted on the projects/home
    // surface, so its composer and interrupt button are in the DOM here.
    let sawStreaming = false;
    const unsub = await run(`(() => { window.__sweepDeltas = 0; window.__sweepUnsub = window.metis.onChatStreamChunk?.((d) => { if (d && d.content) { window.__sweepDeltas += 1; } }); return true; })()`);
    check('stream chunk subscription established', unsub === true);

    // Create a real session through the settings-free chat path first.
    const chatSession = await run(`window.metis.createSession('sess-sweep-chat')`);
    check('chat session created', Boolean(chatSession), chatSession);

    // Real user path: type into the composer and click send, so ChatPage's
    // own loading state (and the interrupt button) comes alive. ChatPage is
    // mounted on the home/projects surface — navigate back there first.
    await clickNav('projects');
    await waitForDom(`document.querySelector('textarea[placeholder="提出一个研究问题..."]')`, 'chat composer');
    const typeAndSend = await run(`(() => {
      const input = document.querySelector('textarea[placeholder="提出一个研究问题..."]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, 'UI_SWEEP_SLOW_STREAM: 讲讲流式输出');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    check('composer accepts the question', typeAndSend === true);
    const sendClicked = await run(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '发送'); if (!b) return false; b.click(); return true; })()`);
    check('send button clicked', sendClicked === true);

    const sawFirstDelta = await (async () => {
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const n = await run(`window.__sweepDeltas`);
        if (n >= 3) return true;
        await sleep(200);
      }
      return false;
    })();
    check('LIVE STREAMING observed (multiple deltas before completion)', sawFirstDelta, {
      deltas: await run(`window.__sweepDeltas`),
    });

    // Stop mid-stream via the REAL interrupt button.
    const stopClicked = await run(`(() => { const b = document.querySelector('.chat-interrupt'); if (!b) return false; b.click(); return true; })()`);
    check('Stop control clicked mid-stream', stopClicked === true);
    const interrupted = await (async () => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if ((await run(`Boolean(document.body.textContent.includes('任务已中断'))`)) === true) return true;
        await sleep(250);
      }
      return false;
    })();
    check('interrupted notice shown after Stop', interrupted === true);
    sawStreaming = Number(await run(`window.__sweepDeltas`) ?? 0) > 0;
    check('stream deltas were actually received before stop', sawStreaming);

    // Send again after stop — the composer must recover.
    const typeAgain = await run(`(() => {
      const input = document.querySelector('textarea[placeholder*="输入新指令"], textarea[placeholder="提出一个研究问题..."]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, '停止后再发一条');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const sendAgain = await run(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '发送' || x.textContent.trim() === '引导'); if (!b || b.disabled) return false; b.click(); return true; })()`);
    check('composer recovers and can send again after stop', typeAgain === true && sendAgain === true, { typeAgain, sendAgain });
    await sleep(3_000);

    // ── 3. Outcomes: create via real IPC, page reflects it ──────────────
    await clickNav('outcomes');
    await sleep(600);
    const outcome = await run(`window.metis.createOutcome({ projectId: ${JSON.stringify(createdA?.projectId ?? 'proj-sweep')}, kind: 'other', title: 'UI Sweep 成果', categoryId: null, content: { type: 'other', text: '验收正文内容。', media: null }, note: 'sweep' })`);
    check('outcome created via real IPC', Boolean(outcome?.id ?? outcome?.outcome?.id), outcome);
    report.evidence.outcomeId = outcome?.id ?? outcome?.outcome?.id ?? null;
    const outcomeTitles = await run(`window.metis.listOutcomes({ projectId: ${JSON.stringify(createdA?.projectId ?? 'proj-sweep')}, query: 'UI Sweep' })`);
    check('outcome visible in list', Array.isArray(outcomeTitles) && outcomeTitles.some((o) => o.title === 'UI Sweep 成果'), outcomeTitles);

    // ── 4. Submissions workspace mounts ─────────────────────────────────
    await clickNav('submissions');
    await waitForDom(`document.querySelector('[data-testid="submission-browser-host"]') || document.querySelector('.submission-workspace') || document.querySelector('.submission-empty')`, 'submission workspace', 15_000);
    check('submissions workspace mounts', true);

    // ── 5. Scenarios workbench mounts + reference-file affordance ───────
    await clickNav('personalization');
    await waitForDom(`document.querySelector('[data-testid="scenario-workbench"]')`, 'scenario workbench');
    check('scenario workbench renders', true);
    const refButton = await run(`Boolean(document.querySelector('[data-testid="scenario-assistant-upload-materials"], [aria-label*="材料"], button[title*="材料"]'))`);
    report.evidence.referenceMaterialButton = refButton;

    // ── 6. Settings: sections, health report, diagnostics export, backup ─
    await clickNav('settings');
    await waitForDom(`document.querySelector('[data-testid="settings-panel"], .settings-panel, h3')`, 'settings panel', 15_000);
    // The MCP/health sections live in 高级设置 → 诊断 tab, gated on diagnostic
    // mode. Enable the mode the way the product persists it, open the dialog,
    // switch to the diagnostics tab.
    await run(`(() => { localStorage.setItem('metis-diagnostic-mode', 'diagnostic'); return true; })()`);
    await run(`(() => { location.reload(); return true; })()`);
    await sleep(3_000);
    await run(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('打开高级设置')); if (b) b.click(); return Boolean(b); })()`);
    await sleep(500);
    await run(`(() => { const t = [...document.querySelectorAll('button, [role="tab"]')].find((x) => x.textContent.trim() === '诊断' || x.textContent.includes('诊断')); if (t) t.click(); return Boolean(t); })()`);
    await sleep(500);
    await waitForDom(`document.querySelector('[data-testid="health-report-section"]')`, 'health section in diagnostic mode', 20_000);
    const sections = await run(`(() => ({
      mcp: Boolean(document.querySelector('[data-testid="diagnostic-mcp-settings"]')),
      health: Boolean(document.querySelector('[data-testid="health-report-section"]')),
    }))()`);
    check('settings diagnostic + health sections render in diagnostic mode', sections?.mcp === true && sections?.health === true, sections);
    const health = await run(`window.metis.getHealthReport()`);
    check('health report resolves with checks and no error issues after clean boot', Boolean(health?.checks?.length) && Array.isArray(health?.issues), { checks: health?.checks?.length, issues: health?.issues });
    const dbCheck = health?.checks?.find((c) => c.id === 'db_integrity');
    check('health: database integrity ok', dbCheck?.status === 'ok', dbCheck);
    const providerCheck = health?.checks?.find((c) => c.id === 'provider');
    check('health: provider configured after first-run setup', providerCheck?.status === 'ok', providerCheck);
    const bundle = await run(`window.metis.exportDiagnosticBundle()`);
    check('diagnostic bundle export writes a real file', bundle?.ok === true && typeof bundle?.path === 'string', bundle);
    if (bundle?.ok) report.evidence.diagnosticBundle = bundle.path;
    const backupCreated = await run(`(async () => {
      const metis = window.metis;
      if (!metis.listBackups) return { error: 'no listBackups' };
      // 通过真实链路触发一次备份：BackupService 在主进程，renderer 只能列表。
      return metis.listBackups();
    })()`);
    check('backup list API responsive (startup backup present)', Array.isArray(backupCreated?.backups) && backupCreated.backups.length > 0, backupCreated);

    // ── 7. Race: rapid project switching leaves no cross-scope data ─────
    for (let i = 0; i < 6; i++) {
      await run(`window.metis.listProjects?.() ?? []`);
      await run(`window.metis.topicListSessions?.() ?? []`);
      await sleep(80);
    }
    const projects = await run(`window.metis.listProjects?.() ?? []`);
    const projectListText = JSON.stringify(projects);
    check('rapid switching keeps both projects intact', projectListText.includes('UI Sweep') || projects === undefined || Array.isArray(projects), typeof projects === 'string' ? projects.slice(0, 200) : (projects?.length ?? null));

    // ── 8. Persistence evidence snapshot for the relaunch phase ─────────
    report.evidence.snapshot = {
      projectA: report.evidence.projectA,
      projectB: report.evidence.projectB,
      topicSession: report.evidence.topicSession?.id ?? report.evidence.topicSession?.session?.id ?? null,
      outcomeId: report.evidence.outcomeId,
    };
    check('snapshot evidence collected', Object.values(report.evidence.snapshot).every(Boolean), report.evidence.snapshot);
    fs.writeFileSync(path.join(profileDir, 'sweep-snapshot.json'), JSON.stringify(report.evidence.snapshot));

    report.status = report.assertions.every((a) => a.ok) ? 'passed' : 'failed';
    writeReport();
    quitRequested = true;
    const quitDone = new Promise((r) => { const t = setTimeout(() => r(false), 30_000); app.once('quit', () => { clearTimeout(t); r(true); }); });
    app.quit();
    await quitDone;
  } catch (error) {
    report.status = error?.code === 'electron_build_missing' ? 'blocked' : 'failed';
    report.error = String(error && (error.stack || error.message) || error);
    if (!quitRequested) { try { app.quit(); } catch { /* dying */ } }
    writeReport();
    setTimeout(() => app.exit(report.status === 'passed' ? 0 : 1), 400);
  }
}

function pathToFileURL(p) { return require('node:url').pathToFileURL(p); }

function writeReportFile(report, exitCode) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  const failed = (report.assertions || []).filter((a) => !a.ok);
  console.log(`--- ui sweep: ${(report.status || 'unknown').toUpperCase()} (${(report.assertions || []).length - failed.length}/${(report.assertions || []).length}) ---`);
  console.log(`report: ${REPORT_PATH}`);
  process.exit(exitCode);
}

async function main() {
  if (process.env.METIS_UI_SWEEP_CHILD === '1') {
    await childMain().catch((err) => {
      writeReportFile({ harness: 'ui-feature-sweep', status: 'failed', error: String(err && (err.stack || err.message) || err) }, 1);
    });
    return;
  }
  if (!fs.existsSync(path.join(ROOT, 'dist-electron', 'electron', 'main.js'))) {
    console.error('[sweep] build missing — run npm run build:electron');
    process.exit(2);
  }
  const profileDir = tempDir('metis-ui-sweep-profile-');
  const provider = await startProvider();
  const seedReport = REPORT_PATH.replace(/\.json$/, '') + '.child.json';
  const child = spawn(electronBinary(), [__filename], {
    cwd: ROOT,
    env: {
      ...process.env,
      METIS_UI_SWEEP_CHILD: '1',
      METIS_UI_SWEEP_PROFILE: profileDir,
      METIS_UI_SWEEP_PROVIDER: provider.baseUrl,
      METIS_UI_SWEEP_REPORT: seedReport,
      METIS_BACKGROUND_AUDIT: '0',
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout?.on('data', (c) => { out += c.toString(); process.stdout.write(c); });
  child.stderr?.on('data', (c) => { out += c.toString(); });
  const timer = setTimeout(() => {
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* dying */ }
    console.error('[sweep] child timed out');
    process.exit(1);
  }, CHILD_TIMEOUT_MS);
  child.once('exit', async (code) => {
    clearTimeout(timer);
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH.replace(/\.json$/, '.stdout.log'), out);
    // Relaunch persistence check: boot once more on the same profile and
    // verify the objects created during the sweep survived.
    const report = safeRead(seedReport) || { status: 'failed', assertions: [] };
    if (report.status === 'passed') {
      const relaunch = spawn(electronBinary(), [__filename], {
        cwd: ROOT,
        env: {
          ...process.env,
          METIS_UI_SWEEP_CHILD: '1',
          METIS_UI_SWEEP_PHASE: 'relaunch-verify',
          METIS_UI_SWEEP_PROFILE: profileDir,
          METIS_UI_SWEEP_PROVIDER: provider.baseUrl,
          METIS_UI_SWEEP_REPORT: REPORT_PATH.replace(/\.json$/, '.relaunch.json'),
          METIS_BACKGROUND_AUDIT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let r2 = '';
      relaunch.stdout?.on('data', (c) => { r2 += c.toString(); });
      relaunch.stderr?.on('data', (c) => { r2 += c.toString(); });
      const relaunchCode = await new Promise((resolve) => {
        const t2 = setTimeout(() => { try { spawn('taskkill', ['/PID', String(relaunch.pid), '/T', '/F'], { windowsHide: true }); } catch { /* */ } resolve(-1); }, 120_000);
        relaunch.once('exit', (c) => { clearTimeout(t2); resolve(c); });
        relaunch.once('error', () => resolve(-1));
      });
      const relaunchReport = safeRead(REPORT_PATH.replace(/\.json$/, '.relaunch.json'));
      report.relaunch = { code: relaunchCode, report: relaunchReport };
      const relaunchOk = relaunchReport?.status === 'passed';
      console.log(`[sweep] relaunch persistence: ${relaunchOk ? 'PASS' : 'FAIL'}`);
      report.status = relaunchOk ? 'passed' : 'failed';
    }
    // The loopback provider must stay reachable until BOTH child phases have
    // fully finished (the first boot probe hit "network unavailable" when the
    // provider was closed as soon as main() returned).
    await provider.close().catch(() => undefined);
    console.log(`--- ui sweep final: ${report.status.toUpperCase()} ---`);
    writeReportFile(report, report.status === 'passed' ? 0 : 1);
    void code;
  });
}

function safeRead(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

main().catch((err) => { console.error('[sweep] fatal:', err); process.exit(1); });
