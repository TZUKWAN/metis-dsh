/**
 * Submission Portal Contract — 浏览器辅助投稿（Submission Portal Operator）领域契约。
 *
 * 领域定位：投稿门户（ScholarOne / Editorial Manager / OJS 等）的表单操作计划
 * 与会话快照。浏览器里看到的一切都是「不可信外部内容」，只作为检测输入，
 * 绝不作为指令来源。
 *
 * 安全原则（安全敏感，不可放宽）：
 *  - value 只承载系统已知事实（稿件标题、目标期刊名等）；
 *    作者事实（姓名/单位/基金/伦理声明）一律不得出现在 value 中；
 *  - attestation / external_auth / financial / legal / final_submit 级别
 *    的动作永远只进计划、不执行——必须人类在浏览器里亲自完成；
 *  - 登录态判不了就是 null，不许猜。
 *
 * 风格与 SubmissionRuntimeContract / JournalProfileContract 对齐：
 * Zod strictObject + 冻结常量表。
 */

import { z } from 'zod';

/**
 * 契约版本：v2 将抽取粒度从「文本级」升级为「字段级」——
 * 新增 PortalFormField / PortalManuscriptFacts / PortalFillPlan，
 * PortalFieldAction 增加 fieldKind/needsUser/packageFileId 三个带默认值字段
 * （向后兼容：旧数据经 schema.parse 自动补默认值，无需迁移）。
 */
export const SUBMISSION_PORTAL_CONTRACT_VERSION = 2 as const;

/** 投稿门户平台类型（影响检测与填表策略；与 JournalProfileContract 的平台语义对应）。 */
export const PORTAL_PLATFORMS = ['scholarone', 'editorial_manager', 'ojs', 'generic'] as const;
export type PortalPlatform = typeof PORTAL_PLATFORMS[number];

/**
 * 门户操作安全级别（决定「机器能替人做到哪一步」）：
 *  - auto          ：纯系统事实填充（如稿件标题），可由服务直接执行；
 *  - review        ：可执行但必须先经用户在 UI 显式确认（confirmed === true）；
 *  - attestation   ：事实声明类（「本文未一稿多投」「原创性声明」「利益冲突」等
 *                    复选框）——只有作者本人有资格声明，机器代勾 = 伪造声明；
 *  - external_auth ：外部认证（CAPTCHA / 2FA / 短信/邮箱验证码）——设计上就
 *                    是「证明你是人」，任何自动绕过都被禁止；
 *  - financial     ：财务操作（APC 版面费 / 支付 / 发票信息）——涉及资金，
 *                    必须人类亲自操作；
 *  - legal         ：法律协议（版权转让 / License 协议 / 开放获取协议）——
 *                    只有权利人本人能签署；
 *  - final_submit  ：最终提交按钮——不可逆外部副作用，一律只能由人类点击。
 * attestation 及以上级别一律只进计划、绝不执行；服务层面整体拒绝执行请求。
 */
export const PORTAL_ACTION_SAFETY_LEVELS = [
  'auto',
  'review',
  'attestation',
  'external_auth',
  'financial',
  'legal',
  'final_submit',
] as const;
export type PortalActionSafetyLevel = typeof PORTAL_ACTION_SAFETY_LEVELS[number];

/** 允许被自动化执行的级别（review 仍需用户确认；其余级别在此集合之外 = 人类专属）。 */
export const PORTAL_AUTOMATABLE_SAFETY_LEVELS: readonly PortalActionSafetyLevel[] = ['auto', 'review'];

export function isPortalActionAutomatable(level: PortalActionSafetyLevel): boolean {
  return PORTAL_AUTOMATABLE_SAFETY_LEVELS.includes(level);
}

// ─── 字段级描述（selector/字段级 DOM 抽取） ───────────────────

/** 表单字段种类（从 DOM input/select/textarea 映射而来）。 */
export const PORTAL_FORM_FIELD_KINDS = ['text', 'textarea', 'select', 'file', 'checkbox', 'radio'] as const;
export type PortalFormFieldKind = typeof PORTAL_FORM_FIELD_KINDS[number];

/**
 * 页面枚举出的单个表单字段（BrowserService.enumerateFormFields 的产出）。
 * key 为页面侧稳定标识（id > name > 序号兜底）；selectorHint 为尽力而为的
 * CSS 选择器猜测（#id 或 [name="..."]），命中不了时执行端如实 not_found。
 */
export const PortalFormFieldSchema = z.strictObject({
  key: z.string().min(1).max(200),
  label: z.string().max(300).default(''),
  kind: z.enum(PORTAL_FORM_FIELD_KINDS),
  required: z.boolean().default(false),
  currentValue: z.string().max(5000).default(''),
  selectorHint: z.string().max(500).default(''),
});
export type PortalFormField = z.infer<typeof PortalFormFieldSchema>;

/**
 * 系统已知稿件事实（填表的唯一值来源；绝不承载作者事实：姓名/单位/基金等）。
 * abstract/keywords 当前 Case 上不存，默认空串/空数组——匹配不到事实的字段
 * 一律 needsUser，系统不编造。
 */
export const PortalManuscriptFactsSchema = z.strictObject({
  title: z.string().max(500).default(''),
  abstract: z.string().max(20000).default(''),
  keywords: z.array(z.string().max(200)).max(50).default([]),
  articleType: z.string().max(120).default(''),
  targetJournalName: z.string().max(300).default(''),
});
export type PortalManuscriptFacts = z.infer<typeof PortalManuscriptFactsSchema>;

/** 已冻结投稿包文件的填单视图（file 字段唯一允许绑定的文件来源）。 */
export const PortalPackageFileRefSchema = z.strictObject({
  id: z.string().min(1),
  type: z.string().max(60),
  filename: z.string().max(1000).default(''),
});
export type PortalPackageFileRef = z.infer<typeof PortalPackageFileRefSchema>;

/**
 * 单条门户表单动作（计划项）。
 * value 约束：只承载系统已知事实（稿件标题、目标期刊名等）；
 * 声明类/法律类/财务类动作进计划时 value 必须为空字符串——
 * 系统不提供、也不允许替作者编造任何事实声明。
 * file 类字段不允许编程赋值（input[type=file] 不可脚本写入），只允许经
 * packageFileId 绑定已冻结投稿包文件，由人类在浏览器里亲自选择上传。
 */
export const PortalFieldActionSchema = z.strictObject({
  /** 稳定字段标识（如 'manuscript_title' / 'hazard_attestation_1'），供执行回执对应。 */
  fieldKey: z.string().min(1).max(120),
  /** 人类可读字段名（来自页面标签或检测说明）。 */
  label: z.string().max(300).default(''),
  /** 待填值；仅 auto/review 级可非空，且只能是系统已知事实。 */
  value: z.string().max(5000).default(''),
  safetyLevel: z.enum(PORTAL_ACTION_SAFETY_LEVELS),
  /** CSS 选择器（文本抽取拿不到时为空串，执行端需退化处理）。 */
  selector: z.string().max(500).default(''),
  /** 绑定的表单字段种类（字段级计划项 = 对应 PortalFormField.kind）。 */
  fieldKind: z.enum(PORTAL_FORM_FIELD_KINDS).default('text'),
  /** 系统无已知事实可填、必须用户亲自处理时为 true（预览 UI 据此分组）。 */
  needsUser: z.boolean().default(false),
  /** file 字段绑定的已冻结投稿包文件 id；非 file 字段恒为 null。 */
  packageFileId: z.string().min(1).nullable().default(null),
  /** 为什么是这个级别/这个值——审计与 UI 预览用，必填。 */
  reason: z.string().min(1).max(2000),
});
export type PortalFieldAction = z.infer<typeof PortalFieldActionSchema>;

/** 门户会话快照：一次 openPortal 的可解释检测结果。 */
export const PortalSessionSchema = z.strictObject({
  caseId: z.string().min(1),
  /** 实际导航的入口 URL（三级解析后的结果）。 */
  portalUrl: z.string().max(2000),
  platform: z.enum(PORTAL_PLATFORMS),
  /** 登录态：可解释启发判定；判不了 = null（不许猜）。 */
  loggedIn: z.boolean().nullable(),
  currentUrl: z.string().max(2000).default(''),
  pageTitle: z.string().max(500).default(''),
  detectedAt: z.number().int().nonnegative(),
});
export type PortalSession = z.infer<typeof PortalSessionSchema>;

/** 一次 planFill 的字段级填单计划（枚举字段 + 动作项，供 UI 预览）。 */
export const PortalFillPlanSchema = z.strictObject({
  caseId: z.string().min(1),
  platform: z.enum(PORTAL_PLATFORMS),
  /** 页面实际枚举到的表单字段；浏览器无枚举能力或页面无表单时为空数组。 */
  fields: z.array(PortalFormFieldSchema).default([]),
  actions: z.array(PortalFieldActionSchema).default([]),
  plannedAt: z.number().int().nonnegative(),
});
export type PortalFillPlan = z.infer<typeof PortalFillPlanSchema>;
