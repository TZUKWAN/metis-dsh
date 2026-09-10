/**
 * Assistant 流累积器（2026-09-05 Conversation Streaming P0，Phase 1）。
 *
 * 职责对应 DeepSeek Harness 的 ClientAssistantStream（assistant-stream.ts）本质：
 * 把瞬态 chunk 帧折叠为单一权威累积状态，settle 时用持久层权威内容一次性 swap，
 * 全程不产生「transient 尾巴 + 最终消息」双份渲染。
 *
 * 与 DSH 的差异（有意为之）：METIS 事件同源单进程，无重连窗口，故无分数 seq
 * 与 pending-by-seq 队列；attempt 身份 + dense index + settle swap + abandon 撤销
 * + rebaseline 兜底这些不变量全部保留。
 */

import type {
  AssistantStreamDecision,
  AssistantStreamFrame,
} from '../contract/AssistantStreamContract.js';

export type AssistantStreamStatus = 'streaming' | 'completed' | 'interrupted' | 'failed' | 'abandoned';

export interface AssistantStreamSnapshot {
  attemptId: string;
  content: string;
  reasoning: string;
  status: AssistantStreamStatus;
}

export class AssistantStreamAccumulator {
  private attemptId: string | null = null;
  private nextIndex = 0;
  private content = '';
  private reasoning = '';
  private status: AssistantStreamStatus = 'streaming';

  /** 当前是否有正在进行的 attempt。 */
  isStreaming(): boolean {
    return this.attemptId !== null;
  }

  /** 当前累积快照；无活动 attempt 时返回最近一次结算的终态（供 settled 渲染续读）。 */
  snapshot(): AssistantStreamSnapshot | null {
    if (this.attemptId === null && this.status === 'streaming') return null;
    const attemptId = this.attemptId ?? this.lastSettledAttemptId ?? 'unknown';
    return {
      attemptId,
      content: this.content,
      reasoning: this.reasoning,
      status: this.status,
    };
  }

  private lastSettledAttemptId: string | null = null;

  acceptFrame(frame: AssistantStreamFrame): AssistantStreamDecision {
    switch (frame.type) {
      case 'start': {
        if (this.attemptId === frame.attemptId) {
          return { type: 'ignored', attemptId: frame.attemptId, reason: 'duplicate_start' };
        }
        this.attemptId = frame.attemptId;
        this.nextIndex = 0;
        this.content = '';
        this.reasoning = '';
        this.status = 'streaming';
        return { type: 'accepted', attemptId: frame.attemptId, textDelta: '', reasoningDelta: '' };
      }
      case 'chunk': {
        if (this.attemptId !== frame.attemptId) {
          // 迟到的旧 attempt chunk：绝不混入当前流。
          return { type: 'ignored', attemptId: frame.attemptId, reason: 'stale_attempt' };
        }
        if (frame.index !== this.nextIndex) {
          // dense index 断裂 = 失步。宁可重同步也不猜（DSH rebaseline 本质）。
          return {
            type: 'rebaseline',
            attemptId: frame.attemptId,
            reason: `index_gap: expected ${this.nextIndex}, got ${frame.index}`,
          };
        }
        const textDelta = frame.textDelta ?? '';
        const reasoningDelta = frame.reasoningDelta ?? '';
        this.content += textDelta;
        this.reasoning += reasoningDelta;
        this.nextIndex += 1;
        return { type: 'accepted', attemptId: frame.attemptId, textDelta, reasoningDelta };
      }
      case 'end': {
        if (this.attemptId !== frame.attemptId) {
          return { type: 'ignored', attemptId: frame.attemptId, reason: 'stale_attempt' };
        }
        if (frame.index !== this.nextIndex) {
          return {
            type: 'rebaseline',
            attemptId: frame.attemptId,
            reason: `index_gap_at_end: expected ${this.nextIndex}, got ${frame.index}`,
          };
        }
        if (frame.outcome === 'settled') {
          // settle swap：权威全文覆盖累积内容（防字节级漂移与双份渲染）。
          this.content = frame.finalContent;
          this.reasoning = frame.finalReasoning ?? this.reasoning;
          this.status = frame.status;
          const attemptId = this.attemptId;
          this.attemptId = null;
          this.lastSettledAttemptId = attemptId;
          return {
            type: 'settled',
            attemptId,
            content: this.content,
            reasoning: this.reasoning,
            status: frame.status,
          };
        }
        // abandoned：撤销 transient 呈现（内容清空，节点由消费方移除）。
        this.content = '';
        this.reasoning = '';
        this.status = 'abandoned';
        const attemptId = this.attemptId;
        this.attemptId = null;
        this.lastSettledAttemptId = attemptId;
        return { type: 'abandoned', attemptId };
      }
    }
  }

  /** rebaseline 决策后由 controller 调用：丢弃全部 transient 状态，等待重同步。 */
  reset(): void {
    this.attemptId = null;
    this.nextIndex = 0;
    this.content = '';
    this.reasoning = '';
    this.status = 'streaming';
  }

  /**
   * 进程内自愈（与 DSH 重启式 rebaseline 的差异）：
   * METIS 的实时通道是进程内有序 IPC，index 断裂只可能来自适配层缺陷，
   * 没有可重拉的服务端窗口。因此失步时保留已累积内容、只对齐 index 期望值，
   * 由 controller 对同一帧重新 acceptFrame 吸收——内容不丢，失步可观测。
   */
  resync(attemptId: string, nextIndex: number): void {
    if (this.attemptId !== attemptId) return;
    this.nextIndex = nextIndex;
  }
}
