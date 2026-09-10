/**
 * Durable Journal Profile persistence — 期刊研究领域 SQLite repository（P1）。
 *
 * 风格与 SubmissionRepository 一致：单类持有 better-sqlite3 句柄、动词命名方法、
 * 行→camelCase 私有映射、事务化写入、写入前对可选字符串字段做 `?? ''` 防御
 * （调用方可能绕过 Zod 默认值直接调仓储）。
 *
 * 证据纪律：官方硬约束（journal_requirements）与语料软范式
 * （journal_pattern_observations）分表存放；replace* 方法按快照整体替换，
 * list* 方法只读不改。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  JournalCorpusItemSchema,
  JournalPatternObservationSchema,
  JournalProfileSchema,
  JournalProfileSnapshotSchema,
  JournalRequirementSchema,
  SubmissionGapItemSchema,
  SubmissionOptimizationItemSchema,
  SubmissionOptimizationPlanSchema,
  type JournalConfidence,
  type JournalCorpusItem,
  type JournalCorpusItemCreateInput,
  type JournalCorpusSource,
  type JournalPatternEvidenceLevel,
  type JournalPatternKey,
  type JournalPatternObservation,
  type JournalPatternObservationCreateInput,
  type JournalPlatform,
  type JournalProfile,
  type JournalProfileSnapshot,
  type JournalProfileUpsertInput,
  type JournalRequirement,
  type JournalRequirementCreateInput,
  type JournalRequirementRuleKey,
  type SubmissionGapItem,
  type SubmissionGapItemCreateInput,
  type SubmissionGapItemPatch,
  type SubmissionGapSeverity,
  type SubmissionGapSourceType,
  type SubmissionGapStatus,
  type SubmissionImpactLevel,
  type SubmissionOptimizationItem,
  type SubmissionOptimizationItemCreateInput,
  type SubmissionOptimizationItemPatch,
  type SubmissionOptimizationPlan,
  type SubmissionPlanItemStatus,
  type SubmissionPlanStatus,
} from '../engine/submission/JournalProfileContract.js';

type ProfileRow = {
  id: string; project_id: string; canonical_name: string; issn: string | null;
  publisher: string; homepage_url: string; submission_portal_url: string;
  platform: string; article_types_json: string;
  created_at: number; updated_at: number; deleted_at: number | null;
};
type SnapshotRow = { id: string; profile_id: string; case_id: string | null; retrieved_at: number; note: string; created_at: number };
type RequirementRow = {
  id: string; snapshot_id: string; rule_key: string; value_text: string; rule_type: string;
  source_url: string; source_title: string; evidence_snippet: string; confidence: string;
  retrieved_at: number; created_at: number; updated_at: number;
};
type CorpusRow = {
  id: string; profile_id: string; snapshot_id: string | null; title: string; authors_json: string;
  year: number | null; doi: string; url: string; abstract: string; source: string;
  venue_name: string; issn: string; similarity_score: number | null; fulltext_available: number; created_at: number;
};
type ObservationRow = {
  id: string; snapshot_id: string; pattern_key: string; observation: string; evidence_level: string;
  sample_size: number; supporting_item_ids_json: string; confidence: string; created_at: number;
};
type GapItemRow = {
  id: string; case_id: string; severity: string; title: string; problem: string; evidence: string;
  source_type: string; affected_location: string; recommended_action: string;
  requires_researcher_judgment: number; estimated_impact: string; status: string;
  created_at: number; updated_at: number;
};
type PlanRow = {
  id: string; case_id: string; status: string; created_at: number; updated_at: number;
  approved_at: number | null; applied_at: number | null;
};
type PlanItemRow = {
  id: string; plan_id: string; gap_item_id: string | null; title: string; action: string; risk: string;
  involves_researcher_judgment: number; status: string; before_text: string; after_text: string;
  outcome_id: string | null; outcome_version: number | null; created_at: number; updated_at: number;
};

const decode = <T,>(value: string, fallback: T): T => { try { return JSON.parse(value) as T; } catch { return fallback; } };

const asProfile = (row: ProfileRow): JournalProfile => JournalProfileSchema.parse({
  id: row.id,
  projectId: row.project_id,
  canonicalName: row.canonical_name,
  issn: row.issn,
  publisher: row.publisher,
  homepageUrl: row.homepage_url,
  submissionPortalUrl: row.submission_portal_url,
  platform: row.platform as JournalPlatform,
  articleTypes: decode<string[]>(row.article_types_json, []),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const asSnapshot = (row: SnapshotRow): JournalProfileSnapshot => JournalProfileSnapshotSchema.parse({
  id: row.id, profileId: row.profile_id, caseId: row.case_id,
  retrievedAt: row.retrieved_at, note: row.note, createdAt: row.created_at,
});
const asRequirement = (row: RequirementRow): JournalRequirement => JournalRequirementSchema.parse({
  id: row.id, snapshotId: row.snapshot_id, ruleKey: row.rule_key as JournalRequirementRuleKey,
  valueText: row.value_text, ruleType: 'official_requirement',
  sourceUrl: row.source_url, sourceTitle: row.source_title, evidenceSnippet: row.evidence_snippet,
  confidence: row.confidence as JournalConfidence,
  retrievedAt: row.retrieved_at, createdAt: row.created_at, updatedAt: row.updated_at,
});
const asCorpusItem = (row: CorpusRow): JournalCorpusItem => JournalCorpusItemSchema.parse({
  id: row.id, profileId: row.profile_id, snapshotId: row.snapshot_id,
  title: row.title, authors: decode<string[]>(row.authors_json, []),
  year: row.year, doi: row.doi, url: row.url, abstract: row.abstract,
  source: row.source as JournalCorpusSource, venueName: row.venue_name, issn: row.issn,
  similarityScore: row.similarity_score, fulltextAvailable: row.fulltext_available === 1,
  createdAt: row.created_at,
});
const asObservation = (row: ObservationRow): JournalPatternObservation => JournalPatternObservationSchema.parse({
  id: row.id, snapshotId: row.snapshot_id, patternKey: row.pattern_key as JournalPatternKey,
  observation: row.observation, evidenceLevel: row.evidence_level as JournalPatternEvidenceLevel,
  sampleSize: row.sample_size, supportingItemIds: decode<string[]>(row.supporting_item_ids_json, []),
  confidence: row.confidence as JournalConfidence, createdAt: row.created_at,
});
const asGapItem = (row: GapItemRow): SubmissionGapItem => SubmissionGapItemSchema.parse({
  id: row.id, caseId: row.case_id, severity: row.severity as SubmissionGapSeverity,
  title: row.title, problem: row.problem, evidence: row.evidence,
  sourceType: row.source_type as SubmissionGapSourceType, affectedLocation: row.affected_location,
  recommendedAction: row.recommended_action, requiresResearcherJudgment: row.requires_researcher_judgment === 1,
  estimatedImpact: row.estimated_impact as SubmissionImpactLevel, status: row.status as SubmissionGapStatus,
  createdAt: row.created_at, updatedAt: row.updated_at,
});
const asPlan = (row: PlanRow): SubmissionOptimizationPlan => SubmissionOptimizationPlanSchema.parse({
  id: row.id, caseId: row.case_id, status: row.status as SubmissionPlanStatus,
  createdAt: row.created_at, updatedAt: row.updated_at,
  approvedAt: row.approved_at, appliedAt: row.applied_at,
});
const asPlanItem = (row: PlanItemRow): SubmissionOptimizationItem => SubmissionOptimizationItemSchema.parse({
  id: row.id, planId: row.plan_id, gapItemId: row.gap_item_id,
  title: row.title, action: row.action, risk: row.risk,
  involvesResearcherJudgment: row.involves_researcher_judgment === 1,
  status: row.status as SubmissionPlanItemStatus, beforeText: row.before_text, afterText: row.after_text,
  outcomeId: row.outcome_id, outcomeVersion: row.outcome_version,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

/** 方案状态 → 里程碑时间戳列（进入即写，离开不擦除：保留历史事实）。 */
const PLAN_STATUS_TIMESTAMP_COLUMN: Partial<Record<SubmissionPlanStatus, 'approved_at' | 'applied_at'>> = {
  approved: 'approved_at',
  applied: 'applied_at',
};

const normalizeTitle = (title: string): string => title.trim().toLowerCase().replace(/\s+/g, ' ');

export class JournalProfileRepository {
  constructor(private readonly db: Database.Database) {}

  private profileRow(profileId: string): ProfileRow | undefined {
    return this.db.prepare('SELECT * FROM journal_profiles WHERE id = ? AND deleted_at IS NULL').get(profileId) as ProfileRow | undefined;
  }

  // ── JournalProfile ─────────────────────────────────────────

  /**
   * 按 (project_id, canonical_name) 或 (project_id, issn 非空) 去重 upsert：
   * 命中已有档案则更新可变字段并返回它，否则新建。
   */
  upsertProfile(projectId: string, input: JournalProfileUpsertInput): JournalProfile {
    const issn = input.issn ?? null;
    const existing = this.db.prepare(
      `SELECT * FROM journal_profiles WHERE project_id = ? AND deleted_at IS NULL AND (
         canonical_name = ? OR (? IS NOT NULL AND ? != '' AND issn = ?)
       ) ORDER BY created_at ASC LIMIT 1`,
    ).get(projectId, input.canonicalName, issn, issn ?? '', issn) as ProfileRow | undefined;
    const now = Date.now();
    if (existing) {
      this.db.prepare(
        'UPDATE journal_profiles SET issn = ?, publisher = ?, homepage_url = ?, submission_portal_url = ?, platform = ?, article_types_json = ?, updated_at = ? WHERE id = ?',
      ).run(
        issn ?? existing.issn,
        input.publisher ?? '',
        input.homepageUrl ?? '',
        input.submissionPortalUrl ?? '',
        input.platform ?? 'unknown',
        JSON.stringify(input.articleTypes ?? []),
        now,
        existing.id,
      );
      return asProfile(this.profileRow(existing.id)!);
    }
    const id = 'jp-' + randomUUID();
    this.db.prepare(
      'INSERT INTO journal_profiles (id,project_id,canonical_name,issn,publisher,homepage_url,submission_portal_url,platform,article_types_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id, projectId, input.canonicalName, issn,
      input.publisher ?? '', input.homepageUrl ?? '', input.submissionPortalUrl ?? '',
      input.platform ?? 'unknown', JSON.stringify(input.articleTypes ?? []), now, now,
    );
    return asProfile(this.profileRow(id)!);
  }

  getProfile(projectId: string, profileId: string): JournalProfile | undefined {
    const row = this.profileRow(profileId);
    return row && row.project_id === projectId ? asProfile(row) : undefined;
  }

  findProfileByName(projectId: string, name: string): JournalProfile | undefined {
    const row = this.db.prepare(
      'SELECT * FROM journal_profiles WHERE project_id = ? AND canonical_name = ? AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1',
    ).get(projectId, name) as ProfileRow | undefined;
    return row ? asProfile(row) : undefined;
  }

  // ── Snapshot ───────────────────────────────────────────────

  createSnapshot(profileId: string, caseId: string | null, note = ''): JournalProfileSnapshot {
    const now = Date.now();
    const id = 'jps-' + randomUUID();
    this.db.prepare(
      'INSERT INTO journal_profile_snapshots (id,profile_id,case_id,retrieved_at,note,created_at) VALUES (?,?,?,?,?,?)',
    ).run(id, profileId, caseId ?? null, now, note ?? '', now);
    return asSnapshot(this.db.prepare('SELECT * FROM journal_profile_snapshots WHERE id = ?').get(id) as SnapshotRow);
  }

  getSnapshot(snapshotId: string): JournalProfileSnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM journal_profile_snapshots WHERE id = ?').get(snapshotId) as SnapshotRow | undefined;
    return row ? asSnapshot(row) : undefined;
  }

  latestSnapshot(profileId: string): JournalProfileSnapshot | undefined {
    const row = this.db.prepare(
      'SELECT * FROM journal_profile_snapshots WHERE profile_id = ? ORDER BY retrieved_at DESC, created_at DESC LIMIT 1',
    ).get(profileId) as SnapshotRow | undefined;
    return row ? asSnapshot(row) : undefined;
  }

  // ── Requirements（官方硬约束，按快照整体替换） ──────────────

  replaceRequirements(snapshotId: string, requirements: JournalRequirementCreateInput[]): JournalRequirement[] {
    const now = Date.now();
    const ids: string[] = [];
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM journal_requirements WHERE snapshot_id = ?').run(snapshotId);
      const insert = this.db.prepare(
        'INSERT INTO journal_requirements (id,snapshot_id,rule_key,value_text,rule_type,source_url,source_title,evidence_snippet,confidence,retrieved_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      );
      for (const requirement of requirements) {
        const id = 'jreq-' + randomUUID();
        insert.run(
          id, snapshotId, requirement.ruleKey, requirement.valueText ?? '', 'official_requirement',
          requirement.sourceUrl ?? '', requirement.sourceTitle ?? '', requirement.evidenceSnippet ?? '',
          requirement.confidence ?? 'medium', requirement.retrievedAt ?? now, now, now,
        );
        ids.push(id);
      }
    })();
    return this.listRequirements(snapshotId).filter((item) => ids.includes(item.id));
  }

  listRequirements(snapshotId: string): JournalRequirement[] {
    return (this.db.prepare('SELECT * FROM journal_requirements WHERE snapshot_id = ? ORDER BY created_at ASC').all(snapshotId) as RequirementRow[]).map(asRequirement);
  }

  // ── Corpus（语料，按 doi 非空或规范化标题去重） ─────────────

  /**
   * 批量追加语料条目：doi 非空时按 doi（大小写不敏感）去重，
   * 否则按规范化标题去重；已存在的条目跳过。返回实际新增的条目。
   */
  addCorpusItems(profileId: string, snapshotId: string | null, items: JournalCorpusItemCreateInput[]): JournalCorpusItem[] {
    const now = Date.now();
    const added: string[] = [];
    const findByDoi = this.db.prepare("SELECT id FROM journal_corpus_items WHERE profile_id = ? AND doi != '' AND LOWER(doi) = LOWER(?) LIMIT 1");
    const findByTitle = this.db.prepare('SELECT id FROM journal_corpus_items WHERE profile_id = ? AND LOWER(TRIM(title)) = ? LIMIT 1');
    const insert = this.db.prepare(
      'INSERT INTO journal_corpus_items (id,profile_id,snapshot_id,title,authors_json,year,doi,url,abstract,source,venue_name,issn,similarity_score,fulltext_available,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    this.db.transaction(() => {
      for (const item of items) {
        const doi = item.doi ?? '';
        const title = item.title ?? '';
        if (doi && findByDoi.get(profileId, doi)) continue;
        if (!doi && title && findByTitle.get(profileId, normalizeTitle(title))) continue;
        if (!doi && !title) continue; // 无可去重键的条目不入库
        const id = 'jci-' + randomUUID();
        insert.run(
          id, profileId, snapshotId ?? null, title, JSON.stringify(item.authors ?? []),
          item.year ?? null, doi, item.url ?? '', item.abstract ?? '',
          item.source ?? 'browser', item.venueName ?? '', item.issn ?? '',
          item.similarityScore ?? null, item.fulltextAvailable ? 1 : 0, now,
        );
        added.push(id);
      }
    })();
    if (added.length === 0) return [];
    const placeholders = added.map(() => '?').join(',');
    return (this.db.prepare(`SELECT * FROM journal_corpus_items WHERE id IN (${placeholders}) ORDER BY created_at ASC`).all(...added) as CorpusRow[]).map(asCorpusItem);
  }

  listCorpusItems(profileId: string, limit?: number): JournalCorpusItem[] {
    const rows = limit !== undefined
      ? this.db.prepare('SELECT * FROM journal_corpus_items WHERE profile_id = ? ORDER BY created_at ASC LIMIT ?').all(profileId, limit)
      : this.db.prepare('SELECT * FROM journal_corpus_items WHERE profile_id = ? ORDER BY created_at ASC').all(profileId);
    return (rows as CorpusRow[]).map(asCorpusItem);
  }

  // ── Pattern observations（软范式，按快照整体替换） ──────────

  replacePatternObservations(snapshotId: string, observations: JournalPatternObservationCreateInput[]): JournalPatternObservation[] {
    const now = Date.now();
    const ids: string[] = [];
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM journal_pattern_observations WHERE snapshot_id = ?').run(snapshotId);
      const insert = this.db.prepare(
        'INSERT INTO journal_pattern_observations (id,snapshot_id,pattern_key,observation,evidence_level,sample_size,supporting_item_ids_json,confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      );
      for (const observation of observations) {
        const id = 'jpo-' + randomUUID();
        insert.run(
          id, snapshotId, observation.patternKey, observation.observation ?? '',
          observation.evidenceLevel ?? 'metadata_only', observation.sampleSize ?? 0,
          JSON.stringify(observation.supportingItemIds ?? []), observation.confidence ?? 'medium', now,
        );
        ids.push(id);
      }
    })();
    return this.listPatternObservations(snapshotId).filter((item) => ids.includes(item.id));
  }

  listPatternObservations(snapshotId: string): JournalPatternObservation[] {
    return (this.db.prepare('SELECT * FROM journal_pattern_observations WHERE snapshot_id = ? ORDER BY created_at ASC').all(snapshotId) as ObservationRow[]).map(asObservation);
  }

  // ── Gap items（差距诊断） ──────────────────────────────────

  createGapItems(caseId: string, items: SubmissionGapItemCreateInput[]): SubmissionGapItem[] {
    const now = Date.now();
    const ids: string[] = [];
    const insert = this.db.prepare(
      'INSERT INTO submission_gap_items (id,case_id,severity,title,problem,evidence,source_type,affected_location,recommended_action,requires_researcher_judgment,estimated_impact,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    this.db.transaction(() => {
      for (const item of items) {
        const id = 'gap-' + randomUUID();
        insert.run(
          id, caseId, item.severity, item.title ?? '', item.problem ?? '', item.evidence ?? '',
          item.sourceType, item.affectedLocation ?? '', item.recommendedAction ?? '',
          item.requiresResearcherJudgment ? 1 : 0, item.estimatedImpact ?? 'medium', 'open', now, now,
        );
        ids.push(id);
      }
    })();
    return this.listGapItems(caseId).filter((item) => ids.includes(item.id));
  }

  listGapItems(caseId: string, status?: SubmissionGapStatus): SubmissionGapItem[] {
    const rows = status
      ? this.db.prepare('SELECT * FROM submission_gap_items WHERE case_id = ? AND status = ? ORDER BY created_at ASC').all(caseId, status)
      : this.db.prepare('SELECT * FROM submission_gap_items WHERE case_id = ? ORDER BY created_at ASC').all(caseId);
    return (rows as GapItemRow[]).map(asGapItem);
  }

  updateGapItem(caseId: string, itemId: string, patch: SubmissionGapItemPatch): SubmissionGapItem | undefined {
    const row = this.db.prepare('SELECT * FROM submission_gap_items WHERE id = ? AND case_id = ?').get(itemId, caseId) as GapItemRow | undefined;
    if (!row) return undefined;
    const sets: string[] = [];
    const values: unknown[] = [];
    const assign = (column: string, value: unknown): void => { sets.push(`${column} = ?`); values.push(value); };
    if (patch.severity !== undefined) assign('severity', patch.severity);
    if (patch.title !== undefined) assign('title', patch.title);
    if (patch.problem !== undefined) assign('problem', patch.problem);
    if (patch.evidence !== undefined) assign('evidence', patch.evidence);
    if (patch.sourceType !== undefined) assign('source_type', patch.sourceType);
    if (patch.affectedLocation !== undefined) assign('affected_location', patch.affectedLocation);
    if (patch.recommendedAction !== undefined) assign('recommended_action', patch.recommendedAction);
    if (patch.requiresResearcherJudgment !== undefined) assign('requires_researcher_judgment', patch.requiresResearcherJudgment ? 1 : 0);
    if (patch.estimatedImpact !== undefined) assign('estimated_impact', patch.estimatedImpact);
    if (patch.status !== undefined) assign('status', patch.status);
    if (sets.length === 0) return asGapItem(row);
    assign('updated_at', Date.now());
    values.push(itemId);
    this.db.prepare(`UPDATE submission_gap_items SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return asGapItem(this.db.prepare('SELECT * FROM submission_gap_items WHERE id = ?').get(itemId) as GapItemRow);
  }

  // ── Optimization plans（优化方案 + 条目） ───────────────────

  /** 创建方案及其条目（单事务：方案与条目要么全部落库要么全部回滚）。 */
  createPlan(caseId: string, items: SubmissionOptimizationItemCreateInput[]): { plan: SubmissionOptimizationPlan; items: SubmissionOptimizationItem[] } {
    const now = Date.now();
    const planId = 'sop-' + randomUUID();
    const itemIds: string[] = [];
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO submission_optimization_plans (id,case_id,status,created_at,updated_at) VALUES (?,?,?,?,?)')
        .run(planId, caseId, 'draft', now, now);
      const insert = this.db.prepare(
        'INSERT INTO submission_optimization_items (id,plan_id,gap_item_id,title,action,risk,involves_researcher_judgment,status,before_text,after_text,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      );
      for (const item of items) {
        const id = 'sopi-' + randomUUID();
        insert.run(
          id, planId, item.gapItemId ?? null, item.title ?? '', item.action ?? '', item.risk ?? '',
          item.involvesResearcherJudgment ? 1 : 0, 'pending', item.beforeText ?? '', item.afterText ?? '', now, now,
        );
        itemIds.push(id);
      }
    })();
    return { plan: this.getPlan(planId)!, items: this.listPlanItems(planId).filter((item) => itemIds.includes(item.id)) };
  }

  getPlan(planId: string): SubmissionOptimizationPlan | undefined {
    const row = this.db.prepare('SELECT * FROM submission_optimization_plans WHERE id = ?').get(planId) as PlanRow | undefined;
    return row ? asPlan(row) : undefined;
  }

  latestPlanForCase(caseId: string): SubmissionOptimizationPlan | undefined {
    const row = this.db.prepare(
      'SELECT * FROM submission_optimization_plans WHERE case_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(caseId) as PlanRow | undefined;
    return row ? asPlan(row) : undefined;
  }

  /** 方案状态推进：进入 approved / applied 时打里程碑时间戳（离开不擦除）。 */
  setPlanStatus(planId: string, status: SubmissionPlanStatus): SubmissionOptimizationPlan | undefined {
    const row = this.db.prepare('SELECT * FROM submission_optimization_plans WHERE id = ?').get(planId) as PlanRow | undefined;
    if (!row) return undefined;
    const now = Date.now();
    const sets = ['status = ?', 'updated_at = ?'];
    const values: unknown[] = [status, now];
    const stampColumn = PLAN_STATUS_TIMESTAMP_COLUMN[status];
    if (stampColumn && row[stampColumn] === null) { sets.push(`${stampColumn} = ?`); values.push(now); }
    values.push(planId);
    this.db.prepare(`UPDATE submission_optimization_plans SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return asPlan(this.db.prepare('SELECT * FROM submission_optimization_plans WHERE id = ?').get(planId) as PlanRow);
  }

  listPlanItems(planId: string): SubmissionOptimizationItem[] {
    return (this.db.prepare('SELECT * FROM submission_optimization_items WHERE plan_id = ? ORDER BY created_at ASC').all(planId) as PlanItemRow[]).map(asPlanItem);
  }

  updatePlanItem(planId: string, itemId: string, patch: SubmissionOptimizationItemPatch): SubmissionOptimizationItem | undefined {
    const row = this.db.prepare('SELECT * FROM submission_optimization_items WHERE id = ? AND plan_id = ?').get(itemId, planId) as PlanItemRow | undefined;
    if (!row) return undefined;
    const sets: string[] = [];
    const values: unknown[] = [];
    const assign = (column: string, value: unknown): void => { sets.push(`${column} = ?`); values.push(value); };
    if (patch.title !== undefined) assign('title', patch.title);
    if (patch.action !== undefined) assign('action', patch.action);
    if (patch.risk !== undefined) assign('risk', patch.risk);
    if (patch.involvesResearcherJudgment !== undefined) assign('involves_researcher_judgment', patch.involvesResearcherJudgment ? 1 : 0);
    if (patch.status !== undefined) assign('status', patch.status);
    if (patch.beforeText !== undefined) assign('before_text', patch.beforeText);
    if (patch.afterText !== undefined) assign('after_text', patch.afterText);
    if (patch.outcomeId !== undefined) assign('outcome_id', patch.outcomeId);
    if (patch.outcomeVersion !== undefined) assign('outcome_version', patch.outcomeVersion);
    if (sets.length === 0) return asPlanItem(row);
    assign('updated_at', Date.now());
    values.push(itemId);
    this.db.prepare(`UPDATE submission_optimization_items SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return asPlanItem(this.db.prepare('SELECT * FROM submission_optimization_items WHERE id = ?').get(itemId) as PlanItemRow);
  }
}
