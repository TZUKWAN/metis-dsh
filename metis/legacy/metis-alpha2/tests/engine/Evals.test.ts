/**
 * Tests for the Evals module (EvalRunner + GateEvaluator).
 */

import { describe, it, expect } from 'vitest';
import { EvalRunner, suiteSummary, suiteToJson } from '../../engine/evals/EvalRunner.js';
import { evaluateGate, clusterFailures } from '../../engine/evals/GateEvaluator.js';
import { GATE_PROFILES } from '../../engine/evals/types.js';
import type { EvalTaskSpec, EvalSuiteResult, EvalResult } from '../../engine/evals/types.js';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import { BaseProvider } from '../../engine/providers/BaseProvider.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import type { NormalizedResponse, StreamChunk } from '../../engine/core/types.js';

// ─── Test Provider ────────────────────────────────────────────

class SimpleProvider extends BaseProvider {
  private response: string;

  constructor(response: string = 'Done') {
    super();
    this.response = response;
  }

  capabilities() {
    return {
      providerType: 'TestProvider',
      model: 'test',
      nativeToolCalling: true,
      jsonSchemaOutput: false,
      streaming: false,
      thinking: false,
      maxContextTokens: 32000,
      maxOutputTokens: 4096,
      retryableStatusCodes: [],
    };
  }

  async complete(): Promise<NormalizedResponse> {
    return {
      content: this.response,
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    };
  }

  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> {}
}

function makeLoop(response: string = 'Task completed'): AgentLoop {
  const provider = new SimpleProvider(response);
  const registry = new ToolRegistry();
  const dispatcher = new ToolDispatcher(registry);
  return new AgentLoop({ provider, registry, dispatcher });
}

// ─── EvalRunner Tests ─────────────────────────────────────────

describe('EvalRunner', () => {
  it('runs a simple passing task', async () => {
    const runner = new EvalRunner(makeLoop());
    const task: EvalTaskSpec = {
      id: 'test-1',
      prompt: 'Say hello',
    };

    const result = await runner.runTask(task);

    expect(result.taskId).toBe('test-1');
    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.turnsUsed).toBe(1);
    expect(result.toolFailures).toBe(0);
  });

  it('runs a full suite and aggregates results', async () => {
    const runner = new EvalRunner(makeLoop());
    const tasks: EvalTaskSpec[] = [
      { id: 'task-1', prompt: 'Task 1' },
      { id: 'task-2', prompt: 'Task 2' },
      { id: 'task-3', prompt: 'Task 3' },
    ];

    const suite = await runner.runSuite(tasks, { suite: 'test-suite', model: 'test-model' });

    expect(suite.results).toHaveLength(3);
    expect(suite.metadata.suite).toBe('test-suite');
    expect(suite.metadata.model).toBe('test-model');
    expect(suite.metadata.taskCount).toBe(3);
    expect(Object.keys(suite.taskSpecs)).toHaveLength(3);

    const summary = suiteSummary(suite);
    expect(summary.taskCount).toBe(3);
    expect(summary.passed).toBe(3);
    expect(summary.failed).toBe(0);
    expect(summary.successRate).toBe(1.0);
  });

  it('detects tool constraint violations', async () => {
    const runner = new EvalRunner(makeLoop());
    const task: EvalTaskSpec = {
      id: 'constraint-test',
      prompt: 'Do something',
      requiredTools: ['nonexistent_tool'], // Will fail because this tool is never called
    };

    const result = await runner.runTask(task);

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes('Required tool not called'))).toBe(true);
  });

  it('serializes to JSON correctly', async () => {
    const runner = new EvalRunner(makeLoop());
    const suite = await runner.runSuite([{ id: 'json-test', prompt: 'Test' }]);

    const json = suiteToJson(suite);
    const parsed = JSON.parse(json);

    expect(parsed.successRate).toBe(1.0);
    expect(parsed.summary.taskCount).toBe(1);
    expect(parsed.results).toHaveLength(1);
  });

  it('handles fixture tasks (no model execution)', async () => {
    const runner = new EvalRunner(makeLoop());
    const task: EvalTaskSpec = {
      id: 'fixture-1',
      prompt: 'N/A',
      fixtureType: 'static_check',
      requiresModelExecution: false,
    };

    const result = await runner.runTask(task);

    expect(result.taskId).toBe('fixture-1');
    expect(result.status).toBe('fixture_skipped');
    expect(result.turnsUsed).toBe(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── GateEvaluator Tests ──────────────────────────────────────

describe('GateEvaluator', () => {
  function makeSuite(successes: number, failures: number): EvalSuiteResult {
    const results: EvalResult[] = [];

    for (let i = 0; i < successes; i++) {
      results.push(makeEvalResult(`pass-${i}`, true, 'completed', 0, 0, 0));
    }
    for (let i = 0; i < failures; i++) {
      results.push(makeEvalResult(`fail-${i}`, false, 'error', 1, 1, 1));
    }

    return { results, metadata: { suite: 'test', taskCount: results.length, model: '', profile: 'small', timestamp: Date.now() }, taskSpecs: {} };
  }

  it('passes with all passing tasks at release profile', () => {
    const suite = makeSuite(5, 0);
    const gate = evaluateGate(suite, 'release');

    expect(gate.passed).toBe(true);
    expect(gate.failures).toHaveLength(0);
    expect(gate.profile).toBe('release');
  });

  it('fails with any failing task at release profile', () => {
    const suite = makeSuite(4, 1);
    const gate = evaluateGate(suite, 'release');

    expect(gate.passed).toBe(false);
    expect(gate.failures.length).toBeGreaterThan(0);
    expect(gate.failedTasks).toContain('fail-0');
  });

  it('passes dev profile with some failures', () => {
    const suite = makeSuite(8, 2); // 80% success rate
    const gate = evaluateGate(suite, 'dev');

    expect(gate.passed).toBe(true);
  });

  it('fails dev profile below min success rate', () => {
    const suite = makeSuite(7, 3); // 70% success rate < 80% threshold
    const gate = evaluateGate(suite, 'dev');

    expect(gate.passed).toBe(false);
  });

  it('supports threshold overrides', () => {
    const suite = makeSuite(8, 2); // 80%
    // Override to require 100%
    const gate = evaluateGate(suite, 'dev', { minSuccessRate: 1.0 });

    expect(gate.passed).toBe(false);
    expect(gate.thresholds.minSuccessRate).toBe(1.0);
  });

  it('provides correct aggregates', () => {
    const suite = makeSuite(3, 2);
    const gate = evaluateGate(suite, 'release');

    expect(gate.aggregates.total_tasks).toBe(5);
    expect(gate.aggregates.passed_tasks).toBe(3);
    expect(gate.aggregates.failed_tasks).toBe(2);
    expect(gate.aggregates.success_rate).toBeCloseTo(0.6);
  });
});

// ─── Failure Clustering Tests ─────────────────────────────────

describe('clusterFailures', () => {
  it('returns empty for all-passing suite', () => {
    const suite = makeSuiteFromResults([
      makeEvalResult('p1', true, 'completed'),
      makeEvalResult('p2', true, 'completed'),
    ]);

    const clusters = clusterFailures(suite);
    expect(clusters).toHaveLength(0);
  });

  it('clusters failures by error pattern', () => {
    const suite = makeSuiteFromResults([
      makeEvalResult('p1', true, 'completed'),
      makeEvalResult('f1', false, 'error', 0, 0, 0, ['Required tool not called: echo']),
      makeEvalResult('f2', false, 'error', 0, 0, 0, ['Required tool not called: read_file']),
      makeEvalResult('f3', false, 'error', 0, 0, 0, ['Agent timed out']),
    ]);

    const clusters = clusterFailures(suite);
    expect(clusters.length).toBeGreaterThanOrEqual(2);

    // Check that there's a "missing tool" cluster
    const missingToolCluster = clusters.find((c) =>
      c.taskIds.includes('f1') || c.taskIds.includes('f2'),
    );
    expect(missingToolCluster).toBeDefined();
  });

  it('assigns critical severity to widespread failures', () => {
    const results: EvalResult[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(makeEvalResult(`f${i}`, false, 'error', 0, 0, 0, ['Tool failure']));
    }
    const suite = makeSuiteFromResults(results);

    const clusters = clusterFailures(suite);
    expect(clusters.length).toBeGreaterThan(0);
    // At least one cluster should be critical (>= 3 tasks)
    expect(clusters.some((c) => c.severity === 'critical')).toBe(true);
  });
});

// ─── Gate Profiles ────────────────────────────────────────────

describe('Gate Profiles', () => {
  it('has dev, candidate, and release profiles', () => {
    expect(GATE_PROFILES.dev).toBeDefined();
    expect(GATE_PROFILES.candidate).toBeDefined();
    expect(GATE_PROFILES.release).toBeDefined();
  });

  it('release is strictest', () => {
    expect(GATE_PROFILES.release.minSuccessRate).toBe(1.0);
    expect(GATE_PROFILES.release.maxFailedTasks).toBe(0);
  });

  it('dev is most lenient', () => {
    expect(GATE_PROFILES.dev.minSuccessRate).toBeLessThan(GATE_PROFILES.candidate.minSuccessRate);
    expect(GATE_PROFILES.dev.maxFailedTasks).toBeGreaterThan(GATE_PROFILES.release.maxFailedTasks);
  });
});

// ─── Helpers ──────────────────────────────────────────────────

function makeEvalResult(
  taskId: string,
  success: boolean,
  status: string,
  toolFailures = 0,
  invalidToolCalls = 0,
  trajectoryFailures = 0,
  errors: string[] = [],
): EvalResult {
  return {
    taskId,
    success,
    status,
    turnsUsed: 1,
    toolCalls: 0,
    latencyMs: 100,
    toolFailures,
    qualityFailures: 0,
    falseCompletion: false,
    finalVerified: success,
    duplicateToolCalls: 0,
    invalidToolCalls,
    trajectoryFailures,
    errors,
    traceEvents: [],
    toolResultExcerpts: [],
    qualityGateResults: [],
  };
}

function makeSuiteFromResults(results: EvalResult[]): EvalSuiteResult {
  return {
    results,
    metadata: { suite: 'test', taskCount: results.length, model: '', profile: 'small', timestamp: Date.now() },
    taskSpecs: {},
  };
}
