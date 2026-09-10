import path from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * METIS 插件家族测试配置（独立于 DSH 根 workspace 配置——
 * 本目录测试不进入 DSH 的 coverage/门禁体系，按插件家族自管）。
 */
export default defineConfig({
  resolve: {
    // 运行时解析到 DSH 构建产物（pnpm build 产出的 lib/index.js）。
    alias: {
      '@deepseek-ai/cordis': path.resolve(import.meta.dirname, '../vendor/cordis/lib/index.js'),
      '@deepseek-ai/dsh-tools': path.resolve(import.meta.dirname, '../packages/core/tools/lib/index.js'),
      '@deepseek-ai/dsh-util-values': path.resolve(import.meta.dirname, '../packages/util/values/lib/index.js'),
      'dsh-metis-literature': path.resolve(import.meta.dirname, './plugins/literature/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'tests/**/*.test.ts',
      'plugins/*/tests/**/*.test.ts',
      'shared/*/tests/**/*.test.ts',
    ],
    testTimeout: 30_000,
  },
})
