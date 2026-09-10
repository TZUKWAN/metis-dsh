/**
 * Eval runner — executes eval tasks through the AgentLoop and collects results.
 *
 * Ported from metis/evals/runner.py (EvalRunner, EvalSuiteResult).
 *
 * Flow:
 *   1. For each EvalTaskSpec, run AgentLoop with the task's prompt
 *   2. Analyze the AgentRunResult for failures, tool errors, quality gates
 *   3. Produce EvalResult with detailed metrics
 *   4. Aggregate into EvalSuiteResult with summary statistics
 */

import type {
  EvalTaskSpec,
  EvalResult,
  EvalSuiteResult,
  EvalSuiteMetadata,
  EvalSuiteSummary,
  EvalToolExcerpt,
  EvalGateResult,
} from './types.js';
import type { AgentRunRequest, AgentRunResult } from '../core/types.js';
import type { AgentLoop } from '../core/AgentLoop.js';

export class EvalRunner {
  private readonly loop: AgentLoop;

  constructor(loop: AgentLoop) {
    this.loop = loop;
  }

  /**
   * Run a single eval task through the agent loop.
   */
  async runTask(task: EvalTaskSpec, sessionId?: string): Promise<EvalResult> {
    const sid = sessionId ?? `eval-${task.id}`;
    const startTime = performance.now();

    // Deterministic fixture (no model call)
    if (task.fixtureType && !task.requiresModelExecution) {
      return {
        taskId: task.id,
        success: true,
        status: 'fixture_skipped',
        turnsUsed: 0,
        toolCalls: 0,
        latencyMs: Math.round(performance.now() - startTime),
        toolFailures: 0,
        qualityFailures: 0,
        falseCompletion: false,
        finalVerified: false,
        duplicateToolCalls: 0,
        invalidToolCalls: 0,
        trajectoryFailures: 0,
        errors: [],
        traceEvents: [],
        toolResultExcerpts: [],
        qualityGateResults: [],
      };
    }

    // Build request from task spec
    const request: AgentRunRequest = {
      sessionId: sid,
      messages: [{ role: 'user', content: task.prompt }],
      allowedTools: task.allowedTools,
      maxTurns: task.maxTurns ?? 12,
      taskContractHash: '',
      promptStackHash: '',
      resumeFromCheckpoint: false,
      requestId: `eval-${task.id}`,
    };

    const runResult: AgentRunResult = await this.loop.run(request);
    const latencyMs = Math.round(performance.now() - startTime);

    // Analyze results
    const toolFailures = countToolFailures(runResult, task.allowRecoveredToolFailures ?? false);
    const duplicateToolCalls = countDuplicateToolCalls(runResult);
    const invalidToolCalls = countInvalidToolCalls(runResult);
    const falseCompletion = runResult.errors.some((e) => e.includes('Completion claim without evidence'));

    // Check tool constraints
    const constraintErrors = checkToolConstraints(task, runResult);

    // Check quality gates
    const qualityGateResults = checkQualityGates(task, runResult);
    const qualityFailures = qualityGateResults.filter((r) => !r.passed).length;

    // Trajectory errors (aggregate of various failure types)
    const trajectoryFailures = countTrajectoryErrors(
      duplicateToolCalls,
      invalidToolCalls,
      toolFailures,
      constraintErrors,
    );

    // Determine success
    const finalVerified = runResult.status === 'completed' && runResult.finalVerified;
    const success =
      runResult.status === 'completed' &&
      toolFailures === 0 &&
      qualityFailures === 0 &&
      !falseCompletion &&
      (finalVerified || !task.requireVerifiedFinal) &&
      trajectoryFailures === 0 &&
      constraintErrors.length === 0;

    return {
      taskId: task.id,
      success,
      status: runResult.status,
      turnsUsed: runResult.turnsUsed,
      toolCalls: runResult.toolResults.length,
      latencyMs,
      toolFailures,
      qualityFailures,
      falseCompletion,
      finalVerified,
      duplicateToolCalls,
      invalidToolCalls,
      trajectoryFailures,
      errors: [...runResult.errors, ...constraintErrors],
      traceEvents: runResult.traceEvents.map((e, i) => ({
        index: i,
        eventType: e.event,
        timestamp: e.timestamp,
        status: String(e.attributes.status ?? ''),
        attributes: e.attributes,
      })),
      toolResultExcerpts: extractToolExcerpts(runResult),
      qualityGateResults,
    };
  }

  /**
   * Run all tasks in a suite and return aggregated results.
   */
  async runSuite(
    tasks: EvalTaskSpec[],
    metadata?: Partial<EvalSuiteMetadata>,
  ): Promise<EvalSuiteResult> {
    const results: EvalResult[] = [];

    for (const task of tasks) {
      const result = await this.runTask(task);
      results.push(result);
    }

    const taskSpecs: Record<string, EvalTaskSpec> = {};
    for (const task of tasks) {
      taskSpecs[task.id] = task;
    }

    return {
      results,
      metadata: {
        suite: metadata?.suite ?? 'custom-eval-suite',
        taskCount: tasks.length,
        model: metadata?.model ?? '',
        profile: metadata?.profile ?? 'small',
        timestamp: Date.now(),
        ...metadata,
      },
      taskSpecs,
    };
  }
}

// ─── Suite Utilities ──────────────────────────────────────────

export function suiteSummary(result: EvalSuiteResult): EvalSuiteSummary {
  const taskCount = result.results.length;
  const passed = result.results.filter((r) => r.success).length;
  const failed = taskCount - passed;
  return {
    taskCount,
    passed,
    failed,
    successRate: taskCount > 0 ? passed / taskCount : 0,
  };
}

export function suiteToJson(result: EvalSuiteResult): string {
  const summary = suiteSummary(result);
  return JSON.stringify(
    {
      successRate: summary.successRate,
      summary,
      metadata: result.metadata,
      results: result.results,
    },
    null,
    2,
  );
}

// ─── Analysis Helpers ─────────────────────────────────────────

function countToolFailures(result: AgentRunResult, allowRecovered: boolean): number {
  return result.toolResults.filter((tr) => {
    if (tr.status === 'ok') return false;
    if (allowRecovered && tr.metadata?.recovered) return false;
    return true;
  }).length;
}

function countDuplicateToolCalls(result: AgentRunResult): number {
  const seen = new Map<string, number>();
  let duplicates = 0;

  for (const msg of result.messages) {
    if (msg.role !== 'assistant' || !msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      const key = `${tc.name}:${JSON.stringify(tc.arguments)}`;
      const count = seen.get(key) ?? 0;
      if (count > 0) duplicates++;
      seen.set(key, count + 1);
    }
  }

  return duplicates;
}

function countInvalidToolCalls(result: AgentRunResult): number {
  return result.toolResults.filter(
    (tr) => tr.status === 'error' && (tr.error?.includes('Unknown tool') || tr.error?.includes('No handler')),
  ).length;
}

function countTrajectoryErrors(
  duplicates: number,
  invalid: number,
  toolFailures: number,
  constraintErrors: string[],
): number {
  let count = 0;
  if (duplicates > 0) count++;
  if (invalid > 0) count++;
  if (toolFailures > 0) count++;
  if (constraintErrors.length > 0) count++;
  return count;
}

function checkToolConstraints(task: EvalTaskSpec, result: AgentRunResult): string[] {
  const errors: string[] = [];
  const calledTools = new Set(
    result.toolResults.map((tr) => tr.toolName),
  );

  // Check required tools
  if (task.requiredTools) {
    for (const tool of task.requiredTools) {
      if (!calledTools.has(tool)) {
        errors.push(`Required tool not called: ${tool}`);
      }
    }
  }

  // Check forbidden tools
  if (task.forbiddenTools) {
    for (const tool of task.forbiddenTools) {
      if (calledTools.has(tool)) {
        errors.push(`Forbidden tool called: ${tool}`);
      }
    }
  }

  // Check max duplicate tool calls
  if (task.maxDuplicateToolCalls !== undefined) {
    const duplicates = countDuplicateToolCalls(result);
    if (duplicates > task.maxDuplicateToolCalls) {
      errors.push(`Too many duplicate tool calls: ${duplicates} > ${task.maxDuplicateToolCalls}`);
    }
  }

  // Check max invalid tool calls
  if (task.maxInvalidToolCalls !== undefined) {
    const invalid = countInvalidToolCalls(result);
    if (invalid > task.maxInvalidToolCalls) {
      errors.push(`Too many invalid tool calls: ${invalid} > ${task.maxInvalidToolCalls}`);
    }
  }

  // Check max tool failures
  if (task.maxToolFailures !== undefined) {
    const failures = countToolFailures(result, task.allowRecoveredToolFailures ?? false);
    if (failures > task.maxToolFailures) {
      errors.push(`Too many tool failures: ${failures} > ${task.maxToolFailures}`);
    }
  }

  return errors;
}

function checkQualityGates(task: EvalTaskSpec, result: AgentRunResult): EvalGateResult[] {
  const gates: EvalGateResult[] = [];

  // Basic quality checks (always applied)
  gates.push({
    name: 'completion_check',
    passed: result.status === 'completed',
    message: result.status === 'completed' ? 'Agent completed successfully' : `Agent status: ${result.status}`,
  });

  // Requirement-based checks
  if (task.requirements && task.requirements.length > 0) {
    const finalText = result.finalText.toLowerCase();
    const allMet = task.requirements.every((req) => finalText.includes(req.toLowerCase()));
    gates.push({
      name: 'requirements_check',
      passed: allMet,
      message: allMet ? 'All requirements met' : 'Not all requirements satisfied in final output',
    });
  }

  return gates;
}

function extractToolExcerpts(result: AgentRunResult): EvalToolExcerpt[] {
  return result.toolResults.map((tr, i) => ({
    index: i,
    toolName: tr.toolName,
    toolCallId: tr.toolCallId,
    status: tr.status,
    failed: tr.status === 'error',
    contentPreview: tr.content.slice(0, 200),
    errorPreview: tr.error ?? '',
  }));
}
