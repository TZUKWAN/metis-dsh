import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import { PersonalizationResolver } from '../../engine/personalization/PersonalizationResolver.js';
import {
  ScenarioRunControlRequestSchema,
  ScenarioRunControlResponseSchema,
  decodeScenarioRunControlResponse,
} from '../../engine/runtime/ScenarioControlContract.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import type { AgentRunResult, ChatMessage } from '../../engine/core/types.js';
import { runPersistedScenarioWorkflow } from '../../electron/ScenarioWorkflowService.js';

const INTEGRITY_SECRET = Buffer.alloc(32, 21);

let root: string;
let store: PersistenceStore;
let repository: PersonalizationRepository;

function completedResult(text: string): AgentRunResult {
  return {
    status: 'completed',
    finalText: text,
    finalVerified: true,
    messages: [],
    turnsUsed: 1,
    toolResults: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    errors: [],
    traceEvents: [],
  };
}

function resolveManifest(scenarioId: string) {
  const result = new PersonalizationResolver(repository).resolve({
    sessionId: 'session-1',
    projectId: 'project-1',
    scenarioId,
    createdAt: 100,
  });
  if (!result.ok) throw new Error(result.issues.join('; '));
  return result.manifest;
}

function runTurn(options: {
  run: ReturnType<typeof vi.fn>;
  requestId: string;
  manifest: ReturnType<typeof resolveManifest>;
  pauseSignal?: AbortSignal;
  cancelSignal?: AbortSignal;
}) {
  const messages: ChatMessage[] = [{ role: 'user', content: `Turn ${options.requestId}` }];
  return runPersistedScenarioWorkflow({
    agentLoop: { run: options.run },
    store,
    repository,
    sessionId: 'session-1',
    messages,
    requestId: options.requestId,
    manifest: options.manifest,
    pauseSignal: options.pauseSignal,
    cancelSignal: options.cancelSignal,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-scenario-control-service-'));
  store = new PersistenceStore(path.join(root, 'service.db'));
  store.createSession('session-1');
  repository = new PersonalizationRepository(store.raw, INTEGRITY_SECRET);
  repository.seedBuiltins(buildBuiltinPersonalizationDefinitions());
});

afterEach(() => {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('public Scenario pause/cancel over the persisted workflow', () => {
  it('pauses before executing work and the next turn resumes the paused checkpoint to completion', async () => {
    const manifest = resolveManifest('builtin:scenarios/general-research');
    const run = vi.fn().mockImplementation(() => Promise.resolve(completedResult('# Resumed final deliverable')));
    const pauseController = new AbortController();
    pauseController.abort();

    const pausedResponse = await runTurn({
      run,
      requestId: 'pause-turn',
      manifest,
      pauseSignal: pauseController.signal,
    });

    // Nothing executed, nothing answered: the pause is durable state instead.
    expect(pausedResponse.status).toBe('interrupted');
    expect(pausedResponse.diagnostics.some((item) => item.code === 'scenario_run_paused')).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(repository.getRecoverableScenarioRun(manifest.sessionId)?.status).toBe('paused');
    // 暂停轮也必须落一条诚实状态摘要（2026-08-30 整轮归档机制），不能
    // 让暂停在聊天里无痕消失。
    const pausedMessages = store.getMessages('session-1');
    expect(pausedMessages).toHaveLength(2);
    expect(pausedMessages[0]).toEqual({ role: 'user', content: 'Turn pause-turn' });
    expect(pausedMessages[1]?.content).toContain('场景工作流已暂停');

    const resumedResponse = await runTurn({ run, requestId: 'resume-turn', manifest });

    expect(resumedResponse.status).toBe('completed');
    expect(resumedResponse.answer).toBe('# Resumed final deliverable');
    expect(run).toHaveBeenCalledTimes(1);
    const record = repository.listScenarioRunRecords('session-1')[0];
    expect(record?.status).toBe('completed');
    // 整轮归档后的消息契约（2026-08-30）：聊天只留摘要指引，全文在生成物
    // 面板；完成摘要含「最终成果」生成物名，全文不进聊天流。
    const messages = store.getMessages('session-1');
    expect(messages[0]).toEqual({ role: 'user', content: 'Turn pause-turn' });
    expect(messages[1]?.role).toBe('assistant');
    expect(String(messages[1]?.content)).toContain('场景工作流已暂停');
    expect(messages[2]).toEqual({ role: 'user', content: 'Turn resume-turn' });
    // 恢复轮消息顺序：步骤摘要 → 完成摘要（最终成果）。
    const stepSummary = messages.at(-2);
    expect(stepSummary?.role).toBe('assistant');
    // T3 协议（2026-09-08）：正文只留人话摘要（无围栏）；卡片结构在 metadata.stepCard。
    expect(String(stepSummary?.content)).toContain('已完成 ✓');
    expect(String(stepSummary?.content)).toContain('产出：');
    expect(String(stepSummary?.content)).not.toContain('metis-step-card');
    const completion = messages.at(-1);
    expect(completion?.role).toBe('assistant');
    expect(String(completion?.content)).toContain('场景工作流已完成');
    expect(String(completion?.content)).toContain('最终成果');
    expect(String(completion?.content)).not.toContain('# Resumed final deliverable');
    // 全文必须注册为会话生成物（过程产出 + 最终成果）。
    const artifacts = store.listArtifacts('session-1');
    expect(artifacts.some((item) => String(item.name).includes('过程产出'))).toBe(true);
    expect(artifacts.some((item) => String(item.name).includes('最终成果'))).toBe(true);
    const finalArtifact = artifacts.find((item) => String(item.name).includes('最终成果'));
    expect(store.getArtifactContent(finalArtifact!.id, 'session-1')?.content).toBe('# Resumed final deliverable');
  });

  it('cancel persists a terminal cancelled run that later turns cannot revive', async () => {
    const manifest = resolveManifest('builtin:scenarios/general-research');
    const run = vi.fn().mockImplementation(() => Promise.resolve(completedResult('late provider output')));
    const cancelController = new AbortController();
    cancelController.abort();

    const cancelledResponse = await runTurn({
      run,
      requestId: 'cancel-turn',
      manifest,
      cancelSignal: cancelController.signal,
    });

    expect(cancelledResponse.status).toBe('cancelled');
    expect(cancelledResponse.diagnostics.some((item) => item.code === 'scenario_run_cancelled')).toBe(true);
    expect(run).not.toHaveBeenCalled();
    const record = repository.listScenarioRunRecords('session-1').at(-1);
    expect(record?.status).toBe('cancelled');
    expect(record?.completedAt).not.toBeNull();
    // Cancelled runs are never offered as recoverable work.
    expect(repository.getRecoverableScenarioRun(manifest.sessionId)).toBeUndefined();
    expect(store.getMessages('session-1')).toEqual([{ role: 'user', content: 'Turn cancel-turn' }]);

    // The next turn cannot resume the cancelled run; it starts fresh work while
    // the cancelled record itself stays immutable under its own runId.
    const followup = await runTurn({ run, requestId: 'after-cancel-turn', manifest });
    expect(followup.status).toBe('completed');
    expect(repository.getScenarioRunRecord(record!.runId)?.status).toBe('cancelled');
    expect(repository.getRecoverableScenarioRun(manifest.sessionId)).toBeUndefined();
    const statuses = repository.listScenarioRunRecords('session-1').map((item) => item.status);
    expect(statuses).toContain('cancelled');
    expect(statuses).toContain('completed');
  });
});

describe('ScenarioRunControl contract schema', () => {
  it('accepts well-formed control requests and rejects malformed ones', () => {
    const validPause = ScenarioRunControlRequestSchema.safeParse({
      contractVersion: 1,
      operationId: 'op-pause-1',
      sessionId: 'session-1',
      action: 'pause',
    });
    expect(validPause.success).toBe(true);
    const validCancel = ScenarioRunControlRequestSchema.safeParse({
      contractVersion: 1,
      operationId: 'op-cancel-1',
      sessionId: 'session-1',
      action: 'cancel',
      reason: 'user requested stop',
    });
    expect(validCancel.success).toBe(true);
    expect(ScenarioRunControlRequestSchema.safeParse({
      contractVersion: 2,
      operationId: 'op-2',
      sessionId: 'session-1',
      action: 'pause',
    }).success).toBe(false);
    expect(ScenarioRunControlRequestSchema.safeParse({
      contractVersion: 1,
      operationId: 'op-3',
      sessionId: 'session-1',
      action: 'rewind',
    }).success).toBe(false);
  });

  it('decodes responses defensively so a malformed reply cannot crash the renderer', () => {
    const parsed = ScenarioRunControlResponseSchema.safeParse({
      ok: true,
      contractVersion: 1,
      operationId: 'op-1',
      action: 'pause',
      code: 'pause_requested',
    });
    expect(parsed.success).toBe(true);
    const fallback = decodeScenarioRunControlResponse(null, 'op-fallback');
    expect(fallback).toEqual({
      ok: false,
      contractVersion: 1,
      operationId: 'op-fallback',
      code: 'scenario_control_unavailable',
    });
  });
});
