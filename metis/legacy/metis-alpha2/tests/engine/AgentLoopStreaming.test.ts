/**
 * Tests for AgentLoop real streaming with fallback.
 */

import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import type { BaseProvider } from '../../engine/providers/BaseProvider.js';
import type { StreamChunk, NormalizedResponse, ToolSpec } from '../../engine/core/types.js';

const ECHO_TOOL: ToolSpec = {
  name: 'echo',
  description: 'Echo back a message',
  parameters: {
    type: 'object',
    properties: { message: { type: 'string', description: 'Message to echo' } },
    required: ['message'],
  },
};

async function echoHandler(args: Record<string, unknown>): Promise<string> {
  return `Echo: ${String(args.message)}`;
}

function fakeStreamingProvider(chunks: StreamChunk[]): BaseProvider {
  return {
    capabilities: () => ({ providerType: 'test', model: 'test-model', nativeToolCalling: true, jsonSchemaOutput: false, streaming: true }),
    async complete() { throw new Error('should not call complete when streaming works'); },
    async *completeStream() { for (const chunk of chunks) yield chunk; },
    async healthCheck() { return {}; },
    async close() {},
  } as unknown as BaseProvider;
}

function fakeNonStreamingProvider(response: NormalizedResponse): BaseProvider {
  return {
    capabilities: () => ({ providerType: 'test', model: 'test-model', nativeToolCalling: true, jsonSchemaOutput: false, streaming: false }),
    async complete() { return response; },
    completeStream: (() => { throw new Error('no streaming'); }) as unknown as BaseProvider['completeStream'],
    async healthCheck() { return {}; },
    async close() {},
  } as unknown as BaseProvider;
}

/** Streaming provider whose chunk sequence advances per call (round-robin). */
function fakeScriptedStreamingProvider(rounds: StreamChunk[][]): BaseProvider {
  let idx = 0;
  return {
    capabilities: () => ({ providerType: 'test', model: 'test-model', nativeToolCalling: true, jsonSchemaOutput: false, streaming: true }),
    async complete() { throw new Error('should not call complete when streaming works'); },
    async *completeStream() {
      const round = rounds[Math.min(idx, rounds.length - 1)] ?? [];
      idx++;
      for (const chunk of round) yield chunk;
    },
    async healthCheck() { return {}; },
    async close() {},
  } as unknown as BaseProvider;
}

describe('AgentLoop streaming', () => {
  it('uses real streaming when provider supports it', async () => {
    const provider = fakeStreamingProvider([
      { content: 'Hello', isFinished: false, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
      { content: ' world', isFinished: false, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
      { content: '!', isFinished: true, usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } },
    ]);
    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);
    const loop = new AgentLoop({ provider, registry, dispatcher });
    const chunks: string[] = [];
    loop.hooks.register('model.stream_chunk', async (ctx) => {
      chunks.push((ctx as { content?: string }).content ?? '');
    });
    const result = await loop.run({ messages: [{ role: 'user', content: 'hi' }], maxTurns: 1 });
    expect(result.finalText).toBe('Hello world!');
    expect(chunks).toEqual(['Hello', ' world', '!']);
  });

  it('falls back to complete() when streaming fails', async () => {
    const provider = fakeNonStreamingProvider({
      content: 'Fallback answer',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    });
    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);
    const loop = new AgentLoop({ provider, registry, dispatcher });
    const chunks: string[] = [];
    loop.hooks.register('model.stream_chunk', async (ctx) => {
      chunks.push((ctx as { content?: string }).content ?? '');
    });
    const result = await loop.run({ messages: [{ role: 'user', content: 'hi' }], maxTurns: 1 });
    expect(result.finalText).toBe('Fallback answer');
    expect(chunks).toEqual(['Fallback answer', '']);
  });

  it('executes tool calls delivered in the final streaming chunk', async () => {
    // Mirrors the real SSE streamer: text deltas first, then a final chunk that
    // carries the complete tool calls (see SSEParser streamOpenAIResponse).
    const provider = fakeScriptedStreamingProvider([
      [
        { content: 'Let me check', isFinished: false, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
        {
          content: '',
          toolCalls: [{ name: 'echo', arguments: { message: 'streamed' }, id: 'call_s1' }],
          isFinished: true,
          usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        },
      ],
      [
        { content: 'Tool returned: Echo: streamed', isFinished: true, usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } },
      ],
    ]);
    const registry = new ToolRegistry();
    registry.register(ECHO_TOOL);
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('echo', echoHandler);
    const loop = new AgentLoop({ provider, registry, dispatcher });
    const result = await loop.run({ messages: [{ role: 'user', content: 'echo streamed' }], maxTurns: 2 });
    expect(result.status).toBe('completed');
    expect(result.toolResults.length).toBe(1);
    expect(result.toolResults[0]?.toolName).toBe('echo');
    expect(result.toolResults[0]?.content).toContain('Echo: streamed');
  });

  it('collapses SSE tool-call deltas into one execution per id', async () => {
    // A realistic OpenAI-style stream: a first delta with id+name, middle deltas
    // carrying only argument fragments (empty name), then the final complete call.
    const provider = fakeScriptedStreamingProvider([
      [
        {
          content: '',
          toolCalls: [{ name: 'echo', arguments: {}, id: 'call_d1' }],
          isFinished: false,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        },
        {
          content: '',
          toolCalls: [{ name: '', arguments: { message: 'frag' }, id: '' }],
          isFinished: false,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        },
        {
          content: '',
          toolCalls: [{ name: 'echo', arguments: { message: 'final' }, id: 'call_d1' }],
          isFinished: true,
          usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        },
      ],
      [
        { content: 'Tool returned: Echo: final', isFinished: true, usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } },
      ],
    ]);
    const registry = new ToolRegistry();
    registry.register(ECHO_TOOL);
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('echo', echoHandler);
    const loop = new AgentLoop({ provider, registry, dispatcher });
    const result = await loop.run({ messages: [{ role: 'user', content: 'echo once' }], maxTurns: 2 });
    expect(result.status).toBe('completed');
    expect(result.toolResults.length).toBe(1);
    expect(result.toolResults[0]?.toolName).toBe('echo');
    expect(result.toolResults[0]?.content).toContain('Echo: final');
  });
});
