/**
 * Durable Submission persistence — 投稿领域 SQLite repository（P0）。
 *
 * 风格与 OutcomeRepository 一致：单类持有 better-sqlite3 句柄、动词命名方法、
 * 行→camelCase 私有映射、事务化写入。状态变更必须经
 * assertSubmissionStatusTransition（engine/submission/SubmissionRuntimeContract），
 * 每次状态推进/创建/更新都追加 submission_events（append-only timeline）。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  SubmissionCaseSchema,
  assertSubmissionStatusTransition,
  isActiveSubmissionStatus,
  type SubmissionCase,
  type SubmissionCaseCreateRequest,
  type SubmissionCaseUpdateRequest,
  type SubmissionEvent,
  type SubmissionEventSource,
  type SubmissionSeries,
  type SubmissionStatus,
  type SubmissionStatusChangeRequest,
  type TargetingCriteria,
} from '../engine/submission/SubmissionRuntimeContract.js';

/** 终态集合（listCases 默认过滤）。 */
const TERMINAL: readonly string[] = ['PUBLISHED', 'DESK_REJECTED', 'REJECTED', 'WITHDRAWN', 'CANCELLED'];

type CaseRow = {
  id: string; series_id: string; project_id: string; title: string; status: string;
  article_type: string | null; target_journal_name: string; target_journal_id: string | null;
  source_outcome_id: string | null; source_outcome_version: number | null;
  working_outcome_id: string | null; working_outcome_version: number | null;
  submitted_outcome_version: number | null; submission_method: string | null;
  submission_portal_url: string; remote_submission_id: string; notes: string;
  targeting_json: string;
  created_at: number; updated_at: number; submitted_at: number | null;
  decision_at: number | null; accepted_at: number | null; published_at: number | null;
};
type SeriesRow = { id: string; project_id: string; source_outcome_id: string | null; title: string; notes: string; created_at: number; updated_at: number };
type EventRow = { id: string; case_id: string; type: string; source: string; source_id: string | null; actor: string; description: string; metadata: string; created_at: number };

const asCase = (row: CaseRow): SubmissionCase => SubmissionCaseSchema.parse({
  contractVersion: 1,
  id: row.id,
  seriesId: row.series_id,
  projectId: row.project_id,
  title: row.title,
  status: row.status,
  articleType: row.article_type,
  targetJournalName: row.target_journal_name,
  targetJournalId: row.target_journal_id,
  sourceOutcomeId: row.source_outcome_id,
  sourceOutcomeVersion: row.source_outcome_version,
  workingOutcomeId: row.working_outcome_id,
  workingOutcomeVersion: row.working_outcome_version,
  submittedOutcomeVersion: row.submitted_outcome_version,
  submissionMethod: row.submission_method,
  submissionPortalUrl: row.submission_portal_url,
  remoteSubmissionId: row.remote_submission_id,
  notes: row.notes,
  targetingCriteria: decode<TargetingCriteria | null>(row.targeting_json, null),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  submittedAt: row.submitted_at,
  decisionAt: row.decision_at,
  acceptedAt: row.accepted_at,
  publishedAt: row.published_at,
});
const decode = <T,>(value: string, fallback: T): T => { try { return JSON.parse(value) as T; } catch { return fallback; } };
const asSeries = (row: SeriesRow): SubmissionSeries => ({
  contractVersion: 1, id: row.id, projectId: row.project_id, sourceOutcomeId: row.source_outcome_id,
  title: row.title, notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at,
});
const asEvent = (row: EventRow): SubmissionEvent => ({
  id: row.id, caseId: row.case_id, type: row.type,
  source: row.source as SubmissionEventSource, sourceId: row.source_id, actor: row.actor,
  description: row.description, metadata: JSON.parse(row.metadata || '{}') as Record<string, unknown>,
  createdAt: row.created_at,
});

/** 状态 → 里程碑时间戳列（进入即写，离开不擦除：保留历史事实）。 */
const STATUS_TIMESTAMP_COLUMN: Partial<Record<SubmissionStatus, 'submitted_at' | 'decision_at' | 'accepted_at' | 'published_at'>> = {
  SUBMITTED: 'submitted_at',
  RESUBMITTED: 'submitted_at',
  REVISION_REQUIRED: 'decision_at',
  REJECTED: 'decision_at',
  DESK_REJECTED: 'decision_at',
  ACCEPTED: 'accepted_at',
  PUBLISHED: 'published_at',
};

export class SubmissionRepository {
  constructor(private readonly db: Database.Database) {}
  private assertProject(projectId: string): void {
    if (!this.db.prepare('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL').get(projectId)) throw new Error('submission_project_not_found');
  }
  private caseRow(caseId: string): CaseRow | undefined {
    return this.db.prepare('SELECT * FROM submission_cases WHERE id = ? AND deleted_at IS NULL').get(caseId) as CaseRow | undefined;
  }
  private assertOutcome(projectId: string, outcomeId: string | null | undefined): void {
    if (!outcomeId) return;
    if (!this.db.prepare('SELECT id FROM outcomes WHERE id = ? AND project_id = ? AND deleted_at IS NULL').get(outcomeId, projectId)) throw new Error('submission_outcome_not_found');
  }
  private appendEvent(input: { caseId: string; type: string; source: SubmissionEventSource; sourceId?: string | null; actor?: string; description?: string; metadata?: Record<string, unknown>; at?: number }): SubmissionEvent {
    const now = input.at ?? Date.now();
    const id = 'sev-' + randomUUID();
    this.db.prepare('INSERT INTO submission_events (id,case_id,type,source,source_id,actor,description,metadata,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, input.caseId, input.type, input.source, input.sourceId ?? null, input.actor ?? '', input.description ?? '', JSON.stringify(input.metadata ?? {}), now);
    return { id, caseId: input.caseId, type: input.type, source: input.source, sourceId: input.sourceId ?? null, actor: input.actor ?? '', description: input.description ?? '', metadata: input.metadata ?? {}, createdAt: now };
  }

  listSeries(projectId: string): SubmissionSeries[] {
    this.assertProject(projectId);
    return (this.db.prepare('SELECT * FROM submission_series WHERE project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC').all(projectId) as SeriesRow[]).map(asSeries);
  }
  /** 全部投稿链（后台监听推导「哪些项目需要同步邮箱」用）。 */
  listAllSeries(): SubmissionSeries[] {
    return (this.db.prepare('SELECT * FROM submission_series WHERE deleted_at IS NULL ORDER BY updated_at DESC').all() as SeriesRow[]).map(asSeries);
  }
  getSeries(projectId: string, seriesId: string): SubmissionSeries | undefined {
    const row = this.db.prepare('SELECT * FROM submission_series WHERE id = ? AND project_id = ? AND deleted_at IS NULL').get(seriesId, projectId) as SeriesRow | undefined;
    return row ? asSeries(row) : undefined;
  }
  listCases(projectId: string, filter: { status?: SubmissionStatus; query?: string; includeClosed?: boolean } = {}): SubmissionCase[] {
    this.assertProject(projectId);
    const rows = this.db.prepare('SELECT * FROM submission_cases WHERE project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC').all(projectId) as CaseRow[];
    const query = (filter.query ?? '').trim().toLowerCase();
    return rows
      .map(asCase)
      .filter((item) => (filter.status ? item.status === filter.status : true))
      .filter((item) => (filter.includeClosed ? true : !TERMINAL.includes(item.status)))
      .filter((item) => (query ? (item.title + ' ' + item.targetJournalName).toLowerCase().includes(query) : true));
  }
  getCase(projectId: string, caseId: string): SubmissionCase | undefined {
    const row = this.caseRow(caseId);
    return row && row.project_id === projectId ? asCase(row) : undefined;
  }
  listEvents(projectId: string, caseId: string): SubmissionEvent[] {
    if (!this.getCase(projectId, caseId)) return [];
    return (this.db.prepare('SELECT * FROM submission_events WHERE case_id = ? ORDER BY created_at ASC').all(caseId) as EventRow[]).map(asEvent);
  }

  /**
   * 创建 Submission Case（可挂到已有 Series，否则自动建 Series）。
   * 一稿多投防护：同一源成果已存在活跃 Case 时抛 submission_duplicate_active，
   * 由 IPC 层转成结构化错误供 UI 提示风险。
   */
  createCase(request: SubmissionCaseCreateRequest): { series: SubmissionSeries; submissionCase: SubmissionCase } {
    this.assertProject(request.projectId);
    this.assertOutcome(request.projectId, request.sourceOutcomeId);
    const active = this.db.prepare(
      "SELECT id, target_journal_name FROM submission_cases WHERE project_id = ? AND source_outcome_id = ? AND deleted_at IS NULL AND status IN ('SUBMITTING','SUBMISSION_STATE_UNCERTAIN','SUBMITTED','EDITORIAL_CHECK','UNDER_REVIEW','REVISION_REQUIRED','REVISING','READY_TO_RESUBMIT','RESUBMITTED') LIMIT 1",
    ).get(request.projectId, request.sourceOutcomeId) as { id: string; target_journal_name: string } | undefined;
    if (active) throw new Error(`submission_duplicate_active:${active.id}:${active.target_journal_name}`);
    const now = Date.now();
    let seriesId = request.seriesId ?? null;
    if (seriesId) {
      const series = this.getSeries(request.projectId, seriesId);
      if (!series) throw new Error('submission_series_not_found');
    } else {
      seriesId = 'sub-series-' + randomUUID();
      this.db.prepare('INSERT INTO submission_series (id,project_id,source_outcome_id,title,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(seriesId, request.projectId, request.sourceOutcomeId, request.title, '', now, now);
    }
    const caseId = 'sub-case-' + randomUUID();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO submission_cases (id,series_id,project_id,title,status,article_type,target_journal_name,source_outcome_id,source_outcome_version,notes,targeting_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(caseId, seriesId, request.projectId, request.title ?? '', request.initialStatus ?? 'DRAFT', request.articleType ?? null, request.targetJournalName ?? '', request.sourceOutcomeId, request.sourceOutcomeVersion, request.notes ?? '', request.targetingCriteria ? JSON.stringify(request.targetingCriteria) : '', now, now);
      this.db.prepare('UPDATE submission_series SET updated_at = ? WHERE id = ?').run(now, seriesId);
      this.appendEvent({ caseId, type: 'series_created', source: 'human', description: '建立投稿事务', metadata: { seriesId }, at: now });
      this.appendEvent({ caseId, type: 'case_created', source: 'human', description: request.targetJournalName ? `目标期刊：${request.targetJournalName}` : '待选刊', at: now });
    })();
    const created = this.caseRow(caseId)!;
    return { series: this.getSeries(request.projectId, seriesId)!, submissionCase: asCase(created) };
  }

  updateCase(projectId: string, patch: SubmissionCaseUpdateRequest, actor = 'human'): SubmissionCase | undefined {
    const row = this.caseRow(patch.caseId);
    if (!row || row.project_id !== projectId) return undefined;
    const existing = asCase(row);
    if (patch.workingOutcomeId) this.assertOutcome(projectId, patch.workingOutcomeId);
    const sets: string[] = [];
    const values: unknown[] = [];
    const assign = (column: string, value: unknown): void => { sets.push(`${column} = ?`); values.push(value); };
    if (patch.title !== undefined) assign('title', patch.title);
    if (patch.articleType !== undefined) assign('article_type', patch.articleType);
    if (patch.targetJournalName !== undefined) assign('target_journal_name', patch.targetJournalName);
    if (patch.targetJournalId !== undefined) assign('target_journal_id', patch.targetJournalId);
    if (patch.workingOutcomeId !== undefined) assign('working_outcome_id', patch.workingOutcomeId);
    if (patch.workingOutcomeVersion !== undefined) assign('working_outcome_version', patch.workingOutcomeVersion);
    if (patch.submissionMethod !== undefined) assign('submission_method', patch.submissionMethod);
    if (patch.submissionPortalUrl !== undefined) assign('submission_portal_url', patch.submissionPortalUrl);
    if (patch.remoteSubmissionId !== undefined) assign('remote_submission_id', patch.remoteSubmissionId);
    if (patch.notes !== undefined) assign('notes', patch.notes);
    if (patch.targetingCriteria !== undefined) assign('targeting_json', patch.targetingCriteria ? JSON.stringify(patch.targetingCriteria) : '');
    if (sets.length === 0) return existing;
    const now = Date.now();
    assign('updated_at', now);
    values.push(patch.caseId);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE submission_cases SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      this.appendEvent({ caseId: patch.caseId, type: 'note_added', source: 'human', actor, description: '更新投稿信息', metadata: patch as unknown as Record<string, unknown>, at: now });
    })();
    return asCase(this.caseRow(patch.caseId)!);
  }

  /**
   * 状态推进（唯一入口）：断言转移合法 → 写状态与里程碑时间戳 → 追加事件。
   * 进入 SUBMITTED / RESUBMITTED 时冻结 submittedOutcomeVersion（取当前工作稿版本，
   * 未指定则用源成果版本），此后该版本不可再被本模块修改。
   */
  changeStatus(projectId: string, request: SubmissionStatusChangeRequest): SubmissionCase | undefined {
    const row = this.caseRow(request.caseId);
    if (!row || row.project_id !== projectId) return undefined;
    const existing = asCase(row);
    assertSubmissionStatusTransition(existing.status as SubmissionStatus, request.to);
    const now = Date.now();
    const stampColumn = STATUS_TIMESTAMP_COLUMN[request.to];
    let frozenVersion = existing.submittedOutcomeVersion;
    if ((request.to === 'SUBMITTED' || request.to === 'RESUBMITTED') && frozenVersion === null) {
      frozenVersion = existing.workingOutcomeVersion ?? existing.sourceOutcomeVersion ?? null;
    }
    this.db.transaction(() => {
      const sets = ['status = ?', 'updated_at = ?'];
      const values: unknown[] = [request.to, now];
      if (stampColumn) { sets.push(`${stampColumn} = ?`); values.push(now); }
      if ((request.to === 'SUBMITTED' || request.to === 'RESUBMITTED') && existing.submittedOutcomeVersion === null && frozenVersion !== null) {
        sets.push('submitted_outcome_version = ?'); values.push(frozenVersion);
      }
      values.push(request.caseId);
      this.db.prepare(`UPDATE submission_cases SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      this.appendEvent({
        caseId: request.caseId,
        type: request.to === 'SUBMITTED' || request.to === 'RESUBMITTED' ? 'submitted' : 'status_changed',
        source: request.source ?? 'human',
        actor: request.actor ?? 'human',
        description: request.reason || `${existing.status} → ${request.to}`,
        metadata: { from: existing.status, to: request.to },
        at: now,
      });
    })();
    return asCase(this.caseRow(request.caseId)!);
  }

  /** 追加自由事件（邮件/浏览器/系统来源），不改状态。 */
  addEvent(projectId: string, input: { caseId: string; type: string; source: SubmissionEventSource; sourceId?: string | null; actor?: string; description?: string; metadata?: Record<string, unknown> }): SubmissionEvent | undefined {
    if (!this.getCase(projectId, input.caseId)) return undefined;
    return this.appendEvent(input);
  }

  /** 软删除（回收站语义沿用 outcomes 的 deleted_at 列风格）。 */
  archiveCase(projectId: string, caseId: string, now = Date.now()): boolean {
    return this.db.prepare('UPDATE submission_cases SET deleted_at = ?, updated_at = ? WHERE id = ? AND project_id = ? AND deleted_at IS NULL').run(now, now, caseId, projectId).changes > 0;
  }

  /** 一稿多投检查：该成果在指定项目下是否有活跃投稿。 */
  findActiveCase(projectId: string, sourceOutcomeId: string): SubmissionCase | undefined {
    const row = this.db.prepare(
      "SELECT * FROM submission_cases WHERE project_id = ? AND source_outcome_id = ? AND deleted_at IS NULL AND status IN ('SUBMITTING','SUBMISSION_STATE_UNCERTAIN','SUBMITTED','EDITORIAL_CHECK','UNDER_REVIEW','REVISION_REQUIRED','REVISING','READY_TO_RESUBMIT','RESUBMITTED') ORDER BY updated_at DESC LIMIT 1",
    ).get(projectId, sourceOutcomeId) as CaseRow | undefined;
    return row ? asCase(row) : undefined;
  }

  // ── 旧数据迁移：submissions.json → Submission Domain ─────────────
  /**
   * 读取旧 SubmissionTrackerService 的 submissions.json（如存在），逐条迁移为
   * Series + Case + 事件。幂等：以 legacyId 为 remote_submission_id 去重。
   * 返回迁移条数；文件不存在返回 0。
   */
  migrateLegacyFile(filePath: string, readFile: (path: string) => string): number {
    let raw: string;
    try { raw = readFile(filePath); } catch { return 0; }
    let records: unknown;
    try { records = JSON.parse(raw); } catch { return 0; }
    if (!Array.isArray(records)) return 0;
    let migrated = 0;
    for (const record of records) {
      if (typeof record !== 'object' || record === null) continue;
      const item = record as Record<string, unknown>;
      const legacyId = typeof item.id === 'string' ? item.id : null;
      const projectId = typeof item.projectId === 'string' ? item.projectId : null;
      const title = typeof item.title === 'string' ? item.title : '';
      const journal = typeof item.journal === 'string' ? item.journal : '';
      if (!legacyId || !projectId) continue;
      const dup = this.db.prepare('SELECT id FROM submission_cases WHERE remote_submission_id = ?').get('legacy:' + legacyId);
      if (dup) continue;
      const statusMap: Record<string, SubmissionStatus> = {
        submitted: 'SUBMITTED', under_review: 'UNDER_REVIEW', revise: 'REVISION_REQUIRED',
        accepted: 'ACCEPTED', published: 'PUBLISHED', rejected: 'REJECTED',
      };
      const legacyStatus = typeof item.status === 'string' ? item.status : 'submitted';
      const status = statusMap[legacyStatus] ?? 'SUBMITTED';
      const submittedAt = typeof item.submittedAt === 'number' ? item.submittedAt : Date.now();
      const notes = typeof item.notes === 'string' ? item.notes : '';
      try {
        this.assertProject(projectId);
      } catch { continue; }
      const now = Date.now();
      const seriesId = 'sub-series-' + randomUUID();
      const caseId = 'sub-case-' + randomUUID();
      const comments = Array.isArray(item.comments) ? item.comments : [];
      this.db.transaction(() => {
        this.db.prepare('INSERT INTO submission_series (id,project_id,source_outcome_id,title,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
          .run(seriesId, projectId, typeof item.artifactId === 'string' ? item.artifactId : null, title, '由旧版投稿记录迁移', now, now);
        this.db.prepare(`INSERT INTO submission_cases (id,series_id,project_id,title,status,target_journal_name,source_outcome_id,remote_submission_id,notes,created_at,updated_at,submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(caseId, seriesId, projectId, title, status, journal, typeof item.artifactId === 'string' ? item.artifactId : null, 'legacy:' + legacyId, notes, submittedAt, now, status === 'SUBMITTED' || isActiveSubmissionStatus(status) ? submittedAt : null);
        this.appendEvent({ caseId, type: 'case_created', source: 'system', description: `由旧版 submissions.json 迁移（legacy=${legacyId}）`, at: submittedAt });
        for (const comment of comments) {
          if (typeof comment !== 'object' || comment === null) continue;
          const entry = comment as Record<string, unknown>;
          const text = typeof entry.text === 'string' ? entry.text : '';
          const at = typeof entry.createdAt === 'number' ? entry.createdAt : now;
          this.appendEvent({ caseId, type: 'note_added', source: 'system', description: '旧审稿意见：' + text.slice(0, 500), metadata: { legacyComment: entry, resolved: entry.resolved === true, revisionNote: entry.revisionNote ?? '' }, at });
        }
      })();
      migrated += 1;
    }
    return migrated;
  }
}
