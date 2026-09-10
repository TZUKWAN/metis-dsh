/**
 * SubmissionMailWatcher / SubmissionDeadlineSync 测试（P4 后台监听 + Goal 打通）。
 *
 * 覆盖：
 *  - Watcher：周期触发、防重入、单目标失败隔离与指数退避、仅新邮件触发 notify、
 *    start/stop 清理定时器；
 *  - DeadlineSync：创建 Goal 并回写绑定、幂等（二次调用 already_synced）、
 *    无 deadline 不建、Goal 服务失败如实报错。
 */
/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubmissionDeadlineSync } from '../../electron/SubmissionDeadlineSync.js';
import { SubmissionMailWatcher, type WatcherSyncResult, type WatcherTarget } from '../../electron/SubmissionMailWatcher.js';
import type { ReviewRound } from '../../engine/submission/SubmissionReviewContract.js';

// ─── Watcher ────────────────────────────────────────────────

function makeWatcher(targets: WatcherTarget[], syncResults: Map<string, WatcherSyncResult | (() => Promise<WatcherSyncResult>)>, notify: (n: unknown) => void) {
  return new SubmissionMailWatcher({
    listTargets: () => targets,
    sync: async (target) => {
      const entry = syncResults.get(target.accountId);
      if (typeof entry === 'function') return await entry();
      return entry ?? { ok: false };
    },
    notify,
  });
}

const okRecords = [{ id: 'scr-1', subject: 'Decision letter', classification: 'decision_letter' as const, caseId: null }];

describe('SubmissionMailWatcher', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('tick 有新邮件时触发 notify，无新邮件不触发', async () => {
    const notifications: unknown[] = [];
    let round = 0;
    const watcher = makeWatcher(
      [{ projectId: 'p1', accountId: 'a1' }],
      new Map([['a1', () => Promise.resolve({ ok: true, newRecords: (round += 1) === 1 ? okRecords : [] })]]),
      (n) => notifications.push(n),
    );
    expect(await watcher.tick()).toBe(true);
    expect(notifications).toHaveLength(1);
    expect(await watcher.tick()).toBe(false); // 第二轮无新邮件
    expect(notifications).toHaveLength(1);
  });

  it('单目标失败隔离：坏账户不影响好账户；连续失败后进入退避', async () => {
    const notifications: unknown[] = [];
    let badCalls = 0;
    const watcher = makeWatcher(
      [{ projectId: 'p1', accountId: 'bad' }, { projectId: 'p1', accountId: 'good' }],
      new Map([
        ['bad', () => { badCalls += 1; return Promise.resolve({ ok: false }); }],
        ['good', () => Promise.resolve({ ok: true, newRecords: okRecords })],
      ]),
      (n) => notifications.push(n),
    );
    // 第 1、2 轮：bad 失败但 good 正常。
    await watcher.tick();
    await watcher.tick();
    expect(badCalls).toBe(2);
    // 第 3 轮起 bad 连续失败达阈值 → 退避，不再被调用。
    await watcher.tick();
    await watcher.tick();
    await watcher.tick();
    expect(badCalls).toBe(3);
    // good 每轮都有新邮件通知（测试 stub 固定返回），不受坏账户影响。
    expect(notifications.length).toBeGreaterThanOrEqual(3);
  });

  it('防重入：上一轮未完成时 tick 直接跳过', async () => {
    let release!: (value: WatcherSyncResult) => void;
    const gate = new Promise<WatcherSyncResult>((resolve) => { release = resolve; });
    const watcher = makeWatcher(
      [{ projectId: 'p1', accountId: 'slow' }],
      new Map([['slow', () => gate]]),
      () => {},
    );
    const first = watcher.tick();
    expect(await watcher.tick()).toBe(false);
    release({ ok: true, newRecords: [] });
    expect(await first).toBe(false);
  });

  it('start/stop 管理定时器；dispose 后不再触发', async () => {
    const notifications: unknown[] = [];
    const watcher = makeWatcher(
      [{ projectId: 'p1', accountId: 'a1' }],
      new Map([['a1', { ok: true, newRecords: okRecords }]]),
      (n) => notifications.push(n),
    );
    watcher.start();
    expect(watcher.isRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    expect(notifications).toHaveLength(1);
    watcher.dispose();
    expect(watcher.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(notifications).toHaveLength(1);
  });
});

// ─── DeadlineSync ───────────────────────────────────────────

function fakeRound(overrides: Partial<ReviewRound>): ReviewRound {
  return {
    id: 'round-1', caseId: 'case-1', roundNo: 1, decision: 'major_revision',
    receivedAt: 1_760_000_000_000, deadline: null, decisionLetterText: '',
    submittedOutcomeVersion: null, revisedOutcomeVersion: null,
    responseLetterOutcomeId: null, note: '', createdAt: 1, updatedAt: 1,
    ...overrides,
  };
}

describe('SubmissionDeadlineSync', () => {
  function assemble(round: ReviewRound, goalResult: { id: string } | null) {
    const deadlineSync = new SubmissionDeadlineSync({
      reviewRepository: { getRound: () => round, updateNote: () => {} } as never,
      submissionRepository: {
        getCase: () => ({ id: 'case-1', targetJournalName: 'Journal of Testing', title: 'Test manuscript' }),
        addEvent: () => undefined,
      } as never,
      createGoal: () => goalResult,
    });
    return { deadlineSync };
  }

  it('有 deadline：创建 Goal、回写绑定、追加事件', () => {
    const createdGoals: string[] = [];
    const deadlineSync = new SubmissionDeadlineSync({
      reviewRepository: { getRound: () => fakeRound({ deadline: Date.UTC(2026, 10, 20) }), updateNote: () => {} } as never,
      submissionRepository: {
        getCase: () => ({ id: 'case-1', targetJournalName: 'Journal of Testing', title: 'Test manuscript' }),
        addEvent: (_p: string, input: { description?: string }) => { createdGoals.push(input.description ?? ''); return undefined; },
      } as never,
      createGoal: (description: string) => { createdGoals.push(description); return { id: 'goal-9' }; },
    });
    const result = deadlineSync.syncRoundToGoal({ projectId: 'p1', caseId: 'case-1', roundId: 'round-1' });
    expect(result).toMatchObject({ ok: true, goalId: 'goal-9' });
    expect(createdGoals.some((text) => text.includes('2026-11-20'))).toBe(true);
    expect(createdGoals.some((text) => text.includes('Journal of Testing'))).toBe(true);
  });

  it('幂等：已绑定 goal 的轮次不重复建', () => {
    const { deadlineSync } = assemble(fakeRound({ deadline: Date.UTC(2026, 10, 20), note: 'goal:goal-1' }), { id: 'goal-2' });
    expect(deadlineSync.syncRoundToGoal({ projectId: 'p1', caseId: 'case-1', roundId: 'round-1' }))
      .toMatchObject({ ok: false, code: 'already_synced' });
  });

  it('无 deadline 不同步；Goal 失败如实报错；round 不存在报 round_not_found', () => {
    const noDeadline = assemble(fakeRound({ deadline: null }), { id: 'g' });
    expect(noDeadline.deadlineSync.syncRoundToGoal({ projectId: 'p1', caseId: 'case-1', roundId: 'round-1' }))
      .toMatchObject({ ok: false, code: 'no_deadline' });

    const failingGoal = assemble(fakeRound({ deadline: Date.UTC(2026, 10, 20) }), null);
    expect(failingGoal.deadlineSync.syncRoundToGoal({ projectId: 'p1', caseId: 'case-1', roundId: 'round-1' }))
      .toMatchObject({ ok: false, code: 'goal_create_failed' });

    const missingRound = new SubmissionDeadlineSync({
      reviewRepository: { getRound: () => undefined } as never,
      submissionRepository: { getCase: () => ({}), addEvent: () => undefined } as never,
      createGoal: () => ({ id: 'g' }),
    });
    expect(missingRound.syncRoundToGoal({ projectId: 'p1', caseId: 'case-1', roundId: 'round-1' }))
      .toMatchObject({ ok: false, code: 'round_not_found' });
  });
});
