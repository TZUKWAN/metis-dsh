/**
 * SubmissionMailWatcher — 投稿邮件后台常驻监听（main 进程）。
 *
 * 职责：周期性对所有（项目 × 邮箱账户）目标触发既有 SubmissionMailService.syncAccount，
 * 把新落库邮件（尤其是决定信类）经 notify 回调推给渲染端。
 *
 * 边界与诚实原则：
 *  - 本服务不碰 IMAP 细节、不做分类/关联——全部复用 syncAccount，避免两套逻辑；
 *  - 单目标失败隔离并指数退避：连续失败 ≥3 次后跳过若干轮，防止坏账户每 10 分钟
 *    拖一轮同步；恢复成功即清零；
 *  - 防重入：上一轮未跑完时本轮直接跳过（IMAP 同步可能慢于间隔）；
 *  - 不自动推进任何状态机——通知只是事实播报。
 */
import type { MailboxAccount } from '../engine/mail/MailboxPool.js';
import type { CorrespondenceClassification } from '../engine/submission/SubmissionCorrespondenceContract.js';

export interface WatcherTarget {
  projectId: string;
  accountId: string;
}

export interface WatcherNotificationItem {
  projectId: string;
  accountId: string;
  records: Array<{ id: string; subject: string; classification: CorrespondenceClassification; caseId: string | null }>;
}

export interface WatcherNotification {
  at: number;
  items: WatcherNotificationItem[];
}

export type WatcherSyncResult = { ok: true; newRecords: Array<{ id: string; subject: string; classification: CorrespondenceClassification; caseId: string | null }> } | { ok: false };

/** 决定信类分类：新邮件通知里单独标出（渲染端可高亮「收到决定信」）。 */
export const WATCHER_DECISION_CLASSIFICATIONS: ReadonlySet<CorrespondenceClassification> = new Set([
  'decision_letter', 'revision_request', 'acceptance', 'rejection',
]);

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
/** 连续失败达到该值后开始退避。 */
const FAILURE_BACKOFF_THRESHOLD = 3;
/** 退避轮数（连续失败越多跳过越久，上限 6 轮 ≈ 1 小时 @10min）。 */
const BACKOFF_TICKS_BASE = 2;

export class SubmissionMailWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  /** accountId → 连续失败次数。 */
  private readonly failures = new Map<string, number>();
  /** accountId → 剩余退避轮数。 */
  private readonly backoff = new Map<string, number>();

  constructor(private readonly options: {
    listTargets(): WatcherTarget[];
    sync(target: WatcherTarget): Promise<WatcherSyncResult>;
    notify(notification: WatcherNotification): void;
    intervalMs?: number;
    logger?: { warn(message: string): void };
  }) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    // 不阻止进程退出。
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void { this.stop(); }

  isRunning(): boolean { return this.timer !== null; }

  /** 手动触发一轮（测试与 IPC 立即同步用）；返回是否有新邮件通知。 */
  async tick(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      const items: WatcherNotificationItem[] = [];
      for (const target of this.options.listTargets()) {
        const remaining = this.backoff.get(target.accountId) ?? 0;
        if (remaining > 0) {
          this.backoff.set(target.accountId, remaining - 1);
          continue;
        }
        const result = await this.options.sync(target);
        if (!result.ok) {
          const count = (this.failures.get(target.accountId) ?? 0) + 1;
          this.failures.set(target.accountId, count);
          if (count >= FAILURE_BACKOFF_THRESHOLD) {
            const ticks = Math.min(BACKOFF_TICKS_BASE * (count - FAILURE_BACKOFF_THRESHOLD + 1), 6);
            this.backoff.set(target.accountId, ticks);
            this.options.logger?.warn(`[SubmissionMailWatcher] 账户 ${target.accountId} 连续失败 ${count} 次，退避 ${ticks} 轮`);
          }
          continue;
        }
        this.failures.delete(target.accountId);
        this.backoff.delete(target.accountId);
        if (result.newRecords.length > 0) items.push({ projectId: target.projectId, accountId: target.accountId, records: result.newRecords });
      }
      if (items.length === 0) return false;
      this.options.notify({ at: Date.now(), items });
      return true;
    } finally {
      this.busy = false;
    }
  }

  /** 目标构造辅助：全部项目 × 全部账户（接线层按需收窄）。 */
  static allProjectAccounts(projects: string[], accounts: MailboxAccount[]): WatcherTarget[] {
    return projects.flatMap((projectId) => accounts.map((account) => ({ projectId, accountId: account.id })));
  }
}
