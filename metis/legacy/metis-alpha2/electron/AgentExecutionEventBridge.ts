import type { AgentLoop } from '../engine/core/AgentLoop.js';
import type { AgentRunStatus } from '../engine/core/types.js';
import type { HookContext } from '../engine/core/HookBus.js';
import {
  AgentExecutionEventSchema,
  AgentToolResultSourceSchema,
  type AgentExecutionEvent,
  type AgentLifecyclePhase,
  type AgentPresentationEvent,
  type AgentToolResultSource,
} from '../engine/runtime/ChatRuntimeContract.js';

type LiveEventLoop = Pick<AgentLoop, 'registerHook' | 'unregisterHook'>;

export interface AgentExecutionEventBridgeOptions {
  sessionId: string;
  turnId: string;
  /** Stable logical run identity. Defaults to turnId for legacy callers. */
  runId?: string;
  /** Correlates all events from this turn with the originating request. */
  correlationId?: string;
  /** Main owns this sink; an IPC send failure can never interrupt the Agent. */
  publish: (event: AgentExecutionEvent) => void;
}

function timestamp(): number {
  return Date.now();
}

function isForSession(context: HookContext, sessionId: string): boolean {
  return context.sessionId === sessionId;
}

function textAction(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) return undefined;
  return value;
}

function toolSources(value: unknown): AgentToolResultSource[] {
  if (!Array.isArray(value)) return [];
  const sources: AgentToolResultSource[] = [];
  for (const candidate of value) {
    const parsed = AgentToolResultSourceSchema.safeParse(candidate);
    if (!parsed.success) continue;
    sources.push(parsed.data);
    if (sources.length >= 32) break;
  }
  return sources;
}

function sanitizedToolDetail(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const content = (value as Record<string, unknown>).content;
  return typeof content === 'string' ? content : undefined;
}

function terminalPhase(status: unknown): AgentLifecyclePhase {
  switch (status) {
    case 'completed': return 'completed';
    case 'interrupted': return 'interrupted';
    case 'cancelled': return 'cancelled';
    default: return 'failed';
  }
}

/**
 * A short-lived adapter from live AgentLoop hooks to the renderer's existing
 * AgentPresentationEvent contract. It emits no derived progress and does not
 * transport model tokens: token streaming stays on chat:stream-chunk.
 */
export class AgentExecutionEventBridge {
  private readonly handlers = new Map<string, string>();
  private loop: LiveEventLoop | undefined;
  private disposed = false;
  private emittedRunningLifecycle = false;
  private emittedTerminalLifecycle = false;
  private nextSequence = 0;
  private readonly runId: string;
  private readonly correlationId: string;

  constructor(private readonly options: AgentExecutionEventBridgeOptions) {
    this.runId = options.runId ?? options.turnId;
    this.correlationId = options.correlationId ?? options.turnId;
  }

  attach(loop: LiveEventLoop): void {
    this.loop = loop;
    this.register(loop, 'agent.pre_run', 'agent-execution-start', (context) => {
      if (!isForSession(context, this.options.sessionId)) return;
      this.publishLifecycle('started', 'agent.pre_run');
    });
    this.register(loop, 'model.request', 'agent-execution-model-request', (context) => {
      if (!isForSession(context, this.options.sessionId)) return;
      if (!this.emittedRunningLifecycle) {
        this.emittedRunningLifecycle = true;
        this.publishLifecycle('running', 'model.request');
      }
      this.publishAction('model.request', 'running', 'model.request');
    });
    // 2026-09-05 无声卡死修复：首字节前的定期心跳，让 UI 能区分「在等」与「挂死」。
    this.register(loop, 'model.waiting', 'agent-execution-model-waiting', (context) => {
      if (!isForSession(context, this.options.sessionId)) return;
      const elapsed = typeof context.elapsedSeconds === 'number' ? context.elapsedSeconds : undefined;
      this.publishAction('model.waiting', 'running', elapsed === undefined ? 'model.waiting' : `model.waiting ${elapsed}s`);
    });
    this.register(loop, 'model.response', 'agent-execution-model-response', (context) => {
      if (!isForSession(context, this.options.sessionId)) return;
      this.publishAction('model.response', 'completed', 'model.response');
    });
    this.register(loop, 'tool.dispatch_started', 'agent-execution-tool-started', (context) => {
      if (!isForSession(context, this.options.sessionId)) return;
      const toolName = textAction(context.toolName);
      if (toolName) this.publishAction(`tool:${toolName}`, 'running', 'tool.dispatch_started');
    });
    this.register(loop, 'tool.dispatched', 'agent-execution-tool-completed', (context) => {
      if (!isForSession(context, this.options.sessionId)) return;
      const toolName = textAction(context.toolName);
      if (!toolName) return;
      this.publishAction(`tool:${toolName}`, context.status === 'ok' ? 'completed' : 'failed', 'tool.dispatched');
      this.publishToolResult(context, toolName, 'tool.dispatched');
    });
    this.register(loop, 'tool.replayed_from_checkpoint', 'agent-execution-tool-replayed', (context) => {
      if (!isForSession(context, this.options.sessionId)) return;
      const toolName = textAction(context.toolName);
      if (!toolName) return;
      this.publishAction(`tool:${toolName}`, 'completed', 'tool.replayed_from_checkpoint');
      this.publishToolResult(context, toolName, 'tool.replayed_from_checkpoint');
    });
    this.register(loop, 'agent.post_run', 'agent-execution-finished', (context) => {
      if (!isForSession(context, this.options.sessionId)) return;
      this.finish(typeof context.status === 'string' ? context.status : 'error');
    });
  }

  /** Emits a terminal event from the actual completed/cancelled IPC response if a loop path did not emit post_run. */
  finish(status: AgentRunStatus | string): void {
    if (this.disposed || this.emittedTerminalLifecycle) return;
    this.emittedTerminalLifecycle = true;
    const phase = terminalPhase(status);
    this.publishLifecycle(phase, `agent.${phase}`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [event, name] of this.handlers) this.loop?.unregisterHook(event, name);
    this.handlers.clear();
    this.loop = undefined;
  }

  private register(
    loop: LiveEventLoop,
    event: string,
    name: string,
    callback: (context: HookContext) => void,
  ): void {
    loop.registerHook(event, (context) => {
      try { callback(context); } catch { /* UI telemetry never changes an Agent run. */ }
      return context;
    }, { name });
    this.handlers.set(event, name);
  }

  private publishLifecycle(phase: AgentLifecyclePhase, summary: string): void {
    this.publish({ type: 'lifecycle', phase, timestamp: timestamp(), summary });
  }

  private publishAction(
    action: string,
    status: Extract<AgentPresentationEvent, { type: 'action' }>['status'],
    summary: string,
  ): void {
    this.publish({ type: 'action', action, status, timestamp: timestamp(), summary });
  }

  /**
   * The engine supplies only a presenter-sanitized ToolResult projection plus
   * displayable source DTOs. Raw metadata, errors, commands and tool output
   * are intentionally not forwarded to the renderer.
   */
  private publishToolResult(context: HookContext, toolName: string, summary: string): void {
    const toolCallId = textAction(context.toolCallId);
    if (!toolCallId) return;
    const detail = sanitizedToolDetail(context.toolFeedback);
    this.publish({
      type: 'tool_result',
      toolCallId,
      toolName,
      status: context.status === 'ok' ? 'completed' : 'failed',
      timestamp: timestamp(),
      summary,
      ...(detail ? { detail } : {}),
      sources: toolSources(context.toolSources),
    });
  }

  private publish(event: AgentPresentationEvent): void {
    if (this.disposed) return;
    const sequence = this.nextSequence++;
    const decoded = AgentExecutionEventSchema.safeParse({
      version: 1,
      eventId: `${this.runId}:${sequence}`,
      runId: this.runId,
      sessionId: this.options.sessionId,
      turnId: this.options.turnId,
      sequence,
      correlationId: this.correlationId,
      event,
    });
    if (!decoded.success) return;
    try { this.options.publish(decoded.data); } catch { /* Renderer delivery is observational only. */ }
  }
}
