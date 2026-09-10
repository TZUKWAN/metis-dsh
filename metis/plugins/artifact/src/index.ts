import { existsSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  MetisDataStore,
  resolveMetisDatabasePath,
  type ArtifactRecord,
  type ArtifactStatus,
} from '../../../shared/data/src/index.ts'
import type { MetisResearch } from '../../core/src/index.ts'
import { ARTIFACT_TYPES, isArtifactType } from './domain.ts'

export interface Config {
  /** The SQLite location must match the core/literature/evidence plugin config. */
  databasePath?: string
}

interface WorkspaceScope {
  id: string
  path: string
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function resolveWorkspaceScope(ctx: Context, agent?: Agent): WorkspaceScope {
  const cwd = agent?.session.header.cwd
  if (!cwd) throw new Error('Artifact 操作要求真实 DSH Agent Session，缺少 session cwd。')
  const registry = ctx.get('workspaceRegistry')
  const workspace = registry?.list().find((candidate: Workspace) => candidate.path === cwd)
  if (!workspace) {
    throw new Error('当前 session cwd 未注册为 DSH Workspace；拒绝以 process.cwd 或任意磁盘路径登记 Artifact。')
  }
  return { id: workspace.id, path: workspace.path }
}

/**
 * Returns the canonical workspace-relative reference. Absolute input is accepted
 * only when it resolves under the current DSH Workspace. Any traversal outside
 * that boundary fails before filesystem inspection.
 */
function workspaceRelativePath(workspacePath: string, requestedPath: string): { relativePath: string; absolutePath: string } {
  const absolutePath = resolve(workspacePath, requestedPath)
  const relativePath = relative(workspacePath, absolutePath)
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error('Artifact 文件必须位于当前 DSH Workspace 内，不能登记 workspace 根目录或外部路径。')
  }
  return { relativePath, absolutePath }
}

function configuredStatus(value: string | undefined): ArtifactStatus | undefined {
  return value === 'draft' || value === 'review' || value === 'final' ? value : undefined
}

export class MetisArtifact extends Service {
  static inject = ['tools', 'metisResearch']

  private readonly ready: Promise<MetisDataStore>
  private readonly research: MetisResearch

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'metisArtifact')
    this.ready = MetisDataStore.open(resolveMetisDatabasePath(config.databasePath)).then((data) => {
      ctx.effect(() => () => data.close(), 'metisArtifact.databaseClose')
      return data
    })
    this.research = ctx.metisResearch
    this.registerTools(ctx)
  }

  async dataStore(): Promise<MetisDataStore> {
    return await this.ready
  }

  async register(
    input: Parameters<MetisDataStore['registerArtifact']>[0],
  ): Promise<ArtifactRecord> {
    return (await this.dataStore()).registerArtifact(input)
  }

  private registerTools(ctx: Context): void {
    ctx.tools.register(defineTool({
      name: 'artifact_register',
      description: '把当前 DSH Workspace 中已有的文件登记为持久化科研 Artifact。METIS 只保存 workspace 相对引用、版本和证据关系，不复制文件。',
      parameters: {
        type: { type: 'string', description: `成果类型：${ARTIFACT_TYPES.join('/')}`, required: true },
        title: { type: 'string', description: '成果标题', required: true },
        path: { type: 'string', description: '当前 DSH Workspace 内文件的相对路径', required: true },
        projectId: { type: 'string', description: '可选；只能重复当前 session 已绑定项目 id' },
        note: { type: 'string', description: '版本说明' },
        evidenceIds: { type: 'json', description: '可选 Evidence id 数组，全部必须真实存在' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { ok: { type: 'boolean' }, artifact: { type: 'json' }, error: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec: ToolRunContext) => {
        if (!isArtifactType(args.type)) {
          return { ok: false, artifact: null, error: `未知成果类型: ${args.type}（可用: ${ARTIFACT_TYPES.join('/')}）` }
        }
        if (args.evidenceIds !== undefined && (!Array.isArray(args.evidenceIds) || !args.evidenceIds.every((value) => typeof value === 'string'))) {
          return { ok: false, artifact: null, error: 'evidenceIds 必须是 Evidence id 字符串数组。' }
        }
        const project = await this.research.requireCurrentProject(exec.agent, args.projectId)
        const workspace = resolveWorkspaceScope(ctx, exec.agent)
        const file = workspaceRelativePath(workspace.path, args.path)
        if (!existsSync(file.absolutePath)) {
          return { ok: false, artifact: null, error: `当前 DSH Workspace 中不存在文件: ${file.relativePath}` }
        }
        const artifact = await this.register({
          type: args.type,
          title: args.title,
          workspacePath: file.relativePath,
          projectId: project.id,
          source: 'dsh-workspace',
          ...(args.note ? { note: args.note } : {}),
          evidenceIds: args.evidenceIds ?? [],
        })
        return { ok: true, artifact: toJson(artifact), error: '' }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'artifact_list',
      description: '列出当前 DSH Workspace/Session 已绑定项目的持久化 Artifact；可按类型过滤。',
      parameters: {
        projectId: { type: 'string', description: '可选；只能重复当前 session 已绑定项目 id' },
        type: { type: 'string', description: 'Artifact 类型过滤' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { total: { type: 'integer' }, artifacts: { type: 'array', items: { type: 'json' } } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec: ToolRunContext) => {
        const project = await this.research.requireCurrentProject(exec.agent, args.projectId)
        const type = args.type === undefined ? undefined : isArtifactType(args.type) ? args.type : null
        if (type === null) throw new Error(`未知成果类型: ${args.type}`)
        const artifacts = (await this.dataStore()).listArtifacts({ projectId: project.id, ...(type ? { type } : {}) })
        return { total: artifacts.length, artifacts: artifacts.map(toJson) }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'artifact_get',
      description: '读取当前项目内一个 Artifact 的完整元数据、版本历史和 Evidence 关联。',
      parameters: { id: { type: 'string', description: 'Artifact id', required: true } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { found: { type: 'boolean' }, artifact: { type: 'json' } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec: ToolRunContext) => {
        const project = await this.research.requireCurrentProject(exec.agent)
        const artifact = (await this.dataStore()).getArtifact(args.id)
        if (!artifact || artifact.projectId !== project.id) return { found: false, artifact: null }
        return { found: true, artifact: toJson(artifact) }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'artifact_version',
      description: '为当前项目内 Artifact 追加一个新版本。路径必须在当前 DSH Workspace 内且文件已存在；历史版本不可覆盖。',
      parameters: {
        id: { type: 'string', description: 'Artifact id', required: true },
        path: { type: 'string', description: '当前 DSH Workspace 内新文件的相对路径', required: true },
        note: { type: 'string', description: '版本说明' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { ok: { type: 'boolean' }, artifact: { type: 'json' }, error: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec: ToolRunContext) => {
        const project = await this.research.requireCurrentProject(exec.agent)
        const data = await this.dataStore()
        const existing = data.getArtifact(args.id)
        if (!existing || existing.projectId !== project.id) return { ok: false, artifact: null, error: `当前项目中不存在 Artifact: ${args.id}` }
        const workspace = resolveWorkspaceScope(ctx, exec.agent)
        const file = workspaceRelativePath(workspace.path, args.path)
        if (!existsSync(file.absolutePath)) return { ok: false, artifact: null, error: `当前 DSH Workspace 中不存在文件: ${file.relativePath}` }
        const artifact = data.addArtifactVersion(args.id, file.relativePath, args.note)
        if (!artifact) return { ok: false, artifact: null, error: `Artifact 不存在: ${args.id}` }
        return { ok: true, artifact: toJson(artifact), error: '' }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'artifact_update_metadata',
      description: '更新当前项目内 Artifact 的标题、状态或 Evidence 关联，不生成文件版本。',
      parameters: {
        id: { type: 'string', description: 'Artifact id', required: true },
        title: { type: 'string', description: '新标题' },
        status: { type: 'string', description: 'draft/review/final' },
        evidenceIds: { type: 'json', description: '替换 Evidence 关联的 id 数组' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { ok: { type: 'boolean' }, artifact: { type: 'json' }, error: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec: ToolRunContext) => {
        if (args.evidenceIds !== undefined && (!Array.isArray(args.evidenceIds) || !args.evidenceIds.every((value) => typeof value === 'string'))) {
          return { ok: false, artifact: null, error: 'evidenceIds 必须是 Evidence id 字符串数组。' }
        }
        const project = await this.research.requireCurrentProject(exec.agent)
        const data = await this.dataStore()
        const existing = data.getArtifact(args.id)
        if (!existing || existing.projectId !== project.id) return { ok: false, artifact: null, error: `当前项目中不存在 Artifact: ${args.id}` }
        const status = args.status === undefined ? undefined : configuredStatus(args.status)
        if (args.status !== undefined && !status) return { ok: false, artifact: null, error: `未知 Artifact 状态: ${args.status}` }
        const artifact = data.updateArtifact(args.id, {
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(status ? { status } : {}),
          ...(args.evidenceIds === undefined ? {} : { evidenceIds: args.evidenceIds }),
        })
        if (!artifact) return { ok: false, artifact: null, error: `Artifact 不存在: ${args.id}` }
        return { ok: true, artifact: toJson(artifact), error: '' }
      },
    }))
  }
}

export default {
  name: 'metis-artifact',
  inject: ['tools', 'metisResearch'],
  apply(ctx: Context, config?: Config): void {
    ctx.plugin(MetisArtifact, config ?? {})
  },
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    metisArtifact: MetisArtifact
  }
}
