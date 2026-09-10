/**
 * Topic Context Package（METIS → Chatbot Bridge，2026-09-05 刘总规格书）。
 * 把 TopicWorkspacePage 的当前状态组装为契约层 ContextPackageInput，
 * 再由 engine 的 buildContextPackage 生成确定性 Markdown 文本。
 * 纯函数、无副作用，便于单测。
 */

import { buildContextPackage as buildPackage, type ContextPackageInput } from '../../engine/runtime/ExternalReferenceContract.js';

export interface TopicContextSnapshot {
  hasSession: boolean;
  sessionTitle: string | null;
  sessionStatus: string | null;
  candidates: Array<{ title: string; status: string; novelty?: number | null; feasibility?: number | null }>;
  messages: Array<{ role: string; content: string }>;
  externalReferences: Array<{ model: string; quotedText: string }>;
}

export function buildTopicContextPackage(snapshot: TopicContextSnapshot, maxChars?: number): string | null {
  if (!snapshot.hasSession) return null;
  const input: ContextPackageInput = {
    topicQuestion: snapshot.sessionTitle,
    sessionStatus: snapshot.sessionStatus,
    candidates: snapshot.candidates,
    recentTurns: snapshot.messages,
    externalReferences: snapshot.externalReferences,
    ...(maxChars !== undefined ? { maxChars } : {}),
  };
  return buildPackage(input);
}
