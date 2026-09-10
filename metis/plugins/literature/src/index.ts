/**
 * dsh-metis-literature — Literature 能力核心（Phase 11）。
 *
 * 职责：统一 LiteratureRecord 模型、provider 注册表、面向模型的检索/保存工具。
 * 不绑定具体来源——来源由 literature-crossref / literature-openalex /
 * literature-ncpssd 等 provider 插件提供。
 *
 * Evidence 联动（T11-037 / T10-022）：literature_save 通过 `metisEvidence`
 * 服务显式登记证据（inject 声明依赖），不做全局 hook 拦截。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { LiteratureRegistry } from './registry.ts'

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** 领域记录 → 无损 JSON（canonical 输出，显式 JsonValue 形态）。 */
function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
import { normalizeDoi, SEARCH_HARD_CAP, type LiteratureRecord } from './domain.ts'

// 领域契约再导出（provider 插件从此处导入，形成 literature ← provider 依赖方向）。
export { normalizeDoi, ProviderUnavailableError, SEARCH_HARD_CAP } from './domain.ts'
export type { LiteratureProvider, LiteratureRecord, LiteratureSearchOptions } from './domain.ts'

export interface Config {
  /** 单次检索默认返回条数。 */
  defaultLimit?: number
}


/** evidence 插件的最小桥接口（避免跨插件硬依赖；运行时由 ctx 提供）。 */
interface EvidenceRegistrationBridge {
  storeService: {
    registerObservation(input: {
      projectId?: string | null
      sourceType: 'literature'
      source: { provider: string; sourceId?: string }
      title: string
      doi?: string
      url?: string
      createdByTool: string
    }): { record: { id: string }; duplicate: boolean }
  }
}

export interface MetisLiteratureService {
  registry: LiteratureRegistry
  saved: LiteratureRecord[]
  save(records: LiteratureRecord[], projectId?: string | null): LiteratureRecord[]
  listSaved(projectId?: string | null): LiteratureRecord[]
}

export class MetisLiterature extends Service {
  readonly registry = new LiteratureRegistry()
  /** 已保存进项目的文献（Phase 25 迁 SQLite 持久化；当前内存态 + Known Limitations 标注）。 */
  private readonly savedRecords: LiteratureRecord[] = []
  private readonly defaultLimit: number

  constructor(ctx: Context, config: Config) {
    super(ctx, 'metisLiterature')
    this.defaultLimit = Math.min(Math.max(config.defaultLimit ?? 10, 1), SEARCH_HARD_CAP)
  }

  save(records: LiteratureRecord[], projectId?: string | null): LiteratureRecord[] {
    const evidence = (this.ctx as unknown as { metisEvidence?: EvidenceRegistrationBridge }).metisEvidence
    const saved: LiteratureRecord[] = []
    for (const record of records) {
      let evidenceId: string | undefined
      if (evidence) {
        const registered = evidence.storeService.registerObservation({
          projectId: projectId ?? null,
          sourceType: 'literature',
          source: { provider: record.source, sourceId: record.sourceId },
          title: record.title,
          doi: record.doi,
          url: record.url,
          createdByTool: 'literature_save',
        })
        evidenceId = registered.record.id
      }
      const existingIndex = this.savedRecords.findIndex((item) => {
        const a = normalizeDoi(item.doi)
        const b = normalizeDoi(record.doi)
        if (a && b) return a === b
        return item.source === record.source && item.sourceId === record.sourceId
      })
      const merged: LiteratureRecord = {
        ...record,
        ...(projectId !== undefined ? { projectId: projectId ?? null } : {}),
        ...(evidenceId ? { evidenceId } : {}),
      }
      if (existingIndex >= 0) this.savedRecords[existingIndex] = merged
      else this.savedRecords.push(merged)
      saved.push(merged)
    }
    return saved
  }

  listSaved(projectId?: string | null): LiteratureRecord[] {
    return projectId === undefined
      ? [...this.savedRecords]
      : this.savedRecords.filter((record) => record.projectId === projectId)
  }

  get defaultLimitValue(): number {
    return this.defaultLimit
  }
}

export default function apply(ctx: Context, config?: Config): void {
  const service = new MetisLiterature(ctx, config ?? {})
  ctx.metisLiterature = service

  ctx.tools.register(defineTool({
    name: 'literature_search',
    description: '在已安装的真实文献来源（Crossref/OpenAlex/NCPSSD 等注册 provider）中检索文献。返回结构化记录（DOI/作者/年份/来源），不包含任何模型臆造的条目。',
    parameters: {
      query: { type: 'string', description: '检索词（主题/概念/理论/机制/学者均可）', required: true },
      limit: { type: 'number', description: `返回条数（1-${SEARCH_HARD_CAP}）` },
      providers: { type: 'string', description: '逗号分隔的 provider 名过滤（如 crossref,openalex）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          total: { type: 'integer', description: '返回条数' },
          records: { type: 'array', items: { type: 'json' }, description: '文献记录' },
          providersUsed: { type: 'array', items: { type: 'string' }, description: '实际使用的 provider' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const limit = Math.min(Math.max(Math.floor(Number(args.limit ?? service.defaultLimitValue)) || service.defaultLimitValue, 1), SEARCH_HARD_CAP)
      const filter = typeof args.providers === 'string' && args.providers.trim()
        ? args.providers.split(',').map((item: string) => item.trim()).filter(Boolean)
        : undefined
      const providers = service.registry.resolveProviders(filter)
      const settled = await Promise.allSettled(
        providers.map((provider) => provider.search({ query: args.query, limit })),
      )
      const records: LiteratureRecord[] = []
      const failures: string[] = []
      settled.forEach((outcome, index) => {
        if (outcome.status === 'fulfilled') records.push(...outcome.value)
        else failures.push(`${providers[index]?.name ?? 'unknown'}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`)
      })
      const merged = service.registry.merge(records).slice(0, limit)
      return {
        total: merged.length,
        records: merged.map(toJson),
        providersUsed: providers.map((provider) => provider.name),
        ...(failures.length > 0 ? { providerFailures: failures } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'literature_save',
    description: '把文献保存进当前科研项目（并自动登记证据）。保存后可通过 literature_search_project 检索。',
    parameters: {
      projectId: { type: 'string', description: '目标科研项目 id（缺省保存为未归属）' },
      records: { type: 'json', description: '要保存的文献记录数组（通常来自 literature_search 的 records）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          saved: { type: 'integer', description: '保存条数' },
          records: { type: 'array', items: { type: 'json' }, description: '保存后的记录（含 evidenceId）' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const input = args.records
      if (!Array.isArray(input)) throw new Error('records 必须是文献记录数组。')
      const saved = service.save(input as unknown as LiteratureRecord[], args.projectId ?? null)
      return { saved: saved.length, records: saved.map(toJson) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'literature_search_project',
    description: '检索当前科研项目已保存的文献。',
    parameters: {
      projectId: { type: 'string', description: '项目 id 过滤（缺省返回全部已保存）' },
      query: { type: 'string', description: '标题/关键词过滤（包含匹配）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          total: { type: 'integer', description: '命中条数' },
          records: { type: 'array', items: { type: 'json' }, description: '文献记录' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      let records = service.listSaved(args.projectId ?? undefined)
      if (args.query) {
        const needle = args.query.toLowerCase()
        records = records.filter((record) =>
          record.title.toLowerCase().includes(needle)
          || (record.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(needle)))
      }
      return { total: records.length, records: records.map(toJson) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'literature_get',
    description: '按 DOI 精确获取文献（走 provider 的权威接口，可用于核验 DOI 真实性）。',
    parameters: {
      doi: { type: 'string', description: 'DOI（支持 https://doi.org/ 前缀）', required: true },
      providers: { type: 'string', description: 'provider 过滤（可选）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          found: { type: 'boolean', description: '是否找到' },
          record: { type: 'json', description: '文献记录' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const doi = normalizeDoi(args.doi)
      if (!doi) throw new Error('doi 不能为空。')
      const providers = service.registry.resolveProviders(
        typeof args.providers === 'string' && args.providers.trim()
          ? args.providers.split(',').map((item: string) => item.trim()).filter(Boolean)
          : undefined,
      )
      for (const provider of providers) {
        if (!provider.getByDoi) continue
        const record = await provider.getByDoi(doi)
        if (record) return { found: true, record: toJson(record) }
      }
      return { found: false, record: null }
    },
  }))
}

// 服务声明合并：ctx.metisLiterature。
declare module '@deepseek-ai/cordis' {
  interface Context {
    metisLiterature: MetisLiterature
  }
}
