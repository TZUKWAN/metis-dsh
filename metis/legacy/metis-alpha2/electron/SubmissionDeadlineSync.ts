/**
 * SubmissionDeadlineSync — 返修截止日期打通 Goal/TaskBoard（刘总需求第 38 条）。
 *
 * 职责：Decision Letter 解析出的 revision deadline 已存 submission_review_rounds；
 * 本服务把「有截止日期的审稿轮次」同步为一条 Goal（METIS 现有任务系统，
 * 复用 goalEngine.createGoal，绝不另建第二套待办）。
 *
 * 诚实边界：
 *  - Goal 模型没有独立的截止日期字段，日期写入描述文本（如「返修截止：2026-11-20」），
 *    不伪造结构化字段；
 *  - 幂等：round 已绑定 goalId 时直接返回，不重复创建；
 *  - 无 deadline 的轮次不同步；Goal 创建失败如实返回错误，不假装成功。
 */
import type { SubmissionReviewRepository } from './SubmissionReviewRepository.js';
import type { SubmissionRepository } from './SubmissionRepository.js';

export type DeadlineSyncResult =
  | { ok: true; goalId: string; created: boolean }
  | { ok: false; code: 'round_not_found' | 'no_deadline' | 'already_synced' | 'goal_create_failed' };

export class SubmissionDeadlineSync {
  constructor(private readonly options: {
    reviewRepository: SubmissionReviewRepository;
    submissionRepository: SubmissionRepository;
    /** 与 goal:create IPC 同一底层（goalEngine.createGoal）。 */
    createGoal(description: string, context?: string, projectId?: string): { id: string } | null;
    /** round 绑定 goalId 的回写（仓储缺省无此列时的注入点）。 */
    bindGoalId?(roundId: string, goalId: string): void;
    logger?: { warn(message: string): void };
  }) {}

  /**
   * 为指定审稿轮次同步一条返修 Goal。幂等：已绑定则返回 already_synced
   * （调用方可用 getRound 查 responseLetterOutcomeId 同列的 goal 绑定值）。
   */
  syncRoundToGoal(input: { projectId: string; caseId: string; roundId: string }): DeadlineSyncResult {
    const round = this.options.reviewRepository.getRound(input.roundId);
    if (!round || round.caseId !== input.caseId) return { ok: false, code: 'round_not_found' };
    if (round.deadline === null) return { ok: false, code: 'no_deadline' };
    if (round.note.includes('goal:')) return { ok: false, code: 'already_synced' };

    const submissionCase = this.options.submissionRepository.getCase(input.projectId, input.caseId);
    if (!submissionCase) return { ok: false, code: 'round_not_found' };

    const dateText = new Date(round.deadline).toISOString().slice(0, 10);
    const journal = submissionCase.targetJournalName.trim() || '目标期刊';
    const description = `返修截止：${dateText}｜${journal}｜${submissionCase.title.slice(0, 80)}（第 ${round.roundNo} 轮审稿）`;
    const goal = this.options.createGoal(description, `来源：投稿 Case ${input.caseId} 审稿轮次 ${input.roundId}`, input.projectId);
    if (!goal || !goal.id) return { ok: false, code: 'goal_create_failed' };

    // 回写绑定：优先注入的 bindGoalId（正式列），否则记入 note（幂等标记 + 可读溯源）。
    const marker = `${round.note ? round.note + ' ' : ''}goal:${goal.id}`;
    try {
      if (this.options.bindGoalId) this.options.bindGoalId(input.roundId, goal.id);
      else this.options.reviewRepository.updateNote(input.roundId, marker.slice(0, 500));
    } catch (error) {
      this.options.logger?.warn?.(`[SubmissionDeadlineSync] 回写绑定失败：${error instanceof Error ? error.message : String(error)}`);
    }

    this.options.submissionRepository.addEvent(input.projectId, {
      caseId: input.caseId,
      type: 'revision_deadline_synced',
      source: 'system',
      actor: 'deadline-sync',
      description: `返修截止 ${dateText} 已同步到任务板`,
      metadata: { roundId: input.roundId, goalId: goal.id },
    });
    return { ok: true, goalId: goal.id, created: true };
  }
}
