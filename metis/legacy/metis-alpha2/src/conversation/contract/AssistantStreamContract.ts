/**
 * Assistant Stream Contract（2026-09-05 Conversation Streaming P0，Phase 1）。
 *
 * 帧模型参考 DeepSeek Harness packages/api/session-controller/src/client/sessions/assistant-stream.ts，
 * 按 METIS 现实裁剪：METIS 的实时通道是进程内 IPC（chat:stream-chunk → renderer），
 * 不存在跨进程重连窗口，因此不需要 DSH 的分数 seq / pending-by-seq / baseline 重放；
 * 保留其本质不变量：attempt 稳定身份 + dense chunk index 校验 + settle 一次性 swap
 * + abandonment 撤销 + 失步 rebaseline。
 * 持久层依旧只落每回合一条完整 assistant 消息（ChatTurnService），流式帧零持久化。
 */

export interface AssistantStreamStartFrame {
  type: 'start';
  /** 一次真实模型 attempt 的稳定身份（METIS 现阶段 = chat turnId，禁止用 Date.now()/数组下标充当）。 */
  attemptId: string;
}

export interface AssistantStreamChunkFrame {
  type: 'chunk';
  attemptId: string;
  /** dense index：从 0 连续递增；断裂即失步（触发 rebaseline 决策）。 */
  index: number;
  textDelta?: string;
  reasoningDelta?: string;
}

export type AssistantStreamEndFrame = {
  type: 'end';
  attemptId: string;
  index: number;
} & (
  | {
      outcome: 'settled';
      /**
       * 权威全文：以持久层写入的最终内容为准。settle 时直接覆盖流式累积内容
       * （DSH 的 settlement swap——杜绝「transient 尾巴 + 最终消息」双份渲染）。
       */
      finalContent: string;
      finalReasoning?: string;
      status: 'completed' | 'interrupted' | 'failed';
    }
  | {
      outcome: 'abandoned';
      /** 无法结算的异常路径：该 attempt 的全部 transient 呈现应被撤销。 */
      reason?: string;
    }
);

export type AssistantStreamFrame =
  | AssistantStreamStartFrame
  | AssistantStreamChunkFrame
  | AssistantStreamEndFrame;

/** Accumulator 对每帧的发布决策；消费方据此驱动 node store 与 publication scheduler。 */
export type AssistantStreamDecision =
  | {
      type: 'accepted';
      attemptId: string;
      textDelta: string;
      reasoningDelta: string;
    }
  | {
      type: 'settled';
      attemptId: string;
      content: string;
      reasoning: string;
      status: 'completed' | 'interrupted' | 'failed';
    }
  | { type: 'abandoned'; attemptId: string }
  | { type: 'rebaseline'; attemptId: string; reason: string }
  | { type: 'ignored'; attemptId?: string; reason: string };
