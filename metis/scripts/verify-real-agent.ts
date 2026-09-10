/**
 * L4 Real Agent E2E for the METIS plugin family.
 *
 * Boots the REAL Cordis loader (dsh-base bundle + METIS overlay + the three
 * real literature providers), wires a real OpenAI-compatible LLM route
 * (llm-pi-ai provider), creates a real live agent, and sends real research
 * TASKS as user messages. The MODEL decides which METIS tools to call; this
 * script never calls METIS services on the model's behalf. Success is judged
 * from durable state (SQLite, DSH Goal) and the session log — never from the
 * model's claims.
 *
 * Requirements:
 *   CLOUDLOB_API_KEY  — API key for the configured OpenAI-compatible endpoint
 *                       (read from the environment; NEVER written to disk).
 *
 * Usage (from the DeepSeek Harness checkout root):
 *   CLOUDLOB_API_KEY=... node --import tsx/esm metis/scripts/verify-real-agent.ts
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const METIS_DIR = path.resolve(SCRIPT_DIR, '..')
const CHECKOUT_ROOT = path.resolve(METIS_DIR, '..')
const BASE_BUNDLE_PATCH = path.join(CHECKOUT_ROOT, 'packages', 'bundle', 'base', 'cordis.patch.yml')

const CLOUDLOB_BASE_URL = 'https://cloudlob.xyz/v1'
const CLOUDLOB_MODEL = 'qwen3.8-flash-bai'

const METIS_PLUGIN_ENTRIES = [
  { id: 'metis-core', source: path.join(METIS_DIR, 'plugins', 'core', 'src', 'index.ts') },
  { id: 'metis-evidence', source: path.join(METIS_DIR, 'plugins', 'evidence', 'src', 'index.ts') },
  { id: 'metis-literature', source: path.join(METIS_DIR, 'plugins', 'literature', 'src', 'index.ts') },
  { id: 'metis-scenario', source: path.join(METIS_DIR, 'plugins', 'scenario', 'src', 'index.ts') },
  { id: 'metis-artifact', source: path.join(METIS_DIR, 'plugins', 'artifact', 'src', 'index.ts') },
  { id: 'metis-literature-crossref', source: path.join(METIS_DIR, 'plugins', 'literature-crossref', 'src', 'index.ts') },
  { id: 'metis-literature-openalex', source: path.join(METIS_DIR, 'plugins', 'literature-openalex', 'src', 'index.ts') },
  { id: 'metis-literature-ncpssd', source: path.join(METIS_DIR, 'plugins', 'literature-ncpssd', 'src', 'index.ts') },
]

const TURN_TIMEOUT_MS = 540_000

const failures: string[] = []
let checkIndex = 0
function check(name: string, ok: boolean, detail?: unknown): void {
  checkIndex += 1
  const label = `${String(checkIndex).padStart(2, '0')} ${name}`
  if (ok) {
    console.log(`  PASS ${label}`)
    return
  }
  const suffix = detail === undefined ? '' : ` :: ${JSON.stringify(detail)?.slice(0, 600)}`
  console.log(`  FAIL ${label}${suffix}`)
  failures.push(`${label}${suffix}`)
}

function writeOverlay(patchFile: string, databasePath: string): void {
  const dbForward = databasePath.replaceAll('\\', '/')
  const lines: string[] = [
    '# Generated METIS overlay for verify-real-agent (do not edit by hand).',
    '- insert:',
  ]
  for (const entry of METIS_PLUGIN_ENTRIES) {
    lines.push(`    - id: ${entry.id}`)
    lines.push(`      name: '${pathToFileURL(entry.source).href}'`)
  }
  lines.push("    - id: workspace-registry")
  lines.push("      name: '@deepseek-ai/dsh-workspace'")
  for (const entry of METIS_PLUGIN_ENTRIES.filter((entry) => !entry.id.includes('literature-'))) {
    lines.push(`- id: ${entry.id}`)
    lines.push('  config:')
    lines.push(`    databasePath: '${dbForward}'`)
  }
  // Real LLM route: OpenAI-compatible endpoint via the pi-ai multi-provider
  // adapter; the key is resolved per request from the process environment.
  lines.push('- id: llm-pi-ai')
  lines.push('  config:')
  lines.push('    providers:')
  lines.push('      cloudlob:')
  lines.push('        displayName: CloudLob')
  lines.push('        api: openai-completions')
  lines.push(`        baseURL: ${CLOUDLOB_BASE_URL}`)
  lines.push('        apiKeyEnv: CLOUDLOB_API_KEY')
  lines.push('        timeoutMs: 180000')
  lines.push('        models:')
  lines.push(`          - id: ${CLOUDLOB_MODEL}`)
  lines.push('            name: Qwen3.8 Flash')
  lines.push('            contextWindow: 262144')
  lines.push('            maxTokens: 32768')
  lines.push('- id: agent-default-model')
  lines.push('  config:')
  lines.push('    provider: cloudlob')
  lines.push(`    model: ${CLOUDLOB_MODEL}`)
  writeFileSync(patchFile, `${lines.join('\n')}\n`, 'utf8')
}

function toolValue(result: unknown): any {
  if (typeof result !== 'object' || result === null) throw new Error('tool result is not an object')
  const record = result as Record<string, unknown>
  if (record.isError === true) throw new Error(`tool failed: ${JSON.stringify(record.error ?? record)}`)
  if (record.isError === false) return record.value
  throw new Error(`tool result has no canonical outcome: ${JSON.stringify(record)}`)
}

async function executeTool(ctx: any, agent: unknown, name: string, args: Record<string, unknown>): Promise<any> {
  return await toolValue(await ctx.get('tools').execute({
    callId: `metis-real-agent-${randomUUID()}`,
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  }))
}

function wait(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
}

async function sendAndAwaitIdle(ctx: any, agent: any, text: string): Promise<void> {
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`turn timed out after ${TURN_TIMEOUT_MS}ms: ${text.slice(0, 60)}`)), TURN_TIMEOUT_MS)
    const progress = setInterval(() => {
      try {
        const types: Record<string, number> = {}
        for (const event of agent.session.snapshotEvents() as any[]) types[event.type] = (types[event.type] ?? 0) + 1
        console.log(`  ...turn progress: ${JSON.stringify(types)}`)
      } catch { /* snapshot raced disposal */ }
    }, 15_000)
    const dispose = ctx.on('agent/status', ({ agent: subject, status }: any) => {
      if (subject === agent && status === 'idle') {
        clearTimeout(timer)
        clearInterval(progress)
        dispose()
        resolve()
      }
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  })
}

function sessionEvidence(agent: any): { toolCalls: Array<{ name: string; args: unknown; result: unknown }>; assistantTexts: string[] } {
  const events = agent.session.snapshotEvents() as any[]
  const toolCalls: Array<{ name: string; args: unknown; result: unknown; failed: boolean }> = []
  const assistantTexts: string[] = []
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const blocks = Array.isArray(event.data?.content) ? event.data.content : []
      const text = blocks.flatMap((block: any) => (block?.type === 'text' ? [String(block.text)] : [])).join('')
      if (text.trim()) assistantTexts.push(text.trim())
    }
    if (event.type === 'tool/call') {
      toolCalls.push({ name: String(event.data?.name ?? '?'), args: event.data?.arguments ?? event.data?.args, result: undefined, failed: false })
    }
    if (event.type === 'tool/result') {
      const last = toolCalls.at(-1)
      if (last) {
        last.result = event.data
        const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
        last.failed = blocks.some((block: any) => block?.isError === true)
      }
    }
  }
  return { toolCalls, assistantTexts }
}

function printLiteratureTrace(evidence: ReturnType<typeof sessionEvidence>): void {
  for (const call of evidence.toolCalls) {
    if (!call.name.startsWith('literature') && !call.name.startsWith('evidence')) continue
    console.log(`  [trace] ${call.name} args:`, JSON.stringify(call.args)?.slice(0, 260))
    console.log(`  [trace] ${call.name} result:`, JSON.stringify(call.result)?.slice(0, 300))
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.CLOUDLOB_API_KEY
  if (!apiKey) {
    console.error('[verify-real-agent] CLOUDLOB_API_KEY is required in the environment (never stored on disk).')
    process.exit(2)
  }

  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'metis-real-agent-'))
  const home = path.join(sandbox, 'dsh-home')
  const workspace = path.join(sandbox, 'workspace')
  const profileDir = path.join(sandbox, 'profile')
  for (const dir of [home, workspace, profileDir]) mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(workspace, 'review-draft.md'), '# 审读报告（真实 Agent E2E 目标文件）\n', 'utf8')

  const databasePath = path.join(profileDir, 'metis-data', 'metis.db')
  const rootConfig = path.join(profileDir, 'cordis.yml')
  const patchFile = path.join(profileDir, 'metis.patch.yml')
  writeFileSync(rootConfig, '[]\n', 'utf8')
  writeOverlay(patchFile, databasePath)

  process.env.DSH_HOME = home
  process.env.DSH_PERMISSION_MODE = 'danger-full-access'

  const { boot, loadOverlayPatches } = await import('../../packages/boot/app-boot/src/index.ts')
  const basePatches = loadOverlayPatches('verify-real-agent', BASE_BUNDLE_PATCH)
  const metisPatches = loadOverlayPatches('verify-real-agent', patchFile)
  const ctx = await boot('dsh', rootConfig, [...basePatches, ...metisPatches])

  const { MetisDataStore } = await import('../shared/data/src/index.ts')
  let data: MetisDataStore | undefined

  try {
    const workspaceRegistry = ctx.get('workspaceRegistry')
    const ws = await workspaceRegistry.create(workspace, 'METIS real agent verification')
    const sessionId = `metis-real-${randomUUID()}`
    const handle = await ctx.get('agents').create({ sessionId, meta: { cwd: ws.path }, agentOptions: { provider: 'cloudlob', model: CLOUDLOB_MODEL } })
    const agent = handle.agent

    // ── Turn 1: research project setup + scenario activation (model-driven) ──
    await sendAndAwaitIdle(ctx, agent,
      '我是一位社会学研究者，现在开始一个新研究：课题是《平台经济中的算法管理与劳动者自主性》。'
      + '请为这个课题建立研究项目档案（学科：社会学；研究问题：算法管理如何重塑平台劳动者的自主性？）。'
      + '项目建立后，激活适合后续论文写作的方法学场景。请使用你的科研工具完成这两件事。')

    const evidence1 = sessionEvidence(agent)
    console.log('\n[evidence] turn 1 tool calls:', JSON.stringify(evidence1.toolCalls))
    console.log('[evidence] turn 1 assistant text:', evidence1.assistantTexts.at(-1)?.slice(0, 400))

    data = await MetisDataStore.open(databasePath)
    const project = data.listProjects().find((candidate) => candidate.title?.includes('算法管理'))
    check('model created the research project via tools', project !== undefined && project.discipline === '社会学', data.listProjects())
    check('model bound the project to the real DSH workspace', project?.workspaceId !== null && project?.workspaceId !== undefined, project)
    check('model activated a scenario (durable, this session)', (await data.getScenarioActivation(sessionId))?.scenarioId !== undefined)
    const goal = ctx.get('goals').get(agent)
    check('DSH Goal exists after scenario activation', goal !== undefined && goal.objective.length > 0, goal)

    // ── Turn 2: real literature search → save → artifact registration ──
    await sendAndAwaitIdle(ctx, agent,
      '推进文献环节：实际检索 platform labor algorithmic management 相关英文文献（真实数据库检索，不要凭记忆列文献），'
      + '把其中最多 3 篇保存进当前研究项目，再把 workspace 中已有的文件 review-draft.md 登记为 review 类型成果。')

    const evidence2 = sessionEvidence(agent)
    console.log('\n[evidence] turn 2 tool calls:', JSON.stringify(evidence2.toolCalls))
    console.log('[evidence] turn 2 assistant text:', evidence2.assistantTexts.at(-1)?.slice(0, 400))

    data.close()
    data = await MetisDataStore.open(databasePath)
    const savedProject = data.listProjects().find((candidate) => candidate.title?.includes('算法管理'))
    const literature = savedProject ? data.listLiterature(savedProject.id) : []
    check('model performed a real literature search (tool call observed)',
      evidence2.toolCalls.some((call) => call.name === 'literature_search'), evidence2.toolCalls)
    check('model saved real literature into the project (SQLite)',
      literature.length > 0 && literature.every((record) => record.evidenceId), literature.map((record) => record.title))
    const artifacts = savedProject ? data.listArtifacts({ projectId: savedProject.id }) : []
    check('model registered the real workspace file as an artifact',
      artifacts.length > 0 && artifacts[0]?.workspacePath === 'review-draft.md', artifacts)

    await handle.dispose()
  } finally {
    data?.close()
    await ctx.fiber.dispose()
    // Keep the sandbox for debugging on failure; remove it on success.
    if (failures.length === 0) rmSync(sandbox, { recursive: true, force: true })
    else console.log(`[verify-real-agent] sandbox preserved for inspection: ${sandbox}`)
  }

  if (failures.length > 0) {
    console.log(`\n[verify-real-agent] ${failures.length} check(s) FAILED`)
    process.exit(1)
  }
  console.log(`\n[verify-real-agent] all ${checkIndex} checks passed (model: ${CLOUDLOB_MODEL} via ${CLOUDLOB_BASE_URL})`)
}

void main().catch((error) => {
  console.error('[verify-real-agent] crashed:', error)
  process.exit(1)
})
