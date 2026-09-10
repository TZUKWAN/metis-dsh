import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import { BaseProvider } from '../../engine/providers/BaseProvider.js';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { FakeProvider } from '../../engine/providers/FakeProvider.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { runEphemeralChatTurn, runPersistedChatTurn, CHAT_DEFAULT_MAX_TURNS } from '../../electron/ChatTurnService.js';
import type { AgentRunResult, ChatMessage, NormalizedResponse, ProviderUsage, StreamChunk, ToolSpec } from '../../engine/core/types.js';

let store: PersistenceStore;
let tmpDir: string;

function createLoop(response: string): AgentLoop {
  const registry = new ToolRegistry();
  return new AgentLoop({
    provider: new FakeProvider({ response }),
    registry,
    dispatcher: new ToolDispatcher(registry),
    workspace: tmpDir,
  });
}

// ─── UX-CHAT-001: scripted tool-call provider ─────────────────

/** Provider that returns a scripted sequence of responses (tool call → answer). */
class MultiTurnProvider extends BaseProvider {
  private callIndex = 0;
  private readonly responses: NormalizedResponse[];

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
      streaming: false,
      thinking: false,
      maxContextTokens: 32000,
      maxOutputTokens: 4096,
      retryableStatusCodes: [],
    };
  }

  async complete(messages: ChatMessage[], tools?: ToolSpec[]): Promise<NormalizedResponse> {
    void messages; void tools;
    const idx = Math.min(this.callIndex, this.responses.length - 1);
    this.callIndex++;
    return this.responses[idx]!;
  }

  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> {
    // Not used — streaming is false
  }
}

function makeUsage(p = 10, c = 20, t = 30): ProviderUsage {
  return { promptTokens: p, completionTokens: c, totalTokens: t };
}

function createToolLoop(responses: NormalizedResponse[]): AgentLoop {
  const registry = new ToolRegistry();
  registry.register({
    name: 'echo',
    description: 'Echo back the input',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'The message to echo' } },
      required: ['message'],
    },
  });
  const dispatcher = new ToolDispatcher(registry);
  dispatcher.registerHandler('echo', async (args: Record<string, unknown>) => `Echo: ${args.message}`);
  return new AgentLoop({
    provider: new MultiTurnProvider(responses),
    registry,
    dispatcher,
    workspace: tmpDir,
  });
}

type RunLifecycleCall =
  | { kind: 'begin'; runId: string }
  | { kind: 'terminal-event'; status: string }
  | { kind: 'finish'; status: string; terminalReason?: string };

function createRunLifecycleStore() {
  const calls: RunLifecycleCall[] = [];
  const runStore = {
    appendMessage: vi.fn(),
    createSession: vi.fn(),
    getSession: vi.fn(() => ({ id: 'session-1' })),
    truncateMessagesAfterLastUser: vi.fn(),
    beginAgentRun: vi.fn((input: { runId: string }) => {
      calls.push({ kind: 'begin', runId: input.runId });
    }),
    finishAgentRun: vi.fn((input: { status: string; terminalReason?: string }) => {
      calls.push({ kind: 'finish', status: input.status, terminalReason: input.terminalReason });
    }),
  } as unknown as Parameters<typeof runPersistedChatTurn>[0]['store'];
  return { runStore, calls };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-chat-turn-'));
  store = new PersistenceStore(path.join(tmpDir, 'chat.db'));
  store.createSession('session-1');
});

afterEach(() => {
  store?.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runPersistedChatTurn', () => {
  it('publishes the terminal event before finishing the durable run on normal completion', async () => {
    const { runStore, calls } = createRunLifecycleStore();

    const response = await runPersistedChatTurn({
      agentLoop: createLoop('ordered answer'),
      store: runStore,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'ordered question' }],
      requestId: 'chat-order-complete',
      beforeFinish: (status) => calls.push({ kind: 'terminal-event', status }),
    });

    expect(response.status).toBe('completed');
    expect(calls).toEqual([
      { kind: 'begin', runId: 'chat-order-complete' },
      { kind: 'terminal-event', status: 'completed' },
      { kind: 'finish', status: 'completed', terminalReason: undefined },
    ]);
  });

  it('finishes the durable run after publishing a terminal event when AgentLoop throws', async () => {
    const { runStore, calls } = createRunLifecycleStore();
    const failure = new Error('provider exploded');

    await expect(runPersistedChatTurn({
      agentLoop: { run: vi.fn().mockRejectedValue(failure) },
      store: runStore,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'exception question' }],
      requestId: 'chat-order-exception',
      beforeFinish: (status) => calls.push({ kind: 'terminal-event', status }),
    })).rejects.toBe(failure);

    expect(calls).toEqual([
      { kind: 'begin', runId: 'chat-order-exception' },
      { kind: 'terminal-event', status: 'error' },
      { kind: 'finish', status: 'error', terminalReason: 'agent_exception' },
    ]);
  });

  it('finishes the durable run after publishing cancellation on runtime reconfiguration', async () => {
    const { runStore, calls } = createRunLifecycleStore();
    const run = vi.fn().mockResolvedValue({
      status: 'completed' as const,
      finalText: 'stale answer',
      finalVerified: true,
      messages: [] as ChatMessage[],
      turnsUsed: 1,
      toolResults: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      errors: [],
      traceEvents: [],
    });

    const response = await runPersistedChatTurn({
      agentLoop: { run },
      store: runStore,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'cancel this question' }],
      requestId: 'chat-order-cancelled',
      isCurrentRuntime: () => false,
      beforeFinish: (status) => calls.push({ kind: 'terminal-event', status }),
    });

    expect(response).toMatchObject({ status: 'cancelled', diagnostics: [{ code: 'runtime_reconfigured' }] });
    expect(calls).toEqual([
      { kind: 'begin', runId: 'chat-order-cancelled' },
      { kind: 'terminal-event', status: 'cancelled' },
      { kind: 'finish', status: 'cancelled', terminalReason: 'runtime_reconfigured' },
    ]);
  });

  it('finishes an interrupted durable run after publishing its terminal event', async () => {
    const { runStore, calls } = createRunLifecycleStore();
    const response = await runPersistedChatTurn({
      agentLoop: {
        run: async () => ({
          status: 'interrupted' as const,
          finalText: '',
          finalVerified: false,
          messages: [] as ChatMessage[],
          turnsUsed: 1,
          toolResults: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          errors: ['cancelled'],
          traceEvents: [],
        }),
      },
      store: runStore,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'interrupt this question' }],
      requestId: 'chat-order-interrupted',
      beforeFinish: (status) => calls.push({ kind: 'terminal-event', status }),
    });

    expect(response.status).toBe('interrupted');
    expect(calls).toEqual([
      { kind: 'begin', runId: 'chat-order-interrupted' },
      { kind: 'terminal-event', status: 'interrupted' },
      { kind: 'finish', status: 'interrupted', terminalReason: 'agent_interrupted' },
    ]);
  });

  it('finishes the durable run after publishing a response contract error terminal', async () => {
    const { runStore, calls } = createRunLifecycleStore();
    const malformedResult: AgentRunResult = {
      status: 'completed',
      finalText: 'x'.repeat(200_001),
      finalVerified: true,
      messages: [],
      turnsUsed: 1,
      toolResults: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      errors: [],
      traceEvents: [],
    };

    const response = await runPersistedChatTurn({
      agentLoop: { run: async () => malformedResult },
      store: runStore,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'contract question' }],
      requestId: 'chat-order-contract-error',
      beforeFinish: (status) => calls.push({ kind: 'terminal-event', status }),
    });

    expect(response).toMatchObject({ status: 'error', diagnostics: [{ code: 'response_contract_error' }] });
    expect(calls).toEqual([
      { kind: 'begin', runId: 'chat-order-contract-error' },
      { kind: 'terminal-event', status: 'error' },
      { kind: 'finish', status: 'error', terminalReason: 'response_contract_error' },
    ]);
  });

  it('persists only the new user and current assistant response', async () => {
    const response = await runPersistedChatTurn({
      agentLoop: createLoop('current answer'),
      store,
      sessionId: 'session-1',
      messages: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'old answer' },
        { role: 'user', content: 'second question' },
      ],
      requestId: 'chat-1',
    });

    expect(response).toMatchObject({
      version: 1,
      turnId: 'chat-1',
      status: 'completed',
      answer: 'current answer',
      citations: [],
      events: [
        { type: 'lifecycle', phase: 'started', summary: 'agent.start' },
        { type: 'action', action: 'model.request', status: 'running', summary: 'model.request' },
        { type: 'action', action: 'model.response', status: 'completed', summary: 'model.response' },
        { type: 'lifecycle', phase: 'completed', summary: 'agent.complete' },
      ],
    });
    expect(store.getMessages('session-1')).toEqual([
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'current answer' },
    ]);
    expect(store.getSession('session-1')?.messageCount).toBe(2);
  });

  it('does not duplicate prior history over consecutive turns', async () => {
    const firstHistory: ChatMessage[] = [{ role: 'user', content: 'first question' }];
    await runPersistedChatTurn({
      agentLoop: createLoop('first answer'),
      store,
      sessionId: 'session-1',
      messages: firstHistory,
      requestId: 'chat-1',
    });

    await runPersistedChatTurn({
      agentLoop: createLoop('second answer'),
      store,
      sessionId: 'session-1',
      messages: [
        ...firstHistory,
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' },
      ],
      requestId: 'chat-2',
    });

    expect(store.getMessages('session-1')).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
      { role: 'assistant', content: 'second answer' },
    ]);
  });

  it('replaces the last assistant response when regenerating', async () => {
    store.appendMessage('session-1', 'user', 'question');
    store.appendMessage('session-1', 'assistant', 'old answer');

    await runPersistedChatTurn({
      agentLoop: createLoop('replacement answer'),
      store,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'question' }],
      requestId: 'chat-regenerate',
      options: { mode: 'regenerate' },
    });

    expect(store.getMessages('session-1')).toEqual([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'replacement answer' },
    ]);
    expect(store.getSession('session-1')?.messageCount).toBe(2);
  });

  it('does not persist an empty interrupted response', async () => {
    const agentLoop = {
      run: async () => ({
        status: 'interrupted' as const,
        finalText: '',
        finalVerified: false,
        messages: [{ role: 'user', content: 'question' }] as ChatMessage[],
        turnsUsed: 1,
        toolResults: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        errors: ['interrupted'],
        traceEvents: [],
      }),
    };

    const response = await runPersistedChatTurn({
      agentLoop,
      store,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'question' }],
      requestId: 'chat-error',
    });

    expect(response).toMatchObject({
      version: 1,
      turnId: 'chat-error',
      status: 'interrupted',
      answer: '',
      diagnostics: [{ severity: 'error', code: 'agent_interrupted' }],
      citations: [],
      events: [expect.objectContaining({ type: 'lifecycle', phase: 'interrupted', summary: 'agent.interrupted' })],
    });
    expect(response.events).toHaveLength(1);
    expect(response.events[0]?.timestamp).toEqual(expect.any(Number));
    expect(store.getMessages('session-1')).toEqual([
      { role: 'user', content: 'question' },
    ]);
  });

  it('never exposes or persists an unverified partial answer', async () => {
    const agentLoop = {
      run: async () => ({
        status: 'completed' as const,
        finalText: 'partial Authorization: Bearer should-never-cross-boundary',
        finalVerified: false,
        messages: [] as ChatMessage[],
        turnsUsed: 1,
        toolResults: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        errors: [],
        traceEvents: [],
      }),
    };

    const response = await runPersistedChatTurn({
      agentLoop,
      store,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'question' }],
      requestId: 'chat-unverified',
    });

    expect(response.status).toBe('error');
    expect(response.answer).toBe('');
    expect(JSON.stringify(response)).not.toContain('should-never-cross-boundary');
    expect(store.getMessages('session-1')).toEqual([
      { role: 'user', content: 'question' },
    ]);
  });

  it('passes the frozen scenario prompt, tool allowlist and manifest bindings to AgentLoop', async () => {
    const run = vi.fn().mockResolvedValue({
      status: 'completed' as const,
      finalText: 'scenario answer',
      finalVerified: true,
      messages: [] as ChatMessage[],
      turnsUsed: 1,
      toolResults: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      errors: [],
      traceEvents: [],
    });
    const controller = new AbortController();
    const liveSteering = { drain: vi.fn().mockReturnValue([]) };
    const fullAccess = {
      mode: 'full_access' as const,
      perActionConfirmation: false as const,
      liveSteering: true as const,
      silentCheckpoints: true,
      rollbackOnFailure: false,
      persistAcrossRestart: true,
    };
    await runPersistedChatTurn({
      agentLoop: { run },
      store,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'question' }],
      requestId: 'chat-personalized',
      skillPrompt: 'resolved scenario prompt',
      allowedTools: [],
      maxTurns: 7,
      taskContractHash: 'a'.repeat(64),
      promptStackHash: 'b'.repeat(64),
      fullAccess,
      signal: controller.signal,
      liveSteering,
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      skillPrompt: 'resolved scenario prompt',
      allowedTools: [],
      maxTurns: 7,
      taskContractHash: 'a'.repeat(64),
      promptStackHash: 'b'.repeat(64),
      fullAccess,
      signal: controller.signal,
      liveSteering,
    }));
  });
});

// O15: 多模型对比的临时回合——与 runPersistedChatTurn 共用响应口径，但完全
// 不触碰 PersistenceStore（对比的 N 个 profile 并行调用若各自落库会把用户
// 消息写 N 遍）。
describe('runEphemeralChatTurn (O15 multi-model compare)', () => {
  it('returns the profile answer without persisting anything', async () => {
    const response = await runEphemeralChatTurn({
      agentLoop: createLoop('compare answer A'),
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'compare question' }],
      requestId: 'chatcmp-1',
    });

    expect(response).toMatchObject({
      version: 1,
      turnId: 'chatcmp-1',
      status: 'completed',
      answer: 'compare answer A',
      diagnostics: [],
    });
    // 关键断言：不写用户消息、不写助手回答。
    expect(store.getMessages('session-1')).toEqual([]);
    expect(store.getSession('session-1')?.messageCount ?? 0).toBe(0);
  });

  it('propagates a credential-free project binding and system prompt to AgentLoop', async () => {
    const calls: Array<{ messages: ChatMessage[]; providerProfileBinding?: unknown }> = [];
    const response = await runEphemeralChatTurn({
      agentLoop: {
        run: async (request) => {
          calls.push({ messages: request.messages, providerProfileBinding: request.providerProfileBinding });
          return {
            status: 'completed' as const,
            finalText: 'bound answer',
            finalVerified: true,
            messages: [],
            turnsUsed: 1,
            toolResults: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            errors: [],
            traceEvents: [],
          };
        },
      },
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'question' }],
      requestId: 'chatcmp-binding',
      projectId: 'project-a',
      providerProfileBinding: { source: 'project_override', profileId: 'profile-b', model: 'model-b', systemPrompt: 'project-only' },
    },
    );
    expect(response.status).toBe('completed');
    expect(calls[0]?.providerProfileBinding).toEqual({ source: 'project_override', profileId: 'profile-b', model: 'model-b', systemPrompt: 'project-only' });
    expect(calls[0]?.messages[0]).toEqual({ role: 'system', content: 'project-only' });
  });

  it('supports true parallel fan-out: each profile loop returns its own answer', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'same question' }];
    const [a, b, c] = await Promise.all([
      runEphemeralChatTurn({ agentLoop: createLoop('answer from A'), sessionId: 'session-1', messages, requestId: 'chatcmp-a' }),
      runEphemeralChatTurn({ agentLoop: createLoop('answer from B'), sessionId: 'session-1', messages, requestId: 'chatcmp-b' }),
      runEphemeralChatTurn({ agentLoop: createLoop('answer from C'), sessionId: 'session-1', messages, requestId: 'chatcmp-c' }),
    ]);

    expect(a.answer).toBe('answer from A');
    expect(b.answer).toBe('answer from B');
    expect(c.answer).toBe('answer from C');
    // 并行三个回合后存储仍然为空。
    expect(store.getMessages('session-1')).toEqual([]);
  });

  it('matches runPersistedChatTurn diagnostics on unverified answers', async () => {
    const unverifiedLoop = {
      run: async () => ({
        status: 'completed' as const,
        finalText: 'thin answer',
        finalVerified: false,
        messages: [] as ChatMessage[],
        turnsUsed: 1,
        toolResults: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        errors: [],
        traceEvents: [],
      }),
    };
    const response = await runEphemeralChatTurn({
      agentLoop: unverifiedLoop,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'question' }],
      requestId: 'chatcmp-unverified',
    });

    expect(response.status).toBe('error');
    expect(response.answer).toBe('');
    expect(response.diagnostics).toEqual([{ severity: 'error', code: 'answer_unverified' }]);
  });

  it('rejects turns without a user message or with a blank session', async () => {
    const noUser = await runEphemeralChatTurn({
      agentLoop: createLoop('unused'),
      sessionId: 'session-1',
      messages: [{ role: 'assistant', content: 'only assistant' }],
      requestId: 'chatcmp-nouser',
    });
    expect(noUser.status).toBe('error');
    expect(noUser.diagnostics[0]?.code).toBe('missing_user_message');

    const blankSession = await runEphemeralChatTurn({
      agentLoop: createLoop('unused'),
      sessionId: '   ',
      messages: [{ role: 'user', content: 'question' }],
      requestId: 'chatcmp-blank',
    });
    expect(blankSession.status).toBe('error');
    expect(blankSession.diagnostics[0]?.code).toBe('invalid_session');
  });
});

// ─── UX-CHAT-001: 工具调用回合必须能被最终回答接续 ──────────────

describe('runPersistedChatTurn tool-call continuation (UX-CHAT-001)', () => {
  it('completes a tool call turn followed by the final answer with the default turn budget', async () => {
    // 受控模型：第一轮必须调用 list_sources 类工具，第二轮读取工具结果后作答。
    const loop = createToolLoop([
      {
        content: '',
        toolCalls: [{ name: 'echo', arguments: { message: '当前项目资料' }, id: 'tc_sources' }],
        finishReason: 'tool_calls',
        usage: makeUsage(),
      },
      { content: '基于工具结果：资料已核对。', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);

    const response = await runPersistedChatTurn({
      agentLoop: loop,
      store,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: '请读取当前项目资料并回答一个证据问题。' }],
      requestId: 'chat-tool-chain',
    });

    expect(response.status).toBe('completed');
    expect(response.answer).toBe('基于工具结果：资料已核对。');
    expect(response.diagnostics).toEqual([]);
    expect(response.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'lifecycle', phase: 'started' }),
      expect.objectContaining({ type: 'action', action: 'tool:echo', status: 'completed', summary: 'tool.dispatched: echo' }),
      expect.objectContaining({ type: 'lifecycle', phase: 'completed' }),
    ]));
    // 用户消息与最终回答都被持久化。
    expect(store.getMessages('session-1')).toEqual([
      { role: 'user', content: '请读取当前项目资料并回答一个证据问题。' },
      { role: 'assistant', content: '基于工具结果：资料已核对。' },
    ]);
    expect(store.getSession('session-1')?.messageCount).toBe(2);
  });

  it('defaults to the bounded CHAT_DEFAULT_MAX_TURNS instead of a single turn', async () => {
    const run = vi.fn().mockResolvedValue({
      status: 'completed' as const,
      finalText: 'ok',
      finalVerified: true,
      messages: [] as ChatMessage[],
      turnsUsed: 1,
      toolResults: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      errors: [],
      traceEvents: [],
    });
    await runPersistedChatTurn({
      agentLoop: { run },
      store,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'question' }],
      requestId: 'chat-default-turns',
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ maxTurns: CHAT_DEFAULT_MAX_TURNS }));
  });

  it('continues an explicit per-window turn budget into the next compressed window', async () => {
    // maxTurns=1 是每个软窗口的预算；聊天服务在窗口内有真实进展时会自动压缩并续跑。
    const loop = createToolLoop([
      {
        content: '',
        toolCalls: [{ name: 'echo', arguments: { message: 'x' }, id: 'tc_cap' }],
        finishReason: 'tool_calls',
        usage: makeUsage(),
      },
      { content: '续跑后到达的回答', toolCalls: [], finishReason: 'stop', usage: makeUsage() },
    ]);

    const response = await runPersistedChatTurn({
      agentLoop: loop,
      store,
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'compressed question' }],
      requestId: 'chat-windowed',
      maxTurns: 1,
    });

    expect(response.status).toBe('completed');
    expect(response.answer).toBe('续跑后到达的回答');
    expect(response.diagnostics).toEqual([]);
    expect(store.getMessages('session-1')).toEqual([
      { role: 'user', content: 'compressed question' },
      { role: 'assistant', content: '续跑后到达的回答' },
    ]);
  });
});

describe('Citation 贯通(BUG-004 回归):检索工具回合必须成功并携带引用', () => {
  it('web_search 结果不再触发 response_contract_error,引用随回答落库', async () => {
    const agentLoop = {
      run: async () => ({
        status: 'completed' as const,
        finalText: '找到 2 篇平台劳动研究,列表如下。',
        finalVerified: true,
        messages: [{ role: 'user', content: 'q' }] as ChatMessage[],
        turnsUsed: 2,
        toolResults: [
          {
            toolName: 'web_search',
            content: JSON.stringify({
              result: {
                results: [
                  { title: 'Platform Labor: A Review', url: 'https://journals.test/platform-labor' },
                  { title: '知识劳动者的平台化', url: 'https://journals.test/cn-platform' },
                ],
              },
            }),
            status: 'ok' as const,
            toolCallId: 'tc_1',
            metadata: {},
          },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        errors: [],
        traceEvents: [],
      }),
    };

    const response = await runPersistedChatTurn({
      agentLoop,
      store,
      sessionId: 'session-cite',
      messages: [{ role: 'user', content: '请检索平台劳动研究' }],
      requestId: 'chat-cite-1',
    });

    expect(response.status).toBe('completed');
    expect(response.citations).toHaveLength(2);
    expect(response.citations[0]).toMatchObject({ id: '1', label: 'Platform Labor: A Review', url: 'https://journals.test/platform-labor' });
    expect(response.citations[1]).toMatchObject({ id: '2', label: '知识劳动者的平台化' });
    expect(response.diagnostics).toEqual([]);

    const rows = store.getMessages('session-cite', undefined, { includeMetadata: true }) as Array<{ role: string; metadata?: Record<string, unknown> }>;
    const assistantRow = rows.find((row) => row.role === 'assistant');
    expect(assistantRow?.metadata?.citations).toEqual(response.citations);
  });
});
