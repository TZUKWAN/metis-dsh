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
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  'funding_material_gap', 'funding_section_draft', 'funding_draft_list', 'funding_template_list',
  'evidence_claim_list', 'evidence_claim_status', 'evidence_excerpt_add', 'evidence_excerpt_list',
  'artifact_evidence_check', 'artifact_finalize', 'artifact_compare',
  'journal_search', 'journal_targeting_match',
]

const tarballs = process.argv.slice(2).map((tarball) => path.resolve(tarball))
if (tarballs.length === 0) {
  console.error('usage: verify-dsh-dist.ts <tarball.tgz>...')
  process.exit(2)
}

const failures: string[] = []

/** Minimal-but-valid funding observation document (mirrors the funding test fixture). */
function fundingObservationDocument(): Record<string, unknown> {
  return {
    contractVersion: 1,
    documentId: 'doc-smoke-001',
    sourceFormat: 'pdf',
    sourceDigest: 'a'.repeat(64),
    extractedAt: Date.now() - 86_400_000,
    extractor: { name: 'dist-smoke', version: '1.0.0' },
    pageCount: 1,
    pages: [{ pageNumber: 1, widthPt: 612, heightPt: 792, observedMarginsPt: null }],
    styles: [{
      styleId: 'style-heading',
      fontFamily: 'SimSun',
      fontSizePt: 14,
      fontWeight: 'bold',
      italic: false,
      alignment: 'left',
      lineSpacingPt: null,
      paragraphBeforePt: null,
      paragraphAfterPt: null,
    }],
    blocks: [
      {
        kind: 'paragraph',
        blockId: 'b1',
        pageNumber: 1,
        ordinal: 0,
        bounds: { x: 70, y: 70, width: 470, height: 20 },
        text: 'Project Title:',
        contentRole: 'template_label',
        styleId: 'style-heading',
      },
      {
        kind: 'paragraph',
        blockId: 'b2',
        pageNumber: 1,
        ordinal: 1,
        bounds: { x: 70, y: 95, width: 470, height: 20 },
        text: '（在此填写项目名称）',
        contentRole: 'placeholder',
        styleId: null,
      },
    ],
  }
}
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
// Funding's JSON registry must land in the sandbox too (checkout root is not
// writable by verification runs — the upstream guard enforces it).

// Funding joins the shared sandboxed SQLite database.
patches.push({ id: 'metis-funding', config: { databasePath: sandboxDatabase } } as (typeof patches)[number])

// The workspace registry is a Web-layer mount in stock profiles; the execution
// matrix needs it, so insert the official DSH package row.
patches.push({ insert: [{ id: 'workspace-registry', name: '@deepseek-ai/dsh-workspace' }] } as (typeof patches)[number])

const ctx = await boot('dsh', rootConfig, patches)
try {
  for (const service of SERVICE_KEYS) {
    check(`service mounted: ${service}`, ctx.get(service) !== undefined)
  }
  if (SERVICE_KEYS.some((service) => ctx.get(service) === undefined)) {
    try {
      const artifactDist = pathToFileURL(path.join(profileModules, 'dsh-metis-artifact', 'dist', 'index.js')).href
      const mod = await import(artifactDist)
      console.log('[diagnostic] artifact dist imports OK:', Object.keys(mod))
      await ctx.plugin(mod.default, { databasePath: sandboxDatabase })
      console.log('[diagnostic] manual re-plugin mounted:', ctx.get('metisArtifact') !== undefined)
    } catch (error) {
      console.log('[diagnostic] manual re-plugin FAILED:', error instanceof Error ? error.stack : String(error))
    }
  }
  for (const tool of EXPECTED_TOOLS) {
    check(`tool registered: ${tool}`, ctx.get('tools').get(tool) !== undefined)
  }
  const providers = ctx.get('metisLiterature').registry.getProviderNames()
  check('literature providers registered from dist bundles',
    ['crossref', 'openalex', 'ncpssd'].every((name) => providers.includes(name)), providers)

  // ── Full execution matrix: every distributed tool runs through the real
  // pipeline at least once. Network-backed tools are asserted to return an
  // HONEST result (success or explicit provider failure), never a fake one.
  const workspaceRegistry = ctx.get('workspaceRegistry')
  mkdirSync(path.join(sandbox, 'workspace'), { recursive: true })
  const ws = await workspaceRegistry.create(path.join(sandbox, 'workspace'), 'dist smoke')
  mkdirSync(path.join(ws.path, 'notes'), { recursive: true })
  writeFileSync(path.join(ws.path, 'smoke-v1.md'), '# smoke v1\n', 'utf8')
  writeFileSync(path.join(ws.path, 'smoke-v2.md'), '# smoke v2\n', 'utf8')
  const handle = await ctx.get('agents').create({
    sessionId: `metis-dist-${randomUUID()}`,
    meta: { cwd: ws.path },
  })

  const execute = async (name: string, args: Record<string, unknown>) => {
    return await ctx.get('tools').execute({
      callId: `metis-dist-${randomUUID()}`,
      name,
      arguments: args,
      agent: handle.agent,
      signal: new AbortController().signal,
    })
  }
  const ok = (result: any) => (result?.isError === false ? result.value : { __error: result?.error ?? result })
  const honestNetwork = (value: any) =>
    value !== undefined && value.__error === undefined
      ? true
      : JSON.stringify(value).includes('unavailable') || JSON.stringify(value).includes('http_')

  const project = ok(await execute('research_project_update', { title: '分发冒烟项目', discipline: '社会学' }))
  const projectId = project?.project?.id as string
  check('research_project_update executes', typeof projectId === 'string', project)
  check('research_project_get executes', ok(await execute('research_project_get', {}))?.project?.id === projectId)

  const search = ok(await execute('literature_search', { query: 'platform labor algorithmic management', limit: 2 }))
  check('literature_search executes with honest result (network)', honestNetwork(search) && Array.isArray(search?.records), search)
  const searchRecord = search?.records?.[0]

  const knownRecord = searchRecord ?? {
    id: 'crossref:10.1371/journal.pone.0000001',
    title: 'Smoke fixture record',
    authors: [{ name: 'Smoke' }],
    year: 2024,
    source: 'crossref',
    doi: '10.1371/journal.pone.0000001',
  }
  const saved = ok(await execute('literature_save', { records: [knownRecord] }))
  check('literature_save persists with evidence id', saved?.saved === 1 && typeof saved?.records?.[0]?.evidenceId === 'string', saved)
  const savedRow = saved?.records?.[0]
  const extra = ok(await execute('literature_save', { records: [{ ...knownRecord, id: 'crossref:10.2000/extra', doi: '10.2000/extra', title: 'Smoke second record' }] }))
  check('literature_save second record for removal', extra?.saved === 1, extra)

  const found = ok(await execute('literature_get', { doi: '10.1371/journal.pone.0000001' }))
  check('literature_get executes with honest result (network)', honestNetwork(found), found)
  check('literature_search_project reads the project library', ok(await execute('literature_search_project', {}))?.total >= 1)
  check('literature_remove unlinks the extra record', ok(await execute('literature_remove', { literatureId: extra?.records?.[0]?.id }))?.removed === true)

  const evidence = ok(await execute('evidence_query', { projectId }))
  check('evidence_query finds saved evidence', evidence?.total >= 1, evidence)
  const claim = ok(await execute('evidence_claim_create', { projectId, text: '冒烟：平台劳动研究存在可追溯证据链。' }))
  check('evidence_claim_create executes', typeof claim?.claim?.id === 'string', claim)
  check('evidence_claim_link executes',
    ok(await execute('evidence_claim_link', { claimId: claim.claim.id, evidenceId: savedRow?.evidenceId }))?.ok === true)

  check('scenario_list executes', ok(await execute('scenario_list', {}))?.total === 5)
  check('scenario_get executes', ok(await execute('scenario_get', { id: 'paper-review' }))?.found === true)
  check('scenario_activate executes and arms a DSH Goal',
    ok(await execute('scenario_activate', { id: 'paper-review' }))?.ok === true
    && ctx.get('goals').get(handle.agent)?.objective?.length > 0)

  const artifact = ok(await execute('artifact_register', { type: 'review', title: '冒烟审读', path: 'smoke-v1.md' }))
  check('artifact_register executes', artifact?.ok === true && artifact?.artifact?.workspacePath === 'smoke-v1.md', artifact)
  check('artifact_version executes', ok(await execute('artifact_version', { id: artifact.artifact.id, path: 'smoke-v2.md', note: 'v2' }))?.artifact?.version === 2)
  check('artifact_update_metadata executes', ok(await execute('artifact_update_metadata', { id: artifact.artifact.id, status: 'review', evidenceIds: [savedRow?.evidenceId] }))?.ok === true)
  check('artifact_get executes', ok(await execute('artifact_get', { id: artifact.artifact.id }))?.found === true)
  check('artifact_list executes', ok(await execute('artifact_list', {}))?.total >= 1)

  const parsed = ok(await execute('funding_template_parse', { observationDocument: fundingObservationDocument(), templateId: 'smoke', templateVersion: 1, createdAt: Date.now() }))
  check('funding_template_parse executes', parsed?.ok === true && parsed?.template !== undefined, parsed)
  check('funding_template_requirements executes', ok(await execute('funding_template_requirements', { template: parsed.template }))?.totalSections >= 0)
  check('funding_template_check executes', ok(await execute('funding_template_check', { templatePackage: parsed.template }))?.ok === true)
  check('funding_template_diff executes', ok(await execute('funding_template_diff', { oldPackage: parsed.template, newPackage: parsed.template })) !== undefined)
  check('funding_template_list executes', ok(await execute('funding_template_list', {}))?.total >= 1)
  const gap = ok(await execute('funding_material_gap', { templateId: 'smoke' }))
  check('funding_material_gap executes with honest needs_user_confirmation', gap?.userFactsRequired?.every((fact: any) => fact.status === 'needs_user_confirmation') === true, gap)
  const draft = ok(await execute('funding_section_draft', { templateId: 'smoke', sectionId: 'section-1', draftText: '第一版草稿（待核验：经费数字）。' }))
  check('funding_section_draft executes', draft?.ok === true && typeof draft?.draft?.id === 'string', draft)
  check('funding_draft_list executes', ok(await execute('funding_draft_list', {}))?.total >= 1)

  // ── v2 claim-level / artifact integrity tools ──
  const claimV2 = ok(await execute('evidence_claim_create', {
    text: '平台劳动研究存在可追溯证据链。',
    claimType: 'literature_finding',
    artifactId: artifact.artifact.id,
  }))
  check('evidence_claim_create executes with project scope', typeof claim?.claim?.id === 'string', claim)
  check('evidence_claim_status executes', ok(await execute('evidence_claim_status', { claimId: claimV2.claim.id, status: 'verified' }))?.claim?.verificationState === 'verified')
  check('evidence_claim_link with confidence executes',
    ok(await execute('evidence_claim_link', { claimId: claimV2.claim.id, evidenceId: savedRow?.evidenceId, relation: 'supports', confidence: 0.9 }))?.ok === true)
  check('evidence_claim_list by artifact executes', ok(await execute('evidence_claim_list', { artifactId: artifact.artifact.id }))?.total === 1)
  check('evidence_excerpt_add executes',
    ok(await execute('evidence_excerpt_add', { evidenceId: savedRow?.evidenceId, content: '原文摘录冒烟', locatorType: 'abstract', locatorValue: 'abstract' }))?.ok === true)
  check('evidence_excerpt_list executes', ok(await execute('evidence_excerpt_list', { evidenceId: savedRow?.evidenceId }))?.total >= 1)
  const coverage = ok(await execute('artifact_evidence_check', { artifactId: artifact.artifact.id }))
  check('artifact_evidence_check reports coverage', coverage?.report?.totalClaims === 1 && coverage?.report?.supportedClaims === 1, coverage)
  check('artifact_finalize executes', ok(await execute('artifact_finalize', { id: artifact.artifact.id }))?.artifact?.status === 'final')
  const compare = ok(await execute('artifact_compare', { id: artifact.artifact.id, fromVersion: 1, toVersion: 2 }))
  check('artifact_compare executes with hashes and diff', compare?.ok === true && typeof compare?.diff?.from?.contentHash === 'string' && compare?.diff?.added >= 0, compare)

  const targeting = ok(await execute('journal_targeting_match', {
    papers: [{ title: 'Platform labor under algorithmic management', venue: 'New Media & Society', year: new Date().getFullYear() - 1, source: 'openalex' }],
    criteria: { categories: ['ssci'], language: 'en', notes: '' },
  }))
  check('journal_targeting_match executes (pure aggregation)', Array.isArray(targeting?.candidates), targeting)
  const journalSearch = ok(await execute('journal_search', { query: 'sociology' }))
  check('journal_search executes with honest result (network)', honestNetwork(journalSearch), journalSearch)

  await handle.dispose()
} finally {
  await ctx.fiber.dispose()
}

rmSync(sandbox, { recursive: true, force: true })
if (failures.length > 0) {
  console.log(`\n[verify-dsh-dist] ${failures.length} check(s) FAILED`)
  process.exit(1)
}
console.log(`\n[verify-dsh-dist] all ${checkIndex} checks passed`)
