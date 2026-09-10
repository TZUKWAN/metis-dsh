/**
 * dsh-metis-core — METIS 科研上下文核心插件（Phase 09 骨架，Gate C 起步）。
 *
 * 职责（T9）：持有科研项目的领域身份与元数据，向其他 METIS 插件提供
 * `metisResearch` 服务（Cordis service，声明合并挂到 ctx.metisResearch）；
 * 对模型暴露最小工具集（research_project_get / research_project_update），
 * 返回结构化 canonical JSON（R0-027）。
 *
 * 非职责：会话历史（DSH session 负责）、文献/证据/成果（独立插件）。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** 有界科研上下文的默认字符预算（T9-013 硬上限）。 */
const DEFAULT_CONTEXT_BUDGET_CHARS = 4_000

/** 领域记录 → 无损 JSON（工具 canonical 输出要求显式的 JsonValue 形态）。 */
function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** 科研项目元数据（T9-002/003）。字段 optional 语义：未知即缺省，不猜。 */
export interface ResearchProjectMetadata {
  title?: string
  discipline?: string
  researchQuestion?: string
  researchObject?: string
  methodology?: string
  stage?: 'idea' | 'designing' | 'fieldwork' | 'analyzing' | 'writing' | 'submission'
  keywords?: string[]
  publicationIntent?: string
  notes?: string
}

export interface ResearchProjectRecord extends ResearchProjectMetadata {
  id: string
  /** 关联的 DSH Workspace id（T9-006）；无关联时为 null。 */
  workspaceId: string | null
  createdAt: number
  updatedAt: number
}

export class MetisResearch extends Service {
  static inject = ['tools', 'systemPrompt']

  private readonly projects = new Map<string, ResearchProjectRecord>()

  constructor(ctx: Context) {
    super(ctx, 'metisResearch')
    registerProjectTools(ctx, this)

    // Phase 16：bounded research context 经 DSH 官方注入机制进入系统提示
    // （systemPrompt.section，provider 形态——每次装配评估当前项目，R0-009 不注会话历史）。
    ctx.systemPrompt.section({
      name: 'metis:research-context',
      order: 500,
      text: () => this.getBoundedResearchContext(),
    })

  }

  getCurrentProject(): ResearchProjectRecord | null {
    const values = [...this.projects.values()]
    return values.at(-1) ?? null
  }

  getProject(id: string): ResearchProjectRecord | null {
    return this.projects.get(id) ?? null
  }

  listProjects(): ResearchProjectRecord[] {
    return [...this.projects.values()]
  }

  updateProject(id: string, patch: Partial<ResearchProjectMetadata>): ResearchProjectRecord | null {
    const existing = this.projects.get(id)
    if (!existing) return null
    const next: ResearchProjectRecord = { ...existing, ...patch, updatedAt: Date.now() }
    this.projects.set(id, next)
    return next
  }

  /**
   * 有界科研上下文（T9-012/013）：字段固定顺序、可重建；超 maxChars 硬上限
   * 按行截断并显式标注——绝不静默溢出。
   */
  /**
   * 有界科研上下文（T9-012/013）：字段固定顺序、可重建；超 maxChars 硬上限
   * 按行截断并显式标注——绝不静默溢出。
   */
  getBoundedResearchContext(maxChars = DEFAULT_CONTEXT_BUDGET_CHARS): string {
    const project = this.getCurrentProject()
    if (!project) return '[科研项目] （尚未建立——可让用户描述研究需求后用 research_project_update 建立。）'
    const lines: string[] = []
    const push = (label: string, value: string | undefined): void => {
      const text = (value ?? '').trim()
      if (text) lines.push(`${label}: ${text}`)
    }
    push('项目', project.title)
    push('学科', project.discipline)
    push('研究问题', project.researchQuestion)
    push('研究对象', project.researchObject)
    push('方法', project.methodology)
    if (project.stage) push(`阶段`, project.stage)
    if (project.keywords?.length) push(`关键词`, project.keywords.join(`、`))
    push('发表意向', project.publicationIntent)
    push('备注', project.notes)
    let text = `[科研项目] ${project.title || `(未命名)`}`
    if (lines.length > 0) text += '\n' + lines.join('\n')
    if (text.length > maxChars) {
      text = text.slice(0, Math.max(0, maxChars - 20)) + '\n[...科研上下文因长度截断]'
    }
    return text
  }

  /** 生成 get 工具的 canonical 输出。 */
  describeCurrent() {
    const project = this.getCurrentProject()
    return {
      ok: true,
      project: toJson(project),
      ...(project === null ? { note: '当前没有任何科研项目。可先描述研究需求以建立项目。' } : {}),
    }
  }

  /** 生成 update 工具的 canonical 输出。 */
  updateFromArgs(args: {
    title?: string
    discipline?: string
    researchQuestion?: string
    researchObject?: string
    methodology?: string
    keywords?: string
    notes?: string
  }) {
    let current = this.getCurrentProject()
    if (!current) {
      const id = `rp-${Date.now().toString(36)}`
      current = { id, workspaceId: null, createdAt: Date.now(), updatedAt: Date.now() }
      this.projects.set(id, current)
    }
    const patch: Partial<ResearchProjectMetadata> = {}
    if (args.title !== undefined) patch.title = args.title
    if (args.discipline !== undefined) patch.discipline = args.discipline
    if (args.researchQuestion !== undefined) patch.researchQuestion = args.researchQuestion
    if (args.researchObject !== undefined) patch.researchObject = args.researchObject
    if (args.methodology !== undefined) patch.methodology = args.methodology
    if (args.keywords !== undefined) {
      patch.keywords = args.keywords.split(/[,，]/u).map((item) => item.trim()).filter(Boolean)
    }
    return { ok: true, project: toJson(this.updateProject(current.id, patch)) }
  }
}

/** 模型可见工具注册（canonical JSON 输出，R0-027）。 */
function registerProjectTools(ctx: Context, service: MetisResearch): void {
    ctx.tools.register(defineTool({
      name: 'research_project_get',
      description: '读取当前科研项目元数据（研究对象、研究问题、方法、阶段、关键词等）。无当前项目时返回明确的空结果与提示。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', description: '读取是否成功' },
            project: { type: 'json', description: '项目记录；无项目时为 null' },
            note: { type: 'string', description: '面向用户的提示' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: () => Promise.resolve(service.describeCurrent()),
    }))


    ctx.tools.register(defineTool({
      name: 'research_project_update',
      description: '更新当前科研项目元数据（无项目时自动创建）。只更新提供的字段；语义未知时不要填写占位内容。',
      parameters: {
        title: { type: 'string', description: '项目标题' },
        discipline: { type: 'string', description: '学科（如社会学/马克思主义理论/政治学）' },
        researchQuestion: { type: 'string', description: '研究问题' },
        researchObject: { type: 'string', description: '研究对象' },
        methodology: { type: 'string', description: '研究方法' },
        keywords: { type: 'string', description: '关键词，逗号分隔' },
        notes: { type: 'string', description: '备注（理论取向、数据线索等自由信息）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', description: '更新是否成功' },
            project: { type: 'json', description: '更新后的项目记录' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: (args) => Promise.resolve(service.updateFromArgs(args)),
    }))
}

// Cordis loader 契约：default 导出必须为插件函数或带 apply 的对象。
export default {
  name: 'metis-core',
  inject: ['tools'],
  apply(ctx: Context): void {
    ctx.plugin(MetisResearch)
  },
}
