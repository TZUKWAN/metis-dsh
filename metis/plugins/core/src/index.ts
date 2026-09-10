import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  MetisDataStore,
  resolveMetisDatabasePath,
  type ResearchProjectMetadata,
  type ResearchProjectRecord,
} from '../../../shared/data/src/index.ts'

const DEFAULT_CONTEXT_BUDGET_CHARS = 4_000

export type { ResearchProjectMetadata, ResearchProjectRecord }

export interface Config {
  /** Absolute or process-relative path to the METIS domain database. */
  databasePath?: string
}

interface ResearchToolArgs {
  title?: string
  discipline?: string
  researchQuestion?: string
  researchObject?: string
  methodology?: string
  keywords?: string
  publicationIntent?: string
  notes?: string
  projectId?: string
  workspaceId?: string
  sessionId?: string
}

interface ExecutionScope {
  workspaceId: string | null
  sessionId: string | null
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function configuredDatabasePath(config?: Config): string {
  return resolveMetisDatabasePath(config?.databasePath)
}

function runtimeScope(ctx: Context, agent?: Agent, override?: Pick<ResearchToolArgs, 'workspaceId' | 'sessionId'>): ExecutionScope {
  const sessionId = override?.sessionId ?? agent?.id ?? null
  const workspaceId = override?.workspaceId ?? resolveWorkspaceId(ctx, agent)
  return { workspaceId, sessionId }
}

function resolveWorkspaceId(ctx: Context, agent?: Agent): string | null {
  const cwd = agent?.session.header.cwd
  if (!cwd) return null
  const workspaceRegistry = ctx.get('workspaceRegistry')
  if (!workspaceRegistry) return null
  const workspace = workspaceRegistry.list().find((candidate: { readonly id: string; readonly path: string }) => candidate.path === cwd)
  return workspace?.id ?? null
}

function parseKeywords(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  return value.split(/[,，]/u).map((item) => item.trim()).filter(Boolean)
}

function metadataFromArgs(args: ResearchToolArgs): ResearchProjectMetadata {
  return {
    ...(args.title === undefined ? {} : { title: args.title }),
    ...(args.discipline === undefined ? {} : { discipline: args.discipline }),
    ...(args.researchQuestion === undefined ? {} : { researchQuestion: args.researchQuestion }),
    ...(args.researchObject === undefined ? {} : { researchObject: args.researchObject }),
    ...(args.methodology === undefined ? {} : { methodology: args.methodology }),
    ...(args.keywords === undefined ? {} : { keywords: parseKeywords(args.keywords) }),
    ...(args.publicationIntent === undefined ? {} : { publicationIntent: args.publicationIntent }),
    ...(args.notes === undefined ? {} : { notes: args.notes }),
  }
}

/**
 * Persistent ResearchProject boundary. DSH still owns workspace/session/agent
 * infrastructure; this service stores only METIS research-domain state and its
 * durable references to those identities.
 */
export class MetisResearch extends Service {
  static inject = ['tools', 'systemPrompt']

  private readonly databasePath: string
  private readonly ready: Promise<MetisDataStore>
  private data: MetisDataStore | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'metisResearch')
    this.databasePath = configuredDatabasePath(config)
    this.ready = MetisDataStore.open(this.databasePath).then((data) => {
      this.data = data
      ctx.effect(() => () => data.close(), 'metisResearch.databaseClose')
      return data
    })

    ctx.systemPrompt.section({
      name: 'metis:research-context',
      order: 500,
      text: (assembly: AssembleContext) => this.contextForScope(runtimeScope(ctx, assembly.agent)),
    })
    registerProjectTools(ctx, this)
  }

  get dataFile(): string {
    return this.databasePath
  }

  async whenReady(): Promise<void> {
    await this.ready
  }

  async dataStore(): Promise<MetisDataStore> {
    return await this.ready
  }

  async getCurrentProject(scope: ExecutionScope = { workspaceId: null, sessionId: null }): Promise<ResearchProjectRecord | null> {
    return (await this.dataStore()).getCurrentProject(scope.workspaceId, scope.sessionId)
  }

  /**
   * Resolve the project visible to a real DSH tool invocation. An explicit id may
   * only repeat that scoped binding; it cannot be used to read another session's
   * project by guessing an id.
   */
  async requireCurrentProject(agent?: Agent, requestedProjectId?: string): Promise<ResearchProjectRecord> {
    const project = await this.getCurrentProject(runtimeScope(this.ctx, agent))
    if (!project) {
      throw new Error('当前 DSH Workspace/Session 尚未绑定科研项目。请先使用 research_project_update 建立项目。')
    }
    const requested = requestedProjectId?.trim()
    if (requested && requested !== project.id) {
      throw new Error('projectId 必须等于当前 DSH Workspace/Session 已绑定的科研项目；跨会话/工作区访问被拒绝。')
    }
    return project
  }

  async getProject(id: string): Promise<ResearchProjectRecord | null> {
    return (await this.dataStore()).getProject(id)
  }

  async listProjects(): Promise<ResearchProjectRecord[]> {
    return (await this.dataStore()).listProjects()
  }

  async bindWorkspace(workspaceId: string, projectId: string): Promise<void> {
    ;(await this.dataStore()).bindWorkspace(workspaceId, projectId)
  }

  async updateProject(
    scope: ExecutionScope,
    patch: ResearchProjectMetadata,
    projectId?: string,
  ): Promise<ResearchProjectRecord> {
    const store = await this.dataStore()
    const currentId = projectId ?? store.resolveProjectId(scope.workspaceId, scope.sessionId)
    const project = currentId
      ? store.updateProject(currentId, patch)
      : store.createProject(patch, scope.workspaceId, scope.sessionId)
    if (!project) throw new Error(`research project does not exist: ${currentId}`)
    if (scope.workspaceId) store.bindWorkspace(scope.workspaceId, project.id)
    if (scope.sessionId) store.bindSession(scope.sessionId, scope.workspaceId, project.id)
    return project
  }

  async describeCurrent(scope: ExecutionScope): Promise<{ ok: true; project: JsonValue; note?: string }> {
    const project = await this.getCurrentProject(scope)
    return {
      ok: true,
      project: toJson(project),
      ...(project ? {} : { note: '当前 DSH Workspace/Session 尚未绑定科研项目。请使用 research_project_update 建立或绑定项目。' }),
    }
  }

  async updateFromArgs(args: ResearchToolArgs, agent?: Agent): Promise<{ ok: true; project: JsonValue }> {
    const scope = runtimeScope(this.ctx, agent, args)
    const project = await this.updateProject(scope, metadataFromArgs(args), args.projectId)
    return { ok: true, project: toJson(project) }
  }

  getBoundedResearchContext(maxChars = DEFAULT_CONTEXT_BUDGET_CHARS): string {
    return this.contextForScope({ workspaceId: null, sessionId: null }, maxChars)
  }

  private contextForScope(scope: ExecutionScope, maxChars = DEFAULT_CONTEXT_BUDGET_CHARS): string {
    const store = this.data
    if (!store) return '[科研项目] 正在加载 METIS 领域数据库。'
    const project = store.getCurrentProject(scope.workspaceId, scope.sessionId)
    if (!project) return '[科研项目] 当前 DSH Workspace/Session 尚未绑定科研项目。'
    const lines: string[] = []
    const push = (label: string, value: string | undefined): void => {
      const text = value?.trim()
      if (text) lines.push(`${label}: ${text}`)
    }
    push('项目', project.title)
    push('学科', project.discipline)
    push('研究问题', project.researchQuestion)
    push('研究对象', project.researchObject)
    push('方法', project.methodology)
    push('阶段', project.stage)
    if (project.keywords?.length) push('关键词', project.keywords.join('、'))
    push('发表意向', project.publicationIntent)
    push('备注', project.notes)
    let text = `[科研项目] ${project.title ?? '(未命名)'}\n${lines.join('\n')}`
    if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 20))}\n[...科研上下文因长度截断]`
    return text
  }
}

function registerProjectTools(ctx: Context, service: MetisResearch): void {
  ctx.tools.register(defineTool({
    name: 'research_project_get',
    description: '读取当前 DSH Workspace/Session 绑定的持久化科研项目元数据。无绑定项目时返回明确空结果。',
    parameters: {
      workspaceId: { type: 'string', description: '仅在无 DSH agent 上下文时显式指定 Workspace id' },
      sessionId: { type: 'string', description: '仅在无 DSH agent 上下文时显式指定 Session id' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          project: { type: 'json' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec: ToolRunContext) => service.describeCurrent(runtimeScope(ctx, exec.agent, args as ResearchToolArgs)),
  }))

  ctx.tools.register(defineTool({
    name: 'research_project_update',
    description: '创建或更新当前 DSH Workspace/Session 的持久化科研项目。只填写已知事实；未知字段不要提供占位内容。',
    parameters: {
      projectId: { type: 'string', description: '要更新/绑定的既有项目 id；缺省时更新当前绑定项目，不存在则新建' },
      workspaceId: { type: 'string', description: '仅在无 DSH agent 上下文时显式指定 Workspace id' },
      sessionId: { type: 'string', description: '仅在无 DSH agent 上下文时显式指定 Session id' },
      title: { type: 'string', description: '项目标题' },
      discipline: { type: 'string', description: '学科' },
      researchQuestion: { type: 'string', description: '研究问题' },
      researchObject: { type: 'string', description: '研究对象' },
      methodology: { type: 'string', description: '研究方法' },
      keywords: { type: 'string', description: '关键词，逗号分隔' },
      publicationIntent: { type: 'string', description: '发表或使用意向' },
      notes: { type: 'string', description: '仅记录用户已知的研究备注' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, project: { type: 'json' } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec: ToolRunContext) => service.updateFromArgs(args as ResearchToolArgs, exec.agent),
  }))
}

export default {
  name: 'metis-core',
  inject: ['tools', 'systemPrompt'],
  apply(ctx: Context, config?: Config): void {
    ctx.plugin(MetisResearch, config ?? {})
  },
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    metisResearch: MetisResearch
  }
}
