import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  CLAIM_EVIDENCE_RELATIONS,
  CLAIM_TYPES,
  EVIDENCE_LOCATOR_TYPES,
  MetisDataStore,
  resolveMetisDatabasePath,
  type ClaimEvidenceRelation,
  type ClaimType,
  type EvidenceLocatorType,
  type EvidenceRecord,
  type EvidenceVerificationState,
} from '../../../shared/data/src/index.ts'
import type { MetisResearch } from '../../core/src/index.ts'
import { EvidenceStore } from './store.ts'

export interface Config {
  databasePath?: string
}

export class MetisEvidence extends Service {
  static inject = ['tools', 'metisResearch']

  private readonly ready: Promise<MetisDataStore>
  private readonly research: MetisResearch

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'metisEvidence')
    const databasePath = resolveMetisDatabasePath(config.databasePath)
    this.ready = MetisDataStore.open(databasePath).then((data) => {
      ctx.effect(() => () => data.close(), 'metisEvidence.databaseClose')
      return data
    })
    this.research = ctx.metisResearch
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
        projectId: { type: 'string', description: '可选；只能重复当前 DSH Workspace/Session 已绑定项目 id' },
        text: { type: 'string', description: '待核验的科研判断', required: true },
        claimType: { type: 'string', description: `Claim 类型（${CLAIM_TYPES.join('/')}，缺省 factual）` },
        artifactId: { type: 'string', description: '可选；归属 Artifact id' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { claim: { type: 'json' } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec: ToolRunContext) => {
        const project = await this.research.requireCurrentProject(exec.agent, args.projectId)
        const claimType: ClaimType | undefined = args.claimType === undefined
          ? undefined
          : (CLAIM_TYPES as readonly string[]).includes(args.claimType)
            ? args.claimType as ClaimType
            : (() => { throw new Error(`claimType 必须是 ${CLAIM_TYPES.join('/')}。`) })()
        const claim = (await this.dataStore()).createClaim(project.id, args.text, {
          ...(claimType ? { claimType } : {}),
          ...(args.artifactId === undefined ? {} : { artifactId: args.artifactId }),
        })
        return { claim: toJson(claim) }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'evidence_claim_link',
      description: '将已有 Claim 与已有 Evidence 关联。缺少任一真实记录会失败，不会编造证据链。',
      parameters: {
        claimId: { type: 'string', description: 'Claim id', required: true },
        evidenceId: { type: 'string', description: 'Evidence id', required: true },
        relation: { type: 'string', description: `关系（${CLAIM_EVIDENCE_RELATIONS.join('/')}，缺省 supports）` },
        confidence: { type: 'number', description: '0-1 置信度（可选）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args) => {
        const relation: ClaimEvidenceRelation | undefined = args.relation === undefined
          ? undefined
          : (CLAIM_EVIDENCE_RELATIONS as readonly string[]).includes(args.relation)
            ? args.relation as ClaimEvidenceRelation
            : (() => { throw new Error(`relation 必须是 ${CLAIM_EVIDENCE_RELATIONS.join('/')}。`) })()
        const link = (await this.dataStore()).linkClaimEvidence(
          args.claimId,
          args.evidenceId,
          relation,
          args.confidence === undefined ? undefined : Number(args.confidence),
        )
        return { ok: true, link: toJson(link) }
      },
    }))

    this.registerClaimTools(ctx)
  }

  private registerClaimTools(ctx: Context): void {
    ctx.tools.register(defineTool({
      name: 'evidence_claim_list',
      description: '列出 Claim（按当前项目或 Artifact 过滤），含类型、验证状态与证据关联数。',
      parameters: {
        projectId: { type: 'string', description: '可选；只能重复当前 session 已绑定项目 id' },
        artifactId: { type: 'string', description: '按 Artifact 过滤' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { total: { type: 'integer' }, claims: { type: 'array', items: { type: 'json' } } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec: ToolRunContext) => {
        if (args.artifactId !== undefined) {
          const claims = (await this.dataStore()).listClaims({ artifactId: args.artifactId })
          return { total: claims.length, claims: claims.map(toJson) }
        }
        const project = await this.research.requireCurrentProject(exec.agent, args.projectId)
        const claims = (await this.dataStore()).listClaims({ projectId: project.id })
        return { total: claims.length, claims: claims.map(toJson) }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'evidence_claim_status',
      description: '更新 Claim 的验证状态。状态必须来自真实核验过程，不得凭空宣布 verified。',
      parameters: {
        claimId: { type: 'string', description: 'Claim id', required: true },
        status: { type: 'string', description: 'unverified/partially_verified/verified/conflicting/invalid/stale', required: true },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, claim: { type: 'json' } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args) => {
        const ALLOWED: ReadonlyArray<EvidenceVerificationState> = ['unverified', 'partially_verified', 'verified', 'conflicting', 'invalid', 'stale']
        if (!(ALLOWED as readonly string[]).includes(args.status)) throw new Error(`status 必须是 ${ALLOWED.join('/')}。`)
        const claim = (await this.dataStore()).setClaimStatus(args.claimId, args.status as EvidenceVerificationState)
        if (!claim) return { ok: false, claim: null }
        return { ok: true, claim: toJson(claim) }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'evidence_excerpt_add',
      description: '为 Evidence 登记原文摘录与定位器（abstract/page/section/paragraph/table/figure/dataset_row/web_fragment/metadata）。摘录必须是真实来源原文。',
      parameters: {
        evidenceId: { type: 'string', description: 'Evidence id', required: true },
        content: { type: 'string', description: '原文摘录', required: true },
        locatorType: { type: 'string', description: '定位器类型（缺省 metadata）' },
        locatorValue: { type: 'string', description: '定位器值（页码/段落号/URL 片段等）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, excerpt: { type: 'json' }, error: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args) => {
        try {
          if (args.locatorType !== undefined && !(EVIDENCE_LOCATOR_TYPES as readonly string[]).includes(args.locatorType)) {
            throw new Error(`locatorType 必须是 ${EVIDENCE_LOCATOR_TYPES.join('/')}。`)
          }
          const excerpt = (await this.dataStore()).addEvidenceExcerpt({
            evidenceId: args.evidenceId,
            content: args.content,
            ...(args.locatorType === undefined ? {} : { locatorType: args.locatorType as EvidenceLocatorType }),
            ...(args.locatorValue === undefined ? {} : { locatorValue: args.locatorValue }),
          })
          return { ok: true, excerpt: toJson(excerpt), error: '' }
        } catch (error) {
          return { ok: false, excerpt: null, error: error instanceof Error ? error.message : String(error) }
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'evidence_excerpt_list',
      description: '列出某条 Evidence 的全部摘录与定位器。',
      parameters: { evidenceId: { type: 'string', description: 'Evidence id', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: true, properties: { total: { type: 'integer' }, excerpts: { type: 'array', items: { type: 'json' } } } },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args) => {
        const excerpts = (await this.dataStore()).listEvidenceExcerpts(args.evidenceId)
        return { total: excerpts.length, excerpts: excerpts.map(toJson) }
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
