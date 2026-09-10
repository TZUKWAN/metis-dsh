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
import { parseLetPubJournalList } from './journal-catalog.ts'
import { aggregateVenueCandidates } from './journal-targeting.ts'
import type { CatalogJournalSummary } from './journal-catalog.ts'

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
      return { total: journals.length, journals }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'journal_targeting_match',
    description: '基于「主题相关近期论文的发表期刊」聚合选刊候选。输入一组论文（题名/期刊/年份），输出候选期刊与核心层级标注（白名单判定，非模型推断）。',
    parameters: {
      papers: { type: 'json', description: '论文数组 [{ title, venue, year }]', required: true },
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
      const papers = Array.isArray(args.papers) ? args.papers : []
      const candidates = aggregateVenueCandidates(papers)
      return { candidates }
    },
  }))
}

// 服务声明合并：ctx.metisSubmission。
declare module '@deepseek-ai/cordis' {
  interface Context {
    metisSubmission: MetisSubmission
  }
}
