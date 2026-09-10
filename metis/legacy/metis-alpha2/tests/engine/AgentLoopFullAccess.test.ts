import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import type {
  AgentRunRequest,
  ChatMessage,
  NormalizedResponse,
  StreamChunk,
  ToolSpec,
} from '../../engine/core/types.js';
import { ApprovalStore, WRITE_APPROVAL_RULE } from '../../engine/hitl/HITLCore.js';
import { BaseProvider } from '../../engine/providers/BaseProvider.js';
import {
  InMemoryLiveSteeringQueue,
  type LiveSteeringSource,
} from '../../engine/runtime/LiveSteeringContract.js';
import type { FullAccessPolicy } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';

const FULL_ACCESS: FullAccessPolicy = {
  mode: 'full_access',
  perActionConfirmation: false,
  liveSteering: true,
  silentCheckpoints: true,
  rollbackOnFailure: false,
  persistAcrossRestart: true,
};

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    messages: [{ role: 'user', content: 'Start' }],
    maxTurns: 5,
    sessionId: 'session-live-1',
    taskContractHash: 'task',
    promptStackHash: 'prompt',
    resumeFromCheckpoint: false,
    requestId: 'request-live-1',
    ...overrides,
  };
}

class SequenceProvider extends BaseProvider {
  private index = 0;
  readonly receivedMessages: ChatMessage[][] = [];
  callCount = 0;

  constructor(
    private readonly responses: readonly NormalizedResponse[],
    private readonly onComplete?: (call: number) => void,
  ) {
    super();
  }

  capabilities() {
    return {
      providerType: 'full-access-test',
      model: 'test',
      nativeToolCalling: true,
      jsonSchemaOutput: false,
      streaming: false,
      thinking: false,
      maxContextTokens: 32_000,
      maxOutputTokens: 2_000,
      retryableStatusCodes: [],
    };
  }

  async complete(messages: ChatMessage[], tools?: ToolSpec[]): Promise<NormalizedResponse> {
    void tools;
    this.callCount++;
    this.onComplete?.(this.callCount);
    this.receivedMessages.push(messages.map((message) => ({ ...message })));
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index++;
    if (!response) throw new Error('Missing test response');
    return response;
  }

  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> {}
}

class BlockingProvider extends SequenceProvider {
  startedResolve!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve;
  });

  constructor() {
    super([]);
  }

  override async complete(): Promise<NormalizedResponse> {
    this.callCount++;
    this.startedResolve();
    return new Promise<NormalizedResponse>(() => {});
  }
}

function response(
  content: string,
  toolCalls: NormalizedResponse['toolCalls'] = [],
): NormalizedResponse {
  return {
    content,
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    usage: USAGE,
  };
}

function setup(
  provider: BaseProvider,
  specs: ToolSpec[] = [],
  handlers: Record<string, (args: Record<string, unknown>) => Promise<string>> = {},
  approvalStore?: ApprovalStore,
) {
  const registry = new ToolRegistry();
  const dispatcher = new ToolDispatcher(registry);
  for (const spec of specs) registry.register(spec);
  for (const [name, handler] of Object.entries(handlers)) {
    dispatcher.registerHandler(name, async (args) => handler(args));
  }
  return new AgentLoop({ provider, registry, dispatcher, approvalStore });
}

const WRITE_SPEC: ToolSpec = {
  name: 'write_file',
  description: 'Write a file',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
};

describe('AgentLoop Full Access hard boundaries', () => {
  it('rejects a malformed Full Access policy before calling the provider', async () => {
    const provider = new SequenceProvider([response('must not run')]);
    const loop = setup(provider);
    const invalid = { ...FULL_ACCESS, perActionConfirmation: true } as unknown as FullAccessPolicy;

    const result = await loop.run(request({ fullAccess: invalid }));

    expect(result.status).toBe('error');
    expect(result.finalVerified).toBe(false);
    expect(result.errors).toContain('Invalid Full Access policy');
    expect(provider.callCount).toBe(0);
  });

  it('skips per-action approval in Full Access while executing an authorized validated tool', async () => {
    let approvalCalls = 0;
    let handlerCalls = 0;
    const approvalStore = new ApprovalStore();
    approvalStore.addRule(WRITE_APPROVAL_RULE);
    approvalStore.setHandler(async () => {
      approvalCalls++;
      return false;
    });
    const provider = new SequenceProvider([
      response('', [{ name: 'write_file', arguments: { path: 'safe.txt', content: 'ok' }, id: 'write-1' }]),
      response('Finished'),
    ]);
    const loop = setup(provider, [WRITE_SPEC], {
      write_file: async () => {
        handlerCalls++;
        return 'Successfully wrote file';
      },
    }, approvalStore);

    const result = await loop.run(request({ fullAccess: FULL_ACCESS, allowedTools: ['write_file'] }));

    expect(result.status).toBe('completed');
    expect(handlerCalls).toBe(1);
    expect(approvalCalls).toBe(0);
    expect(result.traceEvents.some((event) => event.event === 'hitl.skipped_full_access')).toBe(true);
  });

  it('system default is Full Access when no policy is provided (no user-managed permissions)', async () => {
    let handlerCalls = 0;
    const approvalStore = new ApprovalStore();
    approvalStore.addRule(WRITE_APPROVAL_RULE);
    approvalStore.setHandler(async () => false);
    const provider = new SequenceProvider([
      response('', [{ name: 'write_file', arguments: { path: 'safe.txt', content: 'ok' }, id: 'write-2' }]),
      response('Done', []),
    ]);
    const loop = setup(provider, [WRITE_SPEC], {
      write_file: async () => {
        handlerCalls++;
        return 'written';
      },
    }, approvalStore);

    const result = await loop.run(request({ allowedTools: ['write_file'] }));

    // 缺省策略 = 系统 Full Access：即使存在审批规则也不拦截，工具直接执行。
    expect(result.status).toBe('completed');
    expect(handlerCalls).toBeGreaterThan(0);
    expect(result.traceEvents.some((event) => event.event === 'hitl.skipped_full_access')).toBe(true);
  });

  it('blocks a destructive command even in Full Access', async () => {
    let handlerCalls = 0;
    const executeSpec: ToolSpec = {
      name: 'execute_command',
      description: 'Execute command',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
        },
        required: ['command'],
      },
    };
    const provider = new SequenceProvider([
      response('', [{ name: 'execute_command', arguments: { command: 'git', args: ['reset', '--hard'] }, id: 'cmd-1' }]),
    ]);
    const loop = setup(provider, [executeSpec], {
      execute_command: async () => {
        handlerCalls++;
        return 'executed';
      },
    });

    const result = await loop.run(request({ fullAccess: FULL_ACCESS, allowedTools: ['execute_command'] }));

    expect(result.status).toBe('interrupted');
    expect(handlerCalls).toBe(0);
    expect(result.traceEvents.some((event) => event.event === 'tool.blocked_hard_safety')).toBe(true);
  });

  it('does not let Full Access bypass argument validation', async () => {
    let handlerCalls = 0;
    const provider = new SequenceProvider([
      response('', [{ name: 'write_file', arguments: { path: 'safe.txt' }, id: 'write-3' }]),
      response('Stopped after validation failure'),
    ]);
    const loop = setup(provider, [WRITE_SPEC], {
      write_file: async () => {
        handlerCalls++;
        return 'written';
      },
    });

    const result = await loop.run(request({ fullAccess: FULL_ACCESS, allowedTools: ['write_file'] }));

    expect(result.status).toBe('completed');
    expect(handlerCalls).toBe(0);
    expect(result.toolResults[0]?.status).toBe('error');
  });

  it('blocks a provider-forged tool call against an explicit empty allowlist', async () => {
    let handlerCalls = 0;
    const provider = new SequenceProvider([
      response('', [{ name: 'write_file', arguments: { path: 'safe.txt', content: 'x' }, id: 'write-4' }]),
    ]);
    const loop = setup(provider, [WRITE_SPEC], {
      write_file: async () => {
        handlerCalls++;
        return 'written';
      },
    });

    const result = await loop.run(request({ fullAccess: FULL_ACCESS, allowedTools: [] }));

    expect(result.status).toBe('interrupted');
    expect(handlerCalls).toBe(0);
    expect(result.traceEvents.some((event) => event.event === 'tool.blocked_allowlist')).toBe(true);
  });

  it('enforces tool permissions independently of Full Access', async () => {
    let handlerCalls = 0;
    const privilegedSpec: ToolSpec = { ...WRITE_SPEC, permissions: ['workspace.write'] };
    const provider = new SequenceProvider([
      response('', [{ name: 'write_file', arguments: { path: 'safe.txt', content: 'x' }, id: 'write-5' }]),
    ]);
    const loop = setup(provider, [privilegedSpec], {
      write_file: async () => {
        handlerCalls++;
        return 'written';
      },
    });

    const result = await loop.run(request({
      fullAccess: FULL_ACCESS,
      allowedTools: ['write_file'],
      allowedToolPermissions: [],
    }));

    expect(result.status).toBe('interrupted');
    expect(handlerCalls).toBe(0);
    expect(result.traceEvents.some((event) => event.event === 'tool.blocked_permission')).toBe(true);
  });
});

describe('AgentLoop cooperative interruption', () => {
  it('returns interrupted without a provider call when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new SequenceProvider([response('must not run')]);
    const loop = setup(provider);

    const result = await loop.run(request({ signal: controller.signal }));

    expect(result.status).toBe('interrupted');
    expect(result.finalText).toBe('');
    expect(result.finalVerified).toBe(false);
    expect(provider.callCount).toBe(0);
  });

  it('interrupts a pending provider call and never appends stale completion text', async () => {
    const controller = new AbortController();
    const provider = new BlockingProvider();
    const loop = setup(provider);

    const runPromise = loop.run(request({ signal: controller.signal }));
    await provider.started;
    controller.abort();
    const result = await runPromise;

    expect(result.status).toBe('interrupted');
    expect(result.finalText).toBe('');
    expect(result.messages.some((message) => message.role === 'assistant')).toBe(false);
  });

  it('re-checks interruption after a tool returns and never reports completed', async () => {
    const controller = new AbortController();
    const provider = new SequenceProvider([
      response('', [{ name: 'write_file', arguments: { path: 'safe.txt', content: 'x' }, id: 'write-6' }]),
      response('must not become final'),
    ]);
    const loop = setup(provider, [WRITE_SPEC], {
      write_file: async () => {
        controller.abort();
        return 'written';
      },
    });

    const result = await loop.run(request({
      signal: controller.signal,
      fullAccess: FULL_ACCESS,
      allowedTools: ['write_file'],
    }));

    expect(result.status).toBe('interrupted');
    expect(result.finalVerified).toBe(false);
    expect(result.finalText).toBe('');
    expect(result.toolResults).toHaveLength(1);
    expect(provider.callCount).toBe(1);
  });
});

describe('AgentLoop live steering', () => {
  it('injects a queued instruction before the first provider request', async () => {
    const queue = new InMemoryLiveSteeringQueue();
    queue.enqueue({
      type: 'instruction',
      id: 'steer-1',
      sessionId: 'session-live-1',
      sequence: 1,
      createdAt: 1,
      content: 'Change the output to a concise table.',
    });
    const provider = new SequenceProvider([response('Table ready')]);
    const loop = setup(provider);

    const result = await loop.run(request({ liveSteering: queue }));

    expect(result.status).toBe('completed');
    expect(provider.receivedMessages[0]?.some(
      (message) => message.role === 'user' && message.content === 'Change the output to a concise table.',
    )).toBe(true);
  });

  it('discards a stale model response when new steering arrives after the request', async () => {
    let drains = 0;
    const source: LiveSteeringSource = {
      drain: () => {
        drains++;
        return drains === 2
          ? [{
              type: 'instruction',
              id: 'steer-2',
              sessionId: 'session-live-1',
              sequence: 1,
              createdAt: 2,
              content: 'Use the revised direction.',
            }]
          : [];
      },
    };
    const provider = new SequenceProvider([
      response('STALE COMPLETION'),
      response('Revised completion'),
    ]);
    const loop = setup(provider);

    const result = await loop.run(request({ liveSteering: source }));

    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('Revised completion');
    expect(result.messages.some((message) => message.content === 'STALE COMPLETION')).toBe(false);
    expect(provider.receivedMessages[1]?.some((message) => message.content === 'Use the revised direction.')).toBe(true);
  });

  it('honors a queued interrupt before any provider request', async () => {
    const queue = new InMemoryLiveSteeringQueue();
    queue.enqueue({
      type: 'interrupt',
      id: 'stop-1',
      sessionId: 'session-live-1',
      sequence: 1,
      createdAt: 3,
      reason: 'User changed direction.',
    });
    const provider = new SequenceProvider([response('must not run')]);
    const loop = setup(provider);

    const result = await loop.run(request({ liveSteering: queue }));

    expect(result.status).toBe('interrupted');
    expect(provider.callCount).toBe(0);
    expect(result.finalVerified).toBe(false);
  });

  it('cancels pending tool calls when an interrupt arrives before dispatch', async () => {
    let drains = 0;
    let handlerCalls = 0;
    const source: LiveSteeringSource = {
      drain: () => {
        drains++;
        return drains === 3
          ? [{
              type: 'interrupt',
              id: 'stop-2',
              sessionId: 'session-live-1',
              sequence: 1,
              createdAt: 4,
              reason: 'Stop before writing.',
            }]
          : [];
      },
    };
    const provider = new SequenceProvider([
      response('', [{ name: 'write_file', arguments: { path: 'safe.txt', content: 'x' }, id: 'write-7' }]),
    ]);
    const loop = setup(provider, [WRITE_SPEC], {
      write_file: async () => {
        handlerCalls++;
        return 'written';
      },
    });

    const result = await loop.run(request({
      liveSteering: source,
      fullAccess: FULL_ACCESS,
      allowedTools: ['write_file'],
    }));

    expect(result.status).toBe('interrupted');
    expect(handlerCalls).toBe(0);
    expect(result.toolResults[0]?.status).toBe('error');
  });

  it('fails closed when a steering source returns a malformed cross-session event', async () => {
    const source: LiveSteeringSource = {
      drain: () => [{
        type: 'instruction',
        id: 'steer-bad',
        sessionId: 'another-session',
        sequence: 1,
        createdAt: 5,
        content: 'Smuggled instruction',
      }],
    };
    const provider = new SequenceProvider([response('must not run')]);
    const loop = setup(provider);

    const result = await loop.run(request({ liveSteering: source }));

    expect(result.status).toBe('interrupted');
    expect(provider.callCount).toBe(0);
    expect(result.errors).toContain('Live steering event failed validation');
  });
});

describe('InMemoryLiveSteeringQueue strict contract', () => {
  it('rejects extra fields and non-monotonic sequences', () => {
    const queue = new InMemoryLiveSteeringQueue();
    expect(() => queue.enqueue({
      type: 'instruction',
      id: 'strict-1',
      sessionId: 'strict-session',
      sequence: 1,
      createdAt: 1,
      content: 'Valid',
      forged: true,
    })).toThrow();

    queue.enqueue({
      type: 'instruction',
      id: 'strict-2',
      sessionId: 'strict-session',
      sequence: 2,
      createdAt: 2,
      content: 'Valid',
    });
    expect(() => queue.enqueue({
      type: 'interrupt',
      id: 'strict-3',
      sessionId: 'strict-session',
      sequence: 2,
      createdAt: 3,
      reason: 'Duplicate sequence',
    })).toThrow(/increase/u);
  });
});
