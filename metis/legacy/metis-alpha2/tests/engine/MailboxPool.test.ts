/**
 * MailboxPool 解码与验证码提取测试（2026-08-24 米醋API 实证样本）。
 * 实证事实：
 *  1. IMAP download 返回原始 MIME；验证邮件是 base64 编码的 text/html；
 *  2. 验证码可以是 6 位字母数字混合（米醋实测 18958c）；
 *  3. QQ 会把中转站验证邮件判进 Junk（文件夹遍历在 FreeModelService 侧）。
 */
import { describe, it, expect } from 'vitest';
import { decodeMimeText, extractVerification, fetchRecentMailsDetailed, type ImapFlowConstructor } from '../../engine/mail/MailboxPool.js';

// 米醋API 真实验证邮件正文（base64 原样样本，内容：您好，你正在进行米醋API 邮箱验证。您的验证码为: 18958c …）
const MICU_BODY_B64 =
  'PHA+5oKo5aW977yM5L2g5q2j5Zyo6L+b6KGM57Gz6YaLQVBJIOmCrueusemqjOivgeOAgjwvcD48cD7mgqjnmoTpqozor4HnoIHkuLo6IDxzdHJvbmc+MTg5NThjPC9zdHJvbmc+PC9wPjxwPumqjOivgeeggSAxMCDliIbpkp/lhoXmnInmlYjvvIzlpoLmnpzkuI3mmK/mnKzkurrmk43kvZzvvIzor7flv73nlaXjgII8L3A+';
const MICU_RAW = [
  'From: noreply@mail.micuapi.ai',
  'Subject: =?UTF-8?b?57Gz6YaLQVBJIOmCrueusemqjOivgemCruS7tg==?=',
  'Content-Type: text/html; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  MICU_BODY_B64,
].join('\r\n');

describe('decodeMimeText', () => {
  it('decodes base64 html bodies to plain text (米醋实证)', () => {
    const text = decodeMimeText(MICU_RAW);
    expect(text).toContain('米醋');
    expect(text).toContain('18958c');
    expect(text).not.toContain('<strong>');
    expect(text).not.toContain('PHA+');
  });
  it('handles quoted-printable utf-8', () => {
    const raw = 'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n=E6=82=A8=E7=9A=84=E9=AA=8C=E8=AF=81=E7=A0=81=E4=B8=BA: 123456';
    const text = decodeMimeText(raw);
    expect(text).toContain('123456');
  });
  it('recurses multipart/alternative', () => {
    const raw = [
      'Content-Type: multipart/alternative; boundary="abc123"',
      '',
      '--abc123',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('plain part code 777777', 'utf8').toString('base64'),
      '--abc123',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('<p>html part <b>888888</b></p>', 'utf8').toString('base64'),
      '--abc123--',
    ].join('\r\n');
    const text = decodeMimeText(raw);
    expect(text).toContain('777777');
    expect(text).toContain('888888');
  });
  it('returns plain text untouched when no MIME headers', () => {
    expect(decodeMimeText('your code is 424242')).toContain('424242');
  });
});

describe('extractVerification alphanumeric codes', () => {
  it('extracts 6-char alphanumeric labeled codes (米醋 18958c)', () => {
    const text = decodeMimeText(MICU_RAW);
    const { codes } = extractVerification(text);
    expect(codes).toContain('18958c');
  });
  it('still extracts pure-digit codes', () => {
    const { codes } = extractVerification('您的验证码为: 246810，5 分钟内有效');
    expect(codes).toContain('246810');
  });
  it('falls back to six-digit scan when unlabeled', () => {
    const { codes } = extractVerification('hello 135790 world');
    expect(codes).toContain('135790');
  });
  it('does not extract long words as codes', () => {
    const { codes } = extractVerification('verification completed successfully');
    expect(codes).toEqual([]);
  });
});

// ─── fetchRecentMailsDetailed（投稿邮件监听） ─────────────────

interface FakeDetailMail { uid: number; from: string; subject: string; date: number; raw: string }

/** 与 ImapFlowConstructor 同形状的 fake：messageList 发信封，download 发 RFC822 原文。 */
class FakeDetailImapFlow {
  static mails: FakeDetailMail[] = [];
  readonly mailboxLock = null;
  constructor(public readonly options: Record<string, unknown>) { /* fake */ }
  async connect(): Promise<void> { /* fake */ }
  async logout(): Promise<void> { /* fake */ }
  async *messageList(): AsyncGenerator<{ uid: number; from: { value: Array<{ address: string }> }; to: { value: Array<{ address: string }> }; subject: string; date: Date }> {
    for (const mail of FakeDetailImapFlow.mails) {
      yield {
        uid: mail.uid,
        from: { value: [{ address: mail.from }] },
        to: { value: [{ address: 'me@qq.com' }] },
        subject: mail.subject,
        date: new Date(mail.date),
      };
    }
  }
  async download(uid: number): Promise<{ content: { text(): string } } | false> {
    const mail = FakeDetailImapFlow.mails.find((item) => item.uid === uid);
    return mail ? { content: { text: () => mail.raw } } : false;
  }
  close(): void { /* fake */ }
}

const DETAIL_CTOR = FakeDetailImapFlow as unknown as ImapFlowConstructor;
const ACCOUNT = { host: 'imap.qq.com', port: 993, user: 'me@qq.com' };

describe('fetchRecentMailsDetailed', () => {
  it('从 RFC822 头解析 Message-ID 与 In-Reply-To 线索（去尖括号）', async () => {
    FakeDetailImapFlow.mails = [{
      uid: 11,
      from: 'editor@journal.org',
      subject: 'Decision on manuscript J-1',
      date: 1_760_000_000_000,
      raw: [
        'Message-ID: <decision-1@journal.org>',
        'In-Reply-To: <submit-1@journal.org>',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        'We have reached a decision.',
      ].join('\r\n'),
    }];
    const mails = await fetchRecentMailsDetailed(DETAIL_CTOR, ACCOUNT, 'secret');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.messageId).toBe('decision-1@journal.org');
    expect(mails[0]!.threadId).toBe('submit-1@journal.org');
    expect(mails[0]!.from).toBe('editor@journal.org');
    expect(mails[0]!.to).toBe('me@qq.com');
    expect(mails[0]!.bodyText).toContain('decision');
  });

  it('无 In-Reply-To 时回退 References 的第一个引用', async () => {
    FakeDetailImapFlow.mails = [{
      uid: 12, from: 'a@b.com', subject: 'Re: hello', date: 1,
      raw: [
        'Message-ID: <m2@b.com>',
        'References: <m0@b.com> <m1@b.com>',
        '',
        'reply body',
      ].join('\r\n'),
    }];
    const mails = await fetchRecentMailsDetailed(DETAIL_CTOR, ACCOUNT, 'secret');
    expect(mails[0]!.messageId).toBe('m2@b.com');
    expect(mails[0]!.threadId).toBe('m0@b.com');
  });

  it('头字段缺失时 messageId/threadId 如实为空串', async () => {
    FakeDetailImapFlow.mails = [{ uid: 13, from: 'a@b.com', subject: 'no headers', date: 1, raw: 'plain body without any header' }];
    const mails = await fetchRecentMailsDetailed(DETAIL_CTOR, ACCOUNT, 'secret');
    expect(mails[0]!.messageId).toBe('');
    expect(mails[0]!.threadId).toBe('');
  });

  it('正文截断到 100_000 字符', async () => {
    FakeDetailImapFlow.mails = [{
      uid: 14, from: 'a@b.com', subject: 'long', date: 1,
      raw: `Content-Type: text/plain\r\n\r\n${'x'.repeat(100_500)}`,
    }];
    const mails = await fetchRecentMailsDetailed(DETAIL_CTOR, ACCOUNT, 'secret');
    expect(mails[0]!.bodyText).toHaveLength(100_000);
  });

  it('base64 正文经 decodeMimeText 解码（米醋实证路径）', async () => {
    FakeDetailImapFlow.mails = [{ uid: 15, from: 'a@b.com', subject: 'mime', date: 1, raw: MICU_RAW }];
    const mails = await fetchRecentMailsDetailed(DETAIL_CTOR, ACCOUNT, 'secret');
    expect(mails[0]!.bodyText).toContain('18958c');
    expect(mails[0]!.bodyText).not.toContain('PHA+');
  });

  it('limit 截断且逐封拉取', async () => {
    FakeDetailImapFlow.mails = [
      { uid: 16, from: 'a@b.com', subject: 'one', date: 1, raw: 'a' },
      { uid: 17, from: 'a@b.com', subject: 'two', date: 2, raw: 'b' },
      { uid: 18, from: 'a@b.com', subject: 'three', date: 3, raw: 'c' },
    ];
    const mails = await fetchRecentMailsDetailed(DETAIL_CTOR, ACCOUNT, 'secret', 2);
    expect(mails.map((mail) => mail.uid)).toEqual([16, 17]);
  });
});
