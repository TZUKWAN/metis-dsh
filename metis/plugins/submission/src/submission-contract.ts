/**
 * Submission Runtime Contract — 学术投稿生命周期领域契约（P0）。
 *
 * 领域定位：Research Project → Outcome → **Submission** → Review → Publication。
 * 一个 SubmissionCase = 「某一个确定的成果版本 × 某一个确定的目标期刊」的一次投稿事务；
 * 一个 SubmissionSeries = 同一篇成果跨期刊的完整发表尝试链。
 *
 * 设计原则（与 ResearchLifecycle / DeliverableProfile 同风格）：
 *  - Zod strictObject 契约 + 冻结常量表；
 *  - 投稿周期长达数月，状态必须持久化并由静态转移表驱动；
 *  - Scenario / 浏览器 / 邮件 / 用户操作都只是触发 State Transition，
 *    绝不用一个超长 Agent Run 表示整次投稿。
 */

import { z } from 'zod';

export const SUBMISSION_CONTRACT_VERSION = 1 as const;

/** 事件来源：谁触发了这次状态/记录变更。 */
export const SUBMISSION_EVENT_SOURCES = ['human', 'system', 'browser', 'email', 'agent'] as const;
export type SubmissionEventSource = typeof SUBMISSION_EVENT_SOURCES[number];

/** 已知 timeline 事件类型（开放集合：未知类型允许写入，UI 按 fallback 渲染）。 */
export const SUBMISSION_EVENT_TYPES = [
  'case_created',
  'series_created',
  'journal_selected',
  'status_changed',
  'variant_created',
  'package_frozen',
  'submitted',
  'submission_receipt',
  'decision_received',
  'review_round_created',
  'revision_started',
  'resubmitted',
  'accepted',
  'published',
  'withdrawn',
  'note_added',
] as const;
export type SubmissionEventType = typeof SUBMISSION_EVENT_TYPES[number];

// ─── 状态机 ──────────────────────────────────────────────────

/** 投稿状态机全部状态（用户可见顺序）。 */
export const SUBMISSION_STATUSES = [
  // 准备与选刊
  'DRAFT',
  'TARGETING',
  'JOURNAL_SELECTED',
  // 期刊研究
  'PROFILING',
  'PROFILE_READY',
  // 稿件诊断与优化
  'DIAGNOSING',
  'OPTIMIZATION_PLANNED',
  'OPTIMIZING',
  'READY_FOR_PRECHECK',
  'PRECHECKING',
  'READY_TO_SUBMIT',
  // 提交
  'SUBMITTING',
  'SUBMISSION_STATE_UNCERTAIN',
  'SUBMITTED',
  // 编辑部流转
  'EDITORIAL_CHECK',
  'UNDER_REVIEW',
  // 返修
  'REVISION_REQUIRED',
  'REVISING',
  'READY_TO_RESUBMIT',
  'RESUBMITTED',
  // 录用与发表
  'ACCEPTED',
  'PRODUCTION',
  'PROOFING',
  'PUBLISHED',
  // 终态
  'DESK_REJECTED',
  'REJECTED',
  'WITHDRAWN',
  'CANCELLED',
] as const;

export type SubmissionStatus = typeof SUBMISSION_STATUSES[number];

/**
 * 允许的状态转移表（唯一权威定义）。
 * CANCELLED / WITHDRAWN 作为终态修饰：从任何活跃态可达（在 assert 中单独放行）。
 */
export const SUBMISSION_STATUS_TRANSITIONS: Readonly<Record<SubmissionStatus, readonly SubmissionStatus[]>> = {
  DRAFT: ['TARGETING', 'JOURNAL_SELECTED', 'CANCELLED'],
  TARGETING: ['JOURNAL_SELECTED', 'DRAFT', 'CANCELLED'],
  JOURNAL_SELECTED: ['PROFILING', 'TARGETING', 'CANCELLED'],
  PROFILING: ['PROFILE_READY', 'JOURNAL_SELECTED', 'CANCELLED'],
  PROFILE_READY: ['DIAGNOSING', 'PROFILING', 'CANCELLED'],
  DIAGNOSING: ['OPTIMIZATION_PLANNED', 'PROFILE_READY', 'CANCELLED'],
  OPTIMIZATION_PLANNED: ['OPTIMIZING', 'DIAGNOSING', 'CANCELLED'],
  OPTIMIZING: ['READY_FOR_PRECHECK', 'OPTIMIZATION_PLANNED', 'CANCELLED'],
  READY_FOR_PRECHECK: ['PRECHECKING', 'OPTIMIZING', 'CANCELLED'],
  PRECHECKING: ['READY_TO_SUBMIT', 'OPTIMIZING', 'CANCELLED'],
  READY_TO_SUBMIT: ['SUBMITTING', 'PRECHECKING', 'CANCELLED'],
  // 提交是外部副作用：不确定是否成功时必须进入 UNCERTAIN，禁止盲目重试。
  SUBMITTING: ['SUBMITTED', 'SUBMISSION_STATE_UNCERTAIN', 'READY_TO_SUBMIT', 'CANCELLED'],
  SUBMISSION_STATE_UNCERTAIN: ['SUBMITTED', 'READY_TO_SUBMIT', 'WITHDRAWN'],
  SUBMITTED: ['EDITORIAL_CHECK', 'UNDER_REVIEW', 'DESK_REJECTED', 'REJECTED', 'WITHDRAWN'],
  EDITORIAL_CHECK: ['UNDER_REVIEW', 'SUBMITTED', 'DESK_REJECTED', 'REJECTED', 'WITHDRAWN'],
  UNDER_REVIEW: ['REVISION_REQUIRED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'],
  REVISION_REQUIRED: ['REVISING', 'UNDER_REVIEW', 'REJECTED', 'WITHDRAWN'],
  REVISING: ['READY_TO_RESUBMIT', 'REVISION_REQUIRED', 'WITHDRAWN', 'CANCELLED'],
  READY_TO_RESUBMIT: ['RESUBMITTED', 'REVISING', 'WITHDRAWN', 'CANCELLED'],
  RESUBMITTED: ['UNDER_REVIEW', 'EDITORIAL_CHECK', 'REVISION_REQUIRED', 'REJECTED', 'ACCEPTED', 'WITHDRAWN'],
  ACCEPTED: ['PRODUCTION', 'PUBLISHED', 'WITHDRAWN'],
  PRODUCTION: ['PROOFING', 'PUBLISHED'],
  PROOFING: ['PUBLISHED'],
  PUBLISHED: [],
  DESK_REJECTED: [],
  REJECTED: [],
  WITHDRAWN: [],
  CANCELLED: [],
};

/** 终态：投稿事务关闭（换刊重投 = 新建 Case，挂在同一 Series 下）。 */
export const TERMINAL_SUBMISSION_STATUSES: readonly SubmissionStatus[] = [
  'PUBLISHED', 'DESK_REJECTED', 'REJECTED', 'WITHDRAWN', 'CANCELLED',
];

/** 处于这些状态时，同一成果再开新 Case 视为一稿多投风险。 */
export const ACTIVE_SUBMISSION_STATUSES: readonly SubmissionStatus[] = [
  'SUBMITTING', 'SUBMISSION_STATE_UNCERTAIN', 'SUBMITTED', 'EDITORIAL_CHECK',
  'UNDER_REVIEW', 'REVISION_REQUIRED', 'REVISING', 'READY_TO_RESUBMIT', 'RESUBMITTED',
];

export function isTerminalSubmissionStatus(status: SubmissionStatus): boolean {
  return TERMINAL_SUBMISSION_STATUSES.includes(status);
}

export function isActiveSubmissionStatus(status: SubmissionStatus): boolean {
  return ACTIVE_SUBMISSION_STATUSES.includes(status);
}

export function canTransitionSubmissionStatus(from: SubmissionStatus, to: SubmissionStatus): boolean {
  if (from === to) return true; // 幂等重申允许
  return SUBMISSION_STATUS_TRANSITIONS[from].includes(to);
}

/** 唯一状态变更门：所有状态落库必须经过这里。 */
export function assertSubmissionStatusTransition(from: SubmissionStatus, to: SubmissionStatus): void {
  if (!canTransitionSubmissionStatus(from, to)) {
    throw new Error(
      `Illegal submission status transition: '${from}' -> '${to}'. ` +
        `Allowed from '${from}': [${SUBMISSION_STATUS_TRANSITIONS[from].join(', ')}].`,
    );
  }
}

// ─── 实体契约 ────────────────────────────────────────────────

export const SUBMISSION_ARTICLE_TYPES = [
  'research_article', 'review', 'short_communication', 'letter', 'case_report',
  'conference_paper', 'thesis_chapter', 'other',
] as const;
export type SubmissionArticleType = typeof SUBMISSION_ARTICLE_TYPES[number];

export const SUBMISSION_METHODS = ['portal_web', 'email', 'offline_manual'] as const;
export type SubmissionMethod = typeof SUBMISSION_METHODS[number];

/** 选刊前置条件：投稿层级（用户勾选，属约束而非 AI 判断）。 */
export const SUBMISSION_VENUE_CATEGORIES = [
  'conference',   // 会议
  'sci',          // SCI
  'ssci',         // SSCI
  'cssci',        // CSSCI
  'cscd',         // CSCD
  'pku_core',     // 北大核心
  'cn_general',   // 中文普刊（知网/维普/万方检索）
  'en_general',   // 英文普刊（谷歌学术等检索）
] as const;
export type SubmissionVenueCategory = typeof SUBMISSION_VENUE_CATEGORIES[number];

export const SUBMISSION_TARGETING_LANGUAGES = ['zh', 'en', 'any'] as const;
export type SubmissionTargetingLanguage = typeof SUBMISSION_TARGETING_LANGUAGES[number];

/** 选刊条件（简单前置过滤：层级 + 语言）。 */
export const TargetingCriteriaSchema = z.strictObject({
  categories: z.array(z.enum(SUBMISSION_VENUE_CATEGORIES)).min(1).max(SUBMISSION_VENUE_CATEGORIES.length),
  language: z.enum(SUBMISSION_TARGETING_LANGUAGES).default('any'),
  notes: z.string().max(2000).default(''),
});
export type TargetingCriteria = z.infer<typeof TargetingCriteriaSchema>;

const timestamp = z.number().int().nonnegative();
const optionalTimestamp = timestamp.nullable();

/** 投稿事务（Submission Case）。 */
export const SubmissionCaseSchema = z.strictObject({
  contractVersion: z.literal(SUBMISSION_CONTRACT_VERSION),
  id: z.string().min(1),
  seriesId: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().max(500).default(''),
  status: z.enum(SUBMISSION_STATUSES),
  articleType: z.enum(SUBMISSION_ARTICLE_TYPES).nullable().default(null),
  // 目标期刊（P0 存名称与可选外部标识；P1 引入 journal_profiles 外键）
  targetJournalName: z.string().max(300).default(''),
  targetJournalId: z.string().nullable().default(null),
  // 成果链接：源成果（只读事实）、工作稿（可继续修改）、已提交冻结版
  sourceOutcomeId: z.string().nullable().default(null),
  sourceOutcomeVersion: z.number().int().positive().nullable().default(null),
  workingOutcomeId: z.string().nullable().default(null),
  workingOutcomeVersion: z.number().int().positive().nullable().default(null),
  submittedOutcomeVersion: z.number().int().positive().nullable().default(null),
  submissionMethod: z.enum(SUBMISSION_METHODS).nullable().default(null),
  submissionPortalUrl: z.string().max(2000).default(''),
  remoteSubmissionId: z.string().max(300).default(''),
  notes: z.string().max(20000).default(''),
  // 选刊前置条件（层级/语言），仅 TARGETING 阶段有意义。
  targetingCriteria: TargetingCriteriaSchema.nullable().default(null),
  createdAt: timestamp,
  updatedAt: timestamp,
  submittedAt: optionalTimestamp.default(null),
  decisionAt: optionalTimestamp.default(null),
  acceptedAt: optionalTimestamp.default(null),
  publishedAt: optionalTimestamp.default(null),
});
export type SubmissionCase = z.infer<typeof SubmissionCaseSchema>;

/** 发表尝试链（同一篇成果 × 多个期刊）。 */
export const SubmissionSeriesSchema = z.strictObject({
  contractVersion: z.literal(SUBMISSION_CONTRACT_VERSION),
  id: z.string().min(1),
  projectId: z.string().min(1),
  sourceOutcomeId: z.string().nullable().default(null),
  title: z.string().max(500).default(''),
  notes: z.string().max(20000).default(''),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type SubmissionSeries = z.infer<typeof SubmissionSeriesSchema>;

/** Timeline 事件（append-only，禁止改写历史）。 */
export const SubmissionEventSchema = z.strictObject({
  id: z.string().min(1),
  caseId: z.string().min(1),
  type: z.string().max(60),
  source: z.enum(SUBMISSION_EVENT_SOURCES).default('human'),
  sourceId: z.string().max(300).nullable().default(null),
  actor: z.string().max(120).default(''),
  description: z.string().max(2000).default(''),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: timestamp,
});
export type SubmissionEvent = z.infer<typeof SubmissionEventSchema>;

// ─── 创建/更新请求 ───────────────────────────────────────────

export const SubmissionCaseCreateRequestSchema = z.strictObject({
  projectId: z.string().min(1),
  title: z.string().max(500).default(''),
  sourceOutcomeId: z.string().min(1),
  sourceOutcomeVersion: z.number().int().positive(),
  targetJournalName: z.string().max(300).default(''),
  articleType: z.enum(SUBMISSION_ARTICLE_TYPES).nullable().default(null),
  seriesId: z.string().min(1).nullable().default(null), // 为空则自动建 Series
  notes: z.string().max(20000).default(''),
  targetingCriteria: TargetingCriteriaSchema.nullable().default(null),
  initialStatus: z.enum(['DRAFT', 'TARGETING', 'JOURNAL_SELECTED']).default('DRAFT'),
});
export type SubmissionCaseCreateRequest = z.infer<typeof SubmissionCaseCreateRequestSchema>;
/** 渲染层可省略带默认值的字段（preload 入参用 input 型）。 */
export type SubmissionCaseCreateInput = z.input<typeof SubmissionCaseCreateRequestSchema>;

export const SubmissionStatusChangeRequestSchema = z.strictObject({
  caseId: z.string().min(1),
  to: z.enum(SUBMISSION_STATUSES),
  reason: z.string().max(2000).default(''),
  actor: z.string().max(120).default('human'),
  source: z.enum(SUBMISSION_EVENT_SOURCES).default('human'),
});
export type SubmissionStatusChangeRequest = z.infer<typeof SubmissionStatusChangeRequestSchema>;

/** Case 可变字段（id/series/project/时间戳/冻结的 submitted 版本不可经此修改）。 */
export const SubmissionCaseUpdateRequestSchema = z.strictObject({
  caseId: z.string().min(1),
  title: z.string().max(500).optional(),
  articleType: z.enum(SUBMISSION_ARTICLE_TYPES).nullable().optional(),
  targetJournalName: z.string().max(300).optional(),
  targetJournalId: z.string().nullable().optional(),
  workingOutcomeId: z.string().nullable().optional(),
  workingOutcomeVersion: z.number().int().positive().nullable().optional(),
  submissionMethod: z.enum(SUBMISSION_METHODS).nullable().optional(),
  submissionPortalUrl: z.string().max(2000).optional(),
  remoteSubmissionId: z.string().max(300).optional(),
  notes: z.string().max(20000).optional(),
  targetingCriteria: TargetingCriteriaSchema.nullable().optional(),
});
export type SubmissionCaseUpdateRequest = z.infer<typeof SubmissionCaseUpdateRequestSchema>;

/**
 * 已提交版本冻结规则：`submittedOutcomeVersion` 不在 SubmissionCaseUpdateRequestSchema
 * 的可变字段中——结构上就无法经 update 修改。编辑部当前持有的版本只能由
 * 状态机推进（READY_TO_SUBMIT → SUBMITTING → SUBMITTED）时由 repository 写入；
 * 后续稿件修改必须走 Outcomes 版本链产生新版本，绝不覆盖已提交版。
 */

/** 生命周期进度条的阶段归并（UI 用）：状态 → 用户语言阶段。 */
export const SUBMISSION_LIFECYCLE_STAGES = [
  'targeting', 'profiling', 'diagnosis', 'optimization', 'precheck', 'materials',
  'submitting', 'tracking', 'revision', 'accepted',
] as const;
export type SubmissionLifecycleStage = typeof SUBMISSION_LIFECYCLE_STAGES[number];

export function submissionLifecycleStage(status: SubmissionStatus): SubmissionLifecycleStage | 'closed' {
  if (status === 'DRAFT' || status === 'TARGETING') return 'targeting';
  if (status === 'JOURNAL_SELECTED' || status === 'PROFILING' || status === 'PROFILE_READY') return 'profiling';
  if (status === 'DIAGNOSING') return 'diagnosis';
  if (status === 'OPTIMIZATION_PLANNED' || status === 'OPTIMIZING') return 'optimization';
  if (status === 'READY_FOR_PRECHECK' || status === 'PRECHECKING') return 'precheck';
  if (status === 'READY_TO_SUBMIT') return 'materials';
  if (status === 'SUBMITTING' || status === 'SUBMISSION_STATE_UNCERTAIN') return 'submitting';
  if (status === 'SUBMITTED' || status === 'EDITORIAL_CHECK' || status === 'UNDER_REVIEW') return 'tracking';
  if (status === 'REVISION_REQUIRED' || status === 'REVISING' || status === 'READY_TO_RESUBMIT' || status === 'RESUBMITTED') return 'revision';
  if (status === 'ACCEPTED' || status === 'PRODUCTION' || status === 'PROOFING') return 'accepted';
  if (status === 'PUBLISHED') return 'accepted';
  return 'closed';
}
