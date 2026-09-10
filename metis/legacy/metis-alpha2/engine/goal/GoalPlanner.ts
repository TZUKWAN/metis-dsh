/**
 * GoalPlanner — 将用户目标自动拆解为细粒度 WorkflowDefinition。
 *
 * 使用 AgentLoop + 特殊 planning prompt 生成 workflow definition。
 * 每个步骤只做最小操作，适合小模型执行。
 */

import type { WorkflowDefinition, WorkflowStep } from '../workflow/types.js';

export interface Goal {
  id: string;
  description: string;
  context?: string;
  createdAt: number;
  status: 'draft' | 'planning' | 'ready' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  /** Kanban priority: low|medium|high|urgent (default medium). */
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  /** Owning research project (absent = unbound/global task). */
  projectId?: string;
  /** Monotonic revision of the persisted Workflow plan for this Goal. */
  planVersion: number;
  /** Monotonic execution-attempt revision, retained across checkpoint resumes. */
  runVersion: number;
}

export interface PlanResult {
  goal: Goal;
  workflow: WorkflowDefinition;
  reasoning: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ─── Planning Prompt ──────────────────────────────────────────

const PLANNING_SYSTEM_PROMPT = `You are a task decomposition expert. Your job is to break down a user goal into a fine-grained workflow of small, executable steps.

RULES:
1. Each step must do ONE minimal operation (read, extract, summarize, compare, write, etc.)
2. Steps should be 5-15 in number. If the goal is simple, use fewer. If complex, use more.
3. Each step must have clear input/output contracts.
4. Use sequential dependencies (step N depends on step N-1) unless parallel is obvious.
5. Max turns per step: 6 (small model limit).
6. Tools allowed: read_file, write_file, web_search, compare_items.
7. Every step MUST define objective acceptanceCriteria so completion is machine-verifiable, not just LLM self-assessment. A step is only "done" when all its criteria pass. Use these kinds:
   - { "kind": "minLength", "value": "50", "description": "回答不少于 50 字" }
   - { "kind": "contains", "value": "参考文献", "description": "必须列出参考文献" }
   - { "kind": "notContains", "value": "我无法", "description": "不得是拒答" }
   - { "kind": "regex", "value": "10\\\\.\\\\d{4,9}/.+", "description": "包含 DOI" }
   Add 1-3 criteria per step that would be cheap to verify but catch hollow/off-topic answers.
8. Output MUST be valid JSON matching the WorkflowDefinition schema.

OUTPUT FORMAT (JSON):
{
  "id": "wf_<timestamp>",
  "name": "Short name",
  "description": "What this workflow accomplishes",
  "version": "1.0",
  "steps": [
    {
      "id": "step_1",
      "name": "Descriptive name",
      "description": "What this step does",
      "prompt": "Detailed prompt for the agent. Use {{input.key}} for global input, {{stepId.output}} for upstream output.",
      "inputFrom": ["step_0"],
      "tools": ["read_file"],
      "maxTurns": 6,
      "acceptanceCriteria": [
        { "kind": "minLength", "value": "50", "description": "输出不少于 50 字" }
      ]
    }
  ],
  "dependencies": {
    "step_1": ["step_0"],
    "step_2": ["step_1"]
  }
}`;

const REFINEMENT_PROMPT = `You are refining a workflow plan based on user feedback.

Current workflow:
{{workflow}}

User feedback:
{{feedback}}

Please output the revised workflow as valid JSON with the same schema. Keep steps fine-grained and minimal.`;

// ─── GoalPlanner ──────────────────────────────────────────────

export class GoalPlanner {
  /**
   * Build a planning prompt for the given goal.
   */
  buildPlanningPrompt(goal: Goal): string {
    const contextPart = goal.context ? `\n\nAdditional context:\n${goal.context}` : '';
    return `${PLANNING_SYSTEM_PROMPT}\n\nUSER GOAL:\n${goal.description}${contextPart}\n\nGenerate the workflow JSON now.`;
  }

  /**
   * Build a refinement prompt based on feedback.
   */
  buildRefinementPrompt(workflow: WorkflowDefinition, feedback: string): string {
    return REFINEMENT_PROMPT
      .replace('{{workflow}}', JSON.stringify(workflow, null, 2))
      .replace('{{feedback}}', feedback);
  }

  /**
   * Validate a generated plan.
   */
  validatePlan(workflow: WorkflowDefinition): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check basic structure
    if (!workflow.id) errors.push('Workflow missing id');
    if (!workflow.name) errors.push('Workflow missing name');
    if (!workflow.steps || workflow.steps.length === 0) {
      errors.push('Workflow has no steps');
    }

    // Check step granularity
    for (const step of workflow.steps) {
      if (!step.id) errors.push(`Step missing id`);
      if (!step.prompt) errors.push(`Step '${step.id}' missing prompt`);
      if (step.maxTurns > 10) {
        warnings.push(`Step '${step.id}' has maxTurns=${step.maxTurns}, consider splitting`);
      }
      if (step.prompt && step.prompt.length > 2000) {
        warnings.push(`Step '${step.id}' prompt is very long (${step.prompt.length} chars)`);
      }
    }

    // Check dependencies
    const stepIds = new Set(workflow.steps.map((s) => s.id));
    for (const [stepId, deps] of Object.entries(workflow.dependencies)) {
      if (!stepIds.has(stepId)) {
        errors.push(`Dependency key '${stepId}' not found in steps`);
      }
      for (const dep of deps) {
        if (!stepIds.has(dep)) {
          errors.push(`Step '${stepId}' depends on non-existent step '${dep}'`);
        }
      }
    }

    // Check for orphan steps (no deps, not depended on)
    const allDeps = new Set<string>();
    const allDependents = new Set<string>();
    for (const [stepId, deps] of Object.entries(workflow.dependencies)) {
      allDependents.add(stepId);
      for (const dep of deps) allDeps.add(dep);
    }
    for (const step of workflow.steps) {
      if (!allDeps.has(step.id) && !allDependents.has(step.id) && workflow.steps.length > 1) {
        warnings.push(`Step '${step.id}' appears to be isolated`);
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Decompose a step that is too coarse into smaller steps.
   * Returns array of new steps to replace the original.
   */
  decomposeStep(step: WorkflowStep): WorkflowStep[] {
    // Simple heuristic: if prompt contains multiple distinct tasks, split them
    const tasks = step.prompt
      .split(/\n\n(?=Task \d+:|Step \d+:|\d+\. )/)
      .filter((t) => t.trim().length > 0);

    if (tasks.length <= 1) {
      // Can't decompose automatically
      return [step];
    }

    return tasks.map((task, i) => ({
      id: `${step.id}_${i + 1}`,
      name: `${step.name} (part ${i + 1})`,
      description: `Sub-task ${i + 1} of ${step.name}`,
      prompt: task.trim(),
      inputFrom: i === 0 ? step.inputFrom : [`${step.id}_${i}`],
      tools: step.tools,
      maxTurns: step.maxTurns,
    }));
  }

  /**
   * Create a new Goal object.
   */
  static createGoal(description: string, context?: string, projectId?: string): Goal {
    return {
      id: `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      description,
      context,
      createdAt: Date.now(),
      status: 'draft',
      planVersion: 0,
      runVersion: 0,
      ...(projectId ? { projectId } : {}),
    };
  }
}
