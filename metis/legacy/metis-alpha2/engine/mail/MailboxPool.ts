/**
 * 注册邮箱池（2026-08-23 刘总需求）：QQ/网易 163 邮箱（IMAP + 授权码）。
 *
 * 用途：自动收取免费模型渠道注册流程中的验证邮件，提取验证链接/验证码。
 * 授权码由调用方经 OS 级 safeStorage 加密持久化；本模块负责连接、读件与
 * 验证内容提取，不负责落盘格式。
 */

export interface MailboxAccount {
  id: string;
  label: string;
  host: string;
  port: number;
  /** 登录名（完整邮箱地址） */
  user: string;
  /** safeStorage 加密后的授权码（本模块不接触明文落盘） */
  encryptedSecret: string;
  createdAt: number;
  lastCheckedAt: number | null;
  lastOkAt: number | null;
}

/** 常见邮箱的 IMAP 预设（刘总确认：仅网易与 QQ）。 */
export const MAILBOX_PRESETS: Record<string, { host: string; port: number; label: string }> = {
  qq: { host: 'imap.qq.com', port: 993, label: 'QQ 邮箱' },
  '163': { host: 'imap.163.com', port: 993, label: '网易 163 邮箱' },
  '126': { host: 'imap.126.com', port: 993, label: '网易 126 邮箱' },
};

export interface RecentMail {
  uid: number;
  from: string;
  subject: string;
  date: number;
  snippet: string;
  links: string[];
  codes: string[];
}

/** 从邮件文本里提取验证链接与验证码。导出仅为测试。 */
export function extractVerification(bodyText: string): { links: string[]; codes: string[] } {
  const links = Array.from(new Set(
    (bodyText.match(/https?:\/\/[^\s"'<>)\]]+/gu) ?? [])
      .map((link) => link.replace(/[.,;!?]+$/u, '')),
  ));
  const codes = new Set<string>();
  // 2026-08-24 实测：米醋API 等站点的验证码是 6 位字母数字混合（如 18958c），
  // 标签码必须接受字母数字，否则永远提取失败。
  const labeled = bodyText.matchAll(/(?:验证码|verification code|code)[^0-9A-Za-z]{0,16}([0-9A-Za-z]{4,8})/giu);
  for (const match of labeled) codes.add(match[1]!);
  if (codes.size === 0) {
    for (const match of bodyText.matchAll(/(?<![0-9A-Za-z])([0-9]{6})(?![0-9A-Za-z])/gu)) codes.add(match[1]!);
  }
  return { links, codes: [...codes] };
}

/** imapflow 构造签名（依赖注入以保持本模块可单测）。导出供调用方注入同形状 fake。 */
export type ImapFlowConstructor = new (options: Record<string, unknown>) => {
  connect(): Promise<void>;
  logout(): Promise<void>;
  mailboxLock: Promise<unknown> | null;
  messageList(options: { mailbox: string }): AsyncGenerator<{
    uid: number;
    from?: { value?: Array<{ address?: string; name?: string }> };
    to?: { value?: Array<{ address?: string; name?: string }> };
    subject?: string;
    date?: Date;
  }>;
  download(uid: number, options: { uid: true }): Promise<{ content: { text(): string } } | false>;
  close(): void;
};

/** 投稿邮件监听需要的完整邮件（相对 RecentMail 多了 Message-ID/线索/收件人/全文）。 */
export interface DetailedMail {
  uid: number;
  /** RFC Message-ID（去尖括号）；原文没有则为空串。 */
  messageId: string;
  /** 会话线索：In-Reply-To 优先，否则 References 的第一个引用。 */
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: number;
  /** 解码后的纯文本正文，截断到 100_000 字符。 */
  bodyText: string;
  /**
   * 邮件附件（决定信 Word/PDF 拆解用）。上限保护：
   * 单附件 ≤ MAX_ATTACHMENT_BYTES、每封最多 MAX_ATTACHMENTS_PER_MAIL 个，
   * 超限的直接跳过并如实缺失——绝不截断二进制后冒充完整文件。
   */
  attachments: MailAttachmentFile[];
}

export interface MailAttachmentFile {
  filename: string;
  mimeType: string;
  size: number;
  data: Buffer;
}

/** 单附件字节上限：决定信 PDF/DOCX 极少超过此值，防异常巨型附件拖垮同步。 */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
/** 每封邮件提取的附件个数上限。 */
const MAX_ATTACHMENTS_PER_MAIL = 5;

/**
 * 从 MIME 头参数串取属性值（filename / name 等）。
 * 处理带引号与 RFC 2231 filename*=UTF-8''… 两种常见形态；取不到返回空串。
 */
function mimeHeaderParam(headerLine: string, param: string): string {
  const extended = new RegExp(`${param}\\*=(?:[^']*'[^']*')?([^;]+)`, 'iu').exec(headerLine);
  if (extended) {
    try { return decodeURIComponent(extended[1]!.trim().replace(/^"|"$/gu, '')); } catch { /* fallthrough */ }
  }
  const plain = new RegExp(`${param}="([^"]*)"`, 'iu').exec(headerLine)
    ?? new RegExp(`${param}=([^;\\r\\n]+)`, 'iu').exec(headerLine);
  return plain ? plain[1]!.trim() : '';
}

/**
 * 从 RFC822 原文提取全部附件二进制（Content-Disposition: attachment 的 part）。
 * 只解 base64 与 quoted-printable 编码；其余编码如实跳过（不伪造内容）。
 * 原文里没有 boundary 或没有附件时返回空数组。
 */
export function extractMimeAttachments(raw: string): MailAttachmentFile[] {
  const crlfSep = raw.indexOf('\r\n\r\n');
  const lfSep = raw.indexOf('\n\n');
  if (crlfSep < 0 && lfSep < 0) return [];
  const headEnd = crlfSep >= 0 ? crlfSep : lfSep;
  const head = raw.slice(0, headEnd);
  const bodyStart = headEnd + (crlfSep >= 0 ? 4 : 2);
  // 正文内部可能还有子 multipart，这里只在顶层 boundary 内找 attachment part；
  // 子 part 里的深层附件极少见于编辑来信，如实不支持。
  const boundaryMatch = /boundary="?([^"\r\n;]+)"?/iu.exec(head);
  if (!boundaryMatch || !/multipart/iu.test(head)) return [];
  const boundary = boundaryMatch[1]!;
  const results: MailAttachmentFile[] = [];
  for (const segment of raw.slice(bodyStart).split('--' + boundary)) {
    const trimmed = segment.trim();
    if (!trimmed || trimmed === '--') continue;
    const partHeadEnd = trimmed.search(/\r?\n\r?\n/u);
    if (partHeadEnd < 0) continue;
    const partHead = trimmed.slice(0, partHeadEnd).replace(/\r?\n[ \t]+/gu, ' ');
    // 附件判定：Content-Disposition 为 attachment（或带 filename 的 inline）。
    if (!/content-disposition:\s*attachment/iu.test(partHead)
      && !(/content-disposition:\s*inline/iu.test(partHead) && /filename/iu.test(partHead))) continue;
    const filename = mimeHeaderParam(partHead.match(/content-disposition:[^\r\n]*/iu)?.[0] ?? '', 'filename')
      || mimeHeaderParam(partHead.match(/content-type:[^\r\n]*/iu)?.[0] ?? '', 'name');
    const typeMatch = /content-type:\s*([^;\r\n]+)/iu.exec(partHead);
    const mimeType = typeMatch ? typeMatch[1]!.trim().toLowerCase() : 'application/octet-stream';
    const cteMatch = /content-transfer-encoding:\s*([^\r\n;]+)/iu.exec(partHead);
    const cte = cteMatch ? cteMatch[1]!.trim().toLowerCase() : '7bit';
    let payload = trimmed.slice(trimmed.search(/\r?\n\r?\n/u)).replace(/^\r?\n\r?\n/u, '');
    payload = payload.replace(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}--\\s*$`), '');
    let data: Buffer | null = null;
    if (cte === 'base64') {
      data = Buffer.from(payload.replace(/\s+/gu, ''), 'base64');
    } else if (cte === 'quoted-printable') {
      const bytes: number[] = [];
      const cleaned = payload.replace(/=\r?\n/gu, '');
      for (let i = 0; i < cleaned.length; i += 1) {
        if (cleaned[i] === '=' && /^[0-9A-Fa-f]{2}$/u.test(cleaned.slice(i + 1, i + 3))) {
          bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          bytes.push(cleaned.charCodeAt(i) & 0xff);
        }
      }
      data = Buffer.from(bytes);
    }
    if (!data || data.length === 0 || !filename) continue;
    if (data.length > MAX_ATTACHMENT_BYTES) continue;
    if (results.length >= MAX_ATTACHMENTS_PER_MAIL) break;
    results.push({ filename, mimeType, size: data.length, data });
  }
  return results;
}

/** 单封邮件正文内存上限：投稿信件极少超过此长度，截断防异常巨型邮件拖垮解析。 */
const DETAILED_BODY_LIMIT = 100_000;

/**
 * 从 RFC822 原文的头段解析指定头字段（处理折行续行）；未命中返回空串。
 * 只认头段（第一个空行之前），正文里出现的同名字符串绝不当头处理。
 */
function parseRfc822Header(raw: string, name: string): string {
  const crlfSep = raw.indexOf('\r\n\r\n');
  const lfSep = raw.indexOf('\n\n');
  const headEnd = crlfSep >= 0 ? crlfSep : (lfSep >= 0 ? lfSep : raw.length);
  // 续行（以空白开头的行）折回上一行，再按行首匹配字段名。
  const head = raw.slice(0, headEnd).replace(/\r?\n[ \t]+/gu, ' ');
  const match = new RegExp(`^${name}:\\s*(.+)$`, 'imu').exec(head);
  return match ? match[1]!.trim() : '';
}

/** 从头字段值里取第一个引用标识并去尖括号（Message-ID / References 通用）。 */
function firstReferenceId(value: string): string {
  const bracketed = /<([^<>\s]+)>/u.exec(value);
  if (bracketed) return bracketed[1]!;
  const token = value.split(/\s+/u).find((part) => part.length > 0);
  return token ? token.replace(/^<|>$/gu, '') : '';
}

/**
 * 连接邮箱并读取最近 limit 封邮件的完整内容（投稿监听用）。
 * 与 fetchRecentMails 同连接流程，但解析 RFC822 原文头拿 Message-ID/References，
 * 并返回 decodeMimeText 后的全文（截断）。fetchRecentMails 的签名与行为不受影响。
 */
export async function fetchRecentMailsDetailed(
  imapFlowCtor: ImapFlowConstructor,
  account: { host: string; port: number; user: string },
  secret: string,
  limit = 10,
): Promise<DetailedMail[]> {
  const client = new imapFlowCtor({
    host: account.host,
    port: account.port,
    secure: true,
    auth: { user: account.user, pass: secret },
    logger: false,
    emitLogs: false,
  });
  await client.connect();
  try {
    const locks = client.messageList({ mailbox: 'INBOX' });
    const collected: DetailedMail[] = [];
    for await (const message of locks) {
      if (collected.length >= limit) break;
      const downloaded = await client.download(message.uid, { uid: true });
      const raw = downloaded && downloaded.content ? downloaded.content.text() : '';
      const references = parseRfc822Header(raw, 'In-Reply-To') || parseRfc822Header(raw, 'References');
      collected.push({
        uid: message.uid,
        messageId: firstReferenceId(parseRfc822Header(raw, 'Message-ID')),
        threadId: firstReferenceId(references),
        from: message.from?.value?.[0]?.address ?? '',
        to: message.to?.value?.[0]?.address ?? '',
        subject: message.subject ?? '',
        date: message.date ? message.date.getTime() : 0,
        bodyText: raw ? decodeMimeText(raw).slice(0, DETAILED_BODY_LIMIT) : '',
        attachments: raw ? extractMimeAttachments(raw) : [],
      });
    }
    return collected;
  } finally {
    try { client.close(); } catch { /* best effort */ }
  }
}

/**
 * 连接邮箱并读取最近 limit 封邮件（含验证链接/验证码提取）。
 * imapflow 以运行时依赖注入，保持本模块可单测。
 */
/**
 * 把原始 MIME 源码解码为可提取文本（2026-08-24 米醋实证）。
 * IMAP download() 拿到的是 RFC822 原文：正文可能是 base64 / quoted-printable，
 * 且常为 text/html。本函数：解 multipart 递归 → 按 Content-Transfer-Encoding 解码 →
 * 剥离 HTML 标签，返回纯文本。未识别的结构原样返回（宁滥勿缺，提取器再过滤）。
 */
export function decodeMimeText(raw: string): string {
  const crlfSep = raw.indexOf('\r\n\r\n');
  const lfSep = raw.indexOf('\n\n');
  const sep = crlfSep >= 0 ? '\r\n\r\n' : (lfSep >= 0 ? '\n\n' : null);
  if (sep === null) return stripHtml(raw);
  const headEnd = raw.indexOf(sep);
  const head = raw.slice(0, headEnd);
  const body = raw.slice(headEnd + sep.length);
  const boundaryMatch = /boundary="?([^"\r\n;]+)"?/i.exec(head);
  if (boundaryMatch && /multipart/iu.test(head)) {
    const boundary = boundaryMatch[1]!;
    const parts: string[] = [];
    for (const segment of body.split('--' + boundary)) {
      if (!segment.trim() || segment.trim() === '--') continue;
      const decoded = decodeMimeText(segment);
      if (decoded.trim()) parts.push(decoded);
    }
    return parts.join('\n');
  }
  const cteMatch = /content-transfer-encoding:\s*([^\r\n;]+)/iu.exec(head);
  const cte = cteMatch ? cteMatch[1]!.trim().toLowerCase() : '7bit';
  let text = body;
  if (cte === 'base64') {
    try { text = Buffer.from(body.replace(/\s+/gu, ''), 'base64').toString('utf8'); } catch { text = body; }
  } else if (cte === 'quoted-printable') {
    const cleaned = body.replace(/=\r?\n/gu, '');
    const bytes: number[] = [];
    for (let i = 0; i < cleaned.length; i += 1) {
      if (cleaned[i] === '=' && i + 2 < cleaned.length && /^[0-9A-Fa-f]{2}$/u.test(cleaned.slice(i + 1, i + 3))) {
        bytes.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(cleaned.charCodeAt(i) & 0xff);
      }
    }
    text = Buffer.from(bytes).toString('utf8');
  }
  return stripHtml(text);
}

function stripHtml(text: string): string {
  if (!/<\/?[a-zA-Z][^>]*>/u.test(text)) return text;
  return text
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/[ \t]+/gu, ' ');
}

export async function fetchRecentMails(
  imapFlowCtor: ImapFlowConstructor,
  account: { host: string; port: number; user: string },
  secret: string,
  limit = 10,
): Promise<RecentMail[]> {
  const client = new imapFlowCtor({
    host: account.host,
    port: account.port,
    secure: true,
    auth: { user: account.user, pass: secret },
    logger: false,
    emitLogs: false,
  });
  await client.connect();
  try {
    const locks = client.messageList({ mailbox: 'INBOX' });
    const collected: RecentMail[] = [];
    for await (const message of locks) {
      if (collected.length >= limit) break;
      const downloaded = await client.download(message.uid, { uid: true });
      const bodyText = downloaded && downloaded.content ? downloaded.content.text() : '';
      const verification = extractVerification(bodyText);
      collected.push({
        uid: message.uid,
        from: message.from?.value?.[0]?.address ?? '',
        subject: message.subject ?? '',
        date: message.date ? message.date.getTime() : 0,
        snippet: bodyText.replace(/\s+/gu, ' ').slice(0, 200),
        links: verification.links.slice(0, 6),
        codes: verification.codes.slice(0, 4),
      });
    }
    return collected;
  } finally {
    try { client.close(); } catch { /* best effort */ }
  }
}
