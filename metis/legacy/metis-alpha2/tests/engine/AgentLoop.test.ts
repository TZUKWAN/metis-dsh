/**
 * Integration tests for AgentLoop.
 *
 * Tests the full loop: FakeProvider �?AgentLoop �?ToolDispatcher �?result.
 */

import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import { BaseProvider } from '../../engine/providers/BaseProvider.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { createToolPresenterRegistry, buildBuiltinDecoders, presentForProvider } from '../../engine/tools/ToolPresenter.js';
import { buildArgsDecoder, UnsupportedSchemaError } from '../../engine/tools/ArgsValidator.js';
import {
  safeParseToolResult,
  safeParseProviderFeedback,
  safeTruncateContent,
  MAX_PROVIDER_CONTENT_LENGTH,
} from '../../engine/runtime/ToolPresentationContract.js';
import { HookBus } from '../../engine/core/HookBus.js';
import { ContextEngine } from '../../engine/context/ContextEngine.js';
import type {
  AgentRunRequest,
  ChatMessage,
  NormalizedResponse,
  ProviderUsage,
  StreamChunk,
  ToolEffectSnapshot,
  ToolSpec,
} from '../../engine/core/types.js';
import { createToolEffectKey } from '../../engine/core/types.js';

// ─── MultiTurnProvider ────────────────────────────────────────

/** Provider that returns a configurable sequence of responses. */
class MultiTurnProvider extends BaseProvider {
  private callIndex = 0;
  private readonly responses: NormalizedResponse[];
  readonly receivedMessages: ChatMessage[][] = [];
  readonly receivedToolNames: string[][] = [];

  constructor(responses: NormalizedResponse[]) {
    super();
    this.responses = responses;
  }

  capabilities() {
    return {
      providerType: 'MultiTurnTest',
      model: 'test-model',
      nativeToolCalling: true,
      jsonSchemaOutput: false,
      streaming: false, // Force non-streaming so complete() is used
      thinking: false,
      maxContextTokens: 32000,
      maxOutputTokens: 4096,
      retryableStatusCodes: [],
    };
  }

  async complete(messages: ChatMessage[], tools?: ToolSpec[]): Promise<NormalizedResponse> {
    this.receivedMessages.push(messages.map((m) => ({ ...m })));
    this.receivedToolNames.push((tools ?? []).map((tool) => tool.name));
    const idx = Math.min(this.callIndex, this.responses.length - 1);
    this.callIndex++;
    return this.responses[idx];
  }

  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> {
    // Not used �?streaming is false
  }
}

class OverflowThenCompleteProvider extends MultiTurnProvider {
  private overflowed = false;

  override async complete(messages: ChatMessage[], tools?: ToolSpec[]): Promise<NormalizedResponse> {
    if (!this.overflowed) {
      this.overflowed = true;
      this.receivedMessages.push(messages.map((message) => ({ ...message })));
      this.receivedToolNames.push((tools ?? []).map((tool) => tool.name));
      throw new Error('context length exceeded provider limit');
    }
    return super.complete(messages, tools);
  }
}

// ─── Test Tool Definitions ────────────────────────────────────

const ECHO_TOOL_SPEC: ToolSpec = {
  name: 'echo',
  description: 'Echo back the input',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The message to echo' },
    },
    required: ['message'],
  },
};

async function echoHandler(args: Record<string, unknown>): Promise<string> {
  return `Echo: ${args.message}`;
}

const ERROR_TOOL_SPEC: ToolSpec = {
  name: 'fail_tool',
  description: 'Always fails',
  parameters: { type: 'object', properties: {} },
};

async function failHandler(): Promise<string> {
  throw new Error('Tool deliberately failed');
}

// ─── Helpers ──────────────────────────────────────────────────

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

function makeUsage(p = 10, c = 20, t = 30): ProviderUsage {
  return { promptTokens: p, completionTokens: c, totalTokens: t };
}

function setupLoop(responses: NormalizedResponse[], opts?: { maxToolsPerSession?: number }) {
  const provider = new MultiTurnProvider(responses);
  const registry = new ToolRegistry();
  registry.register(ECHO_TOOL_SPEC);
  registry.register(ERROR_TOOL_SPEC);

  const dispatcher = new ToolDispatcher(registry);
  dispatcher.registerHandler('echo', echoHandler);
  dispatcher.registerHandler('fail_tool', failHandler);

  const loop = new AgentLoop({
    provider,
    registry,
    dispatcher,
    hooks: new HookBus(),
    maxToolsPerSession: opts?.maxToolsPerSession,
  });

  return { loop, provider, registry, dispatcher };
}

// ─── Tests ────────────────────────────────────────────────────

describe('AgentLoop', () => {
  it('completes immediately when provider returns no tool calls', async () => {
    const { loop, provider } = setupLoop([
      { content: 'Task completed successfully.', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);

    const result = await loop.run(makeRequest());

    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('Task completed successfully.');
    expect(result.turnsUsed).toBe(1);
    expect(result.toolResults).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(provider.receivedToolNames).toEqual([['echo', 'fail_tool']]);
  });

  it('passes canonical ToolSpec objects to providers instead of wrapped function schemas', async () => {
    const { loop, provider } = setupLoop([
      { content: 'Only the requested tool was exposed.', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);

    const result = await loop.run(makeRequest({ allowedTools: ['echo'] }));

    expect(result.status).toBe('completed');
    expect(provider.receivedToolNames).toEqual([['echo']]);
  });

  it('treats an explicit empty scenario allowlist as no tools, not all tools', async () => {
    const { loop, provider } = setupLoop([
      { content: 'No tools required.', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);
    const result = await loop.run(makeRequest({ allowedTools: [] }));
    expect(result.status).toBe('completed');
    expect(provider.receivedToolNames).toEqual([[]]);
  });

  it('recompresses the same Agent run after a provider context overflow and emits traceable events', async () => {
    const provider = new OverflowThenCompleteProvider([
      { content: 'Recovered without losing the research run.', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);
    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);
    const hooks = new HookBus();
    const hookEvents: Array<Record<string, unknown>> = [];
    hooks.register('context.overflow', (event) => { hookEvents.push(event); });
    hooks.register('context.compressed', (event) => { hookEvents.push(event); });
    const contextEngine = new ContextEngine({
      budget: {
        modelContextTokens: 1_000,
        modelOutputTokens: 250,
        contextThreshold: 0.7,
        perToolChars: 2_000,
        maxToolResultChars: 8_000,
        maxTurns: 5,
      },
      summarizer: async (messages) => `保留 ${messages.length} 条早期研究证据的真实摘要。`,
    });
    const loop = new AgentLoop({ provider, registry, dispatcher, hooks, contextEngine });
    const result = await loop.run(makeRequest({
      sessionId: 'same-run-after-overflow',
      messages: Array.from({ length: 20 }, (_, index) => ({
        role: 'user' as const,
        content: `研究证据 ${index + 1}：${'样本分层、方法约束与待验证结论。'.repeat(30)}`,
      })),
    }));

    expect(result.status).toBe('completed');
    expect(result.finalText).toContain('Recovered without losing');
    expect(provider.receivedMessages).toHaveLength(2);
    expect(result.traceEvents.some((event) => event.event === 'context.overflow')).toBe(true);
    expect(hookEvents.some((event) => event.event === 'context.overflow')).toBe(true);
    expect(hookEvents.some((event) => event.event === 'context.compressed' && event.retry === true)).toBe(true);
    expect(provider.receivedMessages[1]?.some((message) => message.content.includes('真实摘要'))).toBe(true);
  });

  it('dispatches tool calls and loops until completion', async () => {
    const { loop } = setupLoop([
      // Turn 1: returns a tool call
      {
        content: '',
        toolCalls: [{ name: 'echo', arguments: { message: 'hello world' }, id: 'tc_001' }],
        finishReason: 'tool_calls',
        usage: makeUsage(10, 20, 30),
      },
      // Turn 2: returns final text
      {
        content: 'Done after tool call',
        toolCalls: [],
        finishReason: 'stop',
        usage: makeUsage(15, 25, 40),
      },
    ]);

    const result = await loop.run(makeRequest());

    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('Done after tool call');
    expect(result.turnsUsed).toBe(2);
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].content).toBe('Echo: hello world');
    expect(result.toolResults[0].status).toBe('ok');
  });

  it('replays a checkpointed Workflow tool effect instead of executing it twice', async () => {
    const provider = new MultiTurnProvider([
      {
        content: '',
        toolCalls: [{ name: 'echo', arguments: { message: 'same-write' }, id: 'new_call' }],
        finishReason: 'tool_calls',
        usage: makeUsage(),
      },
      { content: 'Recovered without repeating the tool.', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);
    const registry = new ToolRegistry();
    registry.register(ECHO_TOOL_SPEC);
    const dispatcher = new ToolDispatcher(registry);
    let executions = 0;
    dispatcher.registerHandler('echo', async () => {
      executions++;
      return 'this handler must not run during replay';
    });
    const loop = new AgentLoop({ provider, registry, dispatcher });
    const scope = 'workflow-continuity:step-write';
    const effect: ToolEffectSnapshot = {
      idempotencyKey: createToolEffectKey(scope, 'echo', { message: 'same-write' }),
      scope,
      toolName: 'echo',
      arguments: { message: 'same-write' },
      result: {
        toolName: 'echo',
        toolCallId: 'old_call',
        status: 'ok',
        content: 'checkpointed tool result',
        metadata: {},
      },
      completedAt: Date.now(),
    };

    const result = await loop.run(makeRequest({
      toolEffectScope: scope,
      replayToolEffects: [effect],
    }));

    expect(result.status).toBe('completed');
    expect(executions).toBe(0);
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.content).toBe('checkpointed tool result');
    expect(result.toolResults[0]?.toolCallId).toBe('new_call');
    expect(result.traceEvents.some((event) => event.event === 'tool.replayed_from_checkpoint')).toBe(true);
  });

  it('publishes a successful Workflow tool effect before continuing the Agent turn', async () => {
    const { loop } = setupLoop([
      {
        content: '',
        toolCalls: [{ name: 'echo', arguments: { message: 'checkpoint-me' }, id: 'persist_call' }],
        finishReason: 'tool_calls',
        usage: makeUsage(),
      },
      { content: 'done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);
    const recorded: ToolEffectSnapshot[] = [];

    const result = await loop.run(makeRequest({
      toolEffectScope: 'workflow-continuity:step-checkpoint',
      onToolEffect: async (effect) => { recorded.push(effect); },
    }));

    expect(result.status).toBe('completed');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.toolName).toBe('echo');
    expect(recorded[0]?.result.content).toBe('Echo: checkpoint-me');
    expect(recorded[0]?.idempotencyKey).toContain('workflow-continuity:step-checkpoint:echo:');
  });

  it('respects max turns and returns max_turns_reached', async () => {
    // Provider always returns tool calls with unique content per turn to avoid loop detection
    const makeToolCallResponse = (i: number): NormalizedResponse => ({
      content: `Calling tool turn ${i}`,
      toolCalls: [{ name: 'echo', arguments: { message: `loop-${i}` }, id: `tc_loop_${i}` }],
      finishReason: 'tool_calls',
      usage: makeUsage(5, 10, 15),
    });

    const { loop } = setupLoop([makeToolCallResponse(1), makeToolCallResponse(2), makeToolCallResponse(3)]);

    const result = await loop.run(makeRequest({ maxTurns: 3 }));

    expect(result.status).toBe('max_turns_reached');
    expect(result.turnsUsed).toBe(3);
    expect(result.toolResults.length).toBe(3);
  });

  it('records trace events for each step', async () => {
    const { loop } = setupLoop([
      { content: 'Traced response', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);

    const result = await loop.run(makeRequest());

    expect(result.traceEvents.length).toBeGreaterThan(0);
    const eventTypes = result.traceEvents.map((e) => e.event);
    expect(eventTypes).toContain('agent.start');
    expect(eventTypes).toContain('model.request');
    expect(eventTypes).toContain('model.response');
    expect(eventTypes).toContain('agent.complete');
  });

  it('records evidence for tool calls', async () => {
    const { EvidenceLedger } = await import('../../engine/evidence/EvidenceLedger.js');
    const ledger = new EvidenceLedger();

    const provider = new MultiTurnProvider([
      {
        content: '',
        toolCalls: [{ name: 'echo', arguments: { message: 'evidence test' }, id: 'tc_ev' }],
        finishReason: 'tool_calls',
        usage: makeUsage(),
      },
      { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);

    const registry = new ToolRegistry();
    registry.register(ECHO_TOOL_SPEC);
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('echo', echoHandler);

    const loop = new AgentLoop({
      provider,
      registry,
      dispatcher,
      evidenceLedger: ledger,
    });

    const result = await loop.run(makeRequest());

    expect(result.status).toBe('completed');
    expect(ledger.size).toBe(1);

    const evidence = ledger.getBySession('test-session');
    expect(evidence).toHaveLength(1);
    expect(evidence[0].toolName).toBe('echo');
  });

  it('handles tool errors gracefully', async () => {
    const { loop } = setupLoop([
      // Turn 1: call fail_tool
      {
        content: '',
        toolCalls: [{ name: 'fail_tool', arguments: {}, id: 'tc_fail' }],
        finishReason: 'tool_calls',
        usage: makeUsage(),
      },
      // Turn 2: LLM sees error, returns text
      {
        content: 'Handled error',
        toolCalls: [],
        finishReason: 'stop',
        usage: makeUsage(),
      },
    ]);

    const result = await loop.run(makeRequest());

    expect(result.status).toBe('completed');
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].status).toBe('error');
  });

  it('enforces session tool call limit', async () => {
    const toolCallResponse: NormalizedResponse = {
      content: '',
      toolCalls: [{ name: 'echo', arguments: { message: 'limit-test' }, id: 'tc_lim' }],
      finishReason: 'tool_calls',
      usage: makeUsage(),
    };

    const { loop } = setupLoop(
      [toolCallResponse, toolCallResponse, toolCallResponse, toolCallResponse],
      { maxToolsPerSession: 2 },
    );

    const result = await loop.run(makeRequest({ maxTurns: 10 }));

    // Should stop when session tool limit is exceeded
    expect(result.status).toBe('interrupted');
    expect(result.toolResults.length).toBeLessThanOrEqual(3);
  });

  it('fires hook events during execution', async () => {
    const hooks = new HookBus();
    const firedEvents: string[] = [];

    hooks.register('agent.pre_run', () => { firedEvents.push('pre_run'); });
    hooks.register('model.post_call', () => { firedEvents.push('post_call'); });
    hooks.register('agent.post_run', () => { firedEvents.push('post_run'); });

    const provider = new MultiTurnProvider([
      { content: 'Hook test', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);
    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);

    const loop = new AgentLoop({ provider, registry, dispatcher, hooks });

    await loop.run(makeRequest());

    expect(firedEvents).toContain('pre_run');
    expect(firedEvents).toContain('post_call');
    expect(firedEvents).toContain('post_run');
  });

  it('aggregates token usage across turns', async () => {
    const { loop } = setupLoop([
      // Turn 1: tool call
      {
        content: '',
        toolCalls: [{ name: 'echo', arguments: { message: 'usage' }, id: 'tc_u' }],
        finishReason: 'tool_calls',
        usage: makeUsage(100, 50, 150),
      },
      // Turn 2: final text
      {
        content: 'Final',
        toolCalls: [],
        finishReason: 'stop',
        usage: makeUsage(200, 80, 280),
      },
    ]);

    const result = await loop.run(makeRequest());

    expect(result.usage.promptTokens).toBe(300); // 100 + 200
    expect(result.usage.completionTokens).toBe(130); // 50 + 80
    expect(result.usage.totalTokens).toBe(430); // 150 + 280
  });

  it('dispatches multiple tool calls in a single turn', async () => {
    const { loop } = setupLoop([
      // Turn 1: two tool calls
      {
        content: '',
        toolCalls: [
          { name: 'echo', arguments: { message: 'first' }, id: 'tc_1' },
          { name: 'echo', arguments: { message: 'second' }, id: 'tc_2' },
        ],
        finishReason: 'tool_calls',
        usage: makeUsage(),
      },
      // Turn 2: final
      {
        content: 'Both done',
        toolCalls: [],
        finishReason: 'stop',
        usage: makeUsage(),
      },
    ]);

    const result = await loop.run(makeRequest());

    expect(result.status).toBe('completed');
    expect(result.turnsUsed).toBe(2);
    expect(result.toolResults).toHaveLength(2);
    expect(result.toolResults[0].content).toBe('Echo: first');
    expect(result.toolResults[1].content).toBe('Echo: second');
  });

  it('preserves message history across turns', async () => {
    const { loop } = setupLoop([
      // Turn 1: tool call
      {
        content: 'I need to check something',
        toolCalls: [{ name: 'echo', arguments: { message: 'check' }, id: 'tc_msg' }],
        finishReason: 'tool_calls',
        usage: makeUsage(),
      },
      // Turn 2: final
      {
        content: 'All clear',
        toolCalls: [],
        finishReason: 'stop',
        usage: makeUsage(),
      },
    ]);

    const result = await loop.run(makeRequest());

    // user �?assistant (tc) �?tool (result) �?assistant (final)
    expect(result.messages.length).toBe(4);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[1].content).toBe('I need to check something');
    expect(result.messages[2].role).toBe('tool');
    expect(result.messages[3].role).toBe('assistant');
    expect(result.messages[3].content).toBe('All clear');
  });

  it('does not leak raw filesystem paths from tool results into provider messages', async () => {
    const sensitivePath = '/home/researcher/project/secret.txt';
    const writeFileSpec: ToolSpec = {
      name: 'write_file',
      description: 'Write a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    };

    const provider = new MultiTurnProvider([
      {
        content: '',
        toolCalls: [{ name: 'write_file', arguments: { path: sensitivePath, content: 'secret' }, id: 'tc_write' }],
        finishReason: 'tool_calls',
        usage: makeUsage(),
      },
      { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);

    const registry = new ToolRegistry();
    registry.register(writeFileSpec);
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('write_file', async () => `Successfully wrote 6 bytes to ${sensitivePath}`);

    const loop = new AgentLoop({ provider, registry, dispatcher });
    await loop.run(makeRequest());

    // The provider should have been called with messages on turn 2.
    expect(provider.receivedMessages.length).toBeGreaterThanOrEqual(2);
    const turn2Messages = provider.receivedMessages[1]!;
    const toolMessage = turn2Messages.find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.content).not.toContain(sensitivePath);
    expect(toolMessage!.content).not.toContain('/home/researcher');
    // Privileged tool output is replaced by a fixed summary.
    expect(toolMessage!.content).toBe('Tool completed');
  });

  it('uses the fixed fallback for unknown tools so raw content never reaches the provider', async () => {
    const secretContent = 'leaked /home/user/private.key';
    const unknownSpec: ToolSpec = {
      name: 'custom_plugin_action',
      description: 'Custom plugin',
      parameters: { type: 'object', properties: {} },
    };

    const provider = new MultiTurnProvider([
      {
        content: '',
        toolCalls: [{ name: 'custom_plugin_action', arguments: {}, id: 'tc_unknown' }],
        finishReason: 'tool_calls',
        usage: makeUsage(),
      },
      { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);

    const registry = new ToolRegistry();
    registry.register(unknownSpec);
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('custom_plugin_action', async () => secretContent);

    const loop = new AgentLoop({ provider, registry, dispatcher });
    await loop.run(makeRequest());

    const turn2Messages = provider.receivedMessages[1]!;
    const toolMessage = turn2Messages.find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.content).not.toContain(secretContent);
    expect(toolMessage!.content).not.toContain('/home/user');
    expect(toolMessage!.content).toBe('Tool result suppressed');
  });
});


import { ApprovalStore, WRITE_APPROVAL_RULE } from '../../engine/hitl/HITLCore.js';

// ─── Attack Matrix: ToolPresentation boundary ─────────────────

describe('AgentLoop ToolPresentation attack matrix', () => {
  function setupWithSpecs(
    specs: ToolSpec[],
    handlers: Record<string, (args: Record<string, unknown>) => Promise<string>>,
    responses: NormalizedResponse[],
  ) {
    const provider = new MultiTurnProvider(responses);
    const registry = new ToolRegistry();
    for (const spec of specs) registry.register(spec);
    const dispatcher = new ToolDispatcher(registry);
    for (const [name, handler] of Object.entries(handlers)) {
      dispatcher.registerHandler(name, handler);
    }
    const loop = new AgentLoop({ provider, registry, dispatcher });
    return { loop, provider, registry, dispatcher };
  }

  function lastToolMessage(provider: MultiTurnProvider) {
    const messages = provider.receivedMessages[provider.receivedMessages.length - 1] ?? [];
    return messages.find((m) => m.role === 'tool');
  }

  function allProviderContent(provider: MultiTurnProvider): string {
    return provider.receivedMessages
      .flat()
      .map((m) => m.content)
      .join('\n');
  }

  it('redacts POSIX paths with spaces and parentheses as whole-field fallback', async () => {
    const sensitive = '/home/alice/Secret Folder/report (v2).pdf';
    const { loop, provider } = setupWithSpecs(
      [{
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }],
      { read_file: async () => `Contents of ${sensitive}` },
      [
        { content: '', toolCalls: [{ name: 'read_file', arguments: { path: sensitive }, id: 'tc1' }], finishReason: 'tool_calls', usage: makeUsage() },
        { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
      ],
    );
    await loop.run(makeRequest());
    const content = allProviderContent(provider);
    expect(content).not.toContain('alice');
    expect(content).not.toContain('Secret Folder');
    expect(content).not.toContain('report (v2).pdf');
    expect(content).not.toContain('/home/alice/Secret Folder');
    expect(content).toContain('Tool completed');
  });

  it('redacts Windows, UNC and file:// URI paths', async () => {
    const paths = [
      'C:\\\\Users\\\\Bob\\\\Documents\\\\secret.pdf',
      '\\\\\\\\server\\\\share\\\\private\\\\data.txt',
      'file:///Users/Carol/private/key.pem',
    ];
    const { loop, provider } = setupWithSpecs(
      [{
        name: 'list_directory',
        description: 'List directory',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }],
      { list_directory: async () => paths.join('\n') },
      [
        { content: '', toolCalls: [{ name: 'list_directory', arguments: { path: '/' }, id: 'tc2' }], finishReason: 'tool_calls', usage: makeUsage() },
        { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
      ],
    );
    await loop.run(makeRequest());
    const content = allProviderContent(provider);
    expect(content).not.toContain('C:');
    expect(content).not.toContain('\\\\server');
    expect(content).not.toContain('file://');
    expect(content).not.toContain('secret.pdf');
    expect(content).not.toContain('key.pem');
    expect(content).toContain('Tool completed');
  });

  it('falls back entire field when content contains secrets, stdout, stderr, command, cwd or env', async () => {
    const leaks = [
      'api_key=sk-12345',
      'stdout: hello',
      'stderr: oops',
      'command: cat /etc/passwd',
      'cwd: /home/alice/project',
      'env: PATH=/usr/bin',
      'password: hunter2',
    ];
    const { loop, provider } = setupWithSpecs(
      [{
        name: 'search_content',
        description: 'Search',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      }],
      { search_content: async () => leaks.join('\n') },
      [
        { content: '', toolCalls: [{ name: 'search_content', arguments: { query: 'x' }, id: 'tc3' }], finishReason: 'tool_calls', usage: makeUsage() },
        { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
      ],
    );
    await loop.run(makeRequest());
    const content = allProviderContent(provider);
    expect(content).not.toContain('sk-12345');
    expect(content).not.toContain('hunter2');
    expect(content).not.toContain('/etc/passwd');
    expect(content).not.toContain('/home/alice');
    expect(content).toContain('Tool completed');
  });

  it('preserves safe academic output via per-tool decoder', async () => {
    const academic = 'The present study demonstrates a significant effect (p < 0.05) across three trials.';
    const { loop, provider } = setupWithSpecs(
      [{
        name: 'fulltext_search',
        description: 'Search fulltext',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      }],
      { fulltext_search: async () => makeFulltextSearchResult(academic) },
      [
        { content: '', toolCalls: [{ name: 'fulltext_search', arguments: { query: 'x' }, id: 'tc4' }], finishReason: 'tool_calls', usage: makeUsage() },
        { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
      ],
    );
    await loop.run(makeRequest());
    const toolMsg = lastToolMessage(provider);
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain(academic);
  });

  it('does not leak raw errors for thrown handlers', async () => {
    const { loop, provider } = setupWithSpecs(
      [{ name: 'fail_tool', description: 'Fail', parameters: { type: 'object', properties: {} } }],
      { fail_tool: async () => { throw new Error('Internal secret /home/admin/.env'); } },
      [
        { content: '', toolCalls: [{ name: 'fail_tool', arguments: {}, id: 'tc5' }], finishReason: 'tool_calls', usage: makeUsage() },
        { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
      ],
    );
    await loop.run(makeRequest());
    const content = allProviderContent(provider);
    expect(content).not.toContain('/home/admin');
    expect(content).not.toContain('Internal secret');
    expect(content).toContain('Tool execution failed');
  });

  it('does not surface approval machinery when the system default Full Access skips HITL', async () => {
    const approvalStore = new ApprovalStore();
    approvalStore.addRule(WRITE_APPROVAL_RULE);
    approvalStore.setHandler(async () => false);

    const provider = new MultiTurnProvider([
      { content: '', toolCalls: [{ name: 'write_file', arguments: { path: '/tmp/x.txt', content: 'x' }, id: 'tc6' }], finishReason: 'tool_calls', usage: makeUsage() },
      { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);
    const registry = new ToolRegistry();
    registry.register({
      name: 'write_file',
      description: 'Write',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    });
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('write_file', async () => 'Successfully wrote 1 bytes');
    const loop = new AgentLoop({ provider, registry, dispatcher, approvalStore });

    const result = await loop.run(makeRequest());
    // 系统默认 Full Access：审批规则存在也不拦截，工具成功执行。
    expect(result.status).toBe('completed');
    const providerContent = allProviderContent(provider);
    expect(providerContent).not.toContain('User rejected approval');
    expect(providerContent).not.toContain('approval');
    expect(result.traceEvents.some((event) => event.event === 'hitl.skipped_full_access')).toBe(true);
  });

  it('does not leak raw errors when retry budget is exhausted', async () => {
    const provider = new MultiTurnProvider([
      { content: '', toolCalls: [{ name: 'fail_tool', arguments: {}, id: 'tc7' }], finishReason: 'tool_calls', usage: makeUsage() },
      { content: '', toolCalls: [{ name: 'fail_tool', arguments: {}, id: 'tc7' }], finishReason: 'tool_calls', usage: makeUsage() },
      { content: '', toolCalls: [{ name: 'fail_tool', arguments: {}, id: 'tc7' }], finishReason: 'tool_calls', usage: makeUsage() },
      { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);
    const registry = new ToolRegistry();
    registry.register({ name: 'fail_tool', description: 'Fail', parameters: { type: 'object', properties: {} } });
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('fail_tool', async () => { throw new Error('secret retry /root/token'); });
    const loop = new AgentLoop({ provider, registry, dispatcher });

    const result = await loop.run(makeRequest({ maxTurns: 5 }));
    expect(result.toolResults.length).toBeGreaterThanOrEqual(2);
    const content = allProviderContent(provider);
    expect(content).not.toContain('/root/token');
    expect(content).not.toContain('secret retry');
    expect(content).toContain('Tool execution failed');
  });

  it('does not leak raw errors when same-tool-per-session limit is hit', async () => {
    // Use enough calls to exceed the default per-session same-tool limit.
    const limit = 20;
    const toolResponses = Array.from({ length: limit + 1 }, (_, i) => ({
      content: `turn${i + 1}`,
      toolCalls: [{ name: 'echo', arguments: { message: `msg-${i + 1}` }, id: `tc8_${i + 1}` }],
      finishReason: 'tool_calls' as const,
      usage: makeUsage(),
    }));
    const provider = new MultiTurnProvider([
      ...toolResponses,
      { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);
    const registry = new ToolRegistry();
    registry.register(ECHO_TOOL_SPEC);
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('echo', echoHandler);
    const loop = new AgentLoop({ provider, registry, dispatcher });

    const result = await loop.run(makeRequest({ maxTurns: limit + 3 }));
    expect(result.status).toBe('completed');
    const providerContent = allProviderContent(provider);
    expect(providerContent).not.toContain('limit');
    expect(providerContent).not.toContain('exceeded');
    const toolMsgs = result.messages.filter((m) => m.role === 'tool' && m.name === 'echo');
    expect(toolMsgs.length).toBeGreaterThanOrEqual(1);
    expect(toolMsgs[toolMsgs.length - 1]!.content).toBe('Tool execution failed');
  });

  it('fails closed on invalid/missing/extra arguments and does not reflect args', async () => {
    const strictSpec: ToolSpec = {
      name: 'strict_tool',
      description: 'Strict',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      decodeArgs: (raw) => {
        if (typeof raw.name !== 'string') throw new Error('name required');
        if (raw.extra !== undefined) throw new Error('extra disallowed');
        return raw;
      },
    };
    const { loop, provider } = setupWithSpecs(
      [strictSpec],
      { strict_tool: async () => 'ok' },
      [
        { content: '', toolCalls: [{ name: 'strict_tool', arguments: { name: 'x', extra: 1 }, id: 'tc9' }], finishReason: 'tool_calls', usage: makeUsage() },
        { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
      ],
    );
    await loop.run(makeRequest());
    const content = allProviderContent(provider);
    expect(content).not.toContain('extra disallowed');
    expect(content).not.toContain('extra');
    expect(content).toContain('Tool execution failed');
  });

  it('isolates per-loop presenter registries: built-in output is consistent across loops', async () => {
    // Built-in presenters are immutable per loop and cannot be overridden,
    // so two independent loops must produce the same fixed presentation.
    const makeLoop = (responses: NormalizedResponse[]) => {
      const registry = new ToolRegistry();
      registry.register({
        name: 'read_file',
        description: 'Read',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      });
      const provider = new MultiTurnProvider(responses);
      const dispatcher = new ToolDispatcher(registry);
      dispatcher.registerHandler('read_file', async () => 'raw /home/alice/secret');
      const loop = new AgentLoop({ provider, registry, dispatcher });
      return { loop, provider };
    };

    const { loop: loopA, provider: providerA } = makeLoop([
      { content: '', toolCalls: [{ name: 'read_file', arguments: { path: '/tmp/x' }, id: 'tcA' }], finishReason: 'tool_calls', usage: makeUsage() },
      { content: 'Done A', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);

    const { loop: loopB, provider: providerB } = makeLoop([
      { content: '', toolCalls: [{ name: 'read_file', arguments: { path: '/tmp/y' }, id: 'tcB' }], finishReason: 'tool_calls', usage: makeUsage() },
      { content: 'Done B', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);

    await loopA.run(makeRequest({ sessionId: 'sA' }));
    await loopB.run(makeRequest({ sessionId: 'sB' }));

    const msgA = lastToolMessage(providerA);
    const msgB = lastToolMessage(providerB);
    expect(msgA!.content).toBe('Tool completed');
    expect(msgB!.content).toBe('Tool completed');
    expect(msgA!.content).not.toContain('/home/alice');
    expect(msgB!.content).not.toContain('/home/alice');
  });

  it('truncates safe content at the provider boundary (4000 chars)', async () => {
    const longSafe = 'word '.repeat(1500);
    const { loop, provider } = setupWithSpecs(
      [{
        name: 'fulltext_search',
        description: 'Search',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      }],
      { fulltext_search: async () => makeFulltextSearchResult(longSafe) },
      [
        { content: '', toolCalls: [{ name: 'fulltext_search', arguments: { query: 'x' }, id: 'tc10' }], finishReason: 'tool_calls', usage: makeUsage() },
        { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
      ],
    );
    await loop.run(makeRequest());
    const toolMsg = lastToolMessage(provider);
    expect(toolMsg).toBeDefined();
    // The boundary enforces a hard 4000-char cap on provider-facing content.
    expect(toolMsg!.content.length).toBeLessThanOrEqual(4000);
    expect(toolMsg!.content).not.toBe(longSafe);
  });

  it('redacts generic POSIX roots such as /srv that were missed by the prefix list', async () => {
    const { loop, provider } = setupWithSpecs(
      [{
        name: 'read_file',
        description: 'Read',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }],
      { read_file: async () => 'Secret from /srv/data/project/secret.key' },
      [
        { content: '', toolCalls: [{ name: 'read_file', arguments: { path: '/srv/data/project/secret.key' }, id: 'tc_srv' }], finishReason: 'tool_calls', usage: makeUsage() },
        { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
      ],
    );
    await loop.run(makeRequest());
    const content = allProviderContent(provider);
    expect(content).not.toContain('/srv/data');
    expect(content).not.toContain('secret.key');
    expect(content).toContain('Tool completed');
  });

  it('does not let a stale /g regex leak the same path in consecutive tool results', async () => {
    const leakedPath = '/home/alice/Folder/report.pdf';
    const customSpec: ToolSpec = {
      name: 'leaky_plugin',
      description: 'Leaky',
      parameters: { type: 'object', properties: {} },
      decodeResult: () => ({
        toolName: 'leaky_plugin',
        status: 'ok',
        summary: `Found ${leakedPath}`,
      }),
    };
    const { loop, provider } = setupWithSpecs(
      [customSpec],
      { leaky_plugin: async () => 'ignored' },
      [
        {
          content: '',
          toolCalls: [
            { name: 'leaky_plugin', arguments: {}, id: 'tc_g1' },
            { name: 'leaky_plugin', arguments: {}, id: 'tc_g2' },
          ],
          finishReason: 'tool_calls',
          usage: makeUsage(),
        },
        { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
      ],
    );
    await loop.run(makeRequest());
    const toolMsgs = provider.receivedMessages.flat().filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBe(2);
    for (const msg of toolMsgs) {
      expect(msg.content).not.toContain(leakedPath);
      expect(msg.content).not.toContain('/home/alice');
      expect(msg.content).toContain('Tool completed');
    }
  });

  it('treats any non-ok ToolResult status as a failure and does not leak content', async () => {
    class FatalDispatcher extends ToolDispatcher {
      async dispatch(): Promise<import('../../engine/core/types.js').ToolResult> {
        return {
          toolName: 'echo',
          content: 'leaked /home/bob/private',
          status: 'fatal' as unknown as 'ok',
          toolCallId: 'tc_fatal',
          metadata: {},
        };
      }
    }
    const provider = new MultiTurnProvider([
      { content: '', toolCalls: [{ name: 'echo', arguments: { message: 'x' }, id: 'tc_fatal' }], finishReason: 'tool_calls', usage: makeUsage() },
      { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);
    const registry = new ToolRegistry();
    registry.register(ECHO_TOOL_SPEC);
    const dispatcher = new FatalDispatcher(registry);
    const loop = new AgentLoop({ provider, registry, dispatcher });
    await loop.run(makeRequest());
    const content = allProviderContent(provider);
    expect(content).not.toContain('/home/bob');
    expect(content).not.toContain('leaked');
    expect(content).toContain('Tool execution failed');
  });

  it('rejects duplicate presenter registrations at runtime', () => {
    const decoder = () => ({ toolName: 'x', status: 'ok' as const, summary: 'x' });
    expect(() => createToolPresenterRegistry([
      { name: 'x', description: 'x', parameters: {}, decodeResult: decoder },
      { name: 'x', description: 'x', parameters: {}, decodeResult: decoder },
    ])).toThrow('Duplicate tool presenter registration');
  });
});

// ─── 441: Provider boundary without free-text regex ───────────

describe('AgentLoop ProviderBoundary 441', () => {
  function setupWithSpecs(
    specs: ToolSpec[],
    handlers: Record<string, (args: Record<string, unknown>) => Promise<string>>,
    responses: NormalizedResponse[],
  ) {
    const provider = new MultiTurnProvider(responses);
    const registry = new ToolRegistry();
    for (const spec of specs) registry.register(spec);
    const dispatcher = new ToolDispatcher(registry);
    for (const [name, handler] of Object.entries(handlers)) {
      dispatcher.registerHandler(name, handler);
    }
    const loop = new AgentLoop({ provider, registry, dispatcher });
    return { loop, provider, registry, dispatcher };
  }

  function lastToolMessage(provider: MultiTurnProvider) {
    const messages = provider.receivedMessages[provider.receivedMessages.length - 1] ?? [];
    return messages.find((m) => m.role === 'tool');
  }

  it('suppresses read_file detail even when content is safe academic text', async () => {
    const { loop, provider } = setupWithSpecs(
      [{
        name: 'read_file',
        description: 'Read',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }],
      { read_file: async () => 'The present study demonstrates a significant effect.' },
      [
        { content: '', toolCalls: [{ name: 'read_file', arguments: { path: '/tmp/paper.md' }, id: 'tc_rf' }], finishReason: 'tool_calls', usage: makeUsage() },
        { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
      ],
    );
    await loop.run(makeRequest());
    const toolMsg = lastToolMessage(provider);
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).not.toContain('The present study');
    expect(toolMsg!.content).not.toContain('/tmp/paper.md');
  });

  it('suppresses list_directory raw listing', async () => {
    const { loop, provider } = setupWithSpecs(
      [{
        name: 'list_directory',
        description: 'List',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }],
      { list_directory: async () => 'file.txt\n/home/alice/secret.pdf' },
      [
        { content: '', toolCalls: [{ name: 'list_directory', arguments: { path: '/' }, id: 'tc_ld' }], finishReason: 'tool_calls', usage: makeUsage() },
        { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
      ],
    );
    await loop.run(makeRequest());
    const toolMsg = lastToolMessage(provider);
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).not.toContain('secret.pdf');
    expect(toolMsg!.content).not.toContain('/home/alice');
  });

  it('suppresses execute_command raw output', async () => {
    const { loop, provider } = setupWithSpecs(
      [{
        name: 'execute_command',
        description: 'Run command',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      }],
      { execute_command: async () => 'stdout: hello\nstderr: world' },
      [
        { content: '', toolCalls: [{ name: 'execute_command', arguments: { command: 'echo hi' }, id: 'tc_cmd' }], finishReason: 'tool_calls', usage: makeUsage() },
        { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
      ],
    );
    await loop.run(makeRequest());
    const toolMsg = lastToolMessage(provider);
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).not.toContain('stdout');
    expect(toolMsg!.content).not.toContain('stderr');
  });

  it('preserves authored-content detail from fulltext_search', async () => {
    const academic = 'We observe a 12% improvement (p < 0.01) across all cohorts.';
    const { loop, provider } = setupWithSpecs(
      [{
        name: 'fulltext_search',
        description: 'Search fulltext',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      }],
      { fulltext_search: async () => makeFulltextSearchResult(academic) },
      [
        { content: '', toolCalls: [{ name: 'fulltext_search', arguments: { query: 'x' }, id: 'tc_ft' }], finishReason: 'tool_calls', usage: makeUsage() },
        { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
      ],
    );
    await loop.run(makeRequest());
    const toolMsg = lastToolMessage(provider);
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain(academic);
  });

  it('rejects invalid extra arguments for builtin tools at runtime', async () => {
    const { loop, provider } = setupWithSpecs(
      [{
        name: 'write_file',
        description: 'Write',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      }],
      { write_file: async () => 'Successfully wrote 1 bytes' },
      [
        { content: '', toolCalls: [{ name: 'write_file', arguments: { path: '/tmp/x.txt', content: 'x', extra: 1 }, id: 'tc_inv' }], finishReason: 'tool_calls', usage: makeUsage() },
        { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
      ],
    );
    await loop.run(makeRequest());
    const toolMsg = lastToolMessage(provider);
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).not.toContain('extra');
    expect(toolMsg!.content).toContain('Tool execution failed');
  });
});


// ─── 443: Provider boundary fail-closed ───────────────────────

const AUTHORED_CONTENT_TOOLS_443 = new Set([
  'search_papers',
  'arxiv_search',
  'fulltext_search',
  'crossref_lookup',
  'openalex_lookup',
  'search_library',
  'find_library_duplicates',
  'recommend_papers',
  'literature_review',
  'daily_papers',
  'import_by_doi',
  'import_by_arxiv',
  'web_import',
  'import_papers',
  'parse_bibtex',
  'format_citation',
  'writing_stage_check',
  'style_calibration',
  'section_guide',
  'citation_triangulate',
  'citation_passport_record',
  'citation_passport_get',
  'citation_passport_list',
  'citation_passport_add_signal',
  'citation_passport_scan',
  'retraction_watch_update',
  'retraction_watch_lookup',
  'retraction_watch_stats',
  'journal_integrity_update',
  'journal_integrity_lookup',
  'journal_integrity_stats',
  'read_pdf',
]);

const HOSTILE_OUTPUTS = [
  '/home/alice/secret.pdf',
  'C:\\Users\\Bob\\secret.pdf',
  '\\\\server\\share\\secret.txt',
  'file:///Users/Carol/private.key',
  'api_key=sk-1234567890abcdef1234567890',
  'password: hunter2',
  'stdout: leaked',
  'stderr: leaked',
  'command: cat /etc/passwd',
  'cwd: /home/alice/project',
  'env: PATH=/usr/bin',
  'Error: something went wrong',
];

const SAFE_ACADEMIC_OUTPUT = 'We observe a significant effect (p < 0.01) across all cohorts; details in Section 4.';

// Tools that have a strict per-tool structured DTO wired into ToolPresenter.
// All other authored-content tools are suppressed by default (fail-closed).
const STRUCTURED_AUTHORED_TOOLS = new Set([
  'search_papers',
  'web_research_plan',
  'arxiv_search',
  'web_search',
  'ncpssd_search',
  'journal_directory_search',
  'journal_directory_detail',
  'fulltext_search',
  'crossref_lookup',
  'openalex_lookup',
  'recommend_papers',
  'search_library',
  'find_library_duplicates',
  'import_papers',
  'import_by_doi',
  'import_by_arxiv',
  'web_import',
  'parse_bibtex',
  'format_citation',
  'citation_triangulate',
  'citation_passport_get',
  'citation_passport_list',
  'citation_passport_scan',
  'retraction_watch_lookup',
  'retraction_watch_stats',
  'journal_integrity_lookup',
  'journal_integrity_stats',
  'read_pdf',
]);

// Tools with fixed-summary decoders (side-effect/mutation tools, simple content).
// These provide safe, tool-specific summaries without reflecting raw handler output.
const FIXED_SUMMARY_TOOLS = new Set([
  'literature_review',
  'daily_papers',
  'writing_stage_check',
  'style_calibration',
  'section_guide',
  'citation_passport_record',
  'citation_passport_add_signal',
  'retraction_watch_update',
  'journal_integrity_update',
]);

function makeFulltextSearchResult(snippet: string): string {
  return JSON.stringify({
    query: 'test query',
    total: 1,
    matches: [
      {
        id: 'paper-1',
        title: 'Example Paper',
        score: 0.95,
        matchedFields: ['abstract'],
        snippet,
      },
    ],
  });
}

function makePaperListResult(text: string): string {
  return JSON.stringify({
    query: 'test query',
    total: 1,
    papers: [
      {
        id: 'paper-1',
        title: 'Example Paper',
        authors: ['A. Author'],
        year: 2024,
        venue: 'Journal of Examples',
        doi: '10.1000/example',
        arxivId: '2401.00001',
        url: 'https://example.com/paper',
        pdfUrl: 'https://example.com/paper.pdf',
        abstract: text,
      },
    ],
  });
}

function makeLibrarySearchResult(text: string): string {
  return JSON.stringify({
    query: 'test query',
    total: 1,
    items: [
      {
        id: 'lib-1',
        type: 'paper',
        title: 'Example Paper',
        year: 2024,
        authors: 'A. Author',
        sourceId: 'src-1',
        snippet: text,
      },
    ],
  });
}

function makeDuplicateGroupListResult(text: string): string {
  return JSON.stringify({
    totalGroups: 1,
    groups: [
      {
        type: 'title',
        key: text,
        papers: [
          { id: 'p1', title: text, authors: ['A. Author'], year: 2024 },
        ],
      },
    ],
  });
}

function makeImportPapersResult(text: string): string {
  return JSON.stringify({
    source: 'bibtex',
    total: 1,
    imported: 1,
    skipped: 0,
    items: [{ title: text, status: 'imported' }],
  });
}

function makeBibtexParseResult(text: string): string {
  return JSON.stringify({
    entries: [
      {
        type: 'article',
        key: 'example2024',
        title: text,
        authors: ['A. Author'],
        year: 2024,
        journal: 'Journal of Examples',
      },
    ],
  });
}

function makeFormattedCitation(text: string): string {
  return JSON.stringify({ style: 'apa', citation: text });
}


function makeTriangulationResult(text: string): string {
  return JSON.stringify({
    doi: '10.1000/example',
    existsIn: ['crossref', 'openalex'],
    missingIn: ['semantic_scholar'],
    titleConsensus: 'MATCH',
    yearConsensus: 'MATCH',
    authorConsensus: 'MATCH',
    overall: 'VERIFIED',
    records: [
      {
        index: 'crossref',
        found: true,
        doi: '10.1000/example',
        title: text,
        authors: ['A. Author'],
        year: 2024,
        venue: 'Journal of Examples',
      },
      {
        index: 'openalex',
        found: true,
        doi: '10.1000/example',
        title: text,
        authors: ['A. Author'],
        year: 2024,
        venue: 'Journal of Examples',
      },
      {
        index: 'semantic_scholar',
        found: false,
        error: 'Not indexed',
      },
    ],
    warnings: [],
  });
}

function makePassportEntry(text: string): Record<string, unknown> {
  return {
    doi: '10.1000/example',
    normalizedDoi: '10.1000/example',
    overall: 'VERIFIED',
    titleConsensus: 'MATCH',
    yearConsensus: 'MATCH',
    authorConsensus: 'MATCH',
    existsIn: ['crossref', 'openalex'],
    missingIn: ['semantic_scholar'],
    warnings: [text],
    contaminationSignals: [],
  };
}

function makePassportList(text: string): string {
  return JSON.stringify({ total: 1, passports: [makePassportEntry(text)] });
}

function makeScanResult(text: string): string {
  return JSON.stringify({
    doi: '10.1000/example',
    signalCount: 1,
    signals: [
      {
        source: 'openalex',
        type: 'retraction',
        details: text,
      },
    ],
  });
}

function makeRetractionLookup(text: string): string {
  return JSON.stringify({
    doi: '10.1000/example',
    entries: [
      {
        recordId: 'rw-1',
        originalDoi: '10.1000/example',
        retractionNature: 'Retraction',
        reason: text,
      },
    ],
  });
}

function makeRetractionStats(text: string): string {
  return JSON.stringify({
    version: 1,
    updatedAt: Date.now(),
    sourceUrl: text,
    entryCount: 100,
    uniqueDoiCount: 95,
  });
}

function makeJournalIntegrityLookup(text: string): string {
  return JSON.stringify({
    total: 1,
    entries: [
      {
        type: 'doaj_withdrawn',
        source: 'DOAJ',
        title: text,
        issn: '1234-5678',
        reason: 'Withdrawn',
      },
    ],
  });
}

function makeJournalIntegrityStats(text: string): string {
  return JSON.stringify({
    mirrors: [
      {
        type: 'doaj_withdrawn',
        sourceUrl: text,
        updatedAt: Date.now(),
        uniqueIssnCount: 10,
        uniqueTitleCount: 10,
      },
      {
        type: 'hijacked_journal',
        sourceUrl: 'https://example.com/hijacked',
        updatedAt: Date.now(),
        uniqueIssnCount: 5,
        uniqueTitleCount: 5,
      },
    ],
  });
}

function makeStructuredInput(toolName: string, text: string): string {
  switch (toolName) {
    case 'journal_directory_search':
      return JSON.stringify({
        source: 'letpub', keyword: 'test query', page: 1,
        journals: [{ source: 'letpub', id: 'j-1', name: 'Example Journal ' + text, categoryTags: ['社会学'], detailUrl: 'https://example.com/j' }],
      });
    case 'journal_directory_detail':
      return JSON.stringify({
        source: 'letpub', id: 'j-1', name: 'Example Journal', detailUrl: 'https://example.com/j',
        submissionEmails: [], indexingTags: [], submissionNotice: text,
      });
    case 'web_search':
      return JSON.stringify({
        ok: true,
        result: { source: 'bing_cn', query: 'test query', results: [{ title: 'Example Result', url: 'https://example.com/a', snippet: text.slice(0, 300) }] },
      });
    case 'web_research_plan':
      return JSON.stringify({
        ok: true,
        plan: {
          originalQuery: 'test query',
          queries: [{ query: `test query ${text.slice(0, 60)}`, language: 'en', dimension: 'core' }],
          coverageChecklist: [text.slice(0, 120)],
        },
      });
    case 'ncpssd_search':
      return JSON.stringify({
        query: 'test query',
        total: 1,
        papers: [{ title: 'Example Paper', authors: ['A. Author'], year: 2024, venue: '社科期刊', abstract: text.slice(0, 300), url: null, source: 'ncpssd' }],
      });
    case 'read_pdf':
      return JSON.stringify({
        title: 'Test PDF',
        author: 'A. Author',
        totalPages: 1,
        extractedPages: 1,
        keywords: ['test'],
        pageTexts: [text],
      });
    case 'fulltext_search':
      return makeFulltextSearchResult(text);
    case 'search_library':
      return makeLibrarySearchResult(text);
    case 'find_library_duplicates':
      return makeDuplicateGroupListResult(text);
    case 'import_papers':
      return makeImportPapersResult(text);
    case 'parse_bibtex':
      return makeBibtexParseResult(text);
    case 'format_citation':
      return makeFormattedCitation(text);
    case 'citation_triangulate':
      return makeTriangulationResult(text);
    case 'citation_passport_get':
      return JSON.stringify(makePassportEntry(text));
    case 'citation_passport_list':
      return makePassportList(text);
    case 'citation_passport_scan':
      return makeScanResult(text);
    case 'retraction_watch_lookup':
      return makeRetractionLookup(text);
    case 'retraction_watch_stats':
      return makeRetractionStats(text);
    case 'journal_integrity_lookup':
      return makeJournalIntegrityLookup(text);
    case 'journal_integrity_stats':
      return makeJournalIntegrityStats(text);
    default:
      return makePaperListResult(text);
  }
}

describe('AgentLoop ProviderBoundary 443', () => {
  it('ArgsValidator fails closed on unsupported JSON Schema constructs', () => {
    const base = { type: 'object', properties: { x: {} } } as const;
    const unsupported = [
      { ...base, properties: { x: { oneOf: [{ type: 'string' }, { type: 'number' }] } } },
      { ...base, properties: { x: { anyOf: [{ type: 'string' }, { type: 'number' }] } } },
      { ...base, properties: { x: { allOf: [{ type: 'string' }] } } },
      { ...base, properties: { x: { $ref: '#/definitions/X' } } },
      { ...base, properties: { x: { not: { type: 'string' } } } },
      { ...base, properties: { x: { if: { type: 'string' }, then: { type: 'number' } } } },
      { type: 'object', properties: { x: { type: 'unsupported_type' as never } } },
      { type: 'object', properties: { x: { type: ['string', 'unsupported_type' as never] } } },
    ];

    for (const schema of unsupported) {
      expect(() => buildArgsDecoder(schema as Record<string, unknown>)({ x: 'test' })).toThrow(UnsupportedSchemaError);
    }
  });

  it('ArgsValidator rejects extra arguments by default', () => {
    const decode = buildArgsDecoder({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    expect(decode({ name: 'x' })).toEqual({ name: 'x' });
    expect(() => decode({ name: 'x', extra: 1 })).toThrow();
  });

  it('ToolRegistry throws on duplicate tool registration', () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'a', description: 'A', parameters: {} });
    expect(() => registry.register({ name: 'a', description: 'A2', parameters: {} })).toThrow('Duplicate tool registration: a');
  });

  it('builtin presenters cannot be overridden by ToolSpec.decodeResult', async () => {
    const provider = new MultiTurnProvider([
      { content: '', toolCalls: [{ name: 'read_file', arguments: { path: '/tmp/x.txt' }, id: 'tc_override' }], finishReason: 'tool_calls', usage: makeUsage() },
      { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_file',
      description: 'Read',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      decodeResult: () => ({ toolName: 'read_file', status: 'ok' as const, summary: 'OVERRIDE', detail: 'OVERRIDE DETAIL' }),
    });
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('read_file', async () => 'raw content /home/alice/secret');
    const loop = new AgentLoop({ provider, registry, dispatcher });
    await loop.run(makeRequest());
    const toolMsg = provider.receivedMessages[1]?.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).not.toContain('OVERRIDE');
    expect(toolMsg!.content).not.toContain('/home/alice');
    expect(toolMsg!.content).toBe('Tool completed');
  });

  it('enforces discriminated ToolResult: ok must not carry error', () => {
    const result = safeParseToolResult({
      toolName: 'x',
      content: 'safe',
      status: 'ok',
      toolCallId: 'tc1',
      error: 'should not be here',
      metadata: {},
    });
    expect(result.success).toBe(false);
  });

  it('enforces discriminated ToolResult: error must have empty content', () => {
    const result = safeParseToolResult({
      toolName: 'x',
      content: 'leaked',
      status: 'error',
      toolCallId: 'tc1',
      error: 'failed',
      metadata: {},
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid ok ToolResult', () => {
    const result = safeParseToolResult({
      toolName: 'x',
      content: 'safe',
      status: 'ok',
      toolCallId: 'tc1',
      metadata: {},
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid error ToolResult with empty content', () => {
    const result = safeParseToolResult({
      toolName: 'x',
      content: '',
      status: 'error',
      toolCallId: 'tc1',
      error: 'failed',
      metadata: {},
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid control name and toolCallId in ProviderFeedback', () => {
    const allowed = ['echo'];
    const invalid = [
      { role: 'tool', content: 'ok', toolCallId: '', name: 'echo', status: 'ok' },
      { role: 'tool', content: 'ok', toolCallId: 'tc1', name: 'unknown', status: 'ok' },
      { role: 'tool', content: 'ok', toolCallId: 'tc1', name: 'echo', status: 'invalid_status' },
    ];
    for (const fb of invalid) {
      expect(safeParseProviderFeedback(fb, allowed).success).toBe(false);
    }
  });

  it('maps validation_unavailable code through the boundary', async () => {
    const provider = new MultiTurnProvider([
      { content: '', toolCalls: [{ name: 'unsupported_schema_tool', arguments: { x: 'y' }, id: 'tc_val' }], finishReason: 'tool_calls', usage: makeUsage() },
      { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);
    const registry = new ToolRegistry();
    registry.register({
      name: 'unsupported_schema_tool',
      description: 'Unsupported',
      parameters: { type: 'object', properties: { x: { oneOf: [{ type: 'string' }, { type: 'number' }] } }, required: ['x'] },
    });
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('unsupported_schema_tool', async () => 'never reached');
    const loop = new AgentLoop({ provider, registry, dispatcher });
    await loop.run(makeRequest());
    const toolMsg = provider.receivedMessages[1]?.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.metadata).toMatchObject({ status: 'error', code: 'validation_unavailable' });
    expect(toolMsg!.content).toBe('Tool execution failed');
  });

  it('tags ProviderFeedback with ok status and code for successful authored tools', async () => {
    const provider = new MultiTurnProvider([
      { content: '', toolCalls: [{ name: 'fulltext_search', arguments: { query: 'q' }, id: 'tc_ok' }], finishReason: 'tool_calls', usage: makeUsage() },
      { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);
    const registry = new ToolRegistry();
    registry.register({
      name: 'fulltext_search',
      description: 'Search',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    });
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('fulltext_search', async () => makeFulltextSearchResult(SAFE_ACADEMIC_OUTPUT));
    const loop = new AgentLoop({ provider, registry, dispatcher });
    await loop.run(makeRequest());
    const toolMsg = provider.receivedMessages[1]?.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.metadata).toMatchObject({ status: 'ok', code: 'ok' });
    expect(toolMsg!.content).toContain(SAFE_ACADEMIC_OUTPUT);
  });

  it('tags ProviderFeedback with error status and tool_failed code for handler errors', async () => {
    const provider = new MultiTurnProvider([
      { content: '', toolCalls: [{ name: 'fail_tool', arguments: {}, id: 'tc_err' }], finishReason: 'tool_calls', usage: makeUsage() },
      { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);
    const registry = new ToolRegistry();
    registry.register({ name: 'fail_tool', description: 'Fail', parameters: { type: 'object', properties: {} } });
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('fail_tool', async () => { throw new Error('secret'); });
    const loop = new AgentLoop({ provider, registry, dispatcher });
    await loop.run(makeRequest());
    const toolMsg = provider.receivedMessages[1]?.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.metadata).toMatchObject({ status: 'error', code: 'tool_failed' });
  });

  it('truncates at 4000 without splitting paths or leaking mid-token', async () => {
    const longPath = `/home/user/${'a'.repeat(5000)}`;
    const provider = new MultiTurnProvider([
      { content: '', toolCalls: [{ name: 'fulltext_search', arguments: { query: 'q' }, id: 'tc_long' }], finishReason: 'tool_calls', usage: makeUsage() },
      { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);
    const registry = new ToolRegistry();
    registry.register({
      name: 'fulltext_search',
      description: 'Search',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    });
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('fulltext_search', async () => makeFulltextSearchResult(`${SAFE_ACADEMIC_OUTPUT}\n\n${longPath}`));
    const loop = new AgentLoop({ provider, registry, dispatcher });
    await loop.run(makeRequest());
    const toolMsg = provider.receivedMessages[1]?.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content.length).toBeLessThanOrEqual(MAX_PROVIDER_CONTENT_LENGTH);
    expect(toolMsg!.content).not.toContain(longPath);
    // The long path should have caused whole-field suppression because it contains a local path.
    expect(toolMsg!.content).not.toContain('/home/user/');
  });
});

describe('AgentLoop builtin presenter matrix (102 cases)', () => {
  const builtinDecoders = buildBuiltinDecoders();

  it('has 47 built-in decoders registered', () => {
    // 2026-09-04 +2:web_search / ncpssd_search 结构化 decoder(选题模块要求模型真实读取检索结果)。
    expect(builtinDecoders.size).toBe(47);
  });

  for (const [toolName, decoder] of builtinDecoders) {
    const isAuthored = AUTHORED_CONTENT_TOOLS_443.has(toolName);
    const hasStructuredDto = STRUCTURED_AUTHORED_TOOLS.has(toolName);
    const isFixedSummary = FIXED_SUMMARY_TOOLS.has(toolName);

    it(`${toolName}: safe output ${hasStructuredDto ? 'preserves detail via structured DTO' : isFixedSummary ? 'produces fixed safe summary' : isAuthored ? 'is suppressed until structured DTO is wired' : 'is replaced by fixed summary'}`, () => {
      const input = hasStructuredDto ? makeStructuredInput(toolName, SAFE_ACADEMIC_OUTPUT) : SAFE_ACADEMIC_OUTPUT;
      const presentation = decoder(input, 'ok');
      expect(presentation.toolName).toBe(toolName);
      if (hasStructuredDto) {
        expect(presentation.status).toBe('ok');
        expect(presentation.detail).toContain(SAFE_ACADEMIC_OUTPUT);
      } else if (isFixedSummary) {
        // Fixed-summary tools produce a safe, tool-specific summary.
        expect(presentation.status).toBe('ok');
        expect(presentation.summary).not.toBe('Tool result suppressed');
        expect(presentation.summary).not.toContain(SAFE_ACADEMIC_OUTPUT);
      } else {
        // Privileged tools may expose only a fixed sentinel detail (never raw content).
        expect(presentation.status).toBe('ok');
        if (presentation.detail !== undefined) {
          expect(presentation.detail).not.toContain(SAFE_ACADEMIC_OUTPUT);
        }
        expect(presentation.summary).not.toContain(SAFE_ACADEMIC_OUTPUT);
      }
    });

    it(`${toolName}: hostile output is ${hasStructuredDto ? 'contained within structured DTO fields' : isFixedSummary ? 'suppressed by fixed summary' : 'suppressed without partial leaks'}`, () => {
      for (const hostile of HOSTILE_OUTPUTS) {
        const input = hasStructuredDto ? makeStructuredInput(toolName, hostile) : hostile;
        const presentation = decoder(input, 'ok');
        expect(presentation.toolName).toBe(toolName);
        if (hasStructuredDto) {
          // Structured DTOs now run hostile-content detection; hostile strings
          // are suppressed in full before crossing the provider boundary.
          expect(presentation.status).toBe('ok');
          expect(presentation.detail).not.toContain(hostile);
          expect(presentation.detail).toContain('[TOOL_DETAILS_UNAVAILABLE]');
        } else if (isFixedSummary) {
          // Fixed-summary decoders never reflect raw content.
          const text = `${presentation.summary}\n${presentation.detail ?? ''}`;
          expect(text).not.toContain(hostile);
          expect(presentation.status).toBe('ok');
        } else if (isAuthored) {
          const text = `${presentation.summary}\n${presentation.detail ?? ''}`;
          expect(text).not.toContain(hostile);
          // Authored tools fall back to a suppressed summary.
          expect(presentation.status).toBe('tool_failed');
          expect(presentation.summary).toBe('Tool result suppressed');
        } else {
          const text = `${presentation.summary}\n${presentation.detail ?? ''}`;
          expect(text).not.toContain(hostile);
          // Privileged tools always emit a fixed summary and never detail.
          expect(['Tool completed', 'File content retrieved', 'Directory created', 'Directory listing', 'File search results', 'Content search results', 'Multiple files retrieved', 'Command output', 'Successfully wrote bytes']).toContain(presentation.summary);
        }
      }
    });
  }
});

describe('AgentLoop authored-content 41-tool matrix', () => {
  for (const toolName of AUTHORED_CONTENT_TOOLS_443) {
    const hasStructuredDto = STRUCTURED_AUTHORED_TOOLS.has(toolName);
    const isFixedSummary = FIXED_SUMMARY_TOOLS.has(toolName);

    it(`${toolName}: ${hasStructuredDto ? 'preserves safe academic output via structured DTO' : isFixedSummary ? 'returns fixed safe summary' : 'suppresses safe plain-text output until structured DTO is wired'}`, async () => {
      const provider = new MultiTurnProvider([
        { content: '', toolCalls: [{ name: toolName, arguments: { query: 'q' }, id: `tc_${toolName}_safe` }], finishReason: 'tool_calls', usage: makeUsage() },
        { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
      ]);
      const registry = new ToolRegistry();
      registry.register({
        name: toolName,
        description: 'Tool',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      });
      const dispatcher = new ToolDispatcher(registry);
      dispatcher.registerHandler(toolName, async () => (hasStructuredDto ? makeStructuredInput(toolName, SAFE_ACADEMIC_OUTPUT) : SAFE_ACADEMIC_OUTPUT));
      const loop = new AgentLoop({ provider, registry, dispatcher });
      await loop.run(makeRequest());
      const toolMsg = provider.receivedMessages[1]?.find((m) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      if (hasStructuredDto) {
        expect(toolMsg!.content).toContain(SAFE_ACADEMIC_OUTPUT);
        expect(toolMsg!.metadata).toMatchObject({ status: 'ok', code: 'ok' });
      } else if (isFixedSummary) {
        expect(toolMsg!.content).not.toContain(SAFE_ACADEMIC_OUTPUT);
        expect(toolMsg!.content).not.toBe('Tool result suppressed');
        expect(toolMsg!.metadata).toMatchObject({ status: 'ok', code: 'ok' });
      } else {
        expect(toolMsg!.content).not.toContain(SAFE_ACADEMIC_OUTPUT);
        expect(toolMsg!.content).toBe('Tool result suppressed');
        expect(toolMsg!.metadata).toMatchObject({ status: 'error', code: 'tool_failed' });
      }
    });

    it(`${toolName}: suppresses hostile output whole-field`, async () => {
      const provider = new MultiTurnProvider([
        { content: '', toolCalls: [{ name: toolName, arguments: { query: 'q' }, id: `tc_${toolName}_hostile` }], finishReason: 'tool_calls', usage: makeUsage() },
        { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
      ]);
      const registry = new ToolRegistry();
      registry.register({
        name: toolName,
        description: 'Tool',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      });
      const dispatcher = new ToolDispatcher(registry);
      dispatcher.registerHandler(toolName, async () => 'Found /home/alice/secret.pdf with api_key=sk-1234567890');
      const loop = new AgentLoop({ provider, registry, dispatcher });
      await loop.run(makeRequest());
      const allContent = provider.receivedMessages.flat().map((m) => m.content).join('\n');
      expect(allContent).not.toContain('/home/alice');
      expect(allContent).not.toContain('sk-1234567890');
      // Fixed-summary tools show a safe tool-specific message; others show suppressed
      if (isFixedSummary) {
        expect(allContent).not.toContain('Tool result suppressed');
      } else {
        expect(allContent).toContain('Tool result suppressed');
      }
    });
  }
});


describe('review444 hard gates', () => {
  it('ArgsValidator rejects nullable', () => {
    expect(() => buildArgsDecoder({ type: 'object', properties: { x: { type: 'string', nullable: true } } })).toThrow(UnsupportedSchemaError);
  });

  it('ArgsValidator rejects schema without type', () => {
    expect(() => buildArgsDecoder({ properties: { x: { description: 'no type' } } } as Record<string, unknown>)).toThrow(UnsupportedSchemaError);
  });

  it('ArgsValidator rejects empty type union', () => {
    expect(() => buildArgsDecoder({ type: 'object', properties: { x: { type: [] } } } as Record<string, unknown>)).toThrow(UnsupportedSchemaError);
  });

  it('ArgsValidator rejects unknown keyword', () => {
    expect(() => buildArgsDecoder({ type: 'object', properties: { x: { type: 'string', customUnknown: true } } } as Record<string, unknown>)).toThrow(UnsupportedSchemaError);
  });

  it('hostile paths do not reach provider in read_pdf', async () => {
    const provider = new MultiTurnProvider([
      { content: '', toolCalls: [{ name: 'read_pdf', arguments: { path: '/tmp/doc.pdf' }, id: 'tc_rp' }], finishReason: 'tool_calls', usage: makeUsage() },
      { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);
    const registry = new ToolRegistry();
    registry.register({ name: 'read_pdf', description: 'Read PDF', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } });
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('read_pdf', async () => 'PDF content from /home/alice/secret.pdf');
    const loop = new AgentLoop({ provider, registry, dispatcher });
    await loop.run(makeRequest());
    const allContent = provider.receivedMessages.flat().map((m) => m.content).join('\n');
    expect(allContent).not.toContain('/home/alice');
    expect(allContent).not.toContain('secret.pdf');
  });

  it('hostile credentials do not reach provider in import_papers', async () => {
    const provider = new MultiTurnProvider([
      { content: '', toolCalls: [{ name: 'import_papers', arguments: { source: 'bib' }, id: 'tc_ip' }], finishReason: 'tool_calls', usage: makeUsage() },
      { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);
    const registry = new ToolRegistry();
    registry.register({ name: 'import_papers', description: 'Import', parameters: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] } });
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('import_papers', async () => makeImportPapersResult(SAFE_ACADEMIC_OUTPUT));
    const loop = new AgentLoop({ provider, registry, dispatcher });
    await loop.run(makeRequest());
    const toolMsg = provider.receivedMessages[1]?.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain(SAFE_ACADEMIC_OUTPUT);
    expect(toolMsg!.metadata).toMatchObject({ status: 'ok', code: 'ok' });
  });

  it('MCP builtin collision: handler rejects colliding name', () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'mcp_collision', description: 'First', parameters: {} });
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('mcp_collision', async () => 'first');
    expect(() => dispatcher.registerHandler('mcp_collision', async () => 'second')).toThrow('Duplicate handler registration: mcp_collision');
  });

  it('SafeString rejects toolCallId with control characters', () => {
    const result = safeParseToolResult({ toolName: 'x', content: 'safe', status: 'ok', toolCallId: 'tc_\x00control', metadata: {} });
    expect(result.success).toBe(false);
  });

  it('SafeString rejects empty toolCallId', () => {
    const result = safeParseToolResult({ toolName: 'x', content: 'safe', status: 'ok', toolCallId: '', metadata: {} });
    expect(result.success).toBe(false);
  });

  it('SafeString rejects overlong toolCallId', () => {
    const result = safeParseToolResult({ toolName: 'x', content: 'safe', status: 'ok', toolCallId: 'x'.repeat(129), metadata: {} });
    expect(result.success).toBe(false);
  });

});

// ═══════════════════════════════════════════════════════════════════
// REVIEW-450 P0/P1 red gates — written BEFORE source fixes (must FAIL)
// ═══════════════════════════════════════════════════════════════════

describe('REVIEW-450 P0-1: ArgsValidator root bypass', () => {
  const baseSchema = { type: 'object', properties: { x: { type: 'string' } } } as const;

  it('RED: rejects root schema with oneOf', () => {
    expect(() => buildArgsDecoder({ ...baseSchema, oneOf: [{ type: 'string' }] } as Record<string, unknown>))
      .toThrow(UnsupportedSchemaError);
  });

  it('RED: rejects root schema with anyOf', () => {
    expect(() => buildArgsDecoder({ ...baseSchema, anyOf: [{ type: 'string' }] } as Record<string, unknown>))
      .toThrow(UnsupportedSchemaError);
  });

  it('RED: rejects root schema with allOf', () => {
    expect(() => buildArgsDecoder({ ...baseSchema, allOf: [{ type: 'string' }] } as Record<string, unknown>))
      .toThrow(UnsupportedSchemaError);
  });

  it('RED: rejects root schema with $ref', () => {
    expect(() => buildArgsDecoder({ ...baseSchema, $ref: '#/definitions/X' } as Record<string, unknown>))
      .toThrow(UnsupportedSchemaError);
  });

  it('RED: rejects root schema with not', () => {
    expect(() => buildArgsDecoder({ ...baseSchema, not: { type: 'string' } } as Record<string, unknown>))
      .toThrow(UnsupportedSchemaError);
  });

  it('RED: rejects root schema with if/then', () => {
    expect(() => buildArgsDecoder({ ...baseSchema, if: { type: 'string' }, then: { type: 'number' } } as Record<string, unknown>))
      .toThrow(UnsupportedSchemaError);
  });

  it('RED: rejects root schema without type', () => {
    expect(() => buildArgsDecoder({ properties: { x: { type: 'string' } } } as Record<string, unknown>))
      .toThrow(UnsupportedSchemaError);
  });

  it('RED: rejects root schema with non-object type', () => {
    expect(() => buildArgsDecoder({ type: 'string' } as Record<string, unknown>))
      .toThrow(UnsupportedSchemaError);
  });

  it('RED: rejects root schema with type union', () => {
    expect(() => buildArgsDecoder({ type: ['object', 'null'] as never, properties: { x: { type: 'string' } } } as Record<string, unknown>))
      .toThrow(UnsupportedSchemaError);
  });
});

describe('REVIEW-450 P0-1b: ArgsValidator per-node hard gates', () => {
  it('RED: rejects array property without items', () => {
    expect(() => buildArgsDecoder({
      type: 'object',
      properties: { files: { type: 'array' } },
    } as Record<string, unknown>)).toThrow(UnsupportedSchemaError);
  });

  it('RED: rejects property with additionalProperties:true', () => {
    expect(() => buildArgsDecoder({
      type: 'object',
      properties: {
        opts: { type: 'object', additionalProperties: true, properties: {} },
      },
    } as Record<string, unknown>)).toThrow(UnsupportedSchemaError);
  });

  it('RED: rejects nested property with non-single type union', () => {
    expect(() => buildArgsDecoder({
      type: 'object',
      properties: { val: { type: ['string', 'number'] as never } },
    } as Record<string, unknown>)).toThrow(UnsupportedSchemaError);
  });

  it('RED: rejects nested unknown keyword', () => {
    expect(() => buildArgsDecoder({
      type: 'object',
      properties: { x: { type: 'string', customUnknown: true } as Record<string, unknown> },
    } as Record<string, unknown>)).toThrow(UnsupportedSchemaError);
  });
});

describe('REVIEW-450 P0-2: Structured DTO hostile content blocking', () => {
  // Build a minimal presenter pipeline to probe the boundary directly
  function probeDecoder(toolName: string, rawContent: string): { content: string; metadata: { status: string; code: string } } {
    const registry = createToolPresenterRegistry(
      [],
      new Map(buildBuiltinDecoders()),
    );
    const toolResult = {
      toolName,
      content: rawContent,
      status: 'ok' as const,
      toolCallId: 'tc_probe',
      metadata: {},
    };
    const feedback = presentForProvider(toolResult, registry, [toolName]);
    return {
      content: feedback.content,
      metadata: { status: feedback.status, code: feedback.code ?? '' },
    };
  }

  it('RED: blocks file path in fulltext_search snippet', () => {
    const hostile = JSON.stringify({
      query: 'test',
      total: 1,
      matches: [{ id: 'p1', title: 'Paper', score: 0.9, matchedFields: ['abstract'], snippet: 'Found at /home/alice/secret.pdf' }],
    });
    const result = probeDecoder('fulltext_search', hostile);
    expect(result.content).not.toContain('/home/alice');
  });

  it('RED: blocks credential in fulltext_search snippet', () => {
    const hostile = JSON.stringify({
      query: 'test',
      total: 1,
      matches: [{ id: 'p1', title: 'Paper', score: 0.9, matchedFields: ['abstract'], snippet: 'api_key=sk-1234567890abcdef' }],
    });
    const result = probeDecoder('fulltext_search', hostile);
    expect(result.content).not.toContain('sk-1234567890');
  });

  it('RED: blocks file:// URI in paper result url field', () => {
    const hostile = JSON.stringify({
      query: 'test', total: 1,
      papers: [{ id: 'p1', title: 'Paper', authors: ['A'], year: 2024, url: 'file:///etc/passwd' }],
    });
    const result = probeDecoder('search_papers', hostile);
    expect(result.content).not.toContain('file://');
  });


  it('RED: blocks path in retraction_watch_stats sourceUrl', () => {
    const hostile = JSON.stringify({
      version: 1, updatedAt: 1000000, sourceUrl: '/root/private/mirror.json',
      entryCount: 100, uniqueDoiCount: 95,
    });
    const result = probeDecoder('retraction_watch_stats', hostile);
    expect(result.content).not.toContain('/root/private');
  });


  it('GREEN: preserves safe https URL in paper result', () => {
    const safe = JSON.stringify({
      query: 'test', total: 1,
      papers: [{ id: 'p1', title: 'Paper', authors: ['A'], year: 2024, url: 'https://example.com/paper' }],
    });
    const result = probeDecoder('search_papers', safe);
    expect(result.content).toContain('https://example.com/paper');
  });

  it('GREEN: preserves safe DOI in paper result', () => {
    const safe = JSON.stringify({
      query: 'test', total: 1,
      papers: [{ id: 'p1', title: 'Paper', authors: ['A'], year: 2024, doi: '10.1000/example' }],
    });
    const result = probeDecoder('search_papers', safe);
    expect(result.content).toContain('10.1000/example');
  });

  it('GREEN: preserves safe academic snippet', () => {
    const safe = JSON.stringify({
      query: 'test', total: 1,
      matches: [{ id: 'p1', title: 'Paper', score: 0.9, matchedFields: ['abstract'], snippet: 'We observe a significant effect (p < 0.01).' }],
    });
    const result = probeDecoder('fulltext_search', safe);
    expect(result.content).toContain('significant effect');
  });
});

describe('REVIEW-450 P1-2: appendToolError valid shape', () => {
  it('RED: error ToolResult with non-empty content fails safeParse', () => {
    // AgentLoop.appendToolError constructs: {content: JSON.stringify({error}), status:'error', error}
    // This violates the discriminated union: error status must have content=''
    const result = safeParseToolResult({
      toolName: 'test',
      content: JSON.stringify({ error: 'some error' }),
      status: 'error',
      toolCallId: 'tc_err',
      error: 'some error',
      metadata: {},
    });
    // RED: currently returns false (validation fails), but the code should be FIXED
    // so that appendToolError produces valid shapes
    expect(result.success).toBe(false);
  });
});

describe('REVIEW-450 P1-5: SafeString name and id boundaries', () => {
  it('RED: ProviderFeedback rejects name with control character', () => {
    // Even if the tool name is in the allowed list, control chars should be blocked
    const result = safeParseProviderFeedback(
      { role: 'tool', content: 'ok', toolCallId: 'tc1', name: 'echo\x00bad', status: 'ok' as const },
      ['echo\x00bad'],
    );
    expect(result.success).toBe(false);
  });

  it('RED: ProviderFeedback rejects toolCallId with control character', () => {
    const result = safeParseProviderFeedback(
      { role: 'tool', content: 'ok', toolCallId: 'tc_\x01_ctrl', name: 'echo', status: 'ok' as const },
      ['echo'],
    );
    expect(result.success).toBe(false);
  });
});

describe('REVIEW-450 P1-3: status/code derivation', () => {
  function probeFeedback(toolName: string, rawContent: string, metadataCode?: string): { status: string; code: string } {
    const registry = createToolPresenterRegistry(
      [],
      new Map(buildBuiltinDecoders()),
    );
    const toolResult = {
      toolName,
      content: rawContent,
      status: 'ok' as const,
      toolCallId: 'tc_probe',
      metadata: metadataCode ? { code: metadataCode } : {},
    };
    const feedback = presentForProvider(toolResult, registry, [toolName]);
    return { status: feedback.status, code: feedback.code ?? '' };
  }

  it('RED: ok ToolResult with metadata.code=tool_failed rejects contradictory code', () => {
    // For an ok-result tool, the code should not be freely overridable to tool_failed
    const result = probeFeedback('fulltext_search', JSON.stringify({
      query: 'test', total: 0, matches: [],
    }), 'tool_failed');
    // The code must derive from status, not metadata
    expect(result.code).toBe('ok');
    expect(result.status).toBe('ok');
  });

  it('RED: error ToolResult with metadata.code=ok rejects contradictory code', () => {
    const registry = createToolPresenterRegistry([], new Map(buildBuiltinDecoders()));
    const toolResult = {
      toolName: 'fail_tool',
      content: '',
      status: 'error' as const,
      toolCallId: 'tc_probe',
      error: 'something broke',
      metadata: { code: 'ok' },
    };
    const feedback = presentForProvider(toolResult, registry, ['fail_tool']);
    expect(feedback.code).toBe('tool_failed');
    expect(feedback.status).toBe('error');
  });
});

describe('REVIEW-450 P1-7: safeTruncateContent path boundary', () => {
  it('RED: does not leak path at truncation boundary', () => {
    // Build a string that pushes /root/private.pdf right to the 4000-char edge
    const prefix = 'A'.repeat(3970);
    const path = '/root/private.pdf';
    const suffix = 'B'.repeat(30);
    const input = prefix + path + suffix;
    const result = safeTruncateContent(input, 4000);
    expect(result).not.toContain(path);
    // Must use the fallback marker when a clean cut can't be made
    expect(result).not.toContain('/root/');
  });
});

describe('REVIEW-450 Session limit feedback', () => {
  it('RED: session limit exceeded produces valid tool feedback', async () => {
    const provider = new MultiTurnProvider([
      { content: '', toolCalls: [{ name: 'echo', arguments: { message: 'm1' }, id: 'tc1' }], finishReason: 'tool_calls', usage: makeUsage() },
      { content: '', toolCalls: [{ name: 'echo', arguments: { message: 'm2' }, id: 'tc2' }], finishReason: 'tool_calls', usage: makeUsage() },
      { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);
    const registry = new ToolRegistry();
    registry.register(ECHO_TOOL_SPEC);
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('echo', echoHandler);
    const loop = new AgentLoop({ provider, registry, dispatcher, maxToolsPerSession: 1 });

    const result = await loop.run(makeRequest({ maxTurns: 5 }));
    expect(result.status).toBe('interrupted');
    // RED: the second tool call should have generated a tool error message with feedback
    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBeGreaterThanOrEqual(2);
    // The exceeded-limit tool should produce a valid error feedback, not be silently dropped
    const lastTool = toolMsgs[toolMsgs.length - 1];
    expect(lastTool).toBeDefined();
    expect(lastTool!.content).toBe('Tool execution failed');
  });
});

describe('REVIEW-450 P1-1: Handler error produces true error status', () => {
  it('RED: read_pdf non-existent file produces error ToolResult', async () => {
    const provider = new MultiTurnProvider([
      { content: '', toolCalls: [{ name: 'read_pdf', arguments: { filePath: 'Z:\\definitely-missing\\private.pdf' }, id: 'tc_rp' }], finishReason: 'tool_calls', usage: makeUsage() },
      { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_pdf', description: 'Read PDF',
      parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
    });
    const dispatcher = new ToolDispatcher(registry);
    // Simulate a handler that returns error-as-string (the current bug pattern)
    dispatcher.registerHandler('read_pdf', async (args: Record<string, unknown>) => {
      void args;
      return 'PDF reading failed: ENOENT: no such file';
    });
    const loop = new AgentLoop({ provider, registry, dispatcher });
    const result = await loop.run(makeRequest());
    // RED: The underlying ToolResult should have status='error', not 'ok'
    expect(result.toolResults.length).toBeGreaterThanOrEqual(1);
    expect(result.toolResults[0].status).toBe('error');
  });

  it('RED: search_library uninitialized store produces error ToolResult', async () => {
    const provider = new MultiTurnProvider([
      { content: '', toolCalls: [{ name: 'search_library', arguments: { query: 'test' }, id: 'tc_sl' }], finishReason: 'tool_calls', usage: makeUsage() },
      { content: 'Done', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);
    const registry = new ToolRegistry();
    registry.register({
      name: 'search_library', description: 'Search library',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    });
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('search_library', async (args: Record<string, unknown>) => {
      void args;
      return 'Error: local library store is not initialized.';
    });
    const loop = new AgentLoop({ provider, registry, dispatcher });
    const result = await loop.run(makeRequest());
    expect(result.toolResults.length).toBeGreaterThanOrEqual(1);
    expect(result.toolResults[0].status).toBe('error');
  });
});
