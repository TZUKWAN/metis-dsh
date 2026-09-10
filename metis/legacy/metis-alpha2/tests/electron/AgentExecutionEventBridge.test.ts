import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import type { ChatMessage, NormalizedResponse, ProviderCapabilities, StreamChunk, ToolCall, ToolContext, ToolResult, ToolSpec } from '../../engine/core/types.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { BaseProvider } from '../../engine/providers/BaseProvider.js';
import { AgentExecutionEventBridge } from '../../electron/AgentExecutionEventBridge.js';
import { AgentExecutionEventSchema, type AgentExecutionEvent } from '../../engine/runtime/ChatRuntimeContract.js';

class TwoTurnProvider extends BaseProvider {
  private call = 0;

  capabilities(): ProviderCapabilities {
    return {
      providerType: 'agent-execution-events-test', model: 'event-test-model', nativeToolCalling: true,
      jsonSchemaOutput: false, streaming: false, thinking: false, maxContextTokens: 32_000,
      maxOutputTokens: 4_096, retryableStatusCodes: [],
    };
  }

  async complete(messages: ChatMessage[], tools?: ToolSpec[]): Promise<NormalizedResponse> {
    void messages;
    void tools;
    this.call += 1;
    return this.call === 1
      ? {
          content: '', toolCalls: [{ name: 'lookup', arguments: { query: '证据' }, id: 'tool-1' }],
          finishReason: 'tool_calls', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        }
      : {
          content: '已基于工具结果完成回答。', toolCalls: [], finishReason: 'stop',
          usage: { promptTokens: 18, completionTokens: 11, totalTokens: 29 },
        };
  }

  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> { /* Force complete() for deterministic hook sequencing. */ }
}

function createLoop(): AgentLoop {
  const registry = new ToolRegistry();
  registry.register({
    name: 'lookup', description: 'Look up the requested evidence.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  });
  class SourceBearingDispatcher extends ToolDispatcher {
    override async dispatch(call: ToolCall, context?: ToolContext): Promise<ToolResult> {
      const result = await super.dispatch(call, context);
      return {
        ...result,
        metadata: {
          sources: [{ label: 'Crossref record', url: 'https://api.crossref.org/works/real-evidence' }],
          rawDiagnostic: 'this technical metadata must not reach the renderer',
        },
      };
    }
  }
  const dispatcher = new SourceBearingDispatcher(registry);
  dispatcher.registerHandler('lookup', async () => '真实工具结果：证据已获取。');
  return new AgentLoop({ provider: new TwoTurnProvider(), registry, dispatcher });
}

describe('AgentExecutionEventBridge', () => {
  it('publishes only real AgentLoop lifecycle, model and tool hooks before the final answer exists', async () => {
    const loop = createLoop();
    const events: AgentExecutionEvent[] = [];
    const bridge = new AgentExecutionEventBridge({
      sessionId: 'agent-live-session', turnId: 'turn-live-001', publish: (event) => events.push(event),
    });
    bridge.attach(loop);

    const result = await loop.run({
      sessionId: 'agent-live-session', requestId: 'turn-live-001', maxTurns: 4,
      messages: [{ role: 'user', content: '查询证据并回答。' }],
      taskContractHash: '', promptStackHash: '', resumeFromCheckpoint: false,
    });
    bridge.finish(result.status);
    bridge.dispose();

    expect(result.status).toBe('completed');
    expect(events.every((payload) => AgentExecutionEventSchema.safeParse(payload).success)).toBe(true);
    expect(events.every((payload) => payload.turnId === 'turn-live-001')).toBe(true);
    expect(events.every((payload) => payload.runId === 'turn-live-001')).toBe(true);
    expect(events.every((payload) => payload.correlationId === 'turn-live-001')).toBe(true);
    expect(events.map((payload) => payload.sequence)).toEqual(events.map((_, index) => index));
    expect(new Set(events.map((payload) => payload.eventId)).size).toBe(events.length);
    expect(events.map((payload) => payload.event)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'lifecycle', phase: 'started' }),
      expect.objectContaining({ type: 'lifecycle', phase: 'running' }),
      expect.objectContaining({ type: 'action', action: 'model.request', status: 'running' }),
      expect.objectContaining({ type: 'action', action: 'model.response', status: 'completed' }),
      expect.objectContaining({ type: 'action', action: 'tool:lookup', status: 'running' }),
      expect.objectContaining({ type: 'action', action: 'tool:lookup', status: 'completed' }),
      expect.objectContaining({
        type: 'tool_result', toolCallId: 'tool-1', toolName: 'lookup', status: 'completed',
        detail: 'Tool result suppressed',
        sources: [{ label: 'Crossref record', url: 'https://api.crossref.org/works/real-evidence' }],
      }),
      expect.objectContaining({ type: 'lifecycle', phase: 'completed' }),
    ]));
    expect(JSON.stringify(events)).not.toContain('真实工具结果：证据已获取。');
    expect(JSON.stringify(events)).not.toContain('technical metadata');
    expect(events.filter((payload) => payload.event.type === 'lifecycle' && payload.event.phase === 'completed')).toHaveLength(1);
  });

  it('emits one real cancellation terminal and detaches all hook subscriptions during cleanup', async () => {
    const loop = createLoop();
    const events: AgentExecutionEvent[] = [];
    const bridge = new AgentExecutionEventBridge({
      sessionId: 'agent-cancel-session', turnId: 'turn-cancel-001', publish: (event) => events.push(event),
    });
    bridge.attach(loop);
    bridge.finish('cancelled');
    bridge.dispose();

    await loop.run({
      sessionId: 'agent-cancel-session', requestId: 'turn-cancel-001', maxTurns: 1,
      messages: [{ role: 'user', content: '这次运行不会再向已清理的订阅推送。' }],
      taskContractHash: '', promptStackHash: '', resumeFromCheckpoint: false,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ turnId: 'turn-cancel-001', event: { type: 'lifecycle', phase: 'cancelled' } });
  });
});
