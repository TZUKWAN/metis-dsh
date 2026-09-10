/**
 * SubmissionReview 域测试（P4）：Decision Letter 确定性拆解、
 * 轮次/意见持久化往返（原文逐字保留）、Response to Reviewers 汇总与占位。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import { SubmissionRepository } from '../../electron/SubmissionRepository.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';
import { SubmissionReviewRepository } from '../../electron/SubmissionReviewRepository.js';
import { SubmissionReviewService } from '../../electron/SubmissionReviewService.js';

const LETTER = `Dear Author,

We have completed the review of your manuscript. The decision is major revision.
Please resubmit your revised manuscript by 20 November 2026.

Editor comments: Please address the framing concerns.

Reviewer #1
1. The literature review misses recent studies. Please expand section 2.
2. Table 3 needs clearer column headers.

Reviewer #2
The theoretical contribution should be stated explicitly at the end of the introduction.
`;

function seed(db: Database.Database): void {
  db.prepare("INSERT INTO projects (id,title,created_at,updated_at) VALUES ('p1','项目一',1,1)").run();
  db.prepare("INSERT INTO outcomes (id,project_id,title,kind,status,current_version,created_at,updated_at) VALUES ('out-1','p1','论文一','word','draft',2,1,1)").run();
  db.prepare("INSERT INTO outcome_versions (outcome_id,version,content,content_hash,note,created_by,created_at) VALUES ('out-1',1,'{}','h','创建','human',1)").run();
  db.prepare("INSERT INTO outcome_versions (outcome_id,version,content,content_hash,note,created_by,created_at) VALUES ('out-1',2,'{}','h2','修改','human',2)").run();
}

describe('SubmissionReviewService', () => {
  let db: Database.Database;
  let submissions: SubmissionRepository;
  let reviews: SubmissionReviewRepository;
  let service: SubmissionReviewService;
  let caseId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(SCHEMA_SQL);
    seed(db);
    submissions = new SubmissionRepository(db);
    reviews = new SubmissionReviewRepository(db);
    service = new SubmissionReviewService({
      submissionRepository: submissions,
      reviewRepository: reviews,
      outcomeRepository: new OutcomeRepository(db),
    });
    caseId = submissions.createCase({ projectId: 'p1', title: '论文一', sourceOutcomeId: 'out-1', sourceOutcomeVersion: 2, targetJournalName: 'Journal A' }).submissionCase.id;
    // 走完整合法路径到 REVISION_REQUIRED（状态机不允许跳跃）。
    const path: Array<Parameters<SubmissionRepository['changeStatus']>[1]['to']> = [
      'JOURNAL_SELECTED', 'PROFILING', 'PROFILE_READY', 'DIAGNOSING', 'OPTIMIZATION_PLANNED',
      'OPTIMIZING', 'READY_FOR_PRECHECK', 'PRECHECKING', 'READY_TO_SUBMIT', 'SUBMITTING',
      'SUBMITTED', 'EDITORIAL_CHECK', 'UNDER_REVIEW', 'REVISION_REQUIRED',
    ];
    for (const to of path) submissions.changeStatus('p1', { caseId, to });
  });

  it('parses decision, deadline and reviewer sections deterministically', () => {
    const parsed = service.parseDecisionLetter(LETTER);
    expect(parsed.decision).toBe('major_revision');
    expect(parsed.deadline).not.toBeNull();
    expect(new Date(parsed.deadline!).toISOString().slice(0, 10)).toBe('2026-11-20');
    expect(parsed.reviewerComments.map((section) => section.reviewerLabel)).toEqual(['Reviewer #1', 'Reviewer #2']);
    expect(parsed.method).toBe('deterministic');
  });

  it('creates a round with verbatim letter preserved and comments split', () => {
    const result = service.createRoundFromLetter({ projectId: 'p1', caseId, decisionLetterText: LETTER });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const round = reviews.getRound(result.roundId)!;
    expect(round.decisionLetterText).toBe(LETTER); // 原文逐字保留，未改写
    expect(round.decision).toBe('major_revision');
    expect(round.submittedOutcomeVersion).toBe(2);
    const comments = reviews.listComments(result.roundId);
    expect(comments.length).toBeGreaterThanOrEqual(3);
    expect(comments.some((comment) => comment.originalText.includes('literature review misses'))).toBe(true);
  });

  it('returns unclear when no keywords hit; refuses empty letters', () => {
    const parsed = service.parseDecisionLetter('Some friendly text without any decision words.');
    expect(parsed.decision).toBe('unclear');
    expect(service.createRoundFromLetter({ projectId: 'p1', caseId, decisionLetterText: '   ' })).toEqual({ ok: false, code: 'empty_letter' });
  });

  it('rejects rounds for cases outside the project', () => {
    db.prepare("INSERT INTO projects (id,title,created_at,updated_at) VALUES ('p2','项目二',1,1)").run();
    db.prepare("INSERT INTO outcomes (id,project_id,title,kind,status,current_version,created_at,updated_at) VALUES ('out-9','p2','论文二','word','draft',1,1,1)").run();
    db.prepare("INSERT INTO outcome_versions (outcome_id,version,content,content_hash,note,created_by,created_at) VALUES ('out-9',1,'{}','h','创建','human',1)").run();
    expect(() => reviews.createRound({ projectId: 'p2', caseId, decisionLetterText: LETTER })).toThrowError(/case_not_found/u);
  });

  it('generates a response letter outcome with unresolved placeholders and updates it idempotently', async () => {
    const created = service.createRoundFromLetter({ projectId: 'p1', caseId, decisionLetterText: LETTER });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // 回复其中一条意见，其余保持未处理。
    const comments = reviews.listComments(created.roundId);
    reviews.updateComment('p1', comments[0]!.id, { responseText: 'We expanded Section 2 accordingly.', status: 'addressed' });

    const first = await service.generateResponseLetter({ projectId: 'p1', caseId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.unresolvedCount).toBeGreaterThan(0);

    const second = await service.generateResponseLetter({ projectId: 'p1', caseId });
    expect(second.ok && second.outcomeId === first.outcomeId).toBe(true); // 幂等：同一成果新版本

    const round = reviews.getRound(created.roundId)!;
    expect(round.responseLetterOutcomeId).toBe(first.outcomeId);
  });

  it('beginRevision moves an actionable case into REVISING', async () => {
    const created = service.createRoundFromLetter({ projectId: 'p1', caseId, decisionLetterText: LETTER });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const result = await service.beginRevision({ projectId: 'p1', caseId });
    expect(result.ok).toBe(true);
    expect(submissions.getCase('p1', caseId)?.status).toBe('REVISING');
  });

  it('refuses response-letter generation before any round exists', async () => {
    db.prepare("INSERT INTO outcomes (id,project_id,title,kind,status,current_version,created_at,updated_at) VALUES ('out-3','p1','论文三','word','draft',1,1,1)").run();
    db.prepare("INSERT INTO outcome_versions (outcome_id,version,content,content_hash,note,created_by,created_at) VALUES ('out-3',1,'{}','h','创建','human',1)").run();
    const other = submissions.createCase({ projectId: 'p1', title: '论文三', sourceOutcomeId: 'out-3', sourceOutcomeVersion: 1 }).submissionCase.id;
    expect(await service.generateResponseLetter({ projectId: 'p1', caseId: other })).toEqual({ ok: false, code: 'no_rounds' });
  });
});
