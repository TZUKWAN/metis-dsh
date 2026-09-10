import { describe, expect, it } from 'vitest';
import {
  ScenarioRunCoordinator,
  digestResolvedManifestSnapshot,
  digestScenarioStepOutput,
  type ScenarioRunRecord,
  type ScenarioRuntimeDirective,
  type ScenarioRuntimeEvent,
  type ScenarioStepExecutionInput,
} from '../../engine/personalization/ScenarioRunCoordinator.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import { PersonalizationResolver } from '../../engine/personalization/PersonalizationResolver.js';
import type { ResolvedRunManifest } from '../../engine/runtime/PersonalizationRuntimeContract.js';

function realFactoryManifest(scenarioId = 'builtin:scenarios/general-research'): ResolvedRunManifest {
  const definitions = buildBuiltinPersonalizationDefinitions();
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const resolver = new PersonalizationResolver({
    get: (id) => byId.get(id),
    list: (kind, includeDisabled) => definitions.filter((definition) => {
      if (kind && definition.kind !== kind) return false;
      return includeDisabled || definition.enabled;
    }),
  });
  const result = resolver.resolve({
    sessionId: 'scenario-session',
    projectId: 'scenario-project',
    scenarioId,
    createdAt: 1_785_398_400_000,
  });
  if (!result.ok) throw new Error(`Factory scenario failed to resolve: ${result.issues.join('; ')}`);
  return result.manifest;
}

function mutatedManifest(
  mutator: (manifest: ResolvedRunManifest) => void,
  scenarioId = 'builtin:scenarios/general-research',
): ResolvedRunManifest {
  const manifest = structuredClone(realFactoryManifest(scenarioId));
  mutator(manifest);
  manifest.manifestDigest = digestResolvedManifestSnapshot(manifest);
  return manifest;
}

function monotonicClock(start = 10_000): () => number {
  let value = start;
  return () => value++;
}

function assessedResult(input: ScenarioStepExecutionInput, satisfied: boolean, reason: string) {
  const output = {
    stepId: input.step.id,
    stepIteration: input.stepIteration ?? 1,
    workflowIteration: input.workflowIteration ?? 1,
  };
  return {
    ok: true as const,
    output,
    outputDigest: digestScenarioStepOutput(output),
    artifactRefs: [],
    completionAssessment: { satisfied, reason },
  };
}

function plainResult(input: ScenarioStepExecutionInput) {
  const output = { stepId: input.step.id };
  return {
    ok: true as const,
    output,
    outputDigest: digestScenarioStepOutput(output),
    artifactRefs: [],
  };
}

function failingResult(code: string, message: string) {
  return { ok: false as const, code, message };
}

function firstStepId(manifest: ResolvedRunManifest): string {
  const first = manifest.workflow[0];
  if (!first) throw new Error('Expected at least one workflow step');
  return first.id;
}

const ENABLED_LOOP = {
  enabled: true,
  maxIterations: 5,
  stopCondition: 'Draft passes review',
  evaluator: 'ai_judgement' as const,
  onExhausted: 'fail' as const,
  backtrackStepId: null,
};

describe('ScenarioRunCoordinator Step Loop', () => {
  it('iterates until satisfied with distinct execution keys and full validation history', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.loop = { ...ENABLED_LOOP };
    });
    const executionKeys: string[] = [];
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async (input) => {
        executionKeys.push(input.executionKey);
        return assessedResult(input, (input.stepIteration ?? 1) >= 3, `iteration ${input.stepIteration}`);
      },
    });

    const result = await coordinator.start({ runId: 'run-step-loop', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('completed');
    expect(executionKeys).toHaveLength(3);
    expect(new Set(executionKeys).size).toBe(3);
    const step = result.record.steps[0];
    expect(step?.status).toBe('completed');
    expect(step?.loopIteration).toBe(3);
    expect(step?.validationHistory.map((entry) => entry.satisfied)).toEqual([false, false, true]);
    expect(step?.validationHistory.map((entry) => entry.stepIteration)).toEqual([1, 2, 3]);
    expect(step?.validationHistory.every((entry) => entry.workflowIteration === 1)).toBe(true);
    expect(result.record.totalStepExecutions).toBe(3);
  });

  it('fails a step loop that exhausts its iterations under the fail policy', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.loop = { ...ENABLED_LOOP, maxIterations: 2 };
    });
    let calls = 0;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async (input) => {
        calls += 1;
        return assessedResult(input, false, 'still not good enough');
      },
    });

    const result = await coordinator.start({ runId: 'run-loop-exhaust-fail', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toBe(2);
    expect(result.record.status).toBe('failed');
    expect(result.record.failureStepIds).toEqual([firstStepId(manifest)]);
    expect(result.record.steps[0]?.errorCode).toBe('loop_exhausted');
    expect(result.record.steps[0]?.validationHistory).toHaveLength(2);
  });

  it('completes with a loop_exhausted marker under the continue policy', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.loop = { ...ENABLED_LOOP, maxIterations: 2, onExhausted: 'continue' };
    });
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async (input) => assessedResult(input, false, 'not satisfied'),
    });

    const result = await coordinator.start({ runId: 'run-loop-exhaust-continue', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('completed');
    expect(result.record.steps[0]?.status).toBe('completed');
    expect(result.record.steps[0]?.errorCode).toBe('loop_exhausted');
  });

  it('treats a missing completion assessment as not satisfied', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.loop = { ...ENABLED_LOOP, maxIterations: 2 };
    });
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async (input) => plainResult(input),
    });

    const result = await coordinator.start({ runId: 'run-loop-no-assessment', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('failed');
    expect(result.record.steps[0]?.errorCode).toBe('loop_exhausted');
    expect(result.record.steps[0]?.errorMessage).toContain('completion assessment');
  });

  it('performs one targeted repair pass, then continues without requiring perfection', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      // A disabled Loop is still a complete schema object. The runtime derives
      // the bounded two-pass repair cycle from completion criteria.
      step.loop = {
        enabled: false,
        maxIterations: 5,
        stopCondition: '',
        evaluator: 'completion_criteria',
        onExhausted: 'fail',
        backtrackStepId: null,
      };
      step.completionCriteria = ['The draft has a verified evidence trail.'];
    });
    const inputs: ScenarioStepExecutionInput[] = [];
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async (input) => {
        inputs.push(input);
        return assessedResult(input, false, '1. Add the missing evidence\n2. Clarify the source boundary');
      },
    });

    const result = await coordinator.start({ runId: 'run-system-repair', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('completed');
    expect(inputs).toHaveLength(2);
    expect(inputs[1]?.runtimeInstruction).toContain('逐项修正');
    expect(inputs[1]?.runtimeInstruction).toContain('1. Add the missing evidence');
    expect(result.record.steps[0]?.validationHistory).toHaveLength(2);
    expect(result.record.steps[0]?.errorCode).toBe('loop_exhausted');
  });

  it('pauses a step loop via runtime directive and resumes it from the checkpoint', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.loop = { ...ENABLED_LOOP };
    });
    let paused = false;
    let calls = 0;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      onRuntimeEvent: (event: ScenarioRuntimeEvent): ScenarioRuntimeDirective | void => {
        if (event.event === 'validation_failed' && !paused) {
          paused = true;
          return { action: 'pause' };
        }
      },
      executor: async (input) => {
        calls += 1;
        return assessedResult(input, (input.stepIteration ?? 1) >= 2, 'iteration done');
      },
    });

    const interrupted = await coordinator.start({ runId: 'run-loop-pause', manifest });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    expect(interrupted.record.status).toBe('interrupted');
    expect(interrupted.record.steps[0]?.status).toBe('pending');
    expect(interrupted.record.steps[0]?.loopIteration).toBe(1);
    expect(calls).toBe(1);

    const resumed = await coordinator.resume(interrupted.record);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.record.status).toBe('completed');
    expect(calls).toBe(2);
    expect(resumed.record.steps[0]?.validationHistory.map((entry) => entry.satisfied)).toEqual([false, true]);
  });

  it('resumes a crash-interrupted step loop iteration with a stable execution key', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.loop = { ...ENABLED_LOOP };
    });
    const controller = new AbortController();
    const executionKeys: string[] = [];
    let calls = 0;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async (input) => {
        calls += 1;
        executionKeys.push(input.executionKey);
        if (calls === 2) controller.abort();
        return assessedResult(input, calls >= 3, `call ${calls}`);
      },
    });

    const interrupted = await coordinator.start({ runId: 'run-loop-crash', manifest, signal: controller.signal });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    expect(interrupted.record.status).toBe('interrupted');
    expect(interrupted.record.steps[0]?.status).toBe('running');
    expect(interrupted.record.steps[0]?.loopIteration).toBe(1);

    const resumed = await coordinator.resume(interrupted.record);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.record.status).toBe('completed');
    expect(calls).toBe(3);
    // The uncertain crash-interrupted iteration must be retried under the same idempotency key.
    expect(executionKeys[1]).toBe(executionKeys[2]);
    expect(executionKeys[0]).not.toBe(executionKeys[1]);
  });

  it('applies execute_prompt directives as runtime instructions on the next iteration', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.loop = { ...ENABLED_LOOP };
    });
    const events: ScenarioRuntimeEvent[] = [];
    const instructions: string[] = [];
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      onRuntimeEvent: (event: ScenarioRuntimeEvent): ScenarioRuntimeDirective | void => {
        events.push(event);
        if (event.event === 'validation_failed') {
          return { action: 'execute_prompt', instruction: 'Tighten the evidence section' };
        }
      },
      executor: async (input) => {
        instructions.push(input.runtimeInstruction ?? '');
        return assessedResult(input, (input.stepIteration ?? 1) >= 2, 'done');
      },
    });

    const result = await coordinator.start({ runId: 'run-loop-directive', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('completed');
    expect(instructions).toEqual(['', 'Tighten the evidence section']);
    expect(events.map((event) => event.event)).toEqual(['validation_failed', 'loop_iteration']);
    expect(events[0]?.stepId).toBe(firstStepId(manifest));
    expect(events[0]?.code).toBe('completion_not_satisfied');
  });
});

describe('ScenarioRunCoordinator failure policies', () => {
  const RETRY_POLICY = {
    action: 'retry' as const,
    retryLimit: 2,
    backtrackStepId: null,
    instruction: '',
  };

  it('retries failures up to the configured limit and then succeeds', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.failurePolicy = { ...RETRY_POLICY };
    });
    let calls = 0;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async (input) => {
        calls += 1;
        return calls < 3 ? failingResult('flaky_tool', 'transient failure') : plainResult(input);
      },
    });

    const result = await coordinator.start({ runId: 'run-retry-success', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toBe(3);
    expect(result.record.status).toBe('completed');
    expect(result.record.steps[0]?.attempts).toBe(3);
    expect(result.record.steps[0]?.errorCode).toBeNull();
  });

  it('fails after the retry limit is exhausted', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.failurePolicy = { ...RETRY_POLICY };
    });
    let calls = 0;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async () => {
        calls += 1;
        return failingResult('flaky_tool', 'permanent failure');
      },
    });

    const result = await coordinator.start({ runId: 'run-retry-exhausted', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toBe(3);
    expect(result.record.status).toBe('failed');
    expect(result.record.steps[0]?.errorCode).toBe('flaky_tool');
  });

  it('emits tool_failed events for each failed attempt', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.failurePolicy = { ...RETRY_POLICY, retryLimit: 1 };
    });
    const events: ScenarioRuntimeEvent[] = [];
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      onRuntimeEvent: (event: ScenarioRuntimeEvent) => { events.push(event); },
      executor: async () => failingResult('tool_crashed', 'tool exploded'),
    });

    const result = await coordinator.start({ runId: 'run-tool-failed-events', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(events.filter((event) => event.event === 'tool_failed')).toHaveLength(2);
    expect(events[0]?.code).toBe('tool_crashed');
    expect(events[0]?.stepId).toBe(firstStepId(manifest));
  });

  it('skips a failed step under the skip policy and completes the run', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.failurePolicy = { action: 'skip', retryLimit: 0, backtrackStepId: null, instruction: '' };
    });
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async () => failingResult('source_unavailable', 'no corpus'),
    });

    const result = await coordinator.start({ runId: 'run-skip', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('completed');
    expect(result.record.steps[0]?.status).toBe('skipped');
    expect(result.record.steps[0]?.errorCode).toBe('source_unavailable');
    expect(result.record.failureStepIds).toEqual([]);
  });

  it('pauses for the user under pause_for_user and resumes with a fresh retry budget', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.failurePolicy = { action: 'pause_for_user', retryLimit: 0, backtrackStepId: null, instruction: '' };
    });
    let calls = 0;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async (input) => {
        calls += 1;
        return calls === 1 ? failingResult('needs_user', 'user input required') : plainResult(input);
      },
    });

    const interrupted = await coordinator.start({ runId: 'run-pause-resume', manifest });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    expect(interrupted.record.status).toBe('interrupted');
    expect(interrupted.record.steps[0]?.status).toBe('pending');

    const resumed = await coordinator.resume(interrupted.record);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.record.status).toBe('completed');
    expect(calls).toBe(2);
  });

  it('backtracks to an earlier step, resets the downstream chain, and emits workflow_adjusted', async () => {
    const manifest = mutatedManifest((m) => {
      const search = m.workflow.find((step) => step.id === 'systematic-search');
      if (!search) throw new Error('missing systematic-search step');
      search.failurePolicy = { action: 'backtrack', retryLimit: 0, backtrackStepId: 'scope', instruction: '' };
    }, 'builtin:scenarios/article-review');
    const executed: string[] = [];
    const events: ScenarioRuntimeEvent[] = [];
    let searchCalls = 0;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      onRuntimeEvent: (event: ScenarioRuntimeEvent) => { events.push(event); },
      executor: async (input) => {
        executed.push(input.step.id);
        if (input.step.id === 'systematic-search') {
          searchCalls += 1;
          if (searchCalls === 1) return failingResult('bad_query', 'query needs a wider scope');
        }
        return plainResult(input);
      },
    });

    const result = await coordinator.start({ runId: 'run-backtrack', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('completed');
    expect(result.record.backtrackCount).toBe(1);
    expect(executed.slice(0, 4)).toEqual(['scope', 'systematic-search', 'scope', 'systematic-search']);
    expect(result.record.steps.every((step) => step.status === 'completed')).toBe(true);
    const adjusted = events.filter((event) => event.event === 'workflow_adjusted');
    expect(adjusted).toHaveLength(1);
    expect(adjusted[0]?.stepId).toBe('scope');
    expect(adjusted[0]?.code).toBe('backtrack');
  });

  it('enforces the configured total step execution limit', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.loop = { ...ENABLED_LOOP, maxIterations: 10 };
      m.workflowGovernance = {
        entryStepId: null,
        completionCriteria: [],
        allowDynamicReorder: false,
        allowStepSplit: false,
        allowStepMerge: false,
        allowStepInsertion: false,
        requireChangeLog: false,
        maxTotalStepExecutions: 2,
      };
    });
    let calls = 0;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async (input) => {
        calls += 1;
        return assessedResult(input, false, 'never satisfied');
      },
    });

    const result = await coordinator.start({ runId: 'run-execution-limit', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toBe(2);
    expect(result.record.status).toBe('failed');
    expect(result.record.steps[0]?.errorCode).toBe('execution_limit_exceeded');
  });
});

describe('ScenarioRunCoordinator conditional steps', () => {
  const CONDITION = 'Only run when the project needs a literature update';

  it('runs the step when the condition evaluates to true', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.condition = CONDITION;
    });
    let calls = 0;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      evaluateStepCondition: async () => ({ run: true, reason: 'needed' }),
      executor: async (input) => {
        calls += 1;
        return plainResult(input);
      },
    });

    const result = await coordinator.start({ runId: 'run-condition-true', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toBe(1);
    expect(result.record.steps[0]?.status).toBe('completed');
  });

  it('skips the step with a recorded reason when the condition evaluates to false', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.condition = CONDITION;
    });
    let calls = 0;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      evaluateStepCondition: async () => ({ run: false, reason: 'Corpus is already current' }),
      executor: async (input) => {
        calls += 1;
        return plainResult(input);
      },
    });

    const result = await coordinator.start({ runId: 'run-condition-false', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toBe(0);
    expect(result.record.status).toBe('completed');
    expect(result.record.steps[0]?.status).toBe('skipped');
    expect(result.record.steps[0]?.errorMessage).toBe('Corpus is already current');
  });

  it('fails closed when a conditional step has no evaluator configured', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.condition = CONDITION;
    });
    let calls = 0;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async (input) => {
        calls += 1;
        return plainResult(input);
      },
    });

    const result = await coordinator.start({ runId: 'run-condition-no-evaluator', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toBe(0);
    expect(result.record.status).toBe('failed');
    expect(result.record.steps[0]?.errorCode).toBe('condition_evaluator_unavailable');
  });

  it('fails the step when condition evaluation throws', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.condition = CONDITION;
    });
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      evaluateStepCondition: async () => { throw new Error('judge unavailable'); },
      executor: async (input) => plainResult(input),
    });

    const result = await coordinator.start({ runId: 'run-condition-throw', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('failed');
    expect(result.record.steps[0]?.errorCode).toBe('condition_evaluation_failed');
    expect(result.record.steps[0]?.errorMessage).toContain('judge unavailable');
  });

  it('re-evaluates the condition after a workflow-loop re-entry', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.condition = CONDITION;
      m.workflowLoop = {
        enabled: true,
        maxIterations: 3,
        stopCondition: 'Report accepted',
        reentryStepId: null,
        carryArtifacts: true,
        onExhausted: 'fail',
      };
    });
    const conditionDecisions: boolean[] = [];
    let calls = 0;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      evaluateStepCondition: async () => {
        const run = conditionDecisions.length === 0;
        conditionDecisions.push(run);
        return { run, reason: run ? 'needed' : 'no longer needed' };
      },
      evaluateWorkflowLoop: async (input) => ({
        complete: input.record.workflowIteration >= 2,
        reason: 'iteration check',
      }),
      executor: async (input) => {
        calls += 1;
        return plainResult(input);
      },
    });

    const result = await coordinator.start({ runId: 'run-condition-loop', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('completed');
    expect(conditionDecisions).toEqual([true, false]);
    expect(calls).toBe(1);
    expect(result.record.steps[0]?.status).toBe('skipped');
  });
});

describe('ScenarioRunCoordinator Workflow Loop', () => {
  const WORKFLOW_LOOP = {
    enabled: true,
    maxIterations: 3,
    stopCondition: 'Whole report passes final review',
    reentryStepId: null,
    carryArtifacts: true,
    onExhausted: 'fail' as const,
  };

  it('re-enters the workflow until the stop condition is satisfied', async () => {
    const manifest = mutatedManifest((m) => {
      m.workflowLoop = { ...WORKFLOW_LOOP };
    });
    const events: ScenarioRuntimeEvent[] = [];
    const executed: Array<{ step: string; workflowIteration: number }> = [];
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      evaluateWorkflowLoop: async (input) => ({
        complete: input.record.workflowIteration >= 2,
        reason: `workflow iteration ${input.record.workflowIteration}`,
      }),
      onRuntimeEvent: (event: ScenarioRuntimeEvent) => { events.push(event); },
      executor: async (input) => {
        executed.push({ step: input.step.id, workflowIteration: input.workflowIteration ?? 0 });
        return plainResult(input);
      },
    });

    const result = await coordinator.start({ runId: 'run-workflow-loop', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('completed');
    expect(result.record.workflowIteration).toBe(2);
    expect(executed.map((entry) => entry.workflowIteration)).toEqual([1, 2]);
    const loopEvents = events.filter((event) => event.event === 'loop_iteration');
    expect(loopEvents).toHaveLength(1);
    expect(loopEvents[0]?.stepId).toBeNull();
    expect(loopEvents[0]?.workflowIteration).toBe(1);
  });

  it('carries artifacts into the re-entry when workflowLoop.carryArtifacts is enabled', async () => {
    const manifest = mutatedManifest((m) => {
      m.workflowLoop = { ...WORKFLOW_LOOP, maxIterations: 2, carryArtifacts: true };
    });
    const snapshots: ScenarioRunRecord[] = [];
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      evaluateWorkflowLoop: async (input) => ({
        complete: input.record.workflowIteration >= 2,
        reason: 'carry check',
      }),
      onCheckpoint: (record: ScenarioRunRecord) => { snapshots.push(record); },
      executor: async (input) => {
        const output = { stepId: input.step.id, iteration: input.workflowIteration ?? 0 };
        return {
          ok: true as const,
          output,
          outputDigest: digestScenarioStepOutput(output),
          artifactRefs: [{ id: `artifact-${input.workflowIteration ?? 0}`, version: 1, contentDigest: digestScenarioStepOutput(output) }],
        };
      },
    });

    const result = await coordinator.start({ runId: 'run-workflow-carry', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reentrySnapshot = snapshots.find((snapshot) =>
      snapshot.workflowIteration === 2 && snapshot.steps.some((step) => step.status === 'pending'));
    expect(reentrySnapshot).toBeDefined();
    const carriedStep = reentrySnapshot?.steps.find((step) => step.status === 'pending');
    expect(carriedStep?.output).toEqual({ stepId: carriedStep?.stepId, iteration: 1 });
    expect(carriedStep?.artifactRefs).toEqual([{ id: 'artifact-1', version: 1, contentDigest: digestScenarioStepOutput({ stepId: carriedStep?.stepId, iteration: 1 }) }]);
    expect(result.record.steps[0]?.output).toEqual({ stepId: result.record.steps[0]?.stepId, iteration: 2 });
  });

  it('clears artifacts on workflow-loop re-entry when carryArtifacts is disabled', async () => {
    const manifest = mutatedManifest((m) => {
      m.workflowLoop = { ...WORKFLOW_LOOP, maxIterations: 2, carryArtifacts: false };
    });
    const snapshots: ScenarioRunRecord[] = [];
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      evaluateWorkflowLoop: async (input) => ({
        complete: input.record.workflowIteration >= 2,
        reason: 'clear check',
      }),
      onCheckpoint: (record: ScenarioRunRecord) => { snapshots.push(record); },
      executor: async (input) => plainResult(input),
    });

    const result = await coordinator.start({ runId: 'run-workflow-clear', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reentrySnapshot = snapshots.find((snapshot) =>
      snapshot.workflowIteration === 2 && snapshot.steps.some((step) => step.status === 'pending'));
    expect(reentrySnapshot).toBeDefined();
    const clearedStep = reentrySnapshot?.steps.find((step) => step.status === 'pending');
    expect(clearedStep?.output).toBeNull();
    expect(clearedStep?.artifactRefs).toEqual([]);
  });

  it('fails the run when workflow iterations are exhausted under the fail policy', async () => {
    const manifest = mutatedManifest((m) => {
      m.workflowLoop = { ...WORKFLOW_LOOP, maxIterations: 2 };
    });
    let calls = 0;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      evaluateWorkflowLoop: async () => ({ complete: false, reason: 'still failing review' }),
      executor: async (input) => {
        calls += 1;
        return plainResult(input);
      },
    });

    const result = await coordinator.start({ runId: 'run-workflow-exhaust-fail', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toBe(2);
    expect(result.record.status).toBe('failed');
    expect(result.record.workflowIteration).toBe(2);
  });

  it('completes the run on exhaustion under the complete policy', async () => {
    const manifest = mutatedManifest((m) => {
      m.workflowLoop = { ...WORKFLOW_LOOP, maxIterations: 2, onExhausted: 'complete' };
    });
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      evaluateWorkflowLoop: async () => ({ complete: false, reason: 'not quite there' }),
      executor: async (input) => plainResult(input),
    });

    const result = await coordinator.start({ runId: 'run-workflow-exhaust-complete', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('completed');
    expect(result.record.workflowIteration).toBe(2);
  });

  it('pauses on exhaustion under pause_for_user and resumes cleanly', async () => {
    const manifest = mutatedManifest((m) => {
      m.workflowLoop = { ...WORKFLOW_LOOP, maxIterations: 2, onExhausted: 'pause_for_user' };
    });
    let evaluations = 0;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      evaluateWorkflowLoop: async () => {
        evaluations += 1;
        return { complete: evaluations > 2, reason: `evaluation ${evaluations}` };
      },
      executor: async (input) => plainResult(input),
    });

    const interrupted = await coordinator.start({ runId: 'run-workflow-pause', manifest });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    expect(interrupted.record.status).toBe('interrupted');
    expect(interrupted.record.workflowIteration).toBe(2);

    const resumed = await coordinator.resume(interrupted.record);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.record.status).toBe('completed');
    expect(evaluations).toBe(3);
  });

  it('fails closed when the workflow loop evaluator throws', async () => {
    const manifest = mutatedManifest((m) => {
      m.workflowLoop = { ...WORKFLOW_LOOP };
    });
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      evaluateWorkflowLoop: async () => { throw new Error('judge model offline'); },
      executor: async (input) => plainResult(input),
    });

    const result = await coordinator.start({ runId: 'run-workflow-eval-throw', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('failed');
    expect(result.record.steps.at(-1)?.errorCode).toBe('workflow_loop_evaluation_failed');
  });

  it('resumes from a checkpoint taken mid workflow-loop re-entry', async () => {
    const manifest = mutatedManifest((m) => {
      m.workflowLoop = { ...WORKFLOW_LOOP, maxIterations: 3 };
    });
    const controller = new AbortController();
    const executionKeys: string[] = [];
    let calls = 0;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      evaluateWorkflowLoop: async (input) => ({
        complete: input.record.workflowIteration >= 2,
        reason: 'iteration gate',
      }),
      executor: async (input) => {
        calls += 1;
        executionKeys.push(input.executionKey);
        if (calls === 2) controller.abort();
        return plainResult(input);
      },
    });

    const interrupted = await coordinator.start({ runId: 'run-workflow-crash', manifest, signal: controller.signal });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    expect(interrupted.record.status).toBe('interrupted');
    expect(interrupted.record.workflowIteration).toBe(2);
    expect(interrupted.record.steps[0]?.status).toBe('running');

    const resumed = await coordinator.resume(interrupted.record);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.record.status).toBe('completed');
    expect(calls).toBe(3);
    // Iteration-2 execution must resume under the same idempotency key after the crash.
    expect(executionKeys[1]).toBe(executionKeys[2]);
    expect(executionKeys[0]).not.toBe(executionKeys[1]);
  });

  it('re-enters at the configured re-entry step instead of the first step', async () => {
    const manifest = mutatedManifest((m) => {
      m.workflowLoop = { ...WORKFLOW_LOOP, reentryStepId: 'systematic-search' };
    }, 'builtin:scenarios/article-review');
    const executed: string[] = [];
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      evaluateWorkflowLoop: async (input) => ({
        complete: input.record.workflowIteration >= 2,
        reason: 'gate',
      }),
      executor: async (input) => {
        executed.push(input.step.id);
        return plainResult(input);
      },
    });

    const result = await coordinator.start({ runId: 'run-workflow-reentry', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('completed');
    const firstPass = result.record.executionOrder;
    // 'scope' ran only in the first pass; the re-entry pass starts at 'systematic-search'.
    expect(executed.filter((id) => id === 'scope')).toHaveLength(1);
    expect(executed.filter((id) => id === 'systematic-search')).toHaveLength(2);
    expect(executed.slice(0, firstPass.length)).toEqual(firstPass);
  });
});
