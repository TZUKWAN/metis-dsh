/**
 * 2026-09-05 metis 无声卡死修复的回归测试。
 *
 * 场景：LLM 请求在 RateLimiter 排队时用户中断了 run（AbortSignal）。
 * 修复前：排队项不监听取消信号，会作为幽灵条目留在队列里占位，
 * 直到 30 分钟队列超时才 reject——后续请求全部被它堵住。
 * 修复后：abort 立即把排队项移出队列并 reject。
 */

import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../engine/core/RateLimiter.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('RateLimiter cancellation', () => {
  it('rejects a queued item immediately when its abort signal fires', async () => {
    const limiter = new RateLimiter(1);
    const gate = deferred();

    const first = limiter.execute(() => gate.promise);
    const controller = new AbortController();
    const second = limiter.execute(async () => 'second', controller.signal);

    await flush();
    expect(limiter.active).toBe(1);
    expect(limiter.pending).toBe(2);

    controller.abort();
    await expect(second).rejects.toThrow();
    // 排队项已被移出队列：只剩第一个在飞的请求。
    expect(limiter.pending).toBe(1);

    gate.resolve();
    await expect(first).resolves.toBeUndefined();
    expect(limiter.pending).toBe(0);
  });

  it('rejects immediately when the signal is already aborted before queueing', async () => {
    const limiter = new RateLimiter(1);
    const gate = deferred();
    const first = limiter.execute(() => gate.promise);

    const controller = new AbortController();
    controller.abort();
    await expect(limiter.execute(async () => 'never', controller.signal)).rejects.toThrow();
    expect(limiter.pending).toBe(1);

    gate.resolve();
    await first;
  });

  it('lets later queued items start after an aborted item leaves the queue', async () => {
    const limiter = new RateLimiter(1);
    const gate = deferred();

    const first = limiter.execute(() => gate.promise);
    const controller = new AbortController();
    const cancelled = limiter.execute(async () => 'cancelled-item', controller.signal);
    const third = limiter.execute(async () => 'third');

    await flush();
    controller.abort();
    await expect(cancelled).rejects.toThrow();

    gate.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(third).resolves.toBe('third');
    expect(limiter.pending).toBe(0);
    expect(limiter.active).toBe(0);
  });
});
