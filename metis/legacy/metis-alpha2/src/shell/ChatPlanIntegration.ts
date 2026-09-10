/**
 * Chat + execution-state integration model (METIS-505).
 *
 * Unifies chat messages, plan steps, tool executions, and produced artifacts into ONE
 * message stream so the user understands from the conversation what Metis is doing and what
 * it produced — not four separate disconnected UIs (METIS-505 completion).
 *
 * The stream is an ordered list of ChatStreamItem; each is either a user/assistant message,
 * an embedded plan card, an approval request, a progress event, a tool result, or a
 * produced-artifact notice. Renderers turn each into an inline card within the chat.
 */

import type { ResearchLifecycle } from '../../engine/core/types.js';

export type ChatStreamItemKind =
  | 'message'         // a user or assistant text message
  | 'plan'            // an embedded research-plan card
  | 'approval'        // a HITL approval request
  | 'progress'        // a step progress event
  | 'tool_result'     // a tool execution result
  | 'artifact'        // a produced artifact notice
  | 'failure_recovery'; // a failure + recovery notice

export interface ChatStreamItem {
  id: string;
  kind: ChatStreamItemKind;
  /** Ordering timestamp; the stream is sorted by this. */
  at: number;
  // Discriminated payload:
  message?: { role: 'user' | 'assistant'; content: string };
  plan?: { planId: string; lifecycle: ResearchLifecycle; stepSummary: string };
  approval?: { requestId: string; toolName: string; argsSummary: string; status: 'pending' | 'approved' | 'rejected' };
  progress?: { stepName: string; completed: number; total: number };
  toolResult?: { toolName: string; ok: boolean; summary: string };
  artifact?: { artifactId: string; title: string; reviewStatus: string };
  failure?: { error: string; recovered: boolean; recoveryAction: string };
}

export interface ChatPlanStream {
  items: ChatStreamItem[];
}

export function createChatPlanStream(): ChatPlanStream {
  return { items: [] };
}

export function appendItem(stream: ChatPlanStream, item: ChatStreamItem): ChatPlanStream {
  return { items: [...stream.items, item].sort((a, b) => a.at - b.at) };
}

/**
 * Produce a user-readable narrative summary of the latest execution state — so the chat can
 * show "Metis 正在执行第 2 步：检索文献（2/5）" rather than a bare progress integer.
 */
export function narrativeSummary(stream: ChatPlanStream): string {
  const last = stream.items[stream.items.length - 1];
  if (!last) return '准备开始。';
  switch (last.kind) {
    case 'message':
      return last.message?.role === 'assistant' ? `Metis：${last.message.content.slice(0, 40)}` : '您发送了一条消息。';
    case 'plan':
      return `已生成研究计划（${last.plan?.lifecycle}）：${last.plan?.stepSummary}`;
    case 'approval':
      return last.approval?.status === 'pending'
        ? `需要您确认：${last.approval?.toolName}`
        : `已${last.approval?.status === 'approved' ? '批准' : '拒绝'}：${last.approval?.toolName}`;
    case 'progress':
      return `正在执行：${last.progress?.stepName}（${last.progress?.completed}/${last.progress?.total}）`;
    case 'tool_result':
      return last.toolResult?.ok
        ? `完成工具调用：${last.toolResult?.toolName}`
        : `工具调用失败：${last.toolResult?.toolName}`;
    case 'artifact':
      return `生成了成果：${last.artifact?.title}（${last.artifact?.reviewStatus}）`;
    case 'failure_recovery':
      return last.failure?.recovered
        ? `遇到错误并已恢复：${last.failure?.recoveryAction}`
        : `遇到错误：${last.failure?.error}`;
  }
}
