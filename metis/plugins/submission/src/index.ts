/**
 * dsh-metis-submission — 学术投稿领域插件。
 *
 * 期刊记录 / 投稿要求 / 投稿案例持久化到 MetisDataStore（v2 schema）。
 * 诚实边界：
 * - 影响因子/录用率/审稿周期等指标不允许凭模型记忆产生——只透出来源字段；
 * - 投稿要求必须带 verificationState（官网核验前为 unverified）；
 * - LetPub 检索遵守 exec.signal 取消，失败 fail-loud；
 * - 领域级失败以统一 { ok:false, error:{ code, message, retryable } } 返回。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  MetisDataStore,
  resolveMetisDatabasePath,
  SUBMISSION_CASE_STATUSES,
  type SubmissionCaseRecord,
  type SubmissionCaseStatus,
} from '../../../shared/data/src/index.ts'
import type { MetisResearch } from '../../core/src/index.ts'
import { normalizeJsonRecordArg, requireStringArg } from '../../../shared/contracts/src/index.ts'
import {
  SUBMISSION_TARGETING_LANGUAGES,
  SUBMISSION_VENUE_CATEGORIES,
  type SubmissionTargetingLanguage,
  type SubmissionVenueCategory,
  type TargetingCriteria,
} from './targeting-criteria.ts'
import { parseLetPubJournalList } from './journal-catalog.ts'
import { aggregateVenueCandidates } from './journal-targeting.ts'
import type { CatalogJournalSummary } from './journal-catalog.ts'
import type { MatchInputPaper } from './journal-targeting.ts'

export interface Config {
  /** LetPub 目录页抓取的每页条数（由 parser 分页逻辑使用）。 */
  pageSize?: number
  /** 统一 metis.db 路径（与 core/evidence/literature/scenario/artifact/funding 对齐）。 */
  databasePath?: string
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function parseCaseStatus(value: unknown): SubmissionCaseStatus {
  if (!(SUBMISSION_CASE_STATUSES as readonly string[]).includes(value as string)) {
    throw new Error(`status 必须是 ${SUBMISSION_CASE_STATUSES.join('/')}。`)
  }
  return value as SubmissionCaseStatus
}

export class MetisSubmission extends Service {
  static inject = ['tools', 'metisResearch']

  private readonly data: Promise<MetisDataStore>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'metisSubmission')
    this.data = MetisDataStore.open(resolveMetisDatabasePath(config.databasePath)).then((store) => {
      ctx.effect(() => () => store.close(), 'metisSubmission.databaseClose')
      return store
    })
    registerTools(ctx, this)
  }

  private async store(): Promise<MetisDataStore> {
    return await this.data
  }

  /**
   * 用真实 fetch 抓取 LetPub 检索列表页并解析为结构化期刊摘要。
   * 失败时抛错（fail-loud），不返回伪成功。遵守取消信号。
   */
  async searchLetPub(query: string, page: number, signal?: AbortSignal): Promise<CatalogJournalSummary[]> {
    const url = `https://www.letpub.com.cn/index.php?page=journalapp&view=search&searchname=${encodeURIComponent(query)}&currentsearchpage=${page}`
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Metis/0.1', Accept: 'text/html' },
      signal,
    })
    if (!response.ok) {
      throw new Error(`LetPub 检索失败: http_${response.status}`)
    }
    const html = await response.text()
    const parsed = parseLetPubJournalList(html, page)
    return parsed.journals
  }

  async saveJournal(input: { journalId?: string; source: string; sourceId?: string; journal: JsonValue; verificationState?: string }): Promise<string> {
    return (await this.store()).upsertJournalRecord({
      ...(input.journalId === undefined ? {} : { journalId: input.journalId }),
      source: input.source,
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
      journal: input.journal,
      ...(input.verificationState === undefined ? {} : { verificationState: input.verificationState as never }),
    })
  }

  async getJournal(journalId: string) {
    return (await this.store()).getJournalRecord(journalId)
  }

  async setRequirements(journalId: string, requirements: JsonValue, verificationState: string): Promise<string> {
    return (await this.store()).setJournalRequirements(journalId, requirements, verificationState as never)
  }

  async getRequirements(journalId: string) {
    return (await this.store()).getJournalRequirements(journalId)
  }

  async createCase(input: { projectId?: string | null; artifactId?: string | null; journalId?: string | null; notes?: string }): Promise<SubmissionCaseRecord> {
    return (await this.store()).createSubmissionCase(input)
  }

  async getCase(id: string): Promise<SubmissionCaseRecord | null> {
    return (await this.store()).getSubmissionCase(id)
  }

  async listCases(projectId?: string): Promise<SubmissionCaseRecord[]> {
    return (await this.store()).listSubmissionCases(projectId)
  }

  async updateCase(id: string, patch: { status?: SubmissionCaseStatus; notes?: string; journalId?: string | null; artifactId?: string | null }): Promise<SubmissionCaseRecord | null> {
    return (await this.store()).updateSubmissionCase(id, patch)
  }

  async recordMatch(input: { artifactId: string; journalId: string; score?: number }): Promise<void> {
    await (await this.store()).recordArtifactJournalMatch(input)
  }

  async gapCheck(id: string) {
    return (await this.store()).submissionGapCheck(id)
  }
}

export default {
  name: 'metis-submission',
  inject: ['tools', 'metisResearch'],
  apply(ctx: Context, config?: Config): void {
    ctx.plugin(MetisSubmission, config ?? {})
  },
}

function registerTools(ctx: Context, service: MetisSubmission): void {
  ctx.tools.register(defineTool({
    name: 'journal_search',
    description: '在真实期刊目录（LetPub）中按名称/主题检索期刊。返回结构化条目；指标类信息只透出来源字段，不用模型记忆补充。',
    parameters: {
      query: { type: 'string', description: '期刊名称或主题关键词', required: true },
      page: { type: 'number', description: '页码（默认 1）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          total: { type: 'integer', description: '命中条数' },
          journals: { type: 'array', items: { type: 'json' }, description: '期刊条目' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec: ToolRunContext) => {
      const query = String(args.query ?? '').trim()
      if (!query) return { total: 0, journals: [] }
      const journals = await service.searchLetPub(query, Math.max(1, Math.floor(Number(args.page ?? 1)) || 1), exec.signal)
      return { total: journals.length, journals: journals.map(toJson) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'journal_targeting_match',
    description: '基于「主题相关近期论文的发表期刊」聚合选刊候选。输入一组论文（题名/期刊/年份），输出候选期刊与核心层级标注（白名单判定，非模型推断）。',
    parameters: {
      papers: { type: 'json', description: '论文数组 [{ title, venue, year, source, doi?, issn? }]', required: true },
      criteria: { type: 'json', description: '选刊条件 { categories, language, notes }', required: true },
      currentYear: { type: 'number', description: '当前年份（缺省取运行年份）' },
      limit: { type: 'number', description: '返回候选上限（缺省 20）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          candidates: { type: 'array', items: { type: 'json' }, description: '候选期刊（按匹配度排序）' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      if (!Array.isArray(args.papers)) throw new Error('papers 必须是论文数组。')
      const papers = args.papers.map((paper: JsonValue, index: number) => parseMatchPaper(paper, index))
      if (args.criteria === null || typeof args.criteria !== 'object' || Array.isArray(args.criteria)) {
        throw new Error('criteria 必须是 { categories, language, notes } 对象。')
      }
      const criteria = parseCriteria(args.criteria as Record<string, JsonValue>)
      const candidates = aggregateVenueCandidates({
        papers,
        criteria,
        ...(typeof args.currentYear === 'number' ? { currentYear: args.currentYear } : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      })
      return { ok: true as const, error: null as null, candidates: candidates.map(toJson) }
    },
  }))

  registerPersistenceTools(ctx, service)
}

function registerPersistenceTools(ctx: Context, service: MetisSubmission): void {
  const research: MetisResearch = ctx.metisResearch
  void research

  const projectScope = async (
    researchScope: MetisResearch,
    exec: ToolRunContext,
    args: { projectId?: unknown },
  ): Promise<string | undefined> => {
    if (args.projectId === undefined) return undefined
    const project = await researchScope.requireCurrentProject(exec.agent, String(args.projectId))
    return project.id
  }

  ctx.tools.register(defineTool({
    name: 'journal_record',
    description: '把一个候选期刊登记为可追踪的 Journal 记录（带来源与验证状态）。返回 journalId，供 requirements/case/match 引用。只登记有来源的字段。',
    parameters: {
      journal: { type: 'json', description: '期刊信息对象（名称/ISSN/官网/已知要求等）', required: true },
      source: { type: 'string', description: '信息来源（如 letpub / official-site / user）', required: true },
      sourceId: { type: 'string', description: '来源内部 id（可选）' },
      journalId: { type: 'string', description: '更新已有记录时提供' },
      verificationState: { type: 'string', description: 'unverified/verified/conflicting（缺省 unverified）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, journalId: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const journal = normalizeJsonRecordArg(args.journal, 'journal')
      const source = requireStringArg(args.source, 'source')
      const journalId = await service.saveJournal({
        ...(args.journalId === undefined ? {} : { journalId: requireStringArg(args.journalId, 'journalId') }),
        source,
        ...(args.sourceId === undefined ? {} : { sourceId: requireStringArg(args.sourceId, 'sourceId') }),
        journal: toJson(journal),
        ...(args.verificationState === undefined ? {} : { verificationState: String(args.verificationState) }),
      })
      return { ok: true as const, journalId, error: null as null }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'journal_get',
    description: '读取一个 Journal 记录（含验证状态与全部历史要求集）。',
    parameters: { journalId: { type: 'string', description: 'Journal id', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { found: { type: 'boolean' }, journal: { type: 'json' }, requirementSets: { type: 'array', items: { type: 'json' } } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const journalId = requireStringArg(args.journalId, 'journalId')
      const journal = await service.getJournal(journalId)
      if (!journal) {
        return {
          found: false,
          journal: null,
          requirementSets: [],
          ok: false as const,
          error: { code: 'NOT_FOUND' as const, message: `Journal 不存在: ${journalId}`, retryable: false },
        }
      }
      const requirementSets = await service.getRequirements(journalId)
      return { found: true, ok: true as const, error: null as null, journal: toJson(journal), requirementSets: requirementSets.map(toJson) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'journal_verify',
    description: '记录一次对期刊记录的核验动作（如访问官网确认）。核验来源与结论持久化；verified 会在 journal 上留 verifiedVia 标记。',
    parameters: {
      journalId: { type: 'string', description: 'Journal id', required: true },
      source: { type: 'string', description: '核验来源（如 official-site）', required: true },
      verificationState: { type: 'string', description: '核验结论：verified/conflicting/unverified', required: true },
      note: { type: 'string', description: '核验说明（可选）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, journal: { type: 'json' }, error: { type: 'json' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const journalId = requireStringArg(args.journalId, 'journalId')
      const source = requireStringArg(args.source, 'source')
      const verificationState = String(args.verificationState)
      if (!['verified', 'conflicting', 'unverified'].includes(verificationState)) {
        return {
          ok: false as const,
          journal: null,
          error: { code: 'INVALID_INPUT' as const, message: `verificationState 必须是 verified/conflicting/unverified，收到: ${verificationState}`, retryable: false },
        }
      }
      const existing = await service.getJournal(journalId)
      if (!existing) {
        return {
          ok: false as const,
          journal: null,
          error: { code: 'NOT_FOUND' as const, message: `Journal 不存在: ${journalId}`, retryable: false },
        }
      }
      const journal: Record<string, unknown> = { ...(existing.journal as Record<string, unknown>) }
      if (verificationState === 'verified') journal['verifiedVia'] = source
      if (args.note !== undefined) journal['verificationNote'] = String(args.note)
      await service.saveJournal({ journalId, source, journal: toJson(journal), verificationState })
      return { ok: true as const, journal: toJson(await service.getJournal(journalId)), error: '' as string }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'journal_requirements_set',
    description: '登记一个期刊的投稿要求集（字数/格式/匿名/摘要/图表/链接等）。每个要求集必须带验证状态；官网核验前为 unverified，与官网冲突时标 conflicting。',
    parameters: {
      journalId: { type: 'string', description: 'Journal id', required: true },
      requirements: { type: 'json', description: '要求集合（对象或数组，键为要求名）', required: true },
      verificationState: { type: 'string', description: 'unverified/verified/conflicting', required: true },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, requirementSetId: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const journalId = requireStringArg(args.journalId, 'journalId')
      const verificationState = String(args.verificationState)
      if (!['unverified', 'verified', 'conflicting'].includes(verificationState)) {
        return {
          ok: false as const,
          requirementSetId: '',
          error: { code: 'INVALID_INPUT' as const, message: `verificationState 必须是 unverified/verified/conflicting，收到: ${verificationState}`, retryable: false },
        }
      }
      const requirements = toJson(normalizeJsonRecordArg(args.requirements, 'requirements'))
      const requirementSetId = await service.setRequirements(journalId, requirements, verificationState)
      return { ok: true as const, requirementSetId, error: null as null }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'journal_requirements',
    description: '读取一个期刊的全部历史要求集（含各集验证状态，供冲突比对）。',
    parameters: { journalId: { type: 'string', description: 'Journal id', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { total: { type: 'integer' }, requirementSets: { type: 'array', items: { type: 'json' } } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const sets = await service.getRequirements(requireStringArg(args.journalId, 'journalId'))
      return { total: sets.length, requirementSets: sets.map(toJson) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'journal_artifact_match',
    description: '把一个 Artifact 与一个 Journal 的选刊关系登记为持久化匹配记录（可带评分）。',
    parameters: {
      artifactId: { type: 'string', description: 'Artifact id', required: true },
      journalId: { type: 'string', description: 'Journal id', required: true },
      score: { type: 'number', description: '匹配评分（可选）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      await service.recordMatch({
        artifactId: requireStringArg(args.artifactId, 'artifactId'),
        journalId: requireStringArg(args.journalId, 'journalId'),
        ...(typeof args.score === 'number' ? { score: args.score } : {}),
      })
      return { ok: true as const, error: null as null }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'submission_case_create',
    description: '创建投稿案例（researching 起点的持久化生命周期）。项目关联只能指向当前 DSH Workspace/Session 已绑定项目。',
    parameters: {
      projectId: { type: 'string', description: '可选；只能重复当前 session 已绑定项目 id' },
      artifactId: { type: 'string', description: '关联 Artifact' },
      journalId: { type: 'string', description: '关联 Journal' },
      notes: { type: 'string', description: '备注' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, caseRecord: { type: 'json' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec: ToolRunContext) => {
      const project = await projectScope(research, exec, args)
      const caseRecord = await service.createCase({
        projectId: project ?? null,
        ...(args.artifactId === undefined ? {} : { artifactId: requireStringArg(args.artifactId, 'artifactId') }),
        ...(args.journalId === undefined ? {} : { journalId: requireStringArg(args.journalId, 'journalId') }),
        ...(args.notes === undefined ? {} : { notes: String(args.notes) }),
      })
      return { ok: true as const, error: null as null, caseRecord: toJson(caseRecord) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'submission_case_get',
    description: '读取一个投稿案例。',
    parameters: { id: { type: 'string', description: '案例 id', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { found: { type: 'boolean' }, caseRecord: { type: 'json' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const caseRecord = await service.getCase(requireStringArg(args.id, 'id'))
      if (!caseRecord) {
        return { found: false as const, ok: false as const, error: null as null, caseRecord: null }
      }
      return { found: true, ok: true as const, error: null as null, caseRecord: toJson(caseRecord) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'submission_case_update',
    description: '更新投稿案例状态/备注/关联。状态机：researching/candidate/preparing/ready/submitted/revision/accepted/rejected/withdrawn。',
    parameters: {
      id: { type: 'string', description: '案例 id', required: true },
      status: { type: 'string', description: `新状态（${SUBMISSION_CASE_STATUSES.join('/')}）` },
      notes: { type: 'string', description: '备注' },
      journalId: { type: 'string', description: '改绑 Journal' },
      artifactId: { type: 'string', description: '改绑 Artifact' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, caseRecord: { type: 'json' }, error: { type: 'json' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const updated = await service.updateCase(requireStringArg(args.id, 'id'), {
        ...(args.status === undefined ? {} : { status: parseCaseStatus(args.status) }),
        ...(args.notes === undefined ? {} : { notes: String(args.notes) }),
        ...(args.journalId === undefined ? {} : { journalId: requireStringArg(args.journalId, 'journalId') }),
        ...(args.artifactId === undefined ? {} : { artifactId: requireStringArg(args.artifactId, 'artifactId') }),
      })
      if (!updated) {
        return {
          ok: false as const,
          caseRecord: null,
          error: { code: 'NOT_FOUND' as const, message: `案例不存在: ${String(args.id)}`, retryable: false },
        }
      }
      return { ok: true, caseRecord: toJson(updated), error: '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'submission_case_list',
    description: '列出投稿案例（可按当前项目过滤）。',
    parameters: { projectId: { type: 'string', description: '可选；只能重复当前 session 已绑定项目 id' } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { total: { type: 'integer' }, cases: { type: 'array', items: { type: 'json' } } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec: ToolRunContext) => {
      const project = await projectScope(research, exec, args)
      const cases = await service.listCases(project ?? undefined)
      return { total: cases.length, cases: cases.map(toJson) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'submission_gap_check',
    description: '对一个投稿案例做第一版差距检查：要求集验证状态（unverified/conflicting 计数）与 Artifact 元数据缺失键。启发式，诚实标注，不编造符合结论。',
    parameters: { id: { type: 'string', description: '案例 id', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { report: { type: 'json' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const report = await service.gapCheck(requireStringArg(args.id, 'id'))
      return { report: toJson(report) }
    },
  }))
}

function parseMatchPaper(value: JsonValue, index: number): MatchInputPaper {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`papers[${index}] 必须是 { title, venue, year, source } 对象。`)
  }
  const paper = value as Record<string, JsonValue>
  const title = typeof paper['title'] === 'string' ? paper['title'].trim() : ''
  const venue = typeof paper['venue'] === 'string' ? paper['venue'].trim() : ''
  const year = typeof paper['year'] === 'number' ? paper['year'] : Number(paper['year'])
  const source = typeof paper['source'] === 'string' ? paper['source'].trim() : ''
  if (!title || !venue || !source || !Number.isFinite(year)) {
    throw new Error(`papers[${index}] 缺少必填字段 title/venue/year/source。`)
  }
  return {
    title,
    venue,
    year: Math.floor(year),
    source,
    ...(typeof paper['doi'] === 'string' && paper['doi'] ? { doi: paper['doi'] } : {}),
    ...(typeof paper['issn'] === 'string' && paper['issn'] ? { issn: paper['issn'] } : {}),
  }
}

function parseCriteria(value: Record<string, JsonValue>): TargetingCriteria {
  const rawCategories = value['categories']
  if (!Array.isArray(rawCategories)) throw new Error('criteria.categories 必须是数组。')
  const categories = rawCategories.map((item, index) => {
    if (typeof item !== 'string' || !(SUBMISSION_VENUE_CATEGORIES as readonly string[]).includes(item)) {
      throw new Error(`criteria.categories[${index}] 不是合法层级（${SUBMISSION_VENUE_CATEGORIES.join('/')}）。`)
    }
    return item as SubmissionVenueCategory
  })
  const language = typeof value['language'] === 'string' && (SUBMISSION_TARGETING_LANGUAGES as readonly string[]).includes(value['language'])
    ? value['language'] as SubmissionTargetingLanguage
    : 'any'
  return {
    categories,
    language,
    notes: typeof value['notes'] === 'string' ? value['notes'] : '',
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    metisSubmission: MetisSubmission
  }
}
