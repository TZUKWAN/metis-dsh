/**
 * Real DSH runtime verification for the METIS plugin family.
 *
 * This script intentionally does NOT use vitest or any test double. It boots the
 * REAL Cordis loader (`boot()` from @deepseek-ai/dsh-app-boot — the same entry
 * the `dsh` CLI uses) with the REAL `@deepseek-ai/dsh-base` bundle patch plus a
 * generated METIS plugin overlay, then drives METIS tools through the real
 * `ctx.tools.execute()` pipeline under a real live agent.
 *
 * Two phases run as two separate processes (a real restart):
 *   setup:  boot → project/literature/evidence/artifact/scenario+Goal → dispose
 *   verify: boot again (same DSH_HOME + metis.db) → assert everything recovered
 *
 * Usage (from the DeepSeek Harness checkout root):
 *   node --import tsx/esm metis/scripts/verify-dsh-runtime.ts setup  <state.json>
 *   node --import tsx/esm metis/scripts/verify-dsh-runtime.ts verify <state.json>
 *
 * Environment owned by the script: DSH_HOME and DSH_PERMISSION_MODE are pinned
 * into a temporary sandbox so the run never touches a real harness home.
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

interface PhaseState {
  home: string
  workspace: string
  databasePath: string
  rootConfig: string
  patchFile: string
  sessionId: string
  projectId?: string
  literatureId?: string
  evidenceId?: string
  artifactId?: string
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const METIS_DIR = path.resolve(SCRIPT_DIR, '..')
const CHECKOUT_ROOT = path.resolve(METIS_DIR, '..')
const BASE_BUNDLE_PATCH = path.join(CHECKOUT_ROOT, 'packages', 'bundle', 'base', 'cordis.patch.yml')

const METIS_PLUGIN_ENTRIES = [
  { id: 'metis-core', source: path.join(METIS_DIR, 'plugins', 'core', 'src', 'index.ts') },
  { id: 'metis-evidence', source: path.join(METIS_DIR, 'plugins', 'evidence', 'src', 'index.ts') },
  { id: 'metis-literature', source: path.join(METIS_DIR, 'plugins', 'literature', 'src', 'index.ts') },
  { id: 'metis-scenario', source: path.join(METIS_DIR, 'plugins', 'scenario', 'src', 'index.ts') },
  { id: 'metis-artifact', source: path.join(METIS_DIR, 'plugins', 'artifact', 'src', 'index.ts') },
]

const LITERATURE_RECORD = {
  id: 'crossref:10.1371/journal.pone.0000001',
  title: 'Neural Substrate of Cold-Seeking Behavior in Endotoxin Shock',
  authors: [{ name: 'Liu Xiaoming' }],
  year: 2024,
  journal: 'PLOS ONE',
  doi: '10.1371/journal.pone.0000001',
  source: 'crossref',
  sourceId: 'crossref-work-1',
}

class Checker {
  readonly failures: string[] = []
  private index = 0

  check(name: string, ok: boolean, detail?: unknown): void {
    this.index += 1
    const label = `${String(this.index).padStart(2, '0')} ${name}`
    if (ok) {
      console.log(`  PASS ${label}`)
      return
    }
    const suffix = detail === undefined ? '' : ` :: ${JSON.stringify(detail)}`
    console.log(`  FAIL ${label}${suffix}`)
    this.failures.push(`${label}${suffix}`)
  }

  finish(phase: string): never {
    if (this.failures.length > 0) {
      console.log(`\n[verify-dsh-runtime] ${phase}: ${this.failures.length} check(s) FAILED`)
      process.exit(1)
    }
    console.log(`\n[verify-dsh-runtime] ${phase}: all checks passed`)
    process.exit(0)
  }
}

function writeMetisOverlay(patchFile: string, databasePath: string): void {
  const dbForward = databasePath.replaceAll('\\', '/')
  const lines: string[] = [
    '# Generated METIS overlay for verify-dsh-runtime (do not edit by hand).',
    '- insert:',
  ]
  for (const entry of METIS_PLUGIN_ENTRIES) {
    lines.push(`    - id: ${entry.id}`)
    lines.push(`      name: '${pathToFileURL(entry.source).href}'`)
  }
  // The workspace registry is a Web-layer mount in stock profiles; the METIS
  // runtime check needs it, so the overlay inserts the official DSH package row.
  lines.push("    - id: workspace-registry")
  lines.push("      name: '@deepseek-ai/dsh-workspace'")
  // Config overrides target the inserted rows and pin every plugin to the one
  // sandboxed SQLite file (patch config replaces the whole row config).
  for (const entry of METIS_PLUGIN_ENTRIES) {
    lines.push(`- id: ${entry.id}`)
    lines.push('  config:')
    lines.push(`    databasePath: '${dbForward}'`)
  }
  writeFileSync(patchFile, `${lines.join('\n')}\n`, 'utf8')
}

function toolValue(result: unknown): any {
  if (typeof result !== 'object' || result === null) throw new Error('tool result is not an object')
  const record = result as Record<string, unknown>
  if (record.isError === true) {
    console.log('[verify-dsh-runtime] tool failure detail:', JSON.stringify(record, null, 2))
    throw new Error(`tool failed: ${JSON.stringify(record.error ?? record)}`)
  }
  if (record.isError === false) return record.value
  throw new Error(`tool result has no canonical outcome: ${JSON.stringify(record)}`)
}

async function bootRuntime(home: string, rootConfig: string, patchFile: string) {
  const { boot, loadOverlayPatches } = await import('../../packages/boot/app-boot/src/index.ts')
  const basePatches = loadOverlayPatches('verify-dsh-runtime', BASE_BUNDLE_PATCH)
  const metisPatches = loadOverlayPatches('verify-dsh-runtime', patchFile)
  return await boot('dsh', rootConfig, [...basePatches, ...metisPatches])
}

async function createAgent(ctx: any, sessionId: string, cwd: string): Promise<{ agent: unknown; dispose: () => Promise<void> }> {
  const workspaceRegistry = ctx.get('workspaceRegistry')
  const workspace = await workspaceRegistry.create(cwd, 'METIS runtime verification')
  const handle = await ctx.get('agents').create({
    sessionId,
    meta: { cwd: workspace.path },
  })
  return { agent: handle.agent, dispose: () => handle.dispose() }
}

async function executeTool(ctx: any, agent: unknown, name: string, args: Record<string, unknown>): Promise<any> {
  return await toolValue(await ctx.get('tools').execute({
    callId: `metis-verify-${randomUUID()}`,
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  }))
}

async function runSetup(stateFile: string): Promise<never> {
  const checker = new Checker()
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'metis-dsh-runtime-'))
  const home = path.join(sandbox, 'dsh-home')
  const workspace = path.join(sandbox, 'workspace')
  const profileDir = path.join(sandbox, 'profile')
  for (const dir of [home, workspace, profileDir, path.join(workspace, 'notes')]) {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
  }
  const databasePath = path.join(profileDir, 'metis-data', 'metis.db')
  const rootConfig = path.join(profileDir, 'cordis.yml')
  const patchFile = path.join(profileDir, 'metis.patch.yml')
  writeFileSync(rootConfig, '[]\n', 'utf8')
  writeMetisOverlay(patchFile, databasePath)

  process.env.DSH_HOME = home
  process.env.DSH_PERMISSION_MODE = 'danger-full-access'

  const state: PhaseState = {
    home, workspace, databasePath, rootConfig, patchFile,
    sessionId: `metis-setup-${randomUUID()}`,
  }
  const ctx = await bootRuntime(state.home, rootConfig, patchFile)
  try {
    for (const service of ['metisResearch', 'metisEvidence', 'metisLiterature', 'metisScenario', 'metisArtifact']) {
      checker.check(`service mounted: ${service}`, ctx.get(service) !== undefined)
    }
    for (const tool of ['research_project_get', 'research_project_update', 'literature_search', 'literature_save', 'literature_search_project', 'literature_remove', 'literature_get', 'evidence_query', 'evidence_claim_create', 'evidence_claim_link', 'scenario_list', 'scenario_get', 'scenario_activate', 'artifact_register', 'artifact_list', 'artifact_get', 'artifact_version', 'artifact_update_metadata']) {
      checker.check(`tool registered: ${tool}`, ctx.get('tools').get(tool) !== undefined)
    }

    const agentHandle = await createAgent(ctx, state.sessionId, state.workspace)

    const project = await executeTool(ctx, agentHandle.agent, 'research_project_update', {
      title: '生成式人工智能与知识工作者职业分层',
      discipline: '社会学',
      researchQuestion: '生成式 AI 如何重塑知识工作者的职业边界？',
    })
    checker.check('research_project_update creates bound project', project.ok === true && typeof project.project?.id === 'string', project)
    state.projectId = project.project.id

    const saved = await executeTool(ctx, agentHandle.agent, 'literature_save', {
      records: [LITERATURE_RECORD],
    })
    checker.check('literature_save persists with evidence id', saved.saved === 1 && typeof saved.records?.[0]?.evidenceId === 'string', saved)
    state.literatureId = saved.records[0].id
    state.evidenceId = saved.records[0].evidenceId

    const evidence = await executeTool(ctx, agentHandle.agent, 'evidence_query', { doi: LITERATURE_RECORD.doi })
    checker.check('evidence_query finds the saved literature evidence', evidence.total === 1, evidence)

    writeFileSync(path.join(workspace, 'review-draft.md'), '# 审读报告草稿\n', 'utf8')
    const artifact = await executeTool(ctx, agentHandle.agent, 'artifact_register', {
      type: 'review',
      title: '论文审读报告 v1',
      path: 'review-draft.md',
      evidenceIds: [state.evidenceId],
    })
    checker.check('artifact_register registers a real workspace file', artifact.ok === true && artifact.artifact?.workspacePath === 'review-draft.md', artifact)
    state.artifactId = artifact.artifact.id

    let rejected = false
    try {
      await executeTool(ctx, agentHandle.agent, 'artifact_register', {
        type: 'review', title: 'traversal', path: '../outside.md',
      })
    } catch {
      rejected = true
    }
    checker.check('artifact_register rejects workspace traversal', rejected)

    const scenario = await executeTool(ctx, agentHandle.agent, 'scenario_activate', { id: 'paper-review' })
    checker.check('scenario_activate persists and arms a DSH Goal', scenario.ok === true && scenario.goal?.objective?.includes('审读') === true, scenario)

    const goalView = ctx.get('goals').get(agentHandle.agent)
    checker.check('ctx.goals reports the scenario objective', goalView?.objective?.includes('审读') === true, goalView)

    const blocked = await executeTool(ctx, agentHandle.agent, 'scenario_activate', { id: 'literature-review' })
    checker.check('scenario_activate fails loud on missing ncpssd_search', blocked.ok === false && blocked.missingTools?.includes('ncpssd_search') === true, blocked)

    await agentHandle.dispose()
  } finally {
    await ctx.fiber.dispose()
  }

  writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
  checker.finish('setup')
}

async function runVerify(stateFile: string): Promise<never> {
  const checker = new Checker()
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as PhaseState
  process.env.DSH_HOME = state.home
  process.env.DSH_PERMISSION_MODE = 'danger-full-access'

  const ctx = await bootRuntime(state.home, state.rootConfig, state.patchFile)
  try {
    const { MetisDataStore } = await import('../shared/data/src/index.ts')
    const data = await MetisDataStore.open(state.databasePath)

    const project = data.getProject(state.projectId!)
    checker.check('project survives process restart', project?.title === '生成式人工智能与知识工作者职业分层', project)

    const literature = data.listLiterature(state.projectId!)
    checker.check('literature survives restart with evidence link', literature.length === 1 && literature[0]?.evidenceId === state.evidenceId, literature)

    const evidence = data.queryEvidence({ doi: LITERATURE_RECORD.doi })
    checker.check('evidence survives restart', evidence.length === 1 && evidence[0]?.id === state.evidenceId, evidence)

    const artifact = data.getArtifact(state.artifactId!)
    checker.check('artifact survives restart with versions and evidence link',
      artifact !== null && artifact.evidenceIds.includes(state.evidenceId!) && artifact.versions.length === 1, artifact)

    const activation = data.getScenarioActivation(state.sessionId)
    checker.check('scenario activation survives restart for the original session', activation?.scenarioId === 'paper-review', activation)
    data.close()

    const verifySessionId = `metis-verify-${randomUUID()}`
    const agentHandle = await createAgent(ctx, verifySessionId, state.workspace)
    const current = await executeTool(ctx, agentHandle.agent, 'research_project_get', {})
    checker.check('new session in the same workspace resolves the persisted project',
      current.ok === true && current.project?.id === state.projectId, current)

    const found = await executeTool(ctx, agentHandle.agent, 'literature_search_project', { query: 'Cold-Seeking' })
    checker.check('literature_search_project reads persisted literature', found.total === 1, found)

    const fresh = await executeTool(ctx, agentHandle.agent, 'scenario_list', {})
    checker.check('scenario activation is session-scoped (new session starts inactive)',
      fresh.activeId === '', fresh)

    await agentHandle.dispose()
  } finally {
    await ctx.fiber.dispose()
  }
  checker.finish('verify')
}

async function main(): Promise<void> {
  const [phase, stateFile] = process.argv.slice(2)
  if (phase !== 'setup' && phase !== 'verify') {
    console.error('usage: verify-dsh-runtime.ts <setup|verify> <state.json>')
    process.exit(2)
  }
  if (phase === 'setup') return await runSetup(stateFile)
  return await runVerify(stateFile)
}

void main().catch((error) => {
  console.error('[verify-dsh-runtime] crashed:', error)
  process.exit(1)
})
