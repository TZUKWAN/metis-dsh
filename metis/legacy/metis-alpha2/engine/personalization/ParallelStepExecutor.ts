/**
 * Parallel step executor — runs several ScenarioStepExecutors concurrently
 * within a single workflow step and merges their outputs.
 *
 * The production ScenarioRunCoordinator executes workflow steps serially with
 * strict checkpoint/resume semantics (a frozen executionOrder + per-step
 * digest). Changing that to Promise.all across steps would break the resume
 * trust model. Instead, this combinator provides real multi-agent parallelism
 * *inside* one step: each branch runs concurrently, the branch that fails
 * surfaces its error, and the merged output is what the step records. This
 * keeps the coordinator's serial-checkpoint contract intact while letting a
 * single step fan out to multiple agents.
 */

import type { ScenarioStepExecutor, ScenarioStepExecutionInput } from './ScenarioRunCoordinator.js';

export interface ParallelBranch {
  /** Identifier for this branch, used in the merged output map. */
  key: string;
  /** Executor for this branch. Receives the same step input as every branch. */
  executor: ScenarioStepExecutor;
}

export interface ParallelMergeResult {
  ok: boolean;
  /** Branch key -> branch result (raw). Failed branches are absent. */
  branches: Record<string, unknown>;
  /** Branch keys that threw or returned ok:false. */
  failedBranches: Array<{ key: string; code?: string; message?: string }>;
}

/**
 * Build a ScenarioStepExecutor that fans the step input out to every branch
 * executor in parallel and merges their results. If `requireAll` is true, any
 * branch failure fails the whole step (ok:false); otherwise partial success is
 * reported with the failed branches listed.
 */
export function parallelExecutor(
  branches: readonly ParallelBranch[],
  options: { requireAll?: boolean } = {},
): ScenarioStepExecutor {
  const requireAll = options.requireAll ?? false;
  return async (input: ScenarioStepExecutionInput): Promise<ParallelMergeResult> => {
    const settled = await Promise.allSettled(
      branches.map((branch) => branch.executor(input)),
    );
    const merged: Record<string, unknown> = {};
    const failedBranches: ParallelMergeResult['failedBranches'] = [];
    branches.forEach((branch, index) => {
      const outcome = settled[index];
      if (outcome?.status === 'fulfilled') {
        const value = outcome.value as { ok?: boolean; code?: string; message?: string } | undefined;
        if (value && value.ok === false) {
          failedBranches.push({ key: branch.key, code: value.code, message: value.message });
        } else {
          merged[branch.key] = outcome.value;
        }
      } else if (outcome?.status === 'rejected') {
        const reason = outcome.reason;
        failedBranches.push({
          key: branch.key,
          message: reason instanceof Error ? reason.message.slice(0, 4_000) : 'Branch executor failed',
        });
      }
    });
    const ok = failedBranches.length === 0 || !requireAll;
    return { ok, branches: merged, failedBranches };
  };
}
