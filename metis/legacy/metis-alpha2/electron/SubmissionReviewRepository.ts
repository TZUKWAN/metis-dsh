/**
 * SubmissionReviewRepository — 审稿轮次与审稿意见的持久化（P4）。
 * 风格对齐 SubmissionRepository / JournalProfileRepository：同步 better-sqlite3、
 * 事务写入、防御性默认值（调用方可能绕过 Zod 默认值直传）。
 */
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ReviewRound, ReviewerComment, ReviewCommentPatch, ReviewCommentStatus, SubmissionReviewDecision } from '../engine/submission/SubmissionReviewContract.js';

interface RoundRow {
  id: string; case_id: string; round_no: number; decision: string; received_at: number | null;
  deadline: number | null; decision_letter_text: string; submitted_outcome_version: number | null;
  revised_outcome_version: number | null; response_letter_outcome_id: string | null;
  note: string | null; created_at: number; updated_at: number;
}
interface CommentRow {
  id: string; round_id: string; reviewer_label: string | null; original_text: string | null; normalized_text: string | null;
  category: string; priority: string; status: string; affected_location: string | null;
  before_text: string | null; after_text: string | null; response_text: string | null; created_at: number; updated_at: number;
}

const asRound = (row: RoundRow): ReviewRound => ({
  id: row.id,
  caseId: row.case_id,
  roundNo: row.round_no,
  decision: row.decision as SubmissionReviewDecision,
  receivedAt: row.received_at ?? 0,
  deadline: row.deadline ?? null,
  decisionLetterText: row.decision_letter_text ?? '',
  submittedOutcomeVersion: row.submitted_outcome_version ?? null,
  revisedOutcomeVersion: row.revised_outcome_version ?? null,
  responseLetterOutcomeId: row.response_letter_outcome_id ?? null,
  note: row.note ?? '',
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class SubmissionReviewRepository {
  constructor(private readonly db: Database) {}

  ownsCase(projectId: string, caseId: string): boolean {
    return Boolean(this.db.prepare('SELECT id FROM submission_cases WHERE id = ? AND project_id = ? AND deleted_at IS NULL').get(caseId, projectId));
  }

  createRound(input: {
    projectId: string; caseId: string; decisionLetterText: string;
    decision?: SubmissionReviewDecision; receivedAt?: number; deadline?: number | null;
    comments?: Array<{ reviewerLabel?: string; originalText: string; category?: ReviewerComment['category'] }>;
    submittedOutcomeVersion?: number | null;
  }): ReviewRound {
    if (!this.ownsCase(input.projectId, input.caseId)) throw new Error('submission_case_not_found');
    const now = Date.now();
    const max = this.db.prepare('SELECT COALESCE(MAX(round_no), 0) AS max FROM submission_review_rounds WHERE case_id = ?').get(input.caseId) as { max: number };
    const roundId = 'rev-round-' + randomUUID();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO submission_review_rounds (id,case_id,round_no,decision,received_at,deadline,decision_letter_text,submitted_outcome_version,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(roundId, input.caseId, max.max + 1, input.decision ?? 'unclear', input.receivedAt ?? now, input.deadline ?? null,
          input.decisionLetterText, input.submittedOutcomeVersion ?? null, '', now, now);
      for (const comment of input.comments ?? []) {
        this.insertComment(roundId, comment.reviewerLabel ?? '', comment.originalText, comment.category ?? 'other', now);
      }
    })();
    return this.getRound(roundId)!;
  }

  private insertComment(roundId: string, reviewerLabel: string, originalText: string, category: string, now: number): void {
    this.db.prepare(`INSERT INTO submission_review_comments (id,round_id,reviewer_label,original_text,normalized_text,category,priority,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('rev-cmt-' + randomUUID(), roundId, reviewerLabel, originalText, originalText.slice(0, 500), category, 'medium', 'open', now, now);
  }

  getRound(roundId: string): ReviewRound | undefined {
    const row = this.db.prepare('SELECT * FROM submission_review_rounds WHERE id = ?').get(roundId) as RoundRow | undefined;
    return row ? asRound(row) : undefined;
  }

  listRounds(projectId: string, caseId: string): ReviewRound[] {
    if (!this.ownsCase(projectId, caseId)) return [];
    return (this.db.prepare('SELECT * FROM submission_review_rounds WHERE case_id = ? ORDER BY round_no DESC').all(caseId) as RoundRow[]).map(asRound);
  }

  latestRound(projectId: string, caseId: string): ReviewRound | undefined {
    return this.listRounds(projectId, caseId)[0];
  }

  setRoundRevisedVersion(roundId: string, version: number): void {
    this.db.prepare('UPDATE submission_review_rounds SET revised_outcome_version = ?, updated_at = ? WHERE id = ?').run(version, Date.now(), roundId);
  }

  setRoundResponseLetter(roundId: string, outcomeId: string): void {
    this.db.prepare('UPDATE submission_review_rounds SET response_letter_outcome_id = ?, updated_at = ? WHERE id = ?').run(outcomeId, Date.now(), roundId);
  }

  /** 追加轮次备注（SubmissionDeadlineSync 用 note 存 goal 绑定标记）。 */
  updateNote(roundId: string, note: string): void {
    this.db.prepare('UPDATE submission_review_rounds SET note = ?, updated_at = ? WHERE id = ?').run(note, Date.now(), roundId);
  }

  listComments(roundId: string): ReviewerComment[] {
    return (this.db.prepare('SELECT * FROM submission_review_comments WHERE round_id = ? ORDER BY created_at ASC').all(roundId) as CommentRow[]).map((row) => ({
      id: row.id,
      roundId: row.round_id,
      reviewerLabel: row.reviewer_label ?? '',
      originalText: row.original_text ?? '',
      normalizedText: row.normalized_text ?? '',
      category: (row.category || 'other') as ReviewerComment['category'],
      priority: (row.priority || 'medium') as ReviewerComment['priority'],
      status: (row.status || 'open') as ReviewCommentStatus,
      affectedLocation: row.affected_location ?? '',
      beforeText: row.before_text ?? '',
      afterText: row.after_text ?? '',
      responseText: row.response_text ?? '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  updateComment(projectId: string, commentId: string, patch: ReviewCommentPatch): ReviewerComment | undefined {
    const row = this.db.prepare(
      `SELECT c.* FROM submission_review_comments c JOIN submission_review_rounds r ON r.id = c.round_id JOIN submission_cases k ON k.id = r.case_id WHERE c.id = ? AND k.project_id = ?`,
    ).get(commentId, projectId) as CommentRow | undefined;
    if (!row) return undefined;
    const sets: string[] = [];
    const values: unknown[] = [];
    const assign = (column: string, value: unknown): void => { sets.push(`${column} = ?`); values.push(value); };
    if (patch.category !== undefined) assign('category', patch.category);
    if (patch.priority !== undefined) assign('priority', patch.priority);
    if (patch.status !== undefined) assign('status', patch.status);
    if (patch.affectedLocation !== undefined) assign('affected_location', patch.affectedLocation);
    if (patch.beforeText !== undefined) assign('before_text', patch.beforeText);
    if (patch.afterText !== undefined) assign('after_text', patch.afterText);
    if (patch.responseText !== undefined) assign('response_text', patch.responseText);
    if (sets.length === 0) return undefined;
    assign('updated_at', Date.now());
    values.push(commentId);
    this.db.prepare(`UPDATE submission_review_comments SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.listComments(row.round_id).find((comment) => comment.id === commentId);
  }
}
