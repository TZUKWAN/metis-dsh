/**
 * SubmissionMailService 测试（P4 邮件监听 + Case 自动关联 + Decision 识别）。
 *
 * 覆盖：
 *  - MailboxPool.fetchRecentMailsDetailed：Message-ID / In-Reply-To / References 解析、
 *    缺头回退空串、正文截断（另见 tests/engine/MailboxPool.test.ts 的补充用例）；
 *  - classifyMail：全部关键词分支 + 优先级（revision_request 压过 decision 字样）；
 *  - suggestCase：强（编号）/中（刊名/域名）/弱（标题词）命中、歧义并列返 null、
 *    终态 Case 不参与匹配、无命中返 null；
 *  - syncAccount：落库 + 去重（二次同步不重复）、未命中邮件挂 pending 且无 caseId、
 *    decrypt 失败与账户缺失的结构化错误；
 *  - confirmMatch / rejectMatch：确认追加 correspondence_matched 事件；
 *  - createRoundFromCorrespondence：确认后建 round 成功、未确认被拒、
 *    非决定信分类被拒、reviewService 未注入返回 review_service_unavailable。
 *
 * IMAP 客户端用 FakeImapFlow 依赖注入；数据库用内存 better-sqlite3 + SCHEMA_SQL，
 * 与 JournalProfileServices.test.ts 同模式。
 */
/** @vitest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import type { ImapFlowConstructor } from '../../engine/mail/MailboxPool.js';
import { MailboxPoolStore } from '../../electron/ModelDiscoveryStore.js';
import { SubmissionCorrespondenceRepository } from '../../electron/SubmissionCorrespondenceRepository.js';
import { SubmissionMailService } from '../../electron/SubmissionMailService.js';
import { SubmissionRepository } from '../../electron/SubmissionRepository.js';
import { SubmissionReviewRepository } from '../../electron/SubmissionReviewRepository.js';
import { SubmissionReviewService } from '../../electron/SubmissionReviewService.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';

// ─── Fake IMAP 客户端 ────────────────────────────────────────

interface FakeMail {
  uid: number;
  from: string;
  subject: string;
  date: number;
  raw: string;
}

/** 与 ImapFlowConstructor 同形状的 fake：messageList 发信封，download 发 RFC822 原文。 */
class FakeImapFlow {
  static mails: FakeMail[] = [];
  static instances = 0;
  readonly mailboxLock = null;
  constructor(public readonly options: Record<string, unknown>) { FakeImapFlow.instances += 1; }
  async connect(): Promise<void> { /* fake */ }
  async logout(): Promise<void> { /* fake */ }
  async *messageList(): AsyncGenerator<{ uid: number; from: { value: Array<{ address: string }> }; to: { value: Array<{ address: string }> }; subject: string; date: Date }> {
    for (const mail of FakeImapFlow.mails) {
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
    const mail = FakeImapFlow.mails.find((item) => item.uid === uid);
    return mail ? { content: { text: () => mail.raw } } : false;
  }
  close(): void { /* fake */ }
}

const FAKE_CTOR = FakeImapFlow as unknown as ImapFlowConstructor;

/** 拼一封 7bit 纯文本 RFC822 原文（decodeMimeText 原样放行正文）。 */
function rawPlain(headers: Record<string, string>, body: string): string {
  return [...Object.entries(headers).map(([key, value]) => `${key}: ${value}`), '', body].join('\r\n');
}

// ─── 夹具 ────────────────────────────────────────────────────

/** 决定信原文：含 decision 字样 + major revision，用于验证分类优先级与建轮次。 */
const DECISION_BODY = [
  'Dear Dr. Liu,',
  '',
  'Decision: Major revision',
  '',
  'Reviewer 1: The introduction needs clarification on the baseline setup.',
  'Reviewer 2: Please add comparisons with recent graph methods.',
].join('\n');

const DECISION_MAIL: FakeMail = {
  uid: 1,
  from: 'editorial@journaloftesting.org',
  subject: 'Decision on manuscript JOT-2026-0142',
  date: 1_760_000_000_000,
  raw: rawPlain({ 'Message-ID': '<decision-1@journaloftesting.org>', 'References': '<submit-1@journaloftesting.org>' }, DECISION_BODY),
};

const NEWSLETTER_MAIL: FakeMail = {
  uid: 2,
  from: 'newsletter@random-publisher.com',
  subject: 'Weekly digest: new articles you may like',
  date: 1_760_000_100_000,
  raw: rawPlain({ 'Message-ID': '<news-2@random-publisher.com>' }, 'This week in publishing: read our latest blog posts.'),
};

// ─── DB / 服务装配 ───────────────────────────────────────────

let db: Database.Database;
let dataDir: string;
let mailboxStore: MailboxPoolStore;
let correspondenceRepository: SubmissionCorrespondenceRepository;
let submissionRepository: SubmissionRepository;
let reviewService: SubmissionReviewService;
let service: SubmissionMailService;

function seedCase(id: string, overrides: { journal: string; remoteId: string; title: string; status: string }): void {
  db.prepare(`INSERT INTO submission_cases (id,series_id,project_id,title,status,target_journal_name,remote_submission_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,1,1)`)
    .run(id, 'series-1', 'p1', overrides.title, overrides.status, overrides.journal, overrides.remoteId);
}

beforeEach(() => {
  FakeImapFlow.mails = [];
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects (id,title,created_at,updated_at) VALUES ('p1','项目一',1,1)").run();
  db.prepare("INSERT INTO submission_series (id,project_id,source_outcome_id,title,notes,created_at,updated_at) VALUES ('series-1','p1',NULL,'链一','',1,1)").run();
  // case-a：活跃（UNDER_REVIEW），编号 JOT-2026-0142，刊 Journal of Testing。
  seedCase('case-a', { journal: 'Journal of Testing', remoteId: 'JOT-2026-0142', title: 'Graph neural networks for citation prediction', status: 'UNDER_REVIEW' });
  // case-b：活跃（SUBMITTED），刊 Nature（域名 nature.com 可命中），编号 NC-7788。
  seedCase('case-b', { journal: 'Nature', remoteId: 'NC-7788', title: 'Quantum error correction codes', status: 'SUBMITTED' });
  // case-c：终态（REJECTED），编号 OLD-0001，刊名同 case-a——用于验证终态不参与匹配。
  seedCase('case-c', { journal: 'Journal of Testing', remoteId: 'OLD-0001', title: 'Graph neural networks survey', status: 'REJECTED' });

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-mail-'));
  mailboxStore = new MailboxPoolStore(dataDir);
  mailboxStore.add({
    id: 'mb-1', label: '测试邮箱', host: 'imap.qq.com', port: 993,
    user: 'me@qq.com', encryptedSecret: 'encrypted-secret',
    createdAt: 1, lastCheckedAt: null, lastOkAt: null,
  });

  correspondenceRepository = new SubmissionCorrespondenceRepository(db);
  submissionRepository = new SubmissionRepository(db);
  reviewService = new SubmissionReviewService({
    submissionRepository,
    reviewRepository: new SubmissionReviewRepository(db),
    outcomeRepository: new OutcomeRepository(db),
  });
  service = new SubmissionMailService({
    mailboxStore,
    decryptSecret: (encrypted) => (encrypted === 'encrypted-secret' ? 'plain-secret' : null),
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

// ─── classifyMail ────────────────────────────────────────────

describe('SubmissionMailService.classifyMail', () => {
  it('submission confirmation / manuscript received → submission_confirmation', () => {
    expect(service.classifyMail({ from: 'a@b.com', subject: 'Submission confirmation', bodyText: 'Thank you for your submission.' })).toBe('submission_confirmation');
    expect(service.classifyMail({ from: 'a@b.com', subject: 'Manuscript received', bodyText: '您的稿件已收到，投稿成功。' })).toBe('submission_confirmation');
  });

  it('major/minor revision → revision_request，且压过同时出现的 decision 字样', () => {
    const result = service.classifyMail({ from: 'a@b.com', subject: 'Decision on manuscript JOT-2026-0142', bodyText: DECISION_BODY });
    expect(result).toBe('revision_request');
    expect(service.classifyMail({ from: 'a@b.com', subject: '审稿意见与退修通知', bodyText: '请修改后重新提交。' })).toBe('revision_request');
  });

  it('decision 字样但无 accept/reject/revision → decision_letter', () => {
    expect(service.classifyMail({ from: 'a@b.com', subject: 'Decision letter regarding your manuscript', bodyText: 'A decision has been made.' })).toBe('decision_letter');
  });

  it('accepted for publication → acceptance', () => {
    expect(service.classifyMail({ from: 'a@b.com', subject: 'Good news', bodyText: 'We are pleased to inform you that your manuscript has been accepted for publication.' })).toBe('acceptance');
    expect(service.classifyMail({ from: 'a@b.com', subject: '录用通知', bodyText: '您的论文已被录用。' })).toBe('acceptance');
  });

  it('cannot accept / reject → rejection（不会被 accept 字样误判为录用）', () => {
    expect(service.classifyMail({ from: 'a@b.com', subject: 'Decision on your manuscript', bodyText: 'We regret that we cannot accept your manuscript for publication.' })).toBe('rejection');
    expect(service.classifyMail({ from: 'a@b.com', subject: '不宜刊用通知', bodyText: '经评审，不予录用。' })).toBe('rejection');
  });

  it('proof / production → proof / production_query', () => {
    expect(service.classifyMail({ from: 'a@b.com', subject: 'Galley proofs are ready', bodyText: 'Please check your proofs.' })).toBe('proof');
    expect(service.classifyMail({ from: 'a@b.com', subject: '校样确认', bodyText: '请核对清样。' })).toBe('proof');
    expect(service.classifyMail({ from: 'a@b.com', subject: 'Copyright transfer form', bodyText: 'Please sign the copyright form.' })).toBe('production_query');
  });

  it('with the editor / under review → editor_assigned / under_review', () => {
    expect(service.classifyMail({ from: 'a@b.com', subject: 'Status update', bodyText: 'Your manuscript is with the editor.' })).toBe('editor_assigned');
    expect(service.classifyMail({ from: 'a@b.com', subject: 'Status update', bodyText: 'Your manuscript is now under review.' })).toBe('under_review');
    expect(service.classifyMail({ from: 'a@b.com', subject: '送审通知', bodyText: '稿件已送审，外审中。' })).toBe('under_review');
  });

  it('无任何关键词命中 → other（宁可 other 不乱分）', () => {
    expect(service.classifyMail({ from: 'a@b.com', subject: 'Weekly newsletter', bodyText: 'Random industry news.' })).toBe('other');
  });
});

// ─── suggestCase ─────────────────────────────────────────────

describe('SubmissionMailService.suggestCase', () => {
  it('强命中：主题含 remoteSubmissionId', () => {
    const suggestion = service.suggestCase('p1', { from: 'x@y.com', subject: 'Decision on manuscript JOT-2026-0142', bodyText: '' });
    expect(suggestion).not.toBeNull();
    expect(suggestion!.caseId).toBe('case-a');
    expect(suggestion!.reason).toContain('JOT-2026-0142');
  });

  it('中命中：规范化刊名出现在主题', () => {
    const suggestion = service.suggestCase('p1', { from: 'x@y.com', subject: 'Your submission to Journal of Testing', bodyText: '' });
    expect(suggestion?.caseId).toBe('case-a');
    expect(suggestion?.reason).toContain('目标期刊');
  });

  it('中命中：压缩刊名命中发件域名', () => {
    const suggestion = service.suggestCase('p1', { from: 'noreply@nature.com', subject: 'Your manuscript status update', bodyText: '' });
    expect(suggestion?.caseId).toBe('case-b');
    expect(suggestion?.reason).toContain('nature.com');
  });

  it('弱命中：标题 ≥2 个关键词出现在主题', () => {
    const suggestion = service.suggestCase('p1', { from: 'x@y.com', subject: 'Question about citation prediction with graph data', bodyText: '' });
    expect(suggestion?.caseId).toBe('case-a');
    expect(suggestion?.reason).toContain('标题');
  });

  it('歧义并列：两个活跃 Case 同刊名，刊名命中并列 → null 不猜', () => {
    seedCase('case-d', { journal: 'Journal of Testing', remoteId: '', title: 'Completely different topic on spectroscopy', status: 'SUBMITTED' });
    const suggestion = service.suggestCase('p1', { from: 'x@y.com', subject: 'Your submission to Journal of Testing', bodyText: '' });
    expect(suggestion).toBeNull();
  });

  it('终态 Case 不参与：编号只属于 REJECTED 的 case-c → null', () => {
    const suggestion = service.suggestCase('p1', { from: 'x@y.com', subject: 'Regarding OLD-0001', bodyText: '' });
    expect(suggestion).toBeNull();
  });

  it('无命中 → null', () => {
    expect(service.suggestCase('p1', { from: 'x@y.com', subject: 'Lunch tomorrow?', bodyText: 'see you' })).toBeNull();
  });
});

// ─── syncAccount ─────────────────────────────────────────────

describe('SubmissionMailService.syncAccount', () => {
  it('拉信落库：命中邮件挂 pending（带建议 caseId），未命中挂 pending（无 caseId）', async () => {
    FakeImapFlow.mails = [DECISION_MAIL, NEWSLETTER_MAIL];
    const result = await service.syncAccount({ projectId: 'p1', accountId: 'mb-1' });
    expect(result).toMatchObject({ ok: true, fetched: 2, recorded: 2, duplicates: 0, pending: 2 });

    const pending = correspondenceRepository.listPending('p1');
    expect(pending).toHaveLength(2);
    const decision = pending.find((item) => item.messageId === 'decision-1@journaloftesting.org')!;
    expect(decision.classification).toBe('revision_request');
    expect(decision.caseId).toBe('case-a');
    expect(decision.matchStatus).toBe('pending'); // 建议不自动转 matched
    expect(decision.matchReason).toContain('JOT-2026-0142');
    expect(decision.threadId).toBe('submit-1@journaloftesting.org');
    const newsletter = pending.find((item) => item.messageId === 'news-2@random-publisher.com')!;
    expect(newsletter.classification).toBe('other');
    expect(newsletter.caseId).toBeNull();
    expect(newsletter.matchReason).toContain('待人工确认');
  });

  it('二次同步去重：同账户同 Message-ID 不重复落库', async () => {
    FakeImapFlow.mails = [DECISION_MAIL, NEWSLETTER_MAIL];
    await service.syncAccount({ projectId: 'p1', accountId: 'mb-1' });
    const second = await service.syncAccount({ projectId: 'p1', accountId: 'mb-1' });
    expect(second).toMatchObject({ ok: true, fetched: 2, recorded: 0, duplicates: 2 });
    expect(correspondenceRepository.listPending('p1')).toHaveLength(2);
  });

  it('decrypt 失败返回结构化错误且不拉信', async () => {
    const failing = new SubmissionMailService({
      mailboxStore,
      decryptSecret: () => null,
      correspondenceRepository,
      submissionRepository,
      reviewService,
      imapClientCtor: FAKE_CTOR,
    });
    const before = FakeImapFlow.instances;
    expect(await failing.syncAccount({ projectId: 'p1', accountId: 'mb-1' }))
      .toMatchObject({ ok: false, code: 'mailbox_secret_unavailable' });
    expect(FakeImapFlow.instances).toBe(before); // 未建立 IMAP 连接
  });

  it('账户不存在返回 mailbox_account_not_found', async () => {
    expect(await service.syncAccount({ projectId: 'p1', accountId: 'mb-missing' }))
      .toMatchObject({ ok: false, code: 'mailbox_account_not_found' });
  });
});

// ─── confirmMatch / rejectMatch ──────────────────────────────

async function syncDecisionMail(): Promise<string> {
  FakeImapFlow.mails = [DECISION_MAIL];
  const result = await service.syncAccount({ projectId: 'p1', accountId: 'mb-1' });
  expect(result.ok).toBe(true);
  return correspondenceRepository.listPending('p1')[0]!.id;
}

describe('SubmissionMailService.confirmMatch / rejectMatch', () => {
  it('确认关联：转 matched 且决定信类追加 correspondence_matched 事件（source email）', async () => {
    const id = await syncDecisionMail();
    const confirmed = service.confirmMatch({ projectId: 'p1', id });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.record.matchStatus).toBe('matched');
    expect(confirmed.record.caseId).toBe('case-a');
    const events = submissionRepository.listEvents('p1', 'case-a');
    const matched = events.find((event) => event.type === 'correspondence_matched');
    expect(matched?.source).toBe('email');
    expect(matched?.sourceId).toBe(id);
    // 事件只记录事实：Case 状态未被自动推进。
    expect(submissionRepository.getCase('p1', 'case-a')!.status).toBe('UNDER_REVIEW');
  });

  it('否认关联：matchStatus=rejected 且解除 caseId，不追加事件', async () => {
    const id = await syncDecisionMail();
    const rejected = service.rejectMatch({ projectId: 'p1', id });
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.record.matchStatus).toBe('rejected');
    expect(rejected.record.caseId).toBeNull();
    expect(submissionRepository.listEvents('p1', 'case-a').some((event) => event.type === 'correspondence_matched')).toBe(false);
  });

  it('记录不存在返回结构化失败', () => {
    expect(service.confirmMatch({ projectId: 'p1', id: 'scr-missing' })).toMatchObject({ ok: false, code: 'correspondence_not_found' });
    expect(service.rejectMatch({ projectId: 'p1', id: 'scr-missing' })).toMatchObject({ ok: false, code: 'correspondence_not_found' });
  });
});

// ─── createRoundFromCorrespondence ───────────────────────────

describe('SubmissionMailService.createRoundFromCorrespondence', () => {
  it('确认后可建审稿轮次：正文作 decisionLetterText，receivedAt 用邮件时间', async () => {
    const id = await syncDecisionMail();
    service.confirmMatch({ projectId: 'p1', id });
    const created = service.createRoundFromCorrespondence({ projectId: 'p1', id });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const rounds = reviewService.listRounds('p1', 'case-a');
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.id).toBe(created.roundId);
    expect(rounds[0]!.receivedAt).toBe(DECISION_MAIL.date);
    expect(rounds[0]!.decisionLetterText).toContain('Major revision');
    expect(rounds[0]!.decision).toBe('major_revision');
    // 两位审稿人的意见被确定性切分出来。
    expect(rounds[0]!.comments.some((comment) => comment.reviewerLabel.includes('Reviewer 1'))).toBe(true);
    expect(rounds[0]!.comments.some((comment) => comment.reviewerLabel.includes('Reviewer 2'))).toBe(true);
  });

  it('未确认关联时建轮次被拒（match_not_confirmed）', async () => {
    const id = await syncDecisionMail();
    expect(service.createRoundFromCorrespondence({ projectId: 'p1', id }))
      .toMatchObject({ ok: false, code: 'match_not_confirmed' });
    expect(reviewService.listRounds('p1', 'case-a')).toHaveLength(0);
  });

  it('非决定信分类即使已确认也不建轮次（classification_not_decision）', async () => {
    FakeImapFlow.mails = [NEWSLETTER_MAIL];
    await service.syncAccount({ projectId: 'p1', accountId: 'mb-1' });
    const id = correspondenceRepository.listPending('p1')[0]!.id;
    service.confirmMatch({ projectId: 'p1', id, caseId: 'case-b' }); // 人工改绑到 case-b
    expect(service.createRoundFromCorrespondence({ projectId: 'p1', id }))
      .toMatchObject({ ok: false, code: 'classification_not_decision' });
  });

  it('reviewService 未注入返回 review_service_unavailable', async () => {
    const noReview = new SubmissionMailService({
      mailboxStore,
      decryptSecret: () => 'plain-secret',
      correspondenceRepository,
      submissionRepository,
      imapClientCtor: FAKE_CTOR,
    });
    const id = await syncDecisionMail();
    expect(noReview.createRoundFromCorrespondence({ projectId: 'p1', id }))
      .toMatchObject({ ok: false, code: 'review_service_unavailable' });
  });

  it('记录不存在返回 correspondence_not_found', () => {
    expect(service.createRoundFromCorrespondence({ projectId: 'p1', id: 'scr-missing' }))
      .toMatchObject({ ok: false, code: 'correspondence_not_found' });
  });
});
