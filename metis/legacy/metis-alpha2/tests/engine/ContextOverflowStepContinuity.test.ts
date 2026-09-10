/**
 * Focused regression tests for long-context Goal E2E continuity.
 *
 * Reproduces the production defect chain observed in
 * logs/electron-goal-long-context-e2e-20260821*.json: a step whose provider
 * answers a deterministic context-overflow (HTTP 400) never advanced the Goal
 * to its downstream steps.
 *
 * Defect layers covered here:
 *   D1 — OpenAICompatProvider.withRetry blindly re-sends deterministic
 *        context-overflow 400s, burning the retry budget, hiding the overflow
 *        from AgentLoop recovery, and inflating wall-clock latency.
 *   D2 — On the streaming path the transport wraps the 400 into a
 *        ProviderStreamError, which AgentLoop treated as a fatal stream
 *        interruption BEFORE consulting isContextError, so the dedicated
 *        overflow-recovery path (recompression + retry) never engaged for
 *        streaming providers.
 *   D3 — recoverFromContextOverflow pushed "context overflow recovery failed"
 *        into ctx.errors, permanently poisoning finalVerified. A step that
 *        recovered and delivered acceptance-passing output was still marked as
 *        not accomplished, so WorkflowEngine never ran downstream steps.
 *
 * The workflow-level test mirrors the controlled E2E fixture semantics:
 * step 1 seeds long evidence; step 2 overflows on its first attempt, produces
 * an acceptance-failing partial output, then — on the workflow retry — survives
 * repeated overflows and finally delivers marker-complete output; step 3 must
 * run afterwards.
 */

import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { AgentLoop } from '../../engine/core/AgentLoop.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { OpenAICompatProvider } from '../../engine/providers/OpenAICompatProvider.js';
import { BaseProvider, ProviderStreamError } from '../../engine/providers/BaseProvider.js';
import type { NormalizedResponse, StreamChunk } from '../../engine/core/types.js';
import { WorkflowEngine } from '../../engine/workflow/index.js';
import type { WorkflowDefinition } from '../../engine/workflow/types.js';

// ─── Part 1: transport-level classification (real OpenAICompatProvider) ──

const OVERFLOW_REASON = 'context length exceeded in controlled fixture';

function sseChunk(content: string): string {
  return `data: ${JSON.stringify({
    id: `t-${Date.now()}`,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  })}\n\n`;
}

function sseDone(): string {
  return `data: ${JSON.stringify({
    id: `t-${Date.now()}`,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\ndata: [DONE]\n\n`;
}

interface OverflowServer {
  port: number;
  readonly wireRequests: number;
  close: () => Promise<void>;
}

/**
 * Starts a loopback OpenAI-compatible server that answers the first
 * `overflowCount` requests with a deterministic context-overflow 400 and every
 * later request with a valid streaming completion carrying `completionText`.
 */
async function startOverflowServer(
  overflowCount: number,
  completionText: string,
): Promise<OverflowServer> {
  let requests = 0;
  const server = http.createServer((req, res) => {
    void req.resume();
    requests += 1;
    if (requests <= overflowCount) {
      res.writeHead(400, OVERFLOW_REASON, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: OVERFLOW_REASON } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.write(sseChunk(completionText));
    res.end(sseDone());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const wrapper: OverflowServer = {
    port: address.port,
    get wireRequests() { return requests; },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
  return wrapper;
}

async function makeHttpLoop(serverPort: number) {
  const provider = new OpenAICompatProvider({
    baseUrl: `http://127.0.0.1:${serverPort}/v1`,
    apiKey: 'loopback-key',
    model: 'metis-test-loopback',
    timeout: 5_000,
    maxRetries: 3,
    retryBackoffSeconds: 0,
  });
  const registry = new ToolRegistry();
  const dispatcher = new ToolDispatcher(registry);
  const loop = new AgentLoop({ provider, registry, dispatcher });
  return loop;
}

const overflowServers: OverflowServer[] = [];
afterAll(async () => {
  await Promise.all(overflowServers.map((server) => server.close()));
});

describe('transport surfaces deterministic context overflow to AgentLoop recovery', () => {
  it('does not blind-retry a context-overflow 400 inside one provider call', async () => {
    // Every request overflows, so each AgentLoop-level attempt must map to
    // exactly ONE wire request (initial + at most one recovery retry per turn).
    const server = await startOverflowServer(Number.MAX_SAFE_INTEGER, 'unused');
    overflowServers.push(server);
    const loop = await makeHttpLoop(server.port);

    const result = await loop.run({
      sessionId: 'overflow-no-blind-retry',
      requestId: 'req-no-blind-retry',
      messages: [{ role: 'user', content: 'long research task' }],
      maxTurns: 2,
      taskContractHash: '',
      promptStackHash: '',
    });

    // 2 turns × (initial + recovery retry) = 4 wire calls maximum. The old
    // behavior burned maxRetries(3)+1 wire calls per AgentLoop-level attempt
    // (≈16 requests) before surfacing anything.
    expect(server.wireRequests).toBeLessThanOrEqual(4);
    // The overflow must be visible to the AgentLoop recovery layer…
    expect(result.traceEvents.some((event) => event.event === 'context.overflow')).toBe(true);
    // …and must NOT be misclassified as a fatal stream interruption.
    expect(result.status).not.toBe('error');
  });

  it('recovers once after a single overflow and completes with verified output', async () => {
    const server = await startOverflowServer(1, 'Recovered cleanly after overflow.');
    overflowServers.push(server);
    const loop = await makeHttpLoop(server.port);

    const result = await loop.run({
      sessionId: 'overflow-single-recovery',
      requestId: 'req-single-recovery',
      messages: [{ role: 'user', content: 'summarize the evidence' }],
      maxTurns: 3,
      taskContractHash: '',
      promptStackHash: '',
    });

    // Exactly two wire requests: the overflowing call plus the recovery retry.
    expect(server.wireRequests).toBe(2);
    expect(result.status).toBe('completed');
    expect(result.finalText).toContain('Recovered cleanly');
    expect(result.finalVerified).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.traceEvents.some((event) => event.event === 'context.overflow')).toBe(true);
  });
});

// ─── Part 2: workflow step continuity after overflow + acceptance retry ──

const SENTINEL = 'CONTINUITY-SENTINEL-ALPHA';
const EVIDENCE = 'CONTINUITY-EVIDENCE-BETA';
const LONG_EVIDENCE = `${SENTINEL} ${EVIDENCE} ${'verified checkpoint evidence payload. '.repeat(40)}`;
const PARTIAL_STEP2 = 'STEP2 partial first response without the retained markers.';
const RECOVERED_STEP2 = `STEP2 recovered after overflow and retry. ${SENTINEL} ${EVIDENCE} continuity restored.`;
const STEP3_OUTPUT = `STEP3 boundary ready. ${SENTINEL} ${EVIDENCE} durable.`;

type ScriptedOp = { kind: 'overflow'; message: string } | { kind: 'content'; content: string };

/**
 * Provider that replays a fixed script of logical responses. Overflow entries
 * are thrown as ProviderStreamError wrapping an HTTP-400-style message — the
 * exact shape the real streaming transport produces after a non-retryable 400.
 */
class ScriptedStreamProvider extends BaseProvider {
  private ops: ScriptedOp[];
  public readonly issued: ScriptedOp[] = [];

  constructor(ops: ScriptedOp[]) {
    super();
    this.ops = [...ops];
  }

  capabilities() {
    return {
      providerType: 'ScriptedStreamProvider',
      model: 'scripted-loopback',
      nativeToolCalling: true,
      jsonSchemaOutput: false,
      streaming: true,
      thinking: false,
      maxContextTokens: 32_000,
      maxOutputTokens: 4_096,
      retryableStatusCodes: [],
    };
  }

  async complete(): Promise<NormalizedResponse> {
    throw new Error('ScriptedStreamProvider expects the streaming path');
  }

  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> {
    const op = this.ops.shift();
    if (!op) throw new Error('ScriptedStreamProvider script exhausted');
    this.issued.push(op);
    if (op.kind === 'overflow') {
      throw new ProviderStreamError(
        `Provider stream request failed: Provider error 400: ${op.message}`,
        'request',
      );
    }
    yield {
      content: op.content,
      toolCalls: undefined,
      isFinished: false,
    } as StreamChunk;
    yield {
      content: '',
      toolCalls: undefined,
      isFinished: true,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    } as StreamChunk;
  }
}

function buildWorkflow(): WorkflowDefinition {
  return {
    id: 'wf-continuity-regression',
    name: 'Continuity regression workflow',
    description: 'Three serial steps exercising overflow + acceptance retry.',
    version: '1.0.0',
    steps: [
      {
        id: 'seed',
        name: 'Seed',
        description: '',
        prompt: 'Seed the durable evidence payload.',
        inputFrom: [],
        tools: [],
        maxTurns: 6,
      },
      {
        id: 'recover',
        name: 'Recover',
        description: '',
        prompt: `Preserve ${SENTINEL} and ${EVIDENCE}. Upstream evidence:\n{{seed.output}}`,
        inputFrom: ['seed'],
        tools: [],
        maxTurns: 6,
        retry: { maxRetries: 1, onFailPrompt: 'Previous output was incomplete; include both markers.' },
        acceptanceCriteria: [
          { kind: 'contains', value: SENTINEL },
          { kind: 'contains', value: EVIDENCE },
          { kind: 'minLength', value: '80' },
        ],
      },
      {
        id: 'boundary',
        name: 'Boundary',
        description: '',
        prompt: `Report the boundary. Upstream:\n{{recover.output}}`,
        inputFrom: ['recover'],
        tools: [],
        maxTurns: 6,
      },
    ],
    dependencies: {
      seed: [],
      recover: ['seed'],
      boundary: ['recover'],
    },
  };
}

describe('workflow keeps stepping after provider context overflow', () => {
  it('completes the overflow-recovery step and runs the downstream step', async () => {
    const provider = new ScriptedStreamProvider([
      // Step "seed": single clean completion with the long evidence.
      { kind: 'content', content: LONG_EVIDENCE },
      // Step "recover", attempt 1, turn 0: initial request overflows, the
      // AgentLoop recompression retry returns a partial (acceptance-failing)
      // answer.
      { kind: 'overflow', message: OVERFLOW_REASON },
      { kind: 'content', content: PARTIAL_STEP2 },
      // Step "recover", attempt 2 (workflow acceptance retry):
      // turn 0 — initial + recovery both overflow;
      { kind: 'overflow', message: 'context length exceeded in controlled retry fixture' },
      { kind: 'overflow', message: 'context length exceeded in controlled retry fixture' },
      // turn 1 — initial overflows once more, recovery succeeds.
      { kind: 'overflow', message: 'context length exceeded in controlled retry fixture' },
      { kind: 'content', content: RECOVERED_STEP2 },
      // Step "boundary": clean completion.
      { kind: 'content', content: STEP3_OUTPUT },
    ]);

    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);
    const agent = new AgentLoop({ provider, registry, dispatcher });
    const engine = new WorkflowEngine(agent);

    const run = await engine.run(buildWorkflow(), { topic: 'continuity' });

    // The recovery step must complete via its configured acceptance retry…
    const recoverResult = run.stepResults.recover;
    expect(recoverResult?.status).toBe('completed');
    expect(recoverResult?.retryCount).toBe(1);
    expect(recoverResult?.output).toContain(SENTINEL);
    expect(recoverResult?.output).toContain(EVIDENCE);
    // …with an honestly verified final result even though the run survived
    // multiple overflow-recovery cycles (D3).
    expect(recoverResult?.agentResult?.status).toBe('completed');
    expect(recoverResult?.agentResult?.finalVerified).toBe(true);
    expect(recoverResult?.agentResult?.errors).toHaveLength(0);
    // Real overflow + recovery evidence stays in the persisted trace. The
    // final (successful) attempt saw two overflowing turns; the intermediate
    // tightened-retry miss is recorded as its own honest trace event.
    const traceEvents = recoverResult?.agentResult?.traceEvents ?? [];
    expect(traceEvents.filter((event) => event.event === 'context.overflow')).toHaveLength(2);
    expect(traceEvents.filter((event) => event.event === 'context.overflow_recovery_failed')).toHaveLength(1);

    // …and the downstream step must actually run (the original defect: the
    // Goal stalled forever before this step).
    expect(run.stepResults.boundary?.status).toBe('completed');
    expect(run.stepResults.boundary?.output).toContain(SENTINEL);
    expect(run.status).toBe('completed');

    // Exactly-once consumption of the scripted logical responses.
    expect(provider.issued).toHaveLength(8);
  });
});
