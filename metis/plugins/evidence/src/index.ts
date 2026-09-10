/**
 * dsh-metis-evidence — 统一科研证据记录与 provenance 插件（Phase 10）。
 *
 * 对模型暴露 evidence_query 工具（结构化 canonical JSON，R0-027）；
 * 其他 METIS 插件（literature/funding/submission）通过 `metisEvidence` 服务
 * 在各自工具的 execute 中登记证据（T10-022：显式调用优先于全局 hook 拦截）。
 */

import path from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { EvidenceStore } from './store.ts'
import type { EvidenceRecord } from './domain.ts'

export const name = 'metis-evidence'

export const inject = ['tools']

export class MetisEvidence extends Service {
  private readonly store: EvidenceStore

  // Known Limitation：数据文件位置第一版固定为工作目录下 metis-data/；
  // Schemastery config 化与 SQLite 迁移见 migration/DATA_MIGRATION_PLAN.md。
  constructor(ctx: Context, dataFile?: string) {
    super(ctx, 'metisEvidence')
    const resolved = dataFile ?? path.resolve(process.cwd(), 'metis-data/evidence.json')
    this.store = new EvidenceStore(resolved)
  }

  get storeService(): EvidenceStore {
    return this.store
  }
}

export default function apply(ctx: Context): void {
  const service = new MetisEvidence(ctx)
  ctx.metisEvidence = service

  ctx.tools.register(defineTool({
    name: 'evidence_query',
    description: '查询已登记的科研证据。支持按项目/DOI/URL 过滤；返回结构化记录（含验证状态）。证据的登记由各领域工具自动完成。',
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
          total: { type: 'integer', description: '命中条数' },
          records: { type: 'array', items: { type: 'json' }, description: '证据记录' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      let records: EvidenceRecord[]
      if (args.doi) {
        records = service.storeService.queryByDoi(args.doi)
      } else if (args.url) {
        records = service.storeService.queryByUrl(args.url)
      } else if (args.projectId) {
        records = service.storeService.queryByProject(args.projectId)
      } else {
        records = service.storeService.all()
      }
      return {
        total: records.length,
        records: records.map((record) => ({
          id: record.id,
          title: record.title,
          sourceType: record.sourceType,
          provider: record.source.provider,
          doi: record.doi ?? null,
          url: record.url ?? null,
          verificationState: record.verificationState,
          projectId: record.projectId,
          observedAt: record.observedAt,
        })),
      }
    },
  }))
}

// 服务与文件类型的再导出（供 literature/funding/submission 插件消费）。
export { EvidenceStore } from './store.ts'
export type {
  EvidenceRecord,
  EvidenceSourceType,
  EvidenceStoreFile,
  VerificationState,
} from './domain.ts'

// Cordis 服务声明合并：ctx.metisEvidence。
declare module '@deepseek-ai/cordis' {
  interface Context {
    metisEvidence: MetisEvidence
  }
}
