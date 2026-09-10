/**
 * dsh-metis-funding — 基金申报模板领域插件（Phase 20 / T20）。
 *
 * 章节树/限字数/表格/字段映射/版本 diff 的核心分析复用 shared/funding
 * （提取自 legacy FundingTemplateAnalyzer.ts，语义不变）。
 *
 * 工具以**原始 JSON-Schema ToolDefinition** 形状注册（cookbook：ctx.tools.register
 * 直接接受 raw 定义，零 DSH 模块导入——解决独立 workspace 的运行时依赖闭包问题）。
 *
 * 纪律（T20-027/028）：本插件只处理模板结构与要求；履历/经费/成果等
 * 用户事实缺失时明确列为缺口，绝不编造。
 */

import fs from 'node:fs'
import path from 'node:path'
import { analyzeFundingTemplate, diffFundingTemplatePackages, verifyFundingTemplatePackage } from '../../../shared/funding/src/funding-template-analyzer.ts'

export interface Config {
  /** 解析结果登记库（JSON）位置，默认 metis-data/funding-templates.json。 */
  dataFile?: string
}

export class MetisFunding {
  readonly dataFile: string

  constructor(dataFile?: string) {
    const requested = dataFile ?? 'metis-data/funding-templates.json'
    this.dataFile = path.isAbsolute(requested) ? requested : path.resolve(process.cwd(), requested)
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

  /** 解析成功的结果登记到本地 JSON（原子写）。 */
  persist(templateId: string, templateVersion: number, template: unknown): void {
    fs.mkdirSync(path.dirname(this.dataFile), { recursive: true })
    const existing: Array<Record<string, unknown>> = fs.existsSync(this.dataFile)
      ? (JSON.parse(fs.readFileSync(this.dataFile, 'utf8')) as Array<Record<string, unknown>>)
      : []
    const record = { templateId, templateVersion, savedAt: Date.now(), template }
    const index = existing.findIndex((item) => item['templateId'] === templateId)
    if (index >= 0) existing[index] = record
    else existing.push(record)
    const tmp = `${this.dataFile}.tmp-${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify(existing, null, 2), 'utf8')
    fs.renameSync(tmp, this.dataFile)
  }
}

/** 原始 JSON-Schema 工具定义（ctx.tools.register 直接接受的形状）。 */
export interface RawToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: any, value: any) => Array<{ type: 'text'; text: string }>
  }
  execute: (args: any, exec?: unknown) => Promise<any>
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', description: '操作是否成功' },
    template: { type: 'object', description: '模板包' },
    issues: { type: 'array', items: { type: 'string' }, description: '失败时的具体问题' },
  },
}

export function createFundingTools(dataFile?: string): RawToolDefinition[] {
  const service = new MetisFunding(dataFile)

  const parseTool: RawToolDefinition = {
    name: 'funding_template_parse',
    description: '把申报书模板的观察文档（PDF/DOCX 解析产物：页/样式/文本块/表格）解析为结构化模板包：章节树、填写指令、限字数、表格要求、字段映射。解析失败时返回具体 issues，不猜测。',
    parameters: {
      type: 'object',
      properties: {
        observationDocument: { type: 'object', description: '模板观察文档（contractVersion=1，含 pages/styles/blocks）' },
        templateId: { type: 'string', description: '模板 id' },
        templateVersion: { type: 'number', description: '模板版本号' },
        createdAt: { type: 'number', description: '创建时间戳' },
      },
      required: ['observationDocument', 'templateId', 'templateVersion', 'createdAt'],
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args: any) => {
      const request = {
        templateId: String(args.templateId),
        templateVersion: Number(args.templateVersion),
        createdAt: Number(args.createdAt),
        document: args.observationDocument,
      }
      const result = service.parse(request) as { ok: boolean; template?: unknown; issues?: string[] }
      if (result.ok) {
        service.persist(String(args.templateId), Number(args.templateVersion), result.template)
        return { ok: true, template: toJson(result.template) }
      }
      return { ok: false, issues: toJson(result.issues ?? []) }
    },
  }

  const requirementsTool: RawToolDefinition = {
    name: 'funding_template_requirements',
    description: '从已解析的模板包提取申报要求清单：章节树（含层级）、每章填写指令与限字数、表格要求、内容槽位。',
    parameters: {
      type: 'object',
      properties: {
        template: { type: 'object', description: '已解析的模板包' },
      },
      required: ['template'],
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args: any) => {
      const template = args.template ?? {}
      const sections: Array<Record<string, unknown>> = template.sections ?? []
      const requirements = sections.map((section, index) => {
        const entry: Record<string, unknown> = {
          sectionId: section.sectionId ?? `section-${index}`,
          title: section.title ?? `章节 ${index + 1}`,
          level: section.level ?? null,
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

  const checkTool: RawToolDefinition = {
    name: 'funding_template_check',
    description: '校验一个模板包的完整性（digest 与结构 schema）。用于导入/传输后的可信性确认。',
    parameters: {
      type: 'object',
      properties: {
        templatePackage: { type: 'object', description: '待校验的模板包' },
      },
      required: ['templatePackage'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', description: '校验是否通过' },
          issues: { type: 'array', items: { type: 'string' }, description: '失败时的具体问题' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args: any) => service.verify(args.templatePackage),
  }

  const diffTool: RawToolDefinition = {
    name: 'funding_template_diff',
    description: '对比模板旧版与新版的结构化差异（章节/指令/表格/字段映射/排版变化）。',
    parameters: {
      type: 'object',
      properties: {
        oldPackage: { type: 'object', description: '旧版模板包' },
        newPackage: { type: 'object', description: '新版模板包' },
      },
      required: ['oldPackage', 'newPackage'],
    },
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args: any) => ({ diff: toJson(service.diff(args.oldPackage, args.newPackage)) }),
  }

  return [parseTool, requirementsTool, checkTool, diffTool]
}

/** 领域对象 → 无损 JSON（canonical 输出）。 */
function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}
