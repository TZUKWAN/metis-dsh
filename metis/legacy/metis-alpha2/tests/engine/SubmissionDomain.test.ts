/** @vitest-environment node */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import { SubmissionRepository } from '../../electron/SubmissionRepository.js';
import {
  SUBMISSION_STATUS_TRANSITIONS,
  assertSubmissionStatusTransition,
  isActiveSubmissionStatus,
  isTerminalSubmissionStatus,
  submissionLifecycleStage,
  type SubmissionStatus,
} from '../../engine/submission/SubmissionRuntimeContract.js';

describe('submission status machine', () => {
  it('covers every status in the transition table (no dangling states)', () => {
    for (const status of Object.keys(SUBMISSION_STATUS_TRANSITIONS)) {
      for (const next of SUBMISSION_STATUS_TRANSITIONS[status as SubmissionStatus]) {
        // 每个转移目标也必须是合法状态（表内自洽）。
        expect(SUBMISSION_STATUS_TRANSITIONS[next], `${status} -> ${next}`).toBeDefined();
      }
    }
  });

  it('rejects jumping from DRAFT straight to SUBMITTED', () => {
    expect(() => assertSubmissionStatusTransition('DRAFT', 'SUBMITTED')).toThrowError(/Illegal submission status transition/u);
  });

  it('routes SUBMITTING uncertainty through SUBMISSION_STATE_UNCERTAIN instead of blind resubmit', () => {
    expect(SUBMISSION_STATUS_TRANSITIONS.SUBMITTING).toContain('SUBMISSION_STATE_UNCERTAIN');
    expect(SUBMISSION_STATUS_TRANSITIONS.SUBMISSION_STATE_UNCERTAIN).toContain('SUBMITTED');
    expect(SUBMISSION_STATUS_TRANSITIONS.SUBMISSION_STATE_UNCERTAIN).toContain('READY_TO_SUBMIT');
  });

  it('marks published/rejected/withdrawn/cancelled as terminal and submitted as active', () => {
    expect(isTerminalSubmissionStatus('PUBLISHED')).toBe(true);
    expect(isTerminalSubmissionStatus('REJECTED')).toBe(true);
    expect(isTerminalSubmissionStatus('UNDER_REVIEW')).toBe(false);
    expect(isActiveSubmissionStatus('UNDER_REVIEW')).toBe(true);
    expect(isActiveSubmissionStatus('DRAFT')).toBe(false);
  });

  it('maps statuses onto user-facing lifecycle stages', () => {
    expect(submissionLifecycleStage('DRAFT')).toBe('targeting');
    expect(submissionLifecycleStage('PROFILE_READY')).toBe('profiling');
    expect(submissionLifecycleStage('UNDER_REVIEW')).toBe('tracking');
    expect(submissionLifecycleStage('REVISING')).toBe('revision');
    expect(submissionLifecycleStage('PUBLISHED')).toBe('accepted');
    expect(submissionLifecycleStage('REJECTED')).toBe('closed');
  });
});

describe('SubmissionRepository', () => {
  let db: Database.Database;
  let repo: import('../../electron/SubmissionRepository.js').SubmissionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(SCHEMA_SQL);
    db.prepare("INSERT INTO projects (id,title,created_at,updated_at) VALUES ('p1','项目一',1,1)").run();
    db.prepare("INSERT INTO outcomes (id,project_id,title,kind,status,current_version,created_at,updated_at) VALUES ('out-1','p1','论文一','word','draft',1,1,1)").run();
    db.prepare("INSERT INTO outcome_versions (outcome_id,version,content,content_hash,note,created_by,created_at) VALUES ('out-1',1,'{}','h','创建','human',1)").run();
    repo = new SubmissionRepository(db);
  });

  function createCase(overrides: Partial<{ journal: string; initialStatus: 'DRAFT' | 'TARGETING' | 'JOURNAL_SELECTED' }> = {}) {
    return repo.createCase({
      projectId: 'p1',
      title: '论文一',
      sourceOutcomeId: 'out-1',
      sourceOutcomeVersion: 1,
      targetJournalName: overrides.journal ?? '',
      initialStatus: overrides.initialStatus ?? 'DRAFT',
    });
  }

  it('creates a series + case and records timeline events', () => {
    const { series, submissionCase } = createCase({ journal: 'Journal A', initialStatus: 'JOURNAL_SELECTED' });
    expect(series.id).toBeTruthy();
    expect(submissionCase.status).toBe('JOURNAL_SELECTED');
    expect(submissionCase.targetJournalName).toBe('Journal A');
    const events = repo.listEvents('p1', submissionCase.id);
    expect(events.map((item) => item.type)).toContain('case_created');
  });

  it('enforces the state machine on changeStatus and stamps milestones', () => {
    const { submissionCase } = createCase({ journal: 'Journal A', initialStatus: 'JOURNAL_SELECTED' });
    expect(() => repo.changeStatus('p1', { caseId: submissionCase.id, to: 'SUBMITTED' })).toThrowError(/Illegal/u);
    let current = repo.changeStatus('p1', { caseId: submissionCase.id, to: 'PROFILING' })!;
    expect(current.status).toBe('PROFILING');
    for (const next of ['PROFILE_READY', 'DIAGNOSING', 'OPTIMIZATION_PLANNED', 'OPTIMIZING', 'READY_FOR_PRECHECK', 'PRECHECKING', 'READY_TO_SUBMIT', 'SUBMITTING'] as const) {
      repo.changeStatus('p1', { caseId: submissionCase.id, to: next });
    }
    current = repo.changeStatus('p1', { caseId: submissionCase.id, to: 'SUBMITTED' })!;
    // 已提交版本冻结：自动取源成果版本。
    expect(current.submittedOutcomeVersion).toBe(1);
    expect(current.submittedAt).not.toBeNull();
    const statusEvents = repo.listEvents('p1', submissionCase.id).filter((item) => item.type === 'submitted');
    expect(statusEvents.length).toBe(1);
  });

  it('blocks a second active case for the same outcome (一稿多投防护)', () => {
    createCase({ journal: 'Journal A', initialStatus: 'JOURNAL_SELECTED' });
    repo.changeStatus('p1', { caseId: repo.listCases('p1')[0]!.id, to: 'PROFILING' });
    // PROFILING 不是活跃投稿态，允许再建；推进到 SUBMITTED 后再建应被拒。
    const first = repo.listCases('p1')[0]!;
    repo.changeStatus('p1', { caseId: first.id, to: 'PROFILE_READY' });
    expect(repo.findActiveCase('p1', 'out-1')).toBeUndefined();
    repo.changeStatus('p1', { caseId: first.id, to: 'DIAGNOSING' });
    repo.changeStatus('p1', { caseId: first.id, to: 'OPTIMIZATION_PLANNED' });
    repo.changeStatus('p1', { caseId: first.id, to: 'OPTIMIZING' });
    repo.changeStatus('p1', { caseId: first.id, to: 'READY_FOR_PRECHECK' });
    repo.changeStatus('p1', { caseId: first.id, to: 'PRECHECKING' });
    repo.changeStatus('p1', { caseId: first.id, to: 'READY_TO_SUBMIT' });
    repo.changeStatus('p1', { caseId: first.id, to: 'SUBMITTING' });
    repo.changeStatus('p1', { caseId: first.id, to: 'SUBMITTED' });
    expect(() => createCase({ journal: 'Journal B', initialStatus: 'JOURNAL_SELECTED' }))
      .toThrowError(/submission_duplicate_active/u);
  });

  it('allows a new case on the same series after rejection (换刊重投)', () => {
    const { series, submissionCase } = createCase({ journal: 'Journal A', initialStatus: 'JOURNAL_SELECTED' });
    // JOURNAL_SELECTED 无法直接到 REJECTED；走合法路径到 SUBMITTED 再拒。
    repo.changeStatus('p1', { caseId: submissionCase.id, to: 'PROFILING' });
    for (const next of ['PROFILE_READY', 'DIAGNOSING', 'OPTIMIZATION_PLANNED', 'OPTIMIZING', 'READY_FOR_PRECHECK', 'PRECHECKING', 'READY_TO_SUBMIT', 'SUBMITTING', 'SUBMITTED'] as const) {
      repo.changeStatus('p1', { caseId: submissionCase.id, to: next });
    }
    const rejected = repo.changeStatus('p1', { caseId: submissionCase.id, to: 'REJECTED', reason: 'Reject after review' })!;
    expect(rejected.status).toBe('REJECTED');
    // 拒稿后同 Series 新 Case（换刊）。
    const second = repo.createCase({
      projectId: 'p1', title: '论文一', sourceOutcomeId: 'out-1', sourceOutcomeVersion: 1,
      targetJournalName: 'Journal B', seriesId: series.id, initialStatus: 'JOURNAL_SELECTED',
    });
    expect(second.submissionCase.seriesId).toBe(series.id);
    expect(second.submissionCase.id).not.toBe(submissionCase.id);
  });

  it('migrates legacy submissions.json records idempotently', () => {
    const legacy = JSON.stringify([
      {
        id: 'legacy-1', projectId: 'p1', artifactId: 'out-1', title: '旧投稿',
        journal: '旧期刊', status: 'under_review', submittedAt: 1000, updatedAt: 2000,
        notes: '备注', comments: [{ id: 'c1', text: '请补实验', resolved: false, revisionNote: '', createdAt: 3000 }],
      },
    ]);
    const migrated1 = repo.migrateLegacyFile('C:/fake/submissions.json', () => legacy);
    expect(migrated1).toBe(1);
    // 幂等：再跑一遍不重复。
    expect(repo.migrateLegacyFile('C:/fake/submissions.json', () => legacy)).toBe(0);
    const cases = repo.listCases('p1', { includeClosed: true });
    expect(cases).toHaveLength(1);
    expect(cases[0]!.status).toBe('UNDER_REVIEW');
    expect(cases[0]!.remoteSubmissionId).toBe('legacy:legacy-1');
    const events = repo.listEvents('p1', cases[0]!.id);
    expect(events.some((item) => item.description.includes('请补实验'))).toBe(true);
    // 原始意见保留在事件 metadata 中（禁止丢弃原文）。
    expect(events.some((item) => JSON.stringify(item.metadata).includes('legacyComment'))).toBe(true);
  });
});
