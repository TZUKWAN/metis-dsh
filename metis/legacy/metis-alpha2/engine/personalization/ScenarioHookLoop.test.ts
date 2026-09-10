/**
 * ScenarioHookExecutor / ScenarioLoopScheduler — 场景 Hook 与 Loop（任务G）。
 * 覆盖：approval fail-closed 与放行、notify/log 事件、matchStepId 过滤、
 * step_end 事后触发、run 级事件；Loop 到期判定、状态推进与失败不推进；
 * resolver 把 hooks 编译进 manifest 快照（digest 一致）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersistenceStore } from '../persistence/PersistenceStore.js';
import { PersonalizationRepository } from './PersonalizationRepository.js';
import { PersonalizationResolver } from './PersonalizationResolver.js';
import {
  emitScenarioHookEvent,
  notifyScenarioRunEvent,
  scenarioHookExecutor,
  scenarioRuntimeHookBridge,
  type ScenarioHookEvent,
} from './ScenarioHookExecutor.js';
import type { ScenarioRuntimeEvent } from './ScenarioRunCoordinator.js';
import { collectDueLoops, ScenarioLoopScheduler } from './ScenarioLoopScheduler.js';
import type { ScenarioDefinition, ScenarioHook, ScenarioLoop } from '../runtime/PersonalizationRuntimeContract.js';

function hook(overrides: Partial<ScenarioHook> = {}): ScenarioHook {
  return {
    id: 'hook-1',
    event: 'step_start',
    matchStepId: null,
    action: 'notify',
    instruction: 'watch this step',
    enabled: true,
    ...overrides,
  };
}

function loop(overrides: Partial<ScenarioLoop> = {}): ScenarioLoop {
  return {
    id: 'loop-1',
    name: '周期研究',
    intervalMinutes: 60,
    maxRuns: 3,
    instruction: '汇总本周进展',
    enabled: true,
    lastRunAt: null,
    runCount: 0,
    ...overrides,
  };
}

function stepInput(stepId: string): Parameters<ReturnType<typeof scenarioHookExecutor>>[0] {
  return {
    runId: 'run-1',
    executionKey: 'a'.repeat(64),
    sessionId: 'session-1',
    projectId: 'project-1',
    scenarioId: 'user:scenario/s1',
    manifestDigest: 'b'.repeat(64),
    step: {
      id: stepId,
      name: 'Step',
      description: '',
      agentId: 'user:agent/a1',
      skillIds: [],
      toolIds: [],
      mcpIds: [],
      dependsOn: [],
      maxTurns: 5,
    },
    dependencyOutputs: {},
  };
}

const FULL_SUCCESS = {
  ok: true as const,
  output: { text: 'done' },
  outputDigest: 'c'.repeat(64),
  artifactRefs: [],
};

describe('scenarioHookExecutor', () => {
  it('approval 拒绝：步骤以 hook_denied 失败且 producer 不执行', async () => {
    const producer = vi.fn().mockResolvedValue(FULL_SUCCESS);
    const wrapped = scenarioHookExecutor(producer, {
      hooks: [hook({ action: 'approval' })],
      runId: 'run-1',
      onApprovalRequired: () => false,
    });
    const result = await wrapped(stepInput('step-1')) as { ok: boolean; code?: string };
    expect(result.ok).toBe(false);
    expect(result.code).toBe('hook_denied');
    expect(producer).not.toHaveBeenCalled();
  });

  it('approval 决策通道异常时 fail closed', async () => {
    const producer = vi.fn().mockResolvedValue(FULL_SUCCESS);
    const wrapped = scenarioHookExecutor(producer, {
      hooks: [hook({ action: 'approval' })],
      runId: 'run-1',
      onApprovalRequired: () => { throw new Error('ui gone'); },
    });
    const result = await wrapped(stepInput('step-1')) as { ok: boolean; code?: string; message?: string };
    expect(result.ok).toBe(false);
    expect(result.code).toBe('hook_denied');
    expect(result.message).toContain('ui gone');
    expect(producer).not.toHaveBeenCalled();
  });

  it('approval 同意：透传 producer 的完整执行结果（digest/artifactRefs 不变）', async () => {
    const producer = vi.fn().mockResolvedValue(FULL_SUCCESS);
    const wrapped = scenarioHookExecutor(producer, {
      hooks: [hook({ action: 'approval' })],
      runId: 'run-1',
      onApprovalRequired: () => true,
    });
    await expect(wrapped(stepInput('step-1'))).resolves.toEqual(FULL_SUCCESS);
    expect(producer).toHaveBeenCalledTimes(1);
  });

  it('notify/log 事件不阻塞执行；matchStepId 只匹配目标步骤；step_end 在执行后触发', async () => {
    const events: ScenarioHookEvent[] = [];
    const producer = vi.fn().mockResolvedValue(FULL_SUCCESS);
    const wrapped = scenarioHookExecutor(producer, {
      hooks: [
        hook({ id: 'h-notify', event: 'step_start', action: 'notify' }),
        hook({ id: 'h-match', event: 'step_start', action: 'log', matchStepId: 'step-2' }),
        hook({ id: 'h-end', event: 'step_end', action: 'notify' }),
      ],
      runId: 'run-1',
      onApprovalRequired: () => true,
      onHookEvent: (event) => events.push(event),
      now: () => 1000,
    });
    await wrapped(stepInput('step-1'));
    expect(producer).toHaveBeenCalledTimes(1);
    // h-notify（step-1 匹配）与 h-end 触发；h-match 只匹配 step-2，不触发。
    expect(events.map((event) => event.hookId)).toEqual(['h-notify', 'h-end']);
    expect(events[0]).toMatchObject({ event: 'step_start', action: 'notify', stepId: 'step-1', runId: 'run-1', occurredAt: 1000 });
    expect(events[1]).toMatchObject({ event: 'step_end', action: 'notify' });
  });

  it('禁用的钩子不触发；无 onHookEvent 时不抛错', async () => {
    const producer = vi.fn().mockResolvedValue(FULL_SUCCESS);
    const wrapped = scenarioHookExecutor(producer, {
      hooks: [hook({ enabled: false, action: 'notify' })],
      runId: 'run-1',
      onApprovalRequired: () => true,
    });
    await expect(wrapped(stepInput('step-1'))).resolves.toEqual(FULL_SUCCESS);
  });

  it('notifyScenarioRunEvent 上报 run_start/run_end 的启用钩子', () => {
    const events: ScenarioHookEvent[] = [];
    notifyScenarioRunEvent(
      [hook({ id: 'h-start', event: 'run_start' }), hook({ id: 'h-end', event: 'run_end' }), hook({ id: 'h-step', event: 'step_start' })],
      'run_start',
      { runId: 'run-9', onHookEvent: (event) => events.push(event), now: () => 42 },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ hookId: 'h-start', event: 'run_start', stepId: null, runId: 'run-9' });
  });
});

describe('ScenarioLoopScheduler', () => {
  it('collectDueLoops：从未运行、间隔已到、未达上限且启用时到期', () => {
    const now = 60 * 60 * 1000; // 60 分钟
    const scenario = {
      id: 'user:scenario/s1',
      kind: 'scenario',
      enabled: true,
      loops: [
        loop({ id: 'due-never', intervalMinutes: 30 }),
        loop({ id: 'due-elapsed', intervalMinutes: 60, lastRunAt: 0 }),
        loop({ id: 'not-due', intervalMinutes: 60, lastRunAt: now - 30 * 60 * 1000 }),
        loop({ id: 'maxed', intervalMinutes: 30, runCount: 3 }),
        loop({ id: 'off', intervalMinutes: 30, enabled: false }),
      ],
    } as never as Parameters<typeof collectDueLoops>[0][number];
    const due = collectDueLoops([scenario], now).map((item) => item.loop.id);
    expect(due).toEqual(['due-never', 'due-elapsed']);
  });

  it('tick：触发成功后推进 runCount/lastRunAt；失败不推进', async () => {
    const persisted: Array<{ scenarioId: string; loop: ScenarioLoop; revision: number }> = [];
    const scenarios: ScenarioDefinition[] = [{
      id: 'user:scenario/s1',
      kind: 'scenario',
      revision: 5,
      enabled: true,
      loops: [loop({ id: 'loop-a' }), loop({ id: 'loop-b', instruction: '会失败' })],
    } as ScenarioDefinition];
    const scheduler = new ScenarioLoopScheduler({
      listScenarios: () => scenarios,
      onLoopDue: async (due) => due.loop.id === 'loop-a',
      persistLoopState: async (scenarioId, loopState, revision) => {
        persisted.push({ scenarioId, loop: loopState, revision });
        return true;
      },
      now: () => 4_000_000,
      tickIntervalMs: 60_000,
    });
    const triggered = await scheduler.tick();
    expect(triggered).toBe(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ scenarioId: 'user:scenario/s1', revision: 5 });
    expect(persisted[0]!.loop).toMatchObject({ id: 'loop-a', runCount: 1, lastRunAt: 4_000_000 });
    expect(scheduler.isRunning()).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });
});

describe('resolver 把 hooks 编译进 manifest（场景G）', () => {
  let root: string;
  let store: PersistenceStore;
  let repository: PersonalizationRepository;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-hooks-'));
    store = new PersistenceStore(path.join(root, 'test.db'));
    repository = new PersonalizationRepository(store.raw);
  });

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('带 hooks 的场景 resolve 后 manifest.hooks 为快照且 digest 校验通过', () => {
    const agent = {
      contractVersion: 1 as const,
      id: 'user:agent/a1',
      kind: 'agent' as const,
      name: 'A1',
      description: '',
      enabled: true,
      tags: [],
      revision: 1,
      provenance: {
        origin: 'user' as const, author: 't', version: '1.0.0', license: null, sourceUrl: null,
        sourceRevision: null, installedDigest: null, parentId: null, parentVersion: null,
        locallyModified: false, createdAt: 0, updatedAt: 0,
      },
      role: 'r',
      systemPrompt: 'sp',
      modelPreference: null,
      skillIds: [],
      toolIds: [],
      mcpIds: [],
      memory: { scope: 'project' as const, retainDecisions: true, retainArtifacts: true, maxSummaryChars: 1000 },
      output: { format: 'markdown' as const, schema: null, plan: null, requireEvidenceEnvelope: false, includeIntegrityReport: false },
      maxTurns: 10,
      retryLimit: 0,
    };
    const scenario: ScenarioDefinition = {
      contractVersion: 1 as const,
      id: 'user:scenario/s1',
      kind: 'scenario' as const,
      name: 'S1',
      description: '',
      enabled: true,
      tags: [],
      revision: 1,
      provenance: {
        origin: 'user' as const, author: 't', version: '1.0.0', license: null, sourceUrl: null,
        sourceRevision: null, installedDigest: null, parentId: null, parentVersion: null,
        locallyModified: false, createdAt: 0, updatedAt: 0,
      },
      agentIds: ['user:agent/a1'],
      skillIds: [],
      mcpIds: [],
      rulesIds: [],
      workflow: [],
      fullAccess: {
        mode: 'full_access', perActionConfirmation: false, liveSteering: true,
        silentCheckpoints: true, rollbackOnFailure: false, persistAcrossRestart: true,
      },
      memory: { scope: 'project' as const, retainDecisions: true, retainArtifacts: true, maxSummaryChars: 1000 },
      output: { format: 'markdown' as const, schema: null, plan: null, requireEvidenceEnvelope: false, includeIntegrityReport: false },
      triggerPhrases: [],
      capability: 'research' as const,
      hooks: [hook({ id: 'h-approve', action: 'approval' })],
    };
    expect(repository.save({ contractVersion: 1, definition: agent, expectedRevision: 0 }).ok).toBe(true);
    expect(repository.save({ contractVersion: 1, definition: scenario, expectedRevision: 0 }).ok).toBe(true);
    const result = new PersonalizationResolver(repository).resolve({
      sessionId: 'session-1',
      projectId: 'project-1',
      scenarioId: 'user:scenario/s1',
      createdAt: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.hooks).toEqual([hook({ id: 'h-approve', action: 'approval' })]);
  });
});


function runtimeEvent(overrides: Partial<ScenarioRuntimeEvent> = {}): ScenarioRuntimeEvent {
  return {
    event: 'validation_failed',
    runId: 'run-1',
    stepId: 'step-1',
    workflowIteration: 1,
    stepIteration: 1,
    code: 'completion_not_satisfied',
    message: 'not satisfied',
    ...overrides,
  };
}

describe('scenarioRuntimeHookBridge', () => {
  it('validation_failed 的 retry/auto_fix/execute_prompt 钩子映射为 coordinator 指令', async () => {
    for (const action of ['retry', 'auto_fix', 'execute_prompt'] as const) {
      const events: ScenarioHookEvent[] = [];
      const bridge = scenarioRuntimeHookBridge({
        hooks: [hook({ event: 'validation_failed', action, instruction: `do ${action}` })],
        runId: 'run-1',
        onApprovalRequired: () => true,
        onHookEvent: (event) => events.push(event),
        now: () => 7,
      });
      const directive = await bridge(runtimeEvent());
      expect(directive).toEqual({ action, instruction: `do ${action}` });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event: 'validation_failed', action, stepId: 'step-1', occurredAt: 7 });
    }
  });

  it('backtrack 钩子携带 targetStepId；pause 钩子映射为 pause 指令', async () => {
    const backtrack = scenarioRuntimeHookBridge({
      hooks: [hook({ event: 'tool_failed', action: 'backtrack', targetStepId: 'step-0', instruction: 'go back' })],
      runId: 'run-1',
      onApprovalRequired: () => true,
    });
    await expect(backtrack(runtimeEvent({ event: 'tool_failed', code: 'tool_crashed' })))
      .resolves.toEqual({ action: 'backtrack', targetStepId: 'step-0', instruction: 'go back' });

    const pause = scenarioRuntimeHookBridge({
      hooks: [hook({ event: 'tool_failed', action: 'pause', instruction: 'hold on' })],
      runId: 'run-1',
      onApprovalRequired: () => true,
    });
    await expect(pause(runtimeEvent({ event: 'tool_failed' })))
      .resolves.toEqual({ action: 'pause', instruction: 'hold on' });
  });

  it('approval 钩子拒绝或通道异常时 fail closed 为 pause 指令', async () => {
    const denied = scenarioRuntimeHookBridge({
      hooks: [hook({ event: 'validation_failed', action: 'approval', instruction: 'review this failure' })],
      runId: 'run-1',
      onApprovalRequired: () => false,
    });
    await expect(denied(runtimeEvent())).resolves.toEqual({ action: 'pause', instruction: 'review this failure' });

    const broken = scenarioRuntimeHookBridge({
      hooks: [hook({ event: 'validation_failed', action: 'approval', instruction: 'review' })],
      runId: 'run-1',
      onApprovalRequired: () => { throw new Error('ui offline'); },
    });
    await expect(broken(runtimeEvent())).resolves.toEqual({ action: 'pause', instruction: 'review' });

    const approved = scenarioRuntimeHookBridge({
      hooks: [hook({ event: 'validation_failed', action: 'approval' })],
      runId: 'run-1',
      onApprovalRequired: () => true,
    });
    await expect(approved(runtimeEvent())).resolves.toBeUndefined();
  });

  it('notify/log 只汇报不产生指令；matchStepId 过滤与运行级事件匹配', async () => {
    const events: ScenarioHookEvent[] = [];
    const bridge = scenarioRuntimeHookBridge({
      hooks: [
        hook({ id: 'h-notify', event: 'loop_iteration', action: 'notify' }),
        hook({ id: 'h-other', event: 'loop_iteration', action: 'notify', matchStepId: 'step-9' }),
        hook({ id: 'h-log', event: 'loop_iteration', action: 'log' }),
      ],
      runId: 'run-1',
      onApprovalRequired: () => true,
      onHookEvent: (event) => events.push(event),
    });
    // 运行级 loop 事件（stepId null）：只匹配无步骤过滤的钩子。
    const directive = await bridge(runtimeEvent({ event: 'loop_iteration', stepId: null, stepIteration: null }));
    expect(directive).toBeUndefined();
    expect(events.map((event) => event.hookId)).toEqual(['h-notify', 'h-log']);
  });

  it('首个指令型钩子生效；禁用钩子与异事件钩子被跳过', async () => {
    const bridge = scenarioRuntimeHookBridge({
      hooks: [
        hook({ id: 'h-off', event: 'validation_failed', action: 'pause', enabled: false }),
        hook({ id: 'h-other', event: 'tool_failed', action: 'pause' }),
        hook({ id: 'h-first', event: 'validation_failed', action: 'retry', instruction: 'first' }),
        hook({ id: 'h-second', event: 'validation_failed', action: 'pause', instruction: 'second' }),
      ],
      runId: 'run-1',
      onApprovalRequired: () => true,
    });
    await expect(bridge(runtimeEvent())).resolves.toEqual({ action: 'retry', instruction: 'first' });
  });
});

describe('emitScenarioHookEvent', () => {
  it('checkpoint_saved 只触发 notify/log 钩子并遵循 matchStepId', () => {
    const events: ScenarioHookEvent[] = [];
    emitScenarioHookEvent(
      [
        hook({ id: 'h-ck', event: 'checkpoint_saved', action: 'notify' }),
        hook({ id: 'h-ck-log', event: 'checkpoint_saved', action: 'log' }),
        hook({ id: 'h-ck-approval', event: 'checkpoint_saved', action: 'approval' }),
        hook({ id: 'h-ck-step', event: 'checkpoint_saved', action: 'notify', matchStepId: 'step-1' }),
      ],
      'checkpoint_saved',
      { runId: 'run-1', onHookEvent: (event) => events.push(event), now: () => 5 },
    );
    expect(events.map((event) => event.hookId)).toEqual(['h-ck', 'h-ck-log']);
    expect(events[0]).toMatchObject({ event: 'checkpoint_saved', stepId: null, occurredAt: 5 });
  });
});

