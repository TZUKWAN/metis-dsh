/**
 * HITL approval step executor — human-in-the-loop gate around a step.
 *
 * Ports the WorkflowEngine HITL hook (engine/workflow) into the production
 * ScenarioRunCoordinator step-executor layer without changing the coordinator
 * itself. When the step's manifest binding requests approval, the wrapped
 * executor asks the approval hook BEFORE running the step; a denial fails the
 * step with a stable error code so the run record and resume semantics stay
 * intact. The approval hook is an injected decision function (the app wires
 * it to a real UI/native confirmation), so the coordinator never reaches into
 * the renderer.
 */

import type { ScenarioStepExecutor, ScenarioStepExecutionInput } from './ScenarioRunCoordinator.js';

export interface HitlApprovalOptions {
  /** Decision function. Receives the pending step context; resolves to a
   * boolean (true = approved, false = denied). The app must wire this to a
   * real human confirmation (native dialog/UI), never a renderer-passed flag. */
  onApprovalRequired: (input: { stepId: string; step: ScenarioStepExecutionInput['step']; runId: string }) => Promise<boolean> | boolean;
  /** Read the step's approval requirement from its snapshot. Default: step.hitl?.requireApproval === true. */
  requiresApproval?: (step: ScenarioStepExecutionInput['step']) => boolean;
}

export interface HitlApprovalResult {
  ok: boolean;
  output: unknown;
  code?: 'denied_by_user' | 'producer_failed';
  message?: string;
}

/**
 * Wrap a producing executor with an optional human-approval gate. When the
 * step requires approval and the hook denies it, the step fails with
 * code 'denied_by_user' before the producer runs. Steps that do not require
 * approval pass straight through.
 */
export function hitlApprovalExecutor(producer: ScenarioStepExecutor, options: HitlApprovalOptions): ScenarioStepExecutor {
  const { onApprovalRequired, requiresApproval } = options;
  return async (input: ScenarioStepExecutionInput): Promise<HitlApprovalResult> => {
    const step = input.step;
    const needsApproval = requiresApproval
      ? requiresApproval(step)
      : (step as { hitl?: { requireApproval?: boolean } }).hitl?.requireApproval === true;

    if (needsApproval) {
      let approved: boolean;
      try {
        approved = await onApprovalRequired({ stepId: step.id, step, runId: input.runId });
      } catch (error) {
        // An approval-path failure must fail closed, never proceed.
        return {
          ok: false,
          output: null,
          code: 'denied_by_user',
          message: error instanceof Error ? error.message.slice(0, 4_000) : 'Approval check failed closed',
        };
      }
      if (!approved) {
        return { ok: false, output: null, code: 'denied_by_user', message: 'Step was not approved by the user' };
      }
    }

    const produced = await producer(input);
    return { ok: true, output: produced };
  };
}
