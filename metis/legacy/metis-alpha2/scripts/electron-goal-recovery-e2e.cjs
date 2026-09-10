/**
 * Isolated BrowserWindow Goal recovery/cancellation drill.
 *
 * This is a real Electron renderer/preload/main IPC exercise with a temporary
 * profile and a deterministic loopback Provider. It is evidence of product
 * persistence and control wiring only, never external Provider quality.
 *
 * Run with: npm exec -- electron scripts/electron-goal-recovery-e2e.cjs
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = 'metis-electron-goal-recovery-e2e';

function jsonFile(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startProvider() {
  const state = {
    blockNextExecution: false,
    blocked: false,
    release: null,
    executionCalls: 0,
    planningCalls: 0,
  };
  const workflow = {
    id: 'wf-browser-recovery',
    name: 'Browser recovery drill workflow',
    description: 'Two serial deterministic steps for the recovery drill.',
    version: '1.0',
    steps: [
      {
        id: 'collect', name: 'Collect', description: 'Collect deterministic evidence.',
        prompt: 'Collect deterministic evidence and report the checkpoint marker.',
        inputFrom: [], tools: [], maxTurns: 6,
      },
      {
        id: 'synthesize', name: 'Synthesize', description: 'Synthesize the checkpoint evidence.',
        prompt: 'Synthesize the previous checkpoint output into a final marker.',
        inputFrom: ['collect'], tools: [], maxTurns: 6,
      },
    ],
    dependencies: { collect: [], synthesize: ['collect'] },
  };

  // Speaks the real OpenAI SSE wire format so the strict [DONE]-terminated
  // provider stream contract (network-interruption hardening) is exercised.
  const sseResponse = (res, id, content) => {
    const chunk = (delta) => JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.trunc(Date.now() / 1000), model: 'metis-recovery-loopback', choices: [{ index: 0, delta, finish_reason: null }] });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('data: ' + chunk({ role: 'assistant', content: '' }) + String.fromCharCode(10));
    res.write('data: ' + chunk({ content }) + String.fromCharCode(10));
    res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.trunc(Date.now() / 1000), model: 'metis-recovery-loopback', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + String.fromCharCode(10));
    res.write('data: [DONE]' + String.fromCharCode(10));
    res.end();
  };
  const response = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/control/status') {
      return response(res, 200, {
        blocked: state.blocked,
        blockNextExecution: state.blockNextExecution,
        executionCalls: state.executionCalls,
        planningCalls: state.planningCalls,
      });
    }
    if (req.method === 'POST' && url.pathname === '/control/block') {
      state.blockNextExecution = true;
      state.blocked = false;
      return response(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/control/release') {
      state.blocked = false;
      state.release?.();
      state.release = null;
      return response(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return response(res, 200, { data: [{ id: 'metis-recovery-loopback', context_window: 128000, modalities: ['text'] }] });
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') return response(res, 404, { error: 'not_found' });

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return response(res, 400, { error: 'invalid_json' }); }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const systemText = messages.filter((m) => m?.role === 'system').map((m) => String(m.content ?? '')).join('\n');
    if (systemText.includes('planning assistant')) {
      state.planningCalls += 1;
      const content = JSON.stringify(workflow);
      if (body.stream === true) return sseResponse(res, `plan-${Date.now()}`, content);
      return response(res, 200, {
        id: `plan-${Date.now()}`, object: 'chat.completion', created: Math.trunc(Date.now() / 1000), model: 'metis-recovery-loopback',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 80, total_tokens: 100 },
      });
    }

    state.executionCalls += 1;
    if (state.blockNextExecution) {
      state.blockNextExecution = false;
      state.blocked = true;
      await new Promise((resolve) => { state.release = resolve; });
    }
    const executionContent = `Recovery checkpoint output ${state.executionCalls}.`;
    if (body.stream === true) return sseResponse(res, `execution-${Date.now()}`, executionContent);
    return response(res, 200, {
      id: `execution-${Date.now()}`, object: 'chat.completion', created: Math.trunc(Date.now() / 1000), model: 'metis-recovery-loopback',
      choices: [{ index: 0, message: { role: 'assistant', content: executionContent }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback Provider did not bind');
  return { server, state, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

async function postControl(baseUrl, operation) {
  await fetch(`${baseUrl.replace(/\/v1$/u, '')}/control/${operation}`, { method: 'POST' });
}

async function getControl(baseUrl) {
  return fetch(`${baseUrl.replace(/\/v1$/u, '')}/control/status`).then((res) => res.json());
}

async function waitForControl(baseUrl, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await getControl(baseUrl);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for Provider control state: ${JSON.stringify(last)}`);
}

function runChild(phase, profileDir, baseUrl, reportPath) {
  const electronBinary = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary, [__filename], {
      cwd: ROOT,
      env: {
        ...process.env,
        METIS_RECOVERY_CHILD: '1',
        METIS_RECOVERY_PHASE: phase,
        METIS_RECOVERY_PROFILE: profileDir,
        METIS_RECOVERY_PROVIDER: baseUrl,
        METIS_RECOVERY_REPORT: reportPath,
        METIS_BACKGROUND_AUDIT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function runOrchestrator() {
  const profileDir = tempDir('metis-goal-recovery-profile-');
  const artifactDir = tempDir('metis-goal-recovery-reports-');
  const provider = await startProvider();
  const phaseReports = {};
  const result = {
    runner: RUNNER,
    status: 'starting',
    scope: 'real-BrowserWindow-preload-main-IPC-isolated-profile',
    provider: 'deterministic-loopback-controlled-not-external',
    profileDir,
    phases: phaseReports,
    assertions: [],
  };
  const check = (name, ok, detail) => {
    result.assertions.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
    return ok;
  };
  try {
    const phase1Path = path.join(artifactDir, 'phase-1.json');
    const phase1 = await runChild('phase-1', profileDir, provider.baseUrl, phase1Path);
    if (fs.existsSync(phase1Path)) phaseReports.phase1 = JSON.parse(fs.readFileSync(phase1Path, 'utf8'));
    check('phase-1 child exits cleanly', phase1.code === 0, { code: phase1.code, stderr: phase1.stderr.slice(-1_000) });
    const phase2Path = path.join(artifactDir, 'phase-2.json');
    const phase2 = await runChild('phase-2', profileDir, provider.baseUrl, phase2Path);
    if (fs.existsSync(phase2Path)) phaseReports.phase2 = JSON.parse(fs.readFileSync(phase2Path, 'utf8'));
    check('phase-2 child exits cleanly', phase2.code === 0, { code: phase2.code, stderr: phase2.stderr.slice(-1_000) });
    result.providerCalls = provider.state.executionCalls;
    result.planningCalls = provider.state.planningCalls;
    result.status = result.assertions.every((entry) => entry.ok)
      && Object.values(phaseReports).every((phase) => phase.status === 'passed')
      ? 'passed'
      : 'failed';
    jsonFile(path.join(ROOT, 'logs', 'electron-goal-recovery-e2e-20260821.json'), result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.status === 'passed' ? 0 : 1;
  } finally {
    await new Promise((resolve) => provider.server.close(resolve));
    if (process.env.METIS_RECOVERY_KEEP_ARTIFACTS !== '1') {
      fs.rmSync(profileDir, { recursive: true, force: true });
      fs.rmSync(artifactDir, { recursive: true, force: true });
    }
  }
  // 本脚本以 Electron 二进制运行：只设 exitCode 不会退出主进程，门禁编排
  // 会等到超时误判失败。清理完成后必须显式退出。
  process.exit(process.exitCode ?? 0);
}

async function childMain() {
  const { app, BrowserWindow } = require('electron');
  const profileDir = process.env.METIS_RECOVERY_PROFILE;
  const baseUrl = process.env.METIS_RECOVERY_PROVIDER;
  const reportPath = process.env.METIS_RECOVERY_REPORT;
  const phase = process.env.METIS_RECOVERY_PHASE;
  if (!profileDir || !baseUrl || !reportPath || (phase !== 'phase-1' && phase !== 'phase-2')) throw new Error('Recovery child environment is incomplete');
  app.setName('METIS Goal Recovery E2E');
  app.setPath('userData', profileDir);
  process.env.METIS_BACKGROUND_AUDIT = '1';
  const report = { runner: RUNNER, phase, status: 'starting', assertions: [], calls: [] };
  const check = (name, ok, detail) => {
    report.assertions.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
    if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`);
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const run = (expression) => win.webContents.executeJavaScript(`(async()=>(${expression}))()`);
  const waitFor = async (expression, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    let value;
    while (Date.now() < deadline) {
      value = await run(expression);
      if (value) return value;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for renderer expression: ${expression}`);
  };
  let win;
  try {
    await import('../dist-electron/electron/main.js');
    await app.whenReady();
    for (let i = 0; i < 100 && !win; i += 1) {
      win = BrowserWindow.getAllWindows()[0];
      if (!win) await sleep(100);
    }
    if (!win) throw new Error('main BrowserWindow was not created');
    if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    await waitFor('window.metis?.startupStatus?.().then((value)=>value?.ready)', 25_000);

    if (phase === 'phase-1') {
      const operation = `recovery-${Date.now()}`;
      const probe = await run(`window.metis.setupProbe({version:1,operationId:${JSON.stringify(`${operation}-probe`)},keyMode:'replace',baseUrl:${JSON.stringify(baseUrl)},model:'metis-recovery-loopback',newApiKey:'loopback-recovery-key'})`);
      check('isolated provider probe succeeds', probe?.success === true, probe);
      const saved = await run(`window.metis.setupSave({version:1,operationId:${JSON.stringify(`${operation}-save`)},expectedConfigVersion:${Number(probe.configVersion)},probeId:${JSON.stringify(probe.probeId)}})`);
      check('isolated provider save succeeds', saved?.success === true, saved);
      await win.reload();
      if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
      await waitFor('window.metis?.startupStatus?.().then((value)=>value?.ready)', 25_000);

      const goalA = await run(`window.metis.createGoal('Browser recovery cancel drill A','Pause, resume, then cancel in flight.','project-recovery-drill')`);
      check('Goal A created', goalA?.success === true, goalA);
      const planA = await run(`window.metis.generatePlan(${JSON.stringify(goalA.goalId)})`);
      check('Goal A planned', planA?.success === true && planA.steps?.length === 2, planA);
      await postControl(baseUrl, 'block');
      const executeA = run(`window.metis.executeGoal(${JSON.stringify(goalA.goalId)})`);
      const earlyA = await Promise.race([
        executeA.then((value) => ({ settled: 'resolved', value }), (error) => ({ settled: 'rejected', message: String(error).slice(0, 500) })),
        new Promise((resolve) => setTimeout(() => resolve({ settled: 'pending' }), 5_000)),
      ]);
      check('Goal A execution is in flight', earlyA.settled === 'pending', earlyA);
      await waitForControl(baseUrl, (state) => state.blocked === true);
      const pauseA = await run(`window.metis.pauseGoal(${JSON.stringify(goalA.goalId)})`);
      check('Goal A pause request accepted', pauseA?.success === true, pauseA);
      await postControl(baseUrl, 'release');
      const pausedA = await executeA;
      check('Goal A reaches persisted paused boundary', pausedA?.code === 'paused', pausedA);
      const summaryPausedA = await run(`window.metis.getGoal(${JSON.stringify(goalA.goalId)})`);
      check('Goal A renderer sees paused status', summaryPausedA?.goal?.status === 'paused', summaryPausedA);

      await postControl(baseUrl, 'block');
      const resumeA = run(`window.metis.resumeGoal(${JSON.stringify(goalA.goalId)})`);
      await waitForControl(baseUrl, (state) => state.blocked === true);
      const cancelA = await run(`window.metis.cancelGoal(${JSON.stringify(goalA.goalId)})`);
      check('Goal A in-flight cancel accepted', cancelA?.success === true, cancelA);
      await postControl(baseUrl, 'release');
      const cancelledA = await resumeA;
      check('Goal A remains terminally cancelled after late provider result', cancelledA?.code === 'cancelled', cancelledA);
      const summaryCancelledA = await run(`window.metis.getGoal(${JSON.stringify(goalA.goalId)})`);
      check('Goal A is cancelled and not archived as completed', summaryCancelledA?.goal?.status === 'cancelled', summaryCancelledA);

      const goalB = await run(`window.metis.createGoal('Browser recovery restart drill B','Pause and verify status after relaunch.','project-recovery-drill')`);
      check('Goal B created', goalB?.success === true, goalB);
      const planB = await run(`window.metis.generatePlan(${JSON.stringify(goalB.goalId)})`);
      check('Goal B planned', planB?.success === true && planB.steps?.length === 2, planB);
      await postControl(baseUrl, 'block');
      const executeB = run(`window.metis.executeGoal(${JSON.stringify(goalB.goalId)})`);
      await waitForControl(baseUrl, (state) => state.blocked === true);
      const pauseB = await run(`window.metis.pauseGoal(${JSON.stringify(goalB.goalId)})`);
      check('Goal B pause request accepted', pauseB?.success === true, pauseB);
      await postControl(baseUrl, 'release');
      const pausedB = await executeB;
      check('Goal B reaches paused checkpoint before relaunch', pausedB?.code === 'paused', pausedB);
      const listBeforeExit = await run('window.metis.listGoals()');
      check('Both statuses are durable before relaunch', listBeforeExit?.goals?.some((item) => item.goalId === goalA.goalId && item.status === 'cancelled') && listBeforeExit?.goals?.some((item) => item.goalId === goalB.goalId && item.status === 'paused'), listBeforeExit);
      report.goalA = goalA.goalId;
      report.goalB = goalB.goalId;
      report.calls.push({ operation: 'pause-resume-cancel', cancelledA: cancelledA?.code, pausedB: pausedB?.code });
    } else {
      const listAfterRestart = await run('window.metis.listGoals()');
      const goalA = listAfterRestart?.goals?.find((item) => item.label === 'Browser recovery cancel drill A');
      const goalB = listAfterRestart?.goals?.find((item) => item.label === 'Browser recovery restart drill B');
      check('Goal A survives relaunch as cancelled', goalA?.status === 'cancelled', listAfterRestart);
      check('Goal B survives relaunch as paused', goalB?.status === 'paused', listAfterRestart);
      const workflowB = await run(`window.metis.getGoalWorkflow(${JSON.stringify(goalB?.goalId ?? '')})`);
      check('Goal B exposes a resumable persisted checkpoint after relaunch', workflowB?.success === true
        && workflowB.stepResults?.collect?.status === 'completed'
        && workflowB.stepResults?.synthesize?.status === 'pending', workflowB);
      const resumeB = await run(`window.metis.resumeGoal(${JSON.stringify(goalB?.goalId ?? '')})`);
      check('Goal B resumes from persisted checkpoint after relaunch', resumeB?.success === true && resumeB.code === 'completed', resumeB);
      const finalB = await run(`window.metis.getGoal(${JSON.stringify(goalB?.goalId ?? '')})`);
      check('Goal B completes after relaunch resume', finalB?.goal?.status === 'completed', finalB);
      const archivesAfterResume = await run('window.metis.listArchives()');
      check('Goal B completion is archived after relaunch resume', Array.isArray(archivesAfterResume)
        && archivesAfterResume.some((item) => item?.goal?.id === goalB?.goalId), archivesAfterResume);
      const cancelledResume = await run(`window.metis.resumeGoal(${JSON.stringify(goalA?.goalId ?? '')})`);
      check('Cancelled Goal A cannot be resumed after relaunch', cancelledResume?.success === false
        && cancelledResume.code === 'goal_execution_unavailable', cancelledResume);
      report.goalA = goalA?.goalId;
      report.goalB = goalB?.goalId;
    }
    report.status = report.assertions.every((entry) => entry.ok) ? 'passed' : 'failed';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  } finally {
    jsonFile(reportPath, report);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(report.status === 'passed' ? 0 : 1);
  }
}

if (process.env.METIS_RECOVERY_CHILD === '1') {
  void childMain();
} else {
  void runOrchestrator();
}
