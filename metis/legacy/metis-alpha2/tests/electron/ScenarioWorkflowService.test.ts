import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { realTempRoot } from './helpers/realTempDir.mjs';
import path from 'node:path';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import { PersonalizationResolver } from '../../engine/personalization/PersonalizationResolver.js';
import { digestResolvedManifestSnapshot } from '../../engine/personalization/ScenarioRunCoordinator.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import type { AgentRunResult, ChatMessage } from '../../engine/core/types.js';
import {
  applyStepControl,
  compileScenarioExecutionManifest,
  extractStepBrief,
  hasExecutableScenarioWorkflow,
  preflightScenarioExecution,
  runPersistedScenarioWorkflow,
} from '../../electron/ScenarioWorkflowService.js';

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
  return result;
}

const TEST_OUTPUT_PLAN = {
  primaryDeliverable: 'Complete evidence-grounded manuscript',
  supportingArtifacts: ['Evidence table', 'Source ledger'],
  qualityCriteria: ['Every claim is traceable', 'Methods are reproducible'],
};

function withOutputPlan(resolved: ReturnType<typeof resolveManifest>) {
  const candidate = {
    ...resolved.manifest,
    output: {
      ...resolved.manifest.output,
      format: 'artifact_bundle' as const,
      plan: TEST_OUTPUT_PLAN,
    },
    manifestDigest: '0'.repeat(64),
  };
  return {
    ...candidate,
    manifestDigest: digestResolvedManifestSnapshot(candidate),
  };
}

function outputBundleText(
  plan: NonNullable<ReturnType<typeof resolveManifest>['manifest']['output']['plan']>,
  primaryContent = '# Complete primary deliverable\n\nEvidence-aware final content.',
): string {
  return JSON.stringify({
    primary: {
      name: plan.primaryDeliverable,
      content: primaryContent,
    },
    supporting: plan.supportingArtifacts.map((name, index) => ({
      name,
      content: `# ${name}\n\nSupporting artifact ${index + 1}.`,
    })),
    quality: plan.qualityCriteria.map((criterion) => ({
      criterion,
      status: 'met',
      evidence: `Verified against the generated deliverables: ${criterion}`,
    })),
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(realTempRoot(), 'metis-scenario-workflow-'));
  store = new PersistenceStore(path.join(root, 'workflow.db'));
  store.createSession('session-1');
  repository = new PersonalizationRepository(store.raw, INTEGRITY_SECRET);
  repository.seedBuiltins(buildBuiltinPersonalizationDefinitions());
});

afterEach(() => {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('runPersistedScenarioWorkflow', () => {
  it('routes a single-step scenario through the persisted workflow engine', () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    expect(resolved.manifest.workflow).toHaveLength(1);
    expect(hasExecutableScenarioWorkflow(resolved.manifest)).toBe(true);
    expect(hasExecutableScenarioWorkflow({ ...resolved.manifest, workflow: [] })).toBe(false);
  });

  it('executes a one-Agent scenario output plan without requiring an authored workflow', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const planned = withOutputPlan(resolved);
    const exactMemory = {
      scope: 'session' as const,
      retainDecisions: false,
      retainArtifacts: true,
      maxSummaryChars: 12_000,
    };
    const candidate = {
      ...planned,
      workflow: [],
      implicitOutputStep: {
        id: 'runtime-output-plan',
        name: 'Generate configured deliverables',
        description: 'Generate every configured deliverable.',
        agentId: planned.agentIds[0]!,
        agentModelPreference: 'specialized-output-model',
        retryLimit: 1,
        skillIds: [...planned.skillIds],
        toolIds: [...planned.allowedTools],
        mcpIds: [...planned.mcpIds],
        dependsOn: [],
        maxTurns: 3,
        memory: exactMemory,
        output: planned.output,
      },
      manifestDigest: '0'.repeat(64),
    };
    const manifest = {
      ...candidate,
      manifestDigest: digestResolvedManifestSnapshot(candidate),
    };
    const fundingScope = 'Use ownerId=local and projectId=project-1 exactly; never infer or replace them.';
    const compilation = compileScenarioExecutionManifest(manifest, {
      executionInstructions: [fundingScope],
    });
    expect(compilation.ok).toBe(true);
    if (!compilation.ok || !compilation.manifest) return;
    const executionManifest = compilation.manifest;
    const plan = executionManifest.output.plan!;
    const run = vi.fn();
    const preferredRun = vi.fn()
      .mockResolvedValueOnce(completedResult('{"primary":{"name":"wrong"}}'))
      .mockResolvedValueOnce(completedResult(outputBundleText(
        plan,
        '# Workflow-free primary deliverable',
      )));
    const agentLoopForModel = vi.fn().mockReturnValue({ run: preferredRun });

    expect(manifest.agentIds).toHaveLength(1);
    expect(hasExecutableScenarioWorkflow(manifest)).toBe(true);
    expect(preflightScenarioExecution(manifest)).toEqual({ ok: true, useCoordinator: true });

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      agentLoopForModel,
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Generate every configured deliverable.' }],
      requestId: 'workflow-plan-only',
      manifest: executionManifest,
    });

    expect(response.status).toBe('completed');
    expect(response.answer).toBe('# Workflow-free primary deliverable');
    expect(run).not.toHaveBeenCalled();
    expect(agentLoopForModel).toHaveBeenCalledWith('specialized-output-model');
    expect(preferredRun).toHaveBeenCalledTimes(2);
    expect(preferredRun.mock.calls[0]?.[0]).toMatchObject({
      allowedTools: executionManifest.allowedTools,
      maxTurns: 3,
      fullAccess: executionManifest.fullAccess,
    });
    expect((preferredRun.mock.calls[0]?.[0].messages as ChatMessage[]).at(-1)?.content)
      .toContain('# Required output bundle');
    expect(preferredRun.mock.calls[0]?.[0].skillPrompt)
      .toContain(`metis-source:${manifest.agentIds[0]}`);
    expect(preferredRun.mock.calls[0]?.[0].skillPrompt).toContain(fundingScope);
    const artifacts = store.listArtifacts('session-1');
    // 过程产物文档化（2026-08-29 刘总要求）+ 整轮归档（2026-08-30）：
    // 每步一个「过程产出」生成物，轮次结束再归档一个「最终成果」生成物，
    // 与 bundle 生成物同板存放；聊天里只有摘要指引。
    expect(artifacts).toHaveLength(
      1 + 1 + plan.supportingArtifacts.length + 1 + 1,
    );
    // 过程产物同样携带 manifestDigest，因此过滤计数与总数一致。
    expect(artifacts.filter((artifact) => (
      artifact.metadata.manifestDigest === executionManifest.manifestDigest
    )).length).toBe(1 + 1 + plan.supportingArtifacts.length + 1 + 1);
    expect(artifacts.some((artifact) => (
      String(artifact.name).includes('过程产出')
    ))).toBe(true);
    const record = repository.listScenarioRunRecords('session-1')[0];
    expect(record?.manifestSnapshot.scenarioId).toBe(manifest.scenarioId);
    expect(record?.manifestDigest).toBe(executionManifest.manifestDigest);
    expect(record?.manifestSnapshot.workflow).toHaveLength(1);
    expect(record?.steps[0]?.artifactRefs).toHaveLength(1 + plan.supportingArtifacts.length + 1);
  });

  it('fails explicitly instead of silently dropping an output plan when no-workflow Agent selection is ambiguous', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const planned = withOutputPlan(resolved);
    const extraAgentId = 'user:agents/second';
    const candidate = {
      ...planned,
      workflow: [],
      agentIds: [...planned.agentIds, extraAgentId],
      definitionRevisions: { ...planned.definitionRevisions, [extraAgentId]: 1 },
      manifestDigest: '0'.repeat(64),
    };
    const manifest = {
      ...candidate,
      manifestDigest: digestResolvedManifestSnapshot(candidate),
    };
    const run = vi.fn();
    const prepareMcp = vi.fn();

    expect(hasExecutableScenarioWorkflow(manifest)).toBe(false);
    const preflight = preflightScenarioExecution(manifest);
    expect(preflight).toEqual({
      ok: false,
      code: 'scenario_output_agent_ambiguous',
    });
    if (preflight.ok) await prepareMcp();
    expect(prepareMcp).not.toHaveBeenCalled();
    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Generate the configured bundle.' }],
      requestId: 'workflow-plan-ambiguous-agent',
      manifest,
    });

    expect(response.status).toBe('error');
    expect(response.diagnostics[0]?.code).toBe('scenario_output_agent_ambiguous');
    expect(run).not.toHaveBeenCalled();
    expect(store.listArtifacts('session-1')).toEqual([]);
    expect(store.getMessages('session-1')).toEqual([]);
  });

  it('executes every real DAG step and persists its configured output bundle as reusable artifacts', async () => {
    const resolved = resolveManifest('builtin:scenarios/article-review');
    const authoredManifest = withOutputPlan(resolved);
    const fundingScope = 'Use ownerId=local and projectId=project-1 exactly; never infer or replace them.';
    const compilation = compileScenarioExecutionManifest(authoredManifest, {
      executionInstructions: [fundingScope],
    });
    expect(compilation.ok).toBe(true);
    if (!compilation.ok || !compilation.manifest) return;
    const manifest = compilation.manifest;
    const plan = manifest.output.plan!;
    const run = vi.fn().mockImplementation((request: { requestId: string; messages: ChatMessage[] }) => Promise.resolve(
      completedResult(request.messages.at(-1)?.content.includes('# Required output bundle')
        ? outputBundleText(plan)
        : `result:${request.requestId}`),
    ));
    const messages: ChatMessage[] = [{ role: 'user', content: 'Write a systematic review.' }];

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages,
      requestId: 'workflow-1',
      manifest,
    });

    expect(response.status).toBe('completed');
    expect(run).toHaveBeenCalledTimes(resolved.manifest.workflow.length);
    for (const [index, call] of run.mock.calls.entries()) {
      const step = resolved.manifest.workflow[index];
      expect(call[0]).toMatchObject({
        allowedTools: step?.toolIds,
        maxTurns: step?.maxTurns,
        fullAccess: resolved.manifest.fullAccess,
      });
      expect(call[0].skillPrompt).toContain(`metis-source:${step?.agentId}`);
      expect((call[0].messages as ChatMessage[]).at(-1)?.content)
        .toContain('satisfy every active Agent, Skill, and Metis.md instruction');
      expect(call[0].skillPrompt).toContain(fundingScope);
      for (const otherAgentId of resolved.manifest.agentIds.filter((id) => id !== step?.agentId)) {
        expect(call[0].skillPrompt).not.toContain(`metis-source:${otherAgentId}`);
      }
    }
    expect(repository.listScenarioRunRecords('session-1')).toHaveLength(1);
    const runRecord = repository.listScenarioRunRecords('session-1')[0];
    const finalStepId = runRecord?.executionOrder.at(-1);
    expect(runRecord?.status).toBe('completed');
    const persistedArtifacts = store.listArtifacts('session-1');
    // 每个成功步骤额外留 1 个「过程产出」生成物；最终步骤再产出 bundle
    // 生成物（primary + supporting + quality report）；轮次结束归档 1 个
    // 「最终成果」生成物。
    expect(persistedArtifacts).toHaveLength(
      resolved.manifest.workflow.length + 2 + plan.supportingArtifacts.length + 1,
    );
    expect(persistedArtifacts.every((artifact) => artifact.contentAvailable)).toBe(true);
    expect(runRecord?.steps.find((step) => step.stepId === finalStepId)?.artifactRefs)
      .toHaveLength(1 + plan.supportingArtifacts.length + 1);
    const primary = persistedArtifacts.find((artifact) => artifact.metadata.role === 'primary');
    expect(primary?.name).toContain(plan.primaryDeliverable.slice(0, 24));
    expect(store.getArtifactContent(primary!.id, 'session-1')?.content)
      .toBe('# Complete primary deliverable\n\nEvidence-aware final content.');
    // 聊天流契约：首条用户消息 + 每步一条摘要指引 + 完成摘要（含最终成果
    // 生成物名）——最终交付物全文不再进入聊天记录。
    const persistedMessages = store.getMessages('session-1');
    expect(persistedMessages[0]).toEqual({ role: 'user', content: 'Write a systematic review.' });
    expect(persistedMessages.at(-1)?.role).toBe('assistant');
    expect(persistedMessages.at(-1)?.content).toContain('场景工作流已完成');
    expect(persistedMessages.at(-1)?.content).toContain('最终成果');
    expect(persistedMessages.at(-1)?.content).not.toBe(response.answer);
    const stepSummaries = persistedMessages.slice(1, -1);
    expect(stepSummaries).toHaveLength(resolved.manifest.workflow.length);
    expect(stepSummaries.every((message) => (
      message.role === 'assistant'
      && message.content.includes('已完成 ✓')
      && message.content.includes('产出：')
    ))).toBe(true);
    // 最终成果生成物内容与 answer 完全一致。
    const finalArtifact = persistedArtifacts.find((artifact) => artifact.metadata.role === 'final');
    expect(finalArtifact).toBeDefined();
    expect(store.getArtifactContent(finalArtifact!.id, 'session-1')?.content).toBe(response.answer);
    expect(response.answer).toBe('# Complete primary deliverable\n\nEvidence-aware final content.');
  });

  function sectionedBundleText(
    plan: NonNullable<ReturnType<typeof resolveManifest>['manifest']['output']['plan']>,
    primaryContent = '# Complete primary deliverable\n\nEvidence-aware final content.',
  ): string {
    return [
      '===METIS-PRIMARY===',
      primaryContent,
      ...plan.supportingArtifacts.flatMap((name, index) => [
        '',
        '===METIS-SUPPORTING===',
        `name: ${name}`,
        `# ${name}\n\nSupporting artifact ${index + 1}.`,
      ]),
      ...plan.qualityCriteria.flatMap((criterion) => [
        '',
        '===METIS-QUALITY===',
        `criterion: ${criterion}`,
        'status: met',
        `Verified against the generated deliverables: ${criterion}`,
      ]),
      '',
    ].join('\n');
  }

  it('accepts a sectioned final deliverable without model-written JSON (2026-08-30 wire-format fix)', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const manifest = withOutputPlan(resolved);
    const longPrimary = `# 综述定稿

${'劳动过程与平台治理的分析段落，含 "引号" 与 \\反斜杠\\ 等 JSON 敏感字符。'.repeat(300)}`;
    const run = vi.fn().mockResolvedValue(completedResult(sectionedBundleText(TEST_OUTPUT_PLAN, longPrimary)));

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Write the final deliverable.' }],
      requestId: 'workflow-sectioned-bundle',
      manifest,
    });

    // 分段线格式由代码组包并走原契约校验：正文原样保留（无 JSON 转义负担），
    // supporting 与 quality 交付物一件不少。
    expect(response.status).toBe('completed');
    expect(response.answer).toBe(longPrimary);
    const persistedArtifacts = store.listArtifacts('session-1');
    const primary = persistedArtifacts.find((artifact) => artifact.metadata.role === 'primary');
    expect(primary?.name).toContain(TEST_OUTPUT_PLAN.primaryDeliverable.slice(0, 24));
    expect(store.getArtifactContent(primary!.id, 'session-1')?.content).toBe(longPrimary);
    expect(persistedArtifacts.filter((artifact) => artifact.metadata.role === 'supporting'))
      .toHaveLength(TEST_OUTPUT_PLAN.supportingArtifacts.length);
    const persistedMessages = store.getMessages('session-1');
    expect(persistedMessages.at(-1)?.content).toContain('场景工作流已完成');
    expect(persistedMessages.at(-1)?.content).toContain('最终成果');
    expect(persistedMessages.at(-1)?.content).not.toContain('降级');
    const finalStep = repository.listScenarioRunRecords('session-1')[0]?.steps.at(-1);
    expect(finalStep?.artifactRefs).toHaveLength(1 + TEST_OUTPUT_PLAN.supportingArtifacts.length + 1);
  });

  it('repairs plan_mismatch through decode-correction attempts even when retryLimit is 0', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const manifest = withOutputPlan(resolved);
    const run = vi.fn()
      .mockResolvedValueOnce(completedResult('{"primary":{"name":"wrong"}}'))
      .mockResolvedValueOnce(completedResult(sectionedBundleText(TEST_OUTPUT_PLAN, '# Repaired result')));

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Write a systematic review.' }],
      requestId: 'workflow-decode-correction',
      manifest,
    });

    // 生产失败形态（retryLimit=0 + plan_mismatch）：机制上允许解码纠偏重试，
    // 第二次按分段格式交付即完成，不再整步判死。
    expect(response.status).toBe('completed');
    expect(response.answer).toBe('# Repaired result');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('recovers when the model answers the step criteria instead of the plan quality criteria (production failure 2026-08-31)', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const manifest = withOutputPlan(resolved);
    // 第一轮完全复刻生产失败：primary + 全部 supporting（编号标签）都齐了，
    // 但 quality 段错用了步骤自身的验收标准。
    const wrongCriteriaRound = [
      '===METIS-PRIMARY===',
      '# Complete primary deliverable',
      '',
      'Evidence-aware final content.',
      '',
      '===METIS-SUPPORTING===',
      'name: S1',
      '# Evidence table',
      '',
      '===METIS-SUPPORTING===',
      'name: S2',
      '# Source ledger',
      '',
      '===METIS-QUALITY===',
      'criterion: 每条审校意见均有对应的处理决定、修改位置和处理结果记录。',
      'status: met',
      '步骤级标准的证据，不属于计划清单。',
    ].join('\n');
    // 第二轮（纠偏）：只需补交缺失的 Q1/Q2 段，正文与 supporting 由合并保留。
    const correctionRound = [
      '===METIS-QUALITY===',
      'criterion: Q1',
      'status: met',
      'All claims trace to the evidence table.',
      '',
      '===METIS-QUALITY===',
      'criterion: Q2',
      'status: partially_met',
      'Parameters documented; lockfile pending.',
    ].join('\n');
    const run = vi.fn()
      .mockResolvedValueOnce(completedResult(wrongCriteriaRound))
      .mockResolvedValueOnce(completedResult(correctionRound));

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Write the final deliverable.' }],
      requestId: 'workflow-incremental-repair',
      manifest,
    });

    expect(response.status).toBe('completed');
    expect(response.answer).toContain('Evidence-aware final content.');
    expect(run).toHaveBeenCalledTimes(2);
    // 纠偏消息只列缺失段（编号标签形式），不要求整篇重发。
    const correctionMessage = (run.mock.calls[1]?.[0].messages as ChatMessage[]).at(-1)?.content ?? '';
    expect(correctionMessage).toContain('ONLY these missing sections');
    expect(correctionMessage).toContain('Q1');
    expect(correctionMessage).toContain('Q2');
    // 合并组包后仍走原契约校验：supporting 与 quality 条目一件不少。
    const finalStep = repository.listScenarioRunRecords('session-1')[0]?.steps.at(-1);
    expect(finalStep?.artifactRefs).toHaveLength(1 + TEST_OUTPUT_PLAN.supportingArtifacts.length + 1);
  });

  it('assembles the final bundle across paged deliveries with CONTINUED markers (16k output-cap fix)', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const manifest = withOutputPlan(resolved);
    // 第 1 页：正文上半 + S1；第 2 页：正文续写 + S2 + Q1/Q2。模拟模型输出
    // 上限装不下整包的真实形态（生产实证 maxOutputTokens=16,384 截断）。
    const page1 = [
      '===METIS-PRIMARY===',
      '# 综述定稿（上半）',
      '',
      '引言与方法部分。',
      '',
      '===METIS-SUPPORTING===',
      'name: S1',
      '# Evidence table',
    ].join('\n');
    const page2 = [
      '===METIS-PRIMARY-CONTINUED===',
      '',
      '主题综合与研究展望部分。',
      '',
      '===METIS-SUPPORTING===',
      'name: S2',
      '# Source ledger',
      '',
      '===METIS-QUALITY===',
      'criterion: Q1',
      'status: met',
      'Claims trace to the evidence table.',
      '',
      '===METIS-QUALITY===',
      'criterion: Q2',
      'status: met',
      'Methods documented.',
    ].join('\n');
    const run = vi.fn()
      .mockResolvedValueOnce(completedResult(page1))
      .mockResolvedValueOnce(completedResult(page2));

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Write the final deliverable.' }],
      requestId: 'workflow-paged-delivery',
      manifest,
    });

    expect(response.status).toBe('completed');
    // 跨页合并：正文 = 上半 + 续写下半（合并语义与契约层一致：单 \n 拼接，
    // 见 ScenarioOutputBundleContract.test.ts 的 CONTINUED 用例）。
    expect(response.answer).toBe('# 综述定稿（上半）\n\n引言与方法部分。\n主题综合与研究展望部分。');
    expect(run).toHaveBeenCalledTimes(2);
    // 第 2 页的续投消息：确认已收到的部分 + 引导 PRIMARY-CONTINUED 续写。
    const continuationMessage = (run.mock.calls[1]?.[0].messages as ChatMessage[]).at(-1)?.content ?? '';
    expect(continuationMessage).toContain('Received and kept');
    expect(continuationMessage).toContain('S1');
    expect(continuationMessage).toContain('METIS-PRIMARY-CONTINUED');
    expect(continuationMessage).toContain('Q1');
    const finalStep = repository.listScenarioRunRecords('session-1')[0]?.steps.at(-1);
    expect(finalStep?.artifactRefs).toHaveLength(1 + TEST_OUTPUT_PLAN.supportingArtifacts.length + 1);
  });

  it('injects the budgeted union of upstream outputs into the terminal plan step (chain starvation fix)', async () => {
    const resolved = resolveManifest('builtin:scenarios/article-review');
    const manifest = withOutputPlan(resolved);
    const run = vi.fn().mockImplementation((request: { requestId: string; messages: ChatMessage[] }) => Promise.resolve(
      completedResult(request.messages.at(-1)?.content.includes('# Required output bundle')
        ? outputBundleText(manifest.output.plan!)
        : `result-of-${request.requestId}`),
    ));

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Write a systematic review.' }],
      requestId: 'workflow-upstream-injection',
      manifest,
    });

    expect(response.status).toBe('completed');
    // 终末计划步骤收到的最后一条消息里，除直接前驱外还必须包含更早上游
    // 步骤的产出（链式饥饿修复）；小体量夹具不触发预算裁剪。
    const finalCall = run.mock.calls.at(-1)?.[0];
    const finalMessage = (finalCall?.messages as ChatMessage[]).at(-1)?.content ?? '';
    const upstreamStepIds = resolved.manifest.workflow
      .map((step) => step.id)
      .filter((id) => id !== resolved.manifest.workflow.at(-1)?.id);
    const covered = upstreamStepIds.filter((id) => finalMessage.includes(`"${id}"`));
    expect(covered.length).toBeGreaterThanOrEqual(Math.max(1, upstreamStepIds.length - 1));
    expect(finalMessage).not.toContain('_omittedUpstream');
  });

  it('persists per-step process artifacts but no output bundle when the final output bundle is malformed', async () => {
    const resolved = resolveManifest('builtin:scenarios/article-review');
    const manifest = withOutputPlan(resolved);
    expect(manifest.output.plan).toEqual(TEST_OUTPUT_PLAN);
    const run = vi.fn().mockResolvedValue(completedResult('{"primary":{"name":"wrong"}}'));

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Write a systematic review.' }],
      requestId: 'workflow-invalid-bundle',
      manifest,
    });

    expect(response.status).toBe('error');
    expect(response.answer).toBe('');
    // 非最终步骤照常完成并各自留下一个「过程产出」生成物与一条摘要消息
    //（每写完一步就保存）；最终 bundle 因畸形不落库；轮次失败时额外落一条
    // 诚实状态摘要（已完成 N/M 步），不再只活在渲染层内存里。
    const leftoverArtifacts = store.listArtifacts('session-1');
    expect(leftoverArtifacts).toHaveLength(resolved.manifest.workflow.length - 1);
    expect(leftoverArtifacts.every((artifact) => artifact.metadata.kind === 'scenario_process')).toBe(true);
    const persistedMessages = store.getMessages('session-1');
    expect(persistedMessages[0]).toEqual({ role: 'user', content: 'Write a systematic review.' });
    expect(persistedMessages.at(-1)?.content).toContain('场景工作流执行失败');
    const stepSummaries = persistedMessages.slice(1, -1);
    expect(stepSummaries).toHaveLength(resolved.manifest.workflow.length - 1);
    expect(stepSummaries.every((message) => (
      message.role === 'assistant' && message.content.includes('已完成 ✓')
    ))).toBe(true);
    expect(repository.listScenarioRunRecords('session-1')[0]?.status).toBe('failed');
  });

  it('uses the configured retry limit to repair a malformed output bundle before persisting it', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const baseManifest = withOutputPlan(resolved);
    const workflow = baseManifest.workflow.map((step) => ({ ...step, retryLimit: 1 }));
    const candidate = { ...baseManifest, workflow, manifestDigest: '0'.repeat(64) };
    const manifest = {
      ...candidate,
      manifestDigest: digestResolvedManifestSnapshot(candidate),
    };
    const run = vi.fn()
      .mockResolvedValueOnce(completedResult('{"primary":{"name":"wrong"}}'))
      .mockResolvedValueOnce(completedResult(outputBundleText(TEST_OUTPUT_PLAN, '# Repaired result')));

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Generate the configured bundle.' }],
      requestId: 'workflow-repair-bundle',
      manifest,
    });

    expect(response.status).toBe('completed');
    expect(response.answer).toBe('# Repaired result');
    expect(run).toHaveBeenCalledTimes(2);
    const repairMessages = run.mock.calls[1]?.[0].messages as ChatMessage[];
    expect(repairMessages.at(-1)?.content).toContain('previous response failed');
    expect(store.listArtifacts('session-1')).toHaveLength(
      1 + 1 + TEST_OUTPUT_PLAN.supportingArtifacts.length + 1 + 1,
    );
  });

  it('rejects an output plan with multiple terminal workflow steps instead of choosing one arbitrarily', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const baseManifest = withOutputPlan(resolved);
    const baseStep = baseManifest.workflow[0]!;
    const workflow = [
      { ...baseStep, id: 'step-a', name: 'A', dependsOn: [] },
      { ...baseStep, id: 'step-c', name: 'C', dependsOn: ['step-a'] },
      { ...baseStep, id: 'step-b', name: 'B', dependsOn: [] },
    ];
    const candidate = { ...baseManifest, workflow, manifestDigest: '0'.repeat(64) };
    const manifest = {
      ...candidate,
      manifestDigest: digestResolvedManifestSnapshot(candidate),
    };
    const run = vi.fn();

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Run the interleaved DAG.' }],
      requestId: 'workflow-interleaved',
      manifest,
    });

    expect(response.status).toBe('error');
    expect(response.diagnostics[0]?.code).toBe('scenario_output_step_ambiguous');
    expect(run).not.toHaveBeenCalled();
    expect(store.getMessages('session-1')).toEqual([]);
    expect(store.listArtifacts('session-1')).toEqual([]);
  });

  it('uses the Agent model preference and retries only within the frozen step limit', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const workflow = resolved.manifest.workflow.map((step) => ({
      ...step,
      agentModelPreference: 'preferred-research-model',
      retryLimit: 1,
    }));
    const candidate = { ...resolved.manifest, workflow, manifestDigest: '0'.repeat(64) };
    const manifest = {
      ...candidate,
      manifestDigest: digestResolvedManifestSnapshot(candidate),
    };
    const defaultRun = vi.fn();
    const preferredRun = vi.fn()
      .mockResolvedValueOnce({
        ...completedResult(''),
        status: 'error' as const,
        finalText: '',
        finalVerified: false,
      })
      .mockResolvedValueOnce(completedResult('preferred model result'));
    const agentLoopForModel = vi.fn().mockReturnValue({ run: preferredRun });

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run: defaultRun },
      agentLoopForModel,
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Use the preferred model.' }],
      requestId: 'workflow-model',
      manifest,
    });

    expect(response.status).toBe('completed');
    expect(response.answer).toBe('preferred model result');
    expect(agentLoopForModel).toHaveBeenCalledWith('preferred-research-model');
    expect(preferredRun).toHaveBeenCalledTimes(2);
    expect(defaultRun).not.toHaveBeenCalled();
    // requestId 统一计数（2026-08-31 分页交付循环）：交付页与执行重试共用
    // 一个序号，p1=首次执行，p2=执行失败后的重试。
    expect(preferredRun.mock.calls.map((call) => call[0].requestId)).toEqual([
      'workflow-model-research-p1',
      'workflow-model-research-p2',
    ]);
  });

  it('applies the configured memory scope to later workflow runs', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const run = vi.fn()
      .mockResolvedValueOnce(completedResult('durable prior decision'))
      .mockResolvedValueOnce(completedResult('new decision'));

    const first = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Establish the first decision.' }],
      requestId: 'workflow-memory-one',
      manifest: resolved.manifest,
    });
    expect(first.status).toBe('completed');

    const second = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Continue from prior work.' }],
      requestId: 'workflow-memory-two',
      manifest: resolved.manifest,
    });
    expect(second.status).toBe('completed');
    const secondStepMessages = run.mock.calls[1]?.[0].messages as ChatMessage[];
    expect(secondStepMessages.at(-1)?.content).toContain('# Prior scenario memory');
    expect(secondStepMessages.at(-1)?.content).toContain('durable prior decision');
  });

  it('persists an interrupted record and resumes it with stable execution keys', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn().mockResolvedValue(completedResult('resumed output'));

    const interrupted = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Research this question.' }],
      requestId: 'workflow-interrupt',
      manifest: resolved.manifest,
      signal: controller.signal,
    });
    expect(interrupted.status).toBe('interrupted');
    expect(repository.getRecoverableScenarioRun('session-1')?.status).toBe('interrupted');
    expect(run).not.toHaveBeenCalled();

    const resumed = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Research this question.' }],
      requestId: 'workflow-resume',
      manifest: resolved.manifest,
      mode: 'regenerate',
    });
    expect(resumed.status).toBe('completed');
    expect(run).toHaveBeenCalledTimes(1);
    expect(repository.getRecoverableScenarioRun('session-1')).toBeUndefined();
  });

  it('fails closed without an assistant message when a step is not verified', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const run = vi.fn().mockResolvedValue({ ...completedResult('unsafe partial'), finalVerified: false });

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Research this question.' }],
      requestId: 'workflow-failure',
      manifest: resolved.manifest,
    });

    expect(response.status).toBe('error');
    expect(response.answer).toBe('');
    // 步骤未验证通过 → 轮次失败：不落任何产出全文，但必须落一条诚实状态
    // 摘要（0/1 步），不再让失败轮在聊天里无痕消失。
    const failureMessages = store.getMessages('session-1');
    expect(failureMessages).toHaveLength(2);
    expect(failureMessages[0]).toEqual({ role: 'user', content: 'Research this question.' });
    expect(failureMessages[1]?.role).toBe('assistant');
    expect(failureMessages[1]?.content).toContain('场景工作流执行失败');
        // 0 步完成时不再出现误导性的「从断点继续」语义。
    expect(failureMessages[1]?.content).toContain('尚未完成任何步骤');
    expect(repository.listScenarioRunRecords('session-1')[0]?.status).toBe('failed');
  });

  it('trims oversized upstream payloads to the context budget with an explicit note (128k-window fix)', async () => {
    const resolved = resolveManifest('builtin:scenarios/article-review');
    const manifest = withOutputPlan(resolved);
    // 每个上游步骤产出 30k 字符：合计超过 70k 载荷预算，复现 2026-08-31
    // 生产事故的量级（100k 注入 + 13k 上一轮产出超出 128k 上下文窗口）。
    const run = vi.fn().mockImplementation((request: { requestId: string; messages: ChatMessage[] }) => Promise.resolve(
      completedResult(request.messages.at(-1)?.content.includes('# Required output bundle')
        ? outputBundleText(manifest.output.plan!)
        : `${request.requestId} ${'x'.repeat(30_000)}`),
    ));

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Write a systematic review.' }],
      requestId: 'workflow-context-budget',
      manifest,
    });

    expect(response.status).toBe('completed');
    const finalCall = run.mock.calls.at(-1)?.[0];
    const finalMessage = (finalCall?.messages as ChatMessage[]).at(-1)?.content ?? '';
    // 装不下的上游产出必须显式列名（不静默丢弃），且整条提示词被预算封顶。
    // 注意：最早的上游步骤可能已在协调器层列入 _omittedUpstream（格式不同），
    // 这里只断言服务层裁剪清单存在且带字符数标注。
    expect(finalMessage).toContain('_trimmedForContext');
    const trimmedLine = finalMessage.split('\n').find((line) => line.includes('_trimmedForContext')) ?? '';
    expect(trimmedLine).toMatch(/\(\d+ chars\)/u);
    expect(finalMessage.length).toBeLessThan(100_000);
  });

  it('surfaces the provider error text when a step fails (no-silent-failure rule)', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const run = vi.fn().mockResolvedValue({
      ...completedResult(''),
      status: 'error' as const,
      finalText: '',
      finalVerified: false,
      errors: ['Provider error 400: context length exceeded - prompt too long'],
    });

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Research this question.' }],
      requestId: 'workflow-error-surfacing',
      manifest: resolved.manifest,
    });

    expect(response.status).toBe('error');
    // provider 底层错误文本必须一路透到步骤失败记录，不再只剩笼统文案。
    const step = repository.listScenarioRunRecords('session-1')[0]?.steps.at(-1);
    expect(step?.errorMessage).toContain('Provider error 400');
    expect(step?.errorMessage).toContain('context length exceeded');
  });
});

describe('scenario artifact research mirror (研究成果页双写)', () => {
  function seedResearchProject(repo: ResearchRepository): void {
    repo.createProject({
      id: 'project-1',
      title: 'Mirror Project',
      originalIntent: '',
      researchQuestion: '',
      lifecycle: 'active',
      methodology: '',
      discipline: '',
      metadata: {},
      createdAt: 1000,
      updatedAt: 1000,
      archivedAt: null,
      version: 1,
      source: 'user',
      deletedAt: null,
    } as never);
  }

  it('mirrors bundle, process and final artifacts into research_artifacts with content, idempotently', async () => {
    const research = new ResearchRepository(store.raw);
    seedResearchProject(research);
    const resolved = resolveManifest('builtin:scenarios/article-review');
    const authoredManifest = withOutputPlan(resolved);
    const compilation = compileScenarioExecutionManifest(authoredManifest, {
      executionInstructions: ['Use ownerId=local and projectId=project-1 exactly.'],
    });
    expect(compilation.ok).toBe(true);
    if (!compilation.ok || !compilation.manifest) return;
    const manifest = compilation.manifest;
    const plan = manifest.output.plan!;
    const primaryContent = '# Mirrored primary deliverable\n\nUnique marker: research-mirror-001.';
    const run = vi.fn().mockImplementation((request: { requestId: string; messages: ChatMessage[] }) => Promise.resolve(
      completedResult(request.messages.at(-1)?.content.includes('# Required output bundle')
        ? outputBundleText(plan, primaryContent)
        : `process output for ${request.requestId}`),
    ));

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Write a systematic review.' }],
      requestId: 'workflow-research-mirror',
      manifest,
      projectId: 'project-1',
      researchRepository: research,
    });

    expect(response.status).toBe('completed');
    const rows = research.listArtifacts('project-1');
    // bundle(1 primary + 2 supporting + 1 quality) + 每个 DAG 步骤 1 条过程产物 + 1 条整轮归档。
    expect(rows).toHaveLength(4 + manifest.workflow.length + 1);
    expect(rows.every((row) => row.id.startsWith('ra-scenario-artifact-'))).toBe(true);

    // 质量报告标题也含 primary 名（"… quality report"），须排除后才能锁定 primary 本体。
    const primary = rows.find((row) => row.title.includes(plan.primaryDeliverable) && !row.title.includes('quality report'));
    expect(primary?.artifactType).toBe('manuscript');
    // supporting 名称命中表类关键词 → table；质量报告 → report。
    expect(rows.find((row) => row.title.includes('Evidence table'))?.artifactType).toBe('table');
    expect(rows.find((row) => row.title.includes('Source ledger'))?.artifactType).toBe('table');
    expect(rows.find((row) => row.title.includes('quality report'))?.artifactType).toBe('report');
    const processRows = rows.filter((row) => row.title.includes('过程产出'));
    expect(processRows).toHaveLength(manifest.workflow.length);
    expect(processRows.every((row) => row.artifactType === 'report')).toBe(true);
    expect(rows.find((row) => row.title.includes('最终成果'))?.artifactType).toBe('manuscript');

    // 内容体必须进 artifact_versions，成果页才可展开查看。
    const primaryVersions = research.listArtifactVersions(primary!.id);
    expect(primaryVersions).toHaveLength(1);
    expect(primaryVersions[0]?.content).toContain('research-mirror-001');

    // 幂等：同 id 再写不重复建行，版本自增（修订轮重放的存储语义）。
    research.saveArtifactVersion({
      id: primary!.id,
      projectId: 'project-1',
      title: primary!.title,
      artifactType: 'manuscript',
      reviewStatus: 'draft',
      inputs: [],
      generatedBy: { capabilityId: 'scenario-workflow', method: 'scenario:test#rerun' },
      citedSourceIds: [],
      renderer: { kind: 'markdown' },
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, `${primaryContent}\n\nRevised.`);
    expect(research.listArtifacts('project-1')).toHaveLength(4 + manifest.workflow.length + 1);
    const afterRewrite = research.listArtifactVersions(primary!.id);
    expect(afterRewrite).toHaveLength(2);
    expect(afterRewrite[0]?.version).toBe(2);
    expect(afterRewrite[0]?.content).toContain('Revised.');
  });

  it('skips the mirror cleanly when no research repository or project is bound', async () => {
    const research = new ResearchRepository(store.raw);
    seedResearchProject(research);
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const run = vi.fn().mockResolvedValue(completedResult('plain step output'));

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Research this question.' }],
      requestId: 'workflow-no-mirror',
      manifest: resolved.manifest,
      // 不传 projectId / researchRepository：镜像静默跳过，运行不受影响。
    });

    expect(response.status).toBe('completed');
    expect(research.listArtifacts('project-1')).toEqual([]);
    expect(store.listArtifacts('session-1').length).toBeGreaterThan(0);
  });

  it('invokes the literature bridge for every persisted artifact when bound (文献入库桥接线)', async () => {
    const resolved = resolveManifest('builtin:scenarios/general-research');
    const run = vi.fn().mockResolvedValue(completedResult('step text without json'));
    const bridge = vi.fn().mockResolvedValue({ parsed: 0 });

    const response = await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Research this question.' }],
      requestId: 'workflow-literature-bridge',
      manifest: resolved.manifest,
      projectId: 'project-1',
      literatureBridge: bridge,
    });

    expect(response.status).toBe('completed');
    // 过程产物 + 整轮归档各触发一次；桥内容自闸门（无 JSON 即零成本返回）。
    expect(bridge).toHaveBeenCalledTimes(2);
    for (const call of bridge.mock.calls) {
      expect(call[0]).toMatchObject({ projectId: 'project-1', runId: 'scenario-workflow-literature-bridge' });
      expect(typeof call[0].artifactId).toBe('string');
      expect(typeof call[0].content).toBe('string');
    }
  });
});

describe('scenario step cards (2026-09-01 刘总方案一期：过程可见)', () => {
  it('extractStepBrief pulls and strips the report block without polluting the artifact text', () => {
    const output = [
      '# 正文标题',
      '',
      '正文内容，真正的交付物段落。',
      '',
      '<step_brief>',
      '思路：先按近5年核心期刊筛选，因为时效性优先',
      '结果：42篇筛到17篇，剔除了会议摘要',
      '下一步：下一步对17篇做主题聚类',
      '</step_brief>',
    ].join('\n');
    const { text, brief } = extractStepBrief(output);
    expect(text).not.toContain('<step_brief>');
    expect(text).toContain('正文内容');
    expect(brief).toEqual({
      approach: '先按近5年核心期刊筛选，因为时效性优先',
      result: '42篇筛到17篇，剔除了会议摘要',
      next: '下一步对17篇做主题聚类',
    });
  });

  it('extractStepBrief returns null for plain output instead of fabricating a summary', () => {
    const plain = '# 纯输出\n\n没有汇报块。';
    const { text, brief } = extractStepBrief(plain);
    expect(text).toBe(plain);
    expect(brief).toBeNull();
  });

  it('persists a step card message with brief, artifact pointer and control payload', async () => {
    const resolved = resolveManifest('builtin:scenarios/article-review');
    const run = vi.fn().mockImplementation(() => Promise.resolve(
      completedResult(`${'步骤产出内容。'.repeat(5)}

<step_brief>
思路：测试思路
结果：测试结果
下一步：测试下一步
</step_brief>`),
    ));
    await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Research this question.' }],
      requestId: 'workflow-step-cards',
      manifest: resolved.manifest,
    });
    // T3 协议（2026-09-08）：卡片结构进 metadata.stepCard；正文是人话摘要，
    // 不再有 metis-step-card 围栏 JSON。
    const messages = store.getMessages('session-1', undefined, { includeMetadata: true })
      .filter((message) => (
        message.role === 'assistant'
        && (message.metadata?.stepCard as { status?: string } | undefined)?.status === 'completed'
      ));
    expect(messages.length).toBeGreaterThan(0);
    const cardMessage = messages[messages.length - 1]!;
    expect(cardMessage.content).toContain('已完成 ✓');
    expect(cardMessage.content).toContain('测试思路');
    expect(cardMessage.content).toContain('测试结果');
    expect(cardMessage.content).not.toContain('metis-step-card');
    expect(cardMessage.content).not.toContain('思路：');
    const payload = cardMessage.metadata!.stepCard as {
      sessionId: string; stepId: string; status: string; brief: { approach: string } | null;
    };
    expect(payload.sessionId).toBe('session-1');
    expect(payload.status).toBe('completed');
    expect(payload.brief?.approach).toBe('测试思路');
    // 剥离后的过程产物正文不再包含汇报块
    const processArtifacts = store.listArtifacts('session-1').filter((artifact) => (
      artifact.metadata.kind === 'scenario_process' && artifact.contentAvailable
    ));
    expect(processArtifacts.length).toBeGreaterThan(0);
    // 剥离后的过程产物正文包含主输出、不包含汇报块
    const contents = processArtifacts.map((artifact) => (
      store.getArtifactContent(artifact.id, 'session-1')?.content ?? ''
    )).filter((content) => content.includes('步骤产出内容'));
    expect(contents.length).toBeGreaterThan(0);
    expect(contents.every((content) => !content.includes('<step_brief>'))).toBe(true);
  });
});

describe('scenario step control (2026-09-01 刘总方案二期：可介入)', () => {
  async function runToCompletion(): Promise<void> {
    const resolved = resolveManifest('builtin:scenarios/article-review');
    const run = vi.fn().mockImplementation((request: { requestId: string; messages: ChatMessage[] }) => Promise.resolve(
      completedResult(`result:${request.requestId}`),
    ));
    await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'Run the review workflow.' }],
      requestId: 'workflow-step-control-base',
      manifest: resolved.manifest,
    });
  }

  it('derives a resumable branch with a directive from a completed run, and resume injects it', async () => {
    await runToCompletion();
    const original = repository.listScenarioRunRecords('session-1')[0];
    expect(original?.status).toBe('completed');
    const targetStepId = original!.executionOrder[0]!;

    const redo = applyStepControl(original!, { action: 'redo', stepId: targetStepId, guidance: '把定量研究也纳入' });
    expect(redo.ok).toBe(true);
    if (!redo.ok) return;
    expect(redo.record.runId).not.toBe(original!.runId);
    expect(redo.record.status).toBe('interrupted');
    expect(redo.record.pendingDirectives?.[0]).toMatchObject({ stepId: targetStepId, guidance: '把定量研究也纳入', consumedAt: null });
    const targetIdx = redo.record.executionOrder.indexOf(targetStepId);
    const downstream = new Set(redo.record.executionOrder.slice(targetIdx));
    expect(redo.record.steps.filter((step) => downstream.has(step.stepId)).every((step) => step.status === 'pending')).toBe(true);
    // completed 记录是防篡改不可变终态：原记录对象未被就地修改
    expect(original!.status).toBe('completed');

    // 分支落库（新 runId 新行），恢复选择必须选中它
    repository.saveScenarioRunRecord(redo.record);
    expect(repository.getRecoverableScenarioRun('session-1')?.runId).toBe(redo.record.runId);

    // 补发「继续」→ 恢复运行，executor 消费指导：提示词带 DIRECTIVE，产物不带汇报块
    const run = vi.fn().mockImplementation((request: { requestId: string; messages: ChatMessage[] }) => Promise.resolve(
      completedResult(`重跑产出:${request.requestId}

<step_brief>
思路：按指导执行
结果：已重跑
下一步：继续下游
</step_brief>`),
    ));
    await runPersistedScenarioWorkflow({
      agentLoop: { run },
      store,
      repository,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: '继续' }],
      requestId: 'workflow-step-control-resume',
      manifest: original!.manifestSnapshot,
    });
    const directiveCalls = run.mock.calls.filter((call) => (
      JSON.stringify(call[0]?.messages).includes('DIRECTIVE FROM THE USER')
    ));
    expect(directiveCalls.length).toBe(1);
    expect(JSON.stringify(directiveCalls[0]?.[0]?.messages)).toContain('把定量研究也纳入');
  });

  it('skips a step in place on a recoverable record and the progression gate accepts it', async () => {
    await runToCompletion();
    const original = repository.listScenarioRunRecords('session-1')[0]!;
    const redo = applyStepControl(original, { action: 'redo', stepId: original.executionOrder[0]!, guidance: '第一轮重做' });
    expect(redo.ok).toBe(true);
    if (!redo.ok) return;
    repository.saveScenarioRunRecord(redo.record);
    const recoverable = repository.getRecoverableScenarioRun('session-1')!;

    const skip = applyStepControl(recoverable, { action: 'skip', stepId: recoverable.executionOrder[0]! });
    expect(skip.ok).toBe(true);
    if (!skip.ok) return;
    expect(skip.record.steps.find((step) => step.stepId === recoverable.executionOrder[0])?.status).toBe('skipped');
    expect(skip.record.backtrackCount).toBe(recoverable.backtrackCount + 1);
    // 进度断言放行（backtrack 授权的 pending 重置 + 终态→skipped），落库不抛
    repository.saveScenarioRunRecord(skip.record);
    expect(repository.getRecoverableScenarioRun('session-1')?.runId).toBe(skip.record.runId);
  });

  it('rejects control on running records, unknown steps and repeated skips', async () => {
    await runToCompletion();
    const original = repository.listScenarioRunRecords('session-1')[0]!;
    expect(applyStepControl({ ...original, status: 'running' }, { action: 'redo', stepId: original.executionOrder[0]!, guidance: 'x' }).ok).toBe(false);
    expect(applyStepControl(original, { action: 'redo', stepId: 'no-such-step' }).ok).toBe(false);
    const skip = applyStepControl(original, { action: 'skip', stepId: original.executionOrder[0]! });
    expect(skip.ok).toBe(true);
    if (!skip.ok) return;
    expect(applyStepControl(skip.record, { action: 'skip', stepId: original.executionOrder[0]! }).ok).toBe(false);
  });
});
