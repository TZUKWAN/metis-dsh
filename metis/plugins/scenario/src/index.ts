import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { GoalService } from '@deepseek-ai/dsh-goal'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  MetisDataStore,
  resolveMetisDatabasePath,
  type ScenarioActivationRecord,
} from '../../../shared/data/src/index.ts'
import type { MetisResearch } from '../../core/src/index.ts'
import { BUILTIN_SCENARIOS, type ScenarioDefinition } from './definitions.ts'

export interface Config {
  databasePath?: string
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function sessionIdFor(agent?: Agent): string {
  if (!agent) throw new Error('Scenario 操作要求真实 DSH Agent Session，不能使用进程级全局状态。')
  return agent.id
}

function goalObjective(definition: ScenarioDefinition, projectTitle?: string): string {
  const topic = projectTitle?.trim() || '当前研究主题'
  return definition.goalTemplate.replace('{{topic}}', topic)
}

/**
 * Scenario only owns the durable association between a DSH session and a
 * methodology template. Goal lifecycle remains entirely in `ctx.goals`; METIS
 * never creates a parallel planner or Agent loop.
 */
export class MetisScenario extends Service {
  static inject = ['tools', 'systemPrompt', 'goals', 'metisResearch']

  private readonly definitions = new Map<string, ScenarioDefinition>()
  private readonly ready: Promise<MetisDataStore>
  private data: MetisDataStore | undefined
  private readonly research: MetisResearch
  private readonly goals: GoalService

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'metisScenario')
    for (const definition of BUILTIN_SCENARIOS) this.definitions.set(definition.id, definition)
    this.ready = MetisDataStore.open(resolveMetisDatabasePath(config.databasePath)).then((data) => {
      this.data = data
      ctx.effect(() => () => data.close(), 'metisScenario.databaseClose')
      return data
    })
    this.research = ctx.metisResearch
    this.goals = ctx.goals
    this.registerTools(ctx)

    ctx.systemPrompt.section({
      name: 'metis:scenario-instructions',
      order: 510,
      text: (assembly: AssembleContext) => this.instructionsFor(assembly.agent),
    })
  }

  async dataStore(): Promise<MetisDataStore> {
    return await this.ready
  }

  getDefinition(id: string): ScenarioDefinition | undefined {
    return this.definitions.get(id)
  }

  async getActivation(agent?: Agent): Promise<ScenarioActivationRecord | null> {
    return (await this.dataStore()).getScenarioActivation(sessionIdFor(agent))
  }

  /** Prompt assembly is synchronous: no data means no instructions, never a guess. */
  instructionsFor(agent?: Agent): string {
    if (!agent || !this.data) return ''
    const activation = this.data.getScenarioActivation(agent.id)
    return activation ? this.definitions.get(activation.scenarioId)?.instructions ?? '' : ''
  }

  private requiredToolValidation(definition: ScenarioDefinition, agent?: Agent): { state: 'validated'; missingTools: string[] } | { state: 'runtime'; missingTools: string[] } {
    if (!agent) return { state: 'runtime', missingTools: [] }
    const missingTools = definition.requiredTools.filter((tool) => this.ctx.tools.get(tool, agent) === undefined)
    return { state: 'validated', missingTools }
  }

  private async activate(definition: ScenarioDefinition, exec: ToolRunContext): Promise<{
    ok: boolean
    activeId: string
    missingTools: string[]
    validationState: 'validated' | 'runtime'
    goal: JsonValue | null
  }> {
    const validation = this.requiredToolValidation(definition, exec.agent)
    if (validation.state === 'validated' && validation.missingTools.length > 0) {
      return { ok: false, activeId: '', missingTools: validation.missingTools, validationState: validation.state, goal: null }
    }

    const agent = exec.agent
    if (!agent) {
      return { ok: false, activeId: '', missingTools: [], validationState: 'runtime', goal: null }
    }
    const project = await this.research.requireCurrentProject(agent)
    const currentGoal = this.goals.get(agent)
    if (currentGoal && currentGoal.phase !== 'complete') {
      return {
        ok: false,
        activeId: '',
        missingTools: [],
        validationState: validation.state,
        goal: toJson(currentGoal),
      }
    }
    const goal = this.goals.create(agent, { objective: goalObjective(definition, project.title) })
    const activation = (await this.dataStore()).setScenarioActivation(agent.id, project.id, definition.id)
    return {
      ok: true,
      activeId: activation.scenarioId,
      missingTools: [],
      validationState: validation.state,
      goal: toJson(goal),
    }
  }

  private registerTools(ctx: Context): void {
    ctx.tools.register(defineTool({
      name: 'scenario_list',
      description: '列出 METIS 可用的科研方法学场景，以及当前 DSH Session 的持久化激活状态。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { total: { type: 'integer' }, activeId: { type: 'string' }, scenarios: { type: 'array', items: { type: 'json' } } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (_args, exec: ToolRunContext) => {
        const activation = exec.agent ? await this.getActivation(exec.agent) : null
        return {
          total: this.definitions.size,
          activeId: activation?.scenarioId ?? '',
          scenarios: [...this.definitions.values()].map((definition) => toJson({
            id: definition.id,
            name: definition.name,
            description: definition.description,
          })),
        }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'scenario_get',
      description: '读取一个场景的完整方法学定义、必需工具、证据政策和成果契约。',
      parameters: { id: { type: 'string', description: '场景 id', required: true } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { found: { type: 'boolean' }, definition: { type: 'json' } },
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
      description: '为当前 DSH Session 激活持久化科研方法学场景。它验证当前 agent 可见工具，并通过 DSH 原生 Goal 服务创建目标。',
      parameters: { id: { type: 'string', description: '场景 id', required: true } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            activeId: { type: 'string' },
            missingTools: { type: 'array', items: { type: 'string' } },
            validationState: { type: 'string' },
            goal: { type: 'json' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (args, exec: ToolRunContext) => {
        const definition = this.definitions.get(args.id)
        if (!definition) {
          return { ok: false, activeId: '', missingTools: [], validationState: 'validated', goal: null }
        }
        return await this.activate(definition, exec)
      },
    }))
  }
}

export default {
  name: 'metis-scenario',
  inject: ['tools', 'systemPrompt', 'goals', 'metisResearch'],
  apply(ctx: Context, config?: Config): void {
    ctx.plugin(MetisScenario, config ?? {})
  },
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    metisScenario: MetisScenario
  }
}
