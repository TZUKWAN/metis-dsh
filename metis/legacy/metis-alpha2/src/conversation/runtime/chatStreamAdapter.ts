/**
 * chat:stream-chunk → Assistant Stream Contract 适配器（2026-09-05 P0 Phase 2）。
 *
 * 旧 IPC payload（{turnId, content, reasoning, isFinished}）继续存在为兼容 facade
 * （规格八十九），但 renderer 侧不再直接消费它——统一转成 controller 调用。
 * 注意：isFinished=true 只代表流通道关闭；权威结算仍以持久层响应内容为准
 * （settleTurn 由 chat 响应回调调用），此处不做 settle，防止 transient 尾巴提前定型。
 */

import type { ConversationController } from './ConversationController.js';

export interface ChatStreamChunkPayload {
  turnId: string;
  sessionId?: string;
  content: string;
  reasoning?: string;
  isFinished: boolean;
}

export function ingestChatStreamChunk(controller: ConversationController, payload: ChatStreamChunkPayload): void {
  controller.acceptDelta(payload.turnId, payload.content, payload.reasoning ?? '');
}
