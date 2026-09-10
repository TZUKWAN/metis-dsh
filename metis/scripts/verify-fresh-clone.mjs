/**
 * Fresh-clone upstream integrity check: clone the checkout into a temp
 * directory (no local git objects beyond what the clone carries) and run the
 * upstream guard there. This is the guard's designed scenario: a brand-new
 * clone must be able to prove upstream integrity from the manifest alone.
 *
 * Usage: node metis/scripts/verify-fresh-clone.mjs
 */

import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const METIS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECKOUT_ROOT = path.resolve(METIS_ROOT, '..')
const clone = path.join(os.tmpdir(), `metis-fresh-clone-${Date.now()}`)

try {
  execFileSync('git', ['clone', '-q', CHECKOUT_ROOT, clone], { stdio: 'pipe', shell: process.platform === 'win32' })
  const out = execFileSync('node', ['metis/scripts/check-dsh-untouched.mjs'], {
    cwd: clone, encoding: 'utf8', shell: process.platform === 'win32',
  })
  if (!out.includes('OK: 9080 upstream paths')) {
    throw new Error(`unexpected guard output: ${out.trim()}`)
  }
  console.log(out.trim())
} finally {
  rmSync(clone, { recursive: true, force: true })
}
