/**
 * Evals types — task specifications, results, and gate thresholds.
 *
 * Ported from metis/evals/runner.py (EvalTaskSpec, EvalResult, EvalSuiteResult).
 */

// ─── Eval Task Spec ───────────────────────────────────────────

export interface EvalTaskSpec {
  /** Unique task identifier. */
  id: string;
  /** The prompt to send to the agent. */
  prompt: string;
  /** Fixture type for deterministic tasks (no model call). */
  fixtureType?: string;
  /** Whether this task requires model execution. */
  requiresModelExecution?: boolean;
  /** Tool names allowed for this task. */
  allowedTools?: string[];
  /** Maximum turns for this task. */
  maxTurns?: number;
  /** Quality gate names to check. */
  qualityGates?: string[];
  /** Whether the final answer must be verified. */
  requireVerifiedFinal?: boolean;
  /** Tools that must be called during execution. */
  requiredTools?: string[];
  /** Tools that must NOT be called. */
  forbiddenTools?: string[];
  /** Max duplicate tool calls allowed. */
  maxDuplicateToolCalls?: number;
  /** Max invalid tool calls allowed. */
  maxInvalidToolCalls?: number;
  /** Max tool failures allowed. */
  maxToolFailures?: number;
  /** Whether recovered tool failures count as OK. */
  allowRecoveredToolFailures?: boolean;
  /** Requirements the agent must satisfy. */
  requirements?: string[];
}

// ─── Eval Result ──────────────────────────────────────────────

export interface EvalResult {
  taskId: string;
  success: boolean;
  status: string;
  turnsUsed: number;
  toolCalls: number;
  latencyMs: number;
  toolFailures: number;
  qualityFailures: number;
  falseCompletion: boolean;
  finalVerified: boolean;
  duplicateToolCalls: number;
  invalidToolCalls: number;
  trajectoryFailures: number;
  errors: string[];
  traceEvents: EvalTraceEvent[];
  toolResultExcerpts: EvalToolExcerpt[];
  qualityGateResults: EvalGateResult[];
}

export interface EvalTraceEvent {
  index: number;
  eventType: string;
  timestamp: number;
  status: string;
  attributes: Record<string, unknown>;
}

export interface EvalToolExcerpt {
  index: number;
  toolName: string;
  toolCallId: string;
  status: string;
  failed: boolean;
  contentPreview: string;
  errorPreview: string;
}

export interface EvalGateResult {
  name: string;
  passed: boolean;
  message: string;
}

// ─── Eval Suite Result ────────────────────────────────────────

export interface EvalSuiteResult {
  results: EvalResult[];
  metadata: EvalSuiteMetadata;
  taskSpecs: Record<string, EvalTaskSpec>;
}

export interface EvalSuiteMetadata {
  suite: string;
  taskCount: number;
  model: string;
  profile: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface EvalSuiteSummary {
  taskCount: number;
  passed: number;
  failed: number;
  successRate: number;
}

// ─── Gate Thresholds ──────────────────────────────────────────

export interface GateThresholds {
  minSuccessRate: number;
  maxFailedTasks: number;
  maxInvalidToolCalls: number;
  maxToolFailures: number;
  maxTrajectoryFailures: number;
  maxFailureClusters: number;
}

export const GATE_PROFILES: Record<string, GateThresholds> = {
  dev: {
    minSuccessRate: 0.8,
    maxFailedTasks: 2,
    maxInvalidToolCalls: 2,
    maxToolFailures: 3,
    maxTrajectoryFailures: 2,
    maxFailureClusters: 3,
  },
  candidate: {
    minSuccessRate: 0.95,
    maxFailedTasks: 1,
    maxInvalidToolCalls: 0,
    maxToolFailures: 1,
    maxTrajectoryFailures: 0,
    maxFailureClusters: 1,
  },
  release: {
    minSuccessRate: 1.0,
    maxFailedTasks: 0,
    maxInvalidToolCalls: 0,
    maxToolFailures: 0,
    maxTrajectoryFailures: 0,
    maxFailureClusters: 0,
  },
};

export interface GateEvaluation {
  passed: boolean;
  profile: string;
  thresholds: GateThresholds;
  aggregates: Record<string, number>;
  failures: string[];
  failedTasks: string[];
}
