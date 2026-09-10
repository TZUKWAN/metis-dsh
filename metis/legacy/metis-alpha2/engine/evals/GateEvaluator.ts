/**
 * Gate evaluator — quality gate checks for eval runs.
 *
 * Ported from metis/evals/gate.py.
 * Supports three profiles: dev, candidate, release.
 */

import type {
  EvalSuiteResult,
  EvalResult,
  GateThresholds,
  GateEvaluation,
} from './types.js';
import { GATE_PROFILES } from './types.js';

/**
 * Evaluate an eval suite result against a gate profile.
 */
export function evaluateGate(
  suite: EvalSuiteResult,
  profile: string = 'release',
  overrides?: Partial<GateThresholds>,
): GateEvaluation {
  const baseThresholds: GateThresholds = GATE_PROFILES[profile] ?? GATE_PROFILES.release ?? {
    minSuccessRate: 1.0,
    maxFailedTasks: 0,
    maxInvalidToolCalls: 0,
    maxToolFailures: 0,
    maxTrajectoryFailures: 0,
    maxFailureClusters: 0,
  };
  const thresholds: GateThresholds = {
    minSuccessRate: overrides?.minSuccessRate ?? baseThresholds.minSuccessRate,
    maxFailedTasks: overrides?.maxFailedTasks ?? baseThresholds.maxFailedTasks,
    maxInvalidToolCalls: overrides?.maxInvalidToolCalls ?? baseThresholds.maxInvalidToolCalls,
    maxToolFailures: overrides?.maxToolFailures ?? baseThresholds.maxToolFailures,
    maxTrajectoryFailures: overrides?.maxTrajectoryFailures ?? baseThresholds.maxTrajectoryFailures,
    maxFailureClusters: overrides?.maxFailureClusters ?? baseThresholds.maxFailureClusters,
  };

  const aggregates = computeAggregates(suite);
  const failures: string[] = [];

  // Check success rate
  const successRate = aggregates.success_rate ?? 0;
  if (successRate < thresholds.minSuccessRate) {
    failures.push(`success_rate ${successRate.toFixed(4)} < ${thresholds.minSuccessRate.toFixed(4)}`);
  }

  // Check counts against thresholds
  const checks: Array<[keyof GateThresholds, string]> = [
    ['maxFailedTasks', 'failed_tasks'],
    ['maxInvalidToolCalls', 'invalid_tool_calls'],
    ['maxToolFailures', 'tool_failures'],
    ['maxTrajectoryFailures', 'trajectory_failures'],
    ['maxFailureClusters', 'failure_clusters'],
  ];

  for (const [thresholdKey, metricKey] of checks) {
    const maxAllowed = thresholds[thresholdKey] as number;
    const observed = aggregates[metricKey] ?? 0;
    if (observed > maxAllowed) {
      failures.push(`${metricKey} ${observed} > ${maxAllowed}`);
    }
  }

  const failedTasks = suite.results
    .filter((r) => !r.success)
    .map((r) => r.taskId);

  return {
    passed: failures.length === 0,
    profile,
    thresholds,
    aggregates,
    failures,
    failedTasks,
  };
}

// ─── Helpers ──────────────────────────────────────────────────

function computeAggregates(suite: EvalSuiteResult): Record<string, number> {
  const results = suite.results;
  const total = results.length;
  const passed = results.filter((r) => r.success).length;

  return {
    total_tasks: total,
    passed_tasks: passed,
    failed_tasks: total - passed,
    success_rate: total > 0 ? passed / total : 0,
    tool_calls: results.reduce((sum, r) => sum + r.toolCalls, 0),
    tool_failures: results.reduce((sum, r) => sum + r.toolFailures, 0),
    invalid_tool_calls: results.reduce((sum, r) => sum + r.invalidToolCalls, 0),
    duplicate_tool_calls: results.reduce((sum, r) => sum + r.duplicateToolCalls, 0),
    trajectory_failures: results.reduce((sum, r) => sum + r.trajectoryFailures, 0),
    quality_failures: results.reduce((sum, r) => sum + r.qualityFailures, 0),
    false_completions: results.filter((r) => r.falseCompletion).length,
    total_latency_ms: results.reduce((sum, r) => sum + r.latencyMs, 0),
    failure_clusters: countFailureClusters(results),
  };
}

/**
 * Group failed tasks by their error patterns to identify failure clusters.
 */
function countFailureClusters(results: EvalResult[]): number {
  if (results.length === 0) return 0;

  const failed = results.filter((r) => !r.success);
  if (failed.length === 0) return 0;

  // Cluster by status + error pattern
  const clusters = new Set<string>();
  for (const result of failed) {
    // Create a signature from the error types
    const errorSignature = result.errors
      .map((e) => {
        // Normalize error to create cluster keys
        if (e.includes('Required tool not called')) return 'missing_required_tool';
        if (e.includes('Forbidden tool called')) return 'forbidden_tool';
        if (e.includes('duplicate tool calls')) return 'duplicate_tools';
        if (e.includes('invalid tool calls')) return 'invalid_tools';
        if (e.includes('tool failures')) return 'tool_failures';
        if (e.includes('timed out')) return 'timeout';
        if (e.includes('context')) return 'context_overflow';
        return 'other';
      })
      .sort()
      .join(',');

    clusters.add(`${result.status}:${errorSignature}`);
  }

  return clusters.size;
}

/**
 * Cluster failed tasks by error pattern and produce remediation suggestions.
 */
export function clusterFailures(suite: EvalSuiteResult): FailureCluster[] {
  const failed = suite.results.filter((r) => !r.success);
  if (failed.length === 0) return [];

  const clusterMap = new Map<string, FailureCluster>();

  for (const result of failed) {
    const clusterKey = result.errors.length > 0
      ? result.errors.map((e) => normalizeError(e)).sort().join('|')
      : `status:${result.status}`;

    if (!clusterMap.has(clusterKey)) {
      clusterMap.set(clusterKey, {
        clusterKey,
        taskIds: [],
        errorCount: 0,
        exampleError: result.errors[0] ?? `status: ${result.status}`,
        severity: 'medium' as const,
        suggestion: suggestRemediation(result.errors),
      });
    }

    const cluster = clusterMap.get(clusterKey)!;
    cluster.taskIds.push(result.taskId);
    cluster.errorCount += result.errors.length;
  }

  // Classify severity
  const clusters = [...clusterMap.values()];
  for (const cluster of clusters) {
    if (cluster.taskIds.length >= 3 || cluster.errorCount >= 5) {
      cluster.severity = 'critical';
    } else if (cluster.taskIds.length === 1) {
      cluster.severity = 'low';
    }
  }

  return clusters.sort((a, b) => {
    const severityOrder = { critical: 0, medium: 1, low: 2 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });
}

export interface FailureCluster {
  clusterKey: string;
  taskIds: string[];
  errorCount: number;
  exampleError: string;
  severity: 'critical' | 'medium' | 'low';
  suggestion: string;
}

function normalizeError(error: string): string {
  if (error.includes('Required tool')) return 'missing_tool';
  if (error.includes('Forbidden tool')) return 'forbidden_tool';
  if (error.includes('duplicate')) return 'duplicate';
  if (error.includes('invalid')) return 'invalid';
  if (error.includes('timeout')) return 'timeout';
  if (error.includes('context')) return 'context';
  if (error.includes('quality')) return 'quality';
  return 'other';
}

function suggestRemediation(errors: string[]): string {
  if (errors.length === 0) return 'No errors found';
  const first = errors[0] ?? '';
  if (first.includes('Required tool not called')) return 'Review prompt instructions for tool usage hints';
  if (first.includes('Forbidden tool')) return 'Update tool constraints or review agent behavior';
  if (first.includes('timed out')) return 'Increase max_turns or simplify task';
  if (first.includes('context')) return 'Improve context compression or reduce task complexity';
  return 'Investigate root cause and adjust prompt or tool configuration';
}
