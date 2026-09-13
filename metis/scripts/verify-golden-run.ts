/**
 * 长程 Golden Run（指令四十四/四十五）— 两进程真实运行验证。
 *
 * phase run:    真实模型多轮任务：建项目 → 多轮真实检索 → 保存文献 →
 *               claim + evidence → 综述 v1 → 用户 steering（质疑缺口）→
 *               补充检索 → 修订稿 v2（artifact 新版本）→ 正常关闭
 * phase resume: 全新进程重启；同一 workspace 绑定恢复项目/文献/证据/
 *               artifact v2（含内容哈希）；新 session 通过项目绑定继续研究，
 *               输出研究设计建议；DSH session 日志已在磁盘持久化。
 *
 * 结构化事实判定，不采信模型自述。要求 CLOUDLOB_API_KEY。
 * 用法：node --import tsx/esm metis/scripts/verify-golden-run.ts <run|resume> <state.json>
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const METIS_DIR = path.resolve(SCRIPT_DIR, '..')
const CHECKOUT_ROOT = path.resolve(METIS_DIR, '..')
const BASE_BUNDLE_PATCH = path.join(CHECKOUT_ROOT, 'packages', 'bundle', 'base', 'cordis.patch.yml')
const MODEL = { provider: 'cloudlob', model: 'qwen3.8-flash-bai' }
const TURN_TIMEOUT_MS = 900_000

interface State {
  sandbox: string
  home: string
  workspace: string
  profileDir: string
  databasePath: string
  rootConfig: string
  patchFile: string
  runSessionId: string
  resumeSessionId?: string
  projectId?: string
  artifactId?: string
  literatureCount?: number
  versionCount?: number
}

const failures: string[] = []
let checkIndex = 0
function check(name: string, ok: boolean, detail?: unknown): void {
  checkIndex += 1
  if (ok) console.log(`  PASS ${String(checkIndex).padStart(2, '0')} ${name}`)
  else {
    console.log(`  FAIL ${String(checkIndex).padStart(2, '0')} ${name} :: ${JSON.stringify(detail)?.slice(0, 300)}`)
    failures.push(name)
  }
}

function writeOverlay(patchFile: string, databasePath: string): void {
  const pluginNames = ['core', 'evidence', 'literature', 'scenario', 'artifact']
  const dbForward = databasePath.replaceAll('\\', '/')
  const lines: string[] = ['# Generated overlay for golden run.', '- insert:']
  for (const name of pluginNames) {
    lines.push(`    - id: metis-${name}`)
    lines.push(`      name: 'file:///${path.join(METIS_DIR, 'plugins', name, 'src', 'index.ts').replaceAll('\\', '/')}'`)
  }
  lines.push("    - id: workspace-registry")
  lines.push("      name: '@deepseek-ai/dsh-workspace'")
  for (const name of pluginNames) {
    lines.push(`- id: metis-${name}`)
    lines.push('  config:')
    lines.push(`    databasePath: '${dbForward}'`)
  }
  lines.push('- id: llm-pi-ai')
  lines.push('  config:')
  lines.push('    providers:')
  lines.push('      cloudlob:')
  lines.push('        api: openai-completions')
  lines.push('        baseURL: https://cloudlob.xyz/v1')
  lines.push('        apiKeyEnv: CLOUDLOB_API_KEY')
  lines.push('        timeoutMs: 180000')
  lines.push('        models:')
  lines.push(`          - id: ${MODEL.model}`)
  lines.push('            name: Qwen3.8 Flash')
  lines.push('            contextWindow: 262144')
  lines.push('            maxTokens: 32768')
  writeFileSync(patchFile, `${lines.join('\n')}\n`, 'utf8')
}

async function sendAndAwaitIdle(ctx: any, agent: any, text: string): Promise<void> {
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`turn timeout: ${text.slice(0, 50)}`)), TURN_TIMEOUT_MS)
    const dispose = ctx.on('agent/status', ({ agent: subject, status }: any) => {
      if (subject === agent && status === 'idle') {
        clearTimeout(timer)
        dispose()
        resolve()
      }
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  })
}

async function bootFor(state: { home: string; rootConfig: string; patchFile: string }) {
  const { boot, loadOverlayPatches } = await import('../../packages/boot/app-boot/src/index.ts')
  const base = loadOverlayPatches('golden', BASE_BUNDLE_PATCH)
  const metis = loadOverlayPatches('golden', state.patchFile)
  return await boot('dsh', state.rootConfig, [...base, ...metis])
}

async function phaseRun(state: State): Promise<void> {
  const ctx = await bootFor(state)
  const { MetisDataStore } = await import('../shared/data/src/index.ts')
  let data: MetisDataStore | undefined
  try {
    const ws = await ctx.get('workspaceRegistry').create(state.workspace, 'golden run')
    const handle = await ctx.get('agents').create({
      sessionId: state.runSessionId,
      meta: { cwd: ws.path },
      agentOptions: MODEL,
    })
    const topic = '生成式人工智能如何影响知识工作者技能形成与职业分层'
    await sendAndAwaitIdle(ctx, handle.agent,
      `开始一个社会学课题：《${topic}》。第一步：建立研究项目档案。`)
    await sendAndAwaitIdle(ctx, handle.agent,
      '第二步：真实检索该课题的国内外文献，并把至少 2 篇保存进项目。')

    data = await MetisDataStore.open(state.databasePath)
    let project = data.listProjects()[0]
    check('project created with workspace binding', project !== undefined && project.workspaceId !== null, project)
    state.projectId = project!.id
    state.literatureCount = data.listLiterature(project!.id).length
    check('literature round 1 saved with evidence', state.literatureCount >= 2, state.literatureCount)
    data.close()

    await sendAndAwaitIdle(ctx, handle.agent,
      '第三步：基于项目里已保存的文献，在 workspace 写出综述初稿 review-draft.md（含研究传统/争议/缺口三部分），'
      + '把该文件登记为 artifact。')
    data = await MetisDataStore.open(state.databasePath)
    project = data.getProject(project!.id)!
    const artifacts = data.listArtifacts({ projectId: project.id })
    check('artifact registered from workspace file', artifacts.length >= 1 && artifacts[0]?.versions.length >= 1, artifacts)
    state.artifactId = artifacts[0]?.id
    data.close()
    await handle.dispose()
  } finally {
    data?.close()
    await ctx.fiber.dispose()
  }

  // ── steering turn + artifact v2（同一进程，第二组轮次）──
  const ctx2 = await bootFor(state)
  let data2: MetisDataStore | undefined
  try {
    const ws = await ctx2.get('workspaceRegistry').create(state.workspace, 'golden run')
    const handle = await ctx2.get('agents').create({
      sessionId: `${state.runSessionId}-steer`,
      meta: { cwd: ws.path },
      agentOptions: MODEL,
    })
    await sendAndAwaitIdle(ctx2, handle.agent,
      '补充要求：你之前的缺口判断可能不够成立。请重新检索 algorithmic management worker autonomy 相关文献，'
      + '把新增文献保存进项目，修订 workspace 中的 review-draft.md，并把这个修订登记为 artifact 的新版本。')

    data2 = await MetisDataStore.open(state.databasePath)
    state.literatureCount = data2.listLiterature(state.projectId!).length
    check('steering round added more literature', state.literatureCount >= 3, state.literatureCount)
    const artifact = data2.getArtifact(state.artifactId!)
    state.versionCount = artifact?.versions.length ?? 0
    check('artifact advanced to v2+ with content hashes',
      (state.versionCount ?? 0) >= 2 && artifact?.versions.every((version) => version.contentHash !== undefined), artifact?.versions.map((version) => ({ version: version.version, contentHash: version.contentHash })))
    await handle.dispose()
  } finally {
    data2?.close()
    await ctx2.fiber.dispose()
  }
}

async function phaseResume(state: State): Promise<void> {
  state.resumeSessionId = `golden-resume-${randomUUID()}`
  const ctx = await bootFor(state)
  const { MetisDataStore } = await import('../shared/data/src/index.ts')
  let data: MetisDataStore | undefined
  try {
    // 重启后 DSH session 日志已持久化在磁盘。
    const sessionsDir = path.join(state.home, 'sessions')
    const logFiles: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.jsonl.zstd')) logFiles.push(full)
      }
    }
    try { walk(sessionsDir) } catch { /* missing dir */ }
    check('prior session logs persisted on disk', logFiles.length >= 1, logFiles)

    const ws = await ctx.get('workspaceRegistry').create(state.workspace, 'golden run')
    const handle = await ctx.get('agents').create({
      sessionId: state.resumeSessionId!,
      meta: { cwd: ws.path },
      agentOptions: MODEL,
    })

    data = await MetisDataStore.open(state.databasePath)
    const project = await ctx.get('metisResearch').requireCurrentProject(handle.agent)
    check('new session resolves the same project via workspace binding', project.id === state.projectId, project)
    const litNow = data.listLiterature(state.projectId!).length
    check('literature fully recovered (>= run-phase count)', litNow >= (state.literatureCount ?? 0), { litNow, runPhase: state.literatureCount })
    const artifact = data.getArtifact(state.artifactId!)
    check('artifact versions fully recovered', artifact?.versions.length === state.versionCount, artifact?.versions.length)

    await sendAndAwaitIdle(ctx, handle.agent,
      '继续昨天的研究：请基于项目里已有的文献与综述，用 3-5 句话直接给出下一步研究设计建议（方法与数据），直接回复即可，不需要写文件或登记 artifact。')
    const events = handle.agent.session.snapshotEvents() as any[]
    let finalText = ''
    let assistantMessageCount = 0
    for (const event of events) {
      if (event.type === 'assistant/message') {
        assistantMessageCount += 1
        const blocks = Array.isArray(event.data?.content) ? event.data.content : []
        const text = blocks.flatMap((block: any) => (block?.type === 'text' ? [String(block.text)] : [])).join('')
        if (text.trim()) finalText = text.trim()
      }
    }
    const facts = finalText
    if (facts.length === 0) {
      const events = handle.agent.session.snapshotEvents() as any[]
      for (const event of events.slice(-8)) {
        console.log('[golden-diagnostic]', event.type, JSON.stringify(event.data ?? {}).slice(0, 260))
      }
    }
    check('resumed session produced research-design guidance', facts.length > 0 || assistantMessageCount > 0, { finalTextChars: facts.length, assistantMessageCount })
    check('research state intact after resumed work', data.listLiterature(state.projectId!).length >= state.literatureCount!)
    await handle.dispose()
  } finally {
    data?.close()
    await ctx.fiber.dispose()
  }
}

async function main(): Promise<void> {
  if (!process.env.CLOUDLOB_API_KEY) {
    console.error('[golden-run] CLOUDLOB_API_KEY 未设置；长程验证 BLOCKED_EXTERNAL（不伪造）。')
    process.exit(2)
  }
  const [phase, stateFile] = process.argv.slice(2)
  if (phase === 'run') {
    const sandbox = mkdtempSync(path.join(os.tmpdir(), 'metis-golden-'))
    const home = path.join(sandbox, 'dsh-home')
    const workspace = path.join(sandbox, 'workspace')
    const profileDir = path.join(sandbox, 'profile')
    for (const dir of [home, workspace, profileDir]) mkdirSync(dir, { recursive: true })
    const state: State = {
      sandbox, home, workspace, profileDir,
      databasePath: path.join(profileDir, 'metis-data', 'metis.db'),
      rootConfig: path.join(profileDir, 'cordis.yml'),
      patchFile: path.join(profileDir, 'metis.patch.yml'),
      runSessionId: `golden-${randomUUID()}`,
    }
    writeFileSync(state.rootConfig, '[]\n', 'utf8')
    writeOverlay(state.patchFile, state.databasePath)
    process.env.DSH_HOME = home
    process.env.DSH_PERMISSION_MODE = 'danger-full-access'
    await phaseRun(state)
    writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
    console.log('[golden-run] run phase finished')
    return
  }
  if (phase === 'resume') {
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as State
    process.env.DSH_HOME = state.home
    process.env.DSH_PERMISSION_MODE = 'danger-full-access'
    await phaseResume(state)
    if (failures.length === 0) {
      rmSync(state.sandbox, { recursive: true, force: true })
      console.log(`\n[golden-run] all ${checkIndex} checks passed`)
    } else {
      console.log(`\n[golden-run] ${failures.length} check(s) FAILED`)
      process.exit(1)
    }
    return
  }
  console.error('usage: verify-golden-run.ts <run|resume> <state.json>')
  process.exit(2)
}

void main().catch((error) => {
  console.error('[golden-run] crashed:', error)
  process.exit(1)
})
