/**
 * MailSendService — 投稿外发邮件服务（P3/P4）。
 *
 * 诚实性边界：
 *  - operationId 幂等：发送前先查 submission_correspondence，已存在即返回
 *    alreadySent=true，绝不触发第二次真实 SMTP 发送；
 *  - 发送失败（鉴权/网络/配置）一律结构化返回且不落库——
 *    没发出去的邮件绝不能变成「已发送」记录；
 *  - 授权码只在发送瞬间经 decryptSecret 解密到内存，本服务不接触明文落盘；
 *  - 未知邮箱域名不猜 SMTP 配置，直接 mail_smtp_config_unknown；
 *  - previewSend 只做校验与规范化，绝不发送。
 */
import nodemailer from 'nodemailer';
import {
  sendMail as engineSendMail,
  smtpConfigForUser,
  type CreateMailTransport,
  type SmtpConnectionOptions,
} from '../engine/mail/MailSender.js';
import type { MailboxAccount } from '../engine/mail/MailboxPool.js';
import type { SubmissionCorrespondence } from '../engine/submission/SubmissionCorrespondenceContract.js';
import type { MailboxPoolStore } from './ModelDiscoveryStore.js';
import type { SubmissionCorrespondenceRepository } from './SubmissionCorrespondenceRepository.js';
import type { SubmissionRepository } from './SubmissionRepository.js';

export interface MailSendServiceOptions {
  mailboxStore: MailboxPoolStore;
  /** safeStorage 解密：失败返回 null（决不以抛异常方式上抛）。 */
  decryptSecret: (encrypted: string) => string | null;
  correspondenceRepository: SubmissionCorrespondenceRepository;
  submissionRepository: SubmissionRepository;
  /** 可选注入：测试用 fake transport；缺省走真实 nodemailer。 */
  createTransport?: CreateMailTransport;
}

export type MailSendFailureCode =
  | 'mail_invalid_request'
  | 'mail_account_not_found'
  | 'mail_case_not_found'
  | 'mail_secret_unavailable'
  | 'mail_smtp_config_unknown'
  | 'mail_auth_failed'
  | 'mail_send_failed';

export interface MailSendFailure {
  ok: false;
  code: MailSendFailureCode;
  message: string;
}

export interface MailAttachmentInput {
  filename: string;
  content?: string | Buffer;
  path?: string;
}

export interface MailPreviewInput {
  accountId: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  bodyText: string;
  attachments?: MailAttachmentInput[];
}

/** 规范化后的发送预览（附件只暴露文件名与来源形态，不回显内容）。 */
export interface MailPreview {
  accountId: string;
  accountLabel: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  bodyText: string;
  attachments: Array<{ filename: string; source: 'content' | 'path' | 'empty' }>;
  /** 域名推断出的 SMTP 配置；未知域名为 null（发送时会结构化失败）。 */
  smtp: { host: string; port: number; secure: boolean } | null;
}

export type PreviewSendResult =
  | { ok: true; preview: MailPreview }
  | MailSendFailure;

export interface SendOutboundMailInput extends MailPreviewInput {
  projectId: string;
  caseId?: string;
  /** 外发幂等键：同一封邮件的重试必须携带相同 operationId。 */
  operationId: string;
}

export type SendOutboundMailResult =
  | { ok: true; alreadySent: boolean; record: SubmissionCorrespondence; messageId?: string }
  | MailSendFailure;

function failure(code: MailSendFailureCode, message: string): MailSendFailure {
  return { ok: false, code, message };
}

export class MailSendService {
  constructor(private readonly options: MailSendServiceOptions) {}

  private findAccount(accountId: string): MailboxAccount | undefined {
    return this.options.mailboxStore.list().find((account) => account.id === accountId);
  }

  /** 公共校验：收件人非空、主题非空、账户存在。 */
  private validateEnvelope(input: MailPreviewInput): { account: MailboxAccount } | MailSendFailure {
    if (!input.to.trim()) return failure('mail_invalid_request', '收件人不能为空。');
    if (!input.subject.trim()) return failure('mail_invalid_request', '主题不能为空。');
    const account = this.findAccount(input.accountId);
    if (!account) return failure('mail_account_not_found', `邮箱账户不存在：${input.accountId}`);
    return { account };
  }

  /** 缺省走真实 nodemailer；测试注入 fake 时不触网。 */
  private transportFactory(): CreateMailTransport {
    if (this.options.createTransport) return this.options.createTransport;
    return (options: SmtpConnectionOptions) => nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      auth: { user: options.auth.user, pass: options.auth.pass },
    });
  }

  /** 发送预览：只做校验与规范化，绝不发送。 */
  previewSend(input: MailPreviewInput): PreviewSendResult {
    const checked = this.validateEnvelope(input);
    if (!('account' in checked)) return checked;
    const { account } = checked;
    const smtp = smtpConfigForUser(account.user);
    return {
      ok: true,
      preview: {
        accountId: account.id,
        accountLabel: account.label,
        from: account.user,
        to: input.to.trim(),
        cc: input.cc?.trim() ?? '',
        bcc: input.bcc?.trim() ?? '',
        subject: input.subject.trim(),
        bodyText: input.bodyText,
        attachments: (input.attachments ?? []).map((attachment) => ({
          filename: attachment.filename,
          source: attachment.content !== undefined ? 'content' as const : (attachment.path ? 'path' as const : 'empty' as const),
        })),
        smtp: smtp ? { host: smtp.host, port: smtp.port, secure: smtp.secure } : null,
      },
    };
  }

  /**
   * 外发邮件：幂等检查 → 校验 → 解密授权码 → 推断 SMTP → 真实发送 →
   * 成功才落库（recordOutbound）+ 追加 Case 事件。任何一步失败都结构化返回，
   * 且失败绝不落库。
   */
  async sendMail(input: SendOutboundMailInput): Promise<SendOutboundMailResult> {
    if (!input.operationId.trim()) return failure('mail_invalid_request', '缺少 operationId 幂等键。');

    // a. 幂等：该 operationId 已发出过，直接返回原记录，绝不重发。
    const existing = this.options.correspondenceRepository.findByOperationId(input.operationId);
    if (existing) return { ok: true, alreadySent: true, record: existing };

    const checked = this.validateEnvelope(input);
    if (!('account' in checked)) return checked;
    const { account } = checked;

    // 指定了 caseId 就先确认 Case 存在：宁可发送前失败，也不能发出后追不到事件。
    if (input.caseId && !this.options.submissionRepository.getCase(input.projectId, input.caseId)) {
      return failure('mail_case_not_found', `投稿 Case 不存在或不属于当前项目：${input.caseId}`);
    }

    // b. 授权码解密与 SMTP 配置推断失败：结构化失败，不落库。
    const secret = this.options.decryptSecret(account.encryptedSecret);
    if (!secret) return failure('mail_secret_unavailable', '授权码解密失败（safeStorage 不可用或密文损坏），未发送。');
    const smtp = smtpConfigForUser(account.user);
    if (!smtp) return failure('mail_smtp_config_unknown', `无法按邮箱域名推断 SMTP 配置：${account.user}`);

    // c. 真实发送；失败结构化返回，不落库。
    const result = await engineSendMail(
      { createTransport: this.transportFactory() },
      {
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        user: account.user,
        secret,
        to: input.to.trim(),
        cc: input.cc?.trim() || undefined,
        bcc: input.bcc?.trim() || undefined,
        subject: input.subject.trim(),
        text: input.bodyText,
        attachments: input.attachments,
      },
    );
    if (!result.ok) return result;

    // d. 真实发送成功后才落库 + 追加 Case timeline 事件。
    const { record } = this.options.correspondenceRepository.recordOutbound({
      projectId: input.projectId,
      caseId: input.caseId ?? null,
      accountId: account.id,
      operationId: input.operationId,
      messageId: result.messageId,
      toAddr: input.to.trim(),
      subject: input.subject.trim(),
      bodyText: input.bodyText,
      sentAt: Date.now(),
    });
    if (input.caseId) {
      this.options.submissionRepository.addEvent(input.projectId, {
        caseId: input.caseId,
        type: 'correspondence_sent',
        source: 'email',
        description: `外发邮件：${input.subject.trim().slice(0, 80)}（→ ${input.to.trim().slice(0, 120)}）`,
        metadata: {
          correspondenceId: record.id,
          accountId: account.id,
          messageId: result.messageId,
          operationId: input.operationId,
        },
      });
    }
    return { ok: true, alreadySent: false, record, messageId: result.messageId };
  }
}
