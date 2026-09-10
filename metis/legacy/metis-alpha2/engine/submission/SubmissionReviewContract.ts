/**
 * SubmissionReviewContract — 审稿轮次与审稿意见领域契约（P4）。
 *
 * ReviewRound 对应一次 Decision（含编辑信原文，永久保留不改写）；
 * ReviewerComment 是拆解后的独立意见，可关联修改位置、修改前后文与回复文本。
 * 原始意见文本 originalText 只进不出——任何归一化都存 normalizedText，不覆盖原文。
 */
import { z } from 'zod';

export const SUBMISSION_REVIEW_DECISIONS = ['accept', 'minor_revision', 'major_revision', 'reject', 'resubmit', 'unclear'] as const;
export const SUBMISSION_REVIEW_DECISIONS_SCHEMA = z.enum(SUBMISSION_REVIEW_DECISIONS);
export type SubmissionReviewDecision = (typeof SUBMISSION_REVIEW_DECISIONS)[number];

export const REVIEW_COMMENT_CATEGORIES = ['major', 'minor', 'editorial', 'clarification', 'other'] as const;
export const REVIEW_COMMENT_CATEGORIES_SCHEMA = z.enum(REVIEW_COMMENT_CATEGORIES);
export type ReviewCommentCategory = (typeof REVIEW_COMMENT_CATEGORIES)[number];

export const REVIEW_COMMENT_STATUSES = ['open', 'in_revision', 'addressed', 'dismissed'] as const;
export const SUBMISSION_REVIEW_COMMENT_STATUSES = REVIEW_COMMENT_STATUSES;
export const REVIEW_COMMENT_STATUSES_SCHEMA = z.enum(REVIEW_COMMENT_STATUSES);
export type ReviewCommentStatus = (typeof REVIEW_COMMENT_STATUSES)[number];

export const ReviewRoundSchema = z.strictObject({
  id: z.string().min(1),
  caseId: z.string().min(1),
  roundNo: z.number().int().positive(),
  decision: SUBMISSION_REVIEW_DECISIONS_SCHEMA,
  receivedAt: z.number().int().nonnegative(),
  /** Decision Letter 中识别的返修截止时间（毫秒时间戳）；无法识别为 null。 */
  deadline: z.number().int().nonnegative().nullable(),
  /** 编辑信全文逐字保存——禁止改写后丢弃原文。 */
  decisionLetterText: z.string(),
  submittedOutcomeVersion: z.number().int().positive().nullable(),
  revisedOutcomeVersion: z.number().int().positive().nullable(),
  responseLetterOutcomeId: z.string().nullable(),
  note: z.string(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type ReviewRound = z.infer<typeof ReviewRoundSchema>;

export const ReviewerCommentSchema = z.strictObject({
  id: z.string().min(1),
  roundId: z.string().min(1),
  reviewerLabel: z.string(),
  /** 原始意见（逐字保留）。 */
  originalText: z.string(),
  /** 归一化/摘要文本；允许为空（未做归一化时与 originalText 一致或留空）。 */
  normalizedText: z.string(),
  category: REVIEW_COMMENT_CATEGORIES_SCHEMA,
  priority: z.enum(['high', 'medium', 'low']),
  status: REVIEW_COMMENT_STATUSES_SCHEMA,
  affectedLocation: z.string(),
  beforeText: z.string(),
  afterText: z.string(),
  responseText: z.string(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type ReviewerComment = z.infer<typeof ReviewerCommentSchema>;

export const ReviewRoundCreateInputSchema = z.strictObject({
  projectId: z.string().min(1),
  caseId: z.string().min(1),
  decisionLetterText: z.string().min(1).max(200_000),
  decision: SUBMISSION_REVIEW_DECISIONS_SCHEMA.default('unclear'),
  receivedAt: z.number().int().nonnegative().optional(),
  deadline: z.number().int().nonnegative().nullable().default(null),
});
export type ReviewRoundCreateInput = z.input<typeof ReviewRoundCreateInputSchema>;

export const ReviewCommentCreateInputSchema = z.strictObject({
  roundId: z.string().min(1),
  reviewerLabel: z.string().max(120).default(''),
  originalText: z.string().min(1).max(20_000),
  category: REVIEW_COMMENT_CATEGORIES_SCHEMA.default('other'),
});
export type ReviewCommentCreateInput = z.input<typeof ReviewCommentCreateInputSchema>;

export const ReviewCommentPatchSchema = z.strictObject({
  category: REVIEW_COMMENT_CATEGORIES_SCHEMA.optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  status: REVIEW_COMMENT_STATUSES_SCHEMA.optional(),
  affectedLocation: z.string().max(500).optional(),
  beforeText: z.string().max(20_000).optional(),
  afterText: z.string().max(20_000).optional(),
  responseText: z.string().max(20_000).optional(),
});
export type ReviewCommentPatch = z.input<typeof ReviewCommentPatchSchema>;

/** Decision Letter 解析结果：decision 判定 + 意见拆分。全部字段带确定性来源说明。 */
export interface DecisionParseResult {
  decision: SubmissionReviewDecision;
  /** 判定依据的关键词命中说明（空字符串表示未能判定，回退 unclear）。 */
  decisionEvidence: string;
  deadline: number | null;
  deadlineEvidence: string;
  editorComments: Array<{ reviewerLabel: string; text: string }>;
  reviewerComments: Array<{ reviewerLabel: string; text: string }>;
  /** 解析方式：deterministic=纯规则切分；llm=规则失败后模型辅助切分。 */
  method: 'deterministic' | 'llm';
}
