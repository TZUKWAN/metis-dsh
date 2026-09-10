/**
 * Conversation Framework 统一类型（2026-09-08 全局对话体验重构 T2）。
 *
 * Typed Parts 是唯一的新消息 UI 协议：scenario_step/artifact 等结构化内容
 * 必须以 Part 承载，禁止再生成 metis-step-card 等 Markdown 围栏协议
 * （历史围栏由 normalizeLegacyMessage 解码，仅用于旧数据兼容）。
 */

export type ConversationRole = 'user' | 'assistant' | 'system';

export type ConversationMessageStatus = 'streaming' | 'completed' | 'failed' | 'stopped';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ReasoningPart {
  type: 'reasoning';
  /** 运行时允许展示的摘要（阶段/计划/动作），绝不承载模型隐藏思维链。 */
  summary: string;
  status: 'running' | 'completed';
}

export interface ToolPart {
  type: 'tool';
  toolCallId: string;
  name: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  summary?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface CitationPart {
  type: 'citation';
  citations: Array<{ title?: string; url?: string; label?: string }>;
}

export interface ScenarioStepPart {
  type: 'scenario_step';
  runId: string;
  stepId: string;
  revision?: number;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'stale';
  brief?: string;
  durationMs?: number;
  artifactCount?: number;
  sourceCount?: number;
  artifactRefs?: string[];
}

export interface ArtifactPart {
  type: 'artifact';
  artifactId: string;
  title: string;
  artifactType: string;
  status: 'created' | 'updated';
}

export interface StatusPart {
  type: 'status';
  text: string;
  tone?: 'info' | 'success' | 'warning';
}

export interface ErrorPart {
  type: 'error';
  message: string;
  technical?: string;
  retryable?: boolean;
}

export type ConversationPart =
  | TextPart
  | ReasoningPart
  | ToolPart
  | CitationPart
  | ScenarioStepPart
  | ArtifactPart
  | StatusPart
  | ErrorPart;

export interface ConversationMessage {
  id: string;
  role: ConversationRole;
  createdAt: number;
  status?: ConversationMessageStatus;
  parts: ConversationPart[];
}

/**
 * Conversation Target：结构化对话目标（Composer Target Chip / Step 三操作）。
 * Target 随消息一起进入 Runtime，禁止退化为「针对步骤6」式字符串拼接。
 */
export type ConversationTarget =
  | { type: 'scenario_step'; runId: string; stepId: string; revision?: number; title?: string }
  | { type: 'artifact'; artifactId: string; title?: string }
  | { type: 'source'; sourceId: string; label?: string }
  | { type: 'topic_candidate'; candidateId: string; title?: string };

export function targetLabel(target: ConversationTarget): string {
  switch (target.type) {
    case 'scenario_step':
      return `步骤 · ${target.title ?? target.stepId}`;
    case 'artifact':
      return `成果 · ${target.title ?? target.artifactId}`;
    case 'source':
      return `来源 · ${target.label ?? target.sourceId}`;
    case 'topic_candidate':
      return `候选 · ${target.title ?? target.candidateId}`;
  }
}

/** 供 Runtime 消费的 Target 结构化载荷（不含 UI 文案）。 */
export function targetPayload(target: ConversationTarget): Record<string, unknown> {
  switch (target.type) {
    case 'scenario_step':
      return { targetType: 'scenario_step', runId: target.runId, stepId: target.stepId, ...(target.revision !== undefined ? { revision: target.revision } : {}) };
    case 'artifact':
      return { targetType: 'artifact', artifactId: target.artifactId };
    case 'source':
      return { targetType: 'source', sourceId: target.sourceId };
    case 'topic_candidate':
      return { targetType: 'topic_candidate', candidateId: target.candidateId };
  }
}

// ─── ConversationEvent：统一流式事件模型 ─────────────────────────

export type ConversationEvent =
  | { type: 'turn.started'; turnId: string }
  | { type: 'assistant.started'; turnId: string }
  | { type: 'assistant.delta'; turnId: string; delta: string }
  | { type: 'assistant.completed'; turnId: string }
  | { type: 'reasoning.started'; turnId: string; summary: string }
  | { type: 'reasoning.delta'; turnId: string; delta: string }
  | { type: 'reasoning.completed'; turnId: string }
  | { type: 'tool.started'; turnId: string; toolCallId: string; name: string; label: string }
  | { type: 'tool.completed'; turnId: string; toolCallId: string; summary?: string }
  | { type: 'tool.failed'; turnId: string; toolCallId: string; message: string }
  | { type: 'scenario.step.started'; turnId: string; runId: string; stepId: string; title: string }
  | { type: 'scenario.step.completed'; turnId: string; part: ScenarioStepPart }
  | { type: 'scenario.step.failed'; turnId: string; runId: string; stepId: string; message: string }
  | { type: 'artifact.created'; turnId: string; part: ArtifactPart }
  | { type: 'citation.added'; turnId: string; part: CitationPart }
  | { type: 'status.updated'; turnId: string; part: StatusPart }
  | { type: 'turn.completed'; turnId: string }
  | { type: 'turn.failed'; turnId: string; message: string };
