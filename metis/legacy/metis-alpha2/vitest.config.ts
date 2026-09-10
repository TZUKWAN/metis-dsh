// Node >=25 exposes an experimental Web Storage global whose localStorage
// shadows jsdom's (missing clear/removeItem). When that global exists, the
// flag is needed AND allowed: only Node >=25 accepts --no-webstorage in
// NODE_OPTIONS — Node 22 rejects it outright, killing every forked worker at
// startup ("--no-webstorage is not allowed in NODE_OPTIONS"), which used to
// hang CI for the full 30-minute timeout. Gate the injection on the actual
// runtime capability instead of setting it unconditionally.
// 任务2：METIS_ELECTRON_NODE=1 时用 Electron 内置 Node 直接跑 vitest（避免
// 为系统 Node 重编译被运行中实例锁定的 better_sqlite3.node）；该 Node 不认
// 识 --no-webstorage，注入反而会让所有 worker fork 失败。
import { shouldInjectNoWebstorage } from './scripts/lib/webstorage-flag-policy.mjs';
if (shouldInjectNoWebstorage(process.versions.node, process.env)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--no-webstorage'].filter(Boolean).join(' ');
}

import { defineConfig } from 'vitest/config'
import path from 'path'

/**
 * Vitest projects (vitest 4 integrates workspaces via test.projects):
 *  - node: engine/electron/e2e/security/integration tests — isolated forks,
 *    parallel file execution (no DOM, no cross-file pollution).
 *  - jsdom: frontend tests — serial forks + explicit setup cleanup, keeping
 *    the METIS-004/1001 stability guarantees that fixed the "multiple
 *    elements found" flakiness.
 */
export default defineConfig({
  root: __dirname,
  test: {
    globals: true,
    projects: [
      {
        root: __dirname,
        test: {
          name: 'node',
          globals: true,
          environment: 'node',
          include: [
            'engine/**/*.test.ts',
            'tests/{engine,electron,e2e,security,integration,scripts,utils,evals,conversation}/**/*.test.{ts,tsx}',
            'electron/ScenarioLoopRunTracker.test.ts',
            'electron/RuntimeShutdownCoordinator.test.ts',
          ],
          pool: 'forks',
          isolate: true,
          fileParallelism: true,
          maxWorkers: 4,
          minWorkers: 1,
          // Native-process integration suites can create several real child
          // runtimes while the rest of the fork pool is active. Keep the
          // default timeout honest without mistaking host scheduling pressure
          // for a product timeout.
          testTimeout: 30_000,
          hookTimeout: 30_000,
          coverage: {
            provider: 'v8',
            include: ['engine/**/*.ts', 'src/**/*.{ts,tsx}', 'electron/**/*.ts'],
            exclude: [
              'engine/**/*.test.ts',
              'engine/**/types.ts',
              'src/**/*.test.{ts,tsx}',
              'src/main.tsx',
              'electron/preload.ts',
            ],
          },
        },
        resolve: {
          alias: {
            '@engine': path.resolve(__dirname, './engine'),
          },
        },
      },
      {
        root: __dirname,
        test: {
          name: 'jsdom',
          globals: true,
          environment: 'jsdom',
          include: ['tests/{frontend,lib}/**/*.test.{ts,tsx}'],
          setupFiles: [path.resolve(__dirname, 'tests/frontend/setup.ts')],
          // METIS-004/1001: jsdom files stay serial — each file runs in its
          // own process with a fresh global/document, eliminating cross-file
          // jsdom state pollution. Stability is required over raw speed here.
          pool: 'forks',
          isolate: true,
          fileParallelism: false,
          coverage: {
            provider: 'v8',
            include: ['engine/**/*.ts', 'src/**/*.{ts,tsx}', 'electron/**/*.ts'],
            exclude: [
              'engine/**/*.test.ts',
              'engine/**/types.ts',
              'src/**/*.test.{ts,tsx}',
              'src/main.tsx',
              'electron/preload.ts',
            ],
          },
        },
        resolve: {
          alias: {
            '@engine': path.resolve(__dirname, './engine'),
          },
        },
      },
    ],
  },
  resolve: {
    alias: {
      '@engine': path.resolve(__dirname, './engine'),
    },
  },
})
