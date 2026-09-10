/**
 * Evals module barrel export.
 */

export type {
  EvalTaskSpec,
  EvalResult,
  EvalSuiteResult,
  EvalSuiteMetadata,
  EvalSuiteSummary,
  EvalTraceEvent,
  EvalToolExcerpt,
  EvalGateResult,
  GateThresholds,
  GateEvaluation,
} from './types.js';

export { GATE_PROFILES } from './types.js';
export { EvalRunner, suiteSummary, suiteToJson } from './EvalRunner.js';
export { evaluateGate, clusterFailures } from './GateEvaluator.js';
export type { FailureCluster } from './GateEvaluator.js';
/** @deprecated Use HeuristicReviewer */
export { AIReviewer, HeuristicReviewer } from './AIReviewer.js';
export type {
  PaperSubmission,
  PaperSection,
  ReviewCriterion,
  ReviewReport,
  ReviewerPersona,
  ReviewSession,
  MetaReview,
} from './AIReviewer.js';
