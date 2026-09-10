import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Node-side vitest config for running under Electron's embedded Node:
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
 *     node_modules/vitest/vitest.mjs run --config vitest.electron-node.config.ts <files>
 *
 * better-sqlite3 in this workspace is compiled against the Electron ABI so the
 * app can run; `npm run rebuild:node` would flip the shared native module and
 * break any Electron instance that is currently running. Electron's embedded
 * Node loads the module as-is, but the root vitest.config.ts injects
 * `--no-webstorage` into NODE_OPTIONS (a Node >= 25 jsdom workaround) and
 * Electron's Node (v24) rejects that flag in forked workers. This config
 * mirrors the root `node` project without that injection.
 */
export default defineConfig({
  root: __dirname,
  test: {
    globals: true,
    environment: 'node',
    include: [
      'engine/**/*.test.ts',
      'tests/{engine,electron,e2e,security,integration,scripts,utils,evals,conversation}/**/*.test.{ts,tsx}',
      'electron/ScenarioLoopRunTracker.test.ts',
      'electron/RuntimeShutdownCoordinator.test.ts',
    ],
    // `*.electron.test.ts` suites launch a real Electron runtime (BrowserWindow /
    // WebContentsView) and are run separately via `npm run test:electron`.
    exclude: ['**/*.electron.test.ts', '**/node_modules/**'],
    pool: 'forks',
    isolate: true,
    fileParallelism: true,
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@engine': path.resolve(__dirname, './engine'),
    },
  },
});
