import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { MetisDataStore, resolveMetisDatabasePath } from '../../../shared/data/src/index.ts'
import type { MetisResearch } from '../../core/src/index.ts'
import { LiteratureRegistry } from './registry.ts'
import { normalizeDoi, SEARCH_HARD_CAP, type LiteratureRecord } from './domain.ts'

export { normalizeDoi, ProviderUnavailableError, SEARCH_HARD_CAP } from './domain.ts'
export type { LiteratureProvider, LiteratureRecord, LiteratureSearchOptions } from './domain.ts'

export interface Config {
  /** Single source of truth shared with core/evidence/artifact services. */
  databasePath?: string
  /** Maximum default count returned by one provider search. */
  defaultLimit?: number
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function isLiteratureRecord(value: unknown): value is LiteratureRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, JsonValue>
  if (typeof record.id !== 'string' || typeof record.title !== 'string' || typeof record.source !== 'string') return false
  if (!Array.isArray(record.authors) || (typeof record.year !== 'number' && record.year !== null)) return false
  return record.authors.every((author) =>
    author !== null
    && typeof author === 'object'
    && !Array.isArray(author)
    && typeof (author as Record<string, JsonValue>).name === 'string')
}

/**
 * Literature persistence is deliberately a direct SQLite transaction. It does
 * not invoke evidence through a cross-plugin cast, which avoids an in-process
 * dependency and lets Literature/Evidence share one atomic domain boundary.
 */
export class MetisLiterature extends Service {
  static inject = ['tools', 'metisResearch']

  readonly registry = new LiteratureRegistry()
  private readonly defaultLimit: number
  private readonly ready: Promise<MetisDataStore>
  private readonly research: MetisResearch

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'metisLiterature')
    this.defaultLimit = Math.min(Math.max(config.defaultLimit ?? 10, 1), SEARCH_HARD_CAP)
    const databasePath = resolveMetisDatabasePath(config.databasePath)
    this.ready = MetisDataStore.open(databasePath).then((data) => {
      ctx.effect(() => () => data.close(), 'metisLiterature.databaseClose')
      return data
    })
    this.research = ctx.metisResearch
    this.registerTools(ctx)
  }

  async dataStore(): Promise<MetisDataStore> {
    return await this.ready
  }

  get defaultLimitValue(): number {
    return this.defaultLimit
  }

  async save(records: readonly LiteratureRecord[], projectId: string): Promise<LiteratureRecord[]> {
    const store = await this.dataStore()
    return records.map((record) => store.saveLiteratureWithEvidence({
      record,
      projectId,
      createdByTool: 'literature_save',
    }))
  }

  async listSaved(projectId: string): Promise<LiteratureRecord[]> {
    return (await this.dataStore()).listLiterature(projectId)
  }

  async removeSaved(projectId: string, literatureId: string): Promise<boolean> {
    return (await this.dataStore()).removeLiterature(projectId, literatureId)
  }

  private registerTools(ctx: Context): void {
    ctx.tools.register(defineTool({
      name: 'literature_search',
      description: '在已安装的真实文献来源（Crossref/OpenAlex/NCPSSD 等）中检索文献。只返回 provider 给出的结构化记录，不编造条目。',
      parameters: {
        query: { type: 'string', description: '检索词（主题、概念、理论、机制或学者）', required: true },
        limit: { type: 'number', description: `返回条数（1-${SEARCH_HARD_CAP}）` },
        providers: { type: 'string', description: '逗号分隔的 provider 名，如 crossref,openalex' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            total: { type: 'integer' },
            records: { type: 'array', items: { type: 'json' } },
            providersUsed: { type: 'array', items: { type: 'string' } },
            providerFailures: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec: ToolRunContext) => {
        const limit = Math.min(
          Math.max(Math.floor(Number(args.limit ?? this.defaultLimitValue)) || this.defaultLimitValue, 1),
          SEARCH_HARD_CAP,
        )
        const filter = typeof args.providers === 'string' && args.providers.trim()
          ? args.providers.split(',').map((item: string) => item.trim()).filter(Boolean)
          : undefined
        const providers = this.registry.resolveProviders(filter)
        const settled = await Promise.allSettled(
          providers.map((provider) => provider.search({ query: args.query, limit, signal: exec.signal })),
        )
        const records: LiteratureRecord[] = []
        const failures: string[] = []
        settled.forEach((outcome, index) => {
          if (outcome.status === 'fulfilled') records.push(...outcome.value)
          else failures.push(`${providers[index]?.name ?? 'unknown'}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`)
        })
        const merged = this.registry.merge(records).slice(0, limit)
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
      description: '把真实 provider 返回的文献保存到当前 DSH Workspace/Session 已绑定的项目；每条文献与 Evidence 在同一 SQLite 事务中登记。',
      parameters: {
        projectId: { type: 'string', description: '可选；只能重复当前 DSH Workspace/Session 的已绑定项目 id' },
        records: { type: 'json', description: '文献记录数组，通常来自 literature_search', required: true },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { saved: { type: 'integer' }, records: { type: 'array', items: { type: 'json' } } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec: ToolRunContext) => {
        // Models frequently pass one record as a JSON-encoded string or as a
        // bare object; normalize at the boundary, then validate strictly.
        let input: unknown = args.records
        if (typeof input === 'string') {
          try { input = JSON.parse(input) } catch { throw new Error('records 字符串不是合法 JSON。') }
        }
        const candidates: readonly unknown[] = Array.isArray(input) ? input : [input]
        if (candidates.length === 0 || !candidates.every(isLiteratureRecord)) {
          throw new Error('records 必须是至少一条真实文献（来自 literature_search 的完整记录：id/title/authors/year/source）。')
        }
        const project = await this.research.requireCurrentProject(exec.agent, args.projectId)
        const saved = await this.save(candidates as readonly LiteratureRecord[], project.id)
        if (saved.length !== candidates.length) {
          throw new Error(`literature_save 只持久化了 ${saved.length}/${candidates.length} 条记录，拒绝伪成功。`)
        }
        return { saved: saved.length, records: saved.map(toJson) }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'literature_search_project',
      description: '读取当前 DSH Workspace/Session 已绑定项目中持久化保存的文献；可按标题或关键词过滤。',
      parameters: {
        projectId: { type: 'string', description: '可选；只能重复当前 DSH Workspace/Session 的已绑定项目 id' },
        query: { type: 'string', description: '标题或关键词包含匹配' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { total: { type: 'integer' }, records: { type: 'array', items: { type: 'json' } } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec: ToolRunContext) => {
        const project = await this.research.requireCurrentProject(exec.agent, args.projectId)
        let records = await this.listSaved(project.id)
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
      name: 'literature_remove',
      description: '仅移除当前项目与某条文献的关联。保留全局题录与 Evidence，避免破坏其他项目的可追溯记录。',
      parameters: {
        projectId: { type: 'string', description: '可选；只能重复当前 DSH Workspace/Session 的已绑定项目 id' },
        literatureId: { type: 'string', description: '项目中已保存的 literature id', required: true },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { removed: { type: 'boolean' } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec: ToolRunContext) => {
        const project = await this.research.requireCurrentProject(exec.agent, args.projectId)
        return { removed: await this.removeSaved(project.id, args.literatureId) }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'literature_get',
      description: '按 DOI 调用 provider 的权威接口核验题录；该操作不会把网络查询自动误标为已验证结论。',
      parameters: {
        doi: { type: 'string', description: 'DOI，支持 https://doi.org/ 前缀', required: true },
        providers: { type: 'string', description: 'provider 过滤（可选）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { found: { type: 'boolean' }, record: { type: 'json' } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec: ToolRunContext) => {
        const doi = normalizeDoi(args.doi)
        if (!doi) throw new Error('doi 不能为空。')
        const providers = this.registry.resolveProviders(
          typeof args.providers === 'string' && args.providers.trim()
            ? args.providers.split(',').map((item: string) => item.trim()).filter(Boolean)
            : undefined,
        )
        for (const provider of providers) {
          if (!provider.getByDoi) continue
          const record = await provider.getByDoi(doi, exec.signal)
          if (record) return { found: true, record: toJson(record) }
        }
        return { found: false, record: null }
      },
    }))
  }
}

export default {
  name: 'metis-literature',
  inject: ['tools', 'metisResearch'],
  apply(ctx: Context, config?: Config): void {
    ctx.plugin(MetisLiterature, config ?? {})
  },
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    metisLiterature: MetisLiterature
  }
}
