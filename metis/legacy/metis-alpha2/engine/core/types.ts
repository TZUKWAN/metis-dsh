/**
 * Core types for the Metis Workbench Agent Engine.
 *
 * Ported from metis/runtime/response.py + metis/runtime/loop.py StateStore protocol.
 */

import type { BaseProvider } from '../providers/BaseProvider.js';
import type { FullAccessPolicy } from '../runtime/PersonalizationRuntimeContract.js';
import type { LiveSteeringSource } from '../runtime/LiveSteeringContract.js';
import type { ProviderProfileBinding } from '../runtime/ProviderProfileContract.js';

// ─── Tool System ──────────────────────────────────────────────

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  id: string;
  raw?: unknown;
}

export interface ToolResult {
  toolName: string;
  content: string;
  status: 'ok' | 'error';
  toolCallId: string;
  error?: string;
  metadata: Record<string, unknown>;
}

/**
 * A completed tool effect captured at a Workflow checkpoint. The key is
 * stable for one logical Step + exact argument payload, so a resumed Step can
 * feed the original result back to the Agent without executing that effect a
 * second time.
 */
export interface ToolEffectSnapshot {
  idempotencyKey: string;
  scope: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result: ToolResult;
  completedAt: number;
}

/** Deterministic, collision-free-for-the-payload key used by checkpoint replay. */
export function createToolEffectKey(
  scope: string,
  toolName: string,
  argumentsValue: Record<string, unknown>,
): string {
  return `${scope}:${toolName}:${stableSerialize(argumentsValue)}`;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}

/** Strict, sanitized message shape sent back to the LLM provider.
 *  This is produced from a ToolResult via a per-tool presenter so that
 *  filesystem paths, credentials, and other raw execution artifacts never
 *  reach the provider context. */
export interface ProviderFeedback {
  role: 'tool';
  content: string;
  toolCallId: string;
  name: string;
}

// ─── Provider Responses ───────────────────────────────────────

export interface NormalizedResponse {
  content: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: ProviderUsage;
  raw?: unknown;
}

export interface StreamChunk {
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  isFinished: boolean;
  usage: ProviderUsage;
}

export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ─── Agent Run ────────────────────────────────────────────────

export interface AgentRunRequest {
  messages: ChatMessage[];
  maxTurns: number;
  sessionId: string;
  allowedTools?: string[];
  allowedToolPermissions?: string[];
  taskContractHash: string;
  promptStackHash: string;
  resumeFromCheckpoint: boolean;
  requestId: string;
  /** Optional skill system prompt to inject at the start of messages */
  skillPrompt?: string;
  /**
   * Run-scoped Full Access policy resolved from the immutable scenario snapshot.
   * AgentLoop validates this object at runtime before it can bypass HITL prompts.
   */
  fullAccess?: FullAccessPolicy;
  /** Cooperative cancellation for a live run. Aborted runs return `interrupted`. */
  signal?: AbortSignal;
  /** Optional strict source of live user instructions and interrupt commands. */
  liveSteering?: LiveSteeringSource;
  /** Active project scope (METIS-F12): forwarded into ToolContext for tools. */
  projectId?: string;
  /** Stable logical Workflow Step scope used to checkpoint tool effects. */
  toolEffectScope?: string;
  /** Completed effects from a prior attempt of this exact logical Step. */
  replayToolEffects?: ToolEffectSnapshot[];
  /** Invoked immediately after a successful effect so its checkpoint can be persisted before the Step ends. */
  onToolEffect?: (effect: ToolEffectSnapshot) => void | Promise<void>;
  /**
   * O13: 本次运行生效的 provider profile 绑定（全局默认或项目覆盖解析结果）。
   * 由 WorkflowEngine/GoalEngine 在构建请求时注入，随 run 记录持久化以便审计。
   */
  providerProfileBinding?: ProviderProfileBinding;
  /**
   * UX-CHAT-002 soft turn windows: when > 1, exhausting `maxTurns` no longer
   * fails the run while the window made real progress (a successful model
   * response). Instead the loop tightens the context budget (auto-compression),
   * traces `agent.window_renewed`, and continues with a fresh window. The run
   * still stops honestly when windows are exhausted or a window makes no
   * progress. Default 1 preserves the original single-window semantics for
   * Workflow/Goal callers.
   */
  turnWindows?: number;
}

export interface AgentRunResult {
  status: AgentRunStatus;
  finalText: string;
  finalVerified: boolean;
  messages: ChatMessage[];
  turnsUsed: number;
  toolResults: ToolResult[];
  usage: ProviderUsage;
  errors: string[];
  traceEvents: TraceEvent[];
}

export type AgentRunStatus =
  | 'completed'
  | 'interrupted'
  | 'error'
  | 'max_turns_reached'
  | 'context_exhausted'
  | 'cancelled';

// ─── Chat Messages ────────────────────────────────────────────

export type ChatMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatMessageRole;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  metadata?: Record<string, unknown>;
  /**
   * Inline images attached to this message (METIS-WX-2 vision): serialized as
   * OpenAI image_url content blocks when the provider reports vision support.
   * Transient — never persisted into session history.
   */
  images?: Array<{ mime?: string; dataBase64: string }>;
}

// ─── Provider ─────────────────────────────────────────────────

export interface ProviderCapabilities {
  providerType: string;
  model: string;
  nativeToolCalling: boolean;
  jsonSchemaOutput: boolean;
  streaming: boolean;
  thinking: boolean;
  /** Model accepts inline image content (multimodal chat completions). */
  vision?: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
  maxConcurrency?: number;
  retryableStatusCodes: number[];
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeout: number;
  maxRetries: number;
  retryBackoffSeconds: number;
  /** User-declared multimodal support; gates WeChat image understanding. */
  vision?: boolean;
  /** Maximum context window in tokens (user-declared). 0 = auto-detect. */
  maxContextTokens?: number;
}

// ─── Tool Definition ──────────────────────────────────────────

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;  // JSON Schema
  permissions?: string[];
  examples?: Array<{ input: Record<string, unknown>; output: string }>;
  /**
   * Runtime argument decoder. Must throw or return a validated, typed argument
   * object. If absent, the ToolDispatcher performs no runtime argument
   * validation beyond the JSON Schema shape.
   */
  decodeArgs?: (raw: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Runtime output decoder/presenter. Receives the raw string returned by the
   * handler and must return a safe ToolPresentation. If absent, the output is
   * treated as privileged and replaced with a fixed fallback.
   */
  decodeResult?: (raw: string, status: 'ok' | 'error') => import('../runtime/ToolPresentationContract.js').ToolPresentation;
}

export interface ToolContext {
  sessionId: string;
  workspace: string;
  hooks?: unknown;  // HookBus reference
  turnIndex: number;
  /** Optional LLM provider available to tools for semantic tasks. */
  provider?: BaseProvider;
  /** Cooperative cancellation signal for handlers that support interruption. */
  signal?: AbortSignal;
  /** Active project scope (METIS-F12): tools may scope their writes to it. */
  projectId?: string;
}

// ─── Tracing ──────────────────────────────────────────────────

export interface TraceEvent {
  timestamp: number;
  event: string;
  sessionId: string;
  attributes: Record<string, unknown>;
}

// ─── Session / Checkpoint ─────────────────────────────────────

export interface Session {
  id: string;
  createdAt: number;
  lastActivity: number;
  messageCount: number;
  metadata: Record<string, unknown>;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  phase: string;
  status: string;
  turnIndex: number;
  timestamp: number;
  metadata: Record<string, unknown>;
}

// ─── State Store Protocol ─────────────────────────────────────

export interface StateStore {
  createSession(sessionId: string, options?: Record<string, unknown>): string;
  appendMessage(sessionId: string, role: string, content: string, options?: Record<string, unknown>): number;
  recordToolCall(sessionId: string, toolName: string, args: Record<string, unknown>, options?: Record<string, unknown>): string;
  recordCheckpoint(sessionId: string, options: { phase: string; status: string; [key: string]: unknown }): string;
  recordTokenUsage(sessionId: string, usage: ProviderUsage): void;
}

// ─── Budget ───────────────────────────────────────────────────

export interface BudgetConfig {
  modelContextTokens: number;
  modelOutputTokens: number;
  contextThreshold: number;
  perToolChars: number;
  maxToolResultChars: number;
  maxTurns: number;
}

export type ModelProfileName = 'micro_4k' | 'micro_8k' | 'micro_16k' | 'small' | 'balanced' | 'deep' | 'small_strict';

export interface ModelProfile {
  name: ModelProfileName;
  budget: BudgetConfig;
  requireDoneEvidenceRefs: boolean;
}

// ─── Unified Research Lifecycle (METIS-102) ──────────────────
//
// The single source of truth for the user-facing "research plan" state. This merges the
// previously conflicting concepts of Goal / Plan / Workflow / task-list into one linear
// lifecycle that the UI presents uniformly as "研究计划" (research plan).
//
// Internal runtime objects (Task, Run, Workflow, Skill, ToolCall, Eval) remain
// implementation details and MUST NOT surface as primary user-facing states. They map
// INTO this lifecycle but are not visible as separate status sources.
//
// Transition rules are enforced by `RESEARCH_LIFECYCLE_TRANSITIONS` and validated by
// `assertResearchLifecycleTransition` / `canTransitionResearchLifecycle`. Any code path
// that mutates a plan's status must go through these helpers so there is exactly one
// status state machine in the product.

/** The eight canonical research-plan lifecycle states, in user-facing order. */
export type ResearchLifecycle =
  | 'draft'        // user has expressed interest; nothing committed
  | 'clarified'    // necessary clarifications resolved (scope, method, discipline)
  | 'planned'      // a research plan has been generated
  | 'approved'     // user has approved the plan
  | 'running'      // plan is executing
  | 'reviewing'    // produced artifacts are awaiting user review
  | 'completed'    // review passed; artifacts marked verified
  | 'archived';    // plan frozen for reference; no further mutation

/**
 * Allowed forward transitions. Each state maps to the set of states it may move to.
 * Loop-back / branch transitions (retry, rollback) are expressed here too so the whole
 * machine has exactly one definition. `cancelled` is a terminal modifier reachable from
 * any non-terminal state (handled separately in assertTransition).
 */
export const RESEARCH_LIFECYCLE_TRANSITIONS: Readonly<Record<ResearchLifecycle, readonly ResearchLifecycle[]>> = {
  draft: ['clarified', 'planned', 'archived'],
  clarified: ['planned', 'draft', 'archived'],
  planned: ['approved', 'clarified', 'draft', 'archived'],
  approved: ['running', 'planned', 'archived'],
  running: ['reviewing', 'planned', 'approved', 'archived'], // pause -> back to planned/approved; fail -> retry loops here
  reviewing: ['completed', 'running', 'approved', 'archived'], // request changes -> running; reject -> approved
  completed: ['archived', 'reviewing', 'running'], // re-open for revision
  // 归档可恢复：归档 ≠ 永久冻结。恢复目标由调用方决定（通常 draft/completed）。
  archived: ['completed', 'draft', 'reviewing'],
};

/** 归档状态：可恢复，但默认不参与活跃工作流。 */
export const TERMINAL_LIFECYCLE_STATES: readonly ResearchLifecycle[] = ['archived'];

export function isTerminalResearchLifecycle(state: ResearchLifecycle): boolean {
  return TERMINAL_LIFECYCLE_STATES.includes(state);
}

/** Whether a transition is legal under the unified machine. */
export function canTransitionResearchLifecycle(from: ResearchLifecycle, to: ResearchLifecycle): boolean {
  if (from === to) return true; // idempotent re-affirmation is allowed
  return RESEARCH_LIFECYCLE_TRANSITIONS[from].includes(to);
}

/**
 * Assert a transition is legal; throws a descriptive error on illegal transitions so
 * callers cannot silently corrupt plan state. This is the single gate every status
 * mutation must pass.
 */
export function assertResearchLifecycleTransition(from: ResearchLifecycle, to: ResearchLifecycle): void {
  if (!canTransitionResearchLifecycle(from, to)) {
    throw new Error(
      `Illegal research lifecycle transition: '${from}' -> '${to}'. ` +
        `Allowed from '${from}': [${RESEARCH_LIFECYCLE_TRANSITIONS[from].join(', ')}].`,
    );
  }
}
