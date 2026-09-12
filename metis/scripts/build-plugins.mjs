/**
 * Build every METIS plugin to a self-contained ESM bundle in dist/.
 *
 * Distribution contract: the bundle includes all METIS-local sources (plugin
 * code, shared/data, shared/funding) so a packed tarball has no METIS-internal
 * dependencies. Everything the DeepSeek Harness host provides stays external:
 * @deepseek-ai/* services, the dsh-metis-literature contract package (provider
 * plugins import it and the host composition supplies it), node builtins, and
 * zod (already a DSH runtime dependency).
 *
 * Usage: node scripts/build-plugins.mjs
 */

import { existsSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const METIS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_DIR = path.join(METIS_ROOT, 'plugins')

const EXTERNAL = [
  '@deepseek-ai/*',
  'dsh-metis-literature',
  'zod',
  'node:*',
]

const pluginNames = readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .filter((entry) => existsSync(path.join(PLUGINS_DIR, entry.name, 'src', 'index.ts')))
  .map((entry) => entry.name)
  .sort()

let failed = 0
for (const name of pluginNames) {
  const pluginDir = path.join(PLUGINS_DIR, name)
  const entry = path.join(pluginDir, 'src', 'index.ts')
  const outdir = path.join(pluginDir, 'dist')
  rmSync(outdir, { recursive: true, force: true })
  try {
    await build({
      entryPoints: [entry],
      outfile: path.join(outdir, 'index.js'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      external: EXTERNAL,
      sourcemap: 'external',
      legalComments: 'none',
      logLevel: 'warning',
    })
    console.log(`[build-plugins] ${name} -> dist/index.js`)
  } catch (error) {
    failed += 1
    console.error(`[build-plugins] ${name} FAILED:`, error.message)
  }
}

if (failed > 0) {
  console.error(`[build-plugins] ${failed} plugin(s) failed`)
  process.exit(1)
}
console.log(`[build-plugins] ${pluginNames.length} plugins built`)
