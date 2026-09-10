/**
 * Provider failure matrix — system-level gate over the production
 * OpenAICompatProvider against a real loopback HTTP server.
 *
 * Covers the release-matrix statuses and stream failure modes:
 *   401 / 403 / 404 (model) / 429 / 500 / 502 / request timeout /
 *   interrupted SSE stream / malformed SSE / context overflow / user cancel.
 *
 * For every case the contract is: no crash (a typed Error or a normal
 * completion), bounded retries (asserted against the actual request count),
 * accurate status in the surfaced error, honest partial-response semantics,
 * and the API key never appears in any thrown error message.
 */
import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatProvider } from '../../engine/providers/OpenAICompatProvider.js';
import { ProviderStreamError } from '../../engine/providers/BaseProvider.js';

const API_KEY = 'sk-loopback-secret-key-do-not-leak';

interface LoopbackServer {
  port: number;
  requests: number;
  bodies: string[];
  close: () => Promise<void>;
}

function sse(data: unknown): string {
  return `data: ${data === '[DONE]' ? '[DONE]' : JSON.stringify(data)}\n\n`;
}

function streamChunk(content: string, finishReason: string | null = null): Record<string, unknown> {
  return {
    id: 'failure-matrix',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
  };
}

function statusResponder(status: number, body: Record<string, unknown>) {
  return (_requestNumber: number, response: http.ServerResponse) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
}

function startServer(
  responder: (requestNumber: number, response: http.ServerResponse, body: string) => void,
): Promise<LoopbackServer> {
  let requests = 0;
  const bodies: string[] = [];
  const server = http.createServer((request, response) => {
    requests += 1;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      bodies.push(body);
      responder(requests, response, body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        get requests() { return requests; },
        get bodies() { return bodies; },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function makeProvider(server: LoopbackServer, overrides: Record<string, unknown> = {}): OpenAICompatProvider {
  return new OpenAICompatProvider({
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    apiKey: API_KEY,
    model: 'gpt-4o-mini',
    timeout: 5_000,
    maxRetries: 0,
    retryBackoffSeconds: 0,
    ...overrides,
  });
}

const MESSAGES = [{ role: 'user' as const, content: 'failure matrix probe' }];

/** Case definitions: [label, status, body, retryable]. */
const STATUS_CASES: Array<{ label: string; status: number; body: Record<string, unknown>; retryable: boolean }> = [
  { label: '401 unauthorized', status: 401, body: { error: { message: 'invalid api key' } }, retryable: false },
  { label: '403 forbidden', status: 403, body: { error: { message: 'permission denied' } }, retryable: false },
  { label: '404 unknown model', status: 404, body: { error: { message: 'The model `gpt-4o-mini` does not exist or is not a valid model' } }, retryable: false },
  { label: '429 rate limited', status: 429, body: { error: { message: 'rate limit exceeded' } }, retryable: true },
  { label: '500 server error', status: 500, body: { error: { message: 'internal error' } }, retryable: true },
  { label: '502 bad gateway', status: 502, body: { error: { message: 'upstream failure' } }, retryable: true },
];

describe('Provider failure matrix — status codes', () => {
  for (const testCase of STATUS_CASES) {
    it(`${testCase.label}: surfaces status, honors retry bound, never leaks the API key`, async () => {
      const server = await startServer(statusResponder(testCase.status, testCase.body));
      try {
        const provider = makeProvider(server, { maxRetries: 1 });
        await expect(provider.complete(MESSAGES)).rejects.toThrow(/Provider error \d+/);
        expect(server.requests).toBe(testCase.retryable ? 2 : 1);
        const error = await provider.complete(MESSAGES).catch((err: Error) => err);
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toMatch(new RegExp(`Provider error ${testCase.status}`));
        expect(error.message).not.toContain(API_KEY);
      } finally {
        await server.close();
      }
    });
  }

  it('400 with a deterministic model error fails fast (no retry burn)', async () => {
    const server = await startServer(statusResponder(400, { error: { message: 'model not found: no such model gpt-4o-mini' } }));
    try {
      const provider = makeProvider(server, { maxRetries: 3 });
      await expect(provider.complete(MESSAGES)).rejects.toThrow(/Provider error 400/);
      expect(server.requests).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('400 with a generic message is retried per the declared retryable set, then reported', async () => {
    const server = await startServer(statusResponder(400, { error: { message: 'bad request somehow' } }));
    try {
      const provider = makeProvider(server, { maxRetries: 1 });
      await expect(provider.complete(MESSAGES)).rejects.toThrow(/Provider error 400/);
      expect(server.requests).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('400 context-overflow message bypasses retry entirely', async () => {
    const server = await startServer(statusResponder(400, { error: { message: "This model's maximum context length is 8192 tokens" } }));
    try {
      const provider = makeProvider(server, { maxRetries: 5 });
      await expect(provider.complete(MESSAGES)).rejects.toThrow(/maximum context length/i);
      expect(server.requests).toBe(1);
    } finally {
      await server.close();
    }
  });
});

describe('Provider failure matrix — request timeout', () => {
  it('request-phase timeout becomes a typed stream error (phase=request), no crash, no retry beyond budget', async () => {
    const server = await startServer((_requestNumber, response) => {
      // Never respond — the provider timeout must fire.
      void response;
    });
    try {
      // NOTE: provider treats timeout values < 1000 as seconds; use explicit ms.
      const provider = makeProvider(server, { timeout: 1_500, maxRetries: 1 });
      const startedAt = Date.now();
      let caught: unknown;
      try {
        for await (const _chunk of provider.completeStream(MESSAGES)) { void _chunk; }
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProviderStreamError);
      expect((caught as ProviderStreamError).phase).toBe('request');
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      // Timeout errors are treated as transient (status 0) and consume the retry budget.
      expect(server.requests).toBe(2);
    } finally {
      await server.close();
    }
  }, 20_000);
});

describe('Provider failure matrix — stream semantics', () => {
  it('interrupted stream (EOF before [DONE]): partial chunks are delivered, then a typed interrupted error', async () => {
    const server = await startServer((_requestNumber, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(sse(streamChunk('partial ')));
      response.write(sse(streamChunk('answer')));
      response.end(); // EOF without [DONE]
    });
    try {
      const provider = makeProvider(server);
      const received: string[] = [];
      let caught: unknown;
      try {
        for await (const chunk of provider.completeStream(MESSAGES)) received.push(chunk.content);
      } catch (err) {
        caught = err;
      }
      // Partial response semantics: content that arrived IS handed to the caller…
      expect(received.join('')).toBe('partial answer');
      // …and the truncation is a typed interruption, not a silent success.
      expect(caught).toBeInstanceOf(ProviderStreamError);
      expect((caught as ProviderStreamError).phase).toBe('interrupted');
      expect(server.requests).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('malformed SSE lines are skipped without crashing; valid tail still completes', async () => {
    const server = await startServer((_requestNumber, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {not valid json}\n\n');
      response.write(':sse comment frame\n\n');
      response.write('data: "garbage string payload"\n\n');
      response.write(sse(streamChunk('recovered')));
      response.write(sse('[DONE]'));
    });
    try {
      const provider = makeProvider(server);
      const received: string[] = [];
      let finished = false;
      for await (const chunk of provider.completeStream(MESSAGES)) {
        received.push(chunk.content);
        if (chunk.isFinished) finished = true;
      }
      expect(received.join('')).toContain('recovered');
      expect(finished).toBe(true);
      expect(server.requests).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('user cancel before the call issues no request; cancel mid-stream stops delivery', async () => {
    // Pre-aborted signal: request-phase abort check fires before any fetch.
    const idle = await startServer(statusResponder(200, {}));
    try {
      const controller = new AbortController();
      controller.abort();
      const provider = makeProvider(idle);
      await expect(provider.complete(MESSAGES, undefined, { signal: controller.signal })).rejects.toThrow();
      expect(idle.requests).toBe(0);
    } finally {
      await idle.close();
    }

    // Mid-stream cancel: abort as soon as the client has consumed the first
    // chunk; delivery stops and the truncation surfaces as a typed error.
    const stream = await startServer((_requestNumber, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(sse(streamChunk('before-cancel')));
      // Keep the response open until the client aborts it.
    });
    try {
      const controller = new AbortController();
      const provider = makeProvider(stream);
      const received: string[] = [];
      let caught: unknown;
      try {
        for await (const chunk of provider.completeStream(MESSAGES, undefined, { signal: controller.signal })) {
          received.push(chunk.content);
          if (chunk.content === 'before-cancel') controller.abort();
        }
      } catch (err) {
        caught = err;
      }
      expect(received.join('')).toBe('before-cancel');
      expect(caught).toBeInstanceOf(ProviderStreamError);
      expect((caught as ProviderStreamError).phase).toBe('interrupted');
      expect(String((caught as Error).message)).not.toContain(API_KEY);
    } finally {
      await stream.close();
    }
  });

  it('request bodies carry the messages but never the API key', async () => {
    const server = await startServer((_requestNumber, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
    try {
      const provider = makeProvider(server);
      await provider.complete(MESSAGES);
      expect(server.bodies).toHaveLength(1);
      expect(server.bodies[0]).toContain('failure matrix probe');
      expect(server.bodies[0]).not.toContain(API_KEY);
    } finally {
      await server.close();
    }
  });
});
