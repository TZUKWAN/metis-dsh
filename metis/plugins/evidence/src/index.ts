import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  MetisDataStore,
  resolveMetisDatabasePath,
  type EvidenceRecord,
} from '../../../shared/data/src/index.ts'
import { EvidenceStore } from './store.ts'

export interface Config {
  databasePath?: string
}

export class MetisEvidence extends Service {
  static inject = ['tools']

  private readonly ready: Promise<MetisDataStore>

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'metisEvidence')
    const databasePath = resolveMetisDatabasePath(config.databasePath)
    this.ready = MetisDataStore.open(databasePath).then((data) => {
      ctx.effect(() => () => data.close(), 'metisEvidence.databaseClose')
      return data
    })
    this.registerTools(ctx)
  }

  async dataStore(): Promise<EvidenceStore> {
    return new EvidenceStore(await this.ready)
  }

  private registerTools(ctx: Context): void {
    ctx.tools.register(defineTool({
      name: 'evidence_query',
      description: '查询 metis.db 中的科研证据。支持项目/DOI/URL 过滤；检索到 URL 不等于结论已验证，须查看 verificationState。',
      parameters: {
        projectId: { type: 'string', description: '按科研项目 id 过滤' },
        doi: { type: 'string', description: '按 DOI 过滤' },
        url: { type: 'string', description: '按 URL 过滤' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            total: { type: 'integer' },
            records: { type: 'array', items: { type: 'json' } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args) => {
        const store = await this.dataStore()
        const records = args.doi
          ? store.queryByDoi(args.doi)
          : args.url
            ? store.queryByUrl(args.url)
            : args.projectId
              ? store.queryByProject(args.projectId)
              : store.all()
        return { total: records.length, records: records.map(evidenceSummary) }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'evidence_claim_create',
      description: '为当前项目建立一条明确科研 Claim；初始状态为 unverified，必须再关联真实 Evidence。',
      parameters: {
        projectId: { type: 'string', description: '科研项目 id', required: true },
        text: { type: 'string', description: '待核验的科研判断', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { claim: { type: 'json' } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args) => ({ claim: toJson((await this.dataStore()).createClaim(args.projectId, args.text)) }),
    }))

    ctx.tools.register(defineTool({
      name: 'evidence_claim_link',
      description: '将已有 Claim 与已有 Evidence 关联。缺少任一真实记录会失败，不会编造证据链。',
      parameters: {
        claimId: { type: 'string', description: 'Claim id', required: true },
        evidenceId: { type: 'string', description: 'Evidence id', required: true },
        relation: { type: 'string', description: '关系，例如 supports / contradicts' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args) => {
        ;(await this.dataStore()).linkClaimEvidence(args.claimId, args.evidenceId, args.relation)
        return { ok: true }
      },
    }))
  }
}

export default {
  name: 'metis-evidence',
  inject: ['tools'],
  apply(ctx: Context, config?: Config): void {
    ctx.plugin(MetisEvidence, config ?? {})
  },
}

function evidenceSummary(record: EvidenceRecord): JsonValue {
  return toJson({
    id: record.id,
    projectId: record.projectId,
    title: record.title,
    sourceType: record.sourceType,
    provider: record.source.provider,
    doi: record.doi ?? null,
    url: record.url ?? null,
    verificationState: record.verificationState,
    observedAt: record.observedAt,
  })
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export { EvidenceStore } from './store.ts'
export type { EvidenceRecord, EvidenceSourceType, EvidenceStoreFile, VerificationState } from './domain.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    metisEvidence: MetisEvidence
  }
}
