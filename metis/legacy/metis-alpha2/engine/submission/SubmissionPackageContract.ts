/**
 * Submission Package & Preflight Contract — 学术投稿生命周期 P2（投稿预检 + 投稿包）领域契约。
 *
 * 领域定位：SubmissionCase 进入 PRECHECKING / READY_TO_SUBMIT 阶段后，
 * 围绕「投稿包（SubmissionPackage）」与「投稿预检（SubmissionPreflightRun）」建模：
 *  - PreflightRun = 一次确定性预检的完整结果（一组 Check），只追加不改写；
 *  - Package = 一轮投稿的材料清单（首轮 1，返修后重投 2…），freeze 后不可再改。
 *
 * 设计原则（与 JournalProfileContract 同风格）：
 *  - Zod strictObject 契约 + 冻结常量表；
 *  - 预检全部确定性：无官方要求证据的规则一律 warn「未抓取官方要求」，
 *    禁止凭空编造 pass；
 *  - package frozen 是硬边界：冻结后任何文件增删改都被仓储层拒绝。
 */

import { z } from 'zod';

/** 预检检查项键（固定枚举，UI 按 key 分组渲染）。 */
export const SUBMISSION_PREFLIGHT_CHECK_KEYS = [
  'word_count',
  'abstract',
  'keywords',
  'section_structure',
  'reference_style',
  'figures_tables',
  'blind_author_names',
  'blind_affiliation',
  'blind_acknowledgement',
  'statement_funding',
  'statement_coi',
  'statement_ethics',
  'statement_data_availability',
  'file_main_manuscript',
  'file_title_page',
  'file_cover_letter',
  'file_supplementary',
  'ai_policy',
  'other',
] as const;
export type SubmissionPreflightCheckKey = typeof SUBMISSION_PREFLIGHT_CHECK_KEYS[number];

/** 检查结论等级：block = 阻断提交；warn = 需人工确认；pass = 通过。 */
export const SUBMISSION_PREFLIGHT_CHECK_LEVELS = ['pass', 'warn', 'block'] as const;
export type SubmissionPreflightCheckLevel = typeof SUBMISSION_PREFLIGHT_CHECK_LEVELS[number];

/** 检查来源：deterministic = 纯文档事实；requirement = 对照官方要求；user = 用户标注。 */
export const SUBMISSION_PREFLIGHT_CHECK_SOURCES = ['deterministic', 'requirement', 'user'] as const;
export type SubmissionPreflightCheckSource = typeof SUBMISSION_PREFLIGHT_CHECK_SOURCES[number];

/** 投稿包文件类型（覆盖常见期刊材料清单）。 */
export const SUBMISSION_PACKAGE_FILE_TYPES = [
  'main_manuscript',
  'blinded_manuscript',
  'title_page',
  'cover_letter',
  'author_info',
  'coi_statement',
  'funding_statement',
  'ethics_statement',
  'data_availability_statement',
  'highlights',
  'graphical_abstract',
  'supplementary',
  'response_to_reviewers',
  'other',
] as const;
export type SubmissionPackageFileType = typeof SUBMISSION_PACKAGE_FILE_TYPES[number];

/** 投稿包文件校验状态。 */
export const SUBMISSION_PACKAGE_FILE_VALIDATION_STATUSES = [
  'pending',
  'valid',
  'invalid',
  'needs_confirmation',
] as const;
export type SubmissionPackageFileValidationStatus = typeof SUBMISSION_PACKAGE_FILE_VALIDATION_STATUSES[number];

/** 投稿包状态：draft 可编辑；frozen 冻结（提交前锁定材料清单）。 */
export const SUBMISSION_PACKAGE_STATUSES = ['draft', 'frozen'] as const;
export type SubmissionPackageStatus = typeof SUBMISSION_PACKAGE_STATUSES[number];

const timestamp = z.number().int().nonnegative();
const optionalTimestamp = timestamp.nullable();

// ─── 实体契约 ────────────────────────────────────────────────

/** 单条预检检查结论（随 run 落库，append-only）。 */
export const SubmissionPreflightCheckSchema = z.strictObject({
  id: z.string().min(1),
  caseId: z.string().min(1),
  runId: z.string().min(1),
  checkKey: z.enum(SUBMISSION_PREFLIGHT_CHECK_KEYS),
  label: z.string().max(300).default(''),
  level: z.enum(SUBMISSION_PREFLIGHT_CHECK_LEVELS),
  detail: z.string().max(20000).default(''),
  source: z.enum(SUBMISSION_PREFLIGHT_CHECK_SOURCES).default('deterministic'),
  createdAt: timestamp,
});
export type SubmissionPreflightCheck = z.infer<typeof SubmissionPreflightCheckSchema>;

/** 一次预检运行（passed = 无 block 项）。 */
export const SubmissionPreflightRunSchema = z.strictObject({
  id: z.string().min(1),
  caseId: z.string().min(1),
  outcomeId: z.string().min(1),
  outcomeVersion: z.number().int().positive(),
  passed: z.boolean(),
  blockCount: z.number().int().nonnegative(),
  warnCount: z.number().int().nonnegative(),
  createdAt: timestamp,
});
export type SubmissionPreflightRun = z.infer<typeof SubmissionPreflightRunSchema>;

/** 投稿包（一轮投稿的材料清单；round 首轮 1，返修重投递增）。 */
export const SubmissionPackageSchema = z.strictObject({
  id: z.string().min(1),
  caseId: z.string().min(1),
  status: z.enum(SUBMISSION_PACKAGE_STATUSES).default('draft'),
  round: z.number().int().positive(),
  createdAt: timestamp,
  updatedAt: timestamp,
  frozenAt: optionalTimestamp.default(null),
});
export type SubmissionPackage = z.infer<typeof SubmissionPackageSchema>;

/** 投稿包文件条目（可回链成果版本，也可只登记外部文件路径）。 */
export const SubmissionPackageFileSchema = z.strictObject({
  id: z.string().min(1),
  packageId: z.string().min(1),
  type: z.enum(SUBMISSION_PACKAGE_FILE_TYPES),
  filename: z.string().max(1000).default(''),
  outcomeId: z.string().min(1).nullable().default(null),
  outcomeVersion: z.number().int().positive().nullable().default(null),
  artifactPath: z.string().max(2000).nullable().default(null),
  contentHash: z.string().max(200).default(''),
  required: z.boolean().default(false),
  validationStatus: z.enum(SUBMISSION_PACKAGE_FILE_VALIDATION_STATUSES).default('pending'),
  note: z.string().max(20000).default(''),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type SubmissionPackageFile = z.infer<typeof SubmissionPackageFileSchema>;

// ─── 创建/更新请求 ───────────────────────────────────────────

/** 运行一次预检的入参。 */
export const SubmissionPreflightRunRequestSchema = z.strictObject({
  projectId: z.string().min(1),
  caseId: z.string().min(1),
});
export type SubmissionPreflightRunRequest = z.infer<typeof SubmissionPreflightRunRequestSchema>;
export type SubmissionPreflightRunInput = z.input<typeof SubmissionPreflightRunRequestSchema>;

/** 单条检查结论写入入参（id/runId/caseId/createdAt 由仓储填充）。 */
export const SubmissionPreflightCheckCreateRequestSchema = z.strictObject({
  checkKey: z.enum(SUBMISSION_PREFLIGHT_CHECK_KEYS),
  label: z.string().max(300).default(''),
  level: z.enum(SUBMISSION_PREFLIGHT_CHECK_LEVELS),
  detail: z.string().max(20000).default(''),
  source: z.enum(SUBMISSION_PREFLIGHT_CHECK_SOURCES).default('deterministic'),
});
export type SubmissionPreflightCheckCreateRequest = z.infer<typeof SubmissionPreflightCheckCreateRequestSchema>;
export type SubmissionPreflightCheckCreateInput = z.input<typeof SubmissionPreflightCheckCreateRequestSchema>;

/** 投稿包文件登记入参（id/packageId/时间戳由仓储填充）。 */
export const SubmissionPackageFileCreateRequestSchema = z.strictObject({
  type: z.enum(SUBMISSION_PACKAGE_FILE_TYPES),
  filename: z.string().max(1000).default(''),
  outcomeId: z.string().min(1).nullable().default(null),
  outcomeVersion: z.number().int().positive().nullable().default(null),
  artifactPath: z.string().max(2000).nullable().default(null),
  contentHash: z.string().max(200).default(''),
  required: z.boolean().default(false),
  validationStatus: z.enum(SUBMISSION_PACKAGE_FILE_VALIDATION_STATUSES).default('pending'),
  note: z.string().max(20000).default(''),
});
export type SubmissionPackageFileCreateRequest = z.infer<typeof SubmissionPackageFileCreateRequestSchema>;
export type SubmissionPackageFileCreateInput = z.input<typeof SubmissionPackageFileCreateRequestSchema>;

/** 投稿包文件可变字段（id/packageId/type/createdAt 不可经此修改）。 */
export const SubmissionPackageFilePatchSchema = z.strictObject({
  filename: z.string().max(1000).optional(),
  outcomeId: z.string().min(1).nullable().optional(),
  outcomeVersion: z.number().int().positive().nullable().optional(),
  artifactPath: z.string().max(2000).nullable().optional(),
  contentHash: z.string().max(200).optional(),
  required: z.boolean().optional(),
  validationStatus: z.enum(SUBMISSION_PACKAGE_FILE_VALIDATION_STATUSES).optional(),
  note: z.string().max(20000).optional(),
});
export type SubmissionPackageFilePatch = z.infer<typeof SubmissionPackageFilePatchSchema>;
