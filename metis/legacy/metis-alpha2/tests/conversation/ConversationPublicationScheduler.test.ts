/**
 * ConversationPublicationScheduler 回归测试（2026-09-05 P0 Phase 1）。
 * 验证：frame 模式单飞合并（100 个请求只 flush 一次）、immediate 抢占、publishedCount 指标。
 */

import { describe, it, expect } from 'vitest';
import { ConversationPublicationScheduler } from '../../src/conversation/runtime/ConversationPublicationScheduler.js';

/** 手动驱动的 rAF 测试替身：返回单调句柄，按句柄顺序回调。 */
class ManualRaf {
  private nextHandle = 1;
  private queue = new Map<number, () => void>();

  readonly raf = (cb: () => void): number => {
    const handle = this.nextHandle++;
    this.queue.set(handle, cb);
    return handle;
  };

  readonly cancel = (handle: unknown): void => {
    this.queue.delete(handle as number);
  };

  /** 执行当前挂起的全部回调（一帧）。返回执行的回调数。 */
  tick(): number {
    const batch = [...this.queue.values()];
    this.queue.clear();
    for (const cb of batch) cb();
    return batch.length;
  }

  get pending(): number {
    return this.queue.size;
  }
}

describe('ConversationPublicationScheduler', () => {
  it('coalesces a burst of frame-mode schedules into a single flush after 3 frames', () => {
    const raf = new ManualRaf();
    const scheduler = new ConversationPublicationScheduler({ raf: raf.raf, cancelAnimationFrame: raf.cancel });
    let flushes = 0;
    const flush = (): void => {
      flushes += 1;
    };

    for (let index = 0; index < 100; index += 1) {
      scheduler.schedule('frame', flush);
    }
    expect(raf.pending).toBe(1);
    expect(flushes).toBe(0);
    expect(scheduler.coalescedCount).toBe(99);

    raf.tick();
    raf.tick();
    expect(flushes).toBe(0);
    raf.tick();
    expect(flushes).toBe(1);
    expect(scheduler.publishedCount).toBe(1);

    scheduler.dispose();
  });

  it('schedules a new coalescing window after each publish', () => {
    const raf = new ManualRaf();
    const scheduler = new ConversationPublicationScheduler({ raf: raf.raf, cancelAnimationFrame: raf.cancel });
    let flushes = 0;

    scheduler.schedule('frame', (): void => {
      flushes += 1;
    });
    raf.tick();
    raf.tick();
    raf.tick();
    expect(flushes).toBe(1);

    scheduler.schedule('frame', (): void => {
      flushes += 2;
    });
    raf.tick();
    raf.tick();
    raf.tick();
    expect(flushes).toBe(3);
    expect(scheduler.publishedCount).toBe(2);

    scheduler.dispose();
  });

  it('immediate publish preempts a pending frame window and cancels it', () => {
    const raf = new ManualRaf();
    const scheduler = new ConversationPublicationScheduler({ raf: raf.raf, cancelAnimationFrame: raf.cancel });
    const order: string[] = [];

    scheduler.schedule('frame', (): void => {
      order.push('frame');
    });
    expect(scheduler.isFramePending()).toBe(true);

    scheduler.schedule('immediate', (): void => {
      order.push('immediate');
    });
    expect(order).toEqual(['immediate']);
    expect(scheduler.isFramePending()).toBe(false);

    const executed = raf.tick();
    expect(executed).toBe(0);
    expect(order).toEqual(['immediate']);

    scheduler.dispose();
  });

  it('none schedules nothing', () => {
    const raf = new ManualRaf();
    const scheduler = new ConversationPublicationScheduler({ raf: raf.raf, cancelAnimationFrame: raf.cancel });
    let flushes = 0;

    scheduler.schedule('none', (): void => {
      flushes += 1;
    });

    expect(flushes).toBe(0);
    expect(raf.pending).toBe(0);
    expect(scheduler.publishedCount).toBe(0);
  });

  it('sustains publication-count ceiling under a continuous 100k-chunk storm', () => {
    const raf = new ManualRaf();
    const scheduler = new ConversationPublicationScheduler({ raf: raf.raf, cancelAnimationFrame: raf.cancel });
    let flushes = 0;

    for (let chunkIndex = 0; chunkIndex < 100_000; chunkIndex += 1) {
      scheduler.schedule('frame', (): void => {
        flushes += 1;
      });
      if (chunkIndex % 3 === 0) raf.tick();
    }
    raf.tick();
    raf.tick();
    raf.tick();

    expect(flushes).toBe(scheduler.publishedCount);
    expect(scheduler.publishedCount).toBeGreaterThan(0);
    // 不变式：每次 flush 需要消耗 framesPerPublish 个绘制机会，
    // 因此发布次数绝不能超过 tick 数 / 3 + 1（单飞合并的数学上界）。
    const ticks = Math.ceil(100_000 / 3);
    expect(scheduler.publishedCount).toBeLessThanOrEqual(Math.ceil(ticks / 3) + 1);
    scheduler.dispose();
  });
});
