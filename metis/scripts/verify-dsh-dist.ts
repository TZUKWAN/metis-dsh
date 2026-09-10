/**
 * Distribution gate for the METIS plugin family.
 *
 * Verifies the packed tarballs install into a FRESH DSH profile and boot under
 * the REAL Cordis loader: tarballs are installed with the official
 * `dsh plugin add` flow (pnpm inside the profile + bundle-layer reconcile),
 * then the profile composition is booted exactly like the CLI boots it
 * (bundle layers in dsh.profile.bundles order) and the mounted services,
 * registered tools, literature providers, and one real tool execution are
 * asserted.
 *
 * Usage (from the DeepSeek Harness checkout root):
 *   node --import tsx/esm metis/scripts/verify-dsh-dist.ts <tarball>...
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const METIS_DIR = path.resolve(SCRIPT_DIR, '..')
const CHECKOUT_ROOT = path.resolve(METIS_DIR, '..')

const SERVICE_KEYS = [
  'metisResearch', 'metisEvidence', 'metisLiterature', 'metisScenario', 'metisArtifact',
]

const EXPECTED_TOOLS = [
  'research_project_get', 'research_project_update',
  'literature_search', 'literature_save', 'literature_search_project', 'literature_remove', 'literature_get',
  'evidence_query', 'evidence_claim_create', 'evidence_claim_link',
  'scenario_list', 'scenario_get', 'scenario_activate',
  'artifact_register', 'artifact_list', 'artifact_get', 'artifact_version', 'artifact_update_metadata',
  'funding_template_parse', 'funding_template_requirements', 'funding_template_check', 'funding_template_diff',
  'journal_search', 'journal_targeting_match',
]

const tarballs = process.argv.slice(2).map((tarball) => path.resolve(tarball))
if (tarballs.length === 0) {
  console.error('usage: verify-dsh-dist.ts <tarball.tgz>...')
  process.exit(2)
}

const failures: string[] = []
let checkIndex = 0
function check(name: string, ok: boolean, detail?: unknown): void {
  checkIndex += 1
  const label = `${String(checkIndex).padStart(2, '0')} ${name}`
  if (ok) {
    console.log(`  PASS ${label}`)
    return
  }
  const suffix = detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`
  console.log(`  FAIL ${label}${suffix}`)
  failures.push(`${label}${suffix}`)
}

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'metis-dist-'))
process.env.DSH_HOME = path.join(sandbox, 'dsh-home')
process.env.DSH_PERMISSION_MODE = 'danger-full-access'

const dshBin = path.join(CHECKOUT_ROOT, 'node_modules', '.bin', 'dsh')
const dshCmd = existsSync(dshBin) ? dshBin : 'dsh'
const profileName = 'metis-dist'

console.log(`[verify-dsh-dist] installing ${tarballs.length} tarball(s) via dsh plugin add`)
const add = spawnSync(dshCmd, ['plugin', '--profile', profileName, 'add', ...tarballs], {
  cwd: CHECKOUT_ROOT,
  encoding: 'utf8',
  shell: process.platform === 'win32',
})
if (add.status !== 0) {
  console.error(add.stdout)
  console.error(add.stderr)
  console.error('[verify-dsh-dist] dsh plugin add failed')
  process.exit(1)
}

const profileDir = path.join(process.env.DSH_HOME, 'profiles', profileName)
const profileManifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8')) as {
  dsh?: { profile?: { bundles?: string[] } }
}
const bundles = profileManifest.dsh?.profile?.bundles ?? []
console.log(`[verify-dsh-dist] profile bundles: ${bundles.join(', ')}`)
check('profile carries dsh-base and the ten METIS bundles',
  bundles.includes('@deepseek-ai/dsh-base')
  && ['core', 'evidence', 'literature', 'scenario', 'artifact', 'funding', 'submission', 'literature-crossref', 'literature-openalex', 'literature-ncpssd']
    .every((name) => bundles.some((bundle) => bundle.endsWith(`dsh-metis-${name}`))), bundles)

const { boot, loadOverlayPatches, resolveBundleDir } = await import('../../packages/boot/app-boot/src/index.ts')

// The host owns core DSH services in a real deployment: their published
// packages sit in a node_modules reachable from the installed plugin. This
// checkout mirrors that by junction-linking the three runtime-external host
// packages (cordis, tools, zod — verified against the dist bundles' imports)
// into the profile's node_modules. Everything else resolves from the profile
// itself, including dsh-metis-literature for the provider plugins.
const hostLinks: Array<[string, string]> = [
  ['@deepseek-ai/cordis', path.join(CHECKOUT_ROOT, 'vendor', 'cordis')],
  ['@deepseek-ai/dsh-tools', path.join(CHECKOUT_ROOT, 'packages', 'core', 'tools')],
  ['zod', path.join(METIS_DIR, 'node_modules', 'zod')],
]
const profileModules = path.join(profileDir, 'node_modules')
for (const [name, target] of hostLinks) {
  const linkPath = path.join(profileModules, name)
  if (!existsSync(linkPath)) {
    const { symlinkSync, mkdirSync } = await import('node:fs')
    mkdirSync(path.dirname(linkPath), { recursive: true })
    symlinkSync(target, linkPath, 'junction')
  }
}

const rootConfig = path.join(profileDir, 'cordis.yml')
// The plugin-add flow initializes manifest + deps; the empty patch root is
// written by the launcher at boot time. Same content, same contract.
if (!existsSync(rootConfig)) {
  writeFileSync(rootConfig, '# dsh profile root — an empty entry list. The tree is composed as patches:\n# each bundle in package.json\'s dsh.profile.bundles, then cordis.patch.yml, then any\n# --patch overlays. Edit cordis.patch.yml, not this file.\n[]\n', 'utf8')
}
const patches = bundles.flatMap((bundle) => {
  const dir = resolveBundleDir('dsh', bundle, path.join(CHECKOUT_ROOT, 'apps', 'cli', 'package.json'), profileDir)
  const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
    dsh?: { bundle?: { patch?: string } }
  }
  const patchFile = path.join(dir, manifest.dsh?.bundle?.patch ?? 'cordis.patch.yml')
  return loadOverlayPatches('verify-dsh-dist', patchFile)
})

// Pin every METIS service to one sandboxed SQLite file (bundle patch rows carry
// no config; the default would create metis-data/ in the checkout root).
const sandboxDatabase = path.join(sandbox, 'metis-data', 'metis.db').replaceAll('\\', '/')
for (const id of ['metis-core', 'metis-evidence', 'metis-literature', 'metis-scenario', 'metis-artifact']) {
  patches.push({ id, config: { databasePath: sandboxDatabase } } as (typeof patches)[number])
}

const ctx = await boot('dsh', rootConfig, patches)
try {
  for (const service of SERVICE_KEYS) {
    check(`service mounted: ${service}`, ctx.get(service) !== undefined)
  }
  for (const tool of EXPECTED_TOOLS) {
    check(`tool registered: ${tool}`, ctx.get('tools').get(tool) !== undefined)
  }
  const providers = ctx.get('metisLiterature').registry.getProviderNames()
  check('literature providers registered from dist bundles',
    ['crossref', 'openalex', 'ncpssd'].every((name) => providers.includes(name)), providers)

  const result = await ctx.get('tools').execute({
    callId: 'metis-dist-verify-1',
    name: 'research_project_get',
    arguments: {},
    signal: new AbortController().signal,
  })
  check('dist plugin executes through the real tool pipeline',
    result?.isError === false && result.value?.ok === true, result?.value)
} finally {
  await ctx.fiber.dispose()
}

rmSync(sandbox, { recursive: true, force: true })
if (failures.length > 0) {
  console.log(`\n[verify-dsh-dist] ${failures.length} check(s) FAILED`)
  process.exit(1)
}
console.log(`\n[verify-dsh-dist] all ${checkIndex} checks passed`)
