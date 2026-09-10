/**
 * UX-CHAT-002 soft turn windows + provider fast-fail.
 *
 * Chat interaction must not die at a fixed turn limit while the model keeps
 * making real progress: exhausting a window renews it with a tighter context
 * budget (auto-compression) and an `agent.window_renewed` trace. A dead
 * provider must fail honestly after 3 consecutive failures instead of burning
 * every turn and misreporting `max_turns_reached`.
 */
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import { BaseProvider } from '../../engine/providers/BaseProvider.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { HookBus } from '../../engine/core/HookBus.js';
import type { AgentRunRequest, ChatMessage, NormalizedResponse, StreamChunk, ToolSpec } from '../../engine/core/types.js';

class ScriptedProvider extends BaseProvider {
  private callIndex = 0;
  readonly receivedMessages: ChatMessage[][] = [];
  constructor(private readonly script: Array<NormalizedResponse | Error>) { super(); }
  capabilities() {
    return {
      providerType: 'ScriptedTest', model: 'test-model', nativeToolCalling: true, jsonSchemaOutput: false,
      streaming: false, thinking: false, maxContextTokens: 32000, maxOutputTokens: 4096, retryableStatusCodes: [],
    };
  }
  async complete(messages: ChatMessage[]): Promise<NormalizedResponse> {
    this.receivedMessages.push(messages.map((m) => ({ ...m })));
    const step = this.script[Math.min(this.callIndex, this.script.length - 1)]!;
    this.callIndex += 1;
    if (step instanceof Error) throw step;
    return step;
  }
  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> { /* streaming disabled */ }
}

const ECHO_TOOL: ToolSpec = {
  name: 'echo', description: 'Echo back the input',
  parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
};

const usage = () => ({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
// Unique id/message per call: the loop detector interrupts 3 identical
// consecutive turn signatures, and these tests exercise window renewal, not
// response-loop detection.
let callSequence = 0;
const toolTurn = (): NormalizedResponse => {
  callSequence += 1;
  return {
    content: `第 ${callSequence} 步的阶段性分析`, toolCalls: [{ id: `call-${callSequence}`, name: 'echo', arguments: { message: `第 ${callSequence} 次继续` } }], finishReason: 'tool_calls', usage: usage(),
  };
};
const finalTurn = (text: string): NormalizedResponse => ({ content: text, toolCalls: [], finishReason: 'stop', usage: usage() });

function setupLoop(script: Array<NormalizedResponse | Error>) {
  const provider = new ScriptedProvider(script);
  const registry = new ToolRegistry();
  registry.register(ECHO_TOOL);
  const dispatcher = new ToolDispatcher(registry);
  dispatcher.registerHandler('echo', async (args: Record<string, unknown>) => `Echo: ${args.message}`);
  const loop = new AgentLoop({ provider, registry, dispatcher, hooks: new HookBus() });
  return { loop, provider };
}

function makeRequest(overrides?: Partial<AgentRunRequest>): AgentRunRequest {
  return {
    messages: [{ role: 'user', content: '继续执行直到完成' }],
    maxTurns: 5,
    sessionId: 'windows-test',
    taskContractHash: '',
    promptStackHash: '',
    resumeFromCheckpoint: false,
    requestId: 'req-windows',
    ...overrides,
  };
}

describe('AgentLoop soft turn windows (UX-CHAT-002)', () => {
  it('renews the window with auto-compression and completes beyond the original turn limit', async () => {
    const script: Array<NormalizedResponse | Error> = [
      toolTurn(), toolTurn(), toolTurn(), toolTurn(), toolTurn(), // window 1 (maxTurns 5)
      toolTurn(), finalTurn('窗口续跑后的最终回答。'),               // window 2
    ];
    const { loop, provider } = setupLoop(script);
    const result = await loop.run(makeRequest({ turnWindows: 2 }));

    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('窗口续跑后的最终回答。');
    const renewal = result.traceEvents.find((event) => event.event === 'agent.window_renewed');
    expect(renewal?.attributes).toMatchObject({ window: 2, completed_windows: 1, turns_per_window: 5, strategy: 'tightened_budget_retry' });
    expect(provider.receivedMessages.length).toBe(7);
  });

  it('keeps single-window semantics when turnWindows is not requested', async () => {
    const script: Array<NormalizedResponse | Error> = [
      toolTurn(), toolTurn(), toolTurn(), toolTurn(), toolTurn(), // exactly maxTurns tool turns
      finalTurn('不应被调用'),
    ];
    const { loop } = setupLoop(script);
    const result = await loop.run(makeRequest());

    expect(result.status).toBe('max_turns_reached');
    expect(result.traceEvents.some((event) => event.event === 'agent.window_renewed')).toBe(false);
  });

  it('stops honestly after the last window even with ongoing progress', async () => {
    const script: Array<NormalizedResponse | Error> = Array.from({ length: 20 }, () => toolTurn());
    const { loop } = setupLoop(script);
    const result = await loop.run(makeRequest({ maxTurns: 3, turnWindows: 2 }));

    expect(result.status).toBe('max_turns_reached');
    expect(result.turnsUsed).toBe(6);
    expect(result.traceEvents.filter((event) => event.event === 'agent.window_renewed')).toHaveLength(1);
  });

  it('does not renew when the window made no real progress', async () => {
    const script: Array<NormalizedResponse | Error> = [
      new Error('connect ECONNREFUSED 127.0.0.1:63091'),
      new Error('connect ECONNREFUSED 127.0.0.1:63091'),
    ];
    const { loop } = setupLoop(script);
    const result = await loop.run(makeRequest({ maxTurns: 5, turnWindows: 4 }));

    // Two failures alone must not renew (no progress); the third consecutive
    // failure fails the whole run honestly as a provider failure.
    expect(result.status).toBe('error');
    expect(result.traceEvents.some((event) => event.event === 'agent.window_renewed')).toBe(false);
    expect(result.traceEvents.some((event) => event.event === 'agent.provider_failed')).toBe(true);
    expect(result.errors.some((message) => message.includes('Provider unavailable after 3 consecutive failures'))).toBe(true);
  });

  it('fails fast on a dead provider instead of burning every turn as max_turns_reached', async () => {
    const script: Array<NormalizedResponse | Error> = Array.from({ length: 12 }, () => new Error('socket hang up'));
    const { loop, provider } = setupLoop(script);
    const result = await loop.run(makeRequest({ maxTurns: 12 }));

    expect(result.status).toBe('error');
    expect(result.status).not.toBe('max_turns_reached');
    expect(result.turnsUsed).toBeLessThanOrEqual(3);
    expect(provider.receivedMessages.length).toBe(3);
    expect(result.errors.some((message) => message.includes('socket hang up'))).toBe(true);
  });

  it('resets the consecutive-provider counter after a successful response', async () => {
    const script: Array<NormalizedResponse | Error> = [
      new Error('transient network error'),
      new Error('transient network error'),
      finalTurn('恢复后的直接回答。'),
      new Error('another transient error'),
      new Error('another transient error'),
      finalTurn('不应到达'),
    ];
    const { loop } = setupLoop(script);
    const result = await loop.run(makeRequest({ maxTurns: 8 }));

    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('恢复后的直接回答。');
  });
});
