/**
 * ScenarioWorkflowService Harness runtime wiring — 生产链路接通验证。
 * 覆盖：Step Loop completionAssessment、条件步骤评估、Workflow Loop 停止评估、
 * tool-call summary 持久化与 checkpoint policy 开关。
 * judge 与执行器通过消息中的 [ScenarioJudge] 标记区分；judge 一律 allowedTools=[]。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import { PersonalizationResolver } from '../../engine/personalization/PersonalizationResolver.js';
import { digestResolvedManifestSnapshot } from '../../engine/personalization/ScenarioRunCoordinator.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
const INTEGRITY_SECRET = Buffer.alloc(32, 21);
import type { AgentRunResult } from '../../engine/core/types.js';
import type { ResolvedRunManifest } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { runPersistedScenarioWorkflow } from '../../electron/ScenarioWorkflowService.js';

const JUDGE_MARKER = '[ScenarioJudge]';

let root: string;
let store: PersistenceStore;
let repository: PersonalizationRepository;

function completedResult(text: string, toolResults: AgentRunResult['toolResults'] = []): AgentRunResult {
  return {
    status: 'completed',
    finalText: text,
    finalVerified: true,
    messages: [],
    turnsUsed: 1,
    toolResults,
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

function mutatedManifest(
  mutator: (manifest: ResolvedRunManifest) => void,
  scenarioId = 'builtin:scenarios/general-research',
): ResolvedRunManifest {
  const manifest = structuredClone(resolveManifest(scenarioId));
  mutator(manifest);
  manifest.manifestDigest = digestResolvedManifestSnapshot(manifest);
  return manifest;
}

function isJudgeCall(args: { messages: Array<{ content: string }>; allowedTools?: unknown[] }): boolean {
  return args.messages.some((message) => message.content.includes(JUDGE_MARKER))
    && (args.allowedTools?.length ?? 0) === 0;
}

function baseOptions(manifest: ResolvedRunManifest, run: ReturnType<typeof vi.fn>) {
  return {
    agentLoop: { run },
    store,
    repository,
    sessionId: 'session-1',
    messages: [{ role: 'user' as const, content: 'Run the research scenario.' }],
    requestId: 'harness-runtime-test',
    manifest,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-harness-runtime-'));
  store = new PersistenceStore(path.join(root, 'workflow.db'));
  store.createSession('session-1');
  repository = new PersonalizationRepository(store.raw, INTEGRITY_SECRET);
  repository.seedBuiltins(buildBuiltinPersonalizationDefinitions());
});

afterEach(() => {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('runPersistedScenarioWorkflow Harness runtime wiring', () => {
  it('drives a Step Loop with real completion assessments until satisfied', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.loop = {
        enabled: true,
        maxIterations: 4,
        stopCondition: 'Draft cites at least three sources',
        evaluator: 'ai_judgement',
        onExhausted: 'fail',
        backtrackStepId: null,
      };
    });
    let stepCalls = 0;
    let judgeCalls = 0;
    const run = vi.fn().mockImplementation(async (args: { messages: Array<{ content: string }>; allowedTools?: unknown[] }) => {
      if (isJudgeCall(args)) {
        judgeCalls += 1;
        return completedResult(JSON.stringify({
          satisfied: judgeCalls >= 2,
          reason: judgeCalls >= 2 ? 'Three sources are cited' : 'Only one source is cited',
        }));
      }
      stepCalls += 1;
      return completedResult(`Draft iteration ${stepCalls} with evidence.`);
    });

    const response = await runPersistedScenarioWorkflow(baseOptions(manifest, run));

    expect(response.status).toBe('completed');
    if (response.status !== 'completed') return;
    expect(response.answer).toBe('Draft iteration 2 with evidence.');
    expect(stepCalls).toBe(2);
    expect(judgeCalls).toBe(2);
    const records = repository.listCompletedScenarioRunRecords({ sessionId: 'session-1', limit: 5 });
    const record = records.find((candidate) => candidate.runId === `scenario-${response.turnId}`);
    expect(record?.steps[0]?.loopIteration).toBe(2);
    expect(record?.steps[0]?.validationHistory.map((entry) => entry.satisfied)).toEqual([false, true]);
  });

  it('fails the step loop run when the judge never satisfies the stop condition', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.loop = {
        enabled: true,
        maxIterations: 2,
        stopCondition: 'Impossible standard',
        evaluator: 'validation',
        onExhausted: 'fail',
        backtrackStepId: null,
      };
    });
    const run = vi.fn().mockImplementation(async (args: { messages: Array<{ content: string }>; allowedTools?: unknown[] }) => (
      isJudgeCall(args)
        ? completedResult(JSON.stringify({ satisfied: false, reason: 'Standard not met' }))
        : completedResult('draft')
    ));

    const response = await runPersistedScenarioWorkflow(baseOptions(manifest, run));

    expect(response.status).toBe('error');
    if (response.status !== 'error') return;
    expect(response.diagnostics[0]?.code).toBe('scenario_workflow_failed');
  });

  it('treats an unparsable judge verdict as not satisfied instead of crashing', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.loop = {
        enabled: true,
        maxIterations: 2,
        stopCondition: 'Any',
        evaluator: 'completion_criteria',
        onExhausted: 'fail',
        backtrackStepId: null,
      };
    });
    let judgeCalls = 0;
    const run = vi.fn().mockImplementation(async (args: { messages: Array<{ content: string }>; allowedTools?: unknown[] }) => {
      if (isJudgeCall(args)) {
        judgeCalls += 1;
        return judgeCalls === 1
          ? completedResult('I think it is fine, no JSON here')
          : completedResult(JSON.stringify({ satisfied: true, reason: 'Now it passes' }));
      }
      return completedResult('draft');
    });

    const response = await runPersistedScenarioWorkflow(baseOptions(manifest, run));

    expect(response.status).toBe('completed');
    expect(judgeCalls).toBe(2);
  });

  it('skips a conditional step when the condition judge decides against running', async () => {
    const manifest = mutatedManifest((m) => {
      const scope = m.workflow.find((step) => step.id === 'scope');
      if (!scope) throw new Error('missing scope step');
      scope.condition = 'Run only when the research question is unclear';
    }, 'builtin:scenarios/article-review');
    const executedSteps: string[] = [];
    const run = vi.fn().mockImplementation(async (args: { messages: Array<{ content: string }>; allowedTools?: unknown[] }) => {
      if (isJudgeCall(args)) {
        return completedResult(JSON.stringify({ run: false, reason: 'The question is already precise' }));
      }
      const marker = args.messages.at(-1)?.content.match(/workflow step \\"([^\\"]+)\\"/u);
      executedSteps.push(marker?.[1] ?? 'unknown');
      return completedResult(`Output from ${marker?.[1] ?? 'unknown'}`);
    });

    const response = await runPersistedScenarioWorkflow(baseOptions(manifest, run));

    expect(response.status).toBe('completed');
    expect(executedSteps).not.toContain('scope');
    expect(executedSteps.length).toBeGreaterThan(0);
    const records = repository.listCompletedScenarioRunRecords({ sessionId: 'session-1', limit: 5 });
    const record = records.find((candidate) => candidate.runId === `scenario-${response.turnId}`);
    const scope = record?.steps.find((step) => step.stepId === 'scope');
    expect(scope?.status).toBe('skipped');
    expect(scope?.errorMessage).toBe('The question is already precise');
  });

  it('runs the conditional step when the condition judge approves', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.condition = 'Run when evidence exists';
    });
    let stepCalls = 0;
    const run = vi.fn().mockImplementation(async (args: { messages: Array<{ content: string }>; allowedTools?: unknown[] }) => {
      if (isJudgeCall(args)) {
        return completedResult(JSON.stringify({ run: true, reason: 'Evidence exists' }));
      }
      stepCalls += 1;
      return completedResult('full answer');
    });

    const response = await runPersistedScenarioWorkflow(baseOptions(manifest, run));

    expect(response.status).toBe('completed');
    expect(stepCalls).toBe(1);
  });

  it('fails closed when the condition judge returns an invalid verdict', async () => {
    const manifest = mutatedManifest((m) => {
      const step = m.workflow[0];
      if (!step) throw new Error('missing step');
      step.condition = 'Ambiguous condition';
    });
    const run = vi.fn().mockImplementation(async (args: { messages: Array<{ content: string }>; allowedTools?: unknown[] }) => (
      isJudgeCall(args) ? completedResult('not json at all') : completedResult('step output')
    ));

    const response = await runPersistedScenarioWorkflow(baseOptions(manifest, run));

    expect(response.status).toBe('error');
    if (response.status !== 'error') return;
    expect(response.diagnostics[0]?.code).toBe('scenario_workflow_failed');
  });

  it('re-enters the workflow until the Workflow Loop stop condition is satisfied', async () => {
    const manifest = mutatedManifest((m) => {
      m.workflowLoop = {
        enabled: true,
        maxIterations: 3,
        stopCondition: 'The whole report passes final review',
        reentryStepId: null,
        carryArtifacts: true,
        onExhausted: 'fail',
      };
    });
    let stepCalls = 0;
    let workflowJudgeCalls = 0;
    const run = vi.fn().mockImplementation(async (args: { messages: Array<{ content: string }>; allowedTools?: unknown[] }) => {
      if (isJudgeCall(args)) {
        workflowJudgeCalls += 1;
        return completedResult(JSON.stringify({
          complete: workflowJudgeCalls >= 2,
          reason: workflowJudgeCalls >= 2 ? 'Review passed' : 'Needs another pass',
        }));
      }
      stepCalls += 1;
      return completedResult(`Report pass ${stepCalls}`);
    });

    const response = await runPersistedScenarioWorkflow(baseOptions(manifest, run));

    expect(response.status).toBe('completed');
    if (response.status !== 'completed') return;
    expect(response.answer).toBe('Report pass 2');
    expect(stepCalls).toBe(2);
    expect(workflowJudgeCalls).toBe(2);
    const records = repository.listCompletedScenarioRunRecords({ sessionId: 'session-1', limit: 5 });
    const record = records.find((candidate) => candidate.runId === `scenario-${response.turnId}`);
    expect(record?.workflowIteration).toBe(2);
  });

  it('persists tool-call summaries and honors the checkpoint policy opt-out', async () => {
    const toolResults = [
      { toolName: 'web.search', content: '...', status: 'ok' as const, toolCallId: 'c1', metadata: {} },
      { toolName: 'doc.read', content: '', status: 'error' as const, toolCallId: 'c2', error: 'disk gone', metadata: { code: 'EIO' } },
    ];
    const withSummary = mutatedManifest(() => undefined);
    const runA = vi.fn().mockImplementation(async () => completedResult('answer with tools', toolResults));
    const responseA = await runPersistedScenarioWorkflow(baseOptions(withSummary, runA));
    expect(responseA.status).toBe('completed');
    const recordA = repository
      .listCompletedScenarioRunRecords({ sessionId: 'session-1', limit: 5 })
      .find((candidate) => candidate.runId === `scenario-${responseA.turnId}`);
    expect(recordA?.steps[0]?.toolCallSummary).toEqual([
      { toolName: 'web.search', status: 'ok', code: null },
      { toolName: 'doc.read', status: 'error', code: 'EIO' },
    ]);

    const optedOut = mutatedManifest((m) => {
      m.checkpointPolicy = {
        enabled: true,
        afterEveryStep: true,
        afterEveryLoopIteration: true,
        includeToolCallSummary: false,
        resumeMode: 'continue',
      };
    });
    const runB = vi.fn().mockImplementation(async () => completedResult('answer without summaries', toolResults));
    const responseB = await runPersistedScenarioWorkflow({
      ...baseOptions(optedOut, runB),
      requestId: 'harness-runtime-optout',
    });
    expect(responseB.status).toBe('completed');
    const recordB = repository
      .listCompletedScenarioRunRecords({ sessionId: 'session-1', limit: 5 })
      .find((candidate) => candidate.runId === `scenario-${responseB.turnId}`);
    expect(recordB?.steps[0]?.toolCallSummary).toEqual([]);
  });
});
