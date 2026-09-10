/**
 * Real isolated Electron shutdown/relaunch/approval E2E.
 *
 * Scope:
 *   - built Electron main + BrowserWindow + production preload IPC;
 *   - temporary userData (including temporary metis.db);
 *   - real renderer-backed Scenario approval;
 *   - app.quit() while the approval promise is pending;
 *   - a fresh Electron process reusing the same temporary profile;
 *   - physical renderer approval click after relaunch.
 *
 * The provider is a deterministic loopback OpenAI-compatible HTTP server. It
 * controls protocol responses only; it is not evidence of external provider
 * quality, network recovery, or model quality.
 *
 * Run from the project root:
 *   npm run acceptance:shutdown-relaunch-approval
 *   node scripts/electron-shutdown-relaunch-approval-e2e.cjs --report logs/custom.json
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = 'metis-electron-shutdown-relaunch-approval-e2e';
const MODEL = 'metis-shutdown-approval-loopback';
const API_KEY = 'metis-shutdown-approval-loopback-key';
const SUCCESS_MARKER = 'SHUTDOWN_APPROVAL_RELAUNCH_SUCCESS';
const BLOCKED_EXIT = 2;
const CHILD_TIMEOUT_MS = 90_000;
const REPORT_INDEX = process.argv.indexOf('--report');
const DEFAULT_STEM = `electron-shutdown-relaunch-approval-e2e-${new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)}`;
const REPORT_PATH = path.resolve(
  REPORT_INDEX >= 0 && process.argv[REPORT_INDEX + 1]
    ? process.argv[REPORT_INDEX + 1]
    : path.join(ROOT, 'logs', `${DEFAULT_STEM}.json`),
);
const LOG_DIR = path.resolve(process.env.METIS_SHUTDOWN_APPROVAL_LOG_DIR || path.dirname(REPORT_PATH));
const REPORT_STEM = path.basename(REPORT_PATH, path.extname(REPORT_PATH));

function mkdirFor(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJson(filePath, value) {
  mkdirFor(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function sendStream(res, content) {
  res.writeHead(200, {
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
  });
  const id = `shutdown-approval-${Date.now()}`;
  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  })}\n\n`);
  res.end('data: [DONE]\n\n');
}

function completion(content, toolCalls = []) {
  return {
    id: `shutdown-approval-${Date.now()}`,
    object: 'chat.completion',
    created: Math.trunc(Date.now() / 1000),
    model: MODEL,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  };
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function startProvider() {
  const state = {
    requests: 0,
    modelsRequests: 0,
    probeRequests: 0,
    actualScenarioCalls: 0,
    actualScenarioMessages: [],
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname.startsWith('/v1/models')) {
      state.requests += 1;
      state.modelsRequests += 1;
      return sendJson(res, 200, {
        data: [{ id: MODEL, context_window: 32_000, modalities: ['text'] }],
      });
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      return sendJson(res, 404, { error: 'not_found' });
    }
    state.requests += 1;
    let body;
    try {
      body = await parseRequestBody(req);
    } catch {
      return sendJson(res, 400, { error: 'invalid_json' });
    }
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const allText = messages.map((message) => String(message?.content ?? '')).join('\n');
    const actual = allText.includes('APPROVAL_RELAUNCH_E2E_ACTUAL_RUN')
      && allText.includes('APPROVAL_RELAUNCH_E2E_SCENARIO');
    if (!actual) {
      state.probeRequests += 1;
      if (body?.stream === true) return sendStream(res, 'OK');
      if (body?.response_format?.type === 'json_object') {
        return sendJson(res, 200, completion('{"ok":true}'));
      }
      if (Array.isArray(body?.tools)) {
        return sendJson(res, 200, completion('', [{
          id: 'shutdown-approval-probe-tool',
          type: 'function',
          function: { name: 'metis_probe', arguments: '{"ok":true}' },
        }]));
      }
      return sendJson(res, 200, completion('OK'));
    }
    state.actualScenarioCalls += 1;
    state.actualScenarioMessages.push({
      count: messages.length,
      chars: allText.length,
      containsScenarioMarker: allText.includes('APPROVAL_RELAUNCH_E2E_SCENARIO'),
    });
    if (body?.stream === true) return sendStream(res, SUCCESS_MARKER);
    return sendJson(res, 200, completion(SUCCESS_MARKER));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback provider did not bind.');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  return {
    baseUrl,
    state,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function electronBinary() {
  return path.join(
    ROOT,
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  );
}

function waitForChild(child, timeoutMs = CHILD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill(); } catch { /* best effort */ }
      resolve({ code: null, signal: 'timeout', timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code, signal, timedOut: false, stdout, stderr });
    });
  });
}

function runChild(phase, profileDir, providerUrl, reportPath, stdoutPath, stderrPath) {
  const binary = electronBinary();
  if (!fs.existsSync(binary)) {
    const error = new Error(`Electron binary is missing: ${binary}`);
    error.code = 'electron_binary_missing';
    throw error;
  }
  const child = spawn(binary, [__filename], {
    cwd: ROOT,
    env: {
      ...process.env,
      METIS_SHUTDOWN_APPROVAL_CHILD: '1',
      METIS_SHUTDOWN_APPROVAL_PHASE: phase,
      METIS_SHUTDOWN_APPROVAL_PROFILE: profileDir,
      METIS_SHUTDOWN_APPROVAL_PROVIDER: providerUrl,
      METIS_SHUTDOWN_APPROVAL_REPORT: reportPath,
      METIS_BACKGROUND_AUDIT: '0',
      ELECTRON_ENABLE_LOGGING: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return waitForChild(child).then((result) => {
    mkdirFor(stdoutPath);
    mkdirFor(stderrPath);
    fs.writeFileSync(stdoutPath, result.stdout, 'utf8');
    fs.writeFileSync(stderrPath, result.stderr, 'utf8');
    return result;
  });
}

function rendererExpression(expression) {
  return `(async () => { try { return await (${expression}); } catch (error) { return { __e2eError: String(error && (error.stack || error.message) || error) }; } })()`;
}

function buildScenario() {
  const now = Date.now();
  const scenarioId = 'user:scenarios/shutdown-relaunch-approval-e2e';
  return {
    contractVersion: 1,
    id: scenarioId,
    kind: 'scenario',
    name: 'Shutdown relaunch approval E2E',
    description: 'A deterministic isolated scenario used to exercise approval lifecycle and relaunch persistence.',
    enabled: true,
    tags: ['electron-e2e', 'shutdown', 'approval'],
    revision: 1,
    provenance: {
      origin: 'user',
      author: 'Metis isolated E2E',
      version: '1.0.0',
      license: null,
      sourceUrl: null,
      sourceRevision: null,
      installedDigest: null,
      parentId: null,
      parentVersion: null,
      locallyModified: true,
      createdAt: now,
      updatedAt: now,
    },
    agentIds: [],
    skillIds: [],
    mcpIds: [],
    rulesIds: [],
    workflow: [{
      id: 'approval-step',
      name: 'Approval controlled step',
      description: 'Wait for the real renderer approval before making one deterministic provider request.',
      skillIds: [],
      toolIds: [],
      mcpIds: [],
      dependsOn: [],
      maxTurns: 3,
      goal: 'Produce the deterministic approval relaunch marker.',
      prompt: 'APPROVAL_RELAUNCH_E2E_SCENARIO: complete this isolated approval step.',
    }],
    fullAccess: {
      mode: 'full_access',
      perActionConfirmation: false,
      liveSteering: true,
      silentCheckpoints: true,
      rollbackOnFailure: false,
      persistAcrossRestart: true,
    },
    memory: {
      scope: 'session',
      retainDecisions: false,
      retainArtifacts: false,
      maxSummaryChars: 10_000,
    },
    output: {
      format: 'markdown',
      schema: null,
      requireEvidenceEnvelope: false,
      includeIntegrityReport: false,
    },
    triggerPhrases: ['run approval relaunch E2E'],
    capability: 'custom',
    hooks: [{
      id: 'approval-hook',
      event: 'step_start',
      matchStepId: 'approval-step',
      action: 'approval',
      instruction: 'Approve the isolated approval relaunch step.',
      enabled: true,
    }],
  };
}

function makeReport(phase, profileDir, providerUrl, reportPath) {
  return {
    runner: RUNNER,
    phase,
    status: 'starting',
    scope: 'real-Electron-BrowserWindow-preload-main-IPC-temporary-userData-SQLite',
    provider: 'controlled-loopback-OpenAI-compatible-not-external',
    providerUrl,
    profileDir,
    reportPath,
    assertions: [],
    evidence: {},
  };
}

function check(report, name, ok, detail) {
  const assertion = { name, ok: Boolean(ok) };
  if (detail !== undefined) assertion.detail = detail;
  report.assertions.push(assertion);
  return Boolean(ok);
}

function detailValue(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(detailValue(last))}`);
}

async function waitForRenderer(win, expression, timeoutMs, label) {
  return waitFor(async () => {
    const value = await win.webContents.executeJavaScript(rendererExpression(expression), true);
    if (value?.__e2eError) throw new Error(value.__e2eError);
    return value;
  }, timeoutMs, label || expression);
}

async function waitForQuit(app, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Electron did not emit quit within ${timeoutMs}ms.`)), timeoutMs);
    app.once('quit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function childMain() {
  const { app, BrowserWindow } = require('electron');
  const phase = process.env.METIS_SHUTDOWN_APPROVAL_PHASE;
  const profileDir = process.env.METIS_SHUTDOWN_APPROVAL_PROFILE;
  const providerUrl = process.env.METIS_SHUTDOWN_APPROVAL_PROVIDER;
  const reportPath = process.env.METIS_SHUTDOWN_APPROVAL_REPORT;
  if (!profileDir || !providerUrl || !reportPath || !['phase-1', 'phase-2'].includes(phase)) {
    throw new Error('Shutdown approval child environment is incomplete.');
  }

  app.setName('METIS Shutdown Relaunch Approval E2E');
  app.setPath('userData', profileDir);
  const report = makeReport(phase, profileDir, providerUrl, reportPath);
  let win = null;
  let quitRequested = false;
  let reportWritten = false;
  const writeChildReport = () => {
    writeJson(reportPath, report);
    reportWritten = true;
  };
  try {
    const mainEntry = path.join(ROOT, 'dist-electron', 'electron', 'main.js');
    const rendererEntry = path.join(ROOT, 'dist', 'index.html');
    if (!fs.existsSync(mainEntry) || !fs.existsSync(rendererEntry)) {
      report.status = 'blocked';
      report.blocked = { reason: 'electron_build_missing', mainEntry, rendererEntry };
      writeChildReport();
      app.exit(BLOCKED_EXIT);
      return;
    }

    await import(pathToFileUrl(mainEntry));
    await app.whenReady();
    await waitFor(async () => {
      const windows = BrowserWindow.getAllWindows();
      win = windows.find((candidate) => !candidate.isDestroyed()) || null;
      return win;
    }, 30_000, 'main BrowserWindow');
    if (win.webContents.isLoading()) {
      await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    }
    await waitForRenderer(win, 'window.metis?.startupStatus?.().then((value) => value?.ready === true)', 30_000, 'renderer startup');

    const identity = await win.webContents.executeJavaScript(rendererExpression('window.metis.runtimeIdentity?.()'), true);
    check(report, 'real runtime identity is available', identity?.buildId === 'metis-alpha2-release', identity);
    check(report, 'runtime data directory remains under temporary profile', typeof identity?.dataDir === 'string' && identity.dataDir.startsWith(profileDir), identity);
    report.evidence.runtimeIdentity = identity;
    const sqlitePath = path.join(identity?.dataDir || path.join(profileDir, 'metis-data'), 'metis.db');
    check(report, 'temporary SQLite exists before scenario work', fs.existsSync(sqlitePath), sqlitePath);
    report.evidence.sqlitePath = sqlitePath;

    const apiShape = await win.webContents.executeJavaScript(rendererExpression(`({
      setupProbe: typeof window.metis?.setupProbe === 'function',
      setupSave: typeof window.metis?.setupSave === 'function',
      savePersonalization: typeof window.metis?.savePersonalization === 'function',
      getPersonalization: typeof window.metis?.getPersonalization === 'function',
      listPersonalization: typeof window.metis?.listPersonalization === 'function',
      agentChat: typeof window.metis?.agentChat === 'function',
      onScenarioApprovalRequired: typeof window.metis?.onScenarioApprovalRequired === 'function',
      respondScenarioApproval: typeof window.metis?.respondScenarioApproval === 'function',
    })`), true);
    check(report, 'production renderer exposes required approval/scenario IPC APIs', Object.values(apiShape || {}).every(Boolean), apiShape);

    const run = (expression) => win.webContents.executeJavaScript(rendererExpression(expression), true);
    const scenario = buildScenario();
    const scenarioId = scenario.id;
    const sessionId = `shutdown-approval-e2e-${phase}`;
    const turnId = `shutdown-approval-turn-${phase}`;

    if (phase === 'phase-1') {
      const operation = `shutdown-approval-${Date.now()}`;
      const probe = await run(`window.metis.setupProbe(${JSON.stringify({
        version: 1,
        operationId: `${operation}-probe`,
        keyMode: 'replace',
        baseUrl: providerUrl,
        model: MODEL,
        newApiKey: API_KEY,
      })})`);
      check(report, 'controlled loopback passes the real first-run provider probe', probe?.success === true, probe);
      if (!probe?.success) throw new Error(`Provider probe failed: ${JSON.stringify(probe)}`);
      const saved = await run(`window.metis.setupSave(${JSON.stringify({
        version: 1,
        operationId: `${operation}-save`,
        expectedConfigVersion: Number(probe.configVersion),
        probeId: probe.probeId,
      })})`);
      check(report, 'real provider setup save activates the runtime', saved?.success === true, saved);
      if (!saved?.success) throw new Error(`Provider setup save failed: ${JSON.stringify(saved)}`);

      const savedScenario = await run(`window.metis.savePersonalization(${JSON.stringify({
        contractVersion: 1,
        definition: scenario,
        expectedRevision: 0,
      })})`);
      check(report, 'approval Scenario is persisted through production personalization IPC', savedScenario?.ok === true, savedScenario);
      if (!savedScenario?.ok) throw new Error(`Scenario save failed: ${JSON.stringify(savedScenario)}`);
      report.evidence.scenarioId = scenarioId;

      await run(`(() => {
        window.__shutdownApprovalEvents = [];
        window.__shutdownApprovalUnsubscribe = window.metis.onScenarioApprovalRequired((payload) => {
          window.__shutdownApprovalEvents.push(payload);
        });
        return true;
      })()`);
      const chatStartedAt = Date.now();
      const chatPromise = run(`window.metis.agentChat(
        ${JSON.stringify(sessionId)},
        [{ role: 'user', content: 'APPROVAL_RELAUNCH_E2E_ACTUAL_RUN: request the approval-controlled deterministic marker.' }],
        undefined,
        { mode: 'send', turnId: ${JSON.stringify(turnId)}, scenarioId: ${JSON.stringify(scenarioId)}, projectId: 'global' },
      )`);
      await waitForRenderer(win, 'Array.isArray(window.__shutdownApprovalEvents) && window.__shutdownApprovalEvents.length === 1', 30_000, 'renderer approval event');
      const approvalPayload = await run('window.__shutdownApprovalEvents[0]');
      check(report, 'real renderer receives the scenario approval IPC event', approvalPayload?.requestId && approvalPayload?.stepId === 'approval-step', approvalPayload);
      report.evidence.approvalUi = {
        checked: false,
        limitation: 'The first-run approval event can arrive before the lazy approval component mounts; phase 2 verifies the real approval dialog and click after relaunch.',
      };
      report.evidence.approvalPayload = {
        requestId: approvalPayload?.requestId,
        hookId: approvalPayload?.hookId,
        stepId: approvalPayload?.stepId,
        runId: approvalPayload?.runId,
      };

      const quitAt = Date.now();
      const quitFinalized = new Promise((resolve) => {
        // Electron can emit will-quit before the async continuation after
        // app.quit() gets a chance to write evidence. Hold final termination
        // until the real approval promise has settled and the child report is
        // durably written; app.exit() then bypasses a second before-quit loop.
        app.once('will-quit', (event) => {
          event.preventDefault();
          void (async () => {
            let chatResponse;
            try {
              chatResponse = await chatPromise;
            } catch (error) {
              chatResponse = { status: 'error', answer: '', error: String(error?.message || error) };
            }
            const resolvedAt = Date.now();
            report.evidence.chatResponse = detailValue(chatResponse);
            report.evidence.shutdownRequestedAt = new Date(quitAt).toISOString();
            report.evidence.approvalSettledAfterShutdownMs = resolvedAt - quitAt;
            check(report, 'pending approval settles promptly after app.quit shutdown begins', resolvedAt - quitAt < 10_000, {
              elapsedMs: resolvedAt - quitAt,
              chatResponse,
            });
            check(report, 'shutdown fail-closed returns an interrupted/error response instead of executing the step', (chatResponse?.status === 'error' || chatResponse?.status === 'interrupted') && chatResponse?.answer === '', chatResponse);
            check(report, 'shutdown response does not claim a successful scenario result', !String(chatResponse?.answer || '').includes(SUCCESS_MARKER), chatResponse);
            report.evidence.electronQuitEventObserved = true;
            report.status = report.assertions.every((entry) => entry.ok) ? 'passed' : 'failed';
            writeChildReport();
            resolve();
            app.exit(report.status === 'passed' ? 0 : 1);
          })();
        });
      });
      quitRequested = true;
      app.quit();
      await quitFinalized;
      return;
    }

    const listed = await run('window.metis.listPersonalization({ contractVersion: 1, includeDisabled: true })');
    check(report, 'persisted Scenario is listed after a fresh Electron relaunch', listed?.ok === true && listed.definitions?.some((item) => item.id === scenarioId), listed);
    const loaded = await run(`window.metis.getPersonalization({ contractVersion: 1, id: ${JSON.stringify(scenarioId)} })`);
    check(report, 'persisted Scenario retains its approval hook after relaunch', loaded?.ok === true
      && loaded.definition?.id === scenarioId
      && loaded.definition?.hooks?.some((hook) => hook.id === 'approval-hook' && hook.action === 'approval'), loaded);
    const pendingHITL = await run('window.metis.getPendingApprovals()');
    check(report, 'relaunch starts with no stale HITL approval queue entries', Array.isArray(pendingHITL) && pendingHITL.length === 0, pendingHITL);
    report.evidence.scenarioId = scenarioId;
    report.evidence.persistedScenarioRevision = loaded?.definition?.revision;

    await run(`(() => {
      window.__shutdownApprovalEvents = [];
      window.__shutdownApprovalUnsubscribe = window.metis.onScenarioApprovalRequired((payload) => {
        window.__shutdownApprovalEvents.push(payload);
      });
      return true;
    })()`);
    const chatPromise = run(`window.metis.agentChat(
      ${JSON.stringify(sessionId)},
      [{ role: 'user', content: 'APPROVAL_RELAUNCH_E2E_ACTUAL_RUN: approve the relaunch-controlled deterministic marker.' }],
      undefined,
      { mode: 'send', turnId: ${JSON.stringify(turnId)}, scenarioId: ${JSON.stringify(scenarioId)}, projectId: 'global' },
    )`);
    await waitForRenderer(win, 'Array.isArray(window.__shutdownApprovalEvents) && window.__shutdownApprovalEvents.length === 1', 30_000, 'relaunch approval event');
    const approvalPayload = await run('window.__shutdownApprovalEvents[0]');
    check(report, 'fresh renderer receives a new approval request after relaunch', approvalPayload?.requestId && approvalPayload?.stepId === 'approval-step', approvalPayload);
    await waitForRenderer(win, 'document.querySelector("[data-testid=\\"scenario-approval-dialog\\"]") !== null', 10_000, 'relaunch approval dialog');
    const clicked = await run(`(() => {
      const button = document.querySelector('[data-testid="scenario-approval-approve"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    check(report, 'approval is completed by clicking the real renderer approval control', clicked === true, clicked);
    const chatResponse = await chatPromise;
    check(report, 'approved scenario step completes after relaunch', chatResponse?.status === 'completed' && chatResponse?.answer === SUCCESS_MARKER, chatResponse);
    check(report, 'approval dialog is removed after renderer approval', await waitForRenderer(win, 'document.querySelector("[data-testid=\\"scenario-approval-dialog\\"]") === null', 10_000, 'approval dialog dismissal'), chatResponse);
    const messages = await run(`window.metis.getMessages(${JSON.stringify(sessionId)})`);
    check(report, 'approved result is persisted through the real Electron SQLite path', Array.isArray(messages) && messages.some((message) => message?.role === 'assistant' && message?.content === SUCCESS_MARKER), messages);
    report.evidence.approvalPayload = {
      requestId: approvalPayload?.requestId,
      hookId: approvalPayload?.hookId,
      stepId: approvalPayload?.stepId,
      runId: approvalPayload?.runId,
    };
    report.evidence.chatResponse = detailValue(chatResponse);
    report.evidence.persistedMessageCount = Array.isArray(messages) ? messages.length : null;

    const quitFinished = waitForQuit(app);
    quitRequested = true;
    app.quit();
    await quitFinished;
    report.evidence.electronQuitEventObserved = true;
    report.status = report.assertions.every((entry) => entry.ok) ? 'passed' : 'failed';
    writeChildReport();
  } catch (error) {
    report.status = error?.code === 'electron_build_missing' ? 'blocked' : 'failed';
    report.error = error instanceof Error ? error.stack || error.message : String(error);
    if (!quitRequested) {
      try {
        const quitFinished = waitForQuit(app, 15_000);
        quitRequested = true;
        app.quit();
        await quitFinished;
      } catch (quitError) {
        report.quitError = quitError instanceof Error ? quitError.message : String(quitError);
      }
    }
    if (!reportWritten) writeChildReport();
  } finally {
    if (!reportWritten) writeChildReport();
  }
}

function pathToFileUrl(filePath) {
  const normalized = path.resolve(filePath).replaceAll('\\', '/');
  return `file://${normalized.startsWith('/') ? '' : '/'}${encodeURI(normalized).replaceAll('#', '%23')}`;
}

async function runOrchestrator() {
  const profileDir = tempDir('metis-shutdown-relaunch-approval-profile-');
  const provider = await startProvider();
  const phaseReports = {};
  const phaseProcesses = {};
  const paths = {
    report: REPORT_PATH,
    phase1Report: path.join(LOG_DIR, `${REPORT_STEM}-phase-1.json`),
    phase2Report: path.join(LOG_DIR, `${REPORT_STEM}-phase-2.json`),
    phase1Stdout: path.join(LOG_DIR, `${REPORT_STEM}-phase-1.stdout.log`),
    phase1Stderr: path.join(LOG_DIR, `${REPORT_STEM}-phase-1.stderr.log`),
    phase2Stdout: path.join(LOG_DIR, `${REPORT_STEM}-phase-2.stdout.log`),
    phase2Stderr: path.join(LOG_DIR, `${REPORT_STEM}-phase-2.stderr.log`),
  };
  const result = {
    runner: RUNNER,
    status: 'starting',
    scope: 'real-Electron-child-processes-shared-temporary-profile-preload-main-IPC-SQLite',
    provider: 'controlled-loopback-OpenAI-compatible-not-external',
    profileDir,
    databasePath: path.join(profileDir, 'metis-data', 'metis.db'),
    paths,
    phases: phaseReports,
    childProcesses: phaseProcesses,
    assertions: [],
    limitations: [
      'The provider is a local deterministic loopback fixture; this proves protocol wiring and lifecycle behavior, not external provider/model quality.',
      'Approval is observed in the real renderer and phase 2 is completed by a DOM button click through Electron WebContents; this is not a native OS mouse automation trace.',
      'The test does not prove network offline/online recovery, long-context compression, Scenario full-run quality, or native overlay behavior; those are separate audited runners.',
      'The final report retains hashes/statuses/paths and loopback endpoint metadata, never the configured API key; the temporary profile and SQLite are deleted during cleanup.',
    ],
  };
  let exitCode = 1;
  const checkOrchestrator = (name, ok, detail) => {
    result.assertions.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
    return Boolean(ok);
  };

  try {
    const mainEntry = path.join(ROOT, 'dist-electron', 'electron', 'main.js');
    const rendererEntry = path.join(ROOT, 'dist', 'index.html');
    if (!fs.existsSync(mainEntry) || !fs.existsSync(rendererEntry)) {
      result.status = 'blocked';
      result.blocked = { reason: 'electron_build_missing', mainEntry, rendererEntry };
      exitCode = BLOCKED_EXIT;
    } else {
      const phase1Process = await runChild('phase-1', profileDir, provider.baseUrl, paths.phase1Report, paths.phase1Stdout, paths.phase1Stderr);
      phaseProcesses.phase1 = {
        code: phase1Process.code,
        signal: phase1Process.signal,
        timedOut: phase1Process.timedOut,
        stdoutPath: paths.phase1Stdout,
        stderrPath: paths.phase1Stderr,
      };
      if (fs.existsSync(paths.phase1Report)) phaseReports.phase1 = readJson(paths.phase1Report);
      checkOrchestrator('shutdown phase Electron child exits cleanly', phase1Process.code === 0, phaseProcesses.phase1);
      checkOrchestrator('shutdown phase report passes', phaseReports.phase1?.status === 'passed', phaseReports.phase1);
      checkOrchestrator('shutdown phase produces no controlled provider scenario call', provider.state.actualScenarioCalls === 0, provider.state);

      const phase2Process = await runChild('phase-2', profileDir, provider.baseUrl, paths.phase2Report, paths.phase2Stdout, paths.phase2Stderr);
      phaseProcesses.phase2 = {
        code: phase2Process.code,
        signal: phase2Process.signal,
        timedOut: phase2Process.timedOut,
        stdoutPath: paths.phase2Stdout,
        stderrPath: paths.phase2Stderr,
      };
      if (fs.existsSync(paths.phase2Report)) phaseReports.phase2 = readJson(paths.phase2Report);
      checkOrchestrator('relaunch phase Electron child exits cleanly', phase2Process.code === 0, phaseProcesses.phase2);
      checkOrchestrator('relaunch phase report passes', phaseReports.phase2?.status === 'passed', phaseReports.phase2);
      checkOrchestrator('approved relaunch phase makes one controlled provider scenario call', provider.state.actualScenarioCalls === 1, provider.state);
      checkOrchestrator('approved provider request includes the Scenario marker', provider.state.actualScenarioMessages.length === 1 && provider.state.actualScenarioMessages[0].containsScenarioMarker === true, provider.state);
      checkOrchestrator('same temporary SQLite profile is used by both phases', phaseReports.phase1?.profileDir === profileDir && phaseReports.phase2?.profileDir === profileDir, {
        phase1: phaseReports.phase1?.profileDir,
        phase2: phaseReports.phase2?.profileDir,
        profileDir,
      });
      result.providerState = {
        requests: provider.state.requests,
        modelsRequests: provider.state.modelsRequests,
        probeRequests: provider.state.probeRequests,
        actualScenarioCalls: provider.state.actualScenarioCalls,
        actualScenarioMessages: provider.state.actualScenarioMessages,
      };
      result.status = result.assertions.every((entry) => entry.ok)
        && phaseReports.phase1?.status === 'passed'
        && phaseReports.phase2?.status === 'passed'
        ? 'passed'
        : 'failed';
      exitCode = result.status === 'passed' ? 0 : 1;
    }
  } catch (error) {
    result.status = error?.code === 'electron_binary_missing' ? 'blocked' : 'failed';
    result.error = error instanceof Error ? error.stack || error.message : String(error);
    exitCode = result.status === 'blocked' ? BLOCKED_EXIT : 1;
  } finally {
    result.providerState = result.providerState || {
      requests: provider.state.requests,
      modelsRequests: provider.state.modelsRequests,
      probeRequests: provider.state.probeRequests,
      actualScenarioCalls: provider.state.actualScenarioCalls,
      actualScenarioMessages: provider.state.actualScenarioMessages,
    };
    await provider.close().catch((error) => {
      result.cleanupError = error instanceof Error ? error.message : String(error);
      if (result.status === 'passed') {
        result.status = 'failed';
        exitCode = 1;
      }
    });
    try {
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      result.profileRemoved = !fs.existsSync(profileDir);
    } catch (error) {
      result.profileRemoved = false;
      result.cleanupError = error instanceof Error ? error.message : String(error);
      if (result.status === 'passed') {
        result.status = 'failed';
        exitCode = 1;
      }
    }
    checkOrchestrator('temporary profile and SQLite are removed after the run', result.profileRemoved === true, { profileDir, profileRemoved: result.profileRemoved });
    result.finishedAt = new Date().toISOString();
    result.exitCode = exitCode;
    writeJson(REPORT_PATH, result);
    process.stdout.write(`${JSON.stringify({ runner: RUNNER, status: result.status, exitCode, reportPath: REPORT_PATH, paths, providerState: result.providerState, profileRemoved: result.profileRemoved }, null, 2)}\n`);
    process.exitCode = exitCode;
  }
}

if (process.env.METIS_SHUTDOWN_APPROVAL_CHILD === '1') {
  void childMain().catch((error) => {
    const reportPath = process.env.METIS_SHUTDOWN_APPROVAL_REPORT;
    const fallback = {
      runner: RUNNER,
      phase: process.env.METIS_SHUTDOWN_APPROVAL_PHASE,
      status: 'failed',
      error: error instanceof Error ? error.stack || error.message : String(error),
    };
    if (reportPath) writeJson(reportPath, fallback);
    process.stderr.write(`${JSON.stringify(fallback)}\n`);
    process.exitCode = 1;
  });
} else {
  void runOrchestrator().catch((error) => {
    const fallback = {
      runner: RUNNER,
      status: 'failed',
      exitCode: 1,
      error: error instanceof Error ? error.stack || error.message : String(error),
      reportPath: REPORT_PATH,
    };
    writeJson(REPORT_PATH, fallback);
    process.stderr.write(`${JSON.stringify(fallback)}\n`);
    process.exitCode = 1;
  });
}
