/**
 * 任务1（§十三）：真实 Electron + 老数据库 fixture 端到端验收。
 *
 * 模式：以隔离 profile 启动真实的打包主进程（dist-electron/electron/main.js），
 * 数据目录预置 old-baseline 形状的 metis.db（只含最初版表、无任何迁移列），
 * 断言真实 Electron 进程内完成：baseline + versioned migrations + 健康检查，
 * 且老数据完整可读。第二次启动必须幂等（零迁移）。
 *
 * Run with: node scripts/electron-olddb-acceptance.cjs
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** better-sqlite3 的 ABI 与打包运行时一致（Electron）；编排进程是 Node，不能直接加载。
 *  所有 DB 触碰都通过 electron-as-node 子进程执行 db 子脚本完成。 */
function runDbStep(step, dbPath) {
  const electronBinary = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  const result = spawnSync(electronBinary, [path.join(ROOT, 'scripts', 'electron-olddb-acceptance-db.cjs'), step, dbPath], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  const line = (result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
  const parsed = JSON.parse(line);
  if (!parsed.ok) throw new Error(`db step ${step} failed: ${parsed.error}`);
  return parsed;
}

function buildOldBaselineDb(dbPath) {
  // 委托给 electron-as-node 子步骤（见 runDbStep）；此函数不再直接使用。
  runDbStep('build', dbPath);
}

function runElectronChild(profileDir, phase) {
  const electronBinary = path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary, [__filename], {
      cwd: ROOT,
      env: {
        ...process.env,
        METIS_OLDDB_E2E_CHILD: '1',
        METIS_OLDDB_E2E_PROFILE: profileDir,
        METIS_OLDDB_E2E_PHASE: phase,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child timeout')); }, 120_000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (err) => { clearTimeout(timeout); reject(err); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** 真实 Electron 子进程：setPath 隔离 profile → 加载打包主进程 → 等窗口创建 → 汇报。 */
async function childMain() {
  const { app } = require('electron');
  const profileDir = process.env.METIS_OLDDB_E2E_PROFILE;
  const phase = process.env.METIS_OLDDB_E2E_PHASE;
  if (!profileDir || !phase) throw new Error('missing child env');
  app.setName('METIS OldDB E2E');
  app.setPath('userData', profileDir);
  process.env.METIS_BACKGROUND_AUDIT = '1';

  await import('../dist-electron/electron/main.js');
  await app.whenReady();

  // 等主进程完成启动（窗口创建即代表整个 whenReady 管线跑完）。
  const { BrowserWindow } = require('electron');
  const deadline = Date.now() + 45_000;
  let win = null;
  while (Date.now() < deadline) {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    if (wins.length > 0) { win = wins[0]; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const result = { phase, windowCreated: !!win, title: win ? await win.webContents.executeJavaScript('document.title') : null };
  console.log('OLDDB_E2E_RESULT:' + JSON.stringify(result));
  app.exit(win ? 0 : 2);
}

async function main() {
  const profileDir = tempDir('metis-olddb-e2e-profile-');
  const dataDir = path.join(profileDir, 'metis-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'metis.db');
  runDbStep('build', dbPath);

  console.log('[task1-e2e] profile:', profileDir);

  const phase1 = await runElectronChild(profileDir, 'phase-1');
  const phase2 = await runElectronChild(profileDir, 'phase-2');

  // 主进程退出码与 stdout 证据
  const assertions = [];
  const assert = (name, ok, detail) => assertions.push({ name, ok, detail });
  assert('phase-1 window created', phase1.code === 0 && /OLDDB_E2E_RESULT/.test(phase1.stdout), phase1.stdout.match(/OLDDB_E2E_RESULT:(.*)/)?.[1]);
  assert('phase-1 store initialized (无 native 降级)', !/PersistenceStore failed to load/.test(phase1.stdout + phase1.stderr), (phase1.stdout + phase1.stderr).slice(0, 300));
  assert('phase-2 window created (reopen)', phase2.code === 0, phase2.stdout.match(/OLDDB_E2E_RESULT:(.*)/)?.[1]);
  assert('phase-2 store initialized', !/PersistenceStore failed to load/.test(phase2.stdout + phase2.stderr), (phase2.stdout + phase2.stderr).slice(0, 300));

  // 数据库层证据：真实进程跑完后，经 electron-as-node 子步骤读取
  const state = runDbStep('assert', dbPath);
  assert('legacy paper intact after real-Electron migration', state.paperTitle === '旧库验收论文', state.paperTitle);
  assert('legacy memory intact', state.memoryValue === '旧库验收记忆', state.memoryValue);
  assert('legacy message intact', JSON.stringify(state.messages) === JSON.stringify(['旧库验收消息']), JSON.stringify(state.messages));
  assert('migrations applied (>=100)', typeof state.maxVersion === 'number' && state.maxVersion >= 100, String(state.maxVersion));
  assert('global_prompt column present (v113)', state.globalPromptPresent === true, '');
  assert('sessions.project_id present (v106)', state.sessionsProjectIdPresent === true, '');
  assert('phase-2 幂等（仅一次 applied 记录）', state.appliedRuns === 1, String(state.appliedRuns));

  const report = { runner: 'metis-olddb-e2e', status: assertions.every((a) => a.ok) ? 'passed' : 'failed', assertions };
  const logsDir = path.join(ROOT, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const reportPath = path.join(logsDir, `electron-olddb-e2e-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ ...report, phase1Tail: phase1.stdout.slice(-600), phase2Tail: phase2.stdout.slice(-600) }, null, 2), 'utf8');

  for (const a of assertions) console.log(`${a.ok ? 'PASS' : 'FAIL'}  ${a.name}${a.detail ? ' — ' + String(a.detail).slice(0, 160) : ''}`);
  console.log(`[task1-e2e] status: ${report.status}  report: ${reportPath}`);
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.env.METIS_OLDDB_E2E_CHILD === '1') {
  childMain().catch((err) => { console.error('[child] fatal:', err); process.exit(3); });
} else {
  main().catch((err) => { console.error('[task1-e2e] fatal:', err); process.exitCode = 1; });
}
