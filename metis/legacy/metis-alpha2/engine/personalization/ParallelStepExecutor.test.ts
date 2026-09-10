/**
 * Tests for parallelExecutor — concurrent multi-agent fan-out within a step.
 */

import { describe, it, expect, vi } from 'vitest';
import { parallelExecutor, type ParallelBranch, type ParallelMergeResult } from './ParallelStepExecutor.js';
import type { ScenarioStepExecutionInput } from './ScenarioRunCoordinator.js';

const baseInput: ScenarioStepExecutionInput = {
  runId: 'run-1',
  executionKey: 'key-1',
  sessionId: 'sess-1',
  projectId: 'proj-1',
  scenarioId: 'scn-1',
  manifestDigest: 'd'.repeat(64),
  step: { id: 'step-1' } as ScenarioStepExecutionInput['step'],
  dependencyOutputs: {},
};

describe('parallelExecutor', () => {
  it('runs branches concurrently and merges their outputs', async () => {
    let calls = 0;
    const slow: ParallelBranch = {
      key: 'slow',
      executor: async () => { await new Promise((r) => setTimeout(r, 30)); calls++; return { ok: true, value: 'slow-result' }; },
    };
    const fast: ParallelBranch = {
      key: 'fast',
      executor: async () => { calls++; return { ok: true, value: 'fast-result' }; },
    };
    const start = Date.now();
    const exec = parallelExecutor([slow, fast]);
    const result = await exec(baseInput) as ParallelMergeResult;
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(true);
    expect(result.branches.slow).toMatchObject({ value: 'slow-result' });
    expect(result.branches.fast).toMatchObject({ value: 'fast-result' });
    expect(result.failedBranches).toEqual([]);
    expect(calls).toBe(2);
    // Both ran concurrently: total time is closer to the slow branch than to
    // the sum of both.
    expect(elapsed).toBeLessThan(50);
  });

  it('reports failed branches but stays ok when requireAll is false', async () => {
    const branches: ParallelBranch[] = [
      { key: 'good', executor: async () => ({ ok: true, value: 1 }) },
      { key: 'bad', executor: async () => ({ ok: false, code: 'branch_failed', message: 'boom' }) },
    ];
    const result = await parallelExecutor(branches)(baseInput) as ParallelMergeResult;
    expect(result.ok).toBe(true);
    expect(result.branches.good).toMatchObject({ value: 1 });
    expect(result.failedBranches).toEqual([{ key: 'bad', code: 'branch_failed', message: 'boom' }]);
  });

  it('fails the whole step when requireAll is true and a branch fails', async () => {
    const branches: ParallelBranch[] = [
      { key: 'good', executor: async () => ({ ok: true }) },
      { key: 'bad', executor: async () => { throw new Error('crash'); } },
    ];
    const result = await parallelExecutor(branches, { requireAll: true })(baseInput) as ParallelMergeResult;
    expect(result.ok).toBe(false);
    expect(result.failedBranches[0]?.key).toBe('bad');
    expect(result.failedBranches[0]?.message).toBe('crash');
  });

  it('passes the same step input to every branch', async () => {
    const received: ScenarioStepExecutionInput[] = [];
    const branches: ParallelBranch[] = ['a', 'b'].map((key) => ({
      key,
      executor: async (input) => { received.push(input); return { ok: true }; },
    }));
    await parallelExecutor(branches)(baseInput);
    expect(received).toHaveLength(2);
    expect(received.every((r) => r.executionKey === 'key-1')).toBe(true);
  });

  it('handles a thrown branch as a failed branch, not a crash', async () => {
    const spy = vi.fn(async () => ({ ok: true, reached: true }));
    const branches: ParallelBranch[] = [
      { key: 'throws', executor: async () => { throw new Error('oops'); } },
      { key: 'survives', executor: spy },
    ];
    const result = await parallelExecutor(branches)(baseInput) as ParallelMergeResult;
    // The other branch still ran despite the throw.
    expect(spy).toHaveBeenCalled();
    expect(result.failedBranches[0]?.key).toBe('throws');
    expect(result.branches.survives).toMatchObject({ reached: true });
  });
});
