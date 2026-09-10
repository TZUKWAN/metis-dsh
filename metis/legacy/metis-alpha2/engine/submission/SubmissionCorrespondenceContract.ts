/**
 * Submission Correspondence Contract — 投稿通信（邮件）领域契约（P3/P4）。
 *
 * 领域定位：Submission Case 与外部世界（期刊编辑部、投稿系统）之间
 * 全部邮件往来的可审计记录。收件（IMAP 监听）与外发（SMTP）共用一张表，
 * direction 区分方向。
 *
 * 设计原则（与 SubmissionRuntimeContract 同风格）：
 *  - Zod strictObject 契约 + 冻结常量表；
 *  - 外发必须携带 operationId 幂等键：重试绝不产生第二封真实邮件；
 *  - 收件自动关联只是「建议」：matchStatus=pending 的记录必须经用户确认
 *    才允许推进 Case 状态，禁止强行关联；
 *  - 邮件正文属于不可信外部内容，契约层只做承载，消费方负责注入防护。
 */

import { z } from 'zod';

export const SUBMISSION_CORRESPONDENCE_CONTRACT_VERSION = 1 as const;

/** 邮件方向：in=收到（编辑→作者），out=发出（作者→编辑/投稿系统）。 */
export const CORRESPONDENCE_DIRECTIONS = ['in', 'out'] as const;
export type CorrespondenceDirection = typeof CORRESPONDENCE_DIRECTIONS[number];

/**
 * 自动分类结果（确定性关键词分类，开放集合之外一律 'other'）。
 * 分类只是提示：真正的状态推进必须经用户确认或显式规则。
 */
export const CORRESPONDENCE_CLASSIFICATIONS = [
  'submission_confirmation',
  'editor_assigned',
  'under_review',
  'revision_request',
  'decision_letter',
  'acceptance',
  'rejection',
  'production_query',
  'proof',
  'other',
] as const;
export type CorrespondenceClassification = typeof CORRESPONDENCE_CLASSIFICATIONS[number];

/** 关联状态：pending=待用户确认，matched=已确认关联，rejected=用户否认关联。 */
export const CORRESPONDENCE_MATCH_STATUSES = ['pending', 'matched', 'rejected'] as const;
export type CorrespondenceMatchStatus = typeof CORRESPONDENCE_MATCH_STATUSES[number];

/** 一条投稿通信记录。 */
export const SubmissionCorrespondenceSchema = z.strictObject({
  contractVersion: z.literal(SUBMISSION_CORRESPONDENCE_CONTRACT_VERSION),
  id: z.string().min(1),
  projectId: z.string().min(1),
  /** 关联的投稿 Case；未确认关联时为 null（挂起在「待确认」列表）。 */
  caseId: z.string().min(1).nullable(),
  direction: z.enum(CORRESPONDENCE_DIRECTIONS),
  /** 邮箱账户（MailboxPool account id）。 */
  accountId: z.string().min(1).nullable(),
  /** RFC Message-ID（收件去重键）；外发时为 SMTP 回执 messageId。 */
  messageId: z.string().max(1000),
  /** 会话线索（References/In-Reply-To 归一化结果，可空）。 */
  threadId: z.string().max(1000),
  /** 外发幂等键：相同 operationId 的重复发送请求直接返回原记录。 */
  operationId: z.string().min(1).max(200).nullable(),
  fromAddr: z.string().max(2000),
  toAddr: z.string().max(4000),
  subject: z.string().max(4000),
  /** 解码后的正文纯文本（截断存储，原文始终在邮箱服务器）。 */
  bodyText: z.string().max(200_000),
  /** 附件文件名列表（决定信 Word/PDF 拆解的溯源信息）。 */
  attachmentNames: z.array(z.string().min(1).max(500)).max(20).default([]),
  /**
   * 已成功提取的附件纯文本（截断存储）。提取失败的附件只出现在
   * attachmentNames 里，绝不伪造其文本——缺哪个就是没提取出来。
   */
  attachmentTexts: z.array(z.strictObject({
    filename: z.string().min(1).max(500),
    text: z.string().max(300_000),
  })).max(20).default([]),
  receivedAt: z.number().int().nullable(),
  sentAt: z.number().int().nullable(),
  classification: z.enum(CORRESPONDENCE_CLASSIFICATIONS),
  matchStatus: z.enum(CORRESPONDENCE_MATCH_STATUSES),
  /** 自动关联的解释（命中了哪个字段），供用户判断确认。 */
  matchReason: z.string().max(2000),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type SubmissionCorrespondence = z.infer<typeof SubmissionCorrespondenceSchema>;

/** 收件登记输入（IMAP 监听）。 */
export const InboundCorrespondenceInputSchema = z.strictObject({
  projectId: z.string().min(1),
  accountId: z.string().min(1),
  messageId: z.string().max(1000),
  threadId: z.string().max(1000).default(''),
  fromAddr: z.string().max(2000),
  toAddr: z.string().max(4000).default(''),
  subject: z.string().max(4000),
  bodyText: z.string().max(200_000),
  attachmentNames: z.array(z.string().min(1).max(500)).max(20).default([]),
  attachmentTexts: z.array(z.strictObject({
    filename: z.string().min(1).max(500),
    text: z.string().max(300_000),
  })).max(20).default([]),
  receivedAt: z.number().int().nullable().default(null),
  classification: z.enum(CORRESPONDENCE_CLASSIFICATIONS).default('other'),
  /** 自动匹配建议：命中即带理由挂 pending，未命中为 null。 */
  suggestedCaseId: z.string().min(1).nullable().default(null),
  matchReason: z.string().max(2000).default(''),
});
export type InboundCorrespondenceInput = z.infer<typeof InboundCorrespondenceInputSchema>;

/** 外发登记输入（SMTP 发送成功后由 MailSendService 落库）。 */
export const OutboundCorrespondenceInputSchema = z.strictObject({
  projectId: z.string().min(1),
  caseId: z.string().min(1).nullable().default(null),
  accountId: z.string().min(1),
  operationId: z.string().min(1).max(200),
  messageId: z.string().max(1000),
  toAddr: z.string().min(1).max(4000),
  subject: z.string().max(4000),
  bodyText: z.string().max(200_000),
  sentAt: z.number().int(),
});
export type OutboundCorrespondenceInput = z.infer<typeof OutboundCorrespondenceInputSchema>;
