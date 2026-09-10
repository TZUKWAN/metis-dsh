/**
 * O14 — 工作流/目标 checkpoint 恢复。
 *
 * 验证：
 *   1. 一步失败后，以失败 run 为 checkpoint 再执行：已完成步骤被跳过
 *      （不重复调用 agent），从失败点续跑直至 completed。
 *   2. 无 checkpoint 时从 0 开始，所有步骤都执行。
 *   3. resumeFromCheckpoint 标志真实透传到每个步骤的 AgentRunRequest。
 *   4. resume() 跳过已完成步骤并清空上一轮错误（恢复成功应为 completed）。
 *   5. GoalEngine.executeGoal(resumeFromCheckpoint) 用持久化 run 作 checkpoint。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  WorkflowEngine,
  findCheckpointResumeStep,
  hasResumableCheckpoint,
} from '../../engine/workflow/WorkflowEngine.js';
import type { WorkflowDefinition, WorkflowRun, WorkflowProjectRulesSnapshot } from '../../engine/workflow/types.js';
import type { AgentRunRequest, AgentRunResult, ChatMessage, ToolEffectSnapshot } from '../../engine/core/types.js';
import { createToolEffectKey } from '../../engine/core/types.js';
import type { AgentLoop } from '../../engine/core/AgentLoop.js';
import { GoalEngine } from '../../engine/goal/GoalEngine.js';

// ─── Fixtures ─────────────────────────────────────────────────

function makeWorkflow(): WorkflowDefinition {
  return {
    id: 'wf_ckpt',
    name: 'Checkpoint test',
    description: '',
    version: '1.0',
    steps: [
      { id: 'a', name: 'A', description: '', prompt: 'Do A', inputFrom: [], tools: [], maxTurns: 3 },
      { id: 'b', name: 'B', description: '', prompt: 'Do B with {{a.output}}', inputFrom: ['a'], tools: [], maxTurns: 3 },
      { id: 'c', name: 'C', description: '', prompt: 'Do C with {{b.output}}', inputFrom: ['b'], tools: [], maxTurns: 3 },
    ],
    dependencies: { a: [], b: ['a'], c: ['b'] },
  };
}

function okResult(text: string): AgentRunResult {
  return {
    status: 'completed',
    finalText: text,
    finalVerified: true,
    messages: [{ role: 'assistant', content: text }],
    turnsUsed: 1,
    toolResults: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    errors: [],
    traceEvents: [],
  };
}

function failResult(): AgentRunResult {
  return {
    status: 'error',
    finalText: '',
    finalVerified: false,
    messages: [],
    turnsUsed: 1,
    toolResults: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    errors: ['boom'],
    traceEvents: [],
  };
}

interface ScriptedAgent {
  agent: AgentLoop;
  requests: AgentRunRequest[];
  /** 让某步骤开始成功（模拟修复后重跑）。 */
  heal: (stepId: string) => void;
}

/** 脚本化 agent：failSteps 中的步骤返回失败，其余成功；记录每个请求。 */
function makeScriptedAgent(failSteps: string[] = []): ScriptedAgent {
  const failing = new Set(failSteps);
  const requests: AgentRunRequest[] = [];
  const agent = {
    run: vi.fn(async (req: AgentRunRequest) => {
      requests.push(req);
      const stepId = req.sessionId.replace('wf-step-', '');
      if (failing.has(stepId)) return failResult();
      return okResult(`${stepId}-output`);
    }),
  } as unknown as AgentLoop;
  return { agent, requests, heal: (stepId) => failing.delete(stepId) };
}

// ─── WorkflowEngine checkpoint 恢复 ───────────────────────────

describe('WorkflowEngine checkpoint resume (O14)', () => {
  it('一步失败后以 checkpoint 续跑：已完成步骤跳过，从失败点继续', async () => {
    const workflow = makeWorkflow();
    const first = makeScriptedAgent(['b']);
    const engine = new WorkflowEngine(first.agent);

    // 第一次执行：a 完成，b 失败，c 因依赖未完成被跳过
    const failedRun = await engine.run(workflow);
    expect(failedRun.status).toBe('failed');
    expect(failedRun.stepResults.a?.status).toBe('completed');
    expect(failedRun.stepResults.b?.status).toBe('failed');
    expect(failedRun.stepResults.c?.status).toBe('skipped');
    expect(first.requests.map((r) => r.sessionId)).toEqual(['wf-step-a', 'wf-step-b']);
    // 默认不开启 checkpoint 恢复
    expect(first.requests.every((r) => r.resumeFromCheckpoint === false)).toBe(true);

    // 修复 b 后以失败 run 为 checkpoint 续跑
    const second = makeScriptedAgent();
    const engine2 = new WorkflowEngine(second.agent);
    const resumed = await engine2.run(workflow, {}, undefined, undefined, {
      resumeFromCheckpoint: true,
      checkpointRun: failedRun,
    });

    // a 被跳过（agent 未被调用），b/c 从失败点续跑
    expect(second.requests.map((r) => r.sessionId)).toEqual(['wf-step-b', 'wf-step-c']);
    // resumeFromCheckpoint 标志真实透传
    expect(second.requests.every((r) => r.resumeFromCheckpoint === true)).toBe(true);
    // a 的结果（含输出）从 checkpoint 搬入，供下游引用
    expect(resumed.stepResults.a?.status).toBe('completed');
    expect(resumed.stepResults.a?.output).toBe('a-output');
    expect(resumed.stepResults.b?.status).toBe('completed');
    expect(resumed.stepResults.c?.status).toBe('completed');
    expect(resumed.status).toBe('completed');
  });

  it('无 checkpoint 时从 0 开始：所有步骤都执行', async () => {
    const workflow = makeWorkflow();
    const scripted = makeScriptedAgent();
    const engine = new WorkflowEngine(scripted.agent);

    const run = await engine.run(workflow, {}, undefined, undefined, { resumeFromCheckpoint: true });

    expect(scripted.requests.map((r) => r.sessionId)).toEqual(['wf-step-a', 'wf-step-b', 'wf-step-c']);
    expect(run.status).toBe('completed');
  });

  it('resume() 跳过已完成步骤并清空旧错误，恢复成功状态为 completed', async () => {
    const workflow = makeWorkflow();
    const first = makeScriptedAgent(['b']);
    const failedRun = await new WorkflowEngine(first.agent).run(workflow);
    expect(failedRun.errors.length).toBeGreaterThan(0);

    const resumeFrom = findCheckpointResumeStep(workflow, failedRun);
    expect(resumeFrom).toBe('b');

    const second = makeScriptedAgent();
    const resumed = await new WorkflowEngine(second.agent).resume(workflow, failedRun, 'b');
    expect(second.requests.map((r) => r.sessionId)).toEqual(['wf-step-b', 'wf-step-c']);
    // resume 默认按 checkpoint 恢复语义透传标志
    expect(second.requests.every((r) => r.resumeFromCheckpoint === true)).toBe(true);
    expect(resumed.status).toBe('completed');
    expect(resumed.errors).toEqual([]);
  });

  it('findCheckpointResumeStep / hasResumableCheckpoint 边界', () => {
    const workflow = makeWorkflow();
    const emptyRun = { stepResults: {} } as unknown as WorkflowRun;
    expect(findCheckpointResumeStep(workflow, emptyRun)).toBe('a');
    expect(hasResumableCheckpoint(workflow, emptyRun)).toBe(false);
    expect(hasResumableCheckpoint(workflow, null)).toBe(false);

    const allDone = {
      stepResults: {
        a: { status: 'completed' },
        b: { status: 'completed' },
        c: { status: 'completed' },
      },
    } as unknown as WorkflowRun;
    expect(findCheckpointResumeStep(workflow, allDone)).toBeNull();
    expect(hasResumableCheckpoint(workflow, allDone)).toBe(false);
  });

  it('checkpoints a successful tool effect immediately and supplies it to the resumed Step', async () => {
    const workflow = makeWorkflow();
    let firstAttempt = true;
    const replayedEffectKeys: string[][] = [];
    const resumedMessages: ChatMessage[][] = [];
    const agent = {
      run: vi.fn(async (request: AgentRunRequest) => {
        const stepId = request.sessionId.replace('wf-step-', '');
        if (stepId === 'a' && firstAttempt) {
          firstAttempt = false;
          const scope = request.toolEffectScope!;
          const effect: ToolEffectSnapshot = {
            idempotencyKey: createToolEffectKey(scope, 'write_file', { path: 'result.md', content: 'draft' }),
            scope,
            toolName: 'write_file',
            arguments: { path: 'result.md', content: 'draft' },
            result: {
              toolName: 'write_file',
              toolCallId: 'first_write',
              status: 'ok',
              content: 'wrote result.md',
              metadata: { artifactId: 'artifact-result' },
            },
            completedAt: Date.now(),
          };
          await request.onToolEffect?.(effect);
          return {
            ...failResult(),
            messages: [
              { role: 'user', content: '早期研究问题：请保留核心假设与证据链。' },
              {
                role: 'system',
                content: '已压缩：核心假设成立，下一步核验样本。',
                metadata: {
                  contextCompressionSummary: true,
                  sourceFirstMessageIndex: 0,
                  sourceLastMessageIndex: 4,
                  summarizedCount: 5,
                },
              },
            ],
          };
        }
        replayedEffectKeys.push((request.replayToolEffects ?? []).map((effect) => effect.idempotencyKey));
        if (stepId === 'a') resumedMessages.push(request.messages);
        return okResult(`${stepId}-output`);
      }),
    } as unknown as AgentLoop;
    const engine = new WorkflowEngine(agent);

    const failed = await engine.run(workflow);
    expect(failed.status).toBe('failed');
    expect(failed.stepResults.a?.toolEffects).toHaveLength(1);
    expect(failed.checkpoint?.toolEffectKeys).toHaveLength(1);
    expect(failed.checkpoint?.artifactIds).toEqual(['artifact-result']);
    expect(failed.checkpoint?.pendingStepIds).toContain('a');
    expect(failed.checkpoint?.recoveryStrategy).toBe('retry_current_step');

    const resumed = await engine.resume(workflow, failed, 'a');
    expect(resumed.status).toBe('completed');
    expect(replayedEffectKeys[0]).toEqual(failed.checkpoint?.toolEffectKeys);
    const checkpointMessage = resumedMessages[0]?.find((message) => message.metadata?.goalCheckpoint === true);
    expect(checkpointMessage?.content).toContain('早期研究问题');
    expect(checkpointMessage?.content).toContain('已压缩：核心假设成立');
    expect(checkpointMessage?.content).toContain('artifact-result');
    expect(resumed.checkpoint?.completedStepIds).toEqual(['a', 'b', 'c']);
  });

  it('freezes project Metis.md across a failed Step and later resume', async () => {
    const workflow = makeWorkflow();
    const requests: AgentRunRequest[] = [];
    let failFirstStep = true;
    const frozenRules: WorkflowProjectRulesSnapshot = {
      projectId: 'project-rules-test',
      version: 4,
      contentHash: 'frozen-rules-hash',
      markdown: '# Metis.md\n- 保留样本分层约束\n- 引用 artifact-context-001',
    };
    const editedRules: WorkflowProjectRulesSnapshot = {
      ...frozenRules,
      version: 5,
      contentHash: 'edited-rules-hash',
      markdown: '# Metis.md\n- 这是恢复后才编辑的新规则，不应进入旧运行',
    };
    const agent = {
      run: vi.fn(async (request: AgentRunRequest) => {
        requests.push(request);
        const stepId = request.sessionId.replace('wf-step-', '');
        if (stepId === 'a' && failFirstStep) {
          failFirstStep = false;
          return failResult();
        }
        return okResult(`${stepId}-output`);
      }),
    } as unknown as AgentLoop;
    const engine = new WorkflowEngine(agent);

    const failed = await engine.run(workflow, {}, undefined, undefined, {
      projectId: frozenRules.projectId,
      projectRules: frozenRules,
    });
    expect(failed.status).toBe('failed');
    expect(failed.projectRules).toEqual(frozenRules);
    expect(failed.checkpoint?.projectRules).toEqual({
      projectId: frozenRules.projectId,
      version: frozenRules.version,
      contentHash: frozenRules.contentHash,
    });
    expect(requests[0]?.messages[0]?.metadata?.projectMetis).toBe(true);
    expect(requests[0]?.messages[0]?.content).toContain('保留样本分层约束');

    const resumed = await engine.resume(workflow, failed, 'a', undefined, undefined, {
      projectRules: editedRules,
    });
    expect(resumed.status).toBe('completed');
    const resumedRuleMessages = requests.slice(1)
      .map((request) => request.messages.find((message) => message.metadata?.projectMetis === true));
    expect(resumedRuleMessages).toHaveLength(3);
    expect(resumedRuleMessages.every((message) => message?.content.includes('保留样本分层约束'))).toBe(true);
    expect(resumedRuleMessages.some((message) => message?.content.includes('恢复后才编辑'))).toBe(false);
    expect(resumed.projectRules).toEqual(frozenRules);
  });
});

// ─── GoalEngine checkpoint 恢复 ───────────────────────────────

function planJson(): string {
  return JSON.stringify(makeWorkflow());
}

describe('GoalEngine checkpoint resume (O14)', () => {
  it('executeGoal(resumeFromCheckpoint) 以持久化 run 为 checkpoint，跳过已完成步骤', async () => {
    const failing = new Set(['b']);
    const requests: AgentRunRequest[] = [];
    const agent = {
      run: vi.fn(async (req: AgentRunRequest) => {
        if (req.sessionId.startsWith('plan-')) return okResult(planJson());
        requests.push(req);
        const stepId = req.sessionId.replace('wf-step-', '');
        return failing.has(stepId) ? failResult() : okResult(`${stepId}-output`);
      }),
    } as unknown as AgentLoop;
    const engine = new GoalEngine(agent);

    const goal = engine.createGoal('断点恢复测试');
    await engine.generatePlan(goal.id);

    // 第一次执行：b 失败 → run 持久化为 failed
    const firstRun = await engine.executeGoal(goal.id);
    expect(firstRun.status).toBe('failed');
    expect(requests.map((r) => r.sessionId)).toEqual(['wf-step-a', 'wf-step-b']);

    // checkpoint 信息可用于 UI 展示
    const info = engine.getCheckpointInfo(goal.id);
    expect(info.hasCheckpoint).toBe(true);
    expect(info.resumable).toBe(true);
    expect(info.completedSteps).toBe(1);
    expect(info.totalSteps).toBe(3);

    // 修复 b，带 resumeFromCheckpoint 再执行：a 跳过，b/c 续跑
    failing.delete('b');
    const secondRun = await engine.executeGoal(goal.id, undefined, { resumeFromCheckpoint: true });
    expect(requests.map((r) => r.sessionId)).toEqual(['wf-step-a', 'wf-step-b', 'wf-step-b', 'wf-step-c']);
    const secondAttempt = requests.slice(2);
    expect(secondAttempt.every((r) => r.resumeFromCheckpoint === true)).toBe(true);
    expect(secondRun.status).toBe('completed');
    expect(secondRun.stepResults.a?.output).toBe('a-output');
  });

  it('resumeGoal 不指定步骤时从 checkpoint 推导恢复点', async () => {
    const failing = new Set(['b']);
    const requests: AgentRunRequest[] = [];
    const agent = {
      run: vi.fn(async (req: AgentRunRequest) => {
        if (req.sessionId.startsWith('plan-')) return okResult(planJson());
        requests.push(req);
        const stepId = req.sessionId.replace('wf-step-', '');
        return failing.has(stepId) ? failResult() : okResult(`${stepId}-output`);
      }),
    } as unknown as AgentLoop;
    const engine = new GoalEngine(agent);

    const goal = engine.createGoal('断点 resume 测试');
    await engine.generatePlan(goal.id);
    const firstRun = await engine.executeGoal(goal.id);
    expect(firstRun.status).toBe('failed');

    failing.delete('b');
    const resumed = await engine.resumeGoal(goal.id);
    // a 已完成被跳过；从失败点 b 续跑
    expect(requests.map((r) => r.sessionId)).toEqual(['wf-step-a', 'wf-step-b', 'wf-step-b', 'wf-step-c']);
    expect(resumed.status).toBe('completed');
  });

  it('无 checkpoint（无历史 run）时 executeGoal 从 0 开始', async () => {
    const requests: AgentRunRequest[] = [];
    const agent = {
      run: vi.fn(async (req: AgentRunRequest) => {
        if (req.sessionId.startsWith('plan-')) return okResult(planJson());
        requests.push(req);
        return okResult('ok');
      }),
    } as unknown as AgentLoop;
    const engine = new GoalEngine(agent);

    const goal = engine.createGoal('全新执行');
    await engine.generatePlan(goal.id);
    const run = await engine.executeGoal(goal.id, undefined, { resumeFromCheckpoint: true });

    expect(requests.map((r) => r.sessionId)).toEqual(['wf-step-a', 'wf-step-b', 'wf-step-c']);
    expect(requests.every((r) => r.resumeFromCheckpoint === true)).toBe(true);
    expect(run.status).toBe('completed');
  });
});

// ─── O7: step decision escalation (retry / skip / stop) ──────

describe('GoalEngine step decision (O7)', () => {
  /** Workflow with a retry-capable step so failures escalate to a decision. */
  function decisionWorkflow(): WorkflowDefinition {
    return {
      id: 'wf_decision',
      name: 'Decision test',
      description: '',
      version: '1.0',
      steps: [
        { id: 'a', name: 'A', description: '', prompt: 'Do A', inputFrom: [], tools: [], maxTurns: 3 },
        { id: 'b', name: 'B', description: '', prompt: 'Do B', inputFrom: ['a'], tools: [], maxTurns: 3, retry: { maxRetries: 3, onFailPrompt: 'Try again.' } },
        { id: 'c', name: 'C', description: '', prompt: 'Do C', inputFrom: ['b'], tools: [], maxTurns: 3 },
      ],
      dependencies: { a: [], b: ['a'], c: ['b'] },
    };
  }

  async function buildEngineWithFailingStep(failing: Set<string>) {
    const requests: AgentRunRequest[] = [];
    const agent = {
      run: vi.fn(async (req: AgentRunRequest) => {
        if (req.sessionId.startsWith('plan-')) return okResult(JSON.stringify(decisionWorkflow()));
        requests.push(req);
        const stepId = req.sessionId.replace('wf-step-', '');
        return failing.has(stepId) ? failResult() : okResult(`${stepId}-output`);
      }),
    } as unknown as AgentLoop;
    const engine = new GoalEngine(agent);
    const goal = engine.createGoal('O7 决策测试');
    await engine.generatePlan(goal.id);
    return { engine, goal, requests };
  }

  it('skip 将失败步骤标记 skipped 并从下一步续跑', async () => {
    // b 永远失败（且 retry 也失败），用 skip 跳过它。
    const { engine, goal, requests } = await buildEngineWithFailingStep(new Set(['b']));
    // 首次执行 b 失败并升级（连续失败达阈值后 paused + decisionRequired）。
    const first = await engine.executeGoal(goal.id);
    const bResult = Object.values(first.stepResults).find((r) => r.stepId === 'b');
    expect(bResult?.decisionRequired).toBe(true);
    expect(first.status).toBe('paused');

    const after = await engine.resolveStepDecision(goal.id, 'skip');
    expect(after.stepResults.b?.status).toBe('skipped');
    // b 之后是 c：c 成功 → completed。
    expect(after.status).toBe('completed');
    expect(requests.map((r) => r.sessionId)).toContain('wf-step-c');
  });

  it('stop 将目标置为 failed 并终止', async () => {
    const { engine, goal } = await buildEngineWithFailingStep(new Set(['b']));
    const first = await engine.executeGoal(goal.id);
    expect(first.status).toBe('paused');

    const stopped = await engine.resolveStepDecision(goal.id, 'stop');
    expect(stopped.status).toBe('failed');
    expect(engine.getGoal(goal.id)?.status).toBe('failed');
  });
});
