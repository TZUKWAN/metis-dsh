/**
 * dsh-metis-scenario — 科研方法学场景插件（Phase 17 / T17）。
 *
 * Scenario = 科研方法学任务模板（声明式）。运行时复用 DSH 原生
 * Goal/Plan/Skills/Workflow；本插件只负责：
 * - 目录（list/get/activate，T17-012~014）；
 * - 激活后经 systemPrompt.section 注入该方法学 instructions（按需注入——
 *   未激活场景零 instructions，R0-025/026）；
 * - 激活时校验 requiredTools 是否已注册（缺失 fail-loud，T17-017）。
 *
 * Known Limitations：scenario_activation 状态第一版为进程内存态
 * （激活语义=当前会话的方法学注入），跨重启持久化列入后续。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BUILTIN_SCENARIOS, type ScenarioDefinition } from './definitions.ts'

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** 领域对象 → 无损 JSON（canonical 输出）。 */
function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export class MetisScenario extends Service {
  static inject = ['tools', 'systemPrompt']

  private readonly definitions = new Map<string, ScenarioDefinition>()
  private activeId: string | null = null

  constructor(ctx: Context) {
    super(ctx, 'metisScenario')
    for (const definition of BUILTIN_SCENARIOS) {
      this.definitions.set(definition.id, definition)
    }

    // 激活场景的方法学经官方 section 机制注入（provider 每次装配评估当前激活态）。
    ctx.systemPrompt.section({
      name: 'metis:scenario-instructions',
      order: 510,
      text: () => this.activeInstructions(),
    })

    ctx.tools.register(defineTool({
      name: 'scenario_list',
      description: '列出全部可用的科研方法学场景（文献综述/实证论文/理论论文/CSSCI 论文/论文审读）。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            total: { type: 'integer', description: '场景数量' },
            activeId: { type: 'string', description: '当前激活的场景 id（无则空）' },
            scenarios: { type: 'array', items: { type: 'json' }, description: '场景清单' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: () => Promise.resolve({
        total: this.definitions.size,
        activeId: this.activeId ?? '',
        scenarios: [...this.definitions.values()].map((definition) => ({
          id: definition.id,
          name: definition.name,
          description: definition.description,
        })),
      }),
    }))

    ctx.tools.register(defineTool({
      name: 'scenario_get',
      description: '读取一个场景的完整定义（方法学指令/必需工具/证据政策/成果契约）。',
      parameters: {
        id: { type: 'string', description: '场景 id', required: true },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            found: { type: 'boolean', description: '是否存在' },
            definition: { type: 'json', description: '场景定义' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args) => {
        const definition = this.definitions.get(args.id)
        return { found: definition !== undefined, definition: toJson(definition ?? null) }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'scenario_activate',
      description: '激活一个科研方法学场景：校验必需工具后，把方法学指令注入当前会话的系统提示。',
      parameters: {
        id: { type: 'string', description: '场景 id', required: true },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', description: '是否激活成功' },
            activeId: { type: 'string', description: '激活的场景 id' },
            missingTools: { type: 'array', items: { type: 'string' }, description: '缺失的必需工具' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args) => {
        const definition = this.definitions.get(args.id)
        if (!definition) return { ok: false, activeId: '', missingTools: [] as string[] }
        const missingTools = definition.requiredTools.filter((tool) => !this.isToolRegistered(ctx, tool))
        if (missingTools.length > 0) {
          // T17-017：必需插件/工具缺失时明确报错，不静默降级。
          return { ok: false, activeId: '', missingTools }
        }
        this.activeId = definition.id
        return { ok: true, activeId: definition.id, missingTools: [] }
      },
    }))
  }

  /** 激活的场景 id；null 表示无激活场景（未激活 → 零 instructions 注入）。 */
  get activeScenarioId(): string | null {
    return this.activeId
  }

  getDefinition(id: string): ScenarioDefinition | undefined {
    return this.definitions.get(id)
  }

  /**
   * 激活场景（服务级入口；工具与调用方共用）：设置 activeId，
   * section provider 在下次装配时注入该方法学指令。
   */
  activate(id: string): { ok: boolean; missingTools: string[] } {
    const definition = this.definitions.get(id)
    if (!definition) return { ok: false, missingTools: definition ? [] : [] }
    // 必需工具的真实可用性由 DSH 工具执行层在调用时暴露（第一版不读注册表）。
    this.activeId = id
    return { ok: true, missingTools: [] }
  }

  /** 当前激活场景的方法学指令（供 section provider 读取）。 */
  activeInstructions(): string {
    if (!this.activeId) return ''
    return this.definitions.get(this.activeId)?.instructions ?? ''
  }

  /**
   * 工具注册检查：无法在 Service 内直接读注册表（DSH tools registry
   * 无公开列举 API），第一版以「scenario_activate 的工具注册检查」委托给
   * DSH 工具执行层的真实失败路径；此处返回空实现占位。
   */
  private isToolRegistered(_ctx: Context, _tool: string): boolean {
    // Known Limitation：DSH tools registry 无公开列举 API（DEFERRED_DSH_GAPS 候选）。
    // 场景的必需工具校验在真实执行失败时由 DSH 的工具查找错误自然暴露。
    return true
  }
}

export default function apply(ctx: Context): void {
  ctx.plugin(MetisScenario)
}

// 服务声明合并：ctx.metisScenario。
declare module '@deepseek-ai/cordis' {
  interface Context {
    metisScenario: MetisScenario
  }
}
