/**
 * QA review step executor — an independent quality gate that reviews a step's
 * produced output against user-written quality criteria.
 *
 * The production scenario records quality criteria as self-assessed booleans
 * filled by the same agent that produced the output. This combinator turns
 * that into an independent review: a separate reviewer function receives the
 * candidate output (and the quality criteria it must satisfy) and returns a
 * verdict. When the verdict fails, the step fails — so a downstream consumer
 * cannot treat an unreviewed or rejected draft as final.
 *
 * Modeled on engine/evals GateEvaluator's GateEvaluation shape so results are
 * consistent with the existing quality-gate vocabulary.
 */

import type { ScenarioStepExecutor, ScenarioStepExecutionInput } from './ScenarioRunCoordinator.js';

export interface QaVerdict {
  passed: boolean;
  /** Human-readable failure reasons (empty when passed). */
  failures: string[];
  /** Optional reviewer metadata (e.g. reviewer persona, score). */
  metadata?: Record<string, unknown>;
}

export interface QaReviewOptions {
  /**
   * Independent reviewer. Receives the candidate output and the quality
   * criteria text, returns a verdict. This MUST be a different agent/prompt
   * than the one that produced the output, otherwise the review is not
   * independent.
   */
  reviewer: (input: { output: unknown; qualityCriteria: readonly string[]; stepInput: ScenarioStepExecutionInput }) => Promise<QaVerdict> | QaVerdict;
  /** Quality criteria the output must satisfy. Defaults to the step snapshot's own criteria when present. */
  qualityCriteria?: readonly string[];
  /** When true, a failed review still records the output but marks the step ok=false. */
  blockOnFailure?: boolean;
}

export interface QaReviewResult {
  ok: boolean;
  output: unknown;
  verdict: QaVerdict;
}

/**
 * Wrap a producing executor with an independent QA review. The producer runs
 * first; if it succeeds, the reviewer evaluates its output against the quality
 * criteria. A failed review fails the step unless blockOnFailure is false.
 */
export function qaReviewExecutor(producer: ScenarioStepExecutor, options: QaReviewOptions): ScenarioStepExecutor {
  const { reviewer, blockOnFailure = true } = options;
  return async (input: ScenarioStepExecutionInput): Promise<QaReviewResult> => {
    const produced = await producer(input);
    const producedResult = produced as { ok?: boolean; code?: string; message?: string; output?: unknown } | undefined;

    // If the producer itself failed, there is nothing to review.
    if (producedResult && producedResult.ok === false) {
      return {
        ok: false,
        output: produced,
        verdict: { passed: false, failures: [`Producer failed before review: ${producedResult.code ?? 'unknown'}`] },
      };
    }

    const candidate = producedResult?.output ?? produced;
    const criteria = options.qualityCriteria
      ?? (input.step as { qualityCriteria?: string[] } | undefined)?.qualityCriteria
      ?? [];

    const verdict = await reviewer({ output: candidate, qualityCriteria: criteria, stepInput: input });

    if (!verdict.passed && blockOnFailure) {
      return { ok: false, output: candidate, verdict };
    }
    return { ok: true, output: candidate, verdict };
  };
}
