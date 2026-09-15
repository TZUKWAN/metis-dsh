/**
 * dsh-metis-funding tools（SQLite 持久化形态）。
 *
 * 模板包登记进 MetisDataStore（funding_templates + funding_template_versions），
 * 章节草稿进 funding_section_drafts。material_gap 第一版为诚实启发式：
 * 只报告模板要求、项目已知字段与「必须由用户确认」的事实类别，绝不编造。
 */

import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  MetisDataStore,
  type FundingSectionDraftRecord,
  type FundingTemplateRecord,
} from '../../../shared/data/src/index.ts'
import type { MetisResearch } from '../../core/src/index.ts'
import { analyzeFundingTemplate, diffFundingTemplatePackages, verifyFundingTemplatePackage } from '../../../shared/funding/src/funding-template-analyzer.ts'

export interface Config {
  /** 统一 metis.db 路径（与 core/evidence/literature/scenario/artifact 对齐）。 */
  databasePath?: string
}

/** 用户事实类别：模板可能要求，但系统无法自行核验，必须由用户确认。 */
const USER_FACT_CATEGORIES = [
  '负责人履历', '团队成员', '代表性成果', '研究基础', '经费预算', '时间计划', '合作单位',
] as const

export class MetisFunding {
  private readonly data: Promise<MetisDataStore>

  constructor(_research: MetisResearch, data: Promise<MetisDataStore>) {
    this.data = data
  }

  private async store(): Promise<MetisDataStore> {
    return await this.data
  }

  /** 观察文档 → 分析结果（ok 或带具体 issues）。 */
  parse(raw: unknown): unknown {
    return analyzeFundingTemplate(raw)
  }

  /** 两个模板包的结构化 diff。 */
  diff(oldPackage: unknown, newPackage: unknown): unknown {
    return diffFundingTemplatePackages(oldPackage, newPackage)
  }

  /** 完整性校验（digest + 结构 schema）。 */
  verify(raw: unknown): { ok: boolean; issues: string[] } {
    return verifyFundingTemplatePackage(raw)
  }

  async persist(input: { templateId: string; templateVersion: number; template: unknown; projectId?: string | null }): Promise<FundingTemplateRecord> {
    return (await this.store()).saveFundingTemplate({
      templateId: input.templateId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      version: input.templateVersion,
      template: JSON.parse(JSON.stringify(input.template)) as import('@deepseek-ai/dsh-util-values').JsonValue,
    })
  }

  async getTemplate(templateId: string): Promise<FundingTemplateRecord | null> {
    return (await this.store()).getFundingTemplate(templateId)
  }

  async listTemplates(projectId?: string): Promise<FundingTemplateRecord[]> {
    return (await this.store()).listFundingTemplates(projectId)
  }

  async saveSectionDraft(input: {
    projectId: string
    templateId: string
    sectionId: string
    draftText: string
    usedEvidenceIds: readonly string[]
  }): Promise<FundingSectionDraftRecord> {
    return (await this.store()).saveFundingSectionDraft(input)
  }

  async listSectionDrafts(projectId: string, templateId?: string): Promise<FundingSectionDraftRecord[]> {
    return (await this.store()).listFundingSectionDrafts(projectId, templateId)
  }
}

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true } as const

export function createFundingTools(research: MetisResearch, data: Promise<MetisDataStore>): Array<Record<string, unknown>> {
  const service = new MetisFunding(research, data)
  const toJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

  const parseTool = {
    name: 'funding_template_parse',
    description: '把申报书模板的观察文档解析为结构化模板包并自动登记到 SQLite。成功返回 ok=true 和 template 对象；后续可用 funding_template_requirements 提取要求，用 funding_material_gap 检查材料缺口。解析失败时返回具体 issues，不猜测。',
    parameters: {
      observationDocument: { type: 'object', description: '模板观察文档（contractVersion=1，含 pages/styles/blocks）', required: true },
      createdAt: { type: 'number', description: '模板创建时间戳（缺省当前时间）' },
      templateId: { type: 'string', description: '模板 id（字母/数字/: _ -）', required: true },
      templateVersion: { type: 'number', description: '模板版本（正整数）', required: true },
      projectId: { type: 'string', description: '可选；关联当前科研项目' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args: any) => {
      const templateVersion = Number(args.templateVersion)
      if (!Number.isSafeInteger(templateVersion) || templateVersion < 1) {
        return { ok: false, issues: [`templateVersion 必须是正整数，收到: ${String(args.templateVersion)}`] }
      }
      const result = service.parse({ document: args.observationDocument, templateId: String(args.templateId), templateVersion, createdAt: Number(args.createdAt ?? Date.now()) }) as { ok?: boolean; template?: unknown; issues?: string[] }
      if (result?.ok === true && result.template !== undefined) {
        let projectId: string | null = null
        if (args.projectId !== undefined) {
          const project = await research.requireCurrentProject(undefined, args.projectId)
          projectId = project.id
        }
        const record = await service.persist({
          templateId: String(args.templateId),
          templateVersion,
          template: result.template,
          projectId,
        })
        return {
          ok: true,
          template: toJson(record.template),
          registration: toJson({ templateId: record.templateId, version: record.version, projectId: record.projectId }),
        }
      }
      return { ok: false, issues: toJson(result.issues ?? []) }
    },
  }

  const requirementsTool = {
    name: 'funding_template_requirements',
    description: '从已解析的模板包（或按 templateId 从库中读取）提取申报要求清单：章节树、每章填写指令与限字数、表格要求。',
    parameters: {
      template: { type: 'object', description: '已解析的模板包（缺省时按 templateId 读取）' },
      templateId: { type: 'string', description: '从库中读取已登记模板' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args: any) => {
      let template = args.template
      if (template === undefined) {
        const record = args.templateId === undefined ? null : await service.getTemplate(String(args.templateId))
        if (!record) throw new Error('未提供 template，且 templateId 在库中不存在。')
        template = record.template
      }
      const sections: Array<Record<string, unknown>> = template?.sections ?? []
      const requirements = sections.map((section: Record<string, unknown>, index: number) => {
        const entry: Record<string, unknown> = {
          sectionId: section['sectionId'] ?? `section-${index}`,
          title: section['title'] ?? `章节 ${index + 1}`,
          level: section['level'] ?? null,
        }
        const wordLimit = (section as { wordLimit?: { max?: number } }).wordLimit?.max
        if (wordLimit !== undefined) entry.wordLimit = wordLimit
        const instructions = (section as { instructions?: Array<{ text?: string }> }).instructions
        const instructionTexts = (instructions ?? [])
          .map((instruction) => instruction.text)
          .filter((text): text is string => typeof text === 'string')
        if (instructionTexts.length > 0) entry.instructions = instructionTexts
        return entry
      })
      const output: Record<string, unknown> = { totalSections: requirements.length, requirements }
      const tables = (template as { tables?: unknown[] }).tables
      if (tables && tables.length > 0) output.tables = tables
      return output
    },
  }

  const checkTool = {
    name: 'funding_template_check',
    description: '校验一个模板包的完整性（digest 与结构 schema）。用于导入/传输后的可信性确认。',
    parameters: {
      templatePackage: { type: 'object', description: '待校验的模板包', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { ok: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } },
      },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args: any) => service.verify(args.templatePackage),
  }

  const diffTool = {
    name: 'funding_template_diff',
    description: '对比模板旧版与新版的结构化差异（章节/指令/表格/字段映射/排版变化）。',
    parameters: {
      oldPackage: { type: 'object', description: '旧版模板包', required: true },
      newPackage: { type: 'object', description: '新版模板包', required: true },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args: any) => ({ diff: toJson(service.diff(args.oldPackage, args.newPackage)) }),
  }

  const materialGapTool = {
    name: 'funding_material_gap',
    description: '对照模板要求与当前项目已知信息，报告材料缺口。输出 sections（模板章节清单）、projectKnownFields（项目已有字段）、userFactsRequired（需用户确认的事实类别）。请根据结果撰写申报草稿并用 funding_section_draft 保存。',
    parameters: {
      templateId: { type: 'string', description: '已登记的模板 id', required: true },
      projectId: { type: 'string', description: '可选；只能重复当前 session 已绑定项目 id' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args: any, exec: ToolRunContext) => {
      const record = await service.getTemplate(String(args.templateId))
      if (!record) throw new Error(`模板不存在: ${args.templateId}`)
      const project = await research.requireCurrentProject(exec.agent, args.projectId)
      const template = record.template as { sections?: Array<Record<string, unknown>> }
      const sections = (template.sections ?? []).map((section: Record<string, unknown>, index: number) => {
        const entry: Record<string, unknown> = {
          sectionId: section['sectionId'] ?? `section-${index}`,
          title: section['title'] ?? `章节 ${index + 1}`,
        }
        const wordLimit = (section as { wordLimit?: { max?: number } }).wordLimit?.max
        if (wordLimit !== undefined) entry.wordLimit = wordLimit
        return entry
      })
      const fieldNames = ['title', 'discipline', 'researchQuestion', 'researchObject', 'methodology', 'stage', 'keywords', 'publicationIntent', 'notes'] as const
      const fieldValues = [
        project.title, project.discipline, project.researchQuestion, project.researchObject,
        project.methodology, project.stage, project.keywords, project.publicationIntent, project.notes,
      ]
      const projectKnownFields = fieldNames.filter((_, index) => fieldValues[index] !== undefined && fieldValues[index] !== null)
      return {
        templateId: record.templateId,
        templateVersion: record.version,
        sections,
        projectKnownFields,
        userFactsRequired: USER_FACT_CATEGORIES.map((category) => ({
          category,
          status: 'needs_user_confirmation',
          note: '系统无法自行核验该类事实，需用户提供后才能写入申报材料。',
        })),
      }
    },
  }

  const sectionDraftTool = {
    name: 'funding_section_draft',
    description: '登记一个申报书章节草稿。草稿文本由你（模型）撰写；工具会校验所引用的 Evidence 真实存在并持久化草稿。未核验内容必须在草稿中显式标注「待核验」。',
    parameters: {
      projectId: { type: 'string', description: '可选；只能重复当前 session 已绑定项目 id' },
      templateId: { type: 'string', description: '已登记的模板 id', required: true },
      sectionId: { type: 'string', description: '模板章节 id', required: true },
      draftText: { type: 'string', description: '草稿正文', required: true },
      usedEvidenceIds: { type: 'json', description: '草稿引用的 Evidence id 数组' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args: any, exec: ToolRunContext) => {
      const project = await research.requireCurrentProject(exec.agent, args.projectId)
      const usedEvidenceIds = args.usedEvidenceIds === undefined
        ? []
        : Array.isArray(args.usedEvidenceIds)
          ? args.usedEvidenceIds.map((value: unknown) => String(value))
          : (() => { throw new Error('usedEvidenceIds 必须是 Evidence id 数组。') })()
      const draft = await service.saveSectionDraft({
        projectId: project.id,
        templateId: String(args.templateId),
        sectionId: String(args.sectionId),
        draftText: String(args.draftText ?? ''),
        usedEvidenceIds,
      })
      return { ok: true, draft: toJson(draft) }
    },
  }

  const draftListTool = {
    name: 'funding_draft_list',
    description: '列出当前项目已登记的申报书章节草稿（可按 templateId 过滤）。',
    parameters: {
      projectId: { type: 'string', description: '可选；只能重复当前 session 已绑定项目 id' },
      templateId: { type: 'string', description: '按模板过滤' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args: any, exec: ToolRunContext) => {
      const project = await research.requireCurrentProject(exec.agent, args.projectId)
      const drafts = await service.listSectionDrafts(project.id, args.templateId === undefined ? undefined : String(args.templateId))
      return { total: drafts.length, drafts: drafts.map(toJson) }
    },
  }

  const templateListTool = {
    name: 'funding_template_list',
    description: '列出已登记的申报书模板（可按项目过滤）。',
    parameters: {
      projectId: { type: 'string', description: '按项目过滤' },
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args: any) => {
      const templates = await service.listTemplates(args.projectId === undefined ? undefined : String(args.projectId))
      return {
        total: templates.length,
        templates: templates.map((record) => toJson({ templateId: record.templateId, version: record.version, projectId: record.projectId, updatedAt: record.updatedAt })),
      }
    },
  }

  return [parseTool, requirementsTool, checkTool, diffTool, materialGapTool, sectionDraftTool, draftListTool, templateListTool]
}
