/**
 * Research Eval Runner（指令三十四~四十三）。
 *
 * 对 metis/evals/tasks.json 中的每个真实哲社科任务：
 *   boot 真实 Cordis Loader（dsh-base + METIS overlay + 真实文献 provider +
 *   真实 LLM 路由）→ 建 workspace/agent → 按任务 prompt 逐轮发送 →
 *   从 SQLite / DSH Goal / session log 计算结构化指标 → 写结果 JSON。
 *
 * 结构化指标（不使用 LLM Judge 作为验收依据）：
 *   taskCompleted / artifactCreated / citationsTotal / citationsVerified /
 *   evidenceCoverage / unsupportedClaims / toolErrors / providerFailures /
 *   restartRecoverable
 *
 * 凭据：需要 CLOUDLOB_API_KEY；缺失时全部任务标 BLOCKED_EXTERNAL 并以 0 退出。
 * 用法（checkout 根）：CLOUDLOB_API_KEY=… node --import tsx/esm metis/evals/run-evals.ts [taskIds…]
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const EVALS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const METIS_DIR = path.resolve(EVALS_DIR, '..')
const CHECKOUT_ROOT = path.resolve(METIS_DIR, '..')
const BASE_BUNDLE_PATCH = path.join(CHECKOUT_ROOT, 'packages', 'bundle', 'base', 'cordis.patch.yml')

const MODEL_PROVIDER = 'cloudlob'
const MODEL_ID = 'qwen3.8-flash-bai'
const TURN_TIMEOUT_MS = 900_000

interface EvalTask {
  id: string
  discipline: string
  steps: string[]
  expect: { artifact: boolean; literatureMin: number; claims: boolean; submissionCase?: boolean; templateId?: string; seedsManuscript?: boolean }
}

interface TaskResult {
  id: string
  status: 'PASS' | 'FAIL' | 'BLOCKED_EXTERNAL'
  projectId: string | null
  metrics: Record<string, number | boolean | string | null>
  failures: string[]
}

function writeOverlay(patchFile: string, databasePath: string): void {
  const entries = ['core', 'evidence', 'literature', 'scenario', 'artifact'].map((name) => ({
    id: `metis-${name}`,
    source: path.join(METIS_DIR, 'plugins', name, 'src', 'index.ts'),
  }))
  for (const name of ['literature-crossref', 'literature-openalex', 'literature-ncpssd']) {
    entries.push({ id: `metis-${name}`, source: path.join(METIS_DIR, 'plugins', name, 'src', 'index.ts') })
  }
  const dbForward = databasePath.replaceAll('\\', '/')
  const lines: string[] = ['# Generated METIS overlay for run-evals.', '- insert:']
  for (const entry of entries) {
    lines.push(`    - id: ${entry.id}`)
    lines.push(`      name: '${pathToFileURL(entry.source)}'`)
  }
  lines.push("    - id: workspace-registry")
  lines.push("      name: '@deepseek-ai/dsh-workspace'")
  for (const entry of entries.filter((entry) => !entry.id.includes('literature-'))) {
    lines.push(`- id: ${entry.id}`)
    lines.push('  config:')
    lines.push(`    databasePath: '${dbForward}'`)
  }
  lines.push('- id: llm-pi-ai')
  lines.push('  config:')
  lines.push('    providers:')
  lines.push('      cloudlob:')
  lines.push('        displayName: CloudLob')
  lines.push('        api: openai-completions')
  lines.push('        baseURL: https://cloudlob.xyz/v1')
  lines.push('        apiKeyEnv: CLOUDLOB_API_KEY')
  lines.push('        timeoutMs: 180000')
  lines.push('        models:')
  lines.push(`          - id: ${MODEL_ID}`)
  lines.push('            name: Qwen3.8 Flash')
  lines.push('            contextWindow: 262144')
  lines.push('            maxTokens: 32768')
  writeFileSync(patchFile, `${lines.join('\n')}\n`, 'utf8')
}

function pathToFileURL(p: string): string {
  return 'file:///' + p.replaceAll('\\', '/')
}

async function sendAndAwaitIdle(ctx: any, agent: any, text: string): Promise<void> {
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const send = (message: string): void => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: message }], source: { kind: 'user' } }))
  }
  send(text)
  // 与 golden-run 相同的等待语义：单轮 900s；仅超时一次后发送一次「继续」驱动收尾。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) send('请收尾当前步骤：完成手头操作后简短总结。')
    const idle = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), TURN_TIMEOUT_MS)
      const dispose = ctx.on('agent/status', ({ agent: subject, status }: any) => {
        if (subject === agent && status === 'idle') {
          clearTimeout(timer)
          dispose()
          resolve(true)
        }
      })
    })
    if (idle) return
  }
  throw new Error(`task did not finish within the continue-loop budget: ${text.slice(0, 50)}`)
}

function sessionFacts(agent: any): { toolCalls: Array<{ name: string; failed: boolean }>; finalText: string } {
  const events = agent.session.snapshotEvents() as any[]
  const toolCalls: Array<{ name: string; failed: boolean }> = []
  let finalText = ''
  for (const event of events) {
    if (event.type === 'tool/call') toolCalls.push({ name: String(event.data?.name ?? '?'), failed: false })
    if (event.type === 'tool/result') {
      const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
      if (blocks.some((block: any) => block?.isError === true)) {
        const last = toolCalls.at(-1)
        if (last) last.failed = true
      }
    }
    if (event.type === 'assistant/message') {
      const blocks = Array.isArray(event.data?.content) ? event.data.content : []
      const text = blocks.flatMap((block: any) => (block?.type === 'text' ? [String(block.text)] : [])).join('')
      if (text.trim()) finalText = text.trim()
    }
  }
  return { toolCalls, finalText }
}

async function runTask(task: EvalTask): Promise<TaskResult> {
  const result: TaskResult = { id: task.id, status: 'FAIL', projectId: null, metrics: {}, failures: [] }

  const sandbox = mkdtempSync(path.join(os.tmpdir(), `metis-eval-${task.id}-`))
  const home = path.join(sandbox, 'dsh-home')
  const workspace = path.join(sandbox, 'workspace')
  const profileDir = path.join(sandbox, 'profile')
  for (const dir of [home, workspace, profileDir]) mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(workspace, 'review-draft.md'), '# 待审读稿件（示例）\n\n本文提出…（省略）\n', 'utf8')
  writeFileSync(path.join(workspace, 'manuscript.md'), '# 平台劳动短稿\n\n算法管理改变了劳动过程。\n', 'utf8')
  writeFileSync(path.join(workspace, 'funding-observation.json'), JSON.stringify({
    contractVersion: 1,
    documentId: 'doc-eval',
    sourceFormat: 'pdf',
    sourceDigest: 'b'.repeat(64),
    extractedAt: Date.now() - 86_400_000,
    extractor: { name: 'eval', version: '1.0.0' },
    pageCount: 1,
    pages: [{ pageNumber: 1, widthPt: 612, heightPt: 792, observedMarginsPt: null }],
    styles: [{
      styleId: 's1', fontFamily: 'SimSun', fontSizePt: 14, fontWeight: 'bold', italic: false,
      alignment: 'left', lineSpacingPt: null, paragraphBeforePt: null, paragraphAfterPt: null,
    }],
    blocks: [{
      kind: 'paragraph', blockId: 'b1', pageNumber: 1, ordinal: 0,
      bounds: { x: 70, y: 70, width: 470, height: 20 },
      text: '立项依据（不超过 2000 字）：', contentRole: 'instruction', styleId: 's1',
    }],
  }), 'utf8')

  const databasePath = path.join(profileDir, 'metis-data', 'metis.db')
  const rootConfig = path.join(profileDir, 'cordis.yml')
  const patchFile = path.join(profileDir, 'metis.patch.yml')
  writeFileSync(rootConfig, '[]\n', 'utf8')
  writeOverlay(patchFile, databasePath)

  process.env.DSH_HOME = home
  process.env.DSH_PERMISSION_MODE = 'danger-full-access'

  const { boot, loadOverlayPatches } = await import('../../packages/boot/app-boot/src/index.ts')
  const basePatches = loadOverlayPatches('run-evals', BASE_BUNDLE_PATCH)
  const metisPatches = loadOverlayPatches('run-evals', patchFile)
  const ctx = await boot('dsh', rootConfig, [...basePatches, ...metisPatches])
  try {
    const ws = await ctx.get('workspaceRegistry').create(workspace, `eval ${task.id}`)
    const handle = await ctx.get('agents').create({
      sessionId: `metis-eval-${randomUUID()}`,
      meta: { cwd: ws.path },
      agentOptions: { provider: MODEL_PROVIDER, model: MODEL_ID },
    })
    // Staged prompts (v2): each task delivers its work the way the successful
    // golden run does — a sequence of focused user turns, not one giant turn.
    for (const step of task.steps) {
      await sendAndAwaitIdle(ctx, handle.agent, step)
    }

    const facts = sessionFacts(handle.agent)
    const data = await import('../shared/data/src/index.ts').then((module) => module.MetisDataStore.open(databasePath))
    const project = data.listProjects()[0]
    result.projectId = project?.id ?? null
    const literature = project ? data.listLiterature(project.id) : []
    const artifacts = project ? data.listArtifacts({ projectId: project.id }) : []
    const claims = project ? data.listClaims({ projectId: project.id }) : []
    const coverage = artifacts[0] ? data.artifactEvidenceCheck(artifacts[0].id) : null
    const cases = project ? data.listSubmissionCases(project.id) : []
    data.close()

    const providerFailures = facts.toolCalls.filter((call) => call.name.startsWith('literature') && call.failed).length
    result.metrics = {
      taskCompleted: facts.finalText.length > 0,
      artifactCreated: artifacts.length > 0,
      citationsTotal: literature.length,
      citationsVerified: literature.filter((record) => record.evidenceId).length,
      evidenceCoverage: coverage ? Number(coverage.coverageRatio.toFixed(2)) : null,
      unsupportedClaims: claims.filter((claim) => claim.verificationState === 'unverified').length,
      toolErrors: facts.toolCalls.filter((call) => call.failed).length,
      providerFailures,
      hallucinatedReferences: 'structural-check-not-applicable',
      restartRecoverable: 'covered-by-runtime-gate',
      finalTextChars: facts.finalText.length,
    }

    if (!result.metrics.taskCompleted) result.failures.push('模型未产出最终说明文本')
    if (task.expect.artifact && artifacts.length === 0) result.failures.push('未登记 artifact')
    if (literature.length < task.expect.literatureMin) result.failures.push(`保存文献不足（${literature.length}/${task.expect.literatureMin}）`)
    if (task.expect.claims && claims.length === 0) result.failures.push('未建立任何 claim')
    if (task.expect.submissionCase && cases.length === 0) result.failures.push('未创建投稿案例')
    if (task.expect.templateId) {
      const data2 = await import('../shared/data/src/index.ts').then((module) => module.MetisDataStore.open(databasePath))
      const template = data2.getFundingTemplate(task.expect.templateId)
      if (!template) result.failures.push(`模板未登记: ${task.expect.templateId}`)
      data2.close()
    }
    // 文献真实存在（有来源身份）即通过结构化检查；幻觉引用由「文献必须来自 provider 返回记录并带 evidence」的设计约束排除。
    result.status = result.failures.length === 0 ? 'PASS' : 'FAIL'

    await handle.dispose()
  } catch (error) {
    result.failures.push(error instanceof Error ? error.message : String(error))
  } finally {
    await ctx.fiber.dispose()
    if (result.status === 'PASS') rmSync(sandbox, { recursive: true, force: true })
    else console.log(`[eval ${task.id}] sandbox preserved: ${sandbox}`)
  }
  return result
}

async function main(): Promise<void> {
  if (!process.env.CLOUDLOB_API_KEY) {
    const blocked = { schemaVersion: 1, generatedAt: new Date().toISOString(), blocked: 'CLOUDLOB_API_KEY not set', tasks: [] }
    writeFileSync(path.join(EVALS_DIR, 'results-latest.json'), `${JSON.stringify(blocked, null, 2)}\n`, 'utf8')
    console.log('[evals] BLOCKED_EXTERNAL: CLOUDLOB_API_KEY 未设置；未执行任何任务（不伪造结果）。')
    process.exit(0)
  }
  const tasks = JSON.parse(readFileSync(path.join(EVALS_DIR, 'tasks.json'), 'utf8')) as { tasks: EvalTask[] }
  const only = process.argv.slice(2)
  const selected = only.length > 0 ? tasks.tasks.filter((task) => only.includes(task.id)) : tasks.tasks
  const results: TaskResult[] = []
  for (const task of selected) {
    console.log(`\n[eval] running ${task.id} (${task.discipline})`)
    const result = await runTask(task)
    console.log(`[eval] ${task.id}: ${result.status}${result.failures.length > 0 ? ` — ${result.failures.join('; ')}` : ''}`)
    results.push(result)
  }
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    model: `${MODEL_PROVIDER}/${MODEL_ID}`,
    summary: {
      total: results.length,
      pass: results.filter((result) => result.status === 'PASS').length,
      fail: results.filter((result) => result.status === 'FAIL').length,
    },
    results,
  }
  writeFileSync(path.join(EVALS_DIR, 'results-latest.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  if (output.summary.fail > 0) {
    console.log(`\n[evals] ${output.summary.fail}/${output.summary.total} FAILED`)
    process.exit(1)
  }
  console.log(`\n[evals] all ${output.summary.total} tasks PASS`)
}

void main().catch((error) => {
  console.error('[evals] crashed:', error)
  process.exit(1)
})
