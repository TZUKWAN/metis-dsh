/**
 * researchPhases — structural validity of the 4 phase WorkflowDefinitions.
 *
 * Verifies each phase is a well-formed DAG (deps reference existing steps,
 * no cycles), references only real builtin tools, and the input builder
 * threads goal + prior outputs.
 */

import { describe, it, expect } from 'vitest';
import {
  IDEA_PHASE_WORKFLOW,
  EXPERIMENT_PHASE_WORKFLOW,
  ANALYSIS_PHASE_WORKFLOW,
  PAPER_PHASE_WORKFLOW,
  PHASE_WORKFLOWS,
  buildPhaseInput,
} from '../../engine/research/researchPhases.js';
import { topologicalSort } from '../../engine/workflow/types.js';
import type { WorkflowDefinition } from '../../engine/workflow/types.js';

const ALL_REAL_TOOLS = new Set([
  'arxiv_search', 'search_papers', 'crossref_lookup', 'openalex_lookup', 'recommend_papers',
  'literature_review', 'literature_triage', 'read_pdf', 'memory_recall', 'memory_remember',
  'multi_agent_orchestrate', 'claim_manifest_add', 'claim_manifest_list', 'claim_manifest_verify',
  'execute_code', 'write_file', 'read_file', 'run_experiment_script', 'experiment_stats',
  'experiment_compare', 'findings_add', 'findings_list', 'experiment_to_findings', 'verify_claim',
  'provenance_check', 'reference_check', 'figure_audit', 'table_audit', 'writing_stage_check',
  'section_guide', 'skill_execute', 'format_citation', 'latex_cleanup', 'math_audit',
  'section_audit', 'latex_integrity_report', 'tags_audit', 'style_calibration', 'integrity_report',
]);

function validateWorkflow(def: WorkflowDefinition) {
  // steps have unique ids
  const ids = def.steps.map((s) => s.id);
  expect(new Set(ids).size, `duplicate step ids in ${def.id}`).toBe(ids.length);
  // dependencies reference existing steps
  for (const [stepId, deps] of Object.entries(def.dependencies)) {
    expect(ids, `dependency key ${stepId} not a step in ${def.id}`).toContain(stepId);
    for (const dep of deps) {
      expect(ids, `dep ${dep} of ${stepId} not a step in ${def.id}`).toContain(dep);
    }
  }
  // topological sort does not throw (no cycle)
  expect(() => topologicalSort(def)).not.toThrow();
  // inputFrom references existing steps
  for (const step of def.steps) {
    for (const dep of step.inputFrom) {
      expect(ids, `inputFrom ${dep} of ${step.id} not a step in ${def.id}`).toContain(dep);
    }
  }
  // every tool referenced exists in the builtin registry
  for (const step of def.steps) {
    for (const tool of step.tools) {
      expect(ALL_REAL_TOOLS.has(tool), `unknown tool '${tool}' in ${def.id}.${step.id}`).toBe(true);
    }
  }
  // every step has a prompt and maxTurns
  for (const step of def.steps) {
    expect(step.prompt.length).toBeGreaterThan(0);
    expect(step.maxTurns).toBeGreaterThan(0);
  }
}

describe('researchPhases', () => {
  it('idea phase is a valid DAG with real tools', () => {
    validateWorkflow(IDEA_PHASE_WORKFLOW);
  });
  it('experiment phase is a valid DAG with real tools', () => {
    validateWorkflow(EXPERIMENT_PHASE_WORKFLOW);
  });
  it('analysis phase is a valid DAG with real tools', () => {
    validateWorkflow(ANALYSIS_PHASE_WORKFLOW);
  });
  it('paper phase is a valid DAG with real tools', () => {
    validateWorkflow(PAPER_PHASE_WORKFLOW);
  });

  it('PHASE_WORKFLOWS covers all 4 phase kinds', () => {
    expect(Object.keys(PHASE_WORKFLOWS).sort()).toEqual(['analysis', 'experiment', 'idea', 'paper']);
  });

  it('buildPhaseInput threads goal and prior outputs', () => {
    const input = buildPhaseInput('my goal', { idea: 'hypothesis output' });
    expect(input.goal).toBe('my goal');
    expect(input.idea).toBe('hypothesis output');
  });

  it('buildPhaseInput appends revision note to goal when provided', () => {
    const input = buildPhaseInput('my goal', {}, 'fix the methodology');
    expect(String(input.goal)).toContain('fix the methodology');
    expect(String(input.goal)).toContain('[反思修订要求]');
  });
});
