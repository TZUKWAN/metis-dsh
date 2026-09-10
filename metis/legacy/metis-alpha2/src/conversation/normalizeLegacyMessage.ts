import type { ScenarioStepCardData } from '../components/ScenarioStepCard';
import type { ConversationMessage, ConversationPart, ScenarioStepPart } from './types';

/**
 * Legacy 消息规范化（T2）：旧持久化消息 → ConversationMessage parts。
 *
 * - metis-step-card 围栏（历史数据）→ scenario_step part（legacy decoder 仅此用途）；
 * - 新消息禁止再生成围栏（见 ScenarioWorkflowService structured metadata）。
 */

export { parseScenarioStepCard } from '../components/ScenarioStepCard';

function stepCardToPart(card: ScenarioStepCardData): ScenarioStepPart {
  const brief = card.brief
    ? [card.brief.approach, card.brief.result, card.brief.next].filter(Boolean).join('\n')
    : undefined;
  return {
    type: 'scenario_step',
    runId: card.runId,
    stepId: card.stepId,
    revision: card.iteration,
    title: card.stepName,
    status: card.status === 'final' ? 'completed' : card.status,
    brief,
    artifactCount: card.chars > 0 ? 1 : 0,
    artifactRefs: card.artifactName ? [card.artifactName] : undefined,
  };
}

/** 从消息 content 中拆出 step-card 围栏与其余 Markdown 正文。 */
export function splitLegacyStepCards(content: string): {
  textParts: string[];
  stepParts: ScenarioStepPart[];
  /** 存在无法解析的围栏块（保留原文展示，避免静默丢内容）。 */
  rawBlocks: string[];
} {
  const textParts: string[] = [];
  const stepParts: ScenarioStepPart[] = [];
  const rawBlocks: string[] = [];
  const fence = /```metis-step-card\n([\s\S]*?)```/gu;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(content)) !== null) {
    const before = content.slice(cursor, match.index).trim();
    if (before) textParts.push(before);
    const parsed = ((): ScenarioStepCardData | null => {
      try {
        const value = JSON.parse(match[1]!) as ScenarioStepCardData;
        return value && typeof value === 'object' && typeof value.runId === 'string' ? value : null;
      } catch {
        return null;
      }
    })();
    if (parsed) stepParts.push(stepCardToPart(parsed));
    else rawBlocks.push(match[0]);
    cursor = fence.lastIndex;
  }
  const tail = content.slice(cursor).trim();
  if (tail) textParts.push(tail);
  return { textParts, stepParts, rawBlocks };
}

export interface LegacyMessageInput {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  metadata?: unknown;
}

/** 旧消息 → ConversationMessage（围栏降级为 parts；纯文本保持单 text part）。 */
export function normalizeLegacyMessage(message: LegacyMessageInput): ConversationMessage {
  if (message.role === 'user') {
    return { id: message.id, role: message.role, createdAt: message.createdAt, parts: [{ type: 'text', text: message.content }] };
  }
  // assistant 与 system 都可能带历史 step-card 围栏（系统消息曾以围栏嵌入
  // 步骤卡，未走 assistant 解码路径会原样裸露 JSON）。
  const hasFence = message.content.includes('```metis-step-card');
  if (!hasFence) {
    return { id: message.id, role: message.role, createdAt: message.createdAt, parts: [{ type: 'text', text: message.content }] };
  }
  const { textParts, stepParts, rawBlocks } = splitLegacyStepCards(message.content);
  const parts: ConversationPart[] = [];
  // 顺序近似保留：正文在前、卡片随后（历史数据无精确交错信息）。
  for (const text of textParts) parts.push({ type: 'text', text });
  parts.push(...stepParts);
  for (const raw of rawBlocks) {
    parts.push({ type: 'text', text: raw });
  }
  if (parts.length === 0) parts.push({ type: 'text', text: message.content });
  return { id: message.id, role: message.role, createdAt: message.createdAt, parts };
}
