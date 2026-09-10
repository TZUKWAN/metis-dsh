import { useState, useRef, useEffect, useCallback, useMemo, useLayoutEffect, memo, type ReactNode } from 'react';
import type { Components } from 'react-markdown';
import { useMetisStore } from '../store';
import { autoResizeTextarea } from '../lib/textareaAutosize.js';
import ModelThinkingSelector from '../components/ModelThinkingSelector';
import { matchSlashCommand, SLASH_COMMANDS, filterSlashCommands } from '../lib/slashCommands';
import { CodeBlock } from '../components/CodeBlock';
import { ScenarioStepCard, parseScenarioStepCard, type ScenarioStepCardData } from '../components/ScenarioStepCard';
import { ScenarioStepCardWithActions } from '../conversation/ScenarioStepCardWithActions';

import { ConversationController } from '../conversation/runtime/ConversationController.js';
import { ingestChatStreamChunk } from '../conversation/runtime/chatStreamAdapter.js';
import { useTranslation } from '../i18n';
import { researchWorkspaceStore, useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import {
  clearPendingChatIntent,
  consumePendingChatIntent,
  peekPendingChatIntent,
} from '../lib/chatIntent.js';
import { PaperclipIcon, BrainIcon, TagIcon, ClockIcon } from '../components/Icons';
import GoalCardInline, { isInternalExecutionCopy, type GoalCardData } from '../components/GoalCardInline';
import AgentActivityTimeline, {
  type AgentActivityEvent,
  type AgentActivityStatus,
} from '../components/AgentActivityTimeline';
import {
  assistantToolPartFromLegacy,
  createAssistantMessageParts,
  normalizeAssistantEvent,
  reduceAssistantMessageParts,
  reduceAssistantMessagePartsBatch,
  type AssistantMessageParts,
  type AssistantToolPart,
  type LegacyAssistantToolCall,
} from '../lib/assistantMessagePartsReducer';
import RightPanel, { type RightPanelTab } from '../components/RightPanel';
import ArtifactPreviewPane from '../components/ArtifactPreviewPane';
import { getDiagnosticMode, type UIMode } from '../../engine/capabilities/DiagnosticMode';
import {
  presentDiagnosticText,
  presentExecutionAction,
  presentExecutionError,
} from '../presentation/executionPresentation';
import {
  SafeMarkdown,
  presentSafeMarkdownText,
  type SafeMarkdownMode,
} from '../presentation/SafeMarkdown';
import { StreamingMarkdown } from '../presentation/StreamingMarkdown';
import { useFollowScroll } from '../hooks/useFollowScroll';
import { extractCitations, extractDoiCitations } from '../../engine/core/Citation.js';
import { toggleForkActive, loadForkMap, saveForkMap, type ForkRecord } from '../../engine/core/MessageFork.js';
import {
  AgentExecutionEventSchema,
  AgentPresentationEventSchema,
  decodeAgentResponse,
  decodeHistoryPayload,
  RuntimeIdSchema,
  type AgentExecutionEvent,
  type AgentResponse,
  type GoalSnapshot,
} from '../../engine/runtime/ChatRuntimeContract';
import {
  decodeArtifactListPayload,
  type ArtifactListItem,
} from '../../engine/runtime/ArtifactRuntimeContract';
import {
  FILE_CAPABILITY_LIMITS,
  type FileCapabilityDescriptor,
} from '../../engine/runtime/FileCapabilityContract';
import './ChatPage.css';
import {
  decodeSessionCreateRequest,
  decodeSessionDeleteRequest,
  decodeSessionListPayload,
  decodeSessionUpdateRequest,
  type SessionListItem,
} from '../../engine/runtime/SessionRuntimeContract';
import type { ScenarioDefinition } from '../../engine/runtime/PersonalizationRuntimeContract';


// ─── Types ────────────────────────────────────────────────────

type ChatMessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'goal';

interface ChatMessage {
  /** Stable render id, assigned when the message enters state (React key). */
  id?: string;
  role: ChatMessageRole;
  content: string;
  timestamp: number;
  /** Legacy role=tool boundary; rendered through the same canonical tool-part shape. */
  toolCall?: LegacyAssistantToolCall;
  /**
   * Public execution information returned by the existing AgentResponse
   * contract. It is deliberately separate from final answer content so an
   * assistant message can present a compact execution timeline first.
   */
  run?: {
    status: AgentActivityStatus;
    events: AgentActivityEvent[];
    parts?: AssistantMessageParts;
    turnId?: string;
    historyIncomplete?: boolean;
  };
  goalCard?: GoalCardData;
  /** True while model tokens are still streaming into this message. */
  streaming?: boolean;
  /** Wall-clock start of the generating turn (for the elapsed timer). */
  startedAt?: number;
  /** Total generation time once the turn settles. */
  durationMs?: number;
  /** Reasoning/thinking tokens streamed by the model, if any. */
  reasoning?: string;
  /**
   * O8: citations for the answer. Each entry links a piece of the answer to a
   * concrete source (library paper / DOI / URL) so the user can trace the claim.
   */
  citations?: import('../../engine/core/Citation.js').Citation[];
  /**
   * O16: message branch/fork. When a user regenerates an answer, the previous
   * answer is kept as an inactive sibling branch rather than deleted, letting
   * the user flip between alternative takes. forkId groups siblings; activeFork
   * marks which sibling is currently displayed.
   */
  forkId?: string;
  /** Zero-based index of this sibling within its fork group. */
  forkIndex?: number;
  /** Total siblings in the fork group (including this one). */
  forkCount?: number;
  /** True when this sibling is the currently displayed one in its group. */
  forkActive?: boolean;
  /**
   * O15: 多模型对比标记——该回答来自哪个 provider profile（展示用标签，
   * 如 "Kimi · kimi-k2"）。仅对比模式下由渲染端打上；普通回答不带此字段。
   */
  modelLabel?: string;
  /**
   * O15: 对比轮次分组 id。同一轮多模型对比的各模型回答共享它，渲染时
   * 并排展示。仅对比模式打上。
   */
  compareGroup?: string;
  /**
   * UX-CHAT-002: 回合失败/中断/取消时留下的未完成草稿标记。流式占位消息在
   * 非成功结算时保留部分内容并打上此标记；空内容则直接删除。
   */
  incomplete?: boolean;
}



function toGoalCardData(goal: GoalSnapshot): GoalCardData | null {
  if (goal.phase === 'unknown') return null;
  const stepStatuses: GoalCardData['stepStatuses'] = {};
  for (const [stepId, status] of Object.entries(goal.stepStatuses)) {
    if (status.status === 'unknown') return null;
    stepStatuses[stepId] = {
      stepId: status.stepId,
      stepName: status.stepName,
      status: status.status,
      output: status.output,
    };
  }
  return {
    ...goal,
    phase: goal.phase,
    stepStatuses,
  };
}

/**
 * Map a persisted goal status (source of truth on the engine side) to the
 * inline card phase. Used when a goal card is opened from the board or when
 * a board move broadcasts goal:changed.
 */
function goalStatusToCardPhase(status: string): GoalCardData['phase'] {
  switch (status) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'running': return 'executing';
    case 'paused': return 'paused';
    default: return 'plan_ready';
  }
}

function runActivity(
  response: AgentResponse,
  initialParts: AssistantMessageParts = createAssistantMessageParts(),
): NonNullable<ChatMessage['run']> {
  // The final response owns the activity trace. Keep canonical live/replay tool
  // parts as supplemental detail because the terminal response may omit the
  // presenter-sanitized result/source payloads emitted by the live bridge.
  const base: AssistantMessageParts = {
    ...initialParts,
    run: {
      ...initialParts.run,
      phases: [...initialParts.run.phases],
      events: response.events.length > 0
        ? initialParts.run.events.filter((event) => event.type === 'tool_result')
        : [...initialParts.run.events],
    },
    tools: [...initialParts.tools],
    seenEventIds: [...initialParts.seenEventIds],
    seenSequences: [...initialParts.seenSequences],
    seenEventKeys: [...initialParts.seenEventKeys],
  };
  const parts = reduceAssistantMessagePartsBatch(
    response.events.map((event) => normalizeAssistantEvent(event)),
    base,
  );
  return {
    status: response.status,
    events: parts.run.events.slice(-AGENT_EXECUTION_EVENT_LIMIT),
    parts,
    turnId: response.turnId,
  };
}

function reduceExecutionEnvelope(
  state: AssistantMessageParts,
  payload: AgentExecutionEvent,
  replayed = false,
): AssistantMessageParts {
  const event = {
    ...payload.event,
    eventId: payload.eventId,
    sequence: payload.sequence,
  } as AgentActivityEvent;
  return reduceAssistantMessageParts(state, normalizeAssistantEvent(event, replayed));
}

function partsFromExecutionEnvelopes(
  envelopes: readonly AgentExecutionEvent[],
  replayed = false,
): AssistantMessageParts {
  return envelopes.reduce(
    (state, payload) => reduceExecutionEnvelope(state, payload, replayed),
    createAssistantMessageParts(),
  );
}

function isAgentRunStatus(value: unknown): value is AgentActivityStatus {
  return value === 'completed'
    || value === 'interrupted'
    || value === 'cancelled'
    || value === 'error'
    || value === 'context_exhausted'
    || value === 'max_turns_reached'
    || value === 'unknown'
    || value === 'running';
}

type Session = SessionListItem;

function chatPrefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type ArtifactItemType = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'md' | 'latex' | 'other';
type RightPanelTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

function toRightPanelTaskStatus(status: string): RightPanelTaskStatus {
  return status === 'running' || status === 'completed' || status === 'failed'
    ? status
    : 'pending';
}

interface ArtifactItem {
  id: string;
  name: string;
  type: ArtifactItemType;
  sourceCapability?: FileCapabilityDescriptor;
  size?: string;
  createdAt: number;
  contentAvailable: boolean;
}
const validArtifactTypes: ArtifactItemType[] = ['pdf', 'docx', 'xlsx', 'pptx', 'md', 'latex', 'other'];
const DEFAULT_SCENARIO_ID = '';
const ACTIVE_SCENARIO_KEY = 'metis:active-scenario-id';
const SCENARIO_CATALOG_MAX_ATTEMPTS = 2;
const SCENARIO_CATALOG_RETRY_DELAY_MS = 150;
const AGENT_EXECUTION_EVENT_LIMIT = 256;
const AGENT_EXECUTION_TURN_BUFFER_LIMIT = 64;

const triggerWordCharacterPattern = /[\p{Script=Latin}\p{N}_]/u;
const triggerLetterPattern = /\p{L}/u;
const triggerNumberPattern = /\p{N}/u;
const triggerLatinLetterPattern = /\p{Script=Latin}/u;

function requiresTriggerWordBoundaries(phrase: string): boolean {
  let hasLatinLetterOrNumber = false;
  for (const character of phrase) {
    if (triggerNumberPattern.test(character)) {
      hasLatinLetterOrNumber = true;
    } else if (triggerLetterPattern.test(character)) {
      if (!triggerLatinLetterPattern.test(character)) return false;
      hasLatinLetterOrNumber = true;
    }
  }
  return hasLatinLetterOrNumber;
}

function includesScenarioTrigger(content: string, phrase: string): boolean {
  if (!requiresTriggerWordBoundaries(phrase)) return content.includes(phrase);

  let searchFrom = 0;
  while (searchFrom <= content.length - phrase.length) {
    const matchIndex = content.indexOf(phrase, searchFrom);
    if (matchIndex === -1) return false;
    const before = Array.from(content.slice(0, matchIndex)).at(-1);
    const after = Array.from(content.slice(matchIndex + phrase.length))[0];
    const hasLeftBoundary = before === undefined || !triggerWordCharacterPattern.test(before);
    const hasRightBoundary = after === undefined || !triggerWordCharacterPattern.test(after);
    if (hasLeftBoundary && hasRightBoundary) return true;
    searchFrom = matchIndex + 1;
  }
  return false;
}

function matchScenarioTrigger(
  content: string,
  scenarios: readonly ScenarioDefinition[],
): ScenarioDefinition | undefined {
  const normalized = content.trim().toLocaleLowerCase();
  if (!normalized) return undefined;
  return scenarios
    .flatMap((scenario) => scenario.triggerPhrases.map((phrase) => ({
      scenario,
      phrase: phrase.trim().toLocaleLowerCase(),
    })))
    .filter((candidate) => candidate.phrase.length > 0 && includesScenarioTrigger(normalized, candidate.phrase))
    .sort((left, right) => right.phrase.length - left.phrase.length
      || left.scenario.name.localeCompare(right.scenario.name))[0]?.scenario;
}

// ─── Timestamp helper (avoids Date.now() in render) ───────────

function now(): number {
  return Date.now();
}

/** Renderer-owned run IDs let the execution event stream join an in-flight turn. */
function createAgentTurnId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `chat-${globalThis.crypto.randomUUID()}`;
  }
  const randomPart = Math.random().toString(36).slice(2, 12);
  return `chat-${Date.now().toString(36)}-${randomPart || 'run'}`;
}

// ─── Task detection heuristics ────────────────────────────────

/**
 * UX-CHAT-003: 任务意图判定从「单关键词命中」收紧为「动作 + 交付物/持续执行
 * 信号」。疑问、讨论、列举研究问题等默认直接回答；显式 /goal、/task 命令和
 * 自主科研入口在路由层直接执行，不经过这里。
 */
const TASK_ACTION_ZH = /(帮我|请|创建|构建|写|撰写|起草|生成|准备|分析|研究|总结|比较|评审|设计|实现|开发|翻译|核对|核查|验证|检索|收集|整理|制定|规划|梳理|调查|执行)/u;
const TASK_DELIVERABLE_ZH = /(报告|论文|综述|大纲|方案|计划|表格|清单|列表|文档|文章|笔记|摘要|流程|代码|实验|项目|数据库|档案集|目录)/u;
const TASK_LONG_RUNNING_ZH = /(完成|执行|跑完|整个|从头到尾|分阶段|逐步|持续|整理成|输出为)/u;
const TASK_ACTION_EN = /\b(create|build|write|draft|generate|prepare|analyze|research|summarize|compare|review|design|implement|develop|conduct|perform|verify|collect|compile|organize)\b/i;
const TASK_DELIVERABLE_EN = /\b(report|paper|outline|plan|list|document|article|summary|task|workflow|code|experiment|project|analysis|review|database|archive)\b/i;
const TASK_LONG_RUNNING_EN = /\b(complete|execute|run|finish|entire|step by step|phase|deliverable)\b/i;

/** 宽松旧规则：只要命中「研究/分析/写/总结」等宽泛词就算任务（误判源）。 */
const OLD_BROAD_TASK_PATTERNS = [
  /\b(help me|create|build|write|analyze|research|generate|prepare|draft|summarize|compare|review|design|implement|develop|conduct|perform)\b/i,
  /(帮我|创建|构建|写|分析|研究|生成|准备|起草|总结|比较|评审|设计|实现|开发|翻译)/,
];

function isQuestionLike(trimmed: string): boolean {
  // 疑问句：以问号结尾，或以典型疑问词开头。
  if (/[?？]$/u.test(trimmed)) return true;
  return /^(什么|谁|何时|哪里|为什么|怎么|如何|是否|能否|哪些|哪个|请(问|教)|what|who|when|where|why|how|is|are|can|could|would|do|does|did)(?:\b)?/iu.test(trimmed);
}

/** 讨论/列举类表达：默认直接回答，不进入任务链路。 */
function isDiscussionLike(trimmed: string): boolean {
  return /(提出|列出|列举|讨论|谈谈|分析一下|请分析|总结一下|介绍一下|梳理一下).{0,30}(问题|观点|看法|思路|方向|建议|想法|议题)/u.test(trimmed);
}

function isTaskLike(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  // 显式命令（防御性；正常路由层已先行处理）。
  if (/^\/(goal|task|autonomous)\b/u.test(trimmed)) return true;
  // 疑问与讨论默认是聊天。
  if (isQuestionLike(trimmed)) return false;
  if (isDiscussionLike(trimmed)) return false;

  const zhAction = TASK_ACTION_ZH.test(trimmed);
  const zhSignal = TASK_DELIVERABLE_ZH.test(trimmed) || TASK_LONG_RUNNING_ZH.test(trimmed);
  if (zhAction && zhSignal) return true;

  const enAction = TASK_ACTION_EN.test(trimmed);
  const enSignal = TASK_DELIVERABLE_EN.test(trimmed) || TASK_LONG_RUNNING_EN.test(trimmed);
  if (enAction && enSignal) return true;

  return false;
}

/**
 * 低置信度任务表达：旧宽泛规则命中、但新规则判定为直接回答的输入。
 * 用于在回答旁提供非阻塞的「转为研究任务」操作，不新增确认弹窗。
 */
function isTaskAmbiguous(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (isQuestionLike(trimmed)) return false;
  return OLD_BROAD_TASK_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function isLikelyGoalFeedback(content: string): boolean {
  const patterns = [
    /\b(change|modify|update|fix|adjust|instead|rather|redo|add|remove|include|exclude|also)\b/i,
    /(修改|更改|调整|换成|不要|重做|再试|加上|去掉|还有|换成)/,
  ];
  return patterns.some(p => p.test(content));
}

// ─── Inline SVG Icons ─────────────────────────────────────────

const toolIcon = (
  <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.3-3.3a1 1 0 0 0 0-1.4l-1.6-1.6a1 1 0 0 0-1.4 0z" />
    <path d="m3 21 7.6-7.6" />
    <path d="m11.6 11.6 2.1-2.1" />
  </svg>
);

const chevronUpIcon = (
  <svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m18 15-6-6-6 6" />
  </svg>
);

const chevronDownIcon = (
  <svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

const editIcon = (
  <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

const regenerateIcon = (
  <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21.5 2v6h-6M2.5 22v-6h6" />
    <path d="M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3" />
  </svg>
);

const copyIcon = (
  <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

// ─── Code Block Component（共享实现，见 components/CodeBlock）─────────────

// ─── Emoji filter — keeps the UI free of emoji anywhere ─────────

const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F100}-\u{1F1FF}\u{1F200}-\u{1F2FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2300}-\u{23FF}]/gu;

function stripEmoji(text: string): string {
  return text.replace(EMOJI_REGEX, '').replace(/\s{2,}/g, ' ').trim();
}

// ─── Markdown Renderer ────────────────────────────────────────

function linkifyDois(content: string): string {
  // Turn bare DOIs in the model output into clickable doi.org links so the
  // message citation can be opened inside Metis.
  return content.replace(
    /(^|[^\w])10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi,
    (match, prefix: string) => {
      const doi = match.slice(prefix.length);
      return `${prefix}[${doi}](https://doi.org/${doi})`;
    },
  );
}

/** Shared source transform for both the settled and streaming render paths. */
function transformChatMarkdown(content: string): string {
  return linkifyDois(stripEmoji(content));
}

/**
 * Module-level code renderer factory so the `code` component keeps a stable
 * identity across renders (a per-render closure would defeat memoization).
 * While `streaming` is true, fenced blocks skip Prism highlighting and render
 * as plain text; the settled path highlights as before.
 */
/** T3：metadata.stepCard 消息的渲染协议（非 Markdown 围栏；content 前缀承载）。 */
function parseStepCardPrefix(content: string): ScenarioStepCardData | null {
  if (!content.startsWith('__STEP_CARD__')) return null;
  try {
    const value = JSON.parse(content.slice('__STEP_CARD__'.length)) as ScenarioStepCardData;
    return value && typeof value === 'object' && typeof value.runId === 'string' ? value : null;
  } catch {
    return null;
  }
}

function createChatCodeComponent(streaming: boolean): Components['code'] {
  return function ChatMarkdownCode({ className, children, ...props }) {
    const match = /language-([\w-]+)/.exec(className || '');
    const code = String(children).replace(/\n$/, '');
    if (match && match[1] === 'metis-step-card') {
      // 步骤卡（2026-09-01 刘总方案）：场景工作流步骤的结构化卡片，
      // 解析失败（旧消息/坏数据）降级为普通代码块展示。
      const card = parseScenarioStepCard(code);
      if (card) return <ScenarioStepCard card={card} />;
    }
    if (match && match[1]) {
      return <CodeBlock language={match[1]} code={code} streaming={streaming} />;
    }
    return <code className="inline-code" {...props}>{children}</code>;
  };
}

const settledChatCodeComponent = createChatCodeComponent(false);
const streamingChatCodeComponent = createChatCodeComponent(true);

const MarkdownContent = memo(function MarkdownContent({
  content,
  uiMode,
  locale,
  onOpenPaper,
}: {
  content: string;
  uiMode: SafeMarkdownMode;
  locale: 'en' | 'zh';
  onOpenPaper?: (doi: string) => void;
}) {
  return (
    <SafeMarkdown
      content={transformChatMarkdown(content)}
      uiMode={uiMode}
      locale={locale}
      onOpenPaper={onOpenPaper}
      codeComponent={settledChatCodeComponent}
    />
  );
});

// ─── Tool Call Card ───────────────────────────────────────────

export function ToolCallCard({
  toolCall,
  tool,
  diagnosticMode,
}: {
  toolCall?: ChatMessage['toolCall'];
  tool?: AssistantToolPart;
  diagnosticMode: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { t, locale } = useTranslation();
  const canonicalTool = tool ?? (toolCall ? assistantToolPartFromLegacy(toolCall) : undefined);
  if (!canonicalTool) return null;

  const statusColor = {
    running: 'var(--status-running)',
    completed: 'var(--status-completed)',
    error: 'var(--status-failed)',
  }[canonicalTool.status];

  const statusLabel: Record<string, string> = {
    running: t('chat.statusRunning'),
    completed: t('chat.statusCompleted'),
    error: t('chat.statusError'),
  };

  const headerContent = (
    <>
      <span className="tool-call-icon">{toolIcon}</span>
      <span className="tool-call-name">
        {presentExecutionAction(canonicalTool.name, locale)}
      </span>
      <span className="tool-call-status" style={{ color: statusColor }}>
        {statusLabel[canonicalTool.status] ?? canonicalTool.status}
      </span>
      <span className="tool-call-toggle" aria-hidden="true">{expanded ? chevronUpIcon : chevronDownIcon}</span>
    </>
  );

  const resultPreview = canonicalTool.result
    ? presentSafeMarkdownText(canonicalTool.result, diagnosticMode ? 'diagnostic' : 'normal', locale)
    : '';
  const errorPreview = canonicalTool.error
    ? presentSafeMarkdownText(canonicalTool.error, diagnosticMode ? 'diagnostic' : 'normal', locale)
    : '';

  return (
    <div className="tool-call-card">
      <button
        type="button"
        className="tool-call-header"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-label={`${presentExecutionAction(canonicalTool.name, locale)} — ${statusLabel[canonicalTool.status] ?? canonicalTool.status}`}
      >
        {headerContent}
      </button>
      {expanded && (
        <div className="tool-call-body">
          {resultPreview && (
            <div className="tool-call-section">
              <h4>{t('chat.result')}</h4>
              <div className="tool-call-result-preview">{resultPreview}</div>
            </div>
          )}
          {errorPreview && (
            <div className="tool-call-section tool-call-section--error">
              <h4>{t('chat.statusError')}</h4>
              <div className="tool-call-result-preview">{errorPreview}</div>
            </div>
          )}
          {canonicalTool.sources.length > 0 && (
            <div className="tool-call-section">
              <h4>{locale === 'zh' ? '来源' : 'Sources'}</h4>
              <ul className="tool-call-sources">
                {canonicalTool.sources.map((source, sourceIndex) => (
                  <li key={`${source.label}-${source.url ?? sourceIndex}`}>
                    {source.url
                      ? <a href={source.url} target="_blank" rel="noreferrer">{source.label}</a>
                      : source.label}
                  </li>
                ))}
              </ul>
            </div>
          )}
        {diagnosticMode && (
            <>
              <div className="tool-call-section">
                <h4>{t('chat.technicalAction')}</h4>
                <pre className="tool-call-code">{presentDiagnosticText(canonicalTool.name)}</pre>
              </div>
              <div className="tool-call-section">
                <h4>{t('chat.arguments')}</h4>
                <pre className="tool-call-code">{presentDiagnosticText(canonicalTool.arguments)}</pre>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Message Component ────────────────────────────────────────

// Memoized at the module level so a token flush re-renders only the bubble
// whose message object actually changed.
const MemoizedAgentActivityTimeline = memo(AgentActivityTimeline);

// Live elapsed timer for the streaming bubble. Isolated in its own component
// so the 500ms ticker re-renders this span only, not the whole bubble.
function MessageElapsed({
  startedAt,
  durationMs,
  streaming,
}: {
  startedAt?: number;
  durationMs?: number;
  streaming?: boolean;
}) {
  const [elapsedMs, setElapsedMs] = useState(durationMs ?? 0);
  useEffect(() => {
    if (streaming && startedAt) {
      const timer = window.setInterval(() => {
        setElapsedMs(Date.now() - (startedAt ?? Date.now()));
      }, 500);
      return () => window.clearInterval(timer);
    }
    // Settle the timer once streaming stops; deferred so the effect body
    // stays free of synchronous setState.
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) setElapsedMs(durationMs ?? 0);
    });
    return () => { cancelled = true; };
  }, [streaming, startedAt, durationMs]);
  return (
    <span className="message-elapsed" data-testid="message-elapsed">
      <ClockIcon size={12} /> {(elapsedMs / 1000).toFixed(1)}s
    </span>
  );
}

const ChatMessageItem = memo(function ChatMessageItem({
  msg,
  index,
  onEdit,
  onRegenerate,
  onSwitchFork,
  isLast,
  diagnosticMode,
  onOpenPaper,
  onStepCardComment,
}: {
  msg: ChatMessage;
  /** Source index in the messages array, forwarded to onEdit. */
  index: number;
  onEdit?: (index: number, content: string) => void;
  onRegenerate?: () => void;
  /** O16: switch which fork sibling is displayed. */
  onSwitchFork?: (forkId: string, targetIndex: number) => void;
  /** T3 二期：Step 卡三操作——提出意见/修改这步 打开 Composer Target Context。 */
  onStepCardComment?: (card: import('../components/ScenarioStepCard').ScenarioStepCardData, mode: 'comment' | 'modify') => void;
  isLast?: boolean;
  onOpenPaper?: (doi: string) => void;
  diagnosticMode: boolean;
}) {
  const { t, locale } = useTranslation();
  const messageUIMode: SafeMarkdownMode = diagnosticMode ? 'diagnostic' : 'normal';
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(stripEmoji(msg.content));
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const content = msg.content || msg.reasoning || '';
    if (!content) return;
    const fallback = () => {
      const textarea = document.createElement('textarea');
      textarea.value = content;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try { document.execCommand('copy'); } catch { /* clipboard unavailable */ }
      document.body.removeChild(textarea);
      setCopied(true);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(content).then(
        () => setCopied(true),
        () => fallback(),
      );
    } else {
      fallback();
    }
    window.setTimeout(() => setCopied(false), 1500);
  }, [msg.content, msg.reasoning]);

  const handleEditSubmit = () => {
    const cleaned = stripEmoji(editValue).trim();
    if (cleaned && onEdit) {
      onEdit(index, cleaned);
    }
    setEditing(false);
  };

  const avatarLabel = msg.role === 'user'
    ? 'U'
    : diagnosticMode && msg.role === 'tool'
      ? 'T'
      : diagnosticMode && msg.role === 'goal'
        ? 'G'
        : 'M';

  // dsh-style live reasoning summary: while streaming a multi-line reasoning
  // trace, the latest line surfaces next to the label. Single-line traces
  // skip it so the summary never duplicates the body verbatim.
  const streamingReasoningLine = (() => {
    if (!msg.streaming || !msg.reasoning || !msg.reasoning.includes('\n')) return '';
    const lines = msg.reasoning.split('\n').filter((line) => line.trim());
    return lines.length > 1 ? lines[lines.length - 1]! : '';
  })();

  return (
    <div className={`chat-message ${msg.role}`}>
      <div className="message-avatar">
        {avatarLabel}
      </div>
      <div className="message-body">
        {msg.role === 'assistant' && msg.run && (
          <MemoizedAgentActivityTimeline
            status={msg.run.status}
            events={msg.run.events}
            parts={msg.run.parts}
            startedAt={msg.startedAt}
            durationMs={msg.durationMs}
            locale={locale}
            diagnosticMode={diagnosticMode}
            historyIncomplete={msg.run.historyIncomplete}
            pendingLabel={msg.run.historyIncomplete
              ? (locale === 'zh' ? '执行历史已部分裁剪' : 'Execution history is partially pruned')
              : undefined}
          />
        )}
        {msg.role === 'tool' ? (
          msg.run?.parts?.tools[0] || msg.toolCall ? (
            <ToolCallCard
              tool={msg.run?.parts?.tools[0]}
              toolCall={msg.toolCall}
              diagnosticMode={diagnosticMode}
            />
          ) : (
            <div className="message-content">
              {diagnosticMode
                ? <MarkdownContent content={presentDiagnosticText(msg.content)} uiMode={messageUIMode} locale={locale} onOpenPaper={onOpenPaper} />
                : t('chat.researchOperationCompleted')}
            </div>
          )
        ) : editing ? (
          <div className="message-edit">
            <textarea
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              rows={3}
              autoFocus
            />
            <div className="message-edit-actions">
              <button className="btn-sm" onClick={() => setEditing(false)}>{t('chat.cancel')}</button>
              <button className="btn-sm btn-primary" onClick={handleEditSubmit}>{t('chat.saveResend')}</button>
            </div>
          </div>
        ) : (
          <div className="message-content">
            {msg.role === 'assistant' && msg.reasoning && (
              <details className="chat-reasoning" open={Boolean(msg.streaming)}>
                <summary>
                  {msg.streaming ? t('chat.reasoningThinking') : t('chat.reasoningLabel')}
                  {streamingReasoningLine && (
                    <span className="chat-reasoning__latest">{streamingReasoningLine}</span>
                  )}
                </summary>
                <div className="chat-reasoning__body">{msg.reasoning}</div>
              </details>
            )}
            {msg.role === 'assistant' && parseStepCardPrefix(msg.content) ? (() => {
              const card = parseStepCardPrefix(msg.content)!;
              return <ScenarioStepCardWithActions card={card} onComment={(c, m) => onStepCardComment?.(c, m)} />;
            })() : msg.role === 'assistant' && msg.streaming ? (
              <StreamingMarkdown
                text={msg.content}
                streaming
                uiMode={messageUIMode}
                locale={locale}
                onOpenPaper={onOpenPaper}
                codeComponent={streamingChatCodeComponent}
                transform={transformChatMarkdown}
              />
            ) : (
              <MarkdownContent content={msg.content} uiMode={messageUIMode} locale={locale} onOpenPaper={onOpenPaper} />
            )}
            {msg.role === 'assistant' && msg.citations && msg.citations.length > 0 && (
              <div className="chat-citations" data-testid="chat-citations">
                {msg.citations.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="chat-citation"
                    title={c.quote || c.label}
                    onClick={() => {
                      if (c.paperId) {
                        window.dispatchEvent(new CustomEvent('metis:open-paper', { detail: { paperId: c.paperId, page: c.page } }));
                      } else if (c.doi) {
                        window.dispatchEvent(new CustomEvent('metis:open-browser-url', { detail: { url: `https://doi.org/${c.doi}` } }));
                      } else if (c.url) {
                        window.dispatchEvent(new CustomEvent('metis:open-browser-url', { detail: { url: c.url } }));
                      }
                    }}
                  >
                    <span className="chat-citation__id">[{c.id}]</span>
                    <span className="chat-citation__label">{c.label}</span>
                    {c.page !== undefined && <span className="chat-citation__page">p.{c.page}</span>}
                  </button>
                ))}
              </div>
            )}
            {msg.role === 'assistant' && msg.incomplete && (
              <div className="chat-incomplete-draft" data-testid="incomplete-draft">
                {locale === 'zh' ? '（回答未完成——以上为中断前的草稿）' : '(Incomplete draft — captured before the turn ended)'}
              </div>
            )}
          </div>
        )}
        {!editing && (
          <div className="message-actions">
            {msg.modelLabel && (
              <span
                className="message-model-label"
                data-testid="message-model-label"
                style={{
                  fontSize: 11, padding: '1px 6px', borderRadius: 3,
                  border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                  color: 'var(--text-secondary)',
                }}
              >
                {msg.modelLabel}
              </span>
            )}
            <span className="message-time">
              {new Date(msg.timestamp).toLocaleTimeString()}
            </span>
            {msg.role === 'assistant' && (msg.streaming || msg.durationMs !== undefined) && (
              <MessageElapsed startedAt={msg.startedAt} durationMs={msg.durationMs} streaming={msg.streaming} />
            )}
            {msg.role === 'user' && onEdit && (
              <button
                className="message-action-btn"
                onClick={() => setEditing(true)}
                title={t('common.edit')}
                aria-label={t('common.edit')}
              >
                {editIcon}
              </button>
            )}
            {(msg.role === 'user' || msg.role === 'assistant') && (
              <button
                className="message-action-btn"
                onClick={handleCopy}
                title={copied ? t('chat.copied') : t('chat.copy')}
                aria-label={copied ? t('chat.copied') : t('chat.copy')}
                data-testid="copy-message"
              >
                {copied ? '✓' : copyIcon}
              </button>
            )}
            {msg.role === 'assistant' && isLast && onRegenerate && (
              <button
                className="message-action-btn"
                onClick={onRegenerate}
                title={t('chat.regenerate')}
                aria-label={t('chat.regenerate')}
              >
                {regenerateIcon}
              </button>
            )}
            {/* O16: fork switcher — appears when this answer has sibling branches. */}
            {msg.role === 'assistant' && msg.forkId && (msg.forkCount ?? 0) > 1 && onSwitchFork && (
              <span className="fork-switcher" data-testid="fork-switcher">
                <button
                  className="message-action-btn"
                  onClick={() => onSwitchFork(msg.forkId!, (msg.forkIndex ?? 0) - 1)}
                  disabled={(msg.forkIndex ?? 0) <= 0}
                  title={t('chat.forkPrev')}
                  aria-label={t('chat.forkPrev')}
                >◀</button>
                <span className="fork-switcher__label">{(msg.forkIndex ?? 0) + 1}/{msg.forkCount}</span>
                <button
                  className="message-action-btn"
                  onClick={() => onSwitchFork(msg.forkId!, (msg.forkIndex ?? 0) + 1)}
                  disabled={(msg.forkIndex ?? 0) >= (msg.forkCount ?? 1) - 1}
                  title={t('chat.forkNext')}
                  aria-label={t('chat.forkNext')}
                >▶</button>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// ─── Session Sidebar ──────────────────────────────────────────

function SessionSidebar({
  sessions,
  currentSessionId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onArchive,
  showArchived,
  onToggleArchived,
  uiMode,
}: {
  sessions: Session[];
  currentSessionId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  showArchived: boolean;
  onToggleArchived: () => void;
  uiMode: SafeMarkdownMode;
}) {
  const { t, locale } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const visibleSessions = sessions.filter((s) => (showArchived ? s.archived : !s.archived));

  // Group by date relative to today
  const today = new Date().setHours(0, 0, 0, 0);
  const yesterday = today - 24 * 60 * 60 * 1000;
  const groups: { label: string; items: Session[] }[] = [];
  const todayItems: Session[] = [];
  const yesterdayItems: Session[] = [];
  const earlierItems: Session[] = [];
  for (const s of visibleSessions) {
    const d = new Date(s.lastActivity).setHours(0, 0, 0, 0);
    if (d >= today) todayItems.push(s);
    else if (d >= yesterday) yesterdayItems.push(s);
    else earlierItems.push(s);
  }
  if (todayItems.length) groups.push({ label: t('chat.today') ?? '今天', items: todayItems });
  if (yesterdayItems.length) groups.push({ label: t('chat.yesterday') ?? '昨天', items: yesterdayItems });
  if (earlierItems.length) groups.push({ label: t('chat.earlier') ?? '更早', items: earlierItems });

  const startRename = (s: Session) => {
    setEditingId(s.id);
    setEditValue(presentSafeMarkdownText(s.title || t('chat.newSessionTitle'), uiMode, locale));
  };

  const submitRename = () => {
    if (editingId && editValue.trim()) {
      onRename(editingId, editValue.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="chat-sidebar">
      <div className="chat-sidebar-header">
        <button className="btn-primary btn-full" onClick={onNew}>
          {t('chat.newSession')}
        </button>
      </div>
      <div className="chat-sidebar-toolbar">
        <button
          className={`chat-sidebar-filter ${!showArchived ? 'active' : ''}`}
          onClick={() => { if (showArchived) onToggleArchived(); }}
        >
          {t('chat.activeSessions') ?? '进行中'}
        </button>
        <button
          className={`chat-sidebar-filter ${showArchived ? 'active' : ''}`}
          onClick={() => { if (!showArchived) onToggleArchived(); }}
        >
          {t('chat.archivedSessions') ?? '归档'}
        </button>
      </div>
      <div className="chat-sidebar-list">
        {groups.length === 0 && (
          <div className="chat-sidebar-empty">{t('chat.noSessions')}</div>
        )}
        {groups.map((group) => (
          <div key={group.label} className="chat-session-group">
            <div className="chat-session-group-label">{group.label}</div>
            {group.items.map((s) => {
              const safeTitle = presentSafeMarkdownText(
                s.title || t('chat.newSessionTitle'),
                uiMode,
                locale,
              );
              const safeMessageCount = Number.isFinite(s.messageCount)
                ? Math.max(0, Math.trunc(s.messageCount))
                : 0;
              const activityDate = Number.isFinite(s.lastActivity)
                ? new Date(s.lastActivity)
                : null;
              const safeDate = activityDate && !Number.isNaN(activityDate.getTime())
                ? activityDate.toLocaleDateString()
                : '';
              return (
              <div
                key={s.id}
                className={`chat-session-item ${s.id === currentSessionId ? 'active' : ''}`}
                onClick={() => onSelect(s.id)}
              >
                {editingId === s.id ? (
                  <input
                    className="chat-session-title-input"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={submitRename}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setEditingId(null); }}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <div
                      className="chat-session-title"
                      onDoubleClick={(e) => { e.stopPropagation(); startRename(s); }}
                      title={t('chat.doubleClickRename') ?? '双击重命名'}
                    >
                      {safeTitle}
                    </div>
                    <div className="chat-session-meta">
                      {t('chat.sessionMeta', { count: safeMessageCount, date: safeDate })}
                    </div>
                    <div className="chat-session-actions">
                      <button
                        className="chat-session-action"
                        onClick={(e) => { e.stopPropagation(); onArchive(s.id); }}
                        title={s.archived ? t('chat.unarchive') ?? '取消归档' : t('chat.archive') ?? '归档'}
                      >
                        {s.archived ? '↩' : '↩'}
                      </button>
                      <button
                        className="chat-session-action chat-session-delete"
                        onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                        title={t('chat.deleteSession')}
                      >
                        ×
                      </button>
                    </div>
                  </>
                )}
              </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Chat Page ───────────────────────────────────────────

export interface ChatPageLayoutSlots {
  leftPanel: ReactNode;
  workspace: ReactNode;
  rightPanel: ReactNode;
  /** 生成物预览栏（2026-08-31 布局重构）：projects 模式渲染为最右整列。 */
  previewPanel?: ReactNode;
}

export interface ChatPageProps {
  renderLayout: (slots: ChatPageLayoutSlots) => ReactNode;
  uiMode?: UIMode;
  /** pane：预览走独立预览栏（projects 模式）；inline：右栏内联小卡片（其余模式）。 */
  previewMode?: 'pane' | 'inline';
  intentRevision?: number;
}

export default function ChatPage({ renderLayout, uiMode, intentRevision = 0, previewMode = 'inline' }: ChatPageProps) {
  const { t, locale } = useTranslation();
  const resolvedUIMode = uiMode ?? getDiagnosticMode();

  // Message citation → open the paper inside Metis: local library match first,
  // otherwise open the DOI page in the research browser.
  const openPaperByDoi = useCallback((doi: string) => {
    const normalized = doi.replace(/^https?:\/\/doi\.org\//i, '');
    const local = useMetisStore.getState().papers.find(
      (paper) => paper.doi && paper.doi.toLowerCase() === normalized.toLowerCase(),
    );
    if (local) {
      window.dispatchEvent(new CustomEvent('metis:open-paper', { detail: { paperId: local.id } }));
      return;
    }
    window.dispatchEvent(new CustomEvent('metis:open-browser-url', { detail: { url: `https://doi.org/${normalized}` } }));
  }, []);
  const diagnosticMode = resolvedUIMode === 'diagnostic';
  const [sessions, setSessions] = useState<Session[]>([]);
  // UX-CHAT-003: 低置信度任务表达被直接回答时，提供非阻塞「转为研究任务」建议。
  const [goalSuggestion, setGoalSuggestion] = useState<string | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string>('');
  const [messages, setMessagesState] = useState<ChatMessage[]>([]);
  const messageIdRef = useRef(0);
  const nextMessageId = useCallback(() => {
    messageIdRef.current += 1;
    return `msg-${messageIdRef.current}`;
  }, []);
  // Central id assignment: every message that enters state gets a stable
  // render id so the list can key by identity instead of array index.
  const setMessages: typeof setMessagesState = useCallback((update) => {
    setMessagesState((prev) => {
      const next = typeof update === 'function' ? update(prev) : update;
      let assigned = false;
      const withIds = next.map((msg) => {
        if (msg.id) return msg;
        assigned = true;
        messageIdRef.current += 1;
        return { ...msg, id: `msg-${messageIdRef.current}` };
      });
      return assigned ? withIds : next;
    });
  }, []);
  const [input, setInput] = useState('');
  // T3 二期：Step 卡 Target Context（提出意见/修改这步）
  const [stepTarget, setStepTarget] = useState<Extract<import('../conversation/types').ConversationTarget, { type: 'scenario_step' }> | null>(null);
  const [stepTargetMode, setStepTargetMode] = useState<'comment' | 'modify'>('comment');
  const openStepCardComment = useCallback((card: import('../components/ScenarioStepCard').ScenarioStepCardData, mode: 'comment' | 'modify') => {
    setStepTarget({ type: 'scenario_step', runId: card.runId, stepId: card.stepId, revision: card.iteration, title: card.stepName });
    setStepTargetMode(mode);
  }, []);
  const handleStepCardComment = useMemo(() => openStepCardComment, [openStepCardComment]);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  // Live control state: 'idle' until the user requests an interrupt, 'interrupting'
  // while the active run is draining, back to 'idle' when the run settles.
  const [controlState, setControlState] = useState<'idle' | 'interrupting'>('idle');
  const [historyReady, setHistoryReady] = useState(false);
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([]);

  const normalizeArtifact = useCallback((a: ArtifactListItem): ArtifactItem => {
    return {
      id: a.id,
      name: a.name,
      type: validArtifactTypes.includes(a.type as ArtifactItem['type']) ? (a.type as ArtifactItem['type']) : 'other',
      size: a.size,
      sourceCapability: a.sourceCapability,
      createdAt: a.createdAt,
      contentAvailable: a.contentAvailable,
    };
  }, []);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatMessagesRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef(messages);
  const historyReadyRef = useRef(false);
  // dsh-style scroll ledger: programmatic pins are instant and recorded; any
  // scroll position deviating from the ledger is attributed to the user.
  const {
    atBottom: isFollowingLatest,
    atBottomRef: isFollowingLatestRef,
    pinToBottom: pinChatToBottom,
    engageFollow,
  } = useFollowScroll({ containerRef: chatMessagesRef, trackingReadyRef: historyReadyRef });
  // P0 2026-09-05：对话流式 V2 运行时——累积权威、attempt 身份、3 帧合并发布、
  // immediate 权威结算全部由 ConversationController 承担（见 conversation/runtime/）。
  const chatStreamControllerRef = useRef<ConversationController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 输入框随内容自动增高，最多约 10 行，超出后内部滚动查看。
  useEffect(() => {
    if (inputRef.current) autoResizeTextarea(inputRef.current);
  }, [input]);
  useEffect(() => {
    historyReadyRef.current = historyReady;
  }, [historyReady]);
  const activeSessionIdRef = useRef('');
  const sessionGenerationRef = useRef(0);
  const activeChatRequestRef = useRef<{
    token: symbol;
    turnId: string;
    sessionId: string;
    generation: number;
    projectId: string;
    startedAt: number;
  } | null>(null);
  /** Index of the assistant message currently receiving streamed tokens. */
  const streamingIndexRef = useRef(-1);
  /** Live and replayed public Agent events are scoped by a renderer-provided turn ID. */
  const agentExecutionPartsBufferRef = useRef<Map<string, AssistantMessageParts>>(new Map());
  const agentExecutionEventIdentityRef = useRef<Map<string, { eventIds: Set<string>; sequences: Set<number>; contiguousSequence: number }>>(new Map());
  const agentExecutionReplayInFlightRef = useRef<Set<string>>(new Set());
  const activeRunPartsRef = useRef<AssistantMessageParts>(createAssistantMessageParts());
  const [activeRunParts, setActiveRunParts] = useState<AssistantMessageParts>(createAssistantMessageParts);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Skills
  const [skills, setSkills] = useState<Array<{ id: string; name: string; description: string; category: string }>>([]);
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioDefinition[]>([]);
  const [scenarioLoadState, setScenarioLoadState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [scenarioLoadRevision, setScenarioLoadRevision] = useState(0);
  // 目录重试计数跨 effect 重跑保持(多对话架构 2026-09-05)。
  const catalogAttemptRef = useRef(0);
  const revisionTokenRef = useRef(-1);
  const catalogLastOutcomeRef = useRef<'loading' | 'failed' | 'ready' | null>(null);
  const [activeScenarioId, setActiveScenarioId] = useState(DEFAULT_SCENARIO_ID);
  const activeResearchProjectId = useResearchWorkspaceStore((state) => state.activeProjectId);
  const workspaceProjectsLoading = useResearchWorkspaceStore((state) => state.loading.projects);
  const currentProjectId = activeResearchProjectId ?? 'global';
  const [projectScenarioRun, setProjectScenarioRun] = useState<{
    status: string;
    steps: Array<{ stepId: string; name: string; status: string; prompt?: string }>;
  } | null>(null);

  // Goal integration
  const [activeGoalId, setActiveGoalId] = useState<string | null>(null);
  const activeGoalIdRef = useRef<string | null>(null);
  const goalCardIndexMapRef = useRef<Map<string, number>>(new Map());
  const goalStepElementRefs = useRef<Map<string, HTMLElement>>(new Map());
  const sendInFlightRef = useRef(false);
  const goalEventSequenceRef = useRef<Map<string, number>>(new Map());

  const [dragOver, setDragOver] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [previewContent, setPreviewContent] = useState('');
  const [previewTitle, setPreviewTitle] = useState('');
  const [artifactError, setArtifactError] = useState('');
  const [activeRightPanelTab, setActiveRightPanelTab] =
    useState<RightPanelTab>('tasks');
  const [selectionMenu, setSelectionMenu] = useState<{ text: string; x: number; y: number } | null>(null);


  useEffect(() => {
    let alive = true;
    if (!activeResearchProjectId || !window.metis?.getScenarioRunForProject) {
      setProjectScenarioRun(null);
      return () => { alive = false; };
    }
    const loadRun = async () => {
      const result = await window.metis?.getScenarioRunForProject?.(activeResearchProjectId);
      if (!alive) return;
      setProjectScenarioRun(result?.ok && result.status && result.steps?.length
        ? { status: result.status, steps: result.steps }
        : null);
    };
    void loadRun();
    const interval = window.setInterval(() => { void loadRun(); }, 2_000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [activeResearchProjectId]);

  const hasActiveScenarioRun = projectScenarioRun?.status === 'running';

  const openPreview = useCallback((
    content: string,
    title = locale === 'zh' ? 'AI 生成预览' : 'AI-generated preview',
  ) => {
    setPreviewContent(content);
    setPreviewTitle(title);
    setArtifactError('');
    setActiveRightPanelTab('artifacts');
  }, [locale]);

  const acceptGoalEvent = useCallback((goalId: string, sequence: number) => {
    if (activeGoalIdRef.current !== goalId) return false;
    const previous = goalEventSequenceRef.current.get(goalId) ?? -1;
    if (sequence <= previous) return false;
    goalEventSequenceRef.current.set(goalId, sequence);
    return true;
  }, []);

  const updateGoalCard = useCallback((
    index: number,
    updater: (card: GoalCardData) => GoalCardData,
  ) => {
    setMessages((prev) => prev.map((msg, i) => {
      if (i === index && msg.goalCard) {
        return { ...msg, goalCard: updater(msg.goalCard) };
      }
      return msg;
    }));
  }, []);

  /**
   * Resolve the message index of a goal card. Cards restored from session
   * history never re-enter goalCardIndexMapRef (only goals launched in this
   * app session register there), so fall back to scanning the live message
   * list; otherwise 重试/继续/暂停/取消 on a restored card would silently
   * no-op after a restart.
   */
  const findGoalCardIndex = useCallback((goalId: string): number | undefined => {
    const mapped = goalCardIndexMapRef.current.get(goalId);
    if (mapped !== undefined) return mapped;
    const index = messagesRef.current.findIndex((msg) => msg.goalCard?.goalId === goalId);
    return index >= 0 ? index : undefined;
  }, []);

  /**
   * Hydrate the chat card from the persisted Goal/Workflow view. Live IPC
   * events still own subsequent state transitions; this call only prevents a
   * board-to-chat handoff from degrading real step names into button labels.
   */
  const syncGoalCardWorkflow = useCallback(async (goalId: string, index: number) => {
    const ownerSessionId = currentSessionId;
    const ownerGeneration = sessionGenerationRef.current;
    const result = await window.metis?.getGoalWorkflow?.(goalId);
    if (!result?.success) return;
    // The workflow read may finish after the user has opened another session.
    // Indexes are only meaningful for the session/generation that started it.
    if (activeSessionIdRef.current !== ownerSessionId
      || sessionGenerationRef.current !== ownerGeneration) return;
    // Restored cards are not in the index map; only reject when a *different*
    // index is registered, and verify unregistered cards against the message
    // list so history cards still receive workflow hydration.
    const registeredIndex = goalCardIndexMapRef.current.get(goalId);
    if (registeredIndex !== undefined && registeredIndex !== index) return;
    if (registeredIndex === undefined && messagesRef.current[index]?.goalCard?.goalId !== goalId) return;
    const steps = result.workflow.steps.map((step) => ({
      id: step.id,
      name: step.name,
      description: step.description,
    }));
    const stepStatuses: GoalCardData['stepStatuses'] = Object.fromEntries(steps.map((step) => {
      const resultForStep = result.stepResults[step.id];
      return [step.id, {
        stepId: step.id,
        stepName: step.name,
        status: resultForStep?.status ?? 'pending',
        output: resultForStep?.output ?? '',
      }];
    }));
    updateGoalCard(index, (card) => {
      if (card.goalId !== goalId) return card;
      return {
        ...card,
        planName: result.workflow.name,
        planDescription: result.workflow.description,
        steps,
        stepStatuses,
        progress: {
          completed: Object.values(stepStatuses).filter((step) => step.status === 'completed').length,
          total: steps.length,
          currentStep: Object.values(stepStatuses).find((step) => step.status === 'running')?.stepId ?? card.progress.currentStep,
        },
      };
    });
  }, [currentSessionId, updateGoalCard]);

  const activateSession = useCallback((sessionId: string) => {
    sessionGenerationRef.current += 1;
    activeSessionIdRef.current = sessionId;
    activeChatRequestRef.current = null;
    streamingIndexRef.current = -1;
    agentExecutionPartsBufferRef.current.clear();
    agentExecutionEventIdentityRef.current.clear();
    activeRunPartsRef.current = createAssistantMessageParts();
    setActiveRunParts(createAssistantMessageParts());
    setGoalSuggestion(null);
    setCurrentSessionId(sessionId);
    setMessages([]);
    setHistoryReady(false);
    setArtifacts([]);
    setPreviewContent('');
    setPreviewTitle('');
    setArtifactError('');
    setIsLoading(false);
    setActiveGoalId(null);
    activeGoalIdRef.current = null;
    goalEventSequenceRef.current.clear();
    goalCardIndexMapRef.current.clear();
  }, []);

  const isCurrentSessionGeneration = useCallback((
    sessionId: string,
    generation: number,
  ) => (
    activeSessionIdRef.current === sessionId
    && sessionGenerationRef.current === generation
  ), []);

  // 项目联动视图：有当前科研项目时，会话列表只显示该项目的会话与未关联的
  // 旧会话；其他项目的会话不混入（协同对话与项目聊天即「当前项目的对话」）。
  const projectScopedSessions = useMemo(() => {
    if (!activeResearchProjectId) return sessions;
    return sessions.filter((session) => !session.projectId || session.projectId === activeResearchProjectId);
  }, [sessions, activeResearchProjectId]);

  // 切换科研项目时：若当前会话属于其他项目，自动切到当前项目的最近会话；
  // 当前项目还没有会话时回到空白态（首次发送会自动建会话并绑定项目）。
  // 空会话同样走 activateSession 的受保护过渡（布局所有权不变量）。
  useEffect(() => {
    if (!activeResearchProjectId || !currentSessionId) return;
    const current = sessions.find((session) => session.id === currentSessionId);
    if (current && (!current.projectId || current.projectId === activeResearchProjectId)) return;
    const firstInProject = sessions.find((session) => session.projectId === activeResearchProjectId);
    activateSession(firstInProject?.id ?? '');
  }, [activeResearchProjectId, sessions, currentSessionId, activateSession]);

  const refreshArtifactsForSession = useCallback(async (
    sessionId: string,
    generation: number,
  ) => {
    const listArtifacts = window.metis?.listArtifacts;
    if (!listArtifacts) return;
    try {
      const decoded = decodeArtifactListPayload(await listArtifacts(sessionId));
      if (!isCurrentSessionGeneration(sessionId, generation)) return;
      if (decoded.success) {
        setArtifacts(decoded.items.map(normalizeArtifact));
        setArtifactError('');
      } else {
        setArtifactError(locale === 'zh' ? '暂时无法加载本会话的生成物，请稍后重试。' : 'Artifacts could not be loaded. Please try again.');
      }
    } catch {
      if (isCurrentSessionGeneration(sessionId, generation)) {
        setArtifactError(locale === 'zh' ? '暂时无法加载本会话的生成物，请稍后重试。' : 'Artifacts could not be loaded. Please try again.');
      }
    }
  }, [isCurrentSessionGeneration, locale, normalizeArtifact]);

  const isCurrentChatRequest = useCallback((request: {
    token: symbol;
    turnId: string;
    sessionId: string;
    generation: number;
    projectId: string;
  }) => (
    activeChatRequestRef.current?.token === request.token
    && isCurrentSessionGeneration(request.sessionId, request.generation)
    && (researchWorkspaceStore.getState().activeProjectId ?? 'global') === request.projectId
  ), [isCurrentSessionGeneration]);

  const partsForAgentTurn = useCallback((turnId: string): AssistantMessageParts => (
    agentExecutionPartsBufferRef.current.get(turnId) ?? createAssistantMessageParts()
  ), []);

  const hydrateAgentRunHistory = useCallback(async (
    sessionId: string,
    runId: string,
    generation: number,
    status: AgentActivityStatus,
    initialHistoryIncomplete = false,
  ): Promise<ChatMessage['run'] | undefined> => {
    const metis = window.metis;
    if (!metis?.replayAgentEvents) {
      return {
        status,
        events: [],
        parts: createAssistantMessageParts(),
        turnId: runId,
        ...(initialHistoryIncomplete ? { historyIncomplete: true } : {}),
      };
    }
    const replay = await metis.replayAgentEvents({
      version: 1,
      sessionId,
      runId,
      afterSequence: -1,
      limit: 256,
    });
    if (!isCurrentSessionGeneration(sessionId, generation) || !replay) {
      return {
        status,
        events: [],
        parts: createAssistantMessageParts(),
        turnId: runId,
        ...(initialHistoryIncomplete ? { historyIncomplete: true } : {}),
      };
    }
    const envelopes = replay.events
      .filter((event) => event.sessionId === sessionId && event.runId === runId)
      .sort((left, right) => left.sequence - right.sequence);
    const parts = partsFromExecutionEnvelopes(envelopes, true);
    return {
      status,
      turnId: runId,
      events: parts.run.events.slice(-AGENT_EXECUTION_EVENT_LIMIT),
      parts,
      ...((initialHistoryIncomplete || replay.retentionGap) ? { historyIncomplete: true } : {}),
    };
  }, [isCurrentSessionGeneration]);

  const applyAgentExecutionEnvelope = useCallback((payload: AgentExecutionEvent, replayed = false) => {
    const turnId = payload.turnId;
    const identity = agentExecutionEventIdentityRef.current.get(turnId) ?? {
      eventIds: new Set<string>(),
      sequences: new Set<number>(),
      contiguousSequence: -1,
    };
    if (identity.eventIds.has(payload.eventId) || identity.sequences.has(payload.sequence)) {
      return { accepted: false, contiguousSequence: identity.contiguousSequence, gap: false };
    }
    identity.eventIds.add(payload.eventId);
    identity.sequences.add(payload.sequence);
    while (identity.sequences.has(identity.contiguousSequence + 1)) identity.contiguousSequence += 1;
    agentExecutionEventIdentityRef.current.set(turnId, identity);

    const current = agentExecutionPartsBufferRef.current.get(turnId) ?? createAssistantMessageParts();
    const parts = reduceExecutionEnvelope(current, payload, replayed);
    if (!agentExecutionPartsBufferRef.current.has(turnId)
      && agentExecutionPartsBufferRef.current.size >= AGENT_EXECUTION_TURN_BUFFER_LIMIT) {
      const oldestTurnId = agentExecutionPartsBufferRef.current.keys().next().value;
      if (oldestTurnId) {
        agentExecutionPartsBufferRef.current.delete(oldestTurnId);
        agentExecutionEventIdentityRef.current.delete(oldestTurnId);
      }
    }
    agentExecutionPartsBufferRef.current.set(turnId, parts);

    const request = activeChatRequestRef.current;
    if (request && request.turnId === turnId && isCurrentChatRequest(request)) {
      activeRunPartsRef.current = parts;
      setActiveRunParts(parts);
      setMessages((previous) => previous.map((message) => (
        message.run?.turnId === turnId
          ? { ...message, run: { ...message.run, parts, events: parts.run.events.slice(-AGENT_EXECUTION_EVENT_LIMIT) } }
          : message
      )));
    }
    return {
      accepted: true,
      contiguousSequence: identity.contiguousSequence,
      gap: Array.from(identity.sequences).some((sequence) => sequence > identity.contiguousSequence),
    };
  }, [isCurrentChatRequest]);

  // UX-CHAT-002: 失败/中断/取消时结算当前流式占位消息。空内容 → 删除空气泡；
  // 已有部分内容 → 停止流式并标记为「未完成草稿」，避免空气泡与错误气泡并存。
  const settleStreamingPlaceholder = useCallback((
    request: { startedAt: number },
    completedRun?: ChatMessage['run'],
  ) => {
    const streamedIndex = streamingIndexRef.current;
    if (streamedIndex < 0) return false;
    const durationMs = Date.now() - request.startedAt;
    streamingIndexRef.current = -1;
    setMessages((prev) => {
      const target = prev[streamedIndex];
      if (!target) return prev;
      if (!target.content.trim() && !target.reasoning) {
        return prev.filter((_, index) => index !== streamedIndex);
      }
      return prev.map((message, index) => (index === streamedIndex
        ? { ...message, streaming: false, durationMs, incomplete: true, ...(completedRun ? { run: completedRun } : {}) }
        : message));
    });
    return true;
  }, []);

  // UX-CHAT-004: 回合结算后从持久层刷新会话摘要（消息数与最后活动时间），
  // 让侧栏计数与权威值一致，而不是停留在挂载时的旧快照。
  const refreshSessionSummaries = useCallback(() => {
    const metis = window.metis;
    if (!metis?.listSessions) return;
    void metis.listSessions().then((payload) => {
      const decoded = decodeSessionListPayload(payload);
      if (decoded.success) setSessions(decoded.sessions);
    }).catch(() => { /* 摘要刷新是尽力而为，不影响回合结果 */ });
  }, []);

  // A project change invalidates the renderer-side owner of any in-flight
  // response. The main-process request keeps its original project snapshot,
  // while this view becomes ready for a new project-scoped request.
  useEffect(() => {
    activeChatRequestRef.current = null;
    streamingIndexRef.current = -1;
    agentExecutionPartsBufferRef.current.clear();
    agentExecutionEventIdentityRef.current.clear();
    activeRunPartsRef.current = createAssistantMessageParts();
    setActiveRunParts(createAssistantMessageParts());
    setIsLoading(false);
  }, [currentProjectId]);

  // P0-2: "Ask Metis about this selection" — detect text selection in the messages area.
  useEffect(() => {
    const handler = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? '';
      if (text.length < 3) { setSelectionMenu(null); return; }
      // Only trigger within the messages container.
      const range = sel?.getRangeAt(0);
      const container = range?.startContainer.parentElement?.closest('.chat-messages, .artifact-preview-body');
      if (!container) { setSelectionMenu(null); return; }
      const rect = range?.getBoundingClientRect();
      if (rect) {
        const horizontalMargin = 104;
        const verticalMargin = 40;
        const x = Math.min(
          Math.max(rect.left + rect.width / 2, horizontalMargin),
          Math.max(horizontalMargin, window.innerWidth - horizontalMargin),
        );
        const y = Math.min(
          Math.max(rect.top - 10, verticalMargin),
          Math.max(verticalMargin, window.innerHeight - verticalMargin),
        );
        setSelectionMenu({ text, x, y });
      }
    };
    const closeMenu = () => setSelectionMenu(null);
    document.addEventListener('mouseup', handler);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      document.removeEventListener('mouseup', handler);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, []);

  // Load skills on mount
  useEffect(() => {
    if (!diagnosticMode) return;
    const metis = window.metis;
    if (metis?.listSkills) {
      metis.listSkills().then((s) => {
        setSkills(s.map((sk: { id: string; name: string; description: string; category: string }) => ({ id: sk.id, name: sk.name, description: sk.description, category: sk.category })));
      }).catch(() => {});
    }
    if (metis?.getActiveSkill) {
      metis.getActiveSkill().then((r) => {
        if (r.active) setActiveSkillId(r.active);
      }).catch(() => {});
    }
  }, [diagnosticMode]);

  // Load executable scenarios for every UI mode. The selected scenario is
  // revalidated by preload and main; localStorage only remembers the user's
  // preference and is never an authority boundary.
  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;
    const metis = window.metis;
    // 多对话架构(2026-09-05):同一 revision 下重试已耗尽的 failed 态跨 effect
    // 重跑保持(会话切换重解析不再把失败态冲回 loading,交接提示不闪失)。
    if (revisionTokenRef.current === scenarioLoadRevision && catalogLastOutcomeRef.current === 'failed') {
      setScenarios([]);
      setScenarioLoadState('failed');
      return () => { cancelled = true; };
    }
    setScenarioLoadState('loading');
    if (!metis?.listPersonalization) {
      setScenarios([]);
      setScenarioLoadState('failed');
      return () => { cancelled = true; };
    }
    const loadCatalog = (attempt: number) => {
      void metis.listPersonalization({ contractVersion: 1, kind: 'scenario', includeDisabled: false })
        .then(async (response) => {
          if (cancelled) return;
          const available = response.definitions.filter((definition): definition is ScenarioDefinition => (
            definition.kind === 'scenario'
            && definition.enabled
            && definition.capability !== 'presentation_reserved'
            && definition.provenance.origin !== 'builtin'
          ));
          setScenarios(available);
          // 项目级场景优先（2026-08-29 刘总要求：新建项目可选择场景）：
          // 先读 metis:project-scenario:<projectId>，缺失时退回全局偏好。
          let remembered = DEFAULT_SCENARIO_ID;
          try {
            // 多对话架构(2026-09-04 刘总要求):解析优先级
            // 当前会话的 scenarioId(正式持久化) > 项目默认场景(Project.defaultScenarioId)
            // > legacy localStorage(首次读取即迁移进正式层) > 无场景。
            const currentSession = currentSessionId
              ? projectScopedSessions.find((item) => item.id === currentSessionId) ?? sessions.find((item) => item.id === currentSessionId)
              : undefined;
            if (currentSession?.scenarioId && available.some((scenario) => scenario.id === currentSession.scenarioId)) {
              remembered = currentSession.scenarioId;
            } else if (activeResearchProjectId) {
              let projectDefault: string | null = null;
              try {
                const response = await window.metis?.getDefaultScenario?.(activeResearchProjectId);
                projectDefault = response?.scenarioId ?? null;
              } catch { projectDefault = null; }
              const legacyProject = window.localStorage.getItem(`metis:project-scenario:${activeResearchProjectId}`);
              const legacyValue = projectDefault ?? legacyProject;
              if (legacyValue && available.some((scenario) => scenario.id === legacyValue)) {
                remembered = legacyValue;
                // legacy 迁移:写入正式层后清理旧键(此后以正式持久化为唯一真源)。
                void window.metis?.setDefaultScenario?.(activeResearchProjectId, legacyValue);
                window.localStorage.removeItem(`metis:project-scenario:${activeResearchProjectId}`);
              }
            } else {
              remembered = window.localStorage.getItem(ACTIVE_SCENARIO_KEY) ?? DEFAULT_SCENARIO_ID;
            }
          } catch { /* use factory default */ }
          setActiveScenarioId(remembered === DEFAULT_SCENARIO_ID
            ? DEFAULT_SCENARIO_ID
            : (available.some((scenario) => scenario.id === remembered)
                ? remembered
                : DEFAULT_SCENARIO_ID));
          catalogAttemptRef.current = 0;
          catalogLastOutcomeRef.current = 'ready';
          setScenarioLoadState('ready');
        })
        .catch(() => {
          if (cancelled) return;
          if (attempt < SCENARIO_CATALOG_MAX_ATTEMPTS) {
            retryTimer = window.setTimeout(
              () => { catalogAttemptRef.current = attempt; loadCatalog(attempt + 1); },
              SCENARIO_CATALOG_RETRY_DELAY_MS,
            );
            return;
          }
          catalogAttemptRef.current = attempt;
          catalogLastOutcomeRef.current = 'failed';
          setScenarios([]);
          setScenarioLoadState('failed');
        });
    };
    // 多对话架构(2026-09-05):effect 因会话切换重跑时,重试计数跨重跑保持,
    // 避免会话就绪把有限重试变成无限重试;手动「重新加载场景」按钮负责清零。
    if (revisionTokenRef.current !== scenarioLoadRevision) {
      catalogAttemptRef.current = 0;
      revisionTokenRef.current = scenarioLoadRevision;
    }
    // 重试上限已达时,effect 重跑(会话切换)不再自动调用,保持失败态等待手动重试。
    if (catalogAttemptRef.current >= SCENARIO_CATALOG_MAX_ATTEMPTS) {
      setScenarios([]);
      setScenarioLoadState('failed');
      return () => { cancelled = true; };
    }
    loadCatalog(catalogAttemptRef.current + 1);
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  // currentSessionId 入依赖:切换对话时按该会话正式绑定的 scenarioId 恢复场景选择(2026-09-04 多对话架构)。
  }, [scenarioLoadRevision, activeResearchProjectId, currentSessionId, sessions]);

  // Helper: create a new session (defined before useEffect that calls it).
  // Returns the new session id on success, null on failure — callers that
  // auto-create a session on first send need the id synchronously because
  // React state updates are not visible inside the same invocation.
  async function createNewSession(): Promise<string | null> {
    const ts = now();
    const id = `session_${ts}`;
    const request = decodeSessionCreateRequest({
      sessionId: id,
      ...(activeResearchProjectId ? { projectId: activeResearchProjectId } : {}),
    });
    if (!request.ok) return null;
    const metis = window.metis;
    if (metis?.createSession) {
      const result = await metis.createSession(id, request.value.projectId).catch(() => null);
      if (!result?.success) return null;
    }
    // 多对话架构(2026-09-04 刘总要求):新对话默认绑定项目默认场景(defaultScenarioId
    // 只是推荐值,用户可在对话中单独更换;不影响其他对话)。
    if (metis?.updateSession) {
      let defaultScenario: string | null = null;
      if (activeResearchProjectId) {
        try {
          const response = await metis.getDefaultScenario?.(activeResearchProjectId);
          defaultScenario = response?.scenarioId ?? null;
        } catch { defaultScenario = null; }
      }
      const patch: { scenarioId?: string | null } = { scenarioId: defaultScenario };
      await metis.updateSession(id, patch).catch(() => undefined);
    }
    activateSession(id);
    setSessions((prev) => [
      {
        id,
        title: t('chat.newSessionTitle') ?? '新会话',
        createdAt: ts,
        lastActivity: ts,
        messageCount: 0,
        archived: false,
        projectId: request.value.projectId,
      },
      ...prev,
    ]);
    return id;
  }

  // Helper: delete a session
  async function handleDeleteSession(id: string) {
    const request = decodeSessionDeleteRequest({ sessionId: id });
    if (!request.ok) return;
    const metis = window.metis;
    if (metis?.deleteSession) {
      const result = await metis.deleteSession(id).catch(() => null);
      if (!result?.success) return;
    }
    if (id === currentSessionId) {
      const remaining = sessions.filter((s) => s.id !== id);
      if (remaining.length > 0 && remaining[0]) {
        activateSession(remaining[0].id);
      } else {
        activateSession('');
      }
    }
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }

  // Helper: rename a session and persist metadata
  const handleRenameSession = useCallback(async (id: string, title: string) => {
    const request = decodeSessionUpdateRequest({
      sessionId: id,
      patch: { title },
    });
    if (!request.ok) return;
    const metis = window.metis;
    if (metis?.updateSession) {
      const result = await metis.updateSession(id, request.value.patch).catch(() => null);
      if (!result?.success) return;
    }
    setSessions((prev) => prev.map((s) => (
      s.id === id ? { ...s, title: request.value.patch.title } : s
    )));
  }, []);

  // Name the conversation from its content: the first substantive user
  // message wins; a short or command-like opener falls back to the longest
  // user message so the title still describes the conversation.
  const handleAutoNameSession = useCallback(() => {
    if (!currentSessionId) return;
    const userMessages = messages
      .filter((m) => m.role === 'user' && m.content.trim())
      .map((m) => m.content.trim());
    if (userMessages.length === 0) return;
    const first = userMessages[0]!;
    const candidate = first.length >= 4
      ? first
      : [...userMessages].sort((a, b) => b.length - a.length)[0]!;
    const title = candidate.length > 30 ? `${candidate.slice(0, 30)}…` : candidate;
    void handleRenameSession(currentSessionId, title);
  }, [currentSessionId, messages, handleRenameSession]);

  // Helper: archive/unarchive a session and persist metadata
  async function handleArchiveSession(id: string) {
    const existing = sessions.find((session) => session.id === id);
    if (!existing) return;
    const request = decodeSessionUpdateRequest({
      sessionId: id,
      patch: { archived: !existing.archived },
    });
    if (!request.ok) return;
    if (window.metis?.updateSession) {
      const result = await window.metis.updateSession(id, request.value.patch).catch(() => null);
      if (!result?.success) return;
    }

    const next = sessions.map((session) => (
      session.id === id
        ? { ...session, archived: request.value.patch.archived ?? session.archived }
        : session
    ));
    const updated = next.find((session) => session.id === id);
    if (updated?.archived && id === currentSessionId) {
      const remaining = next.filter((session) => !session.archived);
      if (remaining.length > 0 && remaining[0]) {
        activateSession(remaining[0].id);
      } else {
        activateSession('');
      }
    }
    setSessions(next);
  }


  function inferArtifactType(name: string): typeof artifacts[number]['type'] {
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'pdf') return 'pdf';
    if (['doc', 'docx'].includes(ext)) return 'docx';
    if (['xls', 'xlsx', 'csv'].includes(ext)) return 'xlsx';
    if (['ppt', 'pptx'].includes(ext)) return 'pptx';
    if (['md', 'markdown'].includes(ext)) return 'md';
    if (['tex', 'latex'].includes(ext)) return 'latex';
    return 'other';
  }

  async function handleFileUpload() {
    const sessionId = activeSessionIdRef.current;
    const generation = sessionGenerationRef.current;
    if (!sessionId) return;
    try {
      const picked = await window.metis?.selectFileCapability('artifact-attachment');
      if (!picked?.success) return;
      const fileName = picked.capability.displayName;
      // Compatibility for the legacy diagnostic copy below: this is an opaque
      // capability identifier, never a local filesystem path.
      const filePath = picked.capability.capabilityId;

      const artifactId = `art_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const artifactType = inferArtifactType(fileName);
      if (window.metis?.createArtifact) {
        const result = await window.metis.createArtifact({
          id: artifactId,
          sessionId,
          name: fileName,
          type: artifactType,
          sourceCapabilityId: picked.capability.capabilityId,
          size: '',
        });
        if (!result.success) return;
      } else {
        return;
      }
      if (!isCurrentSessionGeneration(sessionId, generation)) return;
      setArtifacts((prev) => [{
        id: artifactId,
        name: fileName,
        type: artifactType,
        sourceCapability: picked.capability,
        size: '',
        createdAt: Date.now(),
        contentAvailable: false,
      }, ...prev.filter((item) => item.id !== artifactId)]);

      setMessages((prev) => [...prev, {
        role: 'system',
        content: diagnosticMode
          ? `[附件] **${fileName}** 已导入。\n路径: \`${filePath}\`\n你现在可以让 Metis 处理该文件。`
          : t('chat.attachmentImported', { name: fileName }),
        timestamp: now(),
      }]);
    } catch (err: unknown) {
      if (!isCurrentSessionGeneration(sessionId, generation)) return;
      setMessages((prev) => [...prev, {
        role: 'system',
        content: t('chat.importFailed', {
          message: presentExecutionError(err, locale, resolvedUIMode),
        }),
        timestamp: now(),
      }]);
    }
  }

  // Load sessions on mount
  useEffect(() => {
    const metis = window.metis;
    if (metis?.listSessions) {
      metis.listSessions().then((payload) => {
        const decoded = decodeSessionListPayload(payload);
        if (!decoded.success) {
          setSessions([]);
          return;
        }
        const normalized = decoded.sessions;
        setSessions(normalized);
        if (normalized.length > 0 && normalized[0]) {
          activateSession(normalized[0].id);
        }
      }).catch(() => {});
    }
  }, [activateSession]);

  // Listen for artifact creation events from other processes and refresh the list
  useEffect(() => {
    const metis = window.metis;
    if (!metis?.onArtifactCreated) return;
    const unsub = metis.onArtifactCreated(({ sessionId }) => {
      const generation = sessionGenerationRef.current;
      if (sessionId === activeSessionIdRef.current) {
        void refreshArtifactsForSession(sessionId, generation);
      }
    });
    return () => { unsub(); };
  }, [refreshArtifactsForSession]);

  // Load messages and artifacts when session changes
  useEffect(() => {
    if (!currentSessionId) return;
    const sessionId = currentSessionId;
    const generation = sessionGenerationRef.current;
    const metis = window.metis;
    if (metis?.getMessages) {
      metis.getMessages(sessionId).then(async (msgs) => {
        if (!isCurrentSessionGeneration(sessionId, generation)) return;
        // O16: rehydrate fork siblings from the side table. The main-process
        // history only kept the final answer; older branches come back here.
        const restored = decodeHistoryPayload(msgs).map((item): ChatMessage | null => {
          if (item.kind === 'message') {
            const metadata = item.metadata;
            const runId = typeof metadata?.runId === 'string' ? metadata.runId : undefined;
            const turnId = typeof metadata?.turnId === 'string' ? metadata.turnId : undefined;
            const runStatus = metadata?.status;
            const historyIncomplete = metadata?.eventsPruned === true;
            const run = runId && isAgentRunStatus(runStatus) && runStatus !== 'unknown'
              ? {
                status: runStatus,
                events: [],
                parts: createAssistantMessageParts(),
                turnId: turnId ?? runId,
                ...(historyIncomplete ? { historyIncomplete: true } : {}),
              }
              : undefined;
            const stepCard = metadata?.stepCard;
            // T3 全局对话体验重构：新消息的 stepCard 在 metadata（结构化协议），
            // content 已是人话摘要；渲染经 __STEP_CARD__ 前缀走 ScenarioStepCard，
            // 与历史围栏消息同一渲染出口，但不再生成 Markdown 围栏协议。
            const content = stepCard && typeof stepCard === 'object'
              ? `__STEP_CARD__${JSON.stringify(stepCard)}`
              : item.content;
            return {
              role: item.role,
              content,
              timestamp: now(),
              ...(run ? { run } : {}),
              // O8: citations persist on message metadata; rehydrate so chips
              // survive reload, not just the live turn.
              ...(extractCitations(metadata).length > 0 ? { citations: extractCitations(metadata) } : {}),
            };
          }
          if (item.kind === 'goal') {
            const goalCard = toGoalCardData(item.goal);
            if (goalCard) {
              return { role: 'goal', content: '', timestamp: now(), goalCard };
            }
          }
          const recoveryCode = item.kind === 'recovery'
            ? item.code
            : 'goal_snapshot_unavailable';
          // 单条历史记录损坏的占位（history_item_unavailable）连成片刷屏，
          // 内容反正不可恢复——正常模式直接丢弃，诊断模式保留技术码。
          if (item.kind === 'recovery' && item.code === 'history_item_unavailable' && !diagnosticMode) {
            return null;
          }
          return {
            role: 'system',
            content: diagnosticMode
              ? presentDiagnosticText(recoveryCode)
              : t('chat.historyRecoveryFailed'),
            timestamp: now(),
          };
        }).filter((message): message is ChatMessage => message !== null);
        const hydrated = await Promise.all(restored.map(async (message) => {
          if (message.role !== 'assistant' || !message.run?.turnId) return message;
          const run = await hydrateAgentRunHistory(
            sessionId,
            message.run.turnId,
            generation,
            message.run.status,
            message.run.historyIncomplete,
          );
          return run ? { ...message, run } : message;
        }));
        // 卡片 phase 以引擎真实状态为准（2026-08-29 刘总截图问题）：持久化
        // 卡片停留在暂停前的 executing，而 checkpoint 步骤状态已是「已暂停」
        // ——重开会话后「暂停」按钮点下去只会被引擎拒绝，「继续」永远不
        // 出现。恢复时必须用 getGoal 的真实状态校正 phase，让按钮区与
        // checkpoint 一致（paused → 显示「继续」）。
        const goalCorrected = await Promise.all(hydrated.map(async (message) => {
          if (message.role !== 'goal' || !message.goalCard) return message;
          try {
            const goalState = await metis.getGoal?.(message.goalCard.goalId);
            if (!goalState?.success || !goalState.goal) return message;
            const phase = goalStatusToCardPhase(goalState.goal.status);
            if (phase === message.goalCard.phase) return message;
            return { ...message, goalCard: { ...message.goalCard, phase, pauseRequested: false } };
          } catch { return message; }
        }));
        if (!isCurrentSessionGeneration(sessionId, generation)) return;
        setMessages((prev) => {
          const current = prev.length > 0 ? prev : goalCorrected;
          if (!currentSessionId) return current;
          const forkMap = loadForkMap(currentSessionId, localStorage);
          if (forkMap.size === 0) return current;
          // Group persisted siblings by forkId.
          const siblingsByFork = new Map<string, ForkRecord[]>();
          for (const record of forkMap.values()) {
            const list = siblingsByFork.get(record.forkId) ?? [];
            list.push(record);
            siblingsByFork.set(record.forkId, list);
          }
          const out: ChatMessage[] = [];
          for (const msg of current) {
            out.push(msg);
            if (msg.role !== 'assistant') continue;
            // Is this message the final sibling of some fork group?
            const matching = [...siblingsByFork.values()].find((records) =>
              records.some((r) => r.content === msg.content),
            );
            if (!matching) continue;
            const forkId = matching[0]!.forkId;
            // The final sibling is the one whose content matches; older ones
            // become inactive branches right after it.
            const finalIdx = matching.findIndex((r) => r.content === msg.content);
            matching.forEach((record, idx) => {
              if (idx === finalIdx) return;
              out.push({
                role: 'assistant',
                content: record.content,
                timestamp: record.timestamp,
                forkId,
                forkIndex: record.forkIndex,
                forkCount: record.forkCount,
                forkActive: false,
              });
            });
          }
          return out;
        });
        setHistoryReady(true);
      }).catch(() => {
        if (isCurrentSessionGeneration(sessionId, generation)) {
          setMessages([]);
          setHistoryReady(true);
        }
      });
    } else {
      setHistoryReady(true);
    }
    void refreshArtifactsForSession(sessionId, generation);
    // 多对话架构第二期:恢复该会话的输入草稿与当前工作对象。
    try {
      const draftMap = JSON.parse(window.localStorage.getItem('metis:chat-drafts') || '{}') as Record<string, string>;
      setInput(typeof draftMap[sessionId] === 'string' ? draftMap[sessionId] : '');
    } catch { setInput(''); }
    try {
      const storedArtifacts = window.localStorage.getItem(`metis:session-artifacts:${sessionId}`);
      setActiveArtifactIds(storedArtifacts ? (JSON.parse(storedArtifacts) as string[]) : []);
    } catch { setActiveArtifactIds([]); }
  }, [currentSessionId, diagnosticMode, hydrateAgentRunHistory, isCurrentSessionGeneration, refreshArtifactsForSession, t]);

  // Follow the latest message only while the user is near the bottom. Once the
  // user scrolls upward, incoming tokens remain readable instead of hijacking
  // the viewport; the explicit control below restores the lock. The scroll
  // listener itself lives in useFollowScroll (ledger-based user attribution).

  // 会话历史就绪后立即定位到最新消息（2026-08-28 刘总要求：进入聊天应看到
  // 最新的消息在底部，而不是停留在最顶部）。使用瞬时滚动，避免 smooth 动画
  // 期间触发的 scroll 事件把跟随锁误判为关闭。
  useEffect(() => {
    if (!historyReady) return;
    const element = messagesEndRef.current;
    if (!element || typeof element.scrollIntoView !== 'function') return;
    engageFollow();
    element.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [historyReady, currentSessionId, engageFollow]);

  const scrollToLatest = useCallback(() => {
    engageFollow();
    const element = messagesEndRef.current;
    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({
        behavior: chatPrefersReducedMotion() ? 'auto' : 'smooth',
        block: 'end',
      });
    }
  }, [engageFollow]);

  // Streaming follow-scroll: instant pin per committed flow update, only while
  // the user is pinned to the bottom. Instant (not smooth) so rapid token
  // frames never restart a smooth-scroll animation mid-flight.
  useLayoutEffect(() => {
    if (!isFollowingLatestRef.current) return;
    pinChatToBottom();
  }, [messages, isLoading, activeRunParts, isFollowingLatestRef, pinChatToBottom]);

  // Goal IPC event listeners. Raw model stream events are intentionally not
  // exposed by preload, so renderer code cannot accidentally present them.
  useEffect(() => {
    const metis = window.metis;
    if (!metis) return;
    const unsubs: Array<() => void> = [];

    // Goal step start
    if (metis.onGoalStepStart) {
      unsubs.push(metis.onGoalStepStart(({ goalId, sequence, stepId, stepName }) => {
        if (!acceptGoalEvent(goalId, sequence)) return;
        const idx = goalCardIndexMapRef.current.get(goalId);
        if (idx === undefined) return;
        updateGoalCard(idx, (card) => {
          const existing = card.stepStatuses[stepId];
          return {
            ...card,
            stepStatuses: {
              ...card.stepStatuses,
              [stepId]: {
                stepId,
                stepName: existing?.stepName ?? stepName,
                status: 'running',
                output: '',
              },
            },
          };
        });
      }));
    }

    // Goal step complete
    if (metis.onGoalStepComplete) {
      unsubs.push(metis.onGoalStepComplete(({ goalId, sequence, stepId, stepName, output }) => {
        if (!acceptGoalEvent(goalId, sequence)) return;
        const idx = goalCardIndexMapRef.current.get(goalId);
        if (idx === undefined) return;
        updateGoalCard(idx, (card) => {
          const existing = card.stepStatuses[stepId];
          return {
            ...card,
            stepStatuses: {
              ...card.stepStatuses,
              [stepId]: {
                stepId,
                stepName: existing?.stepName ?? stepName,
                status: 'completed',
                output: presentDiagnosticText(output),
              },
            },
          };
        });
      }));
    }

    // Goal step failed
    if (metis.onGoalStepFailed) {
      unsubs.push(metis.onGoalStepFailed(({ goalId, sequence, stepId, stepName, error }) => {
        if (!acceptGoalEvent(goalId, sequence)) return;
        const idx = goalCardIndexMapRef.current.get(goalId);
        if (idx === undefined) return;
        updateGoalCard(idx, (card) => {
          const existing = card.stepStatuses[stepId];
          const safeError = presentDiagnosticText(error);
          return {
            ...card,
            stepStatuses: {
              ...card.stepStatuses,
              [stepId]: {
                stepId,
                stepName: existing?.stepName ?? stepName,
                status: 'failed',
                output: safeError,
              },
            },
            phase: 'failed',
            error: safeError,
          };
        });
      }));
    }

    // Goal progress
    if (metis.onGoalProgress) {
      unsubs.push(metis.onGoalProgress(({ goalId, sequence, completed, total, currentStep }) => {
        if (!acceptGoalEvent(goalId, sequence)) return;
        const idx = goalCardIndexMapRef.current.get(goalId);
        if (idx === undefined) return;
        updateGoalCard(idx, (card) => ({
          ...card,
          progress: { completed, total, currentStep: presentDiagnosticText(currentStep) },
          phase: completed >= total ? 'completed' : 'executing',
        }));
      }));
    }

    // Goal state changed from another surface (kanban moves, plan updates,
    // execution completion): refresh the matching card's phase so both views
    // stay in sync. Execution step events above still own step-level detail.
    if (metis.onGoalChanged) {
      unsubs.push(metis.onGoalChanged((payload) => {
        const { goalId, status } = payload;
        // 多对话架构(2026-09-05):非当前项目的目标变更直接忽略,防跨项目串扰。
        const eventProjectId = (payload as { projectId?: string }).projectId;
        if (eventProjectId && activeResearchProjectId && eventProjectId !== activeResearchProjectId) return;
        const idx = goalCardIndexMapRef.current.get(goalId);
        if (idx === undefined) return;
        updateGoalCard(idx, (card) => {
          const phase = goalStatusToCardPhase(status);
          return { ...card, phase, ...(phase === 'executing' ? {} : { pauseRequested: false }) };
        });
      }));
    }

    return () => { for (const u of unsubs) u(); };
  }, [acceptGoalEvent, isCurrentChatRequest, updateGoalCard, activeResearchProjectId]);

  // Public Agent execution events are emitted by main while the same request
  // is in flight. A renderer-generated turnId is the only join key: delayed
  // events for a previous turn stay buffered and never enter this session.
  useEffect(() => {
    const metis = window.metis;
    if (!metis?.onAgentExecutionEvent) return;
    return metis.onAgentExecutionEvent((payload) => {
      const decoded = AgentExecutionEventSchema.safeParse(payload);
      if (!decoded.success) {
        // Compatibility for older renderer test doubles and pre-envelope bridges.
        // The production preload only emits strict AgentExecutionEvent envelopes.
        const turn = RuntimeIdSchema.safeParse(payload?.turnId);
        const event = AgentPresentationEventSchema.safeParse(payload?.event);
        if (!turn.success || !event.success) return;
        const existingIdentity = agentExecutionEventIdentityRef.current.get(turn.data);
        const sequence = existingIdentity && existingIdentity.sequences.size > 0
          ? Math.max(...existingIdentity.sequences) + 1
          : 0;
        const syntheticEnvelope: AgentExecutionEvent = {
          version: 1,
          eventId: `${turn.data}:${sequence}`,
          runId: turn.data,
          sessionId: activeChatRequestRef.current?.sessionId ?? 'legacy-session',
          turnId: turn.data,
          sequence,
          correlationId: turn.data,
          event: event.data,
        };
        applyAgentExecutionEnvelope(syntheticEnvelope);
        return;
      }
      const result = applyAgentExecutionEnvelope(decoded.data);
      const request = activeChatRequestRef.current;
      if (!request || request.turnId !== decoded.data.turnId || !isCurrentChatRequest(request)) return;
      if (!result.gap || !metis.replayAgentEvents || agentExecutionReplayInFlightRef.current.has(request.turnId)) return;
      agentExecutionReplayInFlightRef.current.add(request.turnId);
      void metis.replayAgentEvents({
        version: decoded.data.version,
        sessionId: request.sessionId,
        runId: request.turnId,
        afterSequence: result.contiguousSequence,
        limit: 256,
      }).then((replay) => {
        if (!replay || replay.runId !== request.turnId || replay.sessionId !== request.sessionId) return;
        for (const replayEvent of replay.events) {
          if (replayEvent.turnId === request.turnId) applyAgentExecutionEnvelope(replayEvent, true);
        }
      }).finally(() => {
        agentExecutionReplayInFlightRef.current.delete(request.turnId);
      });
    });
  }, [applyAgentExecutionEnvelope, isCurrentChatRequest]);

  // Streamed model tokens: the V2 conversation runtime (2026-09-05 P0) owns the
  // accumulation authority — chunks flow into the ConversationController
  // (attempt identity + dense index + resync self-heal), publications are
  // coalesced across three animation frames, and settlement publishes
  // immediately with the authoritative payload. This effect bridges controller
  // publications onto the existing messages array so the list renderer stays
  // untouched while cadence/content/settlement all become V2-authoritative.
  useEffect(() => {
    const metis = window.metis;
    if (!metis?.onChatStreamChunk) return;

    const flushFromController = () => {
      const request = activeChatRequestRef.current;
      if (!request || !isCurrentChatRequest(request)) return;
      const node = chatStreamControllerRef.current?.nodeSource(request.turnId).get();
      if (!node || node.status === 'abandoned') return;
      const finished = node.status !== 'streaming';

      if (streamingIndexRef.current < 0) {
        // UX-CHAT-002: empty terminal events must not create an air bubble.
        if (!node.content && !node.reasoning) return;
        const message: ChatMessage = {
          id: nextMessageId(),
          role: 'assistant',
          content: node.content,
          timestamp: now(),
          startedAt: request.startedAt,
          streaming: !finished,
          run: {
            status: finished ? 'completed' : 'running',
            events: activeRunPartsRef.current.run.events.slice(-AGENT_EXECUTION_EVENT_LIMIT),
            parts: activeRunPartsRef.current,
            turnId: request.turnId,
          },
          reasoning: node.reasoning || undefined,
          ...(finished ? { durationMs: Date.now() - request.startedAt } : {}),
          ...(finished ? { citations: extractDoiCitations(node.content) } : {}),
        };
        const index = messagesRef.current.length;
        messagesRef.current = [...messagesRef.current, message];
        setMessages((prev) => [...prev, message]);
        streamingIndexRef.current = index;
        return;
      }

      const streamedIndex = streamingIndexRef.current;
      const nextMessages = messagesRef.current.map((message, index) => {
        if (index !== streamedIndex) return message;
        return {
          ...message,
          content: node.content,
          reasoning: node.reasoning || undefined,
          streaming: !finished,
          ...(finished ? { durationMs: Date.now() - request.startedAt } : {}),
          ...(finished ? { citations: extractDoiCitations(node.content) } : {}),
        };
      });
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
    };

    const controller = new ConversationController({ onPublish: flushFromController });
    chatStreamControllerRef.current = controller;

    const handleStreamChunk = (data: {
      turnId: string;
      sessionId: string;
      content: string;
      reasoning?: string;
      isFinished: boolean;
    }) => {
      const request = activeChatRequestRef.current;
      if (!request
        || data.turnId !== request.turnId
        || data.sessionId !== request.sessionId
        || !isCurrentChatRequest(request)) return;
      // isFinished 只代表流通道关闭；权威结算由 chat 响应回调通过 settleTurn 完成。
      ingestChatStreamChunk(controller, data);
    };

    const unsubscribe = metis.onChatStreamChunk(handleStreamChunk);
    return () => {
      controller.dispose();
      chatStreamControllerRef.current = null;
      unsubscribe();
    };
  }, [isCurrentChatRequest, nextMessageId]);

  // Board → chat handoff: focus a goal as an inline card. App navigates to the
  // conversation first; a sessionStorage fallback covers the case where this
  // page was not mounted when the event fired.
  const focusGoalFromBoard = useCallback(async (goalId: string) => {
    const metis = window.metis;
    if (!metis?.getGoal) return;
    const result = await metis.getGoal(goalId);
    if (!result.success || !result.goal) return;
    const card: GoalCardData = {
      goalId,
      description: result.goal.label,
      phase: goalStatusToCardPhase(result.goal.status),
      steps: [],
      stepStatuses: {},
      progress: { completed: 0, total: 0, currentStep: '' },
      canRefine: false,
    };
    const goalMsg: ChatMessage = { role: 'goal', content: '', timestamp: now(), goalCard: card };
    const goalMsgIndex = messages.length;
    setMessages((prev) => [...prev, goalMsg]);
    goalCardIndexMapRef.current.set(goalId, goalMsgIndex);
    const acceptsLiveEvents = result.goal.status === 'running';
    setActiveGoalId(acceptsLiveEvents ? goalId : null);
    activeGoalIdRef.current = acceptsLiveEvents ? goalId : null;
    goalEventSequenceRef.current.delete(goalId);
    void syncGoalCardWorkflow(goalId, goalMsgIndex);
    if (metis.appendMessage) {
      void metis.appendMessage(currentSessionId, 'goal', `__GOAL_CARD__${JSON.stringify(card)}`);
    }
    // UX-CHAT-004: Goal 卡已持久化，侧栏计数同步刷新。
    refreshSessionSummaries();
    requestAnimationFrame(() => {
      const element = messagesEndRef.current;
      if (element && typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ behavior: 'smooth' });
      }
    });
  }, [currentSessionId, messages.length, refreshSessionSummaries, syncGoalCardWorkflow]);

  useEffect(() => {
    const pending = window.sessionStorage.getItem('metis-pending-goal');
    if (pending) {
      window.sessionStorage.removeItem('metis-pending-goal');
      void focusGoalFromBoard(pending);
    }
    const handler = (event: Event) => {
      const goalId = (event as CustomEvent<{ goalId?: string }>).detail?.goalId;
      if (goalId) {
        // Consume the handoff marker so the mount-effect fallback never
        // inserts the card a second time after this listener re-runs.
        window.sessionStorage.removeItem('metis-pending-goal');
        void focusGoalFromBoard(goalId);
      }
    };
    window.addEventListener('metis:goal-focus', handler);
    return () => window.removeEventListener('metis:goal-focus', handler);
  }, [focusGoalFromBoard]);

  // ─── Normal chat flow (extracted from old handleSend) ──────

  async function handleChatFlow(content: string, scenarioId = activeScenarioId, sessionIdOverride?: string) {
    const request = {
      token: Symbol('chat-request'),
      turnId: createAgentTurnId(),
      sessionId: sessionIdOverride ?? currentSessionId,
      generation: sessionGenerationRef.current,
      projectId: currentProjectId,
      startedAt: Date.now(),
    };
    activeChatRequestRef.current = request;
    agentExecutionPartsBufferRef.current.delete(request.turnId);
    agentExecutionEventIdentityRef.current.delete(request.turnId);
    agentExecutionReplayInFlightRef.current.delete(request.turnId);
    activeRunPartsRef.current = createAssistantMessageParts();
    setActiveRunParts(createAssistantMessageParts());
    setIsLoading(true);
    streamingIndexRef.current = -1;

    const metis = window.metis;
    try {
      if (!metis) throw new Error('Metis API not available');

      const history = messages.concat({ role: 'user', content, timestamp: now() }).map((m) => ({
        role: (m.role === 'tool' || m.role === 'goal') ? 'assistant' : m.role,
        content: m.content,
      }));
      // 多对话架构第二期(2026-09-05):当前工作对象注入(真实进入模型上下文)。
      if (activeArtifactIds.length > 0) {
        const artifactTitles = activeArtifactIds
          .map((artifactId) => projectOutcomes.find((outcome) => outcome.id === artifactId || `outcome:${outcome.id}` === artifactId)?.title)
          .filter((title): title is string => Boolean(title));
        if (artifactTitles.length > 0) {
          history.unshift({ role: 'system', content: `[当前工作对象] ${artifactTitles.join('、')}。用户说"这篇文章/当前成果/这份PPT"等时指上述对象;对它的修改请使用对应的成果编辑能力。` });
        }
      }

      const response = decodeAgentResponse(await metis.agentChat(
        request.sessionId,
        history,
        activeSkillId ?? undefined,
        { mode: 'send', turnId: request.turnId, ...(scenarioId ? { scenarioId } : {}), projectId: request.projectId },
      ));
      if (!isCurrentChatRequest(request)) return;

      // P0 V2：以持久层权威内容结算流式 attempt（immediate 发布——不等帧）。
      // interrupted/error 路径同样结算：保留已生成的部分内容并标记终态（规格四十六/四十七）。
      const v2Controller = chatStreamControllerRef.current;
      if (v2Controller && (streamingIndexRef.current >= 0 || v2Controller.nodeSource(request.turnId).get())) {
        const v2Status = response.status === 'completed'
          ? 'completed'
          : (response.status === 'interrupted' || response.status === 'cancelled')
            ? 'interrupted'
            : 'failed';
        // 空 answer（如 unverified/error）沿用流式累积内容作为终态呈现。
        const accumulated = v2Controller.nodeSource(request.turnId).get();
        v2Controller.settleTurn(request.turnId, response.answer || accumulated?.content || '', '', v2Status);
      }

      if (response.status !== 'completed') {
        // UX-CHAT-002: 先结算流式占位消息（空内容删除、部分内容标记草稿），
        // 再追加明确收据；不残留空白气泡与错误气泡并存的序列。
        const terminalRun = runActivity(
          response,
          response.turnId === request.turnId ? partsForAgentTurn(request.turnId) : createAssistantMessageParts(),
        );
        const retainedStreamDraft = settleStreamingPlaceholder(request, terminalRun);
        if (response.status === 'interrupted' || response.status === 'cancelled') {
          // User-initiated stop: an explicit receipt, never an error presentation.
          setMessages((prev) => [...prev, {
            role: 'assistant',
            content: t('chat.interruptedNotice'),
            timestamp: now(),
            startedAt: request.startedAt,
            durationMs: Date.now() - request.startedAt,
            ...(retainedStreamDraft ? {} : { run: terminalRun }),
          }]);
        } else {
          const diagnosticCode = response.diagnostics[0]?.code ?? response.status;
          const errorMsg: ChatMessage = {
            role: 'assistant',
            content: presentExecutionError(diagnosticCode, locale, resolvedUIMode),
            timestamp: now(),
            startedAt: request.startedAt,
            durationMs: Date.now() - request.startedAt,
            ...(retainedStreamDraft ? {} : { run: terminalRun }),
          };
          setMessages((prev) => [...prev, errorMsg]);
        }
      } else if (response.answer) {
        const streamedIndex = streamingIndexRef.current;
        const durationMs = Date.now() - request.startedAt;
        if (streamedIndex >= 0) {
          // The stream already rendered the answer live; settle the message
          // with the authoritative payload and the measured elapsed time.
          // Settle dedupe: when the authoritative answer is byte-identical to
          // the accumulated stream, keep the content field untouched so the
          // bubble does not re-parse the full document a second time.
          setMessages((prev) => prev.map((m, i) => i === streamedIndex
            ? { ...m, ...(m.content === response.answer ? {} : { content: response.answer }), streaming: false, durationMs, run: runActivity(response, response.turnId === request.turnId ? partsForAgentTurn(request.turnId) : createAssistantMessageParts()), ...(response.citations?.length ? { citations: response.citations } : {}) }
            : m));
        } else {
          const assistantMsg: ChatMessage = {
            role: 'assistant',
            content: response.answer,
            timestamp: now(),
            startedAt: request.startedAt,
            durationMs,
            run: runActivity(response, response.turnId === request.turnId ? partsForAgentTurn(request.turnId) : createAssistantMessageParts()),
            ...(response.citations?.length ? { citations: response.citations } : {}),
          };
          setMessages((prev) => [...prev, assistantMsg]);
          if (response.answer.length > 200 || /^#|^\*|\|.*\||```/.test(response.answer)) {
            openPreview(response.answer);
          }
        }
      }
      if (response.status === 'completed') {
        void refreshArtifactsForSession(request.sessionId, request.generation);
      }
    } catch (err) {
      if (!isCurrentChatRequest(request)) return;
      // UX-CHAT-002: 异常路径同样结算流式占位消息。
      const terminalRun: ChatMessage['run'] = {
        status: 'error',
        events: partsForAgentTurn(request.turnId).run.events,
        parts: partsForAgentTurn(request.turnId),
        turnId: request.turnId,
      };
      const retainedStreamDraft = settleStreamingPlaceholder(request, terminalRun);
      const errorMsg: ChatMessage = {
        role: 'assistant',
        content: presentExecutionError(err, locale, resolvedUIMode),
        timestamp: now(),
        startedAt: request.startedAt,
        durationMs: Date.now() - request.startedAt,
        ...(retainedStreamDraft ? {} : { run: terminalRun }),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      if (isCurrentChatRequest(request)) {
        streamingIndexRef.current = -1;
        activeChatRequestRef.current = null;
        agentExecutionPartsBufferRef.current.delete(request.turnId);
        activeRunPartsRef.current = createAssistantMessageParts();
        setActiveRunParts(createAssistantMessageParts());
        setIsLoading(false);
        setControlState('idle');
        // UX-CHAT-004: 主进程已在回合内持久化消息，刷新权威会话摘要。
        refreshSessionSummaries();
      }
    }
  }

  // ─── Goal flow ─────────────────────────────────────────────

  async function handleGoalFlow(description: string, sessionIdOverride?: string) {
    setIsLoading(true);
    const sessionId = sessionIdOverride ?? currentSessionId;
    const metis = window.metis;
    if (metis?.appendMessage) {
      void metis.appendMessage(sessionId, 'user', description);
    }
    if (!metis?.createGoal) {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: presentExecutionError('Research task service not available', locale, resolvedUIMode),
        timestamp: now(),
      }]);
      setIsLoading(false);
      return;
    }

    // 1. Insert GoalCard message
    const goalCard: GoalCardData = {
      goalId: '', description, phase: 'creating',
      steps: [], stepStatuses: {},
      progress: { completed: 0, total: 0, currentStep: '' },
      canRefine: false,
    };
    const goalMsg: ChatMessage = { role: 'goal', content: '', timestamp: now(), goalCard };
    // Index: messages.length is the user msg just pushed; +1 is the goal card
    const goalMsgIndex = messages.length + 1;

    setMessages((prev) => [...prev, goalMsg]);

    try {
      // 2. Create Goal
      const goal = await metis.createGoal(description, undefined, activeResearchProjectId ?? undefined);
      if (!goal.success) throw new Error(goal.code);
      const goalId = goal.goalId;
      updateGoalCard(goalMsgIndex, (card) => ({ ...card, goalId, phase: 'planning' }));
      setActiveGoalId(goalId);
      activeGoalIdRef.current = goalId;
      goalEventSequenceRef.current.delete(goalId);
      goalCardIndexMapRef.current.set(goalId, goalMsgIndex);

      // 3. Generate Plan
      const planResult = await metis.generatePlan(goalId);
      if (!planResult.success) throw new Error(planResult.code);
      const steps = planResult.steps.map((step) => ({
        id: step.stepId,
        name: t('rightPanel.researchStep', { number: step.ordinal }),
        description: '',
      }));
      const executingCard: GoalCardData = {
        ...goalCard,
        goalId,
        phase: 'executing',
        planName: t('chat.researchPlan'),
        steps,
        stepStatuses: Object.fromEntries(steps.map((s) => [s.id, { stepId: s.id, stepName: s.name, status: 'pending' as const, output: '' }])),
        progress: { completed: 0, total: steps.length, currentStep: '' },
        canRefine: false,
      };
      updateGoalCard(goalMsgIndex, () => executingCard);
      await syncGoalCardWorkflow(goalId, goalMsgIndex);

      // 4. Persist goal card state
      if (metis.appendMessage) {
        void metis.appendMessage(sessionId, 'goal', `__GOAL_CARD__${JSON.stringify(executingCard)}`);
      }

      // 5. Auto-execute
      const execution = await metis.executeGoal(goalId);
      if (execution.success) {
        updateGoalCard(goalMsgIndex, (card) => ({ ...card, phase: 'completed', pauseRequested: false }));
      } else if (execution.code === 'paused') {
        updateGoalCard(goalMsgIndex, (card) => ({ ...card, phase: 'paused', pauseRequested: false }));
      } else if (execution.code === 'cancelled') {
        updateGoalCard(goalMsgIndex, (card) => ({ ...card, phase: 'cancelled', pauseRequested: false }));
      } else {
        throw new Error(execution.code ?? 'goal_execution_failed');
      }
    } catch {
      updateGoalCard(goalMsgIndex, (card) => ({
        ...card,
        phase: 'failed',
        error: 'goal_execution_failed',
      }));
    } finally {
      setActiveGoalId(null);
      activeGoalIdRef.current = null;
      goalEventSequenceRef.current.clear();
      setIsLoading(false);
      // UX-CHAT-004: 用户消息与 Goal 卡均已持久化，刷新会话摘要。
      refreshSessionSummaries();
    }
  }

  /** Controls operate on the same persisted Goal ID as the visible timeline. */
  async function handlePauseGoal(goalId: string) {
    const metis = window.metis;
    const index = findGoalCardIndex(goalId);
    if (!metis?.pauseGoal || index === undefined) return;
    try {
      const result = await metis.pauseGoal(goalId);
      if (result?.success) {
        // The engine pauses at a Workflow boundary. Until its status event
        // arrives this is intentionally a request receipt, not a fake pause.
        updateGoalCard(index, (card) => ({ ...card, pauseRequested: true }));
      } else {
        // 暂停请求被引擎拒绝时必须给出可见回执，不能静默无反应。
        updateGoalCard(index, (card) => ({
          ...card,
          error: locale === 'zh' ? '暂停请求未被执行：任务当前状态不接受暂停。' : 'The pause request was not applied: the task state does not accept a pause.',
        }));
      }
    } catch {
      updateGoalCard(index, (card) => ({
        ...card,
        error: locale === 'zh' ? '暂停服务暂时不可用，请稍后重试。' : 'The pause service is temporarily unavailable. Try again later.',
      }));
    }
  }

  async function handleCancelGoal(goalId: string) {
    const metis = window.metis;
    const index = findGoalCardIndex(goalId);
    if (!metis?.cancelGoal || index === undefined) return;
    try {
      const result = await metis.cancelGoal(goalId);
      if (result?.success) {
        updateGoalCard(index, (card) => ({ ...card, phase: 'cancelled', pauseRequested: false }));
      } else {
        updateGoalCard(index, (card) => ({
          ...card,
          error: locale === 'zh' ? '取消请求未被执行：任务可能已经结束。' : 'The cancel request was not applied: the task may have already finished.',
        }));
      }
    } catch {
      updateGoalCard(index, (card) => ({
        ...card,
        error: locale === 'zh' ? '取消服务暂时不可用，请稍后重试。' : 'The cancel service is temporarily unavailable. Try again later.',
      }));
    }
  }

  async function handleResumeGoal(goalId: string) {
    const metis = window.metis;
    const index = findGoalCardIndex(goalId);
    if (!metis?.resumeGoal || index === undefined) return;
    setIsLoading(true);
    setActiveGoalId(goalId);
    activeGoalIdRef.current = goalId;
    goalEventSequenceRef.current.delete(goalId);
    updateGoalCard(index, (card) => ({ ...card, phase: 'executing', pauseRequested: false, error: undefined }));
    try {
      const execution = await metis.resumeGoal(goalId);
      if (execution.success) {
        updateGoalCard(index, (card) => ({ ...card, phase: 'completed', pauseRequested: false }));
      } else if (execution.code === 'paused') {
        updateGoalCard(index, (card) => ({ ...card, phase: 'paused', pauseRequested: false }));
      } else if (execution.code === 'cancelled') {
        updateGoalCard(index, (card) => ({ ...card, phase: 'cancelled', pauseRequested: false }));
      } else if (execution.code === 'goal_cancelled' || execution.code === 'goal_not_found') {
        // 终态目标（已取消/不存在）永远无法恢复——卡片必须转入诚实的终态：
        // 收起注定失败的重试/继续按钮，清除僵死的“执行中”步骤显示，
        // 并明确告诉用户需要重新发起，而不是提示“稍后重试”。
        updateGoalCard(index, (card) => ({
          ...card,
          phase: 'cancelled',
          pauseRequested: false,
          stepStatuses: Object.fromEntries(Object.entries(card.stepStatuses).map(([stepId, status]) => [
            stepId,
            status.status === 'running' ? { ...status, status: 'pending' as const } : status,
          ])),
          error: locale === 'zh'
            ? '该研究任务已被取消，无法继续恢复。请重新发送指令开始新的研究任务。'
            : 'This research task was cancelled and can no longer be resumed. Send a new instruction to start a fresh task.',
        }));
      } else {
        // 恢复失败必须带真实原因（2026-08-29 刘总要求：不再笼统"未能完成"）。
        const codeText = String(execution.code ?? 'goal_execution_failed');
        updateGoalCard(index, (card) => ({
          ...card,
          phase: codeText === 'goal_cancelled' ? 'cancelled' : 'failed',
          error: locale === 'zh'
            ? `恢复未执行（${codeText}）。若任务已取消请重新发起；若仍在运行请稍候重试。`
            : `Resume did not run (${codeText}). Re-send if cancelled; retry shortly if still running.`,
        }));
      }
      await syncGoalCardWorkflow(goalId, index);
    } catch {
      updateGoalCard(index, (card) => ({ ...card, phase: 'failed', error: 'goal_execution_failed' }));
    } finally {
      setActiveGoalId(null);
      activeGoalIdRef.current = null;
      goalEventSequenceRef.current.clear();
      setIsLoading(false);
      refreshSessionSummaries();
    }
  }

  // ─── Interjection flow ─────────────────────────────────────

  async function handleInterjection(content: string, sessionIdOverride?: string) {
    const metis = window.metis;
    const sessionId = sessionIdOverride ?? currentSessionId;
    if (!metis || !activeGoalId) {
      await handleChatFlow(content, undefined, sessionIdOverride);
      return;
    }

    if (isLikelyGoalFeedback(content)) {
      setIsLoading(true);
      if (metis.appendMessage) {
        void metis.appendMessage(sessionId, 'user', content);
      }
      const idx = goalCardIndexMapRef.current.get(activeGoalId);
      try {
        await metis.cancelGoal(activeGoalId);
        if (idx !== undefined) updateGoalCard(idx, (card) => ({ ...card, phase: 'planning' }));

        const planResult = await metis.refinePlan(activeGoalId, content);
        if (!planResult.success) throw new Error(planResult.code);
        const steps = planResult.steps.map((step) => ({
          id: step.stepId,
          name: t('rightPanel.researchStep', { number: step.ordinal }),
          description: '',
        }));

        if (idx !== undefined) updateGoalCard(idx, (card) => ({
          ...card, phase: 'executing',
          steps,
          planName: t('chat.researchPlan'),
          planDescription: undefined,
          stepStatuses: Object.fromEntries(steps.map((s) => [s.id, { stepId: s.id, stepName: s.name, status: 'pending' as const, output: '' }])),
          progress: { completed: 0, total: steps.length, currentStep: '' },
          error: undefined,
        }));

        const execution = await metis.executeGoal(activeGoalId);
        if (!execution.success) throw new Error(execution.code ?? 'goal_execution_failed');
        if (idx !== undefined) updateGoalCard(idx, (card) => ({ ...card, phase: 'completed' }));
      } catch {
        if (idx !== undefined) {
          updateGoalCard(idx, (card) => ({
            ...card,
            phase: 'failed',
            error: 'goal_execution_failed',
          }));
        }
      } finally {
        setActiveGoalId(null);
        activeGoalIdRef.current = null;
        goalEventSequenceRef.current.clear();
        setIsLoading(false);
        // UX-CHAT-004: 反馈消息已持久化，刷新会话摘要。
        refreshSessionSummaries();
      }
    } else {
      // Unrelated question — answer as normal chat while goal continues in background
      await handleChatFlow(content, undefined, sessionIdOverride);
    }
  }

  // ─── Send message (router) ────────────────────────────────

  async function handleLiveInstruction(
    content: string,
    options?: { userBubbleVisible?: boolean; fallback?: () => Promise<void> },
  ) {
    const userBubbleVisible = options?.userBubbleVisible ?? false;
    const metis = window.metis;
    if (!metis?.agentControl) {
      setMessages((prev) => [...prev, {
        role: 'system',
        content: presentExecutionError('live_steering_unavailable', locale, resolvedUIMode),
        timestamp: now(),
      }]);
      return;
    }
    const response = await metis.agentControl({
      contractVersion: 1,
      operationId: `steer-${crypto.randomUUID()}`,
      sessionId: currentSessionId,
      action: 'instruction',
      content,
    });
    if (!response.ok) {
      // 中断恢复（2026-08-29 刘总报告「中断之后直接无法继续」）：应用重启后
      // 内存运行注册表为空而数据库状态仍是 running，no_active_run 不该报错了
      // 事——自动降级为正常场景轮，主进程发现内存无 run 且数据库有可恢复
      // 断点时会自动续跑，而不是把用户堵死在死路上。
      if (response.code === 'no_active_run' && options?.fallback) {
        setMessages((prev) => [
          ...(userBubbleVisible ? [] : [{ role: 'user', content, timestamp: now() } as ChatMessage]),
          {
            role: 'system',
            content: locale === 'zh'
              ? '检测到运行已中断（应用可能刚重启过），正在从断点恢复…'
              : 'The run was interrupted (the app may have just restarted); resuming from the checkpoint…',
            timestamp: now(),
          },
        ]);
        if (!userBubbleVisible) setInput('');
        await options.fallback();
        return;
      }
      setMessages((prev) => [...prev, {
        role: 'system',
        content: presentExecutionError(response.code, locale, resolvedUIMode),
        timestamp: now(),
      }]);
      return;
    }
    // Success receipt: confirm to the user that the instruction reached the run.
    // 用户气泡只在还没显示时补上（调用点可能已把气泡渲染过，避免重复）。
    setMessages((prev) => [
      ...(userBubbleVisible ? [] : [{ role: 'user', content, timestamp: now() } as ChatMessage]),
      { role: 'system', content: t('chat.steerReceipt'), timestamp: now() },
    ]);
    if (!userBubbleVisible) setInput('');
  }

  async function handleInterrupt() {
    const response = await window.metis?.agentControl?.({
      contractVersion: 1,
      operationId: `interrupt-${crypto.randomUUID()}`,
      sessionId: currentSessionId,
      action: 'interrupt',
      reason: locale === 'zh' ? '用户主动打断当前任务' : 'User interrupted the current run',
    });
    if (!response?.ok) {
      setMessages((prev) => [...prev, {
        role: 'system',
        content: presentExecutionError(response?.code ?? 'live_interrupt_unavailable', locale, resolvedUIMode),
        timestamp: now(),
      }]);
      return;
    }
    // Success receipt: the request is queued; the run settles at its next safe point.
    setControlState('interrupting');
    setMessages((prev) => [...prev, {
      role: 'system',
      content: t('chat.interruptReceipt'),
      timestamp: now(),
    }]);
  }

  /** Execute a slash command. Each maps to an existing system capability. */
  async function handleSlashCommand(name: string, arg: string) {
    const metis = window.metis;
    const reply = (text: string) => {
      setMessages((prev) => [...prev, {
        role: 'user',
        content: `/${name}${arg ? ' ' + arg : ''}`,
        timestamp: now(),
      }, {
        role: 'system',
        content: text,
        timestamp: now(),
      }]);
    };
    setInput('');

    switch (name) {
      case 'chat': {
        if (!arg) { reply('用法：/chat <内容>'); return; }
        // Dispatch as normal chat — keeps the active scenario (bypasses
        // auto-match but does not clear an explicitly selected scenario).
        setMessages((prev) => [...prev, { role: 'user', content: arg, timestamp: now() }]);
        await handleChatFlow(arg, activeScenarioId || DEFAULT_SCENARIO_ID);
        return;
      }
      case 'goal':
      case 'task': {
        if (!arg) { reply('用法：/' + name + ' <描述>'); return; }
        await handleGoalFlow(arg);
        return;
      }
      case 'autonomous': {
        if (!arg) { reply('用法：/autonomous <研究目标>'); return; }
        try {
          const projectId = researchWorkspaceStore.getState().activeProjectId ?? undefined;
          const result = await window.metis?.autonomousStart?.({ goal: arg, projectId });
          if (result?.ok) {
            reply(`🚀 已启动自主科研（目标：${arg}${projectId ? ` · 项目：${projectId}` : ''}）。请打开顶部「自主科研」面板查看 idea→实验→分析→论文 的实时进度，或用 /stop 中断。`);
          } else {
            reply(`启动失败：${result?.error ?? '未知错误'}。可能已有任务在运行，或引擎未就绪。`);
          }
        } catch (err) {
          reply(`启动异常：${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      case 'scenario': {
        if (!arg) { reply('用法：/scenario <名称>'); return; }
        const matched = matchScenarioTrigger(arg, scenarios);
        if (matched) {
          setActiveScenarioId(matched.id);
          try { window.localStorage.setItem(ACTIVE_SCENARIO_KEY, matched.id); } catch { /* preference persistence */ }
          reply(`已切换到场景：${matched.name}`);
        } else {
          reply(`未找到匹配的场景「${arg}」。可用场景：${scenarios.map((s) => s.name).join('、')}`);
        }
        return;
      }
      case 'search': {
        // Open the global search overlay (App-level state) through a bus event.
        window.dispatchEvent(new CustomEvent('metis:open-search'));
        reply(locale === 'zh' ? `已打开全局搜索${arg ? `，正在搜索「${arg}」` : ''}。` : `Global search opened${arg ? ` for “${arg}”` : ''}.`);
        return;
      }
      case 'paper': {
        if (!arg) { reply('用法：/paper <标题或 DOI>'); return; }
        const projectId = researchWorkspaceStore.getState().activeProjectId ?? undefined;
        const paper = {
          id: `paper_slash_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          title: arg, authors: [] as string[], year: new Date().getFullYear(),
          venue: '', abstract: '', tags: [], notes: '', readStatus: 'unread' as const,
          rating: 0, referenceIds: [], addedAt: Date.now(), projectId,
        };
        const result = await useMetisStore.getState().addPaper(paper);
        if (projectId && result.paper.id) {
          await window.metis?.linkPaperToProject?.({ paperId: result.paper.id, projectId, link: true });
        }
        reply(projectId
          ? `已添加文献并关联当前项目：${arg}`
          : `已添加到资料库：${arg}`);
        return;
      }
      case 'note': {
        if (!arg) { reply('用法：/note <内容>'); return; }
        await useMetisStore.getState().addNote({
          id: `note_slash_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          title: arg.slice(0, 40), content: arg, tags: [], linkedPaperIds: [],
          linkedNoteIds: [], updatedAt: Date.now(),
        });
        reply(`已添加笔记：${arg.slice(0, 40)}`);
        return;
      }
      case 'export': {
        const format = arg.trim().toLowerCase() || 'chat';
        if (format === 'chat') {
          const md = messages.map((m) => m.role === 'user' ? `\n## 我\n${m.content}` : m.role === 'system' ? `\n> ${m.content}` : `\n## AI\n${m.content}`).join('\n');
          const blob = new Blob([md], { type: 'text/markdown' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `chat-${currentSessionId.slice(0, 8)}.md`;
          a.click();
          URL.revokeObjectURL(a.href);
          reply('会话已导出为 Markdown。');
        } else {
          reply(`文献库导出请在设置页操作（格式：${format}）。`);
        }
        return;
      }
      case 'stop': {
        await handleInterrupt();
        return;
      }
      case 'skill': {
        // /skill [意图描述] — learn from the current conversation and install
        // a reusable skill. The conversation history is sent to the AI which
        // distills it into a structured systemPrompt + tool allow-list.
        if (messages.length === 0) { reply('当前没有对话可学习。'); return; }
        const convo = messages
          .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
          .map((m) => ({ role: m.role, content: m.content }));
        if (convo.length < 2) { reply('对话太短，至少需要一轮问答才能学习。'); return; }
        reply(`正在从 ${convo.length} 条对话中提取技能…`);
        try {
          const result = await window.metis?.generateSkillFromConversation?.({ messages: convo, userIntent: arg || undefined });
          if (result?.ok && result.skill) {
            const s = result.skill;
            reply([
              `技能「${s.name}」已生成并安装！`,
              `用途：${s.description}`,
              `工具：${s.allowedTools.length > 0 ? s.allowedTools.join(', ') : '（无）'}`,
              `回合预算：${s.maxTurns}`,
              `提取依据：${s.rationale}`,
              ``,
              `下次对话时在技能选择器中选择「${s.name}」即可复用这个工作流。`,
            ].join('\n'));
          } else {
            reply(`技能生成失败：${result?.error ?? '未知错误'}`);
          }
        } catch (err) {
          reply(`技能生成异常：${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      case 'pause': {
        if (!activeGoalId) { reply('当前没有运行中的目标任务。'); return; }
        const result = await metis?.pauseGoal?.(activeGoalId) as { success?: boolean; code?: string } | undefined;
        reply(result?.success
          ? '已请求暂停，当前步骤完成后会保存断点并停止。'
          : '当前目标无法暂停，可能已经结束或没有活动运行。');
        return;
      }
      case 'resume': {
        if (!activeGoalId) { reply('当前没有暂停的目标任务。'); return; }
        await metis?.resumeGoal?.(activeGoalId);
        reply('目标已恢复运行。');
        return;
      }
      case 'status': {
        const parts: string[] = [];
        parts.push(`项目：${researchWorkspaceStore.getState().activeProjectId ?? '未选择'}`);
        parts.push(`场景：${scenarios.find((s) => s.id === activeScenarioId)?.name ?? '默认'}`);
        parts.push(`目标：${activeGoalId ? '运行中' : '无'}`);
        parts.push(`状态：${isLoading ? '正在处理' : '空闲'}`);
        reply(parts.join('\n'));
        return;
      }
      case 'help': {
        const lines = SLASH_COMMANDS.map((c) => `/${c.name}${c.hasArg ? ' <参数>' : ''} — ${c.description}`);
        reply('可用命令：\n' + lines.join('\n'));
        return;
      }
      default:
        reply(`未知命令：/${name}。输入 /help 查看可用命令。`);
    }
  }

  // 场景选择持久化兜底（2026-08-29 刘总要求：显示选中就必须走场景）。
  // React state 恢复是异步的——项目刚打开立刻发送时 state 可能还是空，
  // 导致明明显示已选场景却静默走了 Goal。这里直接读持久化偏好兜底。
  function readPersistedScenarioId(): string | null {
    try {
      // 多对话架构(2026-09-04):当前会话正式绑定的场景优先(随会话切换恢复)。
      const currentSession = currentSessionId
        ? projectScopedSessions.find((item) => item.id === currentSessionId) ?? sessions.find((item) => item.id === currentSessionId)
        : undefined;
      if (currentSession?.scenarioId) return currentSession.scenarioId;
      const projectPreferred = activeResearchProjectId
        ? window.localStorage.getItem(`metis:project-scenario:${activeResearchProjectId}`)
        : null;
      return projectPreferred ?? window.localStorage.getItem(ACTIVE_SCENARIO_KEY);
    } catch { return null; }
  }

  async function handleSend(overrideContent?: string, scenarioOverride?: string) {
    let raw = stripEmoji((overrideContent || input).trim());
    if (!raw) return;
    // T3 二期：Step Target Context——结构化上下文随消息进 Runtime（禁裸「针对步骤6」）。
    if (stepTarget) {
      const contextLines = [
        '【对话目标（结构化上下文）】',
        'targetType: scenario_step',
        `runId: ${stepTarget.runId}`,
        `stepId: ${stepTarget.stepId}`,
        ...(stepTarget.revision !== undefined ? [`stepRevision: ${stepTarget.revision}`] : []),
        ...(stepTarget.title ? [`stepTitle: ${stepTarget.title}`] : []),
        ...(stepTargetMode === 'modify' ? ['instruction: 基于当前步骤结果修改并生成新版本（旧版本保留）'] : []),
      ];
      raw = `${contextLines.join('\n')}\n\n【用户反馈】\n${raw}`;
      setStepTarget(null);
    }
    // 运行中的消息是实时引导（steering），必须放行；防重入只针对空闲态
    // 双击（2026-08-29 刘总要求：消灭同秒双发竞态，同时不拦引导）。
    // 引导若撞上 no_active_run（运行已被中断），降级为断点恢复轮。
    if (isLoading) {
      await handleLiveInstruction(raw, {
        fallback: () => handleChatFlow(
          raw,
          activeScenarioId || readPersistedScenarioId() || DEFAULT_SCENARIO_ID,
          currentSessionId || undefined,
        ),
      });
      return;
    }
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    try {
      await runSendTurn(raw, scenarioOverride);
    } finally {
      sendInFlightRef.current = false;
    }
  }

  // 步骤卡「继续」事件（2026-09-01 刘总方案二期）：ScenarioStepCard 落库成功后
  // 派发该事件，这里补发「继续」触发断点恢复；跨会话的事件忽略。
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;
  const currentSessionIdForContinueRef = useRef(currentSessionId);
  currentSessionIdForContinueRef.current = currentSessionId;
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      if (detail?.sessionId && currentSessionIdForContinueRef.current
        && detail.sessionId !== currentSessionIdForContinueRef.current) return;
      void handleSendRef.current('继续');
    };
    window.addEventListener('metis:scenario-continue', listener);
    return () => window.removeEventListener('metis:scenario-continue', listener);
  }, []);

  // 多对话架构第二期(2026-09-05):左侧栏 Conversation 树点击对话行 → typed 事件切换会话。
  useEffect(() => {
    const handler = (event: Event) => {
      const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (!sessionId || sessionId === currentSessionId) return;
      if (sessions.some((item) => item.id === sessionId)) activateSession(sessionId);
    };
    window.addEventListener('metis:switch-session', handler);
    return () => window.removeEventListener('metis:switch-session', handler);
  }, [currentSessionId, sessions, activateSession]);

  async function runSendTurn(raw: string, scenarioOverride?: string) {

    // Slash commands: intercept before scenario matching / task detection.
    const slashMatch = matchSlashCommand(raw);
    if (slashMatch) {
      await handleSlashCommand(slashMatch.command.name, slashMatch.arg);
      return;
    }

    // Force plain chat with prefix
    const forceChat = raw.startsWith('/chat ') || raw.startsWith('? ');
    const content = forceChat ? raw.replace(/^(\/chat |\? )/, '') : raw;

    // Auto-create a session on first send: previously, messages sent without
    // clicking 「新会话」 first were never persisted — the sidebar kept showing
    // 无会话 and the whole conversation vanished on reload. The first message
    // now implicitly creates (and persists) a session, matching what the UI
    // already displays.
    let sessionIdForTurn = currentSessionId;
    let createdThisTurn = false;
    if (!sessionIdForTurn) {
      const created = await createNewSession();
      if (created) {
        sessionIdForTurn = created;
        createdThisTurn = true;
      }
    }

    // Append user message
    const userMsg: ChatMessage = { role: 'user', content, timestamp: now() };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');

    // Auto-title a fresh session from its first user message so the sidebar
    // distinguishes conversations instead of showing multiple "新会话".
    const currentSession = sessions.find((session) => session.id === currentSessionId);
    const defaultTitle = t('chat.newSessionTitle');
    const trimmed = content.trim();
    if (createdThisTurn && trimmed) {
      // The session was just created, so it is not in `sessions` state yet —
      // rename it directly from this first message.
      void handleRenameSession(
        sessionIdForTurn,
        trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed,
      );
    } else if (currentSession && (!currentSession.title || currentSession.title === defaultTitle) && trimmed) {
      void handleRenameSession(
        currentSessionId,
        trimmed.length > 30 ? `${trimmed.slice(0, 30)}…` : trimmed,
      );
    }

    // Normal chat persistence is owned by the main process so each message is
    // committed once. Goal-only messages still use appendMessage below.
    const hasActiveGoal = activeGoalId !== null;

    // UX-CHAT-003（2026-08-29 刘总要求）：已选场景时步骤规定明确，不再建议
    // "转为研究任务"——任务直接按场景工作流执行；仅无场景时保留 Goal 兜底建议。
    setGoalSuggestion(!forceChat && !activeScenarioId && isTaskAmbiguous(content) ? content : null);

    // 场景选择持久化兜底统一走 readPersistedScenarioId（handleSend 的
    // isLoading 兜底同样需要，2026-08-31 修复作用域断裂）。
    const persistedScenarioId = readPersistedScenarioId();
    const selectedScenarioId = scenarioOverride ?? (activeScenarioId || persistedScenarioId || '');
    const matchedScenario = selectedScenarioId ? undefined : matchScenarioTrigger(content, scenarios);
    const scenarioForTurn = selectedScenarioId || matchedScenario?.id || DEFAULT_SCENARIO_ID;
    if (matchedScenario) {
      setActiveScenarioId(matchedScenario.id);
      try { window.localStorage.setItem(ACTIVE_SCENARIO_KEY, matchedScenario.id); } catch { /* preference persistence is best-effort */ }
    }


    void window.metis?.rendererLog?.(`route: user=${JSON.stringify(content.slice(0, 40))} activeScenarioId=${JSON.stringify(activeScenarioId)} persisted=${JSON.stringify(persistedScenarioId ?? null)} selected=${JSON.stringify(selectedScenarioId)} scenarioForTurn=${JSON.stringify(scenarioForTurn)} hasActiveScenarioRun=${hasActiveScenarioRun} hasActiveGoal=${hasActiveGoal} isTaskLike=${isTaskLike(content)} forceChat=${forceChat}`);
    // 「继续」的系统级语义（2026-08-30 刘总点破：关闭后继续总是重开新任务）：
    // 场景运行的可恢复断点由主进程自动 resume（场景绑定轮走 handleChatFlow，
    // getRecoverableScenarioRun 会接上 interrupted/paused/running 的 checkpoint）；
    // 没有场景运行时，「继续」必须接回最近一个 paused 的研究任务（Goal），
    // 而不是当作新输入被普通聊天吞掉。
    if (!hasActiveScenarioRun && !hasActiveGoal && !forceChat && !scenarioForTurn
      && /^(继续|接着做|接着干|继续执行|continue|resume)[\s!！。.]*$/i.test(content.trim())) {
      try {
        const goalsResult = await window.metis?.listGoals?.();
        // 选择策略与场景恢复同规（系统性教训：不能按列表顺序取第一个）：
        // 优先当前项目的 paused 任务，再取最近创建的——「继续」必须接上
        // 用户最可能指的那条工作，而不是任意一条。
        const pausedGoals = (goalsResult?.goals ?? []).filter((goal) => goal.status === 'paused');
        const resumableGoal = pausedGoals
          .filter((goal) => !goal.projectId || goal.projectId === currentProjectId)
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]
          ?? pausedGoals.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
        if (resumableGoal) {
          await handleResumeGoal(resumableGoal.goalId);
          return;
        }
      } catch { /* goal 列表失败则按普通输入处理 */ }
    }
    if (hasActiveScenarioRun && !forceChat) {
      // 场景工作流执行中（2026-08-29 刘总要求）：随时引导，新消息实时注入
      // 当前运行，而不是当作新任务被"已有任务在执行"拒绝。若运行其实已被
      // 中断（应用重启等），no_active_run 会自动降级为断点恢复轮。
      await handleLiveInstruction(content, {
        userBubbleVisible: true,
        fallback: () => handleChatFlow(content, scenarioForTurn, sessionIdForTurn || undefined),
      });
      return;
    }
    if (scenarioForTurn) {
      await handleChatFlow(content, scenarioForTurn, sessionIdForTurn || undefined);
    } else if (!forceChat && !hasActiveGoal && isTaskLike(content)) {
      await handleGoalFlow(content, sessionIdForTurn || undefined);
    } else if (hasActiveGoal && !forceChat) {
      await handleInterjection(content, sessionIdForTurn || undefined);
    } else {
      await handleChatFlow(content, DEFAULT_SCENARIO_ID, sessionIdForTurn || undefined);
    }
  }

  // Consume a cross-page handoff only after the target session history and the
  // authoritative scenario list are both ready. Full Access launch intents may
  // auto-send once; ordinary paper/note intents remain editable drafts.
  useEffect(() => {
    const pendingPeek = peekPendingChatIntent();
    // 只有 autoSend 需要已就绪的会话与历史（直接发送）；场景/技能选择类交接
    // 在全新环境（尚无任何会话）也必须消费，否则场景永远无法交接。
    if (pendingPeek?.autoSend && (!currentSessionId || !historyReady)) return;
    // 项目上下文仍在加载时挂起交接消费：挂载竞态下 currentProjectId 会短暂
    // 读到 'global'，立即消费会把合法的项目场景交接误判为项目不匹配。
    if (workspaceProjectsLoading) return;
    const pendingIntent = peekPendingChatIntent();
    if (!pendingIntent) {
      if (!currentSessionId || !historyReady) return;
      // Preserve the legacy cleanup behavior for malformed stored values.
      consumePendingChatIntent();
      return;
    }
    // A failed catalog load is not authoritative evidence that a scenario is
    // missing. Keep scenario handoffs pending so a later Chat mount can retry.
    // Ordinary handoffs do not depend on the scenario catalog and remain usable.
    if (pendingIntent.scenarioId && scenarioLoadState !== 'ready') return;
    clearPendingChatIntent();
    const intent = pendingIntent;
    const rejectHandoff = (key: 'chat.handoffRejectedProject' | 'chat.handoffRejectedSession' | 'chat.handoffRejectedScenario') => {
      setMessages((previous) => [...previous, {
        role: 'system',
        content: t(key),
        timestamp: now(),
      }]);
    };
    if (intent.projectId && intent.projectId !== currentProjectId) {
      rejectHandoff('chat.handoffRejectedProject');
      return;
    }
    if (intent.sessionId && intent.sessionId !== currentSessionId) {
      rejectHandoff('chat.handoffRejectedSession');
      return;
    }
    if (intent.skillId && skills.some((skill) => skill.id === intent.skillId)) {
      setActiveSkillId(intent.skillId);
      window.metis?.setActiveSkill?.(intent.skillId).catch(() => {});
    }
    if (intent.scenarioId && !scenarios.some((scenario) => scenario.id === intent.scenarioId)) {
      rejectHandoff('chat.handoffRejectedScenario');
      return;
    }
    const requestedScenario = intent.scenarioId ?? activeScenarioId;
    if (requestedScenario !== activeScenarioId) {
      setActiveScenarioId(requestedScenario);
    }
    if (intent.scenarioId) {
      try { window.localStorage.setItem(ACTIVE_SCENARIO_KEY, requestedScenario); } catch { /* preference only */ }
    }
    if (intent.autoSend) {
      void handleSend(intent.message, requestedScenario);
    } else {
      setInput(intent.message);
      inputRef.current?.focus();
    }
    // handleSend intentionally consumes the state snapshot guarded by
    // historyReady; re-subscribing to its function identity would replay work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScenarioId, currentProjectId, currentSessionId, historyReady, intentRevision, locale, scenarioLoadState, scenarios, skills, workspaceProjectsLoading]);

  // O16: switch which sibling of a regenerated-answer fork is displayed.
  function handleSwitchFork(forkId: string, targetIndex: number) {
    setMessages((prev) => toggleForkActive(prev, forkId, targetIndex));
  }

  // Regenerate last assistant response
  async function handleRegenerate() {
    const lastUserIndex = [...messages].reverse().findIndex((m) => m.role === 'user');
    if (lastUserIndex === -1) return;
    const actualIndex = messages.length - 1 - lastUserIndex;
    const forkId = `fork-${Date.now()}`;
    const history = messages.slice(0, actualIndex + 1);
    const request = {
      token: Symbol('regenerate-request'),
      turnId: createAgentTurnId(),
      sessionId: currentSessionId,
      generation: sessionGenerationRef.current,
      projectId: currentProjectId,
      startedAt: Date.now(),
    };
    activeChatRequestRef.current = request;
    agentExecutionPartsBufferRef.current.delete(request.turnId);
    agentExecutionEventIdentityRef.current.delete(request.turnId);
    agentExecutionReplayInFlightRef.current.delete(request.turnId);
    activeRunPartsRef.current = createAssistantMessageParts();
    setActiveRunParts(createAssistantMessageParts());
    // O16: keep the previous answer as an inactive sibling branch. If it is
    // already part of a fork group, extend that group (3rd, 4th regenerate…);
    // otherwise start a new fork. Older siblings keep their original indexes.
    const priorAssistant = messages[actualIndex + 1];
    const existingForkId = priorAssistant?.forkId;
    const priorForkCount = priorAssistant?.forkCount ?? 1;
    const markedHistory = priorAssistant?.role === 'assistant'
      ? [
        ...history,
        {
          ...priorAssistant,
          // Only promote the *old* answer to fork state when it isn't already
          // in a group; if it is, it stays at its index and the new one gets
          // the next index below.
          ...(priorAssistant.forkId ? {} : { forkId, forkIndex: 0 }),
          forkCount: existingForkId ? priorForkCount + 1 : 2,
          forkActive: false,
        },
      ]
      : history;
    // O16: persist the fork bookkeeping (including sibling contents) so all
    // branches survive a reload — the main-process history only keeps the
    // final answer, so old siblings live in this side table.
    if (priorAssistant?.role === 'assistant' && currentSessionId) {
      const map = loadForkMap(currentSessionId, localStorage);
      const targetForkId = existingForkId ?? forkId;
      // Re-anchor any previously persisted siblings under the same forkId.
      const siblings = [...map.values()]
        .filter((r) => r.forkId === targetForkId)
        .map((r) => ({ ...r, forkCount: priorForkCount + 1 }));
      siblings.forEach((r) => map.set(r.forkId, r));
      map.set(targetForkId, {
        forkId: targetForkId,
        forkIndex: existingForkId ? (priorAssistant.forkIndex ?? 0) : 0,
        forkCount: existingForkId ? priorForkCount + 1 : 2,
        content: priorAssistant.content,
        timestamp: priorAssistant.timestamp,
      });
      saveForkMap(currentSessionId, map, localStorage);
    }
    setMessages(markedHistory);
    setIsLoading(true);
    streamingIndexRef.current = -1;

    try {
      const metis = window.metis;
      if (!metis) throw new Error('Metis API not available');

      const response = decodeAgentResponse(await metis.agentChat(
        request.sessionId,
        history.map((m) => ({ role: (m.role === 'tool' || m.role === 'goal') ? 'assistant' : m.role, content: m.content })),
        activeSkillId ?? undefined,
        { mode: 'regenerate', turnId: request.turnId, ...(activeScenarioId ? { scenarioId: activeScenarioId } : {}), projectId: request.projectId },
      ));
      if (!isCurrentChatRequest(request)) return;

      if (response.status !== 'completed') {
        const terminalRun = runActivity(
          response,
          response.turnId === request.turnId ? partsForAgentTurn(request.turnId) : createAssistantMessageParts(),
        );
        const retainedStreamDraft = settleStreamingPlaceholder(request, terminalRun);
        const diagnosticCode = response.diagnostics[0]?.code ?? response.status;
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: response.status === 'interrupted' || response.status === 'cancelled'
            ? t('chat.interruptedNotice')
            : presentExecutionError(diagnosticCode, locale, resolvedUIMode),
          timestamp: now(),
          startedAt: request.startedAt,
          durationMs: Date.now() - request.startedAt,
          ...(retainedStreamDraft ? {} : { run: terminalRun }),
        }]);
      } else if (response.answer) {
        const streamedIndex = streamingIndexRef.current;
        const durationMs = Date.now() - request.startedAt;
        if (streamedIndex >= 0) {
          // Settle dedupe identical to handleChatFlow: skip the content
          // replacement when the authoritative answer matches the stream.
          setMessages((prev) => prev.map((m, i) => i === streamedIndex
            ? { ...m, ...(m.content === response.answer ? {} : { content: response.answer }), streaming: false, durationMs, run: runActivity(response, response.turnId === request.turnId ? partsForAgentTurn(request.turnId) : createAssistantMessageParts()), ...(response.citations?.length ? { citations: response.citations } : {}) }
            : m));
        } else {
          const assistantMsg: ChatMessage = {
            role: 'assistant',
            content: response.answer,
            timestamp: now(),
            startedAt: request.startedAt,
            durationMs,
            run: runActivity(response, response.turnId === request.turnId ? partsForAgentTurn(request.turnId) : createAssistantMessageParts()),
            ...(response.citations?.length ? { citations: response.citations } : {}),
            // O16: the regenerated answer is the newest active sibling in its
            // fork group (existing group extends, or a fresh group is born).
            ...(priorAssistant?.role === 'assistant'
              ? { forkId: existingForkId ?? forkId, forkIndex: existingForkId ? priorForkCount : 1, forkCount: existingForkId ? priorForkCount + 1 : 2, forkActive: true }
              : {}),
          };
          setMessages((prev) => [...prev, assistantMsg]);
        }
        // Live preview: if the response is substantial (artifact-length), render it in the
        // right panel's preview area (Claude-Artifacts-style split view).
        if (response.answer.length > 200 || /^#|^\*|\|.*\||```/.test(response.answer)) {
          openPreview(response.answer);
        }
      }
      if (response.status === 'completed') {
        void refreshArtifactsForSession(request.sessionId, request.generation);
      }
    } catch (err) {
      if (!isCurrentChatRequest(request)) return;
      const terminalRun: ChatMessage['run'] = {
        status: 'error',
        events: partsForAgentTurn(request.turnId).run.events,
        parts: partsForAgentTurn(request.turnId),
        turnId: request.turnId,
      };
      const retainedStreamDraft = settleStreamingPlaceholder(request, terminalRun);
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: presentExecutionError(err, locale, resolvedUIMode),
        timestamp: now(),
        startedAt: request.startedAt,
        durationMs: Date.now() - request.startedAt,
        ...(retainedStreamDraft ? {} : { run: terminalRun }),
      }]);
    } finally {
      if (isCurrentChatRequest(request)) {
        streamingIndexRef.current = -1;
        activeChatRequestRef.current = null;
        agentExecutionPartsBufferRef.current.delete(request.turnId);
        activeRunPartsRef.current = createAssistantMessageParts();
        setActiveRunParts(createAssistantMessageParts());
        setIsLoading(false);
        setControlState('idle');
      }
    }
  }

  // Edit a user message and resend
  /** Learn messages 0..endIndex as a reusable skill, then install it immediately. */
  async function handleLearnConversationSkill(endIndex: number, userIntent?: string): Promise<void> {
    const skillNotice = (content: string) => ({ role: 'system' as const, content, timestamp: now() });
    const selected = messages
      .slice(0, endIndex + 1)
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
      .map((m) => ({ role: m.role, content: m.content }));
    if (selected.length < 2) {
      setMessages((prev) => [...prev, skillNotice('对话太短，至少需要一轮问答才能学习为技能。')]);
      return;
    }
    setMessages((prev) => [...prev, skillNotice(`正在从选中的 ${selected.length} 条对话中提取技能…`)]);
    try {
      const result = await window.metis?.generateSkillFromConversation?.({ messages: selected, userIntent });
      if (result?.ok && result.skill) {
        const s = result.skill;
        setMessages((prev) => [...prev, skillNotice([
          `技能「${s.name}」已生成并安装！`,
          `用途：${s.description}`,
          `工具：${s.allowedTools.length > 0 ? s.allowedTools.join(', ') : '（无）'}`,
          `回合预算：${s.maxTurns}`,
          `提取依据：${s.rationale}`,
        ].join('\n'))]);
        // Refresh the in-memory dropdown so the skill is selectable immediately.
        const updatedSkills = await window.metis?.listSkills?.();
        if (Array.isArray(updatedSkills)) setSkills(updatedSkills);
      } else {
        setMessages((prev) => [...prev, skillNotice(`技能生成失败：${result?.error ?? '未知错误'}`)]);
      }
    } catch (err) {
      setMessages((prev) => [...prev, skillNotice(`技能生成异常：${err instanceof Error ? err.message : String(err)}`)]);
    }
  }

  function handleEditMessage(index: number, newContent: string) {
    // Truncate messages after the edited one, then send the new content
    const truncated = messages.slice(0, index);
    setMessages(truncated);
    // Use a microtask to ensure state is updated before handleSend reads messages
    setTimeout(() => {
      void handleSend(newContent);
    }, 0);
  }

  // Referentially stable per-message callbacks for the memoized
  // ChatMessageItem: the refs always point at the latest closures, so memo
  // comparison never sees a fresh function identity per render.
  const editMessageHandlerRef = useRef<(index: number, content: string) => void>(() => {});
  editMessageHandlerRef.current = (index, content) => handleEditMessage(index, content);
  const handleEditMessageAtIndex = useCallback((index: number, content: string) => {
    editMessageHandlerRef.current(index, content);
  }, []);
  const regenerateHandlerRef = useRef<() => void>(() => {});
  regenerateHandlerRef.current = () => { void handleRegenerate(); };
  const stableRegenerate = useCallback(() => {
    regenerateHandlerRef.current();
  }, []);
  const switchForkHandlerRef = useRef<(forkId: string, targetIndex: number) => void>(() => {});
  switchForkHandlerRef.current = (forkId, targetIndex) => handleSwitchFork(forkId, targetIndex);
  const stableSwitchFork = useCallback((forkId: string, targetIndex: number) => {
    switchForkHandlerRef.current(forkId, targetIndex);
  }, []);

  const slashSuggestions = (() => {
    if (slashMenuDismissed || !input.startsWith('/') || input.length > 80 || /\s/.test(input.slice(1))) return [];
    return filterSlashCommands(input.slice(1));
  })();
  const slashMenuOpen = slashSuggestions.length > 0;
  const activeSlashIndex = Math.min(slashActiveIndex, Math.max(0, slashSuggestions.length - 1));

  function completeSlashCommand(index: number) {
    const command = slashSuggestions[index];
    if (!command) return;
    setInput(`/${command.name}${command.hasArg ? ' ' : ''}`);
    setSlashActiveIndex(0);
    setSlashMenuDismissed(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // Handle the slash listbox before Enter-to-send. Shift+Enter always preserves a newline.
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (slashMenuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashActiveIndex((current) => (current + 1) % slashSuggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashActiveIndex((current) => (current - 1 + slashSuggestions.length) % slashSuggestions.length);
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        setSlashActiveIndex(0);
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        setSlashActiveIndex(slashSuggestions.length - 1);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashMenuDismissed(true);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault();
        completeSlashCommand(activeSlashIndex);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }


  // Build right-panel task list from active goal card if any
  const activeGoalCard = messages.find((m) => m.role === 'goal' && m.goalCard)?.goalCard;
  const rightPanelTasks = projectScenarioRun?.steps.length
    ? projectScenarioRun.steps.map((step) => ({
        id: step.stepId,
        title: step.name,
        status: toRightPanelTaskStatus(step.status),
        progress: undefined,
        // 步骤提示词随清单下发（2026-08-29 刘总要求：点击可展开查看）。
        detail: step.prompt || undefined,
      }))
    : activeGoalCard
      ? activeGoalCard.steps.map((step, index) => {
          const rawStatus = activeGoalCard.stepStatuses[step.id]?.status;
          const status = toRightPanelTaskStatus(rawStatus ?? 'pending');
          // 隐私边界与 GoalCardInline 同规则（pages.test「Runtime Tool Step」
          // 泄露断言）：内部执行文案（AgentLoop/MCP/Runtime 等）在普通模式
          // 回退为「研究步骤 N」，真实业务步骤名照常显示。
          const internalName = isInternalExecutionCopy(step.name);
          const internalDetail = isInternalExecutionCopy(step.description);
          return {
            id: step.id,
            // 具体步骤名（2026-08-29 刘总要求）：不再用"研究步骤N"遮挡真实标题。
            title: step.name && !internalName
              ? step.name
              : t('rightPanel.researchStep', { number: index + 1 }),
            status,
            progress: activeGoalCard.progress && activeGoalCard.progress.total > 0
              ? Math.round((activeGoalCard.progress.completed / activeGoalCard.progress.total) * 100)
              : undefined,
            detail: step.description && !internalDetail ? step.description : undefined,
          };
        })
      : [];

  const [projectOutcomes, setProjectOutcomes] = useState<Array<{
    id: string;
    title: string;
    type: ArtifactItemType;
    updatedAt: number;
  }>>([]);
  // ── 多对话架构第二期(2026-09-04/05 刘总要求)──
  const [activeArtifactIds, setActiveArtifactIds] = useState<string[]>([]);
  const writeSessionDraft = (sessionId: string, value: string): void => {
    try {
      const map = JSON.parse(window.localStorage.getItem('metis:chat-drafts') || '{}') as Record<string, string>;
      if (value) map[sessionId] = value.slice(0, 8000);
      else delete map[sessionId];
      window.localStorage.setItem('metis:chat-drafts', JSON.stringify(map));
    } catch { /* best-effort */ }
  };

  useEffect(() => {
    let alive = true;
    if (!activeResearchProjectId || !window.metis?.listOutcomes) {
      setProjectOutcomes([]);
      return () => { alive = false; };
    }
    void window.metis.listOutcomes({ projectId: activeResearchProjectId, query: '' }).then((items: Array<{
      id: string;
      title: string;
      kind: string;
      updatedAt: number;
    }>) => {
      if (!alive) return;
      setProjectOutcomes(items.map((item) => ({
        id: item.id,
        title: item.title,
        type: item.kind === 'word' ? 'docx'
          : item.kind === 'ppt' ? 'pptx'
            : item.kind === 'spreadsheet' ? 'xlsx'
              : item.kind === 'pdf' ? 'pdf'
                : item.kind === 'other' ? 'other'
                  : 'other',
        updatedAt: item.updatedAt,
      })));
    }).catch(() => {
      if (alive) setProjectOutcomes([]);
    });
    return () => { alive = false; };
  }, [activeResearchProjectId, isLoading]);

  // 全局对话体验重构（T3）：按逻辑成果聚合——同名（含轮次后缀规整）只保留
  // 最新一条，轮次计数进 size 标注（历史版本在成果页 VersionPanel 保留，
  // 不破坏真实版本历史，仅改善 Presentation）。
  const rightPanelArtifacts = (() => {
    const normalizeName = (name: string) => name.replace(/[(（]第\s*\d+\s*轮[)）]/gu, '').replace(/\s*v\d+$/iu, '').trim();
    const merged = [
      ...projectOutcomes.map((outcome) => ({
        id: `outcome:${outcome.id}`,
        name: outcome.title,
        type: outcome.type,
        createdAt: outcome.updatedAt,
        contentAvailable: true,
      })),
      ...artifacts.filter((artifact) => !projectOutcomes.some((outcome) => outcome.title === artifact.name)),
    ];
    const byName = new Map<string, { id: string; name: string; type: (typeof merged)[number]['type']; createdAt: number; contentAvailable: boolean; versions: number }>();
    for (const item of merged) {
      const key = normalizeName(item.name);
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, { ...item, versions: 1 });
        continue;
      }
      existing.versions += 1;
      if (item.createdAt > existing.createdAt) {
        existing.id = item.id;
        existing.name = item.name;
        existing.type = item.type;
        existing.createdAt = item.createdAt;
        existing.contentAvailable = item.contentAvailable;
      }
    }
    return [...byName.values()]
      .map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        createdAt: item.createdAt,
        contentAvailable: item.contentAvailable,
        size: item.versions > 1 ? `${item.versions} 个版本` : undefined,
      }))
      .sort((left, right) => right.createdAt - left.createdAt);
  })();

  /**
   * 结构化成果文档 → 可内嵌预览的 Markdown（2026-08-28 刘总要求：生成物点击
   * 即刻预览）。Word/PPT 提取文本；PDF/表格等二进制文档返回 null，交给
   * Metis Office 打开。
   */
  function outcomeDocumentToPreviewMarkdown(content: unknown): string | null {
    if (!content || typeof content !== 'object') return null;
    const doc = content as { type?: string };
    if (doc.type === 'word') {
      const word = content as {
        type: 'word';
        blocks?: Array<{ kind?: string; text?: string; level?: number; rows?: string[][] }>;
        header?: string;
        footer?: string;
      };
      const lines: string[] = [];
      for (const block of word.blocks ?? []) {
        if (block.kind === 'table' && Array.isArray(block.rows)) {
          const [head, ...rest] = block.rows;
          if (head?.length) {
            lines.push(`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`);
            for (const row of rest) lines.push(`| ${(row ?? []).join(' | ')} |`);
          }
          continue;
        }
        const text = (block.text ?? '').trim();
        if (!text) continue;
        if (block.kind === 'heading') lines.push(`${'#'.repeat(Math.min(6, Math.max(1, block.level ?? 1)))} ${text}`);
        else lines.push(text);
      }
      return lines.length > 0 ? lines.join('\n\n') : null;
    }
    if (doc.type === 'ppt') {
      const ppt = content as {
        type: 'ppt';
        pages?: Array<{ title?: string; elements?: Array<{ type?: string; props?: Record<string, unknown> }> }>;
      };
      const lines: string[] = [];
      (ppt.pages ?? []).forEach((page, index) => {
        const title = (page.title ?? '').trim();
        lines.push(`## ${index + 1}. ${title || (locale === 'zh' ? '未命名页' : 'Untitled page')}`);
        for (const element of page.elements ?? []) {
          if (element.type !== 'text') continue;
          const text = String(element.props?.text ?? '').trim();
          if (text) lines.push(text);
        }
      });
      return lines.length > 0 ? lines.join('\n\n') : null;
    }
    return null;
  }

  async function handleArtifactClick(
    item: Pick<ArtifactItem, 'id' | 'name' | 'contentAvailable'>,
  ) {
    const sessionId = activeSessionIdRef.current;
    const generation = sessionGenerationRef.current;
    // 项目成果：点击立即预览。文本型文档内嵌渲染；PDF/表格用 Metis Office 打开。
    if (item.id.startsWith('outcome:')) {
      const outcomeId = item.id.slice('outcome:'.length);
      const getOutcome = window.metis?.getOutcome;
      if (!activeResearchProjectId || !getOutcome) return;
      setArtifactError('');
      try {
        const detail = await getOutcome({ projectId: activeResearchProjectId, outcomeId });
        if (!detail) {
          setArtifactError(locale === 'zh' ? '无法打开这个成果，请稍后重试。' : 'This outcome could not be opened. Please try again.');
          return;
        }
        const content = (detail as { version?: { content?: unknown } }).version?.content;
        const markdown = outcomeDocumentToPreviewMarkdown(content);
        if (markdown) {
          openPreview(markdown, item.name);
          return;
        }
        const openExternal = window.metis?.openOutcomeInGenoffice;
        if (openExternal) {
          const result = await openExternal({ projectId: activeResearchProjectId, outcomeId });
          if (result?.ok) return;
        }
        setArtifactError(locale === 'zh' ? '该成果类型暂不支持内嵌预览，Metis Office 也未能打开。' : 'This outcome type has no inline preview and Metis Office failed to open it.');
      } catch {
        setArtifactError(locale === 'zh' ? '无法打开这个成果，请稍后重试。' : 'This outcome could not be opened. Please try again.');
      }
      return;
    }
    if (!item.contentAvailable) return;
    const getArtifactContent = window.metis?.getArtifactContent;
    if (!sessionId || !getArtifactContent) return;
    setArtifactError('');
    try {
      const response = await getArtifactContent(sessionId, item.id);
      if (!isCurrentSessionGeneration(sessionId, generation)) return;
      if (!response.success || response.sessionId !== sessionId || response.id !== item.id) {
        setPreviewContent('');
        setPreviewTitle('');
        setArtifactError(locale === 'zh' ? '无法打开这个生成物，请重新选择或稍后重试。' : 'This artifact could not be opened. Please try again.');
        return;
      }
      openPreview(response.content, item.name);
    } catch {
      if (!isCurrentSessionGeneration(sessionId, generation)) return;
      setPreviewContent('');
      setPreviewTitle('');
      setArtifactError(locale === 'zh' ? '无法打开这个生成物，请重新选择或稍后重试。' : 'This artifact could not be opened. Please try again.');
    }
  }

  const leftPanel = (
    <SessionSidebar
      sessions={projectScopedSessions}
      currentSessionId={currentSessionId}
      onSelect={activateSession}
      onNew={createNewSession}
      onDelete={handleDeleteSession}
      onRename={handleRenameSession}
      onArchive={handleArchiveSession}
      showArchived={showArchived}
      onToggleArchived={() => setShowArchived((v) => !v)}
      uiMode={resolvedUIMode}
    />
  );

  const selectionAskButton = selectionMenu ? (
    <button
      type="button"
      className="selection-ask-btn"
      style={{ left: selectionMenu.x, top: selectionMenu.y }}
      onClick={() => {
        const quoted = `> ${selectionMenu.text}\n\n${t('chat.selectionPrompt')}`;
        setInput(quoted);
        setSelectionMenu(null);
        inputRef.current?.focus();
      }}
    >
      {t('chat.askAboutSelection')}
    </button>
  ) : null;

  const workspace = (
    <div className="chat-main" data-testid="chat-page">
        {/* 项目内多对话切换（2026-08-29 刘总要求）：一个项目支持多个对话，
            可在此选择进入某个对话或新建对话；协同对话布局另有完整侧栏。 */}
        {(projectScopedSessions.length > 0 || currentSessionId) && (
          <div className="chat-session-bar" data-testid="chat-session-bar">
            <label>
              <span>{locale === 'zh' ? '对话' : 'Conversation'}</span>
              <select
                value={(() => {
                  const visible = projectScopedSessions.filter((s) => !s.archived);
                  const index = visible.findIndex((s) => s.id === currentSessionId);
                  // 隐私边界：会话 id 不得进入 DOM（含属性），下拉用 index 寻址。
                  return String(index >= 0 ? index : visible.length);
                })()}
                onChange={(event) => {
                  const target = projectScopedSessions.filter((s) => !s.archived)[Number(event.target.value)];
                  if (target) activateSession(target.id);
                }}
                aria-label={locale === 'zh' ? '切换对话' : 'Switch conversation'}
              >
                {projectScopedSessions.filter((s) => !s.archived).map((s, index) => (
                  // 隐私边界（pages.test 会话 id 泄露断言）：会话 id 不得出现在
                  // DOM 文本或属性里；无标题会话显示通用名而不是裸 id。
                  <option key={s.id} value={String(index)}>{presentSafeMarkdownText(s.title || t('chat.newSessionTitle'), 'normal', locale)}</option>
                ))}
                {currentSessionId && projectScopedSessions.filter((s) => !s.archived).every((s) => s.id !== currentSessionId) && (
                  <option value={String(projectScopedSessions.filter((s) => !s.archived).length)}>{t('chat.newSessionTitle')}</option>
                )}
              </select>
            </label>
            <button
              type="button"
              className="btn-sm btn-secondary"
              onClick={() => void createNewSession()}
            >
              {locale === 'zh' ? '+ 新对话' : '+ New'}
            </button>
            {/* 场景选择（2026-08-29 刘总要求）：选定后任务类消息直接按该场景
                工作流执行；项目级偏好优先，全局偏好兜底。目录加载中禁用、
                失败后保留交接并给出显式重试（旧场景选择器的语义在新下拉中
                必须完整保留，2026-08-29 回归修复）。 */}
            <label>
              <span>{locale === 'zh' ? '场景' : 'Scenario'}</span>
              <select
                value={activeScenarioId}
                disabled={scenarioLoadState === 'loading' || scenarioLoadState === 'failed'}
                onChange={(event) => {
                  const scenarioId = event.target.value;
                  setActiveScenarioId(scenarioId);
                  // 多对话架构(2026-09-04):场景绑定当前会话,正式持久化;切换对话互不影响。
                  if (currentSessionId) {
                    void window.metis?.updateSession?.(currentSessionId, { scenarioId: scenarioId || null });
                  }
                  try {
                    window.localStorage.setItem(ACTIVE_SCENARIO_KEY, scenarioId);
                    if (activeResearchProjectId) {
                      if (scenarioId) window.localStorage.setItem(`metis:project-scenario:${activeResearchProjectId}`, scenarioId);
                      else window.localStorage.removeItem(`metis:project-scenario:${activeResearchProjectId}`);
                    }
                  } catch { /* preference persistence is best-effort */ }
                }}
                aria-label={t('chat.activeScenario')}
              >
                {scenarioLoadState === 'loading' && (
                  <option value="">{t('chat.scenarioLoadingOption')}</option>
                )}
                {scenarioLoadState === 'failed' && (
                  <option value="">{t('chat.scenarioUnavailableOption')}</option>
                )}
                {scenarioLoadState === 'ready' && (
                  <option value="">{t('chat.noCustomScenario')}</option>
                )}
                {scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name}</option>)}
              </select>
            </label>
            {/* 多对话架构第二期(2026-09-05):当前工作对象——正式持久化到 session,发送时注入模型上下文 */}
            {activeResearchProjectId && projectOutcomes.length > 0 && (
              <label>
                <span>{locale === 'zh' ? '当前成果' : 'Artifact'}</span>
                <select
                  value={activeArtifactIds[0] ?? ''}
                  onChange={(event) => {
                    const next = event.target.value ? [event.target.value] : [];
                    setActiveArtifactIds(next);
                    try {
                      if (currentSessionId) {
                        void window.metis?.updateSession?.(currentSessionId, { activeArtifactIds: next });
                        window.localStorage.setItem(`metis:session-artifacts:${currentSessionId}`, JSON.stringify(next));
                      }
                    } catch { /* best-effort */ }
                  }}
                  aria-label={locale === 'zh' ? '当前工作对象' : 'Active artifact'}
                  data-testid="chat-active-artifact"
                >
                  <option value="">{locale === 'zh' ? '不指定' : 'None'}</option>
                  {projectOutcomes.map((outcome) => <option key={outcome.id} value={outcome.id}>{outcome.title}</option>)}
                </select>
              </label>
            )}
            {scenarioLoadState === 'loading' && (
              <div role="status" className="chat-scenario-catalog-status">{t('chat.scenarioLoading')}</div>
            )}
            {scenarioLoadState === 'failed' && (
              <div role="alert" className="chat-scenario-catalog-status">
                {t('chat.scenarioLoadFailed')}
                <button
                  type="button"
                  className="btn-sm btn-secondary"
                  aria-label={t('chat.retryScenarioLoading')}
                  onClick={() => setScenarioLoadRevision((revision) => revision + 1)}
                >
                  {t('chat.retry')}
                </button>
              </div>
            )}
          </div>
        )}
        <div className="chat-messages" ref={chatMessagesRef}>
          {messages.length === 0 && !isLoading && (
            <div className="chat-empty">
              <h2>{t('chat.emptyTitle')}</h2>
              <p>{t('chat.emptyDescription')}</p>
              <p className="chat-empty__examples">{t('chat.emptyExamples')}</p>
            </div>
          )}
          {(() => {
            // O15: side-by-side rendering — consecutive assistant messages of
            // the same compareGroup are laid out in a flex row instead of a
            // vertical stack.
            const rendered: React.ReactNode[] = [];
            let groupBuffer: Array<{ msg: ChatMessage; index: number }> = [];
            let groupId: string | null = null;
            const renderGoal = (msg: ChatMessage, index: number) => (
              <GoalCardInline
                key={msg.id ?? `goal-${index}`}
                data={msg.goalCard!}
                uiMode={resolvedUIMode}
                registerStepElement={(stepId, element) => {
                  const key = `${msg.goalCard!.goalId}\u0000${stepId}`;
                  if (element) goalStepElementRefs.current.set(key, element);
                  else goalStepElementRefs.current.delete(key);
                }}
                onPause={() => {
                  const goalId = msg.goalCard!.goalId;
                  if (goalId) void handlePauseGoal(goalId);
                }}
                onCancel={() => {
                  const goalId = msg.goalCard!.goalId;
                  if (goalId) void handleCancelGoal(goalId);
                }}
                onResume={() => {
                  const goalId = msg.goalCard!.goalId;
                  if (goalId) void handleResumeGoal(goalId);
                }}
                onRetry={() => {
                  const goalId = msg.goalCard!.goalId;
                  if (goalId) void handleResumeGoal(goalId);
                }}
                onOpenBoard={() => {
                  const goalId = msg.goalCard!.goalId;
                  if (!goalId) return;
                  window.dispatchEvent(new CustomEvent('metis:open-kanban', { detail: { goalId } }));
                }}
              />
            );
            const renderItem = (msg: ChatMessage, index: number) => (
              <ChatMessageItem
                key={msg.id ?? index}
                msg={msg}
                index={index}
                isLast={index === messages.length - 1}
                diagnosticMode={diagnosticMode}
                onOpenPaper={openPaperByDoi}
                onEdit={msg.role === 'user' ? handleEditMessageAtIndex : undefined}
                onRegenerate={msg.role === 'assistant' ? stableRegenerate : undefined}
                onSwitchFork={msg.forkId ? stableSwitchFork : undefined}
                onStepCardComment={handleStepCardComment}
              />
            );
            const flushGroup = () => {
              if (groupBuffer.length === 0) return;
              if (groupId) {
                rendered.push(
                  <div className="chat-compare-row" key={`compare-${groupId}`} data-testid={`compare-row-${groupId}`}>
                    {groupBuffer.map(({ msg, index }) => renderItem(msg, index))}
                  </div>,
                );
              } else {
                for (const { msg, index } of groupBuffer) {
                  if (msg.role === 'goal' && msg.goalCard) {
                    rendered.push(renderGoal(msg, index));
                  } else {
                    rendered.push(renderItem(msg, index));
                  }
                }
              }
              groupBuffer = [];
              groupId = null;
            };
            messages.forEach((msg, index) => {
              // O16: hide inactive fork siblings.
              if (msg.forkId && msg.forkActive === false) return;
              if (msg.compareGroup) {
                if (groupId !== null && msg.compareGroup !== groupId) flushGroup();
                groupId = msg.compareGroup;
                groupBuffer.push({ msg, index });
              } else {
                flushGroup();
                if (msg.role === 'goal' && msg.goalCard) {
                  rendered.push(renderGoal(msg, index));
                } else {
                  rendered.push(renderItem(msg, index));
                }
              }
            });
            flushGroup();
            return rendered;
          })()}
          {isLoading && !activeGoalId && streamingIndexRef.current < 0 && (
            <div className="chat-message assistant chat-run-pending" data-testid="active-run-timeline">
              <div className="message-avatar">M</div>
              <div className="message-body">
                <MemoizedAgentActivityTimeline
                  status="running"
                  events={activeRunParts.run.events}
                  parts={activeRunParts}
                  startedAt={activeChatRequestRef.current?.startedAt}
                  locale={locale}
                  diagnosticMode={diagnosticMode}
                  pendingLabel={locale === 'zh' ? '运行已发起，等待模型响应' : 'Run started; waiting for model response'}
                />
              </div>
            </div>
          )}
          {!isFollowingLatest && (
            <button
              type="button"
              className="chat-return-latest"
              data-testid="return-to-latest"
              onClick={scrollToLatest}
            >
              {locale === 'zh' ? '回到最新消息' : 'Return to latest'}
            </button>
          )}
          <div ref={messagesEndRef} />
        </div>
        {selectionAskButton}
        <div
          className={`chat-input-area ${dragOver ? 'drag-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={async (e) => {
            e.preventDefault();
            setDragOver(false);
            const sessionId = activeSessionIdRef.current;
            const generation = sessionGenerationRef.current;
            if (!sessionId) return;
            // Import dropped bytes into the main-process managed attachment area;
            // renderer code never receives or forwards a local filesystem path.
            const files = e.dataTransfer.files;
            if (!files?.length) return;
            for (const file of Array.from(files)) {
              if (!isCurrentSessionGeneration(sessionId, generation)) break;
              try {
                if (file.size <= 0 || file.size > FILE_CAPABILITY_LIMITS.maxImportBytes) continue;
                const imported = await window.metis?.importFileCapability({
                  purpose: 'artifact-attachment',
                  displayName: file.name,
                  mime: file.type || 'application/octet-stream',
                  data: new Uint8Array(await file.arrayBuffer()),
                });
                if (!imported?.success) continue;
                const filePath = imported.capability.capabilityId;
                const sizeStr = file.size > 1024 * 1024
                  ? `${(file.size / 1024 / 1024).toFixed(1)}MB`
                  : `${(file.size / 1024).toFixed(1)}KB`;
                const artifactId = `art_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const artifactType = inferArtifactType(file.name);
                if (window.metis?.createArtifact) {
                  const result = await window.metis.createArtifact({
                    id: artifactId,
                    sessionId,
                    name: file.name,
                    type: artifactType,
                    sourceCapabilityId: imported.capability.capabilityId,
                    size: sizeStr,
                  });
                  if (!result.success) continue;
                } else {
                  continue;
                }
                if (!isCurrentSessionGeneration(sessionId, generation)) break;
                setArtifacts((prev) => [{
                  id: artifactId,
                  name: file.name,
                  type: artifactType,
                  sourceCapability: imported.capability,
                  size: sizeStr,
                  createdAt: Date.now(),
                  contentAvailable: false,
                }, ...prev.filter((item) => item.id !== artifactId)]);
                setMessages((prev) => [...prev, {
                  role: 'system',
                  content: diagnosticMode
                    ? `[附件] **${file.name}** (${sizeStr}) 已导入。\n路径: \`${filePath}\``
                    : t('chat.attachmentImportedWithSize', {
                        name: file.name,
                        size: sizeStr,
                      }),
                  timestamp: now(),
                }]);
              } catch (err: unknown) {
                if (!isCurrentSessionGeneration(sessionId, generation)) break;
                setMessages((prev) => [...prev, {
                  role: 'system',
                  content: t('chat.importFailed', {
                    message: presentExecutionError(err, locale, resolvedUIMode),
                  }),
                  timestamp: now(),
                }]);
              }
            }
          }}
        >
          {goalSuggestion && !hasActiveScenarioRun && (
            <div className="chat-goal-suggestion" data-testid="goal-suggestion-bar">
              <span>{locale === 'zh' ? '这个请求适合作为长期研究任务执行。' : 'This request could run as a long-running research task.'}</span>
              <button
                type="button"
                className="btn-sm btn-primary"
                data-testid="goal-suggestion-button"
                disabled={isLoading}
                onClick={() => {
                  const text = goalSuggestion;
                  setGoalSuggestion(null);
                  if (text) void handleGoalFlow(text);
                }}
              >
                {locale === 'zh' ? '转为研究任务' : 'Turn into research task'}
              </button>
            </div>
          )}
          {stepTarget && (
            <div className="chat-target-chip" role="status" data-testid="chat-step-target">
              <span>{locale === 'zh' ? '针对' : 'Target'}: {stepTarget.title ? `步骤 · ${stepTarget.title}` : stepTarget.stepId}{stepTargetMode === 'modify' ? (locale === 'zh' ? '（修改模式）' : ' (modify)') : ''}</span>
              <button type="button" onClick={() => setStepTarget(null)} aria-label={locale === 'zh' ? '清除对话目标' : 'Clear target'}>×</button>
            </div>
          )}
          <div className="chat-input-grid">
            <div className="chat-input-maincol">
              <div className="chat-input-topbar" data-testid="chat-toolbar-row">
                {/* 学习技能按钮已按刘总要求移除（2026-09）。 */}
                <button
                  className="chat-top-tool"
                  onClick={handleAutoNameSession}
                  title={t('chat.autoName')}
                  aria-label={t('chat.autoName')}
                  data-testid="auto-name-session"
                  disabled={isLoading || messages.length === 0}
                >
                  <TagIcon size={14} />
                  <span>{locale === 'zh' ? '命名对话' : 'Name'}</span>
                </button>
                <ModelThinkingSelector zh={locale === 'zh'} labeled disabled={isLoading} />
              </div>
              <div className="chat-input-row">
                <button
                  className="chat-tool-icon chat-side-upload"
                  onClick={handleFileUpload}
                  title="上传文件"
                  aria-label="上传文件"
                  disabled={isLoading}
                >
                  <PaperclipIcon size={16} />
                </button>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    if (currentSessionId) writeSessionDraft(currentSessionId, e.target.value);
                    setSlashActiveIndex(0);
                    setSlashMenuDismissed(false);
                  }}
                  onKeyDown={handleKeyDown}
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={slashMenuOpen}
                  aria-controls={slashMenuOpen ? 'slash-command-listbox' : undefined}
                  aria-activedescendant={slashMenuOpen ? `slash-command-option-${activeSlashIndex}` : undefined}
                  placeholder={isLoading
                    ? (activeScenarioId
                      ? (locale === 'zh' ? '场景执行中 · 直接输入将实时引导当前步骤…' : 'Scenario running · type to steer the current step…')
                      : (locale === 'zh' ? '输入新指令，实时引导当前任务…' : 'Send a new instruction to steer the active run…'))
                    : t('chat.placeholder')}
                  className="chat-textarea"
                  rows={1}
                />
                {isLoading && <button
                  type="button"
                  onClick={() => void handleInterrupt()}
                  className="chat-interrupt"
                  aria-label={locale === 'zh' ? '打断当前任务' : 'Interrupt active run'}
                >{locale === 'zh' ? '打断' : 'Stop'}</button>}
                <button
                  onClick={() => handleSend()}
                  className="chat-send"
                  disabled={!input.trim()}
                >
                  {isLoading ? (locale === 'zh' ? '引导' : 'Steer') : t('common.send')}
                </button>
              </div>
            </div>
          </div>
          {slashMenuOpen && (
            <div
              id="slash-command-listbox"
              className="slash-command-menu"
              data-testid="slash-command-menu"
              role="listbox"
              aria-label={locale === 'zh' ? '斜杠命令建议' : 'Slash command suggestions'}
            >
              {slashSuggestions.slice(0, 8).map((command, index) => (
                <button
                  key={command.name}
                  id={`slash-command-option-${index}`}
                  className={`slash-command-item ${index === activeSlashIndex ? 'slash-command-item--active' : ''}`}
                  data-testid={`slash-cmd-${command.name}`}
                  role="option"
                  aria-selected={index === activeSlashIndex}
                  onMouseEnter={() => setSlashActiveIndex(index)}
                  onClick={() => completeSlashCommand(index)}
                >
                  <strong>/{command.name}</strong> <span className="slash-command-item__desc">{command.description}</span>
                </button>
              ))}
             </div>
           )}
         </div>
    </div>
  );

  const rightPanel = (
    <RightPanel
      activeTab={activeRightPanelTab}
      onActiveTabChange={setActiveRightPanelTab}
      tasks={rightPanelTasks}
      artifacts={rightPanelArtifacts}
      previewContent={previewContent}
      previewTitle={previewContent ? previewTitle : undefined}
      artifactError={artifactError}
      uiMode={resolvedUIMode}
      embedded
      suppressInlinePreview={previewMode === 'pane'}
      onArtifactClick={(item) => void handleArtifactClick(item)}
      onTaskClick={(id) => {
        if (!activeGoalCard) return;
        const el = goalStepElementRefs.current.get(`${activeGoalCard.goalId} ${id}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }}
    />
  );

  // 预览栏（2026-08-31 刘总布局重构）：projects 模式下预览内容以独立整列
  // 呈现在最右侧，由 ProjectsPage 做布局联动；其余模式仍走右栏内联预览。
  const previewPanel = previewMode === 'pane' && previewContent ? (
    <ArtifactPreviewPane
      title={previewTitle}
      content={previewContent}
      uiMode={resolvedUIMode}
      locale={locale}
      onClose={() => setPreviewContent('')}
      onExportDocx={async () => {
        const result = await window.metis?.exportMarkdownAsDocx?.({
          title: previewTitle || (locale === 'zh' ? '生成物' : 'Artifact'),
          markdown: previewContent,
        });
        return result ?? { ok: false, message: 'export unavailable' };
      }}
    />
  ) : null;

  return renderLayout({
    leftPanel,
    workspace,
    rightPanel,
    previewPanel,
  });
}
