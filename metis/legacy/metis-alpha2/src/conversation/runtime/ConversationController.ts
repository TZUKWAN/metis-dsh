/**
 * Conversation Controller（2026-09-05 Conversation Streaming P0，Phase 2）。
 *
 * 把 Phase 1 的三件核心（Accumulator / Scheduler / NodeStore）组装成
 * 对话流式的单一权威控制器：
 * - beginTurn / acceptDelta / settleTurn / abandonTurn 是唯一写入口；
 * - 流式 delta 走 frame 节奏发布，结算/放弃/中断走 immediate 抢占；
 * - 节点身份 = `assistant:${attemptId}`，running → settled/abandoned 全程同一 key
 *   （规格九：Streaming → Settlement 不换 React identity）。
 *
 * ChatPage / Topic / Scenario 等所有对话面共享本控制器基础设施；
 * 业务页面只提供 attemptId 与最终结算内容。
 */

import {
  AssistantStreamAccumulator,
  type AssistantStreamSnapshot,
} from './AssistantStreamAccumulator.js';
import { ConversationPublicationScheduler } from './ConversationPublicationScheduler.js';
import { ConversationNodeStore, type ConversationNodeSource } from '../store/conversationNodeStore.js';
import type { AssistantStreamFrame } from '../contract/AssistantStreamContract.js';

export type AssistantNodeStatus = 'streaming' | 'completed' | 'interrupted' | 'failed' | 'abandoned';

export interface AssistantNodeState {
  key: string;
  attemptId: string;
  content: string;
  reasoning: string;
  status: AssistantNodeStatus;
  startedAt: number;
  settledAt: number | null;
}

export type AssistantSettlementStatus = 'completed' | 'interrupted' | 'failed';

export type ConversationControllerOptions = {
  scheduler?: ConversationPublicationScheduler;
  /**
   * 每次发布后的回调（frame cadence 或 immediate）：迁移期桥接用——
   * 调用方把 store 快照投影到自己的既有渲染管线（如 ChatPage 的 messages 数组）。
   */
  onPublish?: (controller: ConversationController) => void;
};

export function assistantNodeKey(attemptId: string): string {
  return `assistant:${attemptId}`;
}

export class ConversationController {
  readonly store: ConversationNodeStore<AssistantNodeState>;
  private readonly accumulator: AssistantStreamAccumulator;
  private readonly scheduler: ConversationSchedulerLike;
  private readonly indices = new Map<string, number>();
  private readonly onPublish?: (controller: ConversationController) => void;
  private resyncs = 0;

  constructor(options?: ConversationControllerOptions) {
    this.store = new ConversationNodeStore<AssistantNodeState>();
    this.accumulator = new AssistantStreamAccumulator();
    this.scheduler = options?.scheduler ?? new ConversationPublicationScheduler();
    this.onPublish = options?.onPublish;
  }

  beginTurn(attemptId: string): void {
    this.indices.set(attemptId, 0);
    this.applyFrame({ type: 'start', attemptId });
  }

  acceptDelta(attemptId: string, textDelta: string, reasoningDelta = ''): void {
    if (!textDelta && !reasoningDelta) return;
    const index = this.indices.get(attemptId);
    if (index === undefined) {
      // 未 beginTurn 的 delta：按容错语义先建 attempt（进程内通道不会重放历史）。
      this.beginTurn(attemptId);
    }
    const frameIndex = this.indices.get(attemptId) ?? 0;
    this.indices.set(attemptId, frameIndex + 1);
    this.applyFrame({ type: 'chunk', attemptId, index: frameIndex, textDelta, reasoningDelta });
  }

  settleTurn(
    attemptId: string,
    finalContent: string,
    finalReasoning: string,
    status: AssistantSettlementStatus,
  ): void {
    const index = this.indices.get(attemptId) ?? 0;
    this.applyFrame({
      type: 'end',
      attemptId,
      index,
      outcome: 'settled',
      finalContent,
      // 空 reasoning 视为「沿用流式累积」，避免权威结算清掉已展示的思考过程。
      finalReasoning: finalReasoning || undefined,
      status,
    });
    this.indices.delete(attemptId);
  }

  abandonTurn(attemptId: string, reason?: string): void {
    const index = this.indices.get(attemptId) ?? 0;
    this.applyFrame({ type: 'end', attemptId, index, outcome: 'abandoned', reason });
    this.indices.delete(attemptId);
  }

  /** 流式节点的 per-key 订阅源（React useSyncExternalStore 直接可用）。 */
  nodeSource(attemptId: string): ConversationNodeSource<AssistantNodeState> {
    return this.store.source(assistantNodeKey(attemptId));
  }

  /** 当前流式快照（供非 React 消费方或迁移期桥接读取）。 */
  snapshot(attemptId: string): AssistantStreamSnapshot | null {
    return this.accumulator.snapshot();
  }

  /** 诊断指标：rebaseline 自愈次数（正常应恒为 0）。 */
  get resyncCount(): number {
    return this.resyncs;
  }

  private publishFrame(): void {
    this.scheduler.schedule('frame', () => this.emitPublish());
  }

  private publishImmediate(): void {
    this.scheduler.schedule('immediate', () => this.emitPublish());
  }

  private emitPublish(): void {
    this.store.publish();
    this.onPublish?.(this);
  }

  dispose(): void {
    this.scheduler.dispose();
  }

  private applyFrame(frame: AssistantStreamFrame): void {
    const decision = this.accumulator.acceptFrame(frame);
    const key = assistantNodeKey(frame.attemptId);
    switch (decision.type) {
      case 'accepted': {
        const snap = this.accumulator.snapshot();
        if (!snap) return;
        this.store.upsert({
          key,
          attemptId: frame.attemptId,
          content: snap.content,
          reasoning: snap.reasoning,
          status: 'streaming',
          startedAt: this.startedAt(frame.attemptId),
          settledAt: null,
        });
        this.publishFrame();
        return;
      }
      case 'settled': {
        this.store.upsert({
          key,
          attemptId: frame.attemptId,
          content: decision.content,
          reasoning: decision.reasoning,
          status: decision.status,
          startedAt: this.startedAt(frame.attemptId),
          settledAt: Date.now(),
        });
        // settlement 必须立即 flush，不等帧（规格十六）。
        this.publishImmediate();
        return;
      }
      case 'abandoned': {
        this.store.upsert({
          key,
          attemptId: frame.attemptId,
          content: '',
          reasoning: '',
          status: 'abandoned',
          startedAt: this.startedAt(frame.attemptId),
          settledAt: Date.now(),
        });
        this.publishImmediate();
        return;
      }
      case 'rebaseline': {
        // 进程内有序通道失步 = 适配层缺陷。自愈：保留累积内容、对齐 index、重吸收本帧。
        this.resyncs += 1;
        const rawIndex = (frame as { index?: number }).index;
        this.accumulator.resync(frame.attemptId, typeof rawIndex === 'number' ? rawIndex : 0);
        const second = this.accumulator.acceptFrame(frame);
        if (second.type === 'accepted') {
          const snap = this.accumulator.snapshot();
          if (snap) {
            this.store.upsert({
              key,
              attemptId: frame.attemptId,
              content: snap.content,
              reasoning: snap.reasoning,
              status: 'streaming',
              startedAt: this.startedAt(frame.attemptId),
              settledAt: null,
            });
            this.publishFrame();
          }
        }
        return;
      }
      case 'ignored':
        return;
    }
  }

  private readonly startTimes = new Map<string, number>();

  private startedAt(attemptId: string): number {
    let value = this.startTimes.get(attemptId);
    if (value === undefined) {
      value = Date.now();
      this.startTimes.set(attemptId, value);
    }
    return value;
  }
}

type ConversationSchedulerLike = Pick<ConversationPublicationScheduler, 'schedule' | 'dispose'>;
