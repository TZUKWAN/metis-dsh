/**
 * Upstream guard negative-test matrix.
 *
 * For each mutation, clone the checkout into a temp directory, apply the
 * mutation, run check-dsh-untouched.mjs, and assert the expected verdict.
 * Cases:
 *   1. legal metis/** modification  → guard PASS
 *   2. illegal DSH source edit      → guard FAIL
 *   3. DSH file mode change         → guard FAIL
 *   4. new file inside DSH tree     → guard FAIL
 *   5. deleted DSH file             → guard FAIL
 *
 * Usage: node metis/scripts/verify-guard-negative.mjs
 */

import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const METIS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECKOUT_ROOT = path.resolve(METIS_ROOT, '..')
const shell = process.platform === 'win32'

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe', shell })
}

function runGuard(cwd) {
  try {
    const out = execFileSync('node', ['metis/scripts/check-dsh-untouched.mjs'], { cwd, encoding: 'utf8', shell })
    return { pass: true, out }
  } catch (error) {
    return { pass: false, out: String(error.stdout ?? '') + String(error.stderr ?? '') }
  }
}

const cases = [
  {
    name: 'legal metis/** modification → PASS',
    apply: (clone) => { writeFileSync(path.join(clone, 'metis', 'docs', 'GUARD_NEGATIVE_TEST.md'), 'temporary\n', 'utf8') },
    expectPass: true,
    cleanup: (clone) => { try { unlinkSync(path.join(clone, 'metis', 'docs', 'GUARD_NEGATIVE_TEST.md')) } catch {} },
  },
  {
    name: 'illegal DSH source edit → FAIL',
    apply: (clone) => { writeFileSync(path.join(clone, 'packages', 'core', 'tools', 'src', 'index.ts'), '// mutated\n', 'utf8') },
    expectPass: false,
    cleanup: (clone) => { git(clone, 'checkout', '--', 'packages/core/tools/src/index.ts') },
  },
  {
    name: 'DSH file mode change → FAIL',
    apply: (clone) => {
      const target = path.join(clone, 'scripts', 'check-expected-filenames.sh')
      chmodSync(target, 0o644)
      git(clone, 'update-index', '--chmod=-x', 'scripts/check-expected-filenames.sh')
    },
    expectPass: false,
    cleanup: (clone) => { git(clone, 'reset', '--', 'scripts/check-expected-filenames.sh') },
  },
  {
    name: 'new file inside DSH tree → FAIL',
    apply: (clone) => { writeFileSync(path.join(clone, 'packages', 'core', 'tools', 'src', 'rogue-file.ts'), 'rogue\n', 'utf8') },
    expectPass: false,
    cleanup: (clone) => { try { unlinkSync(path.join(clone, 'packages', 'core', 'tools', 'src', 'rogue-file.ts')) } catch {} },
  },
  {
    name: 'deleted DSH file → FAIL',
    apply: (clone) => { unlinkSync(path.join(clone, 'scripts', 'check-expected-filenames.sh')) },
    expectPass: false,
    cleanup: (clone) => { git(clone, 'checkout', '--', 'scripts/check-expected-filenames.sh') },
  },
]

const clone = path.join(os.tmpdir(), `metis-guard-negative-${Date.now()}`)
try {
  execFileSync('git', ['clone', '-q', CHECKOUT_ROOT, clone], { stdio: 'pipe', shell })
  let failures = 0
  for (const item of cases) {
    let outcome
    try {
      item.apply(clone)
      outcome = runGuard(clone)
    } finally {
      try { item.cleanup(clone) } catch (error) { console.error(`cleanup failed for "${item.name}":`, error.message) }
    }
    const ok = outcome.pass === item.expectPass
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${item.name} (guard ${outcome.pass ? 'PASS' : 'FAIL'})`)
    if (!ok) {
      failures += 1
      console.log(outcome.out.split('\n').slice(0, 6).join('\n'))
    }
  }
  if (failures > 0) {
    console.error(`[guard-negative] ${failures} case(s) behaved unexpectedly`)
    process.exit(1)
  }
  console.log('[guard-negative] all 5 cases behaved as expected')
} finally {
  rmSync(clone, { recursive: true, force: true })
}
