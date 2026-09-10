/**
 * Workflow module barrel export.
 */

export type {
  WorkflowDefinition,
  WorkflowStep,
  StepHITLConfig,
  StepRetryConfig,
  WorkflowRun,
  StepResult,
  WorkflowStatus,
  StepStatus,
  WorkflowHooks,
} from './types.js';

export { topologicalSort, validateWorkflowDefinition } from './types.js';
export { WorkflowEngine } from './WorkflowEngine.js';
export { LITERATURE_REVIEW_WORKFLOW } from './templates/literature-review.js';
export { PAPER_WRITING_WORKFLOW } from './templates/paper-writing.js';
export { EXPERIMENT_DESIGN_WORKFLOW } from './templates/experiment-design.js';
export { DATA_ANALYSIS_WORKFLOW } from './templates/data-analysis.js';
