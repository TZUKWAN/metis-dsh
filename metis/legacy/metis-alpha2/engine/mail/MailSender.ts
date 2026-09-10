/**
 * SMTP 发件领域模块（P3/P4 投稿外发邮件）。
 *
 * 与 MailboxPool（IMAP 收件）对称：纯领域、无 Electron/持久化依赖，
 * nodemailer 的 createTransport 以依赖注入传入，保持本模块可单测。
 *
 * 诚实性边界：
 *  - 未知邮箱域名不猜测 SMTP 配置，smtpConfigForUser 直接返回 null；
 *  - 任何发送异常都结构化返回失败，绝不吞异常冒充发送成功；
 *  - 鉴权类错误（535 / EAUTH / Invalid login）单独映射为 mail_auth_failed，
 *    便于上层提示「授权码错误」而非笼统的网络失败。
 */

/** 常见邮箱的 SMTP 预设（与 MAILBOX_PRESETS 的 IMAP 预设一一对应）。 */
export interface SmtpPreset {
  host: string;
  port: number;
  secure: boolean;
  label: string;
}

export const SMTP_PRESETS: Record<string, SmtpPreset> = {
  qq: { host: 'smtp.qq.com', port: 465, secure: true, label: 'QQ 邮箱' },
  '163': { host: 'smtp.163.com', port: 465, secure: true, label: '网易 163 邮箱' },
  '126': { host: 'smtp.126.com', port: 465, secure: true, label: '网易 126 邮箱' },
};

/** 发件域名 → 预设键。只做精确匹配，子域名/企业邮箱不猜。 */
const SMTP_DOMAIN_MAP: Record<string, keyof typeof SMTP_PRESETS> = {
  'qq.com': 'qq',
  '163.com': '163',
  '126.com': '126',
};

/** 按发件邮箱域名推断 SMTP 预设；未知域名返回 null（不猜）。 */
export function smtpConfigForUser(email: string): SmtpPreset | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  const key = SMTP_DOMAIN_MAP[domain];
  return key ? (SMTP_PRESETS[key] ?? null) : null;
}

export interface MailAttachment {
  filename: string;
  content?: string | Buffer;
  path?: string;
}

/** 注入给 createTransport 的连接参数（nodemailer SMTPTransport.Options 的最小子集）。 */
export interface SmtpConnectionOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
}

export interface OutgoingMailMessage {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
}

/** nodemailer Transporter 的最小结构子集：领域层不依赖 nodemailer 类型。 */
export interface MailTransportLike {
  sendMail(message: OutgoingMailMessage): Promise<{ messageId?: string }>;
}

export type CreateMailTransport = (options: SmtpConnectionOptions) => MailTransportLike;

export interface SendMailInput {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  /** 授权码明文：仅在本次发送的内存中存在，调用方负责不落盘。 */
  secret: string;
  /** 缺省时用 user 作为 From。 */
  from?: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
}

export type MailSendFailureCode = 'mail_invalid_request' | 'mail_auth_failed' | 'mail_send_failed';

export type SendMailResult =
  | { ok: true; messageId: string }
  | { ok: false; code: MailSendFailureCode; message: string };

/** SMTP 鉴权失败特征：响应码 535 / nodemailer code=EAUTH / 常见鉴权文案。 */
function isAuthError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const shaped = error as { code?: unknown; responseCode?: unknown };
    if (shaped.responseCode === 535) return true;
    if (shaped.code === 'EAUTH') return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /535|invalid login|authentication failed|username and password not accepted/iu.test(message);
}

/**
 * 发送一封邮件。入参先校验（mail_invalid_request），再经注入的
 * createTransport 建立连接并发送；鉴权失败与其余发送失败分别映射为
 * mail_auth_failed / mail_send_failed，绝不把异常吞成 ok。
 */
export async function sendMail(
  deps: { createTransport: CreateMailTransport },
  input: SendMailInput,
): Promise<SendMailResult> {
  const invalid = (message: string): SendMailResult => ({ ok: false, code: 'mail_invalid_request', message });
  if (!input.host.trim()) return invalid('缺少 SMTP 主机。');
  if (!Number.isInteger(input.port) || input.port <= 0 || input.port > 65535) return invalid(`SMTP 端口非法：${input.port}`);
  if (!input.user.trim()) return invalid('缺少发件账户。');
  if (!input.secret) return invalid('缺少授权码。');
  if (!input.to.trim()) return invalid('缺少收件人。');

  const transport = deps.createTransport({
    host: input.host,
    port: input.port,
    secure: input.secure,
    auth: { user: input.user, pass: input.secret },
  });
  try {
    const info = await transport.sendMail({
      from: input.from?.trim() || input.user,
      to: input.to,
      ...(input.cc ? { cc: input.cc } : {}),
      ...(input.bcc ? { bcc: input.bcc } : {}),
      subject: input.subject,
      text: input.text,
      ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
    });
    return { ok: true, messageId: info.messageId ?? '' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAuthError(error)) {
      return { ok: false, code: 'mail_auth_failed', message: `SMTP 鉴权失败（授权码可能错误或已失效）：${message}` };
    }
    return { ok: false, code: 'mail_send_failed', message: `SMTP 发送失败：${message}` };
  }
}
