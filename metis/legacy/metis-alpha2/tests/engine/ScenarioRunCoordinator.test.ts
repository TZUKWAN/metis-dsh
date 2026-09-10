import { describe, expect, it } from 'vitest';
import {
  ScenarioRunCoordinator,
  digestResolvedManifestSnapshot,
  digestScenarioStepOutput,
  type ScenarioRunRecord,
  type ScenarioStepExecutionInput,
} from '../../engine/personalization/ScenarioRunCoordinator.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import { PersonalizationResolver } from '../../engine/personalization/PersonalizationResolver.js';
import type { ResolvedRunManifest } from '../../engine/runtime/PersonalizationRuntimeContract.js';

function realFactoryManifest(scenarioId = 'builtin:scenarios/article-review'): ResolvedRunManifest {
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

function withRecomputedDigest(manifest: ResolvedRunManifest): ResolvedRunManifest {
  const copy = structuredClone(manifest);
  copy.manifestDigest = digestResolvedManifestSnapshot(copy);
  return copy;
}

function successfulResult(input: ScenarioStepExecutionInput) {
  const output = {
    executionKey: input.executionKey,
    stepId: input.step.id,
    dependencies: Object.keys(input.dependencyOutputs).sort(),
  };
  return {
    ok: true as const,
    output,
    outputDigest: digestScenarioStepOutput(output),
    artifactRefs: [],
  };
}

function monotonicClock(start = 10_000): () => number {
  let value = start;
  return () => value++;
}

describe('ScenarioRunCoordinator', () => {
  it('executes a real built-in DAG in deterministic topological order with dependency outputs', async () => {
    const manifest = realFactoryManifest();
    const executed: string[] = [];
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async (input) => {
        executed.push(input.step.id);
        for (const dependency of input.step.dependsOn) {
          expect(input.dependencyOutputs[dependency]).not.toBeNull();
        }
        return successfulResult(input);
      },
    });

    const result = await coordinator.start({ runId: 'run-real-dag', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('completed');
    expect(executed).toEqual(result.record.executionOrder);
    expect(result.record.steps.every((step) => step.status === 'completed')).toBe(true);
    expect(result.record.steps.every((step) => step.outputDigest !== null)).toBe(true);
    expect(result.record.failureStepIds).toEqual([]);
  });

  it('rejects a dependency cycle before invoking the executor', async () => {
    const manifest = structuredClone(realFactoryManifest());
    const first = manifest.workflow[0];
    const last = manifest.workflow[manifest.workflow.length - 1];
    if (!first || !last) throw new Error('Expected workflow steps');
    first.dependsOn = [last.id];
    const cyclic = withRecomputedDigest(manifest);
    let calls = 0;
    const coordinator = new ScenarioRunCoordinator({
      executor: async (input) => {
        calls++;
        return successfulResult(input);
      },
    });

    const result = await coordinator.start({ runId: 'run-cycle', manifest: cyclic });

    expect(result).toEqual({ ok: false, code: 'invalid_dag', issues: ['Workflow contains a dependency cycle'] });
    expect(calls).toBe(0);
  });

  it('rejects missing dependencies and step references outside the manifest snapshot', async () => {
    const manifest = structuredClone(realFactoryManifest());
    const first = manifest.workflow[0];
    if (!first) throw new Error('Expected workflow step');
    first.dependsOn = ['missing-step'];
    first.skillIds = ['builtin:skills/not-bound'];
    const invalid = withRecomputedDigest(manifest);
    const coordinator = new ScenarioRunCoordinator({
      executor: async (input) => successfulResult(input),
    });

    const result = await coordinator.start({ runId: 'run-missing', manifest: invalid });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.includes('unbound skill'))).toBe(true);
    expect(result.issues.some((issue) => issue.includes('dependency is missing'))).toBe(true);
  });

  it('retries a transient failure, then blocks all transitive dependants without fabricating outputs', async () => {
    const manifest = realFactoryManifest();
    const executed: string[] = [];
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async (input) => {
        executed.push(input.step.id);
        if (input.step.id === 'systematic-search') {
          return { ok: false, code: 'source_unavailable', message: 'No retrievable corpus was available' };
        }
        return successfulResult(input);
      },
    });

    const result = await coordinator.start({ runId: 'run-failure', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('failed');
    expect(result.record.failureStepIds).toEqual(['systematic-search']);
    // Source availability is recoverable.  The coordinator retries it twice
    // before declaring the step failed, and still never runs its dependants.
    expect(executed).toEqual(['scope', 'systematic-search', 'systematic-search', 'systematic-search']);
    const downstream = result.record.steps.filter((step) => !['scope', 'systematic-search'].includes(step.stepId));
    expect(downstream.every((step) => step.status === 'blocked')).toBe(true);
    expect(downstream.every((step) => step.output === null && step.outputDigest === null)).toBe(true);
  });

  it('treats a mismatched executor output digest as a real failure', async () => {
    const manifest = realFactoryManifest('builtin:scenarios/general-research');
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async () => ({
        ok: true,
        output: { actual: 'content' },
        outputDigest: '0'.repeat(64),
        artifactRefs: [],
      }),
    });

    const result = await coordinator.start({ runId: 'run-digest-failure', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('failed');
    expect(result.record.steps[0]?.errorCode).toBe('output_digest_mismatch');
  });

  it('returns a recoverable interrupted record and resumes pending work', async () => {
    const manifest = realFactoryManifest('builtin:scenarios/general-research');
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async (input) => {
        calls++;
        return successfulResult(input);
      },
    });

    const interrupted = await coordinator.start({
      runId: 'run-resume-pending',
      manifest,
      signal: controller.signal,
    });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    expect(interrupted.record.status).toBe('interrupted');
    expect(calls).toBe(0);

    const resumed = await coordinator.resume(interrupted.record);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.record.status).toBe('completed');
    expect(calls).toBe(1);
  });

  it('preserves a stable execution key when interruption makes a running step uncertain', async () => {
    const manifest = realFactoryManifest('builtin:scenarios/general-research');
    const controller = new AbortController();
    const executionKeys: string[] = [];
    let calls = 0;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async (input) => {
        calls++;
        executionKeys.push(input.executionKey);
        const value = successfulResult(input);
        if (calls === 1) controller.abort();
        return value;
      },
    });

    const interrupted = await coordinator.start({
      runId: 'run-resume-running',
      manifest,
      signal: controller.signal,
    });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    expect(interrupted.record.status).toBe('interrupted');
    expect(interrupted.record.steps[0]?.status).toBe('running');

    const resumed = await coordinator.resume(interrupted.record);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.record.status).toBe('completed');
    expect(executionKeys).toHaveLength(2);
    expect(executionKeys[0]).toBe(executionKeys[1]);
  });

  it('rejects a tampered recoverable step snapshot before resuming', async () => {
    const manifest = realFactoryManifest('builtin:scenarios/general-research');
    const controller = new AbortController();
    controller.abort();
    const coordinator = new ScenarioRunCoordinator({
      executor: async (input) => successfulResult(input),
    });
    const interrupted = await coordinator.start({ runId: 'run-tamper', manifest, signal: controller.signal });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    const tampered: ScenarioRunRecord = structuredClone(interrupted.record);
    const step = tampered.steps[0];
    if (!step) throw new Error('Expected step record');
    step.stepSnapshot.description = 'Tampered after snapshot';

    const resumed = await coordinator.resume(tampered);

    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.code).toBe('invalid_record');
    expect(resumed.issues[0]).toMatch(/manifest|snapshot/u);
  });

  it('rejects a forged blocked state without a real failed dependency', async () => {
    const manifest = realFactoryManifest('builtin:scenarios/general-research');
    const controller = new AbortController();
    controller.abort();
    const coordinator = new ScenarioRunCoordinator({
      executor: async (input) => successfulResult(input),
    });
    const interrupted = await coordinator.start({ runId: 'run-forged-block', manifest, signal: controller.signal });
    expect(interrupted.ok).toBe(true);
    if (!interrupted.ok) return;
    const forged: ScenarioRunRecord = structuredClone(interrupted.record);
    const step = forged.steps[0];
    if (!step) throw new Error('Expected step record');
    step.status = 'blocked';
    step.completedAt = 100;
    step.errorCode = 'dependency_failed';
    step.errorMessage = 'Forged dependency failure';

    const resumed = await coordinator.resume(forged);

    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.issues[0]).toContain('no failed dependency');
  });

  it('rejects a manifest whose content no longer matches its digest', async () => {
    const manifest = structuredClone(realFactoryManifest());
    manifest.allowedTools = [];
    const coordinator = new ScenarioRunCoordinator({
      executor: async (input) => successfulResult(input),
    });

    const result = await coordinator.start({ runId: 'run-manifest-tamper', manifest });

    expect(result).toEqual({ ok: false, code: 'invalid_manifest', issues: ['Manifest digest mismatch'] });
  });

  it('writes durable checkpoints before and after a side-effecting step', async () => {
    const manifest = realFactoryManifest('builtin:scenarios/general-research');
    const checkpoints: ScenarioRunRecord[] = [];
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      onCheckpoint: (record) => { checkpoints.push(record); },
      executor: async (input) => successfulResult(input),
    });

    const result = await coordinator.start({ runId: 'run-checkpoints', manifest });

    expect(result.ok).toBe(true);
    expect(checkpoints.some((record) => record.steps[0]?.status === 'running')).toBe(true);
    expect(checkpoints.at(-1)?.status).toBe('completed');
    expect(checkpoints.at(-1)?.steps[0]?.status).toBe('completed');
    expect(checkpoints[0]).not.toBe(result.ok ? result.record : undefined);
  });

  it('fails closed before executor work when durable checkpoint persistence fails', async () => {
    const manifest = realFactoryManifest('builtin:scenarios/general-research');
    let calls = 0;
    const coordinator = new ScenarioRunCoordinator({
      onCheckpoint: () => { throw new Error('disk unavailable'); },
      executor: async (input) => {
        calls += 1;
        return successfulResult(input);
      },
    });

    const result = await coordinator.start({ runId: 'run-checkpoint-failure', manifest });

    expect(result).toEqual({
      ok: false,
      code: 'invalid_record',
      issues: ['Run checkpoint persistence failed'],
    });
    expect(calls).toBe(0);
  });
});
