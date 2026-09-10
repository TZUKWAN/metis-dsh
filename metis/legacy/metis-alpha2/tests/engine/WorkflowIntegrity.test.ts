/**
 * Workflow execution integrity — a step must NOT be marked completed when the
 * agent declares inability ("我无法访问…", "please paste the text for me"),
 * when the run is not verified, or when the output is empty; and every step
 * gets enough turn headroom (floor of 6) to finish tool-using work.
 *
 * Regression tests for the real DeepSeek run where step_4's refusal was
 * recorded as `completed` + finalVerified:true and step_5 died on
 * max_turns_reached with the planner's old 3-turn default.
 */

import { describe, it, expect, vi } from 'vitest';
import { WorkflowEngine, isNonAccomplishmentOutput } from '../../engine/workflow/WorkflowEngine.js';
import type { WorkflowDefinition } from '../../engine/workflow/types.js';
import type { AgentRunRequest, AgentRunResult } from '../../engine/core/types.js';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import { BaseProvider } from '../../engine/providers/BaseProvider.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import type { NormalizedResponse } from '../../engine/core/types.js';

function makeWorkflow(maxTurns = 3): WorkflowDefinition {
  return {
    id: 'wf_test',
    name: 'Integrity test',
    description: '',
    version: '1.0.0',
    steps: [
      { id: 'a', name: 'A', description: '', prompt: 'Do A', inputFrom: [], tools: [], maxTurns },
    ],
    dependencies: { a: [] },
  };
}

function makeAgentStub(result: Partial<AgentRunResult>, capture?: (req: AgentRunRequest) => void): AgentLoop {
  const full: AgentRunResult = {
    status: 'completed',
    finalText: 'done',
    finalVerified: true,
    messages: [],
    turnsUsed: 1,
    toolResults: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    errors: [],
    traceEvents: [],
    ...result,
  };
  return {
    run: vi.fn(async (req: AgentRunRequest) => { capture?.(req); return full; }),
  } as unknown as AgentLoop;
}

// Real provider path: refusal text through a genuine AgentLoop end-to-end.
class RefusalProvider extends BaseProvider {
  capabilities() {
    return {
      providerType: 'RefusalProvider', model: 'test', nativeToolCalling: true,
      jsonSchemaOutput: false, streaming: false, thinking: false,
      maxContextTokens: 32000, maxOutputTokens: 4096, retryableStatusCodes: [],
    };
  }
  async complete(): Promise<NormalizedResponse> {
    return {
      content: '我无法直接访问 `step_2.output` 文件。请你将该文件中的搜索结果文本粘贴给我，我会用 summarize_text 工具概括。',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
  async *completeStream(): AsyncGenerator<never, void, unknown> {}
}

describe('isNonAccomplishmentOutput', () => {
  it('flags the observed step_4 refusal (无法访问 + 请粘贴给我)', () => {
    expect(isNonAccomplishmentOutput(
      '我无法直接访问 `step_2.output` 文件。请你将该文件中的搜索结果文本粘贴给我，我会用 `summarize_text` 工具将其概括。',
    )).toBe(true);
  });

  it('flags short tool-missing refusals', () => {
    expect(isNonAccomplishmentOutput('由于当前环境中没有提供 write_file 工具，我无法创建文件。')).toBe(true);
    expect(isNonAccomplishmentOutput("I'm unable to access the file directly.")).toBe(true);
  });

  it('does NOT flag a long substantive answer that mentions a limitation (observed step_5 variant)', () => {
    const longAnswer = `由于当前环境中没有提供 write_file 工具，我无法实际创建 meta_analysis_answer.txt 文件。以下是本应写入该文件的完整内容：\n\n元分析是一种对同一研究主题的多项独立研究结果进行系统性整合的统计学方法。它通过加权合并效应量，得出比单项研究更可靠的总体结论。例如 Smith 和 Glass（1977）综合了 375 项心理治疗研究，发现平均效应量为 0.68 个标准差。${'补充说明。'.repeat(100)}`;
    expect(longAnswer.length).toBeGreaterThan(500);
    expect(isNonAccomplishmentOutput(longAnswer)).toBe(false);
  });

  it('does NOT flag normal answers', () => {
    expect(isNonAccomplishmentOutput('元分析是一种统计方法，用于合并多个独立研究的结果。')).toBe(false);
    expect(isNonAccomplishmentOutput('')).toBe(false);
  });
});

describe('WorkflowEngine step integrity', () => {
  it('marks a refusal output step as FAILED instead of completed (real AgentLoop path)', async () => {
    const loop = new AgentLoop({
      provider: new RefusalProvider(),
      registry: new ToolRegistry(),
      dispatcher: new ToolDispatcher(new ToolRegistry()),
    });
    const engine = new WorkflowEngine(loop);
    const run = await engine.run(makeWorkflow());
    expect(run.stepResults.a?.status).toBe('failed');
    expect(run.status).toBe('failed');
  });

  it('rejects a completed-but-unverified run even when finalText is present', async () => {
    const engine = new WorkflowEngine(makeAgentStub({ finalVerified: false, finalText: 'looks fine' }));
    const run = await engine.run(makeWorkflow());
    expect(run.stepResults.a?.status).toBe('failed');
  });

  it('rejects empty finalText', async () => {
    const engine = new WorkflowEngine(makeAgentStub({ finalText: '   ' }));
    const run = await engine.run(makeWorkflow());
    expect(run.stepResults.a?.status).toBe('failed');
  });

  it('completes normally for a verified, substantive answer', async () => {
    const engine = new WorkflowEngine(makeAgentStub({ finalText: '元分析是一种定量综合多个研究结果的统计方法。' }));
    const run = await engine.run(makeWorkflow());
    expect(run.stepResults.a?.status).toBe('completed');
    expect(run.status).toBe('completed');
  });
});

describe('WorkflowEngine maxTurns floor', () => {
  it('raises the old 3-turn default to 6', async () => {
    let captured: AgentRunRequest | undefined;
    const engine = new WorkflowEngine(makeAgentStub({}, (req) => { captured = req; }));
    await engine.run(makeWorkflow(3));
    expect(captured?.maxTurns).toBe(6);
  });

  it('keeps larger explicit budgets', async () => {
    let captured: AgentRunRequest | undefined;
    const engine = new WorkflowEngine(makeAgentStub({}, (req) => { captured = req; }));
    await engine.run(makeWorkflow(12));
    expect(captured?.maxTurns).toBe(12);
  });
});
