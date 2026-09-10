/**
 * 2026-09-05 metis 无声卡死修复的回归测试。
 *
 * 两件事：
 * 1. model.request 发出后、provider 首字节返回前，AgentLoop 按固定间隔
 *    广播 model.waiting 心跳（UI 靠它区分「在等」与「挂死」）。
 * 2. run 有总时间预算：超预算后不再开启新的 turn，run 以 error 结束，
 *    errors 里携带真实原因——防止单请求超时 × 重试次数组合出数小时挂死。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import { BaseProvider } from '../../engine/providers/BaseProvider.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { HookBus } from '../../engine/core/HookBus.js';
import { MODEL_WAITING_HEARTBEAT_MS, RUN_TIME_BUDGET_MS } from '../../engine/core/Config.js';
import type {
  AgentRunRequest,
  ChatMessage,
  NormalizedResponse,
  ProviderUsage,
  StreamChunk,
  ToolSpec,
} from '../../engine/core/types.js';

function makeUsage(): ProviderUsage {
  return { promptTokens: 10, completionTokens: 20, totalTokens: 30 };
}

function makeRequest(overrides?: Partial<AgentRunRequest>): AgentRunRequest {
  return {
    messages: [{ role: 'user', content: 'Hello' }],
    maxTurns: 5,
    sessionId: 'test-session',
    taskContractHash: '',
    promptStackHash: '',
    resumeFromCheckpoint: false,
    requestId: 'req-001',
    ...overrides,
  };
}

abstract class TestProvider extends BaseProvider {
  capabilities() {
    return {
      providerType: 'WaitingBudgetTest',
      model: 'test-model',
      nativeToolCalling: true,
      jsonSchemaOutput: false,
      streaming: false,
      thinking: false,
      maxContextTokens: 32000,
      maxOutputTokens: 4096,
      retryableStatusCodes: [],
    };
  }

  async *completeStream(_messages?: ChatMessage[], _tools?: ToolSpec[]): AsyncGenerator<StreamChunk, void, unknown> {
    void _messages;
    void _tools;
  }
}

/** 首个调用挂起直到测试放行，用于验证等待心跳。 */
class GatedProvider extends TestProvider {
  private release?: (value: NormalizedResponse) => void;
  private readonly gate: Promise<NormalizedResponse>;

  constructor() {
    super();
    this.gate = new Promise<NormalizedResponse>((resolve) => {
      this.release = resolve;
    });
  }

  async complete(): Promise<NormalizedResponse> {
    return this.gate;
  }

  respond(response: NormalizedResponse): void {
    this.release?.(response);
  }
}

/**
 * 每一轮都要求调用 echo 工具，但由测试逐步放行——让假时间与 turn 边界
 * 的对应关系完全确定，预算熔断的触发点可精确预测。
 */
class SteppedToolCallProvider extends TestProvider {
  private pending?: (value: NormalizedResponse) => void;
  private callCount = 0;

  async complete(): Promise<NormalizedResponse> {
    this.callCount += 1;
    return new Promise<NormalizedResponse>((resolve) => {
      this.pending = resolve;
    });
  }

  step(): void {
    this.pending?.({
      content: '',
      toolCalls: [{ name: 'echo', arguments: { message: `spam-${this.callCount}` }, id: `tc_${this.callCount}` }],
      finishReason: 'tool_calls',
      usage: makeUsage(),
    });
  }
}

function buildLoop(provider: TestProvider, hooks: HookBus): AgentLoop {
  const registry = new ToolRegistry();
  const dispatcher = new ToolDispatcher(registry);
  return new AgentLoop({ provider, registry, dispatcher, hooks });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentLoop waiting heartbeat', () => {
  it('emits model.waiting on a fixed interval while the provider call is in flight', async () => {
    vi.useFakeTimers();
    const hooks = new HookBus();
    const waiting: Array<number | undefined> = [];
    const provider = new GatedProvider();
    const loop = buildLoop(provider, hooks);
    loop.registerHook('model.waiting', (context) => {
      waiting.push(context.elapsedSeconds as number | undefined);
      return context;
    }, { name: 'collect-waiting' });

    const runPromise = loop.run(makeRequest());
    await vi.advanceTimersByTimeAsync(MODEL_WAITING_HEARTBEAT_MS * 3);
    provider.respond({ content: 'finally answered.', toolCalls: [], finishReason: 'stop', usage: makeUsage() });

    const result = await runPromise;
    expect(result.status).toBe('completed');
    expect(waiting).toEqual([15, 30, 45]);
  });

  it('stops emitting heartbeats once the provider responds', async () => {
    vi.useFakeTimers();
    const hooks = new HookBus();
    let heartbeats = 0;
    const provider = new GatedProvider();
    const loop = buildLoop(provider, hooks);
    loop.registerHook('model.waiting', (context) => {
      void context;
      heartbeats += 1;
      return context;
    }, { name: 'count-waiting' });

    const runPromise = loop.run(makeRequest());
    provider.respond({ content: 'fast answer.', toolCalls: [], finishReason: 'stop', usage: makeUsage() });
    await runPromise;
    await vi.advanceTimersByTimeAsync(MODEL_WAITING_HEARTBEAT_MS * 5);

    expect(heartbeats).toBe(0);
  });
});

describe('AgentLoop run time budget', () => {
  it('ends the run with an honest error once the budget is exhausted at a turn boundary', async () => {
    vi.useFakeTimers();
    const hooks = new HookBus();
    const provider = new SteppedToolCallProvider();
    const loop = buildLoop(provider, hooks);

    const runPromise = loop.run(makeRequest({ maxTurns: 12 }));
    // 每个放行前的等待消耗总预算的 1/4 强：第 5 个 turn 边界必然熔断
    //（elapsed ≈ 4 × (budget/4 + 1s) > budget），maxTurns=12 不会先到。
    const perTurnElapsed = Math.ceil(RUN_TIME_BUDGET_MS / 4) + 1_000;
    for (let index = 0; index < 4; index += 1) {
      await vi.advanceTimersByTimeAsync(perTurnElapsed);
      provider.step();
      await vi.advanceTimersByTimeAsync(0);
    }
    const result = await runPromise;

    expect(result.status).toBe('error');
    expect(result.errors.some((message) => message.includes('time budget exhausted'))).toBe(true);
    expect(result.traceEvents.some((event) => event.event === 'agent.time_budget_exhausted')).toBe(true);
  });
});
