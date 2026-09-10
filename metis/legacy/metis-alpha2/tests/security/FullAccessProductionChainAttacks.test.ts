import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import type {
  AgentRunRequest,
  AgentRunResult,
  ChatMessage,
  NormalizedResponse,
  StreamChunk,
  ToolSpec,
} from '../../engine/core/types.js';
import { ApprovalStore, WRITE_APPROVAL_RULE } from '../../engine/hitl/HITLCore.js';
import { digestResolvedManifestSnapshot } from '../../engine/personalization/ScenarioRunCoordinator.js';
import { BaseProvider } from '../../engine/providers/BaseProvider.js';
import {
  AgentChatOptionsSchema,
  AgentChatRequestSchema,
} from '../../engine/runtime/ChatRuntimeContract.js';
import { InMemoryLiveSteeringQueue } from '../../engine/runtime/LiveSteeringContract.js';
import {
  FullAccessPolicySchema,
  ResolvedRunManifestSchema,
  type FullAccessPolicy,
  type ResolvedRunManifest,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { runPersistedChatTurn } from '../../electron/ChatTurnService.js';
import { runPersistedScenarioWorkflow } from '../../electron/ScenarioWorkflowService.js';

const FULL_ACCESS: FullAccessPolicy = {
  mode: 'full_access',
  perActionConfirmation: false,
  liveSteering: true,
  silentCheckpoints: true,
  rollbackOnFailure: false,
  persistAcrossRestart: true,
};

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const SAFE_TOOL: ToolSpec = {
  name: 'safe_operation',
  description: 'Perform one bounded safe operation.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { value: { type: 'string' } },
    required: ['value'],
  },
};

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

class SequenceProvider extends BaseProvider {
  readonly receivedMessages: ChatMessage[][] = [];
  callCount = 0;
  #index = 0;

  constructor(private readonly responses: readonly NormalizedResponse[]) {
    super();
  }

  capabilities() {
    return {
      providerType: 'full-access-production-chain-audit',
      model: 'deterministic-audit-provider',
      nativeToolCalling: true,
      jsonSchemaOutput: false,
      streaming: false,
      thinking: false,
      maxContextTokens: 16_000,
      maxOutputTokens: 2_000,
      retryableStatusCodes: [],
    };
  }

  async complete(messages: ChatMessage[]): Promise<NormalizedResponse> {
    this.callCount += 1;
    this.receivedMessages.push(messages.map((message) => ({ ...message })));
    const result = this.responses[Math.min(this.#index, this.responses.length - 1)];
    this.#index += 1;
    if (!result) throw new Error('Missing deterministic provider response');
    return result;
  }

  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> {}
}

class BlockingProvider extends SequenceProvider {
  readonly started: Promise<void>;
  #markStarted!: () => void;

  constructor() {
    super([]);
    this.started = new Promise<void>((resolve) => { this.#markStarted = resolve; });
  }

  override async complete(): Promise<NormalizedResponse> {
    this.callCount += 1;
    this.#markStarted();
    return new Promise<NormalizedResponse>(() => {});
  }
}

function loopWith(
  provider: BaseProvider,
  approvalStore: ApprovalStore,
  onSafeTool: () => void = () => {},
): AgentLoop {
  const registry = new ToolRegistry();
  const dispatcher = new ToolDispatcher(registry);
  registry.register(SAFE_TOOL);
  dispatcher.registerHandler(SAFE_TOOL.name, async () => {
    onSafeTool();
    return 'safe operation completed';
  });
  return new AgentLoop({ provider, registry, dispatcher, approvalStore });
}

function neverResolvingApprovalStore(): { store: ApprovalStore; calls: () => number } {
  let approvalCalls = 0;
  const store = new ApprovalStore();
  store.addRule({
    id: 'audit-all-safe-tools',
    name: 'Audit all safe tools',
    description: 'Would wait forever if Full Access failed to skip per-action approval.',
    enabled: true,
    evaluate: (toolName) => toolName === SAFE_TOOL.name,
  });
  store.setHandler(() => {
    approvalCalls += 1;
    return new Promise<boolean>(() => {});
  });
  return { store, calls: () => approvalCalls };
}

async function within<T>(promise: Promise<T>, milliseconds = 1_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Full Access path waited for human input')), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function chatStore(sessionId: string) {
  const messages: Array<{ role: string; content: string }> = [];
  const store = {
    appendMessage: vi.fn((_sessionId: string, role: string, content: string) => {
      messages.push({ role, content });
      return messages.length;
    }),
    createSession: vi.fn(),
    getSession: vi.fn(() => ({ id: sessionId })),
    truncateMessagesAfterLastUser: vi.fn(),
    // 场景工作流把步骤/整轮产出登记为生成物（2026-08-29/30 整轮归档机制）。
    createArtifacts: vi.fn(),
  } as unknown as Parameters<typeof runPersistedChatTurn>[0]['store'];
  return { store, messages };
}

function workflowManifest(): ResolvedRunManifest {
  const scenarioId = 'user:scenarios/full-access-production-audit';
  const agentId = 'user:agents/full-access-production-audit';
  const withoutDigest = {
    contractVersion: 1 as const,
    sessionId: 'full-access-workflow-session',
    projectId: 'full-access-project',
    scenarioId,
    scenarioRevision: 1,
    definitionRevisions: { [scenarioId]: 1, [agentId]: 1 },
    agentIds: [agentId],
    skillIds: [],
    mcpIds: [],
    allowedTools: [SAFE_TOOL.name],
    workflow: [
      {
        id: 'step-one',
        name: 'Step one',
        description: 'Run the first safe operation.',
        agentId,
        skillIds: [],
        toolIds: [SAFE_TOOL.name],
        mcpIds: [],
        dependsOn: [],
        maxTurns: 2,
      },
      {
        id: 'step-two',
        name: 'Step two',
        description: 'Run the second safe operation.',
        agentId,
        skillIds: [],
        toolIds: [SAFE_TOOL.name],
        mcpIds: [],
        dependsOn: ['step-one'],
        maxTurns: 2,
      },
    ],
    maxTurns: 4,
    promptStack: [],
    fullAccess: FULL_ACCESS,
    memory: {
      scope: 'session' as const,
      retainDecisions: true,
      retainArtifacts: true,
      maxSummaryChars: 10_000,
    },
    output: {
      format: 'markdown' as const,
      schema: null,
      requireEvidenceEnvelope: true,
      includeIntegrityReport: true,
    },
    truthPolicy: 'automatic_required' as const,
    createdAt: 1_000,
  };
  const candidate = { ...withoutDigest, manifestDigest: '0'.repeat(64) };
  return ResolvedRunManifestSchema.parse({
    ...withoutDigest,
    manifestDigest: digestResolvedManifestSnapshot(candidate),
  });
}

describe('Full Access production chain attacks', () => {
  it('derives Full Access only from the authoritative manifest and has no interactive branch in agent:chat', () => {
    const root = process.cwd();
    const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
    const chatPage = fs.readFileSync(path.join(root, 'src/pages/ChatPage.tsx'), 'utf8');
    const preload = fs.readFileSync(path.join(root, 'electron/preload.ts'), 'utf8');
    const main = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');
    const chatTurn = fs.readFileSync(path.join(root, 'electron/ChatTurnService.ts'), 'utf8');
    const scenarioWorkflow = fs.readFileSync(path.join(root, 'electron/ScenarioWorkflowService.ts'), 'utf8');
    const agentLoop = fs.readFileSync(path.join(root, 'engine/core/AgentLoop.ts'), 'utf8');
    const chatHandler = main.match(/ipcMain\.handle\('agent:chat',[\s\S]*?ipcMain\.handle\('agent:control'/u)?.[0] ?? '';
    const controlHandler = main.match(/ipcMain\.handle\('agent:control',[\s\S]*?ipcMain\.handle\('agent:status'/u)?.[0] ?? '';

    expect(app).toContain('setPendingChatIntent({');
    expect(app).toContain('autoSend: false');
    expect(chatPage).toContain('await handleLiveInstruction(raw');
    expect(chatPage).toContain("action: 'interrupt'");
    expect(preload).toContain("ipcRenderer.invoke('agent:chat'");
    expect(chatHandler).toContain('personalizationRuntime.resolveForAgent({');
    expect(chatHandler).toContain('fullAccess = resolved.manifest.fullAccess');
    expect(chatHandler).toContain('runPersistedScenarioWorkflow({');
    expect(chatHandler).toContain('runPersistedChatTurn({');
    expect(chatHandler).toContain('signal: activeRun.controller.signal');
    expect(chatHandler).toContain('liveSteering: liveSteeringQueue');
    expect(chatHandler).not.toMatch(/dialog\.|showMessageBox|showOpenDialog|showSaveDialog|requestApproval|hitl:approval/iu);
    expect(controlHandler).toContain('run.ownerWebContentsId !== event.sender.id');
    expect(controlHandler).toContain('liveSteeringQueue.enqueue');
    expect(controlHandler).toContain('run.controller.abort()');
    expect(chatTurn).toContain('fullAccess,');
    expect(scenarioWorkflow).toContain('fullAccess: manifest.fullAccess');

    const hardSafety = agentLoop.indexOf('evaluateHardSafetyBoundary(call.name, call.arguments)');
    const hitl = agentLoop.indexOf('await this.checkHitlApproval(ctx, call, turnIndex)');
    const dispatch = agentLoop.indexOf('await this.dispatcher.dispatch(call, toolContext)');
    // 系统默认权限即 Full Access：策略缺省（!ctx.fullAccess?.…）与显式 false
    // 一律跳过逐动作确认，跳过分支必须先于任何审批请求。
    const skip = agentLoop.indexOf('!ctx.fullAccess?.perActionConfirmation');
    const approval = agentLoop.indexOf('this.approvalStore.checkRequired');
    expect(hardSafety).toBeGreaterThanOrEqual(0);
    expect(hitl).toBeGreaterThan(hardSafety);
    expect(dispatch).toBeGreaterThan(hitl);
    expect(skip).toBeGreaterThanOrEqual(0);
    expect(approval).toBeGreaterThan(skip);
  });

  it('rejects renderer attempts to forge Full Access or downgrade truth controls', () => {
    expect(AgentChatOptionsSchema.safeParse({
      mode: 'send',
      scenarioId: 'builtin:scenarios/general-research',
      projectId: 'project-a',
      fullAccess: FULL_ACCESS,
    }).success).toBe(false);
    expect(AgentChatRequestSchema.safeParse({
      version: 1,
      turnId: 'turn-a',
      sessionId: 'session-a',
      messages: [{ role: 'user', content: 'Run the task.' }],
      scenarioId: 'builtin:scenarios/general-research',
      projectId: 'project-a',
      mode: 'send',
      truthPolicy: 'user_override',
    }).success).toBe(false);
    expect(FullAccessPolicySchema.safeParse({
      ...FULL_ACCESS,
      truthPolicy: 'user_override',
      requireEvidenceEnvelope: false,
    }).success).toBe(false);
    expect(ResolvedRunManifestSchema.safeParse({
      ...workflowManifest(),
      truthPolicy: 'user_override',
    }).success).toBe(false);
  });

  it('runs a persisted Full Access chat tool without consulting a never-resolving approval handler', async () => {
    const approvals = neverResolvingApprovalStore();
    let toolCalls = 0;
    const provider = new SequenceProvider([
      response('', [{ id: 'safe-call-one', name: SAFE_TOOL.name, arguments: { value: 'one' } }]),
      response('Safe chat operation completed.'),
    ]);
    const agentLoop = loopWith(provider, approvals.store, () => { toolCalls += 1; });
    const persistence = chatStore('full-access-chat-session');

    const result = await within(runPersistedChatTurn({
      agentLoop,
      store: persistence.store,
      sessionId: 'full-access-chat-session',
      messages: [{ role: 'user', content: 'Run the safe operation.' }],
      requestId: 'full-access-chat-turn',
      allowedTools: [SAFE_TOOL.name],
      maxTurns: 3,
      taskContractHash: 'a'.repeat(64),
      promptStackHash: 'b'.repeat(64),
      fullAccess: FULL_ACCESS,
    }));

    expect(result.status).toBe('completed');
    expect(result.answer).toBe('Safe chat operation completed.');
    expect(toolCalls).toBe(1);
    expect(approvals.calls()).toBe(0);
    expect(persistence.messages).toEqual([
      { role: 'user', content: 'Run the safe operation.' },
      { role: 'assistant', content: 'Safe chat operation completed.' },
    ]);
  });

  it('runs every Full Access workflow step without consulting a never-resolving approval handler', async () => {
    const manifest = workflowManifest();
    const approvals = neverResolvingApprovalStore();
    let toolCalls = 0;
    const provider = new SequenceProvider([
      response('', [{ id: 'workflow-safe-one', name: SAFE_TOOL.name, arguments: { value: 'one' } }]),
      response('Step one completed.'),
      response('', [{ id: 'workflow-safe-two', name: SAFE_TOOL.name, arguments: { value: 'two' } }]),
      response('Step two completed.'),
    ]);
    const concreteLoop = loopWith(provider, approvals.store, () => { toolCalls += 1; });
    const requests: AgentRunRequest[] = [];
    const results: AgentRunResult[] = [];
    const agentLoop = {
      run: async (request: AgentRunRequest) => {
        requests.push(request);
        const result = await concreteLoop.run(request);
        results.push(result);
        return result;
      },
    };
    const persistence = chatStore(manifest.sessionId);
    const checkpoints: unknown[] = [];
    const repository = {
      getRecoverableScenarioRun: vi.fn(() => undefined),
      saveScenarioRunRecord: vi.fn((record: unknown) => { checkpoints.push(record); return record; }),
      listCompletedScenarioRunRecords: vi.fn(() => []),
      // 整轮归档用场景名命名最终成果生成物（2026-08-30 契约新增）。
      get: vi.fn(() => undefined),
      supersedeOtherScenarioRuns: vi.fn(() => 0),
    } as unknown as Parameters<typeof runPersistedScenarioWorkflow>[0]['repository'];

    const result = await within(runPersistedScenarioWorkflow({
      agentLoop,
      store: persistence.store,
      repository,
      sessionId: manifest.sessionId,
      messages: [{ role: 'user', content: 'Execute both workflow steps.' }],
      requestId: 'full-access-workflow-turn',
      manifest,
      systemPrompt: 'Keep automatic truth and evidence controls active.',
    }));

    expect(result.status).toBe('completed');
    expect(result.answer).toBe('Step two completed.');
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.fullAccess === manifest.fullAccess)).toBe(true);
    expect(results.every((run) => run.traceEvents.some(
      (event) => event.event === 'hitl.skipped_full_access',
    ))).toBe(true);
    expect(toolCalls).toBe(2);
    expect(approvals.calls()).toBe(0);
    expect(checkpoints.length).toBeGreaterThan(0);
  });

  it('keeps hard safety ahead of Full Access approval skipping in the persisted chat path', async () => {
    let handlerCalls = 0;
    let approvalCalls = 0;
    const approvals = new ApprovalStore();
    approvals.addRule(WRITE_APPROVAL_RULE);
    approvals.setHandler(() => {
      approvalCalls += 1;
      return new Promise<boolean>(() => {});
    });
    const executeCommand: ToolSpec = {
      name: 'execute_command',
      description: 'Execute a command.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
        },
        required: ['command', 'args'],
      },
    };
    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);
    registry.register(executeCommand);
    dispatcher.registerHandler(executeCommand.name, async () => {
      handlerCalls += 1;
      return 'must not execute';
    });
    const provider = new SequenceProvider([
      response('', [{
        id: 'destructive-full-access-call',
        name: executeCommand.name,
        arguments: { command: 'git', args: ['reset', '--hard'] },
      }]),
    ]);
    const concreteLoop = new AgentLoop({ provider, registry, dispatcher, approvalStore: approvals });
    let runResult: AgentRunResult | undefined;
    const persistence = chatStore('full-access-hard-safety-session');
    const result = await within(runPersistedChatTurn({
      agentLoop: {
        run: async (request) => {
          runResult = await concreteLoop.run(request);
          return runResult;
        },
      },
      store: persistence.store,
      sessionId: 'full-access-hard-safety-session',
      messages: [{ role: 'user', content: 'Attempt a destructive command.' }],
      requestId: 'full-access-hard-safety-turn',
      allowedTools: [executeCommand.name],
      maxTurns: 2,
      fullAccess: FULL_ACCESS,
    }));

    expect(result.status).toBe('interrupted');
    expect(handlerCalls).toBe(0);
    expect(approvalCalls).toBe(0);
    expect(runResult?.traceEvents.some((event) => event.event === 'tool.blocked_hard_safety')).toBe(true);
    expect(persistence.messages).toEqual([
      { role: 'user', content: 'Attempt a destructive command.' },
    ]);
  });

  it('applies queued guidance and stop through the persisted Full Access chat path', async () => {
    const approvals = neverResolvingApprovalStore();
    const queue = new InMemoryLiveSteeringQueue();
    queue.enqueue({
      type: 'instruction',
      id: 'full-access-guide-one',
      sessionId: 'full-access-guided-session',
      sequence: 1,
      createdAt: 1,
      content: 'Prioritize the counterexample.',
    });
    const guidedProvider = new SequenceProvider([response('Guidance applied.')]);
    const guidedPersistence = chatStore('full-access-guided-session');
    const guided = await within(runPersistedChatTurn({
      agentLoop: loopWith(guidedProvider, approvals.store),
      store: guidedPersistence.store,
      sessionId: 'full-access-guided-session',
      messages: [{ role: 'user', content: 'Start the research.' }],
      requestId: 'full-access-guided-turn',
      fullAccess: FULL_ACCESS,
      liveSteering: queue,
      maxTurns: 2,
    }));
    expect(guided.status).toBe('completed');
    expect(guidedProvider.receivedMessages[0]?.some(
      (message) => message.role === 'user' && message.content === 'Prioritize the counterexample.',
    )).toBe(true);

    const blockingProvider = new BlockingProvider();
    const controller = new AbortController();
    const stoppedPersistence = chatStore('full-access-stopped-session');
    const pending = runPersistedChatTurn({
      agentLoop: loopWith(blockingProvider, approvals.store),
      store: stoppedPersistence.store,
      sessionId: 'full-access-stopped-session',
      messages: [{ role: 'user', content: 'Start then stop.' }],
      requestId: 'full-access-stopped-turn',
      fullAccess: FULL_ACCESS,
      signal: controller.signal,
      maxTurns: 2,
    });
    await blockingProvider.started;
    controller.abort();
    const stopped = await within(pending);
    expect(stopped.status).toBe('interrupted');
    expect(stopped.answer).toBe('');
    expect(stoppedPersistence.messages).toEqual([
      { role: 'user', content: 'Start then stop.' },
    ]);
  });

  it('stops the persisted Full Access run while a non-cooperative tool result is still pending', async () => {
    let markToolStarted!: () => void;
    let releaseTool!: () => void;
    const toolStarted = new Promise<void>((resolve) => { markToolStarted = resolve; });
    const toolPending = new Promise<string>((resolve) => {
      releaseTool = () => resolve('late tool completion');
    });
    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);
    registry.register(SAFE_TOOL);
    dispatcher.registerHandler(SAFE_TOOL.name, async () => {
      markToolStarted();
      return toolPending;
    });
    const provider = new SequenceProvider([
      response('', [{ id: 'pending-safe-tool', name: SAFE_TOOL.name, arguments: { value: 'pending' } }]),
      response('must not become final'),
    ]);
    const loop = new AgentLoop({ provider, registry, dispatcher });
    const controller = new AbortController();
    const persistence = chatStore('full-access-pending-tool-session');
    const pendingRun = runPersistedChatTurn({
      agentLoop: loop,
      store: persistence.store,
      sessionId: 'full-access-pending-tool-session',
      messages: [{ role: 'user', content: 'Start the pending safe tool.' }],
      requestId: 'full-access-pending-tool-turn',
      allowedTools: [SAFE_TOOL.name],
      fullAccess: FULL_ACCESS,
      signal: controller.signal,
      maxTurns: 2,
    });
    await toolStarted;
    controller.abort();
    const stopOutcome = await Promise.race([
      pendingRun.then(() => 'stopped' as const),
      new Promise<'still_waiting'>((resolve) => setTimeout(() => resolve('still_waiting'), 100)),
    ]);
    releaseTool();
    const result = await pendingRun;

    expect(stopOutcome).toBe('stopped');
    expect(result.status).toBe('interrupted');
    expect(result.answer).toBe('');
    expect(provider.callCount).toBe(1);
    expect(persistence.messages).toEqual([
      { role: 'user', content: 'Start the pending safe tool.' },
    ]);
  });
});
