/**
 * SubmissionMailService — 投稿邮件监听服务（P4）。
 *
 * 职责边界（刘总红线）：
 *  - 只做「拉信 → 确定性分类 → 确定性建议关联 Case → 登记落库」；
 *  - 自动关联永远是建议（pending）：匹配不上就如实挂起待确认，绝不强行关联；
 *  - 绝不自动建 ReviewRound、绝不自动推进状态机——建轮次必须走
 *    createRoundFromCorrespondence，且前提是用户已 confirmMatch；
 *  - 邮件正文是不可信外部内容：本服务只做分类与存储，不喂给任何自动执行链路。
 *
 * IMAP 客户端经 imapClientCtor 依赖注入，测试可注入 fake（见
 * tests/electron/SubmissionMailService.test.ts）。
 */
import {
  fetchRecentMailsDetailed,
  type DetailedMail,
  type ImapFlowConstructor,
} from '../engine/mail/MailboxPool.js';
import {
  TERMINAL_SUBMISSION_STATUSES,
  type SubmissionCase,
} from '../engine/submission/SubmissionRuntimeContract.js';
import type {
  CorrespondenceClassification,
  SubmissionCorrespondence,
} from '../engine/submission/SubmissionCorrespondenceContract.js';
import type { MailboxPoolStore } from './ModelDiscoveryStore.js';
import { extractAttachmentText } from './DecisionLetterAttachments.js';
import type { SubmissionCorrespondenceRepository } from './SubmissionCorrespondenceRepository.js';
import type { SubmissionRepository } from './SubmissionRepository.js';
import type { SubmissionReviewService } from './SubmissionReviewService.js';

// ─── 分类关键词表 ────────────────────────────────────────────

/**
 * 确定性关键词分类表（中英双语）。
 *
 * 判定顺序即优先级，靠前者先命中即返回。顺序依据「误判代价」排列：
 *  1. revision_request / rejection / acceptance：决定后续动作的类别最优先——
 *     返修信与拒稿信里常出现 decision/accept 字样（"decision: major revision"、
 *     "we cannot accept"），若先判 decision_letter 或 acceptance 会把返修误判成
 *     普通决定信、把拒稿误判成录用，代价最高；
 *  2. decision_letter：generic 的 "decision" 兜底，只在前三类都没命中时采用；
 *  3. proof / production_query：出版流程类，关键词与前面各类基本不重叠；
 *  4. submission_confirmation / editor_assigned / under_review：流程通知类，最靠后，
 *     因为确认信里常含 "submission"/"received" 等泛词，放前面会吞掉更具体的类别。
 * 任何一类都不命中 → 'other'：宁可 other 不可乱分。
 */
const CLASSIFICATION_RULES: ReadonlyArray<{
  classification: CorrespondenceClassification;
  patterns: RegExp[];
}> = [
  {
    classification: 'revision_request',
    patterns: [
      /\b(?:major|minor)\s+revisions?\b/iu,
      /\brevise(?:d)?\s+and\s+resubmit\b/iu,
      /\brevision\s+(?:is\s+)?requested\b/iu,
      /\binvite(?:d)?\s+you\s+to\s+(?:submit\s+)?a\s+revised\b/iu,
      /审稿意见/u,
      /退修/u,
      /修改后(?:再审|重新提交)/u,
    ],
  },
  {
    classification: 'rejection',
    patterns: [
      /\breject(?:ed|ion)?\b/iu,
      /\b(?:cannot|unable\s+to|not\s+able\s+to)\s+accept\b/iu,
      /\bdeclin(?:e|ed|ing)\b/iu,
      /\bnot\s+(?:suitable|accepted)\b/iu,
      /不宜刊用/u,
      /不予(?:录用|采用)/u,
      /退稿/u,
    ],
  },
  {
    classification: 'acceptance',
    patterns: [
      /\baccept(?:ed)?\s+for\s+publication\b/iu,
      /\b(?:pleased|delighted|happy)\s+to\s+(?:inform|tell)\s+you[^.\n]{0,80}accept/iu,
      /\bhas\s+been\s+accepted\b/iu,
      /\bacceptance\s+of\s+your\s+(?:manuscript|paper)\b/iu,
      /录用通知/u,
      /已(?:被)?录用/u,
      /予以录用/u,
    ],
  },
  {
    classification: 'decision_letter',
    patterns: [
      /\bdecision\s+(?:letter|on|regarding|has\s+been\s+made)\b/iu,
      /\bdecision\s*[:：]/iu,
      /决定信/u,
      /审理决定/u,
    ],
  },
  {
    classification: 'proof',
    patterns: [
      /\b(?:galley|page)\s+proofs?\b/iu,
      /\bproofs?\s+(?:are\s+)?(?:ready|available)\b/iu,
      /校样/u,
      /清样/u,
    ],
  },
  {
    classification: 'production_query',
    patterns: [
      /\bproduction\s+(?:team|editor|query|queries)\b/iu,
      /\bcopyright\s+(?:form|transfer)\b/iu,
      /\barticle\s+processing\s+charge\b/iu,
      /出版流程/u,
      /版权协议/u,
      /版面费/u,
    ],
  },
  {
    classification: 'submission_confirmation',
    patterns: [
      /\bsubmission\s+confirm(?:ation|ed)\b/iu,
      /\bmanuscript\s+(?:has\s+been\s+)?received\b/iu,
      /\bthank\s+you\s+for\s+(?:your\s+)?submi(?:ssion|tting)\b/iu,
      /\bconfirm(?:ation)?\s+of\s+(?:your\s+)?submission\b/iu,
      /投稿成功/u,
      /收稿通知/u,
      /收到您(?:的)?稿件/u,
    ],
  },
  {
    classification: 'editor_assigned',
    patterns: [
      /\beditor\s+(?:has\s+been\s+)?assigned\b/iu,
      /\bassigned\s+to\s+(?:an?\s+)?editor\b/iu,
      /\bwith\s+the\s+editor\b/iu,
      /已分配编辑/u,
      /编辑处理中/u,
    ],
  },
  {
    classification: 'under_review',
    patterns: [
      /\bunder\s+review\b/iu,
      /\b(?:sent|out)\s+(?:to|for)\s+(?:the\s+)?reviewers?\b/iu,
      /\breviewer\s+(?:has\s+been\s+)?assigned\b/iu,
      /审稿中/u,
      /已送审/u,
      /外审/u,
    ],
  },
];

// ─── Case 建议匹配 ───────────────────────────────────────────

/** 建议强度分值：编号直命中 > 期刊名命中 > 标题词重合。 */
const SCORE_STRONG = 100;
const SCORE_MEDIUM = 50;
const SCORE_WEAK = 10;

/** 规范化文本：小写、去标点、压缩空白，供期刊名/标题的包含判断。 */
function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** 期刊名压缩为纯字母数字串（"Journal of Testing" → "journaloftesting"），用于域名匹配。 */
function compactName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/gu, '');
}

/** 英文停用词：标题里这些词太泛，不参与弱匹配打分。 */
const TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'using', 'based', 'study',
  'analysis', 'approach', 'via', 'towards', 'toward', 'between', 'among',
]);

/** 提取标题里的有效 token：长度 ≥4 的拉丁词（去停用词），或长度 ≥2 的连续汉字段。 */
function titleTokens(title: string): string[] {
  const tokens = new Set<string>();
  for (const word of title.toLowerCase().match(/[a-z]{4,}/gu) ?? []) {
    if (!TITLE_STOPWORDS.has(word)) tokens.add(word);
  }
  for (const han of title.match(/[一-鿿]{2,}/gu) ?? []) tokens.add(han);
  return [...tokens];
}

interface CaseScore {
  caseId: string;
  score: number;
  reason: string;
}

export interface CaseSuggestion {
  caseId: string;
  reason: string;
}

export type SyncAccountResult =
  | { ok: true; fetched: number; recorded: number; duplicates: number; pending: number;
      /** 本轮新落库的邮件摘要（后台监听通知渲染端用）。 */
      newRecords: Array<{ id: string; subject: string; classification: CorrespondenceClassification; caseId: string | null }> }
  | { ok: false; code: 'mailbox_account_not_found' | 'mailbox_secret_unavailable' | 'project_not_found' | 'mailbox_fetch_failed' | 'correspondence_record_failed' };

export type ConfirmMatchResult =
  | { ok: true; record: SubmissionCorrespondence }
  | { ok: false; code: 'correspondence_not_found' };

export type CreateRoundResult =
  | { ok: true; roundId: string }
  | { ok: false; code: 'review_service_unavailable' | 'correspondence_not_found' | 'match_not_confirmed' | 'classification_not_decision' | 'case_not_found' | 'empty_letter' };

/** 判定为「决定信类」的分类：confirm 后追加事件、允许建审稿轮次。 */
const DECISION_CLASSIFICATIONS: ReadonlySet<CorrespondenceClassification> = new Set(['decision_letter', 'revision_request']);

export class SubmissionMailService {
  constructor(private readonly options: {
    mailboxStore: MailboxPoolStore;
    /** 解密 safeStorage 密文授权码；失败（用户拒绝/环境不支持）返回 null。 */
    decryptSecret: (encrypted: string) => string | null;
    correspondenceRepository: SubmissionCorrespondenceRepository;
    submissionRepository: SubmissionRepository;
    reviewService?: SubmissionReviewService | null;
    imapClientCtor?: ImapFlowConstructor;
  }) {}

  /**
   * 确定性关键词分类：按 CLASSIFICATION_RULES 顺序取第一个命中类；
   * 全不命中返回 'other'。只看文本，不理解语义——误判宁可落在 other。
   */
  classifyMail(mail: { from: string; subject: string; bodyText: string }): CorrespondenceClassification {
    // 主题权重最高，正文取前 20_000 字符足够覆盖决定信关键段落（全文上限 100k）。
    const haystack = `${mail.subject}\n${mail.bodyText.slice(0, 20_000)}`;
    for (const rule of CLASSIFICATION_RULES) {
      if (rule.patterns.some((pattern) => pattern.test(haystack))) return rule.classification;
    }
    return 'other';
  }

  /**
   * 为邮件建议关联 Case（纯确定性，不调用 LLM）：
   *  - 强命中（100）：remoteSubmissionId 出现在主题或正文；
   *  - 中命中（50）：规范化期刊名出现在主题，或压缩刊名命中发件域名；
   *  - 弱命中（10）：标题有效 token ≥2 个出现在主题。
   * 只在最高分严格大于次高分时返回建议；并列或无命中一律返回 null
   * （歧义不猜，挂起待用户确认）。终态 Case 不参与匹配。
   */
  suggestCase(
    projectId: string,
    mail: { from: string; subject: string; bodyText: string },
    candidates?: SubmissionCase[],
  ): CaseSuggestion | null {
    const active = candidates ?? this.options.submissionRepository
      .listCases(projectId, { includeClosed: true })
      .filter((item) => !TERMINAL_SUBMISSION_STATUSES.includes(item.status));

    const subjectNorm = normalizeText(mail.subject);
    const subjectLower = mail.subject.toLowerCase();
    const bodyLower = mail.bodyText.toLowerCase();
    const fromDomain = (/@([^@\s>]+)/u.exec(mail.from)?.[1] ?? '').toLowerCase();

    const scored: CaseScore[] = [];
    for (const submissionCase of active) {
      // 强：稿件编号直命中（编号本身足够特异，主题或正文命中皆可）。
      const remoteId = submissionCase.remoteSubmissionId.trim();
      if (remoteId && (subjectLower.includes(remoteId.toLowerCase()) || bodyLower.includes(remoteId.toLowerCase()))) {
        scored.push({
          caseId: submissionCase.id,
          score: SCORE_STRONG,
          reason: `${subjectLower.includes(remoteId.toLowerCase()) ? '主题' : '正文'}含稿件编号 ${remoteId}`,
        });
        continue;
      }
      // 中：规范化刊名出现在主题，或压缩刊名命中发件域名。
      const journalName = submissionCase.targetJournalName.trim();
      if (journalName) {
        const journalNorm = normalizeText(journalName);
        const journalKey = compactName(journalName);
        if (journalNorm.length >= 4 && subjectNorm.includes(journalNorm)) {
          scored.push({ caseId: submissionCase.id, score: SCORE_MEDIUM, reason: `主题命中目标期刊「${journalName}」` });
          continue;
        }
        if (journalKey.length >= 4 && fromDomain.includes(journalKey)) {
          scored.push({ caseId: submissionCase.id, score: SCORE_MEDIUM, reason: `发件域名 ${fromDomain} 命中目标期刊「${journalName}」` });
          continue;
        }
      }
      // 弱：标题有效 token 至少 2 个出现在主题（单词命中太泛，不单独采信）。
      const hits = titleTokens(submissionCase.title).filter((token) => subjectLower.includes(token));
      if (hits.length >= 2) {
        scored.push({ caseId: submissionCase.id, score: SCORE_WEAK, reason: `主题与稿件标题重合（命中关键词：${hits.slice(0, 4).join('、')}）` });
      }
    }

    if (scored.length === 0) return null;
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0]!;
    const runnerUp = scored[1];
    // 分差清晰原则：最高分被并列分享 → 歧义，不猜。
    if (runnerUp && runnerUp.score === top.score) return null;
    return { caseId: top.caseId, reason: top.reason };
  }

  /**
   * 同步一个邮箱账户的最近来信：解密 → 拉信 → 逐封分类+建议关联 → 登记。
   * alreadyRecorded（同账户同 Message-ID）的跳过；无任何自动状态推进。
   */
  async syncAccount(input: { projectId: string; accountId: string; limit?: number }): Promise<SyncAccountResult> {
    const account = this.options.mailboxStore.list().find((item) => item.id === input.accountId);
    if (!account) return { ok: false, code: 'mailbox_account_not_found' };
    const secret = this.options.decryptSecret(account.encryptedSecret);
    if (!secret) return { ok: false, code: 'mailbox_secret_unavailable' };

    // 预取活跃候选（顺带校验项目存在），避免逐封重复查库。
    let candidates: SubmissionCase[];
    try {
      candidates = this.options.submissionRepository
        .listCases(input.projectId, { includeClosed: true })
        .filter((item) => !TERMINAL_SUBMISSION_STATUSES.includes(item.status));
    } catch {
      return { ok: false, code: 'project_not_found' };
    }

    const imapCtor = this.options.imapClientCtor;
    if (!imapCtor) return { ok: false, code: 'mailbox_fetch_failed' };
    let mails: DetailedMail[];
    try {
      mails = await fetchRecentMailsDetailed(imapCtor, account, secret, input.limit ?? 20);
    } catch {
      this.options.mailboxStore.updateStatus(account.id, false);
      return { ok: false, code: 'mailbox_fetch_failed' };
    }

    let recorded = 0;
    let duplicates = 0;
    const newRecords: Array<{ id: string; subject: string; classification: CorrespondenceClassification; caseId: string | null }> = [];
    for (const mail of mails) {
      const classification = this.classifyMail(mail);
      // 附件文本提取：只对决定信类邮件做（同步成本控制）。
      // 提取失败的附件只保留文件名，绝不伪造其文本。
      const attachmentNames = mail.attachments.map((item) => item.filename);
      const attachmentTexts: Array<{ filename: string; text: string }> = [];
      if (mail.attachments.length > 0 && DECISION_CLASSIFICATIONS.has(classification)) {
        for (const attachment of mail.attachments) {
          const extracted = await extractAttachmentText(attachment);
          if (extracted.ok) attachmentTexts.push({ filename: attachment.filename, text: extracted.text });
        }
      }
      const suggestion = this.suggestCase(input.projectId, mail, candidates);
      try {
        const result = this.options.correspondenceRepository.recordInbound({
          projectId: input.projectId,
          accountId: account.id,
          messageId: mail.messageId,
          threadId: mail.threadId,
          fromAddr: mail.from,
          toAddr: mail.to,
          subject: mail.subject,
          bodyText: mail.bodyText,
          attachmentNames,
          attachmentTexts,
          receivedAt: mail.date > 0 ? mail.date : null,
          classification,
          suggestedCaseId: suggestion?.caseId ?? null,
          // 匹配理由必填：未命中也要如实说明，供待确认列表展示。
          matchReason: suggestion?.reason ?? '自动匹配无命中，待人工确认归属 Case',
        });
        if (result.alreadyRecorded) duplicates += 1;
        else {
          recorded += 1;
          newRecords.push({
            id: result.record.id,
            subject: result.record.subject,
            classification: result.record.classification,
            caseId: result.record.caseId,
          });
        }
      } catch {
        return { ok: false, code: 'correspondence_record_failed' };
      }
    }
    this.options.mailboxStore.updateStatus(account.id, true);
    return {
      ok: true,
      fetched: mails.length,
      recorded,
      duplicates,
      newRecords,
      pending: this.options.correspondenceRepository.listPending(input.projectId).length,
    };
  }

  /**
   * 用户确认邮件↔Case 关联。确认成功且分类属决定信类时，
   * 在 Case 时间线追加 correspondence_matched 事件（source: 'email'）——
   * 只记录事实，不推进状态机。
   */
  confirmMatch(input: { projectId: string; id: string; caseId?: string }): ConfirmMatchResult {
    const record = this.options.correspondenceRepository.resolveMatch({
      projectId: input.projectId,
      id: input.id,
      approve: true,
      caseId: input.caseId,
    });
    if (!record) return { ok: false, code: 'correspondence_not_found' };
    if (record.caseId && DECISION_CLASSIFICATIONS.has(record.classification)) {
      this.options.submissionRepository.addEvent(input.projectId, {
        caseId: record.caseId,
        type: 'correspondence_matched',
        source: 'email',
        sourceId: record.id,
        description: `确认邮件关联：${record.subject.slice(0, 120)}（${record.classification}）`,
        metadata: { classification: record.classification, messageId: record.messageId },
      });
    }
    return { ok: true, record };
  }

  /** 用户否认自动关联：解除绑定并标记 rejected。 */
  rejectMatch(input: { projectId: string; id: string }): ConfirmMatchResult {
    const record = this.options.correspondenceRepository.resolveMatch({
      projectId: input.projectId,
      id: input.id,
      approve: false,
    });
    if (!record) return { ok: false, code: 'correspondence_not_found' };
    return { ok: true, record };
  }

  /**
   * 从已确认的收件记录创建审稿轮次：record 必须 direction=in、
   * matchStatus=matched、分类属决定信类；否则结构化失败。
   * 邮件正文作为 decisionLetterText 传入解析（正文仍是不可信文本，
   * 解析只做确定性切分，见 SubmissionReviewService）。
   */
  createRoundFromCorrespondence(input: { projectId: string; id: string }): CreateRoundResult {
    if (!this.options.reviewService) return { ok: false, code: 'review_service_unavailable' };
    const record = this.options.correspondenceRepository.get(input.projectId, input.id);
    if (!record || record.direction !== 'in') return { ok: false, code: 'correspondence_not_found' };
    if (record.matchStatus !== 'matched' || !record.caseId) return { ok: false, code: 'match_not_confirmed' };
    if (!DECISION_CLASSIFICATIONS.has(record.classification)) return { ok: false, code: 'classification_not_decision' };
    // 正文 + 附件文本合并为决定信全文：附件段落带来源标记，
    // 原始正文与各附件文本在记录里原样保留（原文永不丢弃）。
    const sections = [record.bodyText.trim()];
    for (const attachment of record.attachmentTexts) {
      sections.push(`--- 附件：${attachment.filename} ---\n${attachment.text}`);
    }
    const created = this.options.reviewService.createRoundFromLetter({
      projectId: input.projectId,
      caseId: record.caseId,
      decisionLetterText: sections.filter((section) => section).join('\n\n'),
      receivedAt: record.receivedAt ?? undefined,
    });
    if (!created.ok) return { ok: false, code: created.code };
    return { ok: true, roundId: created.roundId };
  }
}
