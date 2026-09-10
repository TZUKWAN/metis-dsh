/**
 * dsh-metis-submission — 学术投稿领域插件（Phase 21 / T21）。
 *
 * 领域资产迁移（语义保持）：
 * - journal-catalog.ts：LetPub/eshukan 目录 HTML parser（纯函数，fetcher 可注入）；
 * - journal-targeting.ts：选刊匹配（基于主题相关近期论文的期刊聚合 + 白名单层级标注）；
 * - submission-contract.ts：投稿生命周期 zod 契约（Series/Case/状态转移）。
 *
 * 诚实边界（规格/任务清单 T21-019、27.2）：
 * - 影响因子/录用率/审稿周期等指标**不允许凭模型记忆产生**——只透出有来源的字段；
 * - 无法核验的要求标 unverified；
 * - LetPub/万维门户的交互式抓取标 DEFERRED（第一版以 web_fetch + parser 完成）。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { parseLetPubJournalList } from './journal-catalog.ts'
import { aggregateVenueCandidates } from './journal-targeting.ts'
import type { CatalogJournalSummary } from './journal-catalog.ts'
import {
  SUBMISSION_TARGETING_LANGUAGES,
  SUBMISSION_VENUE_CATEGORIES,
  type SubmissionTargetingLanguage,
  type SubmissionVenueCategory,
  type TargetingCriteria,
} from './targeting-criteria.ts'
import type { MatchInputPaper } from './journal-targeting.ts'

export interface Config {
  /** LetPub 目录页抓取的每页条数（由 parser 分页逻辑使用）。 */
  pageSize?: number
}

export class MetisSubmission extends Service {
  constructor(ctx: Context, config?: Config) {
    super(ctx, 'metisSubmission')
    void config
  }

  /**
   * 用真实 fetch 抓取 LetPub 检索列表页并解析为结构化期刊摘要。
   * 失败时抛错（fail-loud），不返回伪成功。
   */
  async searchLetPub(query: string, page: number): Promise<CatalogJournalSummary[]> {
    const url = `https://www.letpub.com.cn/index.php?page=journalapp&view=search&searchname=${encodeURIComponent(query)}&currentsearchpage=${page}`
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Metis/0.1', Accept: 'text/html' },
    })
    if (!response.ok) {
      throw new Error(`LetPub 检索失败: http_${response.status}`)
    }
    const html = await response.text()
    const parsed = parseLetPubJournalList(html, page)
    return parsed.journals
  }
}

export default function apply(ctx: Context, config?: Config): void {
  const service = new MetisSubmission(ctx, config)
  ctx.metisSubmission = service

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
    execute: async (args) => {
      const query = String(args.query ?? '').trim()
      if (!query) return { total: 0, journals: [] }
      const journals = await service.searchLetPub(query, Math.max(1, Math.floor(Number(args.page ?? 1)) || 1))
      return { total: journals.length, journals: journals.map(toJson) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'journal_targeting_match',
    description: '基于「主题相关近期论文的发表期刊」聚合选刊候选。输入一组论文（题名/期刊/年份），输出候选期刊与核心层级标注（白名单判定，非模型推断）。',
    parameters: {
      papers: { type: 'json', description: '选刊请求 { papers: [{ title, venue, year, source, doi?, issn? }], criteria: { categories, language, notes }, currentYear?, limit? }', required: true },
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
      const request = parseTargetingRequest(args.papers)
      const candidates = aggregateVenueCandidates(request)
      return { candidates: candidates.map(toJson) }
    },
  }))
}

function parseTargetingRequest(value: JsonValue): {
  papers: MatchInputPaper[]
  criteria: TargetingCriteria
  currentYear?: number
  limit?: number
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('papers 必须是 { papers, criteria } 形式的选刊匹配请求。')
  }
  const request = value as Record<string, JsonValue>
  const rawPapers = request['papers']
  const rawCriteria = request['criteria']
  if (!Array.isArray(rawPapers) || rawCriteria === null || typeof rawCriteria !== 'object' || Array.isArray(rawCriteria)) {
    throw new Error('选刊请求必须包含 papers 数组和 criteria 对象。')
  }
  const papers = rawPapers.map((paper, index) => parseMatchPaper(paper, index))
  const criteria = parseCriteria(rawCriteria as Record<string, JsonValue>)
  const currentYear = request['currentYear']
  const limit = request['limit']
  if (currentYear !== undefined && (typeof currentYear !== 'number' || !Number.isInteger(currentYear) || currentYear < 1)) {
    throw new Error('currentYear 必须是正整数。')
  }
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw new Error('limit 必须是 1-100 的整数。')
  }
  return {
    papers,
    criteria,
    ...(typeof currentYear === 'number' ? { currentYear } : {}),
    ...(typeof limit === 'number' ? { limit } : {}),
  }
}

function parseMatchPaper(value: JsonValue, index: number): MatchInputPaper {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`papers[${index}] 必须是对象。`)
  }
  const paper = value as Record<string, JsonValue>
  const title = stringField(paper, 'title', `papers[${index}]`)
  const venue = stringField(paper, 'venue', `papers[${index}]`)
  const source = stringField(paper, 'source', `papers[${index}]`)
  const year = paper['year']
  if (typeof year !== 'number' || !Number.isInteger(year) || year < 1) {
    throw new Error(`papers[${index}].year 必须是正整数。`)
  }
  const doi = optionalStringField(paper, 'doi', `papers[${index}]`)
  const issn = optionalStringField(paper, 'issn', `papers[${index}]`)
  return { title, venue, source, year, ...(doi ? { doi } : {}), ...(issn ? { issn } : {}) }
}

function parseCriteria(value: Record<string, JsonValue>): TargetingCriteria {
  const categories = value['categories']
  if (!Array.isArray(categories) || categories.length === 0 || !categories.every((entry) =>
    typeof entry === 'string' && (SUBMISSION_VENUE_CATEGORIES as readonly string[]).includes(entry))) {
    throw new Error('criteria.categories 必须是一个或多个受支持的投稿类别。')
  }
  const language = value['language']
  if (typeof language !== 'string' || !(SUBMISSION_TARGETING_LANGUAGES as readonly string[]).includes(language)) {
    throw new Error('criteria.language 必须是 zh、en 或 any。')
  }
  const notes = optionalStringField(value, 'notes', 'criteria') ?? ''
  return {
    categories: categories as SubmissionVenueCategory[],
    language: language as SubmissionTargetingLanguage,
    notes,
  }
}

function stringField(value: Record<string, JsonValue>, field: string, label: string): string {
  const candidate = value[field]
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error(`${label}.${field} 必须是非空字符串。`)
  return candidate.trim()
}

function optionalStringField(value: Record<string, JsonValue>, field: string, label: string): string | undefined {
  const candidate = value[field]
  if (candidate === undefined) return undefined
  if (typeof candidate !== 'string') throw new Error(`${label}.${field} 必须是字符串。`)
  return candidate.trim() || undefined
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

// 服务声明合并：ctx.metisSubmission。
declare module '@deepseek-ai/cordis' {
  interface Context {
    metisSubmission: MetisSubmission
  }
}
