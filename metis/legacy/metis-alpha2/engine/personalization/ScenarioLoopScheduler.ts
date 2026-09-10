/**
 * Scenario loop scheduler — 场景循环执行的定时调度（场景重构 P4）。
 *
 * 纯引擎：注入时钟、场景读取器与持久化回调，可完全离线测试。
 * 到期判定：loop.enabled && runCount < maxRuns &&
 *   (lastRunAt == null || now - lastRunAt >= intervalMinutes * 60_000)。
 * 触发后由调度器把 lastRunAt/runCount 写回场景定义（CAS 修订 +1），
 * 保存冲突（用户并发编辑）时放弃本次状态更新，下个 tick 重读重试。
 */
import type { ScenarioDefinition, ScenarioLoop } from '../runtime/PersonalizationRuntimeContract.js';

export interface DueLoop {
  scenarioId: string;
  scenarioRevision: number;
  loop: ScenarioLoop;
}

export interface ScenarioLoopSchedulerOptions {
  /** 读取所有（未归档）场景定义。 */
  listScenarios: () => ScenarioDefinition[];
  /** 到期触发：执行一次场景运行。返回是否成功（成功才推进 runCount）。 */
  onLoopDue: (due: DueLoop) => Promise<boolean> | boolean;
  /** 把 loop 状态写回场景定义（revision+1 的 CAS 保存）。 */
  persistLoopState: (scenarioId: string, loop: ScenarioLoop, scenarioRevision: number) => Promise<boolean> | boolean;
  now?: () => number;
  /** tick 间隔（默认 30 秒；测试注入小值）。 */
  tickIntervalMs?: number;
}

export function collectDueLoops(scenarios: readonly ScenarioDefinition[], now: number): DueLoop[] {
  const due: DueLoop[] = [];
  for (const scenario of scenarios) {
    if (!scenario.enabled) continue;
    for (const loop of scenario.loops ?? []) {
      if (!loop.enabled || loop.runCount >= loop.maxRuns) continue;
      const last = loop.lastRunAt ?? 0;
      if (now - last >= loop.intervalMinutes * 60_000) {
        due.push({ scenarioId: scenario.id, scenarioRevision: scenario.revision, loop });
      }
    }
  }
  return due;
}

export class ScenarioLoopScheduler {
  readonly #options: ScenarioLoopSchedulerOptions;
  readonly #now: () => number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #ticking = false;

  constructor(options: ScenarioLoopSchedulerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.tick(); }, this.#options.tickIntervalMs ?? 30_000);
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  isRunning(): boolean {
    return this.#timer !== null;
  }

  async tick(): Promise<number> {
    if (this.#ticking) return 0;
    this.#ticking = true;
    try {
      const due = collectDueLoops(this.#safeList(), this.#now());
      let triggered = 0;
      for (const item of due) {
        let succeeded = false;
        try {
          succeeded = await this.#options.onLoopDue(item);
        } catch {
          succeeded = false;
        }
        if (succeeded) {
          triggered += 1;
          const updated: ScenarioLoop = {
            ...item.loop,
            lastRunAt: this.#now(),
            runCount: item.loop.runCount + 1,
          };
          try {
            await this.#options.persistLoopState(item.scenarioId, updated, item.scenarioRevision);
          } catch {
            // 状态回写失败不影响触发本身；下个 tick 重读后按旧状态重试。
          }
        }
      }
      return triggered;
    } finally {
      this.#ticking = false;
    }
  }

  #safeList(): ScenarioDefinition[] {
    try {
      return this.#options.listScenarios();
    } catch {
      return [];
    }
  }
}
