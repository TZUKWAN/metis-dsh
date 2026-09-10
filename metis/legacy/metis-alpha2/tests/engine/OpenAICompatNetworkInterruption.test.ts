/**
 * Phase 2 controlled network interruption/recovery coverage.
 *
 * These tests use a real localhost HTTP server and the production
 * OpenAICompatProvider -> SSEParser -> AgentLoop chain. An interrupted SSE
 * response has no cursor continuation contract, so it must be surfaced as an
 * error/interruption rather than replayed through complete() or a new turn.
 */
import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import { OpenAICompatProvider } from '../../engine/providers/OpenAICompatProvider.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import type { ToolSpec } from '../../engine/core/types.js';

interface LoopbackServer {
  port: number;
  requests: number;
  close: () => Promise<void>;
}

function sse(data: unknown): string {
  return `data: ${data === '[DONE]' ? '[DONE]' : JSON.stringify(data)}\n\n`;
}

function streamChunk(
  content: string,
  finishReason: string | null = null,
  toolCalls?: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    id: 'loopback-completion',
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: { content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      finish_reason: finishReason,
    }],
  };
}

function startServer(
  responder: (requestNumber: number, response: http.ServerResponse<http.IncomingMessage>) => void,
): Promise<LoopbackServer> {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    responder(requests, response);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        get requests() { return requests; },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function makeProvider(server: LoopbackServer, maxRetries = 0): OpenAICompatProvider {
  return new OpenAICompatProvider({
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    apiKey: 'loopback-key',
    model: 'gpt-4o-mini',
    timeout: 5_000,
    maxRetries,
    retryBackoffSeconds: 0,
  });
}

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    messages: [{ role: 'user' as const, content: 'controlled network test' }],
    maxTurns: 5,
    turnWindows: 3,
    sessionId: 'phase2-network-session',
    requestId: 'phase2-network-run',
    taskContractHash: '',
    promptStackHash: '',
    resumeFromCheckpoint: false,
    ...overrides,
  };
}

describe('Phase 2 OpenAI-compatible network controls', () => {
  it('surfaces an SSE EOF before [DONE] and never falls back or renews the run', async () => {
    const server = await startServer((_requestNumber, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(sse(streamChunk('partial answer')));
      response.end();
    });

    try {
      const provider = makeProvider(server);
      const registry = new ToolRegistry();
      const loop = new AgentLoop({ provider, registry, dispatcher: new ToolDispatcher(registry) });
      const result = await loop.run(makeRequest());

      expect(result.status).toBe('error');
      expect(result.finalText).toBe('');
      expect(result.messages.some((message) => message.role === 'assistant')).toBe(false);
      expect(server.requests).toBe(1);
      expect(result.turnsUsed).toBe(1);
      expect(result.traceEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: 'agent.start',
          sessionId: 'phase2-network-session',
        }),
        expect.objectContaining({
          event: 'agent.provider_stream_interrupted',
          sessionId: 'phase2-network-session',
          attributes: expect.objectContaining({
            turn: 1,
            request_id: 'phase2-network-run',
            phase: 'interrupted',
          }),
        }),
      ]));
      expect(result.traceEvents.some((event) => event.event === 'agent.window_renewed')).toBe(false);
      expect(result.errors.some((error) => error.includes('before [DONE]'))).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('retries permanent request-level 503 failures exactly by budget, then reports the same turn', async () => {
    const server = await startServer((_requestNumber, response) => {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'controlled unavailable' } }));
    });

    try {
      const provider = makeProvider(server, 2);
      const registry = new ToolRegistry();
      const loop = new AgentLoop({ provider, registry, dispatcher: new ToolDispatcher(registry) });
      const result = await loop.run(makeRequest({ maxTurns: 8 }));

      expect(result.status).toBe('error');
      expect(server.requests).toBe(3);
      expect(result.turnsUsed).toBe(1);
      expect(result.traceEvents.filter((event) => event.event === 'agent.provider_stream_interrupted')).toHaveLength(1);
      expect(result.traceEvents.find((event) => event.event === 'agent.provider_stream_interrupted')).toMatchObject({
        sessionId: 'phase2-network-session',
        attributes: { turn: 1, request_id: 'phase2-network-run', phase: 'request' },
      });
      expect(result.traceEvents.some((event) => event.event === 'agent.window_renewed')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('executes one streamed tool call exactly once and only then starts turn two', async () => {
    let executions = 0;
    const echoTool: ToolSpec = {
      name: 'echo',
      description: 'Echo one message',
      parameters: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    };
    const server = await startServer((requestNumber, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (requestNumber === 1) {
        response.write(sse(streamChunk('', null, [{
          index: 0,
          id: 'call-once',
          type: 'function',
          function: { name: 'echo', arguments: '{"message":"' },
        }])));
        response.write(sse(streamChunk('', null, [{
          index: 0,
          function: { arguments: 'exactly-once"}' },
        }])));
        response.write(sse(streamChunk('', 'tool_calls')));
      } else {
        response.write(sse(streamChunk('done', 'stop')));
      }
      response.end(sse('[DONE]'));
    });

    try {
      const provider = makeProvider(server);
      const registry = new ToolRegistry();
      registry.register(echoTool);
      const dispatcher = new ToolDispatcher(registry);
      dispatcher.registerHandler('echo', async (args) => {
        executions += 1;
        return `Echo: ${String(args.message)}`;
      });
      const loop = new AgentLoop({ provider, registry, dispatcher });
      const result = await loop.run(makeRequest({ maxTurns: 2, turnWindows: 1 }));

      expect(result.status).toBe('completed');
      expect(result.finalText).toBe('done');
      expect(executions).toBe(1);
      expect(result.toolResults).toHaveLength(1);
      expect(result.toolResults[0]?.toolCallId).toBe('call-once');
      expect(server.requests).toBe(2);
      expect(result.traceEvents.filter((event) => event.event === 'tool.dispatched')).toHaveLength(1);
      expect(result.traceEvents.filter((event) => event.event === 'agent.start')).toHaveLength(1);
      expect(result.traceEvents.filter((event) => event.event === 'model.request').map((event) => event.attributes.turn)).toEqual([1, 2]);
    } finally {
      await server.close();
    }
  });

  it('propagates AbortSignal to the live fetch and returns interrupted without stale text', async () => {
    let firstChunkWritten!: () => void;
    const firstChunk = new Promise<void>((resolve) => { firstChunkWritten = resolve; });
    const server = await startServer((_requestNumber, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(sse(streamChunk('not-final')));
      firstChunkWritten();
      // Keep the response open until the client aborts it.
    });

    try {
      const controller = new AbortController();
      const provider = makeProvider(server);
      const registry = new ToolRegistry();
      const loop = new AgentLoop({ provider, registry, dispatcher: new ToolDispatcher(registry) });
      loop.hooks.register('model.stream_chunk', (context) => {
        if (context.content === 'not-final') controller.abort();
      });

      const runPromise = loop.run(makeRequest({ signal: controller.signal }));
      await firstChunk;
      const result = await runPromise;

      expect(result.status).toBe('interrupted');
      expect(result.finalText).toBe('');
      expect(result.messages.some((message) => message.role === 'assistant')).toBe(false);
      expect(server.requests).toBe(1);
      expect(result.traceEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: 'agent.interrupted',
          sessionId: 'phase2-network-session',
          attributes: { phase: 'during_model', turn: 1, request_id: 'phase2-network-run' },
        }),
      ]));
    } finally {
      await server.close();
    }
  });
});
