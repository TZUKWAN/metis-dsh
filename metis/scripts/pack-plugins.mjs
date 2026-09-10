/**
 * Pack every METIS plugin tarball into dist-tarballs/ (pnpm native pack per filter).
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const METIS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEST = path.join(METIS_ROOT, 'dist-tarballs')
const PLUGINS = [
  'core', 'evidence', 'literature', 'scenario', 'artifact', 'funding', 'submission',
  'literature-crossref', 'literature-openalex', 'literature-ncpssd',
]

rmSync(DEST, { recursive: true, force: true })
mkdirSync(DEST, { recursive: true })
for (const name of PLUGINS) {
  const result = spawnSync('pnpm', [`--filter`, `dsh-metis-${name}`, 'pack', '--pack-destination', DEST], {
    cwd: METIS_ROOT, stdio: 'inherit', shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    console.error(`[pack-plugins] dsh-metis-${name} failed`)
    process.exit(result.status ?? 1)
  }
}
console.log(`[pack-plugins] ${PLUGINS.length} tarballs in ${DEST}`)
