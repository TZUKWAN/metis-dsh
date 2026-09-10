/**
 * Journal Profile Contract — 学术投稿生命周期 P1（期刊研究）领域契约。
 *
 * 领域定位：SubmissionCase 进入 PROFILING 阶段后，围绕目标期刊建立
 * JournalProfile（期刊档案）→ Snapshot（一次研究快照）→
 * Requirements（官方硬约束）/ Corpus（已发表语料）/ PatternObservations（软范式）
 * → GapItems（差距诊断）→ OptimizationPlan（优化方案）。
 *
 * 设计原则（与 SubmissionRuntimeContract 同风格）：
 *  - Zod strictObject 契约 + 冻结常量表；
 *  - 官方要求（JournalRequirement，ruleType 固定 'official_requirement'）与
 *    语料归纳出的软范式（JournalPatternObservation）严格分表存放，禁止混淆证据等级；
 *  - 所有证据字段（sourceUrl / evidenceSnippet / confidence）必须随记录持久化，
 *    不允许只存结论不存出处。
 */

import { z } from 'zod';

/** 投稿平台类型（影响后续浏览器自动化策略）。 */
export const JOURNAL_PLATFORMS = [
  'scholarone',
  'editorial_manager',
  'ojs',
  'generic_web',
  'email',
  'unknown',
] as const;
export type JournalPlatform = typeof JOURNAL_PLATFORMS[number];

/** 官方投稿要求的规则类别（硬约束，只来自期刊官方来源）。 */
export const JOURNAL_REQUIREMENT_RULE_KEYS = [
  'word_limit',
  'abstract_limit',
  'keywords',
  'section_structure',
  'reference_style',
  'figures_tables',
  'supplementary',
  'blind_review',
  'title_page',
  'author_info',
  'funding',
  'conflict_of_interest',
  'ethics',
  'data_availability',
  'ai_policy',
  'cover_letter',
  'copyright_license',
  'article_types',
  'submission_method',
  'other',
] as const;
export type JournalRequirementRuleKey = typeof JOURNAL_REQUIREMENT_RULE_KEYS[number];

/** 证据置信度。 */
export const JOURNAL_CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type JournalConfidence = typeof JOURNAL_CONFIDENCE_LEVELS[number];

/** 语料条目来源。 */
export const JOURNAL_CORPUS_SOURCES = ['openalex', 'crossref', 'ncpssd', 'browser'] as const;
export type JournalCorpusSource = typeof JOURNAL_CORPUS_SOURCES[number];

/** 软范式观察的切面（标题/摘要/各章节/引用/整体结构）。 */
export const JOURNAL_PATTERN_KEYS = [
  'title',
  'abstract',
  'introduction',
  'literature_review',
  'theory',
  'method',
  'results',
  'discussion',
  'conclusion',
  'citation',
  'structure',
  'other',
] as const;
export type JournalPatternKey = typeof JOURNAL_PATTERN_KEYS[number];

/** 范式观察的证据等级：只看元数据 < 读了摘要 < 读了全文。 */
export const JOURNAL_PATTERN_EVIDENCE_LEVELS = ['metadata_only', 'abstract', 'fulltext'] as const;
export type JournalPatternEvidenceLevel = typeof JOURNAL_PATTERN_EVIDENCE_LEVELS[number];

/** 差距项严重度。 */
export const SUBMISSION_GAP_SEVERITIES = ['must_fix', 'strongly_recommended', 'optional'] as const;
export type SubmissionGapSeverity = typeof SUBMISSION_GAP_SEVERITIES[number];

/** 差距项证据来源类型（与硬约束/软范式的分离对应）。 */
export const SUBMISSION_GAP_SOURCE_TYPES = ['official_requirement', 'published_pattern', 'manuscript'] as const;
export type SubmissionGapSourceType = typeof SUBMISSION_GAP_SOURCE_TYPES[number];

/** 差距项状态。 */
export const SUBMISSION_GAP_STATUSES = ['open', 'planned', 'applied', 'dismissed', 'verified'] as const;
export type SubmissionGapStatus = typeof SUBMISSION_GAP_STATUSES[number];

/** 预估影响。 */
export const SUBMISSION_IMPACT_LEVELS = ['high', 'medium', 'low'] as const;
export type SubmissionImpactLevel = typeof SUBMISSION_IMPACT_LEVELS[number];

/** 优化方案状态。 */
export const SUBMISSION_PLAN_STATUSES = ['draft', 'approved', 'applying', 'applied', 'verified'] as const;
export type SubmissionPlanStatus = typeof SUBMISSION_PLAN_STATUSES[number];

/** 优化条目状态。 */
export const SUBMISSION_PLAN_ITEM_STATUSES = ['pending', 'selected', 'skipped', 'applied', 'failed'] as const;
export type SubmissionPlanItemStatus = typeof SUBMISSION_PLAN_ITEM_STATUSES[number];

const timestamp = z.number().int().nonnegative();
const optionalTimestamp = timestamp.nullable();

// ─── 实体契约 ────────────────────────────────────────────────

/** 期刊档案（同一项目下按刊名/ISSN 去重，软删除）。 */
export const JournalProfileSchema = z.strictObject({
  id: z.string().min(1),
  projectId: z.string().min(1),
  canonicalName: z.string().min(1).max(300),
  issn: z.string().max(20).nullable().default(null),
  publisher: z.string().max(300).default(''),
  homepageUrl: z.string().max(2000).default(''),
  submissionPortalUrl: z.string().max(2000).default(''),
  platform: z.enum(JOURNAL_PLATFORMS).default('unknown'),
  articleTypes: z.array(z.string().max(120)).default([]),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type JournalProfile = z.infer<typeof JournalProfileSchema>;

/** 一次期刊研究快照（caseId 可空：允许脱离具体投稿事务的独立期刊研究）。 */
export const JournalProfileSnapshotSchema = z.strictObject({
  id: z.string().min(1),
  profileId: z.string().min(1),
  caseId: z.string().nullable().default(null),
  retrievedAt: timestamp,
  note: z.string().max(20000).default(''),
  createdAt: timestamp,
});
export type JournalProfileSnapshot = z.infer<typeof JournalProfileSnapshotSchema>;

/**
 * 官方投稿要求（硬约束）。ruleType 固定为 'official_requirement'，
 * 结构上防止把语料归纳的软范式写进硬约束表。
 */
export const JournalRequirementSchema = z.strictObject({
  id: z.string().min(1),
  snapshotId: z.string().min(1),
  ruleKey: z.enum(JOURNAL_REQUIREMENT_RULE_KEYS),
  valueText: z.string().max(20000).default(''),
  ruleType: z.literal('official_requirement'),
  sourceUrl: z.string().max(2000).default(''),
  sourceTitle: z.string().max(500).default(''),
  evidenceSnippet: z.string().max(20000).default(''),
  confidence: z.enum(JOURNAL_CONFIDENCE_LEVELS).default('medium'),
  retrievedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type JournalRequirement = z.infer<typeof JournalRequirementSchema>;

/** 期刊已发表文章语料条目（用于归纳软范式）。 */
export const JournalCorpusItemSchema = z.strictObject({
  id: z.string().min(1),
  profileId: z.string().min(1),
  snapshotId: z.string().nullable().default(null),
  title: z.string().max(1000).default(''),
  authors: z.array(z.string().max(300)).default([]),
  year: z.number().int().nullable().default(null),
  doi: z.string().max(300).default(''),
  url: z.string().max(2000).default(''),
  abstract: z.string().max(50000).default(''),
  source: z.enum(JOURNAL_CORPUS_SOURCES).default('browser'),
  venueName: z.string().max(300).default(''),
  issn: z.string().max(20).default(''),
  similarityScore: z.number().nullable().default(null),
  fulltextAvailable: z.boolean().default(false),
  createdAt: timestamp,
});
export type JournalCorpusItem = z.infer<typeof JournalCorpusItemSchema>;

/** 软范式观察（来自语料归纳，与官方硬约束严格分离）。 */
export const JournalPatternObservationSchema = z.strictObject({
  id: z.string().min(1),
  snapshotId: z.string().min(1),
  patternKey: z.enum(JOURNAL_PATTERN_KEYS),
  observation: z.string().max(20000).default(''),
  evidenceLevel: z.enum(JOURNAL_PATTERN_EVIDENCE_LEVELS).default('metadata_only'),
  sampleSize: z.number().int().nonnegative().default(0),
  supportingItemIds: z.array(z.string().min(1)).default([]),
  confidence: z.enum(JOURNAL_CONFIDENCE_LEVELS).default('medium'),
  createdAt: timestamp,
});
export type JournalPatternObservation = z.infer<typeof JournalPatternObservationSchema>;

/** 投稿差距项（诊断结论：稿件相对要求/范式的差距）。 */
export const SubmissionGapItemSchema = z.strictObject({
  id: z.string().min(1),
  caseId: z.string().min(1),
  severity: z.enum(SUBMISSION_GAP_SEVERITIES),
  title: z.string().max(500).default(''),
  problem: z.string().max(20000).default(''),
  evidence: z.string().max(20000).default(''),
  sourceType: z.enum(SUBMISSION_GAP_SOURCE_TYPES),
  affectedLocation: z.string().max(500).default(''),
  recommendedAction: z.string().max(20000).default(''),
  requiresResearcherJudgment: z.boolean().default(false),
  estimatedImpact: z.enum(SUBMISSION_IMPACT_LEVELS).default('medium'),
  status: z.enum(SUBMISSION_GAP_STATUSES).default('open'),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type SubmissionGapItem = z.infer<typeof SubmissionGapItemSchema>;

/** 投稿优化方案（一份方案 = 一组优化条目）。 */
export const SubmissionOptimizationPlanSchema = z.strictObject({
  id: z.string().min(1),
  caseId: z.string().min(1),
  status: z.enum(SUBMISSION_PLAN_STATUSES).default('draft'),
  createdAt: timestamp,
  updatedAt: timestamp,
  approvedAt: optionalTimestamp.default(null),
  appliedAt: optionalTimestamp.default(null),
});
export type SubmissionOptimizationPlan = z.infer<typeof SubmissionOptimizationPlanSchema>;

/** 优化条目（可关联差距项；应用后可回链到成果版本）。 */
export const SubmissionOptimizationItemSchema = z.strictObject({
  id: z.string().min(1),
  planId: z.string().min(1),
  gapItemId: z.string().nullable().default(null),
  title: z.string().max(500).default(''),
  action: z.string().max(20000).default(''),
  risk: z.string().max(20000).default(''),
  involvesResearcherJudgment: z.boolean().default(false),
  status: z.enum(SUBMISSION_PLAN_ITEM_STATUSES).default('pending'),
  beforeText: z.string().max(50000).default(''),
  afterText: z.string().max(50000).default(''),
  outcomeId: z.string().nullable().default(null),
  outcomeVersion: z.number().int().positive().nullable().default(null),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type SubmissionOptimizationItem = z.infer<typeof SubmissionOptimizationItemSchema>;

// ─── 创建/更新请求 ───────────────────────────────────────────

/** 期刊档案 upsert 入参（按 projectId + canonicalName / issn 去重）。 */
export const JournalProfileUpsertRequestSchema = z.strictObject({
  canonicalName: z.string().min(1).max(300),
  issn: z.string().max(20).nullable().default(null),
  publisher: z.string().max(300).default(''),
  homepageUrl: z.string().max(2000).default(''),
  submissionPortalUrl: z.string().max(2000).default(''),
  platform: z.enum(JOURNAL_PLATFORMS).default('unknown'),
  articleTypes: z.array(z.string().max(120)).default([]),
});
export type JournalProfileUpsertRequest = z.infer<typeof JournalProfileUpsertRequestSchema>;
/** 调用方可省略带默认值的字段。 */
export type JournalProfileUpsertInput = z.input<typeof JournalProfileUpsertRequestSchema>;

/** 官方要求写入入参（snapshotId / id / 时间戳由仓储填充）。 */
export const JournalRequirementCreateRequestSchema = z.strictObject({
  ruleKey: z.enum(JOURNAL_REQUIREMENT_RULE_KEYS),
  valueText: z.string().max(20000).default(''),
  sourceUrl: z.string().max(2000).default(''),
  sourceTitle: z.string().max(500).default(''),
  evidenceSnippet: z.string().max(20000).default(''),
  confidence: z.enum(JOURNAL_CONFIDENCE_LEVELS).default('medium'),
  retrievedAt: timestamp.optional(),
});
export type JournalRequirementCreateRequest = z.infer<typeof JournalRequirementCreateRequestSchema>;
export type JournalRequirementCreateInput = z.input<typeof JournalRequirementCreateRequestSchema>;

/** 语料条目写入入参。 */
export const JournalCorpusItemCreateRequestSchema = z.strictObject({
  title: z.string().max(1000).default(''),
  authors: z.array(z.string().max(300)).default([]),
  year: z.number().int().nullable().default(null),
  doi: z.string().max(300).default(''),
  url: z.string().max(2000).default(''),
  abstract: z.string().max(50000).default(''),
  source: z.enum(JOURNAL_CORPUS_SOURCES).default('browser'),
  venueName: z.string().max(300).default(''),
  issn: z.string().max(20).default(''),
  similarityScore: z.number().nullable().default(null),
  fulltextAvailable: z.boolean().default(false),
});
export type JournalCorpusItemCreateRequest = z.infer<typeof JournalCorpusItemCreateRequestSchema>;
export type JournalCorpusItemCreateInput = z.input<typeof JournalCorpusItemCreateRequestSchema>;

/** 软范式观察写入入参。 */
export const JournalPatternObservationCreateRequestSchema = z.strictObject({
  patternKey: z.enum(JOURNAL_PATTERN_KEYS),
  observation: z.string().max(20000).default(''),
  evidenceLevel: z.enum(JOURNAL_PATTERN_EVIDENCE_LEVELS).default('metadata_only'),
  sampleSize: z.number().int().nonnegative().default(0),
  supportingItemIds: z.array(z.string().min(1)).default([]),
  confidence: z.enum(JOURNAL_CONFIDENCE_LEVELS).default('medium'),
});
export type JournalPatternObservationCreateRequest = z.infer<typeof JournalPatternObservationCreateRequestSchema>;
export type JournalPatternObservationCreateInput = z.input<typeof JournalPatternObservationCreateRequestSchema>;

/** 差距项创建入参。 */
export const SubmissionGapItemCreateRequestSchema = z.strictObject({
  severity: z.enum(SUBMISSION_GAP_SEVERITIES),
  title: z.string().max(500).default(''),
  problem: z.string().max(20000).default(''),
  evidence: z.string().max(20000).default(''),
  sourceType: z.enum(SUBMISSION_GAP_SOURCE_TYPES),
  affectedLocation: z.string().max(500).default(''),
  recommendedAction: z.string().max(20000).default(''),
  requiresResearcherJudgment: z.boolean().default(false),
  estimatedImpact: z.enum(SUBMISSION_IMPACT_LEVELS).default('medium'),
});
export type SubmissionGapItemCreateRequest = z.infer<typeof SubmissionGapItemCreateRequestSchema>;
export type SubmissionGapItemCreateInput = z.input<typeof SubmissionGapItemCreateRequestSchema>;

/** 差距项可变字段（id/caseId/createdAt 不可经此修改）。 */
export const SubmissionGapItemPatchSchema = z.strictObject({
  severity: z.enum(SUBMISSION_GAP_SEVERITIES).optional(),
  title: z.string().max(500).optional(),
  problem: z.string().max(20000).optional(),
  evidence: z.string().max(20000).optional(),
  sourceType: z.enum(SUBMISSION_GAP_SOURCE_TYPES).optional(),
  affectedLocation: z.string().max(500).optional(),
  recommendedAction: z.string().max(20000).optional(),
  requiresResearcherJudgment: z.boolean().optional(),
  estimatedImpact: z.enum(SUBMISSION_IMPACT_LEVELS).optional(),
  status: z.enum(SUBMISSION_GAP_STATUSES).optional(),
});
export type SubmissionGapItemPatch = z.infer<typeof SubmissionGapItemPatchSchema>;

/** 优化条目创建入参（随 createPlan 一并写入）。 */
export const SubmissionOptimizationItemCreateRequestSchema = z.strictObject({
  gapItemId: z.string().nullable().default(null),
  title: z.string().max(500).default(''),
  action: z.string().max(20000).default(''),
  risk: z.string().max(20000).default(''),
  involvesResearcherJudgment: z.boolean().default(false),
  beforeText: z.string().max(50000).default(''),
  afterText: z.string().max(50000).default(''),
});
export type SubmissionOptimizationItemCreateRequest = z.infer<typeof SubmissionOptimizationItemCreateRequestSchema>;
export type SubmissionOptimizationItemCreateInput = z.input<typeof SubmissionOptimizationItemCreateRequestSchema>;

/** 优化条目可变字段（id/planId/gapItemId/createdAt 不可经此修改）。 */
export const SubmissionOptimizationItemPatchSchema = z.strictObject({
  title: z.string().max(500).optional(),
  action: z.string().max(20000).optional(),
  risk: z.string().max(20000).optional(),
  involvesResearcherJudgment: z.boolean().optional(),
  status: z.enum(SUBMISSION_PLAN_ITEM_STATUSES).optional(),
  beforeText: z.string().max(50000).optional(),
  afterText: z.string().max(50000).optional(),
  outcomeId: z.string().nullable().optional(),
  outcomeVersion: z.number().int().positive().nullable().optional(),
});
export type SubmissionOptimizationItemPatch = z.infer<typeof SubmissionOptimizationItemPatchSchema>;
