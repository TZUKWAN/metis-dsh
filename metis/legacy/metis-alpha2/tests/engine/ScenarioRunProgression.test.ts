/**
 * Run-record progression rules under the Harness state machine.
 * 合法迁移（Step Loop 迭代、条件跳过、回溯重置、Workflow Loop 重入）必须可持久化；
 * 无 loop 信号的状态回退（伪造/重放）必须继续被拒绝。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import { PersonalizationResolver } from '../../engine/personalization/PersonalizationResolver.js';
import {
  ScenarioRunCoordinator,
  digestResolvedManifestSnapshot,
  digestScenarioStepOutput,
  type ScenarioRunRecord,
  type ScenarioStepExecutionInput,
} from '../../engine/personalization/ScenarioRunCoordinator.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import type { ResolvedRunManifest } from '../../engine/runtime/PersonalizationRuntimeContract.js';

const NOW = 1_785_398_400_000;

let root: string;
let store: PersistenceStore;
let repository: PersonalizationRepository;

// 运行记录完整性签名（PersonalizationRepository 硬化后必传）：保存与校验
// 场景运行记录需要密钥，测试用固定密钥与 ScenarioWorkflowService.test 一致。
const INTEGRITY_SECRET = Buffer.alloc(32, 21);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-run-progression-'));
  store = new PersistenceStore(path.join(root, 'progression.db'));
  repository = new PersonalizationRepository(store.raw, INTEGRITY_SECRET);
});

afterEach(() => {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function resolveFactoryManifest(scenarioId = 'builtin:scenarios/general-research'): ResolvedRunManifest {
  const definitions = buildBuiltinPersonalizationDefinitions();
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const resolved = new PersonalizationResolver({
    get: (id) => byId.get(id),
    list: (kind, includeDisabled) => definitions.filter((definition) => (
      (!kind || definition.kind === kind) && (includeDisabled || definition.enabled)
    )),
  }).resolve({ sessionId: 'session-1', projectId: 'project-1', scenarioId, createdAt: NOW });
  if (!resolved.ok) throw new Error(resolved.issues.join('; '));
  return resolved.manifest;
}

function mutatedManifest(
  mutator: (manifest: ResolvedRunManifest) => void,
  scenarioId?: string,
): ResolvedRunManifest {
  const manifest = structuredClone(resolveFactoryManifest(scenarioId));
  mutator(manifest);
  manifest.manifestDigest = digestResolvedManifestSnapshot(manifest);
  return manifest;
}

function monotonicClock(start = NOW): () => number {
  let value = start;
  return () => value++;
}

function assessedResult(input: ScenarioStepExecutionInput, satisfied: boolean, reason: string) {
  const output = { stepId: input.step.id, stepIteration: input.stepIteration ?? 1 };
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
  return { ok: true as const, output, outputDigest: digestScenarioStepOutput(output), artifactRefs: [] };
}

describe('scenario run progression under Harness semantics', () => {
  it('persists every Step Loop iteration checkpoint until satisfied', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.loop = {
        enabled: true,
        maxIterations: 5,
        stopCondition: 'passes review',
        evaluator: 'ai_judgement',
        onExhausted: 'fail',
        backtrackStepId: null,
      };
    });
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      onCheckpoint: (record) => { repository.saveScenarioRunRecord(record); },
      executor: async (input) => assessedResult(input, (input.stepIteration ?? 1) >= 3, 'iteration verdict'),
    });

    const result = await coordinator.start({ runId: 'loop-run', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('completed');
    expect(repository.getScenarioRunRecord('loop-run')).toEqual(result.record);
    expect(result.record.steps[0]?.validationHistory).toHaveLength(3);
  });

  it('persists a condition-skipped step as skipped', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.condition = 'Run only when needed';
    });
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      onCheckpoint: (record) => { repository.saveScenarioRunRecord(record); },
      evaluateStepCondition: async () => ({ run: false, reason: 'Not needed' }),
      executor: async (input) => plainResult(input),
    });

    const result = await coordinator.start({ runId: 'skip-run', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.steps[0]?.status).toBe('skipped');
    expect(repository.getScenarioRunRecord('skip-run')?.steps[0]?.status).toBe('skipped');
  });

  it('persists backtrack resets of completed steps when the backtrack counter advances', async () => {
    const manifest = mutatedManifest((m) => {
      const search = m.workflow.find((step) => step.id === 'systematic-search');
      if (!search) throw new Error('missing systematic-search');
      search.failurePolicy = { action: 'backtrack', retryLimit: 0, backtrackStepId: 'scope', instruction: '' };
    }, 'builtin:scenarios/article-review');
    let searchCalls = 0;
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      onCheckpoint: (record) => { repository.saveScenarioRunRecord(record); },
      executor: async (input) => {
        if (input.step.id === 'systematic-search') {
          searchCalls += 1;
          if (searchCalls === 1) return { ok: false as const, code: 'bad_query', message: 'widen scope' };
        }
        return plainResult(input);
      },
    });

    const result = await coordinator.start({ runId: 'backtrack-run', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('completed');
    expect(result.record.backtrackCount).toBe(1);
    expect(repository.getScenarioRunRecord('backtrack-run')).toEqual(result.record);
  });

  it('persists Workflow Loop re-entry resets when the workflow iteration advances', async () => {
    const manifest = mutatedManifest((m) => {
      m.workflowLoop = {
        enabled: true,
        maxIterations: 3,
        stopCondition: 'final review passes',
        reentryStepId: null,
        carryArtifacts: true,
        onExhausted: 'fail',
      };
    });
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      onCheckpoint: (record) => { repository.saveScenarioRunRecord(record); },
      evaluateWorkflowLoop: async (input) => ({
        complete: input.record.workflowIteration >= 2,
        reason: 'gate verdict',
      }),
      executor: async (input) => plainResult(input),
    });

    const result = await coordinator.start({ runId: 'workflow-loop-run', manifest });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.status).toBe('completed');
    expect(result.record.workflowIteration).toBe(2);
    expect(repository.getScenarioRunRecord('workflow-loop-run')).toEqual(result.record);
  });

  it('still rejects a running step silently regressing to pending without a loop signal', async () => {
    const manifest = resolveFactoryManifest();
    const checkpoints: ScenarioRunRecord[] = [];
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      onCheckpoint: (record) => {
        checkpoints.push(record);
        repository.saveScenarioRunRecord(record);
      },
      executor: async (input) => plainResult(input),
    });
    const result = await coordinator.start({ runId: 'forgery-run', manifest });
    expect(result.ok).toBe(true);

    const runningCheckpoint = checkpoints.find((record) => record.steps[0]?.status === 'running');
    if (!runningCheckpoint) throw new Error('expected a running checkpoint');
    const forged = structuredClone(runningCheckpoint);
    const forgedStep = forged.steps[0];
    if (!forgedStep) throw new Error('missing step');
    forgedStep.status = 'pending';
    forged.updatedAt = runningCheckpoint.updatedAt + 1;

    expect(() => repository.saveScenarioRunRecord(forged)).toThrow(/cannot move backwards/u);
  });

  it('still rejects resetting a completed step without a backtrack or re-entry signal', async () => {
    const manifest = resolveFactoryManifest();
    const coordinator = new ScenarioRunCoordinator({
      now: monotonicClock(),
      onCheckpoint: (record) => { repository.saveScenarioRunRecord(record); },
      executor: async (input) => plainResult(input),
    });
    const result = await coordinator.start({ runId: 'immutable-run', manifest });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Terminal run records are immutable as a whole.
    expect(() => repository.saveScenarioRunRecord({
      ...result.record,
      status: 'running',
      completedAt: null,
      updatedAt: result.record.updatedAt + 1,
    })).toThrow(/Terminal scenario run records are immutable/u);

    // A running intermediate record cannot rewrite a completed step back to pending
    // without loop counters advancing — that is a replay/forgery shape.
    const checkpoints: ScenarioRunRecord[] = [];
    const second = new ScenarioRunCoordinator({
      now: monotonicClock(),
      onCheckpoint: (record) => { checkpoints.push(record); },
      executor: async (input) => plainResult(input),
    });
    const secondResult = await second.start({ runId: 'immutable-run-2', manifest });
    expect(secondResult.ok).toBe(true);
    const completedCheckpoint = checkpoints.find((record) => record.steps[0]?.status === 'completed');
    if (!completedCheckpoint) throw new Error('expected a completed checkpoint');
    const forged = structuredClone(completedCheckpoint);
    const forgedStep = forged.steps[0];
    if (!forgedStep) throw new Error('missing step');
    forgedStep.status = 'pending';
    forgedStep.output = null;
    forgedStep.outputDigest = null;
    forged.updatedAt = completedCheckpoint.updatedAt + 1;
    // Save the genuine completed checkpoint first so the forgery is evaluated against it.
    repository.saveScenarioRunRecord(completedCheckpoint);
    expect(() => repository.saveScenarioRunRecord(forged)).toThrow(/immutable/u);
  });
});
