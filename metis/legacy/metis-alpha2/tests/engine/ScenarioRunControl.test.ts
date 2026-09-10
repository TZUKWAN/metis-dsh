import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import {
  ScenarioRunCoordinator,
  digestResolvedManifestSnapshot,
  digestScenarioStepOutput,
  terminateStoredScenarioRun,
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

function successfulResult(input: ScenarioStepExecutionInput) {
  const output = { executionKey: input.executionKey, stepId: input.step.id };
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

/** Coordinator whose checkpoints are durably persisted; pauses once the first step's completion checkpoint is saved. */
function pausedRunSetup(repository: PersonalizationRepository, runId: string) {
  const localPause = new AbortController();
  let calls = 0;
  const coordinator = new ScenarioRunCoordinator({
    now: monotonicClock(),
    onCheckpoint: (record) => { repository.saveScenarioRunRecord(record); },
    // The pause fires from the checkpoint-saved hook so the paused snapshot
    // lands on a step boundary: step 1 completed, downstream steps untouched.
    onCheckpointSaved: (record) => {
      if (record.steps[0]?.status === 'completed') localPause.abort();
    },
    executor: async (input) => {
      calls += 1;
      return successfulResult(input);
    },
  });
  return { coordinator, runId, pauseSignal: localPause.signal, executedTimes: () => calls };
}

let root: string;
let dbPath: string;
// A fixed integrity secret keeps run records verifiable across simulated restarts.
const INTEGRITY_SECRET = Buffer.alloc(32, 9);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-scenario-control-'));
  dbPath = path.join(root, 'control.db');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Scenario public pause/cancel contract', () => {
  it('pause persists a durable paused checkpoint and resume continues without redoing completed steps', async () => {
    const manifest = realFactoryManifest();
    const checkpoints: ScenarioRunRecord[] = [];
    const store = new PersistenceStore(dbPath);
    const repository = new PersonalizationRepository(store.raw, INTEGRITY_SECRET);
    try {
      const localPause = new AbortController();
      let calls = 0;
      const coordinator = new ScenarioRunCoordinator({
        now: monotonicClock(),
        onCheckpoint: (record) => {
          checkpoints.push(structuredClone(record));
          repository.saveScenarioRunRecord(record);
        },
        // Pause lands on the step boundary right after step 1 completes.
        onCheckpointSaved: (record) => {
          if (record.steps[0]?.status === 'completed') localPause.abort();
        },
        executor: async (input) => {
          calls += 1;
          return successfulResult(input);
        },
      });

      const paused = await coordinator.start({
        runId: 'run-pause-resume',
        manifest,
        pauseSignal: localPause.signal,
      });
      expect(paused.ok).toBe(true);
      if (!paused.ok) return;
      expect(paused.record.status).toBe('paused');
      expect(calls).toBe(1);
      expect(checkpoints.at(-1)?.status).toBe('paused');
      // Completed step evidence is preserved inside the paused checkpoint.
      expect(paused.record.steps[0]?.status).toBe('completed');
      expect(paused.record.steps[0]?.outputDigest).not.toBeNull();
      expect(repository.getRecoverableScenarioRun('scenario-session')?.status).toBe('paused');

      const resumed = await coordinator.resume(paused.record);
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) return;
      expect(resumed.record.status).toBe('completed');
      // The completed first step is not re-executed; every remaining step ran once.
      expect(calls).toBe(resumed.record.executionOrder.length);
      expect(repository.getRecoverableScenarioRun('scenario-session')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('cancel is terminal, discards late provider results, and can never be resumed', async () => {
    const manifest = realFactoryManifest();
    const cancelController = new AbortController();
    let releaseExecutor: (() => void) | undefined;
    const executorGate = new Promise<void>((resolve) => { releaseExecutor = resolve; });
    let executorReturned = false;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async (input) => {
        // Simulates a provider result that arrives only after cancellation.
        cancelController.abort();
        await executorGate;
        executorReturned = true;
        return successfulResult(input);
      },
    });

    const cancelledPromise = coordinator.start({
      runId: 'run-cancel-terminal',
      manifest,
      cancelSignal: cancelController.signal,
    });
    releaseExecutor?.();
    const cancelled = await cancelledPromise;
    expect(executorReturned).toBe(true);
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;

    expect(cancelled.record.status).toBe('cancelled');
    expect(cancelled.record.completedAt).not.toBeNull();
    // The late provider output was discarded, not folded into the record.
    expect(cancelled.record.steps[0]?.status).toBe('running');
    expect(cancelled.record.steps[0]?.output).toBeNull();
    expect(cancelled.record.steps[0]?.outputDigest).toBeNull();

    const revived = await coordinator.resume(cancelled.record);
    expect(revived).toEqual({
      ok: false,
      code: 'invalid_record',
      issues: ['Only interrupted, paused, running or failed records can resume'],
    });
  });

  it('keeps a paused run recoverable across a simulated restart', async () => {
    const manifest = realFactoryManifest();
    // ── First process life: pause mid-run and close the database. ──
    {
      const store = new PersistenceStore(dbPath);
      const repository = new PersonalizationRepository(store.raw, INTEGRITY_SECRET);
      const { coordinator, pauseSignal } = pausedRunSetup(repository, 'run-restart-pause');
      const paused = await coordinator.start({ runId: 'run-restart-pause', manifest, pauseSignal });
      expect(paused.ok).toBe(true);
      if (!paused.ok) return;
      expect(paused.record.status).toBe('paused');
      store.close();
    }

    // ── Second process life: the paused checkpoint is still recoverable and resumable. ──
    const store = new PersistenceStore(dbPath);
    const repository = new PersonalizationRepository(store.raw, INTEGRITY_SECRET);
    try {
      const recovered = repository.getRecoverableScenarioRun('scenario-session');
      expect(recovered?.status).toBe('paused');
      expect(recovered?.steps[0]?.status).toBe('completed');

      let resumedCalls = 0;
      const resumedCoordinator = new ScenarioRunCoordinator({
        // A later clock models real elapsed time across the restart; timestamps
        // must never move backwards versus the persisted paused checkpoint.
        now: monotonicClock(50_000),
        onCheckpoint: (record) => { repository.saveScenarioRunRecord(record); },
        executor: async (input) => {
          resumedCalls += 1;
          return successfulResult(input);
        },
      });
      const resumed = await resumedCoordinator.resume(recovered);
      expect(resumed.ok).toBe(true);
      if (!resumed.ok) return;
      expect(resumed.record.status).toBe('completed');
      // Only the unfinished downstream steps executed after the restart.
      expect(resumedCalls).toBe(resumed.record.executionOrder.length - 1);
      expect(repository.getRecoverableScenarioRun('scenario-session')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('cancels a stored paused checkpoint terminally and keeps cancelled records immutable', async () => {
    const manifest = realFactoryManifest();
    const store = new PersistenceStore(dbPath);
    const repository = new PersonalizationRepository(store.raw, INTEGRITY_SECRET);
    try {
      const { coordinator, runId, pauseSignal } = pausedRunSetup(repository, 'run-store-cancel');
      const paused = await coordinator.start({ runId, manifest, pauseSignal });
      expect(paused.ok).toBe(true);
      if (!paused.ok) return;

      const terminated = terminateStoredScenarioRun(paused.record, 'cancelled', { now: () => 5_000_000 });
      expect(terminated.ok).toBe(true);
      if (!terminated.ok) return;
      expect(terminated.record.status).toBe('cancelled');
      expect(terminated.record.completedAt).toBe(5_000_000);
      repository.saveScenarioRunRecord(terminated.record);
      expect(repository.getRecoverableScenarioRun('scenario-session')).toBeUndefined();
      expect(repository.getScenarioRunRecord(terminated.record.runId)?.status).toBe('cancelled');

      // Cancelled runs are immutable: no late write may rewrite history.
      const forged = structuredClone(terminated.record);
      forged.updatedAt = 6_000_000;
      expect(() => repository.saveScenarioRunRecord(forged)).toThrow(/immutable|backwards/u);
    } finally {
      store.close();
    }
  });

  it('rejects controlling terminal or malformed stored records', async () => {
    const manifest = realFactoryManifest('builtin:scenarios/general-research');
    const controller = new AbortController();
    controller.abort();
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async (input) => successfulResult(input),
    });
    const start = await coordinator.start({ runId: 'run-control-guard', manifest, signal: controller.signal });
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const pausedAttempt = terminateStoredScenarioRun(start.record, 'paused');
    expect(pausedAttempt.ok).toBe(true);

    const completedRecord = { ...start.record, status: 'completed' as const, completedAt: 20_000 };
    expect(terminateStoredScenarioRun(completedRecord, 'paused').ok).toBe(false);
    expect(terminateStoredScenarioRun(completedRecord, 'cancelled').ok).toBe(false);
    expect(terminateStoredScenarioRun(null, 'cancelled').ok).toBe(false);
    expect(digestResolvedManifestSnapshot(manifest)).toBe(manifest.manifestDigest);
  });

  it('prefers cancellation over pause when both controls fire mid-run', async () => {
    const manifest = realFactoryManifest();
    const pauseController = new AbortController();
    const cancelController = new AbortController();
    let calls = 0;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      executor: async (input) => {
        calls += 1;
        pauseController.abort();
        cancelController.abort();
        return successfulResult(input);
      },
    });
    const result = await coordinator.start({
      runId: 'run-cancel-wins',
      manifest,
      pauseSignal: pauseController.signal,
      cancelSignal: cancelController.signal,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A cancelled run must never be downgraded into recoverable work.
    expect(result.record.status).toBe('cancelled');
    expect(calls).toBe(1);
  });
});

