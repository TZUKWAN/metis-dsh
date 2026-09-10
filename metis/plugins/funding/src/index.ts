/**
 * dsh-metis-funding — 基金申报模板领域插件入口（Phase 20）。
 *
 * 核心 analyzer（章节树/限字数/表格/字段映射/版本 diff）复用 shared/funding
 * （提取自 legacy FundingTemplateAnalyzer.ts，语义不变）。
 * 工具定义见 tools.ts（原始 JSON-Schema 形状，ctx.tools.register 直接接受）。
 *
 * 纪律（T20-027/028）：本插件只处理模板结构与要求；履历/经费/成果等
 * 用户事实缺失时明确列为缺口，绝不编造。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createFundingTools } from './tools.ts'

export { createFundingTools, MetisFunding } from './tools.ts'
export type { Config, RawToolDefinition } from './tools.ts'

export const name = 'metis-funding'

export const inject = ['tools']

export function apply(ctx: Context): void {
  for (const tool of createFundingTools(ctx?.metisDataFile)) {
    ctx.tools.register(tool)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    metisDataFile?: string
  }
}
