import type { AgentLoop } from '../engine/core/AgentLoop.js';
import type { Citation } from '../engine/core/Citation.js';
import type { AgentRunResult, ChatMessage } from '../engine/core/types.js';
import { DEFAULT_MAX_TURNS } from '../engine/core/Config.js';
import type { PersistenceStore } from '../engine/persistence/PersistenceStore.js';
import type { FullAccessPolicy } from '../engine/runtime/PersonalizationRuntimeContract.js';
import type { LiveSteeringSource } from '../engine/runtime/LiveSteeringContract.js';
import type { ProviderProfileBinding } from '../engine/runtime/ProviderProfileContract.js';
import {
  AgentResponseSchema,
  CHAT_RUNTIME_LIMITS,
  CHAT_RUNTIME_CONTRACT_VERSION,
  RuntimeIdSchema,
  type AgentResponse,
} from '../engine/runtime/ChatRuntimeContract.js';
import { checkSessionProjectBinding } from '../engine/runtime/ContextScopeContract.js';

export type ChatTurnMode = 'send' | 'regenerate';

/**
 * UX-CHAT-001: 普通研究对话的默认轮数上限。直接回答仍在首轮结束；当模型
 * 决定调用工具（如读取当前项目资料）时，允许继续生成基于工具结果的最终
 * 回答，而不是在唯一回合里撞上 max_turns_reached。仍是有界策略：场景
 * manifest 或调用方显式传入的 maxTurns 优先级更高。
 */
export const CHAT_DEFAULT_MAX_TURNS = DEFAULT_MAX_TURNS;

/**
 * UX-CHAT-002: 普通对话不因固定回合上限而失败。每个窗口耗尽时，只要窗口内有
 * 真实模型响应，AgentLoop 就收紧上下文预算（自动压缩）并续跑下一个窗口；
 * 连续无进展或窗口耗尽仍诚实停止。默认 8 个窗口 × 12 轮 = 96 轮上限。
 */
export const CHAT_TURN_WINDOWS = 8;

export interface ChatTurnOptions {
  mode?: ChatTurnMode;
}

export type ChatTurnResponse = AgentResponse;

type ChatTurnBeforeFinish = (status: AgentResponse['status']) => void | Promise<void>;

interface RunPersistedChatTurnOptions {
  agentLoop: Pick<AgentLoop, 'run'>;
  store: Pick<
    PersistenceStore,
    'appendMessage' | 'createSession' | 'getSession' | 'truncateMessagesAfterLastUser' | 'updateSession'
  > & Partial<Pick<PersistenceStore, 'beginAgentRun' | 'finishAgentRun'>>;
  sessionId: string;
  messages: ChatMessage[];
  requestId: string;
  skillPrompt?: string;
  allowedTools?: string[];
  maxTurns?: number;
  taskContractHash?: string;
  promptStackHash?: string;
  fullAccess?: FullAccessPolicy;
  signal?: AbortSignal;
  liveSteering?: LiveSteeringSource;
  options?: ChatTurnOptions;
  projectId?: string;
  isCurrentRuntime?: () => boolean;
  /**
   * Runs immediately before the durable AgentRun terminal state is written.
   * The callback is awaited so event publication can settle first.
   */
  beforeFinish?: ChatTurnBeforeFinish;
}

async function finishPersistedAgentRun(input: {
  store: RunPersistedChatTurnOptions['store'];
  runId: string;
  sessionId: string;
  status: AgentResponse['status'];
  terminalReason?: string;
  beforeFinish?: ChatTurnBeforeFinish;
}): Promise<void> {
  // Terminal event delivery is observational: a failing bridge must never leave
  // the durable run stuck in `running`. Awaiting the callback preserves the
  // required event-ledger-before-run-terminal ordering for async publishers.
  try {
    await input.beforeFinish?.(input.status);
  } catch {
    // The bridge itself is best-effort; persistence remains authoritative.
  }
  input.store.finishAgentRun?.({
    runId: input.runId,
    sessionId: input.sessionId,
    status: input.status,
    terminalReason: input.terminalReason,
  });
}

function latestUserMessage(messages: ChatMessage[]): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return message;
  }
  return undefined;
}

function safeTurnId(requestId: string): string {
  const parsed = RuntimeIdSchema.safeParse(requestId);
  return parsed.success ? parsed.data : 'runtime-recovery';
}

export function createChatTurnErrorResponse(
  turnId: string,
  status: AgentResponse['status'],
  code: string,
): AgentResponse {
  return AgentResponseSchema.parse({
    version: CHAT_RUNTIME_CONTRACT_VERSION,
    turnId,
    status,
    answer: '',
    diagnostics: [{ severity: 'error', code }],
    citations: [],
    events: [],
  });
}

export async function runPersistedChatTurn({
  agentLoop,
  store,
  sessionId,
  messages,
  requestId,
  skillPrompt,
  allowedTools,
  maxTurns,
  taskContractHash,
  promptStackHash,
  fullAccess,
  signal,
  liveSteering,
  options,
  projectId,
  isCurrentRuntime,
  beforeFinish,
}: RunPersistedChatTurnOptions): Promise<ChatTurnResponse> {
  const mode = options?.mode ?? 'send';
  const userMessage = latestUserMessage(messages);
  const turnId = safeTurnId(requestId);

  if (!sessionId.trim()) {
    return createChatTurnErrorResponse(turnId, 'error', 'invalid_session');
  }
  if (!userMessage) {
    return createChatTurnErrorResponse(turnId, 'error', 'missing_user_message');
  }

  // 任务2 上下文隔离（fail-closed）：
  // - 隐式建会话必须带上本次请求声明的 projectId，否则会话落库为无主记录，
  //   永远无法被任何项目的 scope 校验与列表覆盖。
  // - session 已归属项目 A 而 request 声明项目 B → 拒绝 scope_mismatch：
  //   不注入 A 的历史、不调用模型；绝不自动改绑或按「最近项目」回退。
  // - 无主 session 首次在项目上下文中使用 → 显式绑定到该 request.projectId
  //   （写绑定，消除存量无主会话；null scope 不等于「所有项目」）。
  const existingSession = store.getSession(sessionId);
  if (!existingSession) {
    store.createSession(sessionId, undefined, projectId);
  } else {
    const scopeIssue = checkSessionProjectBinding(existingSession, { projectId });
    if (scopeIssue) {
      return createChatTurnErrorResponse(turnId, 'error', scopeIssue.code);
    }
    if (!existingSession.projectId && projectId) {
      store.updateSession(sessionId, { projectId });
    }
  }
  if (mode === 'send') {
    store.appendMessage(sessionId, 'user', userMessage.content);
  }
  store.beginAgentRun?.({
    runId: turnId,
    sessionId,
    turnId,
    ...(projectId ? { projectId } : {}),
  });

  let result: AgentRunResult;
  try {
    result = await agentLoop.run({
      messages,
      maxTurns: maxTurns ?? CHAT_DEFAULT_MAX_TURNS,
      turnWindows: CHAT_TURN_WINDOWS,
      allowedTools,
      sessionId,
      requestId,
      taskContractHash: taskContractHash ?? '',
      promptStackHash: promptStackHash ?? '',
      resumeFromCheckpoint: false,
      skillPrompt,
      fullAccess,
      signal,
      liveSteering,
      projectId,
    });
  } catch (error) {
    await finishPersistedAgentRun({
      store,
      runId: turnId,
      sessionId,
      status: 'error',
      terminalReason: 'agent_exception',
      beforeFinish,
    });
    throw error;
  }

  if (isCurrentRuntime && !isCurrentRuntime()) {
    await finishPersistedAgentRun({
      store,
      runId: turnId,
      sessionId,
      status: 'cancelled',
      terminalReason: 'runtime_reconfigured',
      beforeFinish,
    });
    return createChatTurnErrorResponse(turnId, 'cancelled', 'runtime_reconfigured');
  }

  const decoded = presentRunResult(turnId, result);
  if (!decoded) {
    await finishPersistedAgentRun({
      store,
      runId: turnId,
      sessionId,
      status: 'error',
      terminalReason: 'response_contract_error',
      beforeFinish,
    });
    return createChatTurnErrorResponse(turnId, 'error', 'response_contract_error');
  }
  await finishPersistedAgentRun({
    store,
    runId: turnId,
    sessionId,
    status: decoded.status,
    terminalReason: decoded.diagnostics[0]?.code,
    beforeFinish,
  });

  if (decoded.answer) {
    if (isCurrentRuntime && !isCurrentRuntime()) {
      return createChatTurnErrorResponse(turnId, 'cancelled', 'runtime_reconfigured');
    }
    if (mode === 'regenerate') {
      store.truncateMessagesAfterLastUser(sessionId);
    }
    store.appendMessage(sessionId, 'assistant', decoded.answer, {
      metadata: {
        runId: turnId,
        turnId,
        status: decoded.status,
        // O8 citations ride on metadata (engine/core/Citation.ts 契约),
        // 否则重开会话后引用条目全部丢失。
        ...(decoded.citations.length > 0 ? { citations: decoded.citations } : {}),
      },
    });
  }

  return decoded;
}

/**
 * 把一次 AgentLoop 运行结果映射为契约化的 AgentResponse。
 * 返回 undefined 表示结果无法通过响应契约（调用方回退 response_contract_error）。
 * 该函数是 runPersistedChatTurn 与 O15 runEphemeralChatTurn 共用的出口，
 * 保证两种路径的状态/诊断口径完全一致。
 */
const CITATION_CAPABLE_TOOLS = new Set([
  'web_search', 'web_fetch', 'ncpssd_search', 'search_papers', 'arxiv_search',
  'openalex_lookup', 'crossref_lookup', 'search_library', 'web_import',
]);

/**
 * 任务7 Web Research 3.1(2026-09-05 刘总要求):Citation 贯通——从本轮检索类
 * 工具结果中提取真实来源(URL/title),生成可点击引用,修复"调过工具=有引用"
 * 的断链:ChatPage 的 O8 渲染早已存在,但主进程一直返回空数组。
 */
function collectCitations(result: AgentRunResult): Citation[] {
  const citations: Citation[] = [];
  const seen = new Set<string>();
  let index = 1;
  for (const toolResult of result.toolResults) {
    if (!CITATION_CAPABLE_TOOLS.has(toolResult.toolName) || toolResult.status !== 'ok') continue;
    try {
      const parsed = JSON.parse(toolResult.content) as Record<string, unknown>;
      const candidates: Array<{ title: string; url?: string; doi?: string }> = [];
      const pushCandidate = (title: unknown, url: unknown, doi?: unknown): void => {
        if (typeof title === 'string' && title.trim()) {
          candidates.push({ title: title.slice(0, 200), url: typeof url === 'string' ? url.slice(0, 1000) : undefined, doi: typeof doi === 'string' ? doi.slice(0, 200) : undefined });
        }
      };
      if (toolResult.toolName === 'web_search') {
        const result2 = parsed.result as Record<string, unknown> | undefined;
        if (result2) {
          if (Array.isArray(result2.results)) {
            for (const item of result2.results as Array<Record<string, unknown>>) {
              pushCandidate(item.title, item.url);
            }
          }
          if (Array.isArray(result2.relatedTopics)) {
            for (const item of result2.relatedTopics as Array<Record<string, unknown>>) {
              pushCandidate(item.text, item.url);
            }
          }
        }
      } else {
        const papers = parsed.papers ?? parsed.results;
        if (Array.isArray(papers)) {
          for (const item of papers as Array<Record<string, unknown>>) {
            pushCandidate(item.title, item.url, item.doi);
          }
        }
      }
      for (const candidate of candidates) {
        const key = (candidate.url ?? candidate.doi ?? candidate.title).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        citations.push({
          id: String(index),
          label: candidate.title,
          ...(candidate.url ? { url: candidate.url } : {}),
          ...(candidate.doi ? { doi: candidate.doi } : {}),
        });
        index += 1;
        if (index > 20) return citations;
      }
    } catch { /* 非 JSON 工具结果忽略 */ }
  }
  return citations;
}

function presentRunResult(
  turnId: string,
  result: AgentRunResult,
  options?: { acceptUnverified?: boolean },
): AgentResponse | undefined {
  const verifiedAnswer = result.status === 'completed'
    && result.finalVerified
    && result.finalText.trim().length > 0;
  // acceptUnverified（2026-08-22）：工具型任务（场景增量编译）的最终正确性
  // 由调用方自己的严格校验（schema 门）保证，chat 的文本验证门槛不适用；
  // 已处理的中间错误不应把一次实际成功的编译降级为 error。
  const acceptUnverified = options?.acceptUnverified === true && result.status === 'completed';
  const status: AgentResponse['status'] = result.status === 'completed' && !verifiedAnswer && !acceptUnverified
    ? 'error'
    : result.status;
  // 失败诊断必须携带真实原因摘要（provider 错误体/中断信息），
  // 否则 UI 只能显示裸 agent_error，用户无法定位配置问题。
  const lastError = result.errors.length > 0
    ? result.errors[result.errors.length - 1]!.replace(/\s+/gu, ' ').slice(0, 500)
    : undefined;
  const diagnostics = status === 'completed' && result.errors.length === 0
    ? []
    : [{
        severity: 'error' as const,
        code: status === 'error' && result.status === 'completed'
          ? 'answer_unverified'
          : `agent_${status}`,
        ...(lastError ? { message: lastError } : {}),
      }];
  const candidate = {
    version: CHAT_RUNTIME_CONTRACT_VERSION,
    turnId,
    status,
    answer: verifiedAnswer ? result.finalText : '',
    diagnostics,
    citations: collectCitations(result),
    events: presentTraceEvents(result),
  };
  const decoded = AgentResponseSchema.safeParse(candidate);
  return decoded.success ? decoded.data : undefined;
}

/**
 * Translate the engine's completed-run TraceEvent ledger into the renderer's
 * public presentation contract. The trace is already the source of truth for
 * the agent execution; this function deliberately never invents a tool,
 * sub-agent or progress action that the loop did not record.
 */
function presentTraceEvents(result: AgentRunResult): AgentResponse['events'] {
  const events: AgentResponse['events'] = [];
  const traces = result.traceEvents.slice(0, CHAT_RUNTIME_LIMITS.agentEvents);
  let hasTerminalLifecycle = false;

  for (const trace of traces) {
    const timestamp = Number.isSafeInteger(trace.timestamp) && trace.timestamp >= 0
      ? trace.timestamp
      : 0;
    const lifecycle = lifecycleFromTrace(trace.event);
    if (lifecycle) {
      if (lifecycle !== 'started') hasTerminalLifecycle = true;
      events.push({
        type: 'lifecycle',
        phase: lifecycle,
        timestamp,
        summary: trace.event,
      });
      continue;
    }

    events.push({
      type: 'action',
      action: actionCodeForTrace(trace.event, trace.attributes),
      status: actionStatusForTrace(trace.event, trace.attributes),
      timestamp,
      summary: traceSummary(trace.event, trace.attributes),
    });
  }

  const terminal = terminalLifecycleForRun(result.status);
  if (terminal && !hasTerminalLifecycle && events.length < CHAT_RUNTIME_LIMITS.agentEvents) {
    const finalTimestamp = traces.at(-1)?.timestamp;
    events.push({
      type: 'lifecycle',
      phase: terminal,
      timestamp: typeof finalTimestamp === 'number' && Number.isSafeInteger(finalTimestamp) && finalTimestamp >= 0
        ? finalTimestamp
        : Date.now(),
      summary: `agent.${terminal}`,
    });
  }
  return events;
}

function lifecycleFromTrace(event: string): 'started' | 'completed' | 'interrupted' | 'failed' | null {
  switch (event) {
    case 'agent.start': return 'started';
    case 'agent.complete': return 'completed';
    case 'agent.interrupted': return 'interrupted';
    case 'agent.error':
    case 'agent.blocked':
    case 'agent.request_rejected': return 'failed';
    default: return null;
  }
}

function terminalLifecycleForRun(status: AgentRunResult['status']): 'completed' | 'interrupted' | 'cancelled' | 'failed' | null {
  switch (status) {
    case 'completed': return 'completed';
    case 'interrupted': return 'interrupted';
    case 'cancelled': return 'cancelled';
    case 'error':
    case 'context_exhausted':
    case 'max_turns_reached': return 'failed';
    default: return null;
  }
}

function actionCodeForTrace(event: string, attributes: Record<string, unknown>): string {
  const toolName = typeof attributes.tool_name === 'string' ? attributes.tool_name : undefined;
  const source = toolName && event.startsWith('tool.')
    ? `tool:${toolName}`
    : event.replace(/[^A-Za-z0-9._:-]/gu, '_');
  const normalized = source.slice(0, 128);
  return /^[A-Za-z0-9]/u.test(normalized) ? normalized : 'runtime_event';
}

function actionStatusForTrace(event: string, attributes: Record<string, unknown>): 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'unknown' {
  const status = attributes.status;
  if (status === 'pending' || status === 'running' || status === 'completed' || status === 'failed' || status === 'skipped') {
    return status;
  }
  if (status === 'ok') return 'completed';
  if (status === 'error') return 'failed';
  if (event === 'model.request') return 'running';
  if (event === 'hitl.approval_required') return 'pending';
  if (event === 'model.response_superseded' || event === 'tool.calls_superseded') return 'skipped';
  if (event === 'context.overflow' || event === 'agent.loop_detected') return 'failed';
  if (event.startsWith('tool.blocked') || event === 'tool.session_limit') return 'failed';
  return 'completed';
}

function traceSummary(event: string, attributes: Record<string, unknown>): string {
  const toolName = typeof attributes.tool_name === 'string' ? attributes.tool_name.trim() : '';
  return (toolName ? `${event}: ${toolName}` : event).slice(0, 512);
}

// ─── O15: 多模型对比的临时（不落库）对话回合 ──────────────────

export interface RunEphemeralChatTurnOptions {
  agentLoop: Pick<AgentLoop, 'run'>;
  sessionId: string;
  messages: ChatMessage[];
  requestId: string;
  skillPrompt?: string;
  /** Explicit empty list is useful for bounded, document-only assistant turns. */
  allowedTools?: string[];
  maxTurns?: number;
  signal?: AbortSignal;
  projectId?: string;
  /** Credential-free provider routing receipt for this run. */
  providerProfileBinding?: ProviderProfileBinding;
  /** 工具型任务：完成状态由调用方严格校验，不因中间已处理错误降级。 */
  acceptUnverified?: boolean;
}

/**
 * O15: 多模型同会话对比使用的临时回合。与 runPersistedChatTurn 的区别是
 * 完全不触碰 PersistenceStore——对比模式下一个用户问题会并行发给 N 个
 * provider profile，若每个 profile 调用都走持久化路径，用户消息与回答会被
 * 重复写入 N 次。对比回合的持久化由渲染端统一负责（用户消息一次 + 每个
 * profile 的回答各一条），主进程这里只负责「用指定 profile 跑一轮并返回
 * 与正常聊天完全同构的 AgentResponse」。
 */
export async function runEphemeralChatTurn({
  agentLoop,
  sessionId,
  messages,
  requestId,
  skillPrompt,
  allowedTools,
  maxTurns,
  signal,
  projectId,
  providerProfileBinding,
  acceptUnverified,
}: RunEphemeralChatTurnOptions): Promise<ChatTurnResponse> {
  const userMessage = latestUserMessage(messages);
  const turnId = safeTurnId(requestId);

  if (!sessionId.trim()) {
    return createChatTurnErrorResponse(turnId, 'error', 'invalid_session');
  }
  if (!userMessage) {
    return createChatTurnErrorResponse(turnId, 'error', 'missing_user_message');
  }

  const runMessages = providerProfileBinding?.systemPrompt
    ? [{ role: 'system' as const, content: providerProfileBinding.systemPrompt }, ...messages]
    : messages;
  const result = await agentLoop.run({
    messages: runMessages,
    maxTurns: maxTurns ?? CHAT_DEFAULT_MAX_TURNS,
    turnWindows: CHAT_TURN_WINDOWS,
    allowedTools,
    sessionId,
    requestId,
    taskContractHash: '',
    promptStackHash: '',
    resumeFromCheckpoint: false,
    skillPrompt,
    signal,
    projectId,
    ...(providerProfileBinding ? { providerProfileBinding } : {}),
  });

  const decoded = presentRunResult(turnId, result, { acceptUnverified });
  if (!decoded) {
    return createChatTurnErrorResponse(turnId, 'error', 'response_contract_error');
  }
  return decoded;
}
