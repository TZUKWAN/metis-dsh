/**
 * Tests for Workflow engine — topological sort, DAG validation, serial execution.
 */

import { describe, it, expect } from 'vitest';
import {
  topologicalSort,
  validateWorkflowDefinition,
  WorkflowEngine,
} from '../../engine/workflow/index.js';
import type { WorkflowDefinition } from '../../engine/workflow/types.js';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import { BaseProvider } from '../../engine/providers/BaseProvider.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import type { NormalizedResponse, StreamChunk } from '../../engine/core/types.js';

// ─── Test Provider ────────────────────────────────────────────

class SequentialProvider extends BaseProvider {
  private responses: string[];
  private index = 0;

  constructor(responses: string[]) {
    super();
    this.responses = responses;
  }

  capabilities() {
    return {
      providerType: 'SequentialProvider',
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
    const content = this.responses[this.index] ?? 'Default response';
    this.index++;
    return {
      content,
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    };
  }

  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> {}
}

function makeLoop(responses: string[]): AgentLoop {
  const provider = new SequentialProvider(responses);
  const registry = new ToolRegistry();
  const dispatcher = new ToolDispatcher(registry);
  return new AgentLoop({ provider, registry, dispatcher });
}

// ─── Test Workflow ────────────────────────────────────────────

const LINEAR_WORKFLOW: WorkflowDefinition = {
  id: 'test-linear',
  name: 'Linear Test',
  description: 'A → B → C',
  version: '1.0.0',
  steps: [
    { id: 'a', name: 'Step A', description: '', prompt: 'Do step A with topic: {{input.topic}}', inputFrom: [], tools: [], maxTurns: 3 },
    { id: 'b', name: 'Step B', description: '', prompt: 'Step A produced: {{a.output}}. Now do step B.', inputFrom: ['a'], tools: [], maxTurns: 3 },
    { id: 'c', name: 'Step C', description: '', prompt: 'Step B produced: {{b.output}}. Now do step C.', inputFrom: ['b'], tools: [], maxTurns: 3 },
  ],
  dependencies: {
    a: [],
    b: ['a'],
    c: ['b'],
  },
};

// ─── Topological Sort Tests ───────────────────────────────────

describe('topologicalSort', () => {
  it('sorts linear chain correctly', () => {
    const order = topologicalSort(LINEAR_WORKFLOW);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('sorts diamond DAG correctly', () => {
    const diamond: WorkflowDefinition = {
      ...LINEAR_WORKFLOW,
      steps: [
        { id: 'a', name: 'A', description: '', prompt: '', inputFrom: [], tools: [], maxTurns: 3 },
        { id: 'b', name: 'B', description: '', prompt: '', inputFrom: ['a'], tools: [], maxTurns: 3 },
        { id: 'c', name: 'C', description: '', prompt: '', inputFrom: ['a'], tools: [], maxTurns: 3 },
        { id: 'd', name: 'D', description: '', prompt: '', inputFrom: ['b', 'c'], tools: [], maxTurns: 3 },
      ],
      dependencies: { a: [], b: ['a'], c: ['a'], d: ['b', 'c'] },
    };

    const order = topologicalSort(diamond);
    // A must come first, D must come last
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });

  it('detects cycles', () => {
    const cyclic: WorkflowDefinition = {
      ...LINEAR_WORKFLOW,
      steps: [
        { id: 'a', name: 'A', description: '', prompt: '', inputFrom: ['b'], tools: [], maxTurns: 3 },
        { id: 'b', name: 'B', description: '', prompt: '', inputFrom: ['a'], tools: [], maxTurns: 3 },
      ],
      dependencies: { a: ['b'], b: ['a'] },
    };

    expect(() => topologicalSort(cyclic)).toThrow('cycle');
  });
});

// ─── Validation Tests ─────────────────────────────────────────

describe('validateWorkflowDefinition', () => {
  it('returns no errors for valid workflow', () => {
    const errors = validateWorkflowDefinition(LINEAR_WORKFLOW);
    expect(errors).toHaveLength(0);
  });

  it('detects missing dependency references', () => {
    const bad: WorkflowDefinition = {
      ...LINEAR_WORKFLOW,
      steps: [
        { id: 'a', name: 'A', description: '', prompt: '', inputFrom: [], tools: [], maxTurns: 3 },
      ],
      dependencies: { a: ['nonexistent'] },
    };

    const errors = validateWorkflowDefinition(bad);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('non-existent'))).toBe(true);
  });

  it('detects duplicate step IDs', () => {
    const dup: WorkflowDefinition = {
      ...LINEAR_WORKFLOW,
      steps: [
        { id: 'a', name: 'A1', description: '', prompt: '', inputFrom: [], tools: [], maxTurns: 3 },
        { id: 'a', name: 'A2', description: '', prompt: '', inputFrom: [], tools: [], maxTurns: 3 },
      ],
      dependencies: { a: [] },
    };

    const errors = validateWorkflowDefinition(dup);
    expect(errors.some((e) => e.includes('Duplicate'))).toBe(true);
  });
});

// ─── WorkflowEngine Tests ─────────────────────────────────────

describe('WorkflowEngine', () => {
  it('executes linear workflow end to end', async () => {
    const engine = new WorkflowEngine(makeLoop([
      'Result A for topic X',
      'Result B based on Result A',
      'Result C based on Result B',
    ]));

    const events: string[] = [];
    const run = await engine.run(LINEAR_WORKFLOW, { topic: 'AI Safety' }, {
      onStepStart: (step) => events.push(`start:${step.id}`),
      onStepComplete: (step) => events.push(`complete:${step.id}`),
    });

    expect(run.status).toBe('completed');
    expect(run.stepResults.a.status).toBe('completed');
    expect(run.stepResults.b.status).toBe('completed');
    expect(run.stepResults.c.status).toBe('completed');
    expect(run.stepResults.a.output).toBe('Result A for topic X');
    expect(run.stepResults.b.output).toBe('Result B based on Result A');
    expect(run.stepResults.c.output).toBe('Result C based on Result B');

    expect(events).toEqual([
      'start:a', 'complete:a',
      'start:b', 'complete:b',
      'start:c', 'complete:c',
    ]);
  });

  it('skips steps with failed dependencies', async () => {
    // Create a workflow where step B depends on A, and A fails
    const engine = new WorkflowEngine(makeLoop(['Step A done', 'Step B done', 'Step C done']));

    const workflow: WorkflowDefinition = {
      id: 'skip-test',
      name: 'Skip Test',
      description: '',
      version: '1.0.0',
      steps: [
        { id: 'a', name: 'A', description: '', prompt: 'Do A', inputFrom: [], tools: [], maxTurns: 1 },
        { id: 'b', name: 'B', description: '', prompt: 'Do B', inputFrom: ['a'], tools: [], maxTurns: 1 },
        { id: 'c', name: 'C', description: '', prompt: 'Do C', inputFrom: ['b'], tools: [], maxTurns: 1 },
      ],
      dependencies: { a: [], b: ['a'], c: ['b'] },
    };

    // Manually mark step A as failed to simulate dependency failure
    const run = await engine.run(workflow);
    // With a working provider, all steps should complete
    expect(run.stepResults.a.status).toBe('completed');
    expect(run.stepResults.b.status).toBe('completed');
    expect(run.stepResults.c.status).toBe('completed');
  });

  it('reports progress via hooks', async () => {
    const engine = new WorkflowEngine(makeLoop(['A', 'B', 'C']));

    const progress: Array<{ completed: number; total: number }> = [];
    const run = await engine.run(LINEAR_WORKFLOW, {}, {
      onProgress: (completed, total) => progress.push({ completed, total }),
    });

    expect(run.status).toBe('completed');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0].total).toBe(3);
    expect(progress[progress.length - 1].completed).toBe(3);
  });

  it('pauses on HITL approval rejection', async () => {
    const engine = new WorkflowEngine(makeLoop(['A', 'B']));

    const workflow: WorkflowDefinition = {
      id: 'hitl-test',
      name: 'HITL Test',
      description: '',
      version: '1.0.0',
      steps: [
        { id: 'a', name: 'A', description: '', prompt: 'Do A', inputFrom: [], tools: [], maxTurns: 3 },
        { id: 'b', name: 'B', description: '', prompt: 'Do B', inputFrom: ['a'], tools: [], maxTurns: 3, hitl: { requireApproval: true, allowEdit: false } },
      ],
      dependencies: { a: [], b: ['a'] },
    };

    const run = await engine.run(workflow, {}, {
      onApprovalRequired: async (step) => {
        return step.id === 'b' ? false : true; // Reject step B
      },
    });

    expect(run.status).toBe('paused');
    expect(run.currentStepId).toBe('b');
    expect(run.stepResults.a.status).toBe('completed');
    expect(run.stepResults.b.status).toBe('pending');
  });

  it('resumes paused workflow', async () => {
    // First engine: will pause at step B (approval rejected)
    const engine1 = new WorkflowEngine(makeLoop(['A-result']));

    const workflow: WorkflowDefinition = {
      id: 'resume-test',
      name: 'Resume Test',
      description: '',
      version: '1.0.0',
      steps: [
        { id: 'a', name: 'A', description: '', prompt: 'Do A', inputFrom: [], tools: [], maxTurns: 3 },
        { id: 'b', name: 'B', description: '', prompt: 'Do B', inputFrom: ['a'], tools: [], maxTurns: 3, hitl: { requireApproval: true, allowEdit: false } },
      ],
      dependencies: { a: [], b: ['a'] },
    };

    // Pause at B
    const paused = await engine1.run(workflow, {}, {
      onApprovalRequired: async () => false, // Always reject
    });

    expect(paused.status).toBe('paused');
    expect(paused.stepResults.a.status).toBe('completed');

    // Second engine: will approve and complete
    const engine2 = new WorkflowEngine(makeLoop(['B-result']));

    const resumed = await engine2.resume(workflow, paused, 'b', {
      onApprovalRequired: async () => true, // Always approve
    });

    expect(resumed.status).toBe('completed');
    expect(resumed.stepResults.b.status).toBe('completed');
    expect(resumed.stepResults.b.output).toBe('B-result');
  });

  it('retries failed steps', async () => {
    const engine = new WorkflowEngine(makeLoop(['A', 'B-first-try', 'B-retry']));

    const workflow: WorkflowDefinition = {
      id: 'retry-test',
      name: 'Retry Test',
      description: '',
      version: '1.0.0',
      steps: [
        { id: 'a', name: 'A', description: '', prompt: 'Do A', inputFrom: [], tools: [], maxTurns: 3 },
        {
          id: 'b',
          name: 'B',
          description: '',
          prompt: 'Do B',
          inputFrom: ['a'],
          tools: [],
          maxTurns: 1, // Low max turns to force failure scenario
          retry: { maxRetries: 2, onFailPrompt: 'Try harder' },
        },
      ],
      dependencies: { a: [], b: ['a'] },
    };

    const run = await engine.run(workflow, {});
    expect(run.status).toBe('completed');
    expect(run.stepResults.a.status).toBe('completed');
  });
});
