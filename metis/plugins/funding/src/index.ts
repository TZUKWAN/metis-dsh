/**
 * dsh-metis-funding — 基金申报模板领域插件入口。
 *
 * 模板解析/要求提取/完整性校验/版本 diff + 材料缺口 + 章节草稿。
 * 持久化统一走 MetisDataStore（SQLite），不再使用独立 JSON 文件。
 *
 * 纪律：本插件只处理模板结构与要求；履历/经费/成果等用户事实缺失时
 * 明确列为缺口（needs_user_confirmation），绝不编造。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MetisResearch } from '../../core/src/index.ts'
import { createFundingTools } from './tools.ts'

export { createFundingTools, MetisFunding } from './tools.ts'
export type { Config } from './tools.ts'

export default {
  name: 'metis-funding',
  inject: ['tools', 'metisResearch'],
  apply(ctx: Context, config?: import('./tools.ts').Config): void {
    const research: MetisResearch = ctx.metisResearch
    const data = import('../../../shared/data/src/index.ts').then(({ MetisDataStore, resolveMetisDatabasePath }) =>
      MetisDataStore.open(resolveMetisDatabasePath(config?.databasePath)))
    data.then((store) => {
      ctx.effect(() => () => store.close(), 'metisFunding.databaseClose')
    }).catch(() => undefined)
    for (const tool of createFundingTools(research, data)) {
      ctx.tools.register(tool as never)
    }
  },
}
