import { describe, expect, it, vi } from 'vitest';
import { RuntimeShutdownCoordinator } from './RuntimeShutdownCoordinator.js';
import { createScenarioLoopRunTracker, type ActiveScenarioLoopRun } from './ScenarioLoopRunTracker.js';

const due = { scenarioId: 'scenario-1', loop: { id: 'loop-1' } };

describe('ScenarioLoopRunTracker', () => {
  it('rejects duplicate runs, aborts on shutdown, waits for completion, and cleans up', async () => {
    const activeRuns = new Map<string, ActiveScenarioLoopRun>();
    const runtimeShutdown = new RuntimeShutdownCoordinator();
    const runScenarioLoopTracked = createScenarioLoopRunTracker({ activeRuns, runtimeShutdown });
    let resolveExecution!: (value: { ok: true }) => void;
    let observedSignal!: AbortSignal;

    const run = runScenarioLoopTracked(due, 'run-now', (signal): Promise<{ ok: true }> => {
      observedSignal = signal;
      return new Promise<{ ok: true }>((resolve) => { resolveExecution = resolve; });
    });
    await Promise.resolve();
    expect(activeRuns.size).toBe(1);
    expect(observedSignal.aborted).toBe(false);

    await expect(
      runScenarioLoopTracked(due, 'scheduler', vi.fn(async () => ({ ok: true }))),
    ).resolves.toEqual({ ok: false, code: 'scenario_loop_already_running' });

    const draining = runtimeShutdown.drain(1000);
    expect(observedSignal.aborted).toBe(true);
    expect(activeRuns.size).toBe(1);
    resolveExecution({ ok: true });

    await expect(run).resolves.toEqual({ ok: true });
    await expect(draining).resolves.toEqual({ timedOut: false, pending: [] });
    expect(activeRuns.size).toBe(0);
  });

  it('rejects new runs once shutdown has started without invoking the executor', async () => {
    const activeRuns = new Map<string, ActiveScenarioLoopRun>();
    const runtimeShutdown = new RuntimeShutdownCoordinator();
    const runScenarioLoopTracked = createScenarioLoopRunTracker({ activeRuns, runtimeShutdown });
    await expect(runtimeShutdown.drain()).resolves.toEqual({ timedOut: false, pending: [] });

    const execute = vi.fn(async () => ({ ok: true }));
    await expect(runScenarioLoopTracked(due, 'run-now', execute)).resolves.toEqual({
      ok: false,
      code: 'application_shutting_down',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(activeRuns.size).toBe(0);
  });

  it('cleans up tracking when execution rejects', async () => {
    const activeRuns = new Map<string, ActiveScenarioLoopRun>();
    const runtimeShutdown = new RuntimeShutdownCoordinator();
    const runScenarioLoopTracked = createScenarioLoopRunTracker({ activeRuns, runtimeShutdown });
    const failure = new Error('loop failed');

    await expect(
      runScenarioLoopTracked(due, 'scheduler', async () => { throw failure; }),
    ).rejects.toBe(failure);
    expect(activeRuns.size).toBe(0);
    await expect(runtimeShutdown.drain()).resolves.toEqual({ timedOut: false, pending: [] });
  });
});
