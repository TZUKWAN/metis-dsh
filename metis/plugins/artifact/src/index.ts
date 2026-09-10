/**
 * dsh-metis-artifact — 科研成果领域插件（Phase 18 / T18）。
 *
 * 真实文件保存在 DSH workspace（用户/DSH Files 管理）；本插件维护领域身份、
 * 版本与项目关联，不复制文件内容（T18-014）。对模型暴露：
 * artifact_register / artifact_list / artifact_get / artifact_version /
 * artifact_update_metadata（全部 canonical JSON）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ArtifactStore, isArtifactType } from './store.ts'
import { ARTIFACT_TYPES } from './domain.ts'

export interface Config {
  /** 登记库文件位置。默认落在 profile 工作目录下 metis-data/。 */
  dataFile?: string
}

export class MetisArtifact extends Service {
  readonly store: ArtifactStore
  private readonly dataFileResolved: string

  constructor(ctx: Context, config?: Config) {
    super(ctx, 'metisArtifact')
    const requested = config?.dataFile ?? path.resolve(process.cwd(), 'metis-data/artifacts.json')
    this.dataFileResolved = path.isAbsolute(requested) ? requested : path.resolve(process.cwd(), requested)
    this.store = new ArtifactStore(this.dataFileResolved)
  }

  get dataFile(): string {
    return this.dataFileResolved
  }
}

export default function apply(ctx: Context, config?: Config): void {
  const service = new MetisArtifact(ctx, config)
  ctx.metisArtifact = service

  ctx.tools.register(defineTool({
    name: 'artifact_register',
    description: '把 workspace 中的一个已有文件登记为科研成果 Artifact（建立领域身份与版本 1）。文件必须已存在。',
    parameters: {
      type: { type: 'string', description: `成果类型（${ARTIFACT_TYPES.join('/')}）`, required: true },
      title: { type: 'string', description: '成果标题', required: true },
      path: { type: 'string', description: 'workspace 内文件路径', required: true },
      projectId: { type: 'string', description: '关联科研项目 id（可选）' },
      note: { type: 'string', description: '版本说明（可选）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', description: '是否登记成功' },
          artifact: { type: 'json', description: '登记后的记录' },
          error: { type: 'string', description: '失败原因' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      if (!isArtifactType(args.type)) {
        return { ok: false, error: `未知成果类型: ${args.type}（可用: ${ARTIFACT_TYPES.join('/')}）` }
      }
      // T18-026：文件不存在时登记失败——metadata 与文件不得一边成功一边静默失败。
      const workspaceCandidate = path.isAbsolute(args.path) ? args.path : path.resolve(process.cwd(), args.path)
      if (!fs.existsSync(workspaceCandidate)) {
        return { ok: false, error: `文件不存在: ${args.path}（登记前请确认文件已在 workspace 生成）` }
      }
      const record = service.store.register({
        type: args.type,
        title: args.title,
        path: args.path,
        projectId: args.projectId ?? null,
        source: 'model',
        note: args.note,
      })
      return { ok: true, artifact: toJson(record) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'artifact_list',
    description: '列出 Artifact（可按项目/类型过滤）。',
    parameters: {
      projectId: { type: 'string', description: '按项目 id 过滤' },
      type: { type: 'string', description: '按类型过滤' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          total: { type: 'integer', description: '数量' },
          artifacts: { type: 'array', items: { type: 'json' }, description: '成果清单' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const records = service.store.list({
        projectId: args.projectId,
        type: args.type !== undefined && isArtifactType(args.type) ? args.type : undefined,
      })
      return { total: records.length, artifacts: records.map((record) => toJson(record)) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'artifact_get',
    description: '读取一个 Artifact 的完整记录（含全部版本历史）。',
    parameters: {
      id: { type: 'string', description: 'Artifact id', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          found: { type: 'boolean', description: '是否存在' },
          artifact: { type: 'json', description: '完整记录（含版本历史）' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const record = service.store.get(args.id)
      return { found: record !== undefined, artifact: toJson(record ?? null) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'artifact_version',
    description: '为已有 Artifact 登记新版本（新路径 + 版本说明）；历史版本保留可追溯。',
    parameters: {
      id: { type: 'string', description: 'Artifact id', required: true },
      path: { type: 'string', description: '新版本文件路径', required: true },
      note: { type: 'string', description: '版本说明（本次改了什么）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', description: '是否成功' },
          artifact: { type: 'json', description: '更新后的记录' },
          error: { type: 'string', description: '失败原因' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const workspaceCandidate = path.isAbsolute(args.path) ? args.path : path.resolve(process.cwd(), args.path)
      if (!fs.existsSync(workspaceCandidate)) {
        return { ok: false, error: `文件不存在: ${args.path}` }
      }
      const record = service.store.addVersion(args.id, args.path, args.note)
      if (!record) return { ok: false, error: `Artifact 不存在: ${args.id}` }
      return { ok: true, artifact: toJson(record) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'artifact_update_metadata',
    description: '更新 Artifact 元数据（标题/状态/项目关联），不产生新版本。',
    parameters: {
      id: { type: 'string', description: 'Artifact id', required: true },
      title: { type: 'string', description: '新标题' },
      status: { type: 'string', description: 'draft/review/final' },
      projectId: { type: 'string', description: '项目 id（空字符串=清除关联）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', description: '是否成功' },
          artifact: { type: 'json', description: '更新后的记录' },
          error: { type: 'string', description: '失败原因' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args) => {
      const record = service.store.updateMetadata(args.id, {
        title: args.title,
        status: args.status === 'draft' || args.status === 'review' || args.status === 'final' ? args.status : undefined,
        projectId: args.projectId === '' ? null : args.projectId,
      })
      if (!record) return { ok: false, error: `Artifact 不存在: ${args.id}` }
      return { ok: true, artifact: toJson(record) }
    },
  }))
}


/** 领域记录 → 无损 JSON。 */
function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

// 服务声明合并：ctx.metisArtifact。
declare module '@deepseek-ai/cordis' {
  interface Context {
    metisArtifact: MetisArtifact
  }
}
