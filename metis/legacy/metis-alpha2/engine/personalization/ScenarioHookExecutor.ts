/**
 * Scenario hook executor — 场景生命周期钩子的运行时执行（场景重构 P4）。
 *
 * 与 HitlApprovalExecutor 相同的包装器模式：把 step executor 包一层，
 * 按 manifest 快照中的 hooks 在步骤前后触发动作。approval 动作复用
 * fail-closed 决策注入（拒绝/决策通道异常 → 步骤以 hook_denied 失败，
 * 运行记录与 resume 语义保持不变）；notify/log 动作不阻塞，经注入的
 * 事件汇汇报。run_start/run_end 是运行级事件，由调用方在运行边界调用
 * notifyScenarioRunEvent（coordinator 没有运行级钩子点）。
 */
import type {
  ScenarioRuntimeDirective,
  ScenarioRuntimeEvent,
  ScenarioStepExecutor,
  ScenarioStepExecutionInput,
} from './ScenarioRunCoordinator.js';
import type { ResolvedRunManifest, ScenarioHook } from '../runtime/PersonalizationRuntimeContract.js';

export interface ScenarioHookEvent {
  hookId: string;
  event: ScenarioHook['event'];
  action: ScenarioHook['action'];
  stepId: string | null;
  runId: string;
  instruction: string;
  occurredAt: number;
}

export interface ScenarioHookExecutorOptions {
  hooks: readonly ScenarioHook[];
  runId: string;
  /** approval 决策：true=放行；false 或抛错=步骤失败（fail closed）。必须接到真实 UI。 */
  onApprovalRequired: (input: { hookId: string; stepId: string; instruction: string; runId: string }) => Promise<boolean> | boolean;
  /** notify/log 动作的事件汇（持久化日志、渲染通知等由宿主决定）。 */
  onHookEvent?: (event: ScenarioHookEvent) => void;
  now?: () => number;
}

function matchesStep(hook: ScenarioHook, event: 'step_start' | 'step_end', stepId: string): boolean {
  if (!hook.enabled || hook.event !== event) return false;
  return hook.matchStepId === null || hook.matchStepId === stepId;
}

/** 编译快照中的可用钩子（enabled 过滤），供运行级事件使用。 */
export function activeHooksForEvent(hooks: readonly ScenarioHook[] | undefined, event: ScenarioHook['event']): ScenarioHook[] {
  return (hooks ?? []).filter((hook) => hook.enabled && hook.event === event);
}

/** 运行级事件（run_start / run_end）：通知类钩子直接汇报，approval 不适用于运行边界。 */
export function notifyScenarioRunEvent(
  hooks: readonly ScenarioHook[] | undefined,
  event: 'run_start' | 'run_end',
  context: { runId: string; onHookEvent?: (event: ScenarioHookEvent) => void; now?: () => number },
): void {
  const now = context.now ?? Date.now;
  for (const hook of activeHooksForEvent(hooks, event)) {
    context.onHookEvent?.({
      hookId: hook.id,
      event,
      action: hook.action,
      stepId: null,
      runId: context.runId,
      instruction: hook.instruction,
      occurredAt: now(),
    });
  }
}

/** 通用事件发射：notify/log 类钩子对任意生命周期事件的非阻塞汇报。 */
export function emitScenarioHookEvent(
  hooks: readonly ScenarioHook[] | undefined,
  event: ScenarioHook['event'],
  context: { runId: string; stepId?: string | null; onHookEvent?: (event: ScenarioHookEvent) => void; now?: () => number },
): void {
  const now = context.now ?? Date.now;
  const stepId = context.stepId ?? null;
  for (const hook of activeHooksForEvent(hooks, event)) {
    if (hook.matchStepId !== null && hook.matchStepId !== stepId) continue;
    if (hook.action !== 'notify' && hook.action !== 'log') continue;
    context.onHookEvent?.({
      hookId: hook.id,
      event,
      action: hook.action,
      stepId,
      runId: context.runId,
      instruction: hook.instruction,
      occurredAt: now(),
    });
  }
}

export interface ScenarioRuntimeHookBridgeOptions {
  hooks: readonly ScenarioHook[];
  runId: string;
  /** approval 决策通道（fail closed：拒绝/异常 → pause 指令）。 */
  onApprovalRequired: (input: { hookId: string; stepId: string; instruction: string; runId: string }) => Promise<boolean> | boolean;
  onHookEvent?: (event: ScenarioHookEvent) => void;
  now?: () => number;
}

/**
 * 把 coordinator 的运行时事件（validation_failed / tool_failed / loop_iteration /
 * workflow_adjusted / checkpoint_saved）桥接到匹配钩子：notify/log 始终汇报；
 * approval 阻塞式决策，拒绝或通道异常时 fail closed 为 pause 指令；
 * retry/backtrack/pause/auto_fix/execute_prompt 映射为 coordinator 指令，
 * 首个产生指令的钩子生效（按 manifest 顺序）。
 */
export function scenarioRuntimeHookBridge(
  options: ScenarioRuntimeHookBridgeOptions,
): (event: ScenarioRuntimeEvent) => Promise<ScenarioRuntimeDirective | void> {
  const now = options.now ?? Date.now;
  return async (event: ScenarioRuntimeEvent): Promise<ScenarioRuntimeDirective | void> => {
    let directive: ScenarioRuntimeDirective | undefined;
    for (const hook of options.hooks) {
      if (!hook.enabled || hook.event !== event.event) continue;
      if (hook.matchStepId !== null && hook.matchStepId !== event.stepId) continue;
      const emit = (): void => {
        options.onHookEvent?.({
          hookId: hook.id,
          event: hook.event,
          action: hook.action,
          stepId: event.stepId,
          runId: options.runId,
          instruction: hook.instruction,
          occurredAt: now(),
        });
      };
      switch (hook.action) {
        case 'notify':
        case 'log':
          emit();
          break;
        case 'approval': {
          let approved: boolean;
          try {
            approved = await options.onApprovalRequired({
              hookId: hook.id,
              stepId: event.stepId ?? '',
              instruction: hook.instruction,
              runId: options.runId,
            });
          } catch {
            approved = false;
          }
          emit();
          if (!approved) directive ??= { action: 'pause', instruction: hook.instruction };
          break;
        }
        case 'retry':
        case 'pause':
        case 'auto_fix':
        case 'execute_prompt':
          directive ??= { action: hook.action, instruction: hook.instruction };
          emit();
          break;
        case 'backtrack':
          directive ??= {
            action: 'backtrack',
            targetStepId: hook.targetStepId ?? null,
            instruction: hook.instruction,
          };
          emit();
          break;
      }
    }
    return directive;
  };
}

/**
 * 包装 step executor：step_start 匹配钩子先触发（approval 阻塞、拒绝则步骤
 * 以 hook_denied 失败），执行后触发 step_end。成功路径原样透传 producer 的
 * 完整执行结果（ScenarioStepExecutionResult），coordinator 的严格校验不受影响。
 */
export function scenarioHookExecutor(producer: ScenarioStepExecutor, options: ScenarioHookExecutorOptions): ScenarioStepExecutor {
  const { hooks, runId, onApprovalRequired, onHookEvent } = options;
  const now = options.now ?? Date.now;
  const emit = (hook: ScenarioHook, event: 'step_start' | 'step_end', stepId: string): void => {
    onHookEvent?.({
      hookId: hook.id,
      event,
      action: hook.action,
      stepId,
      runId,
      instruction: hook.instruction,
      occurredAt: now(),
    });
  };
  return async (input: ScenarioStepExecutionInput): Promise<unknown> => {
    const stepId = input.step.id;
    for (const hook of hooks) {
      if (!matchesStep(hook, 'step_start', stepId)) continue;
      if (hook.action === 'approval') {
        let approved: boolean;
        try {
          approved = await onApprovalRequired({ hookId: hook.id, stepId, instruction: hook.instruction, runId });
        } catch (error) {
          return {
            ok: false,
            code: 'hook_denied',
            message: error instanceof Error ? error.message.slice(0, 4_000) : 'Approval hook failed closed',
          };
        }
        if (!approved) {
          return { ok: false, code: 'hook_denied', message: `Step ${stepId} was not approved by hook ${hook.id}` };
        }
      } else {
        emit(hook, 'step_start', stepId);
      }
    }
    const produced = await producer(input);
    for (const hook of hooks) {
      if (matchesStep(hook, 'step_end', stepId)) emit(hook, 'step_end', stepId);
    }
    return produced;
  };
}

/** 从 manifest 快照读取 hooks（无则空数组）。 */
export function hooksFromManifest(manifest: ResolvedRunManifest): readonly ScenarioHook[] {
  return manifest.hooks ?? [];
}
