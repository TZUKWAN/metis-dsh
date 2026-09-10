import type { RuntimeShutdownCoordinator } from './RuntimeShutdownCoordinator.js';

export interface ScenarioLoopDueLike {
  scenarioId: string;
  loop: { id: string };
}

export interface ActiveScenarioLoopRun {
  completion: Promise<void>;
  resolveCompletion: () => void;
  controller: AbortController;
}

export interface ScenarioLoopRunTrackerOptions {
  activeRuns: Map<string, ActiveScenarioLoopRun>;
  runtimeShutdown: Pick<RuntimeShutdownCoordinator, 'isDraining' | 'register'>;
}

type TrackedRunFailure = {
  ok: false;
  code: 'application_shutting_down' | 'scenario_loop_already_running';
  status?: undefined;
};

/**
 * Wraps one scenario loop execution in the process-wide shutdown lifecycle.
 * The active map is the concurrency gate; the coordinator owns abort + drain.
 */
export function createScenarioLoopRunTracker(options: ScenarioLoopRunTrackerOptions) {
  return async function runScenarioLoopTracked<T extends { ok: boolean; code?: string; status?: string }>(
    due: ScenarioLoopDueLike,
    source: 'scheduler' | 'run-now',
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | TrackedRunFailure> {
    if (options.runtimeShutdown.isDraining()) {
      return { ok: false, code: 'application_shutting_down' };
    }

    const key = `${due.scenarioId}:${due.loop.id}`;
    if (options.activeRuns.has(key)) {
      return { ok: false, code: 'scenario_loop_already_running' };
    }

    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const controller = new AbortController();
    const active: ActiveScenarioLoopRun = { completion, resolveCompletion, controller };
    options.activeRuns.set(key, active);

    const unregister = options.runtimeShutdown.register({
      id: `scenario:${source}:${key}`,
      promise: completion,
      abort: () => controller.abort(),
    });
    if (!unregister) {
      if (options.activeRuns.get(key) === active) options.activeRuns.delete(key);
      resolveCompletion();
      return { ok: false, code: 'application_shutting_down' };
    }

    try {
      return await execute(controller.signal);
    } finally {
      if (options.activeRuns.get(key) === active) options.activeRuns.delete(key);
      resolveCompletion();
      unregister();
    }
  };
}
