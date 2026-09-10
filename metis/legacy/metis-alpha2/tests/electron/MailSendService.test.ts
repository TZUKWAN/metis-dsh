/**
 * MailSendService / engine MailSender 测试（P3/P4 投稿外发邮件）。
 *
 * 覆盖：
 *  - engine 层：smtpConfigForUser 域名映射（qq/163/126 命中、未知域名 null）；
 *    sendMail 入参校验、鉴权错误映射（535/EAUTH/Invalid login → mail_auth_failed）；
 *  - previewSend：账户/收件人/主题校验与规范化，绝不触网；
 *  - sendMail：成功落库 + correspondence_sent 事件；鉴权失败/网络失败不落库；
 *    相同 operationId 重试不重发（fake transport 只被调一次）；
 *    secret 解密失败；未知域名账户的 mail_smtp_config_unknown。
 *
 * 全程使用 fake createTransport，不触真实网络、不用真实 nodemailer transport。
 */
/** @vitest-environment node */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  sendMail as engineSendMail,
  smtpConfigForUser,
  type CreateMailTransport,
  type OutgoingMailMessage,
  type SmtpConnectionOptions,
} from '../../engine/mail/MailSender.js';
import type { MailboxAccount } from '../../engine/mail/MailboxPool.js';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import { MailSendService } from '../../electron/MailSendService.js';
import { MailboxPoolStore } from '../../electron/ModelDiscoveryStore.js';
import { SubmissionCorrespondenceRepository } from '../../electron/SubmissionCorrespondenceRepository.js';
import { SubmissionRepository } from '../../electron/SubmissionRepository.js';

// ─── fake SMTP transport（记录调用、可控成功/失败） ─────────────

type FakeMode = 'success' | 'auth' | 'network';

function createFakeTransport(mode: FakeMode) {
  const calls: Array<{ options: SmtpConnectionOptions; message: OutgoingMailMessage }> = [];
  const factory: CreateMailTransport = (options) => ({
    sendMail: async (message) => {
      calls.push({ options, message });
      if (mode === 'auth') {
        const error = new Error('535 Login Fail. Please enter your authorization code');
        (error as { responseCode?: number }).responseCode = 535;
        throw error;
      }
      if (mode === 'network') throw new Error('connect ETIMEDOUT 124.XX.XX.XX:465');
      return { messageId: `<fake-${calls.length}@smtp.qq.com>` };
    },
  });
  return { factory, calls };
}

// ─── DB / store seed ─────────────────────────────────────────

let db: Database.Database;
let dataDir: string;
let mailboxStore: MailboxPoolStore;
let correspondenceRepository: SubmissionCorrespondenceRepository;
let submissionRepository: SubmissionRepository;

function makeAccount(overrides: Partial<MailboxAccount> = {}): MailboxAccount {
  return {
    id: 'mb-1',
    label: '测试 QQ 邮箱',
    host: 'imap.qq.com',
    port: 993,
    user: 'author@qq.com',
    encryptedSecret: 'enc:secret',
    createdAt: 1,
    lastCheckedAt: null,
    lastOkAt: null,
    ...overrides,
  };
}

function createService(mode: FakeMode = 'success') {
  const fake = createFakeTransport(mode);
  const service = new MailSendService({
    mailboxStore,
    // 只有测试密文能解密；其余一律失败，模拟 safeStorage 不可用。
    decryptSecret: (encrypted) => (encrypted === 'enc:secret' ? 'plain-secret' : null),
    correspondenceRepository,
    submissionRepository,
    createTransport: fake.factory,
  });
  return { service, calls: fake.calls };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects (id,title,created_at,updated_at) VALUES ('p1','项目一',1,1)").run();
  db.prepare("INSERT INTO outcomes (id,project_id,title,kind,status,current_version,created_at,updated_at) VALUES ('out-1','p1','论文一','word','draft',1,1,1)").run();
  db.prepare("INSERT INTO outcome_versions (outcome_id,version,content,content_hash,note,created_by,created_at) VALUES ('out-1',1,'{}','h','创建','human',1)").run();
  db.prepare("INSERT INTO submission_series (id,project_id,source_outcome_id,title,notes,created_at,updated_at) VALUES ('series-1','p1','out-1','链一','',1,1)").run();
  db.prepare("INSERT INTO submission_cases (id,series_id,project_id,title,status,created_at,updated_at) VALUES ('case-1','series-1','p1','论文一','PROFILING',1,1)").run();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-mail-test-'));
  mailboxStore = new MailboxPoolStore(dataDir);
  correspondenceRepository = new SubmissionCorrespondenceRepository(db);
  submissionRepository = new SubmissionRepository(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ─── engine：smtpConfigForUser 域名映射 ───────────────────────

describe('smtpConfigForUser', () => {
  it('qq/163/126 域名命中预设，均 465 + secure', () => {
    expect(smtpConfigForUser('a@qq.com')).toMatchObject({ host: 'smtp.qq.com', port: 465, secure: true });
    expect(smtpConfigForUser('a@163.com')).toMatchObject({ host: 'smtp.163.com', port: 465, secure: true });
    expect(smtpConfigForUser('a@126.com')).toMatchObject({ host: 'smtp.126.com', port: 465, secure: true });
    // 大小写不敏感。
    expect(smtpConfigForUser('A@QQ.COM')).toMatchObject({ host: 'smtp.qq.com' });
  });

  it('未知域名与非法输入返回 null，不猜配置', () => {
    expect(smtpConfigForUser('a@gmail.com')).toBeNull();
    expect(smtpConfigForUser('a@vip.qq.com')).toBeNull();
    expect(smtpConfigForUser('not-an-email')).toBeNull();
    expect(smtpConfigForUser('')).toBeNull();
  });
});

// ─── engine：sendMail 校验与错误映射 ──────────────────────────

describe('engine sendMail', () => {
  const baseInput = {
    host: 'smtp.qq.com', port: 465, secure: true,
    user: 'author@qq.com', secret: 'plain-secret',
    to: 'editor@journal.example.com', subject: '投稿咨询', text: '正文',
  };

  it('入参非法返回 mail_invalid_request，且不创建 transport', async () => {
    const fake = createFakeTransport('success');
    const result = await engineSendMail({ createTransport: fake.factory }, { ...baseInput, to: '  ' });
    expect(result).toMatchObject({ ok: false, code: 'mail_invalid_request' });
    expect(fake.calls).toHaveLength(0);
  });

  it('鉴权类错误（535 / EAUTH / Invalid login）映射为 mail_auth_failed', async () => {
    const by535 = await engineSendMail({ createTransport: createFakeTransport('auth').factory }, baseInput);
    expect(by535).toMatchObject({ ok: false, code: 'mail_auth_failed' });

    const eauth: CreateMailTransport = () => ({
      sendMail: async () => {
        const error = new Error('Authentication failed');
        (error as { code?: string }).code = 'EAUTH';
        throw error;
      },
    });
    expect(await engineSendMail({ createTransport: eauth }, baseInput))
      .toMatchObject({ ok: false, code: 'mail_auth_failed' });

    const invalidLogin: CreateMailTransport = () => ({
      sendMail: async () => { throw new Error('Invalid login: 535 Error'); },
    });
    expect(await engineSendMail({ createTransport: invalidLogin }, baseInput))
      .toMatchObject({ ok: false, code: 'mail_auth_failed' });
  });

  it('非鉴权异常映射为 mail_send_failed，绝不吞成 ok', async () => {
    const result = await engineSendMail({ createTransport: createFakeTransport('network').factory }, baseInput);
    expect(result).toMatchObject({ ok: false, code: 'mail_send_failed' });
    if (result.ok) return;
    expect(result.message).toContain('ETIMEDOUT');
  });

  it('成功时透传 messageId，from 缺省取 user，授权码只进 auth.pass', async () => {
    const fake = createFakeTransport('success');
    const result = await engineSendMail({ createTransport: fake.factory }, baseInput);
    expect(result).toMatchObject({ ok: true, messageId: '<fake-1@smtp.qq.com>' });
    expect(fake.calls[0]!.message.from).toBe('author@qq.com');
    expect(fake.calls[0]!.options.auth).toEqual({ user: 'author@qq.com', pass: 'plain-secret' });
  });
});

// ─── MailSendService.previewSend ─────────────────────────────

describe('MailSendService.previewSend', () => {
  it('校验通过返回规范化预览，绝不触网', () => {
    mailboxStore.add(makeAccount());
    const { service, calls } = createService();
    const result = service.previewSend({
      accountId: 'mb-1',
      to: '  editor@journal.example.com ',
      subject: '  投稿咨询  ',
      bodyText: '正文',
      attachments: [{ filename: 'manuscript.docx', path: '/tmp/m.docx' }, { filename: 'note.txt', content: 'x' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.from).toBe('author@qq.com');
    expect(result.preview.to).toBe('editor@journal.example.com');
    expect(result.preview.subject).toBe('投稿咨询');
    expect(result.preview.smtp).toEqual({ host: 'smtp.qq.com', port: 465, secure: true });
    expect(result.preview.attachments).toEqual([
      { filename: 'manuscript.docx', source: 'path' },
      { filename: 'note.txt', source: 'content' },
    ]);
    expect(calls).toHaveLength(0);
  });

  it('收件人/主题为空、账户不存在时结构化失败', () => {
    mailboxStore.add(makeAccount());
    const { service } = createService();
    expect(service.previewSend({ accountId: 'mb-1', to: ' ', subject: 's', bodyText: '' }))
      .toMatchObject({ ok: false, code: 'mail_invalid_request' });
    expect(service.previewSend({ accountId: 'mb-1', to: 'e@j.com', subject: ' ', bodyText: '' }))
      .toMatchObject({ ok: false, code: 'mail_invalid_request' });
    expect(service.previewSend({ accountId: 'mb-missing', to: 'e@j.com', subject: 's', bodyText: '' }))
      .toMatchObject({ ok: false, code: 'mail_account_not_found' });
  });
});

// ─── MailSendService.sendMail ────────────────────────────────

const SEND_INPUT = {
  projectId: 'p1',
  caseId: 'case-1',
  accountId: 'mb-1',
  operationId: 'op-001',
  to: 'editor@journal.example.com',
  subject: '投稿咨询',
  bodyText: '尊敬的编辑：……',
};

describe('MailSendService.sendMail', () => {
  it('发送成功：落库 + 追加 correspondence_sent 事件，授权码仅在发送瞬间解密', async () => {
    mailboxStore.add(makeAccount());
    const { service, calls } = createService('success');
    const result = await service.sendMail(SEND_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alreadySent).toBe(false);
    expect(result.messageId).toBe('<fake-1@smtp.qq.com>');

    // 真实 transport 收到了推断出的 QQ SMTP 配置与解密后的授权码。
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({ host: 'smtp.qq.com', port: 465, secure: true });
    expect(calls[0]!.options.auth).toEqual({ user: 'author@qq.com', pass: 'plain-secret' });
    expect(calls[0]!.message.to).toBe('editor@journal.example.com');

    // 通信记录落库。
    const record = correspondenceRepository.findByOperationId('op-001');
    expect(record).toBeDefined();
    expect(record).toMatchObject({
      direction: 'out', projectId: 'p1', caseId: 'case-1', accountId: 'mb-1',
      messageId: '<fake-1@smtp.qq.com>', toAddr: 'editor@journal.example.com',
    });
    expect(correspondenceRepository.listByCase('p1', 'case-1')).toHaveLength(1);

    // Case timeline 追加 correspondence_sent 事件（source=email）。
    const events = submissionRepository.listEvents('p1', 'case-1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'correspondence_sent', source: 'email' });
    expect(events[0]!.metadata).toMatchObject({ correspondenceId: record!.id, operationId: 'op-001' });
  });

  it('鉴权失败：mail_auth_failed，不落库、不追加事件', async () => {
    mailboxStore.add(makeAccount());
    const { service } = createService('auth');
    const result = await service.sendMail(SEND_INPUT);
    expect(result).toMatchObject({ ok: false, code: 'mail_auth_failed' });
    expect(correspondenceRepository.findByOperationId('op-001')).toBeUndefined();
    expect(submissionRepository.listEvents('p1', 'case-1')).toHaveLength(0);
  });

  it('网络失败：mail_send_failed，不落库、不追加事件', async () => {
    mailboxStore.add(makeAccount());
    const { service } = createService('network');
    const result = await service.sendMail(SEND_INPUT);
    expect(result).toMatchObject({ ok: false, code: 'mail_send_failed' });
    expect(correspondenceRepository.findByOperationId('op-001')).toBeUndefined();
    expect(submissionRepository.listEvents('p1', 'case-1')).toHaveLength(0);
  });

  it('相同 operationId 重试：直接返回原记录，fake transport 只被调一次', async () => {
    mailboxStore.add(makeAccount());
    const { service, calls } = createService('success');
    const first = await service.sendMail(SEND_INPUT);
    expect(first.ok && !first.alreadySent).toBe(true);
    const second = await service.sendMail(SEND_INPUT);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.alreadySent).toBe(true);
    expect(second.record.id).toBe(first.ok ? first.record.id : '');
    // 第二次没有触发任何真实发送。
    expect(calls).toHaveLength(1);
    expect(correspondenceRepository.listByCase('p1', 'case-1')).toHaveLength(1);
    expect(submissionRepository.listEvents('p1', 'case-1')).toHaveLength(1);
  });

  it('secret 解密失败：mail_secret_unavailable，不创建 transport、不落库', async () => {
    mailboxStore.add(makeAccount({ encryptedSecret: 'enc:corrupted' }));
    const { service, calls } = createService('success');
    const result = await service.sendMail(SEND_INPUT);
    expect(result).toMatchObject({ ok: false, code: 'mail_secret_unavailable' });
    expect(calls).toHaveLength(0);
    expect(correspondenceRepository.findByOperationId('op-001')).toBeUndefined();
  });

  it('未知域名账户：mail_smtp_config_unknown，不猜配置、不落库', async () => {
    mailboxStore.add(makeAccount({ id: 'mb-2', user: 'someone@gmail.com' }));
    const { service, calls } = createService('success');
    const result = await service.sendMail({ ...SEND_INPUT, accountId: 'mb-2' });
    expect(result).toMatchObject({ ok: false, code: 'mail_smtp_config_unknown' });
    expect(calls).toHaveLength(0);
    expect(correspondenceRepository.findByOperationId('op-001')).toBeUndefined();
  });

  it('账户不存在 / Case 不存在 / operationId 缺失：结构化失败', async () => {
    mailboxStore.add(makeAccount());
    const { service, calls } = createService('success');
    expect(await service.sendMail({ ...SEND_INPUT, accountId: 'mb-missing' }))
      .toMatchObject({ ok: false, code: 'mail_account_not_found' });
    expect(await service.sendMail({ ...SEND_INPUT, caseId: 'case-missing' }))
      .toMatchObject({ ok: false, code: 'mail_case_not_found' });
    expect(await service.sendMail({ ...SEND_INPUT, operationId: ' ' }))
      .toMatchObject({ ok: false, code: 'mail_invalid_request' });
    expect(calls).toHaveLength(0);
  });
});
