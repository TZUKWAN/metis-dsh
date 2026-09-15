/**
 * METIS Research Eval Runner v3 — per-task execution, persistent state, resume.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EVALS_DIR = path.dirname(fileURLToPath(import.meta.url))
const METIS_DIR = path.resolve(EVALS_DIR, '..')
const CHECKOUT_ROOT = path.resolve(METIS_DIR, '..')
const BASE_BUNDLE_PATCH = path.join(CHECKOUT_ROOT, 'packages', 'bundle', 'base', 'cordis.patch.yml')
const MODEL_PROVIDER = 'cloudlob'
const MODEL_ID = 'qwen3.8-flash-bai'
const DEFAULT_TURN_TIMEOUT_MS = 900_000
const TURN_TIMEOUT_BY_TASK = { 'journal-selection': 1_200_000, 'funding-template': 1_200_000 }

function writeOverlay(patchFile, databasePath) {
  const entries = ['core', 'evidence', 'literature', 'scenario', 'artifact'].map(name => ({ id: `metis-${name}`, source: path.join(METIS_DIR, 'plugins', name, 'src', 'index.ts') }))
  for (const name of ['literature-crossref', 'literature-openalex', 'literature-ncpssd']) entries.push({ id: `metis-${name}`, source: path.join(METIS_DIR, 'plugins', name, 'src', 'index.ts') })
  const dbFwd = databasePath.split(path.sep).join('/')
  const lines = ['# Generated METIS overlay.', '- insert:']
  for (const entry of entries) { lines.push(`    - id: ${entry.id}`); lines.push(`      name: 'file:///${entry.source.split(path.sep).join('/')}'`) }
  lines.push("    - id: workspace-registry"); lines.push("      name: '@deepseek-ai/dsh-workspace'")
  for (const entry of entries.filter(e => !e.id.includes('literature-'))) { lines.push(`- id: ${entry.id}`); lines.push('  config:'); lines.push(`    databasePath: '${dbFwd}'`) }
  lines.push('- id: llm-pi-ai'); lines.push('  config:'); lines.push('    providers:'); lines.push('      cloudlob:'); lines.push('        displayName: CloudLob'); lines.push('        api: openai-completions'); lines.push('        baseURL: https://cloudlob.xyz/v1'); lines.push('        apiKeyEnv: CLOUDLOB_API_KEY'); lines.push('        timeoutMs: 180000'); lines.push('        models:'); lines.push('          - id: qwen3.8-flash-bai'); lines.push('            name: Qwen3.8 Flash'); lines.push('            contextWindow: 262144'); lines.push('            maxTokens: 32768')
  writeFileSync(patchFile, lines.join('\n') + '\n', 'utf8')
}

async function sendAndAwaitIdle(ctx, agent, text, timeoutMs) {
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const send = msg => { agent.followup(createUserMessage({ content: [{ type: 'text', text: msg }], source: { kind: 'user' } })) }
  send(text)
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) send('请收尾当前步骤：完成手头操作后简短总结。')
    const idle = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject === agent && status === 'idle') { clearTimeout(timer); dispose(); resolve(true) }
      })
    })
    if (idle) return
  }
  throw new Error(`turn timeout (${timeoutMs}ms): ${text.slice(0, 50)}`)
}

function sessionFacts(agent) {
  const events = agent.session.snapshotEvents()
  const toolCalls = []
  let finalText = ''
  for (const event of events) {
    if (event.type === 'tool/call') toolCalls.push({ name: String(event.data?.name ?? '?'), failed: false })
    if (event.type === 'tool/result') {
      const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
      if (blocks.some(b => b?.isError === true)) { const last = toolCalls.at(-1); if (last) last.failed = true }
    }
    if (event.type === 'assistant/message') {
      const blocks = Array.isArray(event.data?.content) ? event.data.content : []
      const text = blocks.flatMap(b => b?.type === 'text' ? [String(b.text)] : []).join('')
      if (text.trim()) finalText = text.trim()
    }
  }
  return { toolCalls, finalText }
}

async function runSingleTask(task, runDir, attempt) {
  const result = { evalId: task.id, runId: path.basename(runDir), status: 'RUNNING', startedAt: new Date().toISOString(), finishedAt: null, attempt, model: `${MODEL_PROVIDER}/${MODEL_ID}`, provider: MODEL_PROVIDER, workspaceId: null, sessionId: null, projectId: null, artifactIds: [], toolCalls: [], toolFailures: 0, literatureSaved: 0, researchQualityChecks: null, failureReason: null, finalTextChars: 0, metrics: {}, failures: [] }
  const writeTaskResult = (r) => { writeFileSync(path.join(runDir, `${r.evalId}.json`), JSON.stringify(r, null, 2) + '\n', 'utf8') }
  writeTaskResult(result)
  const sandbox = mkdtempSync(path.join(os.tmpdir(), `metis-eval-${task.id}-`))
  const home = path.join(sandbox, 'dsh-home'); const workspace = path.join(sandbox, 'workspace'); const profileDir = path.join(sandbox, 'profile')
  for (const dir of [home, workspace, profileDir]) mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(workspace, 'review-draft.md'), '# 待审读稿件\n\n本文提出…\n', 'utf8')
  writeFileSync(path.join(workspace, 'manuscript.md'), '# 平台劳动短稿\n\n算法管理改变了劳动过程。\n', 'utf8')
  writeFileSync(path.join(workspace, 'funding-observation.json'), JSON.stringify({ contractVersion: 1, documentId: 'doc-eval', sourceFormat: 'pdf', sourceDigest: 'b'.repeat(64), extractedAt: Date.now() - 86400000, extractor: { name: 'eval', version: '1.0.0' }, pageCount: 1, pages: [{ pageNumber: 1, widthPt: 612, heightPt: 792, observedMarginsPt: null }], styles: [{ styleId: 's1', fontFamily: 'SimSun', fontSizePt: 14, fontWeight: 'bold', italic: false, alignment: 'left', lineSpacingPt: null, paragraphBeforePt: null, paragraphAfterPt: null }], blocks: [{ kind: 'paragraph', blockId: 'b1', pageNumber: 1, ordinal: 0, bounds: { x: 70, y: 70, width: 470, height: 20 }, text: '立项依据（不超过 2000 字）：', contentRole: 'instruction', styleId: 's1' }] }), 'utf8')
  const databasePath = path.join(profileDir, 'metis-data', 'metis.db')
  const rootConfig = path.join(profileDir, 'cordis.yml'); const patchFile = path.join(profileDir, 'metis.patch.yml')
  writeFileSync(rootConfig, '[]\n', 'utf8'); writeOverlay(patchFile, databasePath)
  process.env.DSH_HOME = home; process.env.DSH_PERMISSION_MODE = 'danger-full-access'
  const { boot, loadOverlayPatches } = await import('file:///' + path.join(CHECKOUT_ROOT, 'packages', 'boot', 'app-boot', 'src', 'index.ts').split(path.sep).join('/'))
  const basePatches = loadOverlayPatches('run-evals', BASE_BUNDLE_PATCH)
  const metisPatches = loadOverlayPatches('run-evals', patchFile)
  const ctx = await boot('dsh', rootConfig, [...basePatches, ...metisPatches])
  const turnTimeout = TURN_TIMEOUT_BY_TASK[task.id] ?? DEFAULT_TURN_TIMEOUT_MS
  try {
    const ws = await ctx.get('workspaceRegistry').create(workspace, `eval ${task.id}`)
    result.workspaceId = ws.id
    const sessionId = `metis-eval-${randomUUID()}`; result.sessionId = sessionId
    const handle = await ctx.get('agents').create({ sessionId, meta: { cwd: ws.path }, agentOptions: { provider: MODEL_PROVIDER, model: MODEL_ID } })
    for (const step of task.steps) { await sendAndAwaitIdle(ctx, handle.agent, step, turnTimeout) }
    const facts = sessionFacts(handle.agent)
    result.toolCalls = facts.toolCalls; result.toolFailures = facts.toolCalls.filter(c => c.failed).length; result.finalTextChars = facts.finalText.length
    const dataModule = await import('file:///' + path.join(CHECKOUT_ROOT, 'metis', 'shared', 'data', 'src', 'index.ts').split(path.sep).join('/'))
    const data = await dataModule.MetisDataStore.open(databasePath)
    const project = data.listProjects()[0]; result.projectId = project?.id ?? null
    const literature = project ? data.listLiterature(project.id) : []
    const artifacts = project ? data.listArtifacts({ projectId: project.id }) : []
    const claims = project ? data.listClaims({ projectId: project.id }) : []
    result.artifactIds = artifacts.map(a => a.id); result.literatureSaved = literature.length
    const coverage = artifacts[0] ? data.artifactEvidenceCheck(artifacts[0].id) : null
    result.researchQualityChecks = coverage ? { coverageRatio: coverage.coverageRatio, totalClaims: coverage.totalClaims } : null
    const cases = project ? data.listSubmissionCases(project.id) : []
    data.close()
    result.metrics = {
      taskCompleted: (task.expect.artifact ? artifacts.length > 0 : true) && literature.length >= task.expect.literatureMin && (task.expect.submissionCase ? cases.length > 0 : true),
      artifactCreated: artifacts.length > 0, citationsTotal: literature.length,
      citationsVerified: literature.filter(r => r.evidenceId).length,
      evidenceCoverage: coverage ? Number(coverage.coverageRatio.toFixed(2)) : null,
      unsupportedClaims: claims.filter(c => c.verificationState === 'unverified').length,
      toolErrors: result.toolFailures,
      providerFailures: facts.toolCalls.filter(c => c.name.startsWith('literature') && c.failed).length,
      finalTextChars: facts.finalText.length,
    }
    if (!result.metrics.taskCompleted) result.failures.push('任务交付物未完成')
    if (task.expect.artifact && artifacts.length === 0) result.failures.push('未登记 artifact')
    if (literature.length < task.expect.literatureMin) result.failures.push(`保存文献不足（${literature.length}/${task.expect.literatureMin}）`)
    if (task.expect.submissionCase && cases.length === 0) result.failures.push('未创建投稿案例')
    if (task.expect.templateId) {
      const data2 = await dataModule.MetisDataStore.open(databasePath)
      if (!data2.getFundingTemplate(task.expect.templateId)) result.failures.push(`模板未登记: ${task.expect.templateId}`)
      data2.close()
    }
    result.status = result.failures.length === 0 ? 'PASS' : 'FAIL'
    result.finishedAt = new Date().toISOString()
    await handle.dispose()
  } catch (error) {
    result.status = 'INTERRUPTED'; result.failureReason = error instanceof Error ? error.message : String(error)
    result.finishedAt = new Date().toISOString()
    try { await ctx.fiber.dispose() } catch {}
    writeTaskResult(result); return result
  } finally {
    try { await ctx.fiber.dispose() } catch {}
    if (result.status === 'PASS') rmSync(sandbox, { recursive: true, force: true })
    else console.log(`[eval ${task.id}] sandbox preserved: ${sandbox}`)
  }
  writeTaskResult(result); return result
}

function writeTaskResult(result) { writeFileSync(path.join(result.runDir ? path.join(EVALS_DIR, 'results', result.runDir) : '', `${result.evalId}.json`), JSON.stringify(result, null, 2) + '\n', 'utf8') }

async function main() {
  if (!process.env.CLOUDLOB_API_KEY) { console.log('[evals] BLOCKED_EXTERNAL: CLOUDLOB_API_KEY'); process.exit(0) }
  const args = process.argv.slice(2)
  let resumeRunDir = null; let onlyIds = []; let retryFailed = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resume' && args[i + 1]) resumeRunDir = args[++i]
    else if (args[i] === '--retry-failed') retryFailed = true
    else if (!args[i].startsWith('--')) onlyIds.push(args[i])
  }
  const tasks = JSON.parse(readFileSync(path.join(EVALS_DIR, 'tasks.json'), 'utf8')).tasks
  let selected = onlyIds.length > 0 ? tasks.filter(t => onlyIds.includes(t.id)) : tasks
  let runDir; let priorResults = {}
  if (resumeRunDir && existsSync(resumeRunDir)) {
    runDir = resumeRunDir; priorResults = readRunState(runDir)
    selected = selected.filter(t => { const p = priorResults[t.id]; if (!p) return true; if (p.status === 'PASS') return false; if (p.status === 'FAIL' && !retryFailed) return false; return true })
    console.log(`[evals] resuming: ${runDir} (${selected.length} to run)`)
  } else {
    runDir = path.join(EVALS_DIR, 'results', `run-${Date.now()}`)
    mkdirSync(runDir, { recursive: true })
    const commit = execSync('git rev-parse HEAD', { cwd: CHECKOUT_ROOT, encoding: 'utf8', shell: process.platform === 'win32' }).trim()
    writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ runId: path.basename(runDir), startedAt: new Date().toISOString(), commit, model: `${MODEL_PROVIDER}/${MODEL_ID}`, tasks: selected.map(t => t.id) }, null, 2) + '\n', 'utf8')
    console.log(`[evals] new run: ${runDir} (${selected.length} tasks)`)
  }
  const results = []
  for (const task of selected) {
    console.log(`\n[eval] running ${task.id} (${task.discipline})`)
    const result = await runSingleTask(task, runDir, 1)
    console.log(`[eval] ${task.id}: ${result.status}${result.failures?.length > 0 ? ' — ' + result.failures.join('; ') : ''}`)
    results.push(result)
  }
  const allResults = tasks.tasks.map(t => results.find(r => r.evalId === t.id) ?? priorResults[t.id] ?? { evalId: t.id, status: 'PENDING', metrics: {} })
  const output = { schemaVersion: 2, generatedAt: new Date().toISOString(), model: `${MODEL_PROVIDER}/${MODEL_ID}`, runDir, summary: { total: allResults.length, pass: allResults.filter(r => r.status === 'PASS').length, fail: allResults.filter(r => r.status === 'FAIL').length, interrupted: allResults.filter(r => r.status === 'INTERRUPTED').length, pending: allResults.filter(r => r.status === 'PENDING').length }, results: allResults }
  writeFileSync(path.join(runDir, 'run-summary.json'), JSON.stringify(output, null, 2) + '\n', 'utf8')
  writeFileSync(path.join(EVALS_DIR, 'results-latest.json'), JSON.stringify(output, null, 2) + '\n', 'utf8')
  if (output.summary.fail > 0 || output.summary.pending > 0) { console.log(`\n[evals] ${output.summary.fail} FAIL, ${output.summary.pending} PENDING`); process.exit(1) }
  console.log(`\n[evals] all ${output.summary.pass} tasks PASS`)
}

void main().catch(error => { console.error('[evals] crashed:', error); process.exit(1) })
