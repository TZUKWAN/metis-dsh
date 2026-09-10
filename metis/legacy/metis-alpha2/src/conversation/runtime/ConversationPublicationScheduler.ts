/**
 * Conversation Publication Scheduler（2026-09-05 Conversation Streaming P0，Phase 1）。
 *
 * 对应 DeepSeek Harness ui-conversation/assembly.ts 的 BoundConversation.publish 本质：
 * 数据更新与 React 快照发布解耦——
 * - none：只更新 accumulator，不发布；
 * - frame：高频流（text/reasoning delta）跨 framesPerPublish 个绘制机会后合并发布一次
 *   （DSH 默认 3 帧，约 50ms@60fps）；挂起期间到达的新请求直接丢弃（单飞合并）；
 * - immediate：结构性事件（工具开始/结果、结算、中断、错误）抢占——取消挂起的帧并同步 flush，
 *   保证操作状态及时出现、settlement 不等帧。
 *
 * rAF 通过依赖注入提供（默认 window.requestAnimationFrame），便于在 node 测试中驱动。
 */

export type PublicationMode = 'none' | 'frame' | 'immediate';

export interface PublicationSchedulerOptions {
  raf?: (callback: () => void) => unknown;
  cancelAnimationFrame?: (handle: unknown) => void;
  /** 一次发布跨越的绘制机会数，默认 3（DSH 同款：cross three paint opportunities）。 */
  framesPerPublish?: number;
}

export class ConversationPublicationScheduler {
  private readonly raf: (callback: () => void) => unknown;
  private readonly cancelAnimationFrame: (handle: unknown) => void;
  private readonly framesPerPublish: number;
  private frameHandle: unknown = null;
  private depth = 0;
  private pendingFlush: (() => void) | null = null;

  /** 开发诊断指标（规格六十五）：不喂给普通 UI。 */
  publishedCount = 0;
  coalescedCount = 0;

  constructor(options?: PublicationSchedulerOptions) {
    this.raf = options?.raf ?? ((cb) => window.requestAnimationFrame(cb));
    this.cancelAnimationFrame = options?.cancelAnimationFrame ?? ((handle) => window.cancelAnimationFrame(handle as number));
    this.framesPerPublish = Math.max(1, options?.framesPerPublish ?? 3);
  }

  /** 是否有挂起中的合并窗口（测试与诊断用）。 */
  isFramePending(): boolean {
    return this.frameHandle !== null;
  }

  schedule(mode: PublicationMode, flush: () => void): void {
    if (mode === 'none') return;
    if (mode === 'immediate') {
      // 抢占：取消挂起的帧，同步 flush 最新累积状态（settlement 不等帧）。
      this.cancelPending();
      flush();
      this.publishedCount += 1;
      return;
    }
    // frame 模式：单飞合并——已有挂起计划时丢弃本次请求（accumulator 里已是最新累积）。
    if (this.frameHandle !== null) {
      this.coalescedCount += 1;
      return;
    }
    this.depth = 0;
    const advance = (): void => {
      this.depth += 1;
      if (this.depth < this.framesPerPublish) {
        this.frameHandle = this.raf(advance);
        return;
      }
      this.frameHandle = null;
      this.depth = 0;
      const flushFn = this.pendingFlush;
      this.pendingFlush = null;
      if (flushFn) {
        flushFn();
        this.publishedCount += 1;
      }
    };
    this.pendingFlush = flush;
    this.frameHandle = this.raf(advance);
  }

  /** 丢弃挂起的发布计划（ dispos/rebaseline 时用）。注意：不补偿 flush——调用方决定是否立即 flush。 */
  cancelPending(): void {
    if (this.frameHandle !== null) {
      this.cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.depth = 0;
    this.pendingFlush = null;
  }

  dispose(): void {
    this.cancelPending();
  }
}
