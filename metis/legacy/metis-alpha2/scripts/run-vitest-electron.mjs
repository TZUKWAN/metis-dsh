/**
 * Run Vitest under Electron's Node runtime so native modules compiled for
 * Electron can be exercised without rebuilding them for the host Node ABI.
 *
 * Electron injects flags such as --no-webstorage into process.execArgv. Node
 * worker and child-process runtimes reject those flags, so remove
 * Electron-only switches before Vitest creates its worker pool. Electron 41
 * also propagates its private --no-webstorage switch when process.fork
 * launches electron.exe, so worker threads are the reliable default: they
 * remain inside Electron's Node runtime and exercise its native-module ABI.
 */
process.stdout.write(`${JSON.stringify({ runner: 'metis-electron-vitest', status: 'starting', filters: process.argv.slice(2) })}\n`);
process.execArgv = process.execArgv.filter((arg) => arg !== '--no-webstorage');
const sanitizedNodeOptions = (process.env.NODE_OPTIONS ?? '')
  .replace(/(?:^|\s)--no-webstorage(?=\s|$)/gu, ' ')
  .trim();
if (sanitizedNodeOptions) process.env.NODE_OPTIONS = sanitizedNodeOptions;
else delete process.env.NODE_OPTIONS;

const filters = process.argv.slice(2);
if (filters.length === 0) {
  console.error('Usage: electron scripts/run-vitest-electron.mjs <test-file> [...]');
  process.exit(2);
}

// Electron node-mode can terminate before a top-level async test runner keeps
// itself alive. This handle is released in every outcome below.
const keepAlive = setInterval(() => {}, 1_000);

try {
  const { startVitest } = await import('vitest/node');
  const reporter = process.env.METIS_VITEST_REPORTER ?? 'dot';
  const outputFile = process.env.METIS_VITEST_OUTPUT_FILE;
  const context = await startVitest('test', filters, {
    run: true,
    watch: false,
    pool: process.env.METIS_VITEST_POOL ?? 'threads',
    execArgv: [],
    // Vitest snapshots the parent environment per worker. Electron can
    // re-inject --no-webstorage after module startup, so override the worker
    // environment explicitly instead of relying only on deleting the parent
    // variable above.
    env: {
      NODE_OPTIONS: '',
      ELECTRON_RUN_AS_NODE: '1',
    },
    reporters: [reporter],
    ...(outputFile ? { outputFile } : {}),
  });

  if (!context) {
    process.stdout.write(`${JSON.stringify({ runner: 'metis-electron-vitest', status: 'startup_failed' })}\n`);
    process.exitCode = 1;
  } else {
    const files = context.state.getFiles();
    const countTests = (tasks, counts) => tasks.reduce((next, task) => {
      if (task.type === 'test') {
        const state = task.result?.state;
        if (state === 'pass') next.passed += 1;
        if (state === 'fail') next.failed += 1;
      } else if (Array.isArray(task.tasks)) {
        countTests(task.tasks, next);
      }
      return next;
    }, counts);
    const assertionCounts = files.reduce(
      (counts, file) => countTests(file.tasks ?? [], counts),
      { passed: 0, failed: 0 },
    );
    const failed = assertionCounts.failed > 0 || files.some((file) => (
      Array.isArray(file.tasks)
      && file.tasks.some((task) => task.result?.state === 'fail')
    ));
    const unhandled = context.state.getUnhandledErrors().length > 0;
    const passedTests = assertionCounts.passed;
    const failedTests = assertionCounts.failed;
    const status = files.length === 0 || failed || unhandled ? 'failed' : 'passed';
    process.stdout.write(`${JSON.stringify({
      runner: 'metis-electron-vitest',
      status,
      files: files.length,
      passedTests,
      failedTests,
      unhandledErrors: context.state.getUnhandledErrors().length,
    })}\n`);
    if (status !== 'passed') process.exitCode = 1;
    await context.close();
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    runner: 'metis-electron-vitest',
    status: 'failed',
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
} finally {
  clearInterval(keepAlive);
}
