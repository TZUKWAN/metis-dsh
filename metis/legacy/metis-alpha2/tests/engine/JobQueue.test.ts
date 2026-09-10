/**
 * JobQueue — 后台作业队列核心逻辑（T10）。
 */

import { describe, expect, it, vi } from 'vitest';
import { JobQueue, JobCancelledError, type JobRecord } from '../../engine/runtime/JobQueue.js';

describe('JobQueue', () => {
  it('按 kind 执行 handler 并产出 done 记录', async () => {
    const onChanged = vi.fn();
    const queue = new JobQueue({ onChanged });
    queue.registerHandler({
      kind: 'double',
      run: async ({ job }) => (job.payload as number) * 2,
    });
    const job = queue.enqueue('double', '翻倍', 21);
    expect(job).not.toBeNull();
    await vi.waitFor(() => {
      expect(queue.list()[0]!.status).toBe('done');
    });
    expect(queue.list()[0]!.result).toBe(42);
    expect(queue.list()[0]!.progress).toBe(100);
    expect(onChanged).toHaveBeenCalled();
  });

  it('handler 抛错时作业标记 failed 并携带错误信息', async () => {
    const queue = new JobQueue({ onChanged: () => {} });
    queue.registerHandler({
      kind: 'boom',
      run: async () => { throw new Error('kaboom'); },
    });
    queue.enqueue('boom', '爆炸', {});
    await vi.waitFor(() => {
      expect(queue.list()[0]!.status).toBe('failed');
    });
    expect(queue.list()[0]!.error).toContain('kaboom');
  });

  it('running 作业的取消请求令 handler 收到取消信号', async () => {
    const queue = new JobQueue({ onChanged: () => {} });
    queue.registerHandler({
      kind: 'slow',
      run: async (ctx) => {
        ctx.reportProgress(30);
        queue.cancel(ctx.job.id);
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (ctx.isCancelled()) throw new JobCancelledError();
        return 'finished';
      },
    });
    const job = queue.enqueue('slow', '慢任务', {})!;
    await vi.waitFor(() => {
      expect(queue.list().find((j) => j.id === job.id)!.status).toBe('cancelled');
    });
  });

  it('failed 作业可重试并成功', async () => {
    let attempt = 0;
    const queue = new JobQueue({ onChanged: () => {} });
    queue.registerHandler({
      kind: 'flaky',
      run: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('first try fails');
        return 'ok';
      },
    });
    const job = queue.enqueue('flaky', '不稳定', {})!;
    await vi.waitFor(() => {
      expect(queue.list().find((j) => j.id === job.id)!.status).toBe('failed');
    });
    queue.retry(job.id);
    await vi.waitFor(() => {
      expect(queue.list().find((j) => j.id === job.id)!.status).toBe('done');
    });
    expect(queue.list().find((j) => j.id === job.id)!.result).toBe('ok');
  });

  it('restore 把 running/queued 作业重新排队并保留断点', async () => {
    let sawCheckpoint: unknown = null;
    const queue = new JobQueue({ onChanged: () => {} });
    queue.registerHandler({
      kind: 'resumable',
      run: async (ctx) => {
        sawCheckpoint = ctx.job.checkpoint;
        ctx.reportProgress(100, 'resumed');
        return 'done';
      },
    });
    const record: JobRecord = {
      id: 'job-restore-1',
      kind: 'resumable',
      label: '恢复任务',
      payload: {},
      status: 'running',
      progress: 60,
      progressNote: '',
      error: null,
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
      finishedAt: null,
      checkpoint: { doneIds: ['a', 'b'] },
      result: null,
    };
    queue.restore([record]);
    await vi.waitFor(() => {
      expect(queue.list()[0]!.status).toBe('done');
    });
    expect(queue.restoredIds.has('job-restore-1')).toBe(true);
    expect(sawCheckpoint).toEqual({ doneIds: ['a', 'b'] });
  });

  it('未注册 kind 的作业不入队', () => {
    const queue = new JobQueue({ onChanged: () => {} });
    expect(queue.enqueue('unknown-kind', 'x', {})).toBeNull();
  });

  it('进度上报钳制在 0-100', async () => {
    const queue = new JobQueue({ onChanged: () => {} });
    queue.registerHandler({
      kind: 'progress',
      run: async (ctx) => {
        ctx.reportProgress(150, '超界');
        ctx.reportProgress(-5, '负数');
        return null;
      },
    });
    const job = queue.enqueue('progress', '进度', {})!;
    await vi.waitFor(() => {
      expect(queue.list().find((j) => j.id === job.id)!.status).toBe('done');
    });
    expect(job.progress).toBe(100);
  });
});
