/**
 * Decision Letter 附件解析测试。
 *
 * 覆盖：
 *  - MailboxPool.extractMimeAttachments：multipart/mixed + base64 附件的
 *    文件名/MIME/字节解码、非附件 part 忽略、无附件原文返回空数组；
 *  - DecisionLetterAttachments.extractAttachmentText：
 *    DOCX（jszip 现场构造最小合法包）、纯文本、不支持类型如实拒绝、
 *    损坏 PDF 如实报 extract_failed；
 *  - SubmissionMailService 集成：决定信类邮件同步时提取附件文本落库，
 *    非决定信类只记文件名不提取；createRoundFromCorrespondence 把
 *    附件文本带来源标记合并进决定信全文（原文不丢）。
 */
/** @vitest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import { extractMimeAttachments, type ImapFlowConstructor } from '../../engine/mail/MailboxPool.js';
import { extractAttachmentText } from '../../electron/DecisionLetterAttachments.js';
import { MailboxPoolStore } from '../../electron/ModelDiscoveryStore.js';
import { SubmissionCorrespondenceRepository } from '../../electron/SubmissionCorrespondenceRepository.js';
import { SubmissionMailService } from '../../electron/SubmissionMailService.js';
import { SubmissionRepository } from '../../electron/SubmissionRepository.js';
import { SubmissionReviewRepository } from '../../electron/SubmissionReviewRepository.js';
import { SubmissionReviewService } from '../../electron/SubmissionReviewService.js';

// ─── extractMimeAttachments ─────────────────────────────────

function multipartRaw(boundary: string, parts: string[]): string {
  // 每个 part 是一段完整的多行 MIME 文本（含自己的头与空行分隔的正文）。
  return [
    'From: editor@journal.org',
    'Subject: Decision',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    ...parts.flatMap((part) => ['--' + boundary, part]),
    '--' + boundary + '--',
    '',
  ].join('\r\n');
}

const TEXT_PART = ['Content-Type: text/plain; charset=utf-8', '', 'Decision: major revision.'].join('\r\n');

describe('extractMimeAttachments', () => {
  it('解析 base64 DOCX 附件的文件名/MIME/字节', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="w"><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:document>');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    const b64 = bytes.toString('base64').replace(/(.{76})/gu, '$1\r\n');
    const raw = multipartRaw('BOUND1', [TEXT_PART, [
      'Content-Disposition: attachment; filename="decision.docx"',
      'Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Transfer-Encoding: base64',
      '',
      b64,
    ].join('\r\n')]);
    const attachments = extractMimeAttachments(raw);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.filename).toBe('decision.docx');
    expect(attachments[0]!.size).toBe(bytes.length);
    expect(Buffer.compare(attachments[0]!.data, bytes)).toBe(0);
  });

  it('忽略非附件正文 part；无附件原文返回空数组', () => {
    const withPlain = multipartRaw('B2', [['Content-Type: text/plain; charset=utf-8', '', 'just body'].join('\r\n')]);
    expect(extractMimeAttachments(withPlain)).toHaveLength(0);
    expect(extractMimeAttachments('From: a@b.c\r\nSubject: x\r\n\r\nplain body')).toHaveLength(0);
  });
});

// ─── extractAttachmentText ──────────────────────────────────

async function buildDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="w">${body}</w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('extractAttachmentText', () => {
  it('DOCX 按段落提取文本并保留 Reviewer 标题', async () => {
    const data = await buildDocx(['Decision: Major revision', 'Reviewer 1:', 'The baseline setup is unclear.']);
    const result = await extractAttachmentText({
      filename: 'decision.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      data,
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Decision: Major revision');
    expect(result.text).toContain('Reviewer 1:');
    expect(result.text).toContain('The baseline setup is unclear.');
  });

  it('纯文本直接解码；不支持类型如实拒绝', async () => {
    const txt = await extractAttachmentText({ filename: 'letter.txt', mimeType: 'text/plain', data: Buffer.from('Reviewer 2: add baselines.') });
    expect(txt.ok).toBe(true);
    expect(txt.text).toContain('Reviewer 2');

    const exe = await extractAttachmentText({ filename: 'tool.exe', mimeType: 'application/octet-stream', data: Buffer.from([0x4d, 0x5a]) });
    expect(exe.ok).toBe(false);
    expect(exe.reason).toBe('unsupported_type');
    expect(exe.text).toBe('');
  });

  it('损坏 PDF 报 extract_failed 而不是编造文本', async () => {
    const broken = await extractAttachmentText({ filename: 'broken.pdf', mimeType: 'application/pdf', data: Buffer.from('not a pdf') });
    expect(broken.ok).toBe(false);
    expect(broken.reason.startsWith('extract_failed')).toBe(true);
    expect(broken.text).toBe('');
  });
});

// ─── SubmissionMailService 集成 ─────────────────────────────

interface FakeMail {
  uid: number; from: string; subject: string; date: number; raw: string;
}
class FakeImapFlow {
  static mails: FakeMail[] = [];
  readonly mailboxLock = null;
  constructor(public readonly options: Record<string, unknown>) {}
  async connect(): Promise<void> {}
  async logout(): Promise<void> {}
  async *messageList(): AsyncGenerator<{ uid: number; from: { value: Array<{ address: string }> }; to: { value: Array<{ address: string }> }; subject: string; date: Date }> {
    for (const mail of FakeImapFlow.mails) {
      yield { uid: mail.uid, from: { value: [{ address: mail.from }] }, to: { value: [{ address: 'me@qq.com' }] }, subject: mail.subject, date: new Date(mail.date) };
    }
  }
  async download(uid: number): Promise<{ content: { text(): string } } | false> {
    const mail = FakeImapFlow.mails.find((item) => item.uid === uid);
    return mail ? { content: { text: () => mail.raw } } : false;
  }
  close(): void {}
}
const FAKE_CTOR = FakeImapFlow as unknown as ImapFlowConstructor;

function decisionMailWithDocx(docx: Buffer): FakeMail {
  const b64 = docx.toString('base64');
  return {
    uid: 7,
    from: 'editor@journaloftesting.org',
    subject: 'Decision on manuscript JOT-2026-0142',
    date: 1_760_000_200_000,
    raw: multipartRaw('B3', [[
      'Content-Disposition: attachment; filename="JOT-decision.docx"',
      'Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Transfer-Encoding: base64',
      '',
      b64.replace(/(.{76})/gu, '$1\r\n'),
    ].join('\r\n')]),
  };
}

function newsletterMail(): FakeMail {
  return {
    uid: 8,
    from: 'news@random.org',
    subject: 'Weekly digest',
    date: 1_760_000_300_000,
    raw: multipartRaw('B4', [[
      'Content-Disposition: attachment; filename="digest.pdf"',
      'Content-Type: application/pdf',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('%PDF-1.4 fake').toString('base64'),
    ].join('\r\n')]),
  };
}

// ─── DB / 服务装配 + 集成用例 ────────────────────────────────

describe('SubmissionMailService 附件集成', () => {
  let db: Database.Database;
  let dataDir: string;
  let mailboxStore: MailboxPoolStore;
  let correspondenceRepository: SubmissionCorrespondenceRepository;
  let submissionRepository: SubmissionRepository;
  let reviewRepository: SubmissionReviewRepository;
  let service: SubmissionMailService;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-decision-letter-'));
    mailboxStore = new MailboxPoolStore(dataDir);
    mailboxStore.add({
      id: 'acc-1', label: 'test', user: 'me@qq.com', host: 'imap.qq.com', port: 993,
      encryptedSecret: 'enc', createdAt: 1, lastCheckedAt: null, lastOkAt: null,
    });
    db.prepare(`INSERT INTO projects (id,title,created_at,updated_at) VALUES ('p1','Test Project',1,1)`).run();
    submissionRepository = new SubmissionRepository(db);
    db.prepare(`INSERT INTO submission_series (id,project_id,title,notes,created_at,updated_at) VALUES ('s1','p1','series','',1,1)`).run();
  db.prepare(`INSERT INTO submission_cases (id,series_id,project_id,title,status,target_journal_name,remote_submission_id,created_at,updated_at)
    VALUES ('case-1','s1','p1','Test manuscript','UNDER_REVIEW','Journal of Testing','JOT-2026-0142',1,1)`).run();
  correspondenceRepository = new SubmissionCorrespondenceRepository(db);
  reviewRepository = new SubmissionReviewRepository(db);
  const reviewService = new SubmissionReviewService({
    submissionRepository,
    reviewRepository,
    outcomeRepository: null as never,
  });
  service = new SubmissionMailService({
    mailboxStore,
    decryptSecret: () => 'secret',
    correspondenceRepository,
    submissionRepository,
    reviewService,
    imapClientCtor: FAKE_CTOR,
  });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('决定信附件：同步时提取文本落库，建轮次合并附件段且保留来源标记', async () => {
    const docx = await buildDocx(['Reviewer 1:', 'Please clarify Figure 3.']);
    FakeImapFlow.mails = [decisionMailWithDocx(docx)];
    const sync = await service.syncAccount({ projectId: 'p1', accountId: 'acc-1' });
    expect(sync.ok).toBe(true);

    const pending = correspondenceRepository.listPending('p1');
    expect(pending).toHaveLength(1);
    const record0 = pending[0]!;
    expect(record0.classification).toBe('decision_letter');
    expect(record0.attachmentNames).toEqual(['JOT-decision.docx']);
    expect(record0.attachmentTexts).toHaveLength(1);
    expect(record0.attachmentTexts[0]!.filename).toBe('JOT-decision.docx');
    expect(record0.attachmentTexts[0]!.text).toContain('Please clarify Figure 3.');

    correspondenceRepository.resolveMatch({ projectId: 'p1', id: record0.id, approve: true, caseId: 'case-1' });
    const created = service.createRoundFromCorrespondence({ projectId: 'p1', id: record0.id });
    expect(created.ok).toBe(true);

    const rounds = reviewRepository.listRounds('p1', 'case-1');
    expect(rounds).toHaveLength(1);
    // 原文与附件文本都进入决定信全文，来源标记保留；Reviewer 段落被拆出。
    expect(rounds[0]!.decisionLetterText).toContain('--- 附件：JOT-decision.docx ---');
    const comments = reviewRepository.listComments(rounds[0]!.id);
    expect(comments.some((comment) => comment.originalText.includes('Please clarify Figure 3.'))).toBe(true);
  });

  it('非决定信邮件：附件只记文件名，不提取文本', async () => {
    FakeImapFlow.mails = [newsletterMail()];
    await service.syncAccount({ projectId: 'p1', accountId: 'acc-1' });
    const pending = correspondenceRepository.listPending('p1');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.attachmentNames).toEqual(['digest.pdf']);
    expect(pending[0]!.attachmentTexts).toEqual([]);
  });
});
