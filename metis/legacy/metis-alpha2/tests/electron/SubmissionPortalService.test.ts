/**
 * SubmissionPortalService 测试：浏览器辅助投稿（Submission Portal Operator）。
 *
 * 覆盖：
 *  - detectPortalPlatform：scholarone / editorial_manager / ojs / generic 各分支；
 *  - openPortal：门户 URL 三级解析（显式入参 > Case > 期刊档案）、缺失结构化失败、
 *    登录态启发（false / true / null）、portal_opened 事件落库；
 *  - planFill：系统已知事实带值、高风险项（声明/法律/财务/最终提交）只进计划且
 *    value 恒空、绝不含作者事实；
 *  - executeAutoSteps：混入 attestation/legal/final_submit 整体拒绝、review 未确认
 *    被拒、确认后按选择器执行并落事件；
 *  - confirmSubmitted：非法状态失败、SUBMITTING/UNCERTAIN 推进 SUBMITTED 且回写
 *    remoteSubmissionId、落 submission_receipt（source 'human'）；
 *  - markUncertain：SUBMITTING → SUBMISSION_STATE_UNCERTAIN，其余状态拒绝。
 *
 * BrowserService 用结构化 fake（记录 navigate/evaluateInView 调用、可控 extract 返回）；
 * 库用内存 better-sqlite3 + SCHEMA_SQL seed，与 JournalProfileServices.test.ts 同模式。
 */
/** @vitest-environment node */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import type { PortalFieldAction } from '../../engine/submission/SubmissionPortalContract.js';
import type { ExtractedPage } from '../../electron/BrowserService.js';
import { JournalProfileRepository } from '../../electron/JournalProfileRepository.js';
import { SubmissionRepository } from '../../electron/SubmissionRepository.js';
import { SubmissionPortalService, detectPortalPlatform } from '../../electron/SubmissionPortalService.js';

// ─── Fake BrowserService ─────────────────────────────────────

class FakeBrowserService {
  readonly navigated: string[] = [];
  readonly evaluated: string[] = [];
  navigateResult: { ok: boolean; url?: string; error?: string } = { ok: true };
  extractResult: { ok: boolean; page?: ExtractedPage; error?: string } = {
    ok: true,
    page: { title: '', text: '', url: '', links: [] },
  };
  evaluateResult: { ok: boolean; value?: unknown; error?: string } = { ok: true, value: { ok: true } };

  async navigate(url: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    this.navigated.push(url);
    if (!this.navigateResult.ok) return this.navigateResult;
    return { ok: true, url };
  }
  async extract(): Promise<{ ok: boolean; page?: ExtractedPage; error?: string }> {
    return this.extractResult;
  }
  async evaluateInView<T>(fn: string): Promise<{ ok: boolean; value?: T; error?: string }> {
    this.evaluated.push(fn);
    return this.evaluateResult as { ok: boolean; value?: T; error?: string };
  }
  enumerateFieldsResult: { ok: boolean; fields?: Array<{ key: string; label: string; kind: string; required: boolean; currentValue: string; selectorHint: string }>; error?: string } | null = null;
  async enumerateFormFields(): Promise<{ ok: boolean; fields?: Array<{ key: string; label: string; kind: string; required: boolean; currentValue: string; selectorHint: string }>; error?: string }> {
    return this.enumerateFieldsResult ?? { ok: false, error: 'not_supported' };
  }
}

function pageOf(partial: Partial<ExtractedPage>): ExtractedPage {
  return { title: '', text: '', url: '', links: [], ...partial };
}

// ─── DB seed ─────────────────────────────────────────────────

let db: Database.Database;
let submissionRepository: SubmissionRepository;
let journalProfileRepository: JournalProfileRepository;
let browser: FakeBrowserService;
let service: SubmissionPortalService;

function seedCase(id: string, status: string, extra: { portalUrl?: string; journalId?: string } = {}): void {
  db.prepare(
    `INSERT INTO submission_cases (id,series_id,project_id,title,status,submission_portal_url,target_journal_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,1,1)`,
  ).run(id, 'series-1', 'p1', `稿件-${id}`, status, extra.portalUrl ?? '', extra.journalId ?? null);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects (id,title,created_at,updated_at) VALUES ('p1','项目一',1,1)").run();
  db.prepare("INSERT INTO submission_series (id,project_id,source_outcome_id,title,notes,created_at,updated_at) VALUES ('series-1','p1',NULL,'链一','',1,1)").run();
  seedCase('case-profiling', 'PROFILING'); // 无门户 URL
  seedCase('case-submitting', 'SUBMITTING', { portalUrl: 'https://journal.example.com/portal' });
  seedCase('case-uncertain', 'SUBMISSION_STATE_UNCERTAIN');
  seedCase('case-draft', 'DRAFT');
  submissionRepository = new SubmissionRepository(db);
  journalProfileRepository = new JournalProfileRepository(db);
  browser = new FakeBrowserService();
  service = new SubmissionPortalService({
    browserService: browser,
    submissionRepository,
    journalProfileRepository,
  });
});

afterEach(() => {
  db.close();
});

// ─── detectPortalPlatform ────────────────────────────────────

describe('detectPortalPlatform', () => {
  it('scholarone：manuscriptcentral 域名 / mc 前缀域名 / 页面文本特征', () => {
    expect(detectPortalPlatform('https://mc04.manuscriptcentral.com/jtest')).toBe('scholarone');
    expect(detectPortalPlatform('https://journal.scholarone.com/submit')).toBe('scholarone');
    expect(detectPortalPlatform('https://journal.example.com/x', { text: 'Powered by ScholarOne Manuscripts' })).toBe('scholarone');
  });
  it('editorial_manager：editorialmanager 域名或页面文本', () => {
    expect(detectPortalPlatform('https://www.editorialmanager.com/jtest/')).toBe('editorial_manager');
    expect(detectPortalPlatform('https://journal.example.com/x', { title: 'Editorial Manager' })).toBe('editorial_manager');
  });
  it('ojs：/about/submissions 路径或 Open Journal Systems 署名', () => {
    expect(detectPortalPlatform('https://journal.example.com/about/submissions')).toBe('ojs');
    expect(detectPortalPlatform('https://journal.example.com/x', { text: 'Open Journal Systems' })).toBe('ojs');
  });
  it('不命中任何特征时回落 generic，不误判平台', () => {
    expect(detectPortalPlatform('https://journal.example.com/portal')).toBe('generic');
  });
});

// ─── openPortal ──────────────────────────────────────────────

describe('SubmissionPortalService.openPortal', () => {
  it('门户 URL 三级解析：显式入参 > Case > 期刊档案', async () => {
    // 显式入参优先于 Case 上的 URL。
    const explicit = await service.openPortal({ projectId: 'p1', caseId: 'case-submitting', portalUrl: 'https://explicit.example.com/' });
    expect(explicit.ok).toBe(true);
    expect(browser.navigated.at(-1)).toBe('https://explicit.example.com/');

    // 无显式入参时用 Case 的 submissionPortalUrl。
    const fromCase = await service.openPortal({ projectId: 'p1', caseId: 'case-submitting' });
    expect(fromCase.ok).toBe(true);
    expect(browser.navigated.at(-1)).toBe('https://journal.example.com/portal');

    // Case 无 URL 时回落期刊档案，且 generic 检测可采信档案标注的平台。
    const profile = journalProfileRepository.upsertProfile('p1', {
      canonicalName: 'Portal Journal',
      submissionPortalUrl: 'https://journal.example.com/submit',
      platform: 'scholarone',
    });
    seedCase('case-via-profile', 'PROFILING', { journalId: profile.id });
    const fromProfile = await service.openPortal({ projectId: 'p1', caseId: 'case-via-profile' });
    expect(fromProfile.ok).toBe(true);
    if (!fromProfile.ok) return;
    expect(browser.navigated.at(-1)).toBe('https://journal.example.com/submit');
    expect(fromProfile.session.platform).toBe('scholarone');
  });

  it('三级都没有 URL 时返回 portal_url_missing 且不导航', async () => {
    const result = await service.openPortal({ projectId: 'p1', caseId: 'case-profiling' });
    expect(result).toMatchObject({ ok: false, code: 'portal_url_missing' });
    expect(browser.navigated).toHaveLength(0);
  });

  it('Case 不存在返回 case_not_found', async () => {
    const result = await service.openPortal({ projectId: 'p1', caseId: 'case-missing' });
    expect(result).toMatchObject({ ok: false, code: 'case_not_found' });
  });

  it('登录态启发：登录表单特征 → false；logout/my submissions → true；都没有 → null', async () => {
    browser.extractResult = { ok: true, page: pageOf({ text: 'Sign in to your account. Password required.' }) };
    const loggedOut = await service.openPortal({ projectId: 'p1', caseId: 'case-submitting' });
    expect(loggedOut.ok && loggedOut.session.loggedIn).toBe(false);

    browser.extractResult = { ok: true, page: pageOf({ text: 'Welcome. My submissions | Sign out' }) };
    const loggedIn = await service.openPortal({ projectId: 'p1', caseId: 'case-submitting' });
    expect(loggedIn.ok && loggedIn.session.loggedIn).toBe(true);

    browser.extractResult = { ok: true, page: pageOf({ text: '投稿系统主页，只有期刊新闻与导航。' }) };
    const unknown = await service.openPortal({ projectId: 'p1', caseId: 'case-submitting' });
    expect(unknown.ok && unknown.session.loggedIn).toBe(null);
  });

  it('成功打开后落 portal_opened 事件（source browser）', async () => {
    const result = await service.openPortal({ projectId: 'p1', caseId: 'case-submitting' });
    expect(result.ok).toBe(true);
    const events = submissionRepository.listEvents('p1', 'case-submitting');
    const opened = events.find((event) => event.type === 'portal_opened');
    expect(opened?.source).toBe('browser');
    expect(opened?.metadata.portalUrl).toBe('https://journal.example.com/portal');
  });
});

// ─── planFill ────────────────────────────────────────────────

describe('SubmissionPortalService.planFill', () => {
  it('系统已知事实带值；高风险项只进计划且 value 恒空；绝不含作者事实', async () => {
    browser.extractResult = {
      ok: true,
      page: pageOf({
        title: 'Submission Step 4',
        text: [
          'Author information and affiliation will be collected.',
          'I confirm this manuscript has not been submitted elsewhere.',
          'Please sign the copyright transfer agreement.',
          'An Article Processing Charge (APC) applies upon acceptance.',
          'Submit Manuscript to complete submission.',
        ].join(' '),
      }),
    };
    const result = await service.planFill({ projectId: 'p1', caseId: 'case-submitting' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byKey = new Map(result.actions.map((action) => [action.fieldKey, action]));
    // 系统已知事实：稿件标题 auto 带值。
    expect(byKey.get('manuscript_title')).toMatchObject({ safetyLevel: 'auto', value: '稿件-case-submitting' });
    // 高风险项全部进计划、级别正确、value 恒空。
    expect(byKey.get('hazard_attestation')).toMatchObject({ safetyLevel: 'attestation', value: '' });
    expect(byKey.get('hazard_legal')).toMatchObject({ safetyLevel: 'legal', value: '' });
    expect(byKey.get('hazard_financial')).toMatchObject({ safetyLevel: 'financial', value: '' });
    expect(byKey.get('hazard_final_submit')).toMatchObject({ safetyLevel: 'final_submit', value: '' });
    // 每条动作都必须给出 reason。
    for (const action of result.actions) expect(action.reason.length).toBeGreaterThan(0);
    // 作者事实绝不作为值出现（提醒位也为空值）。
    for (const action of result.actions) {
      expect(action.value).not.toMatch(/张三|李四|affiliation of/i);
      if (action.fieldKey === 'author_facts_reminder') expect(action.value).toBe('');
    }
  });

  it('Case 不存在返回 case_not_found', async () => {
    const result = await service.planFill({ projectId: 'p1', caseId: 'case-missing' });
    expect(result).toMatchObject({ ok: false, code: 'case_not_found' });
  });
});

// ─── executeAutoSteps ────────────────────────────────────────

const AUTO_ACTION: PortalFieldAction = {
  fieldKey: 'manuscript_title', label: '稿件标题', value: '稿件标题内容',
  safetyLevel: 'auto', selector: '#title', reason: '系统已知事实填充',
};
const REVIEW_ACTION: PortalFieldAction = {
  fieldKey: 'article_type', label: '文章类型', value: 'research_article',
  safetyLevel: 'review', selector: '#type', reason: '需用户确认的门户映射',
};

describe('SubmissionPortalService.executeAutoSteps', () => {
  it.each(['attestation', 'legal', 'final_submit', 'external_auth', 'financial'] as const)(
    '混入 %s 级动作时整体拒绝且一步都不执行',
    async (level) => {
      const actions: PortalFieldAction[] = [
        AUTO_ACTION,
        { fieldKey: `hazard_${level}`, label: '高风险', value: '', safetyLevel: level, selector: '', reason: '人类专属' },
      ];
      const result = await service.executeAutoSteps({ projectId: 'p1', caseId: 'case-submitting', actions, confirmed: true });
      expect(result).toMatchObject({ ok: false, code: 'portal_action_forbidden' });
      expect(browser.evaluated).toHaveLength(0);
    },
  );

  it('含 review 级动作但未 confirmed 时拒绝', async () => {
    const result = await service.executeAutoSteps({
      projectId: 'p1', caseId: 'case-submitting', actions: [REVIEW_ACTION],
    });
    expect(result).toMatchObject({ ok: false, code: 'portal_confirmation_required' });
    expect(browser.evaluated).toHaveLength(0);
  });

  it('auto + 已确认 review 按选择器执行，并逐步落 portal_auto_step 事件', async () => {
    const result = await service.executeAutoSteps({
      projectId: 'p1', caseId: 'case-submitting',
      actions: [AUTO_ACTION, REVIEW_ACTION], confirmed: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results.map((item) => item.status)).toEqual(['done', 'done']);
    expect(browser.evaluated).toHaveLength(2);
    // 选择器与值经 JSON 转义进入脚本，不拼裸字符串。
    expect(browser.evaluated[0]).toContain('"#title"');
    expect(browser.evaluated[0]).toContain('"稿件标题内容"');
    const events = submissionRepository.listEvents('p1', 'case-submitting').filter((event) => event.type === 'portal_auto_step');
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.source === 'browser')).toBe(true);
  });

  it('缺选择器的动作跳过执行并如实记录 skipped', async () => {
    const result = await service.executeAutoSteps({
      projectId: 'p1', caseId: 'case-submitting',
      actions: [{ ...AUTO_ACTION, selector: '' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results[0]).toMatchObject({ fieldKey: 'manuscript_title', status: 'skipped' });
    expect(browser.evaluated).toHaveLength(0);
  });
});

// ─── confirmSubmitted ────────────────────────────────────────

describe('SubmissionPortalService.confirmSubmitted', () => {
  it('非法状态（PROFILING/DRAFT）结构化失败，状态与事件不变', () => {
    for (const caseId of ['case-profiling', 'case-draft']) {
      const result = service.confirmSubmitted({ projectId: 'p1', caseId });
      expect(result).toMatchObject({ ok: false, code: 'illegal_status' });
      expect(submissionRepository.getCase('p1', caseId)?.status).not.toBe('SUBMITTED');
    }
  });

  it('SUBMITTING 确认后推进 SUBMITTED、回写 remoteSubmissionId、落回执事件', () => {
    const result = service.confirmSubmitted({
      projectId: 'p1', caseId: 'case-submitting',
      remoteSubmissionId: 'JTEST-2026-0042', receiptNote: '编辑部系统回执编号 JTEST-2026-0042',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.case.status).toBe('SUBMITTED');
    expect(result.case.remoteSubmissionId).toBe('JTEST-2026-0042');
    expect(result.case.submittedAt).not.toBeNull();
    const events = submissionRepository.listEvents('p1', 'case-submitting');
    expect(events.some((event) => event.type === 'submitted' && event.source === 'human')).toBe(true);
    const receipt = events.find((event) => event.type === 'submission_receipt');
    expect(receipt?.source).toBe('human');
    expect(receipt?.metadata.remoteSubmissionId).toBe('JTEST-2026-0042');
  });

  it('SUBMISSION_STATE_UNCERTAIN 确认后同样可推进 SUBMITTED', () => {
    const result = service.confirmSubmitted({ projectId: 'p1', caseId: 'case-uncertain' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.case.status).toBe('SUBMITTED');
  });
});

// ─── markUncertain ───────────────────────────────────────────

describe('SubmissionPortalService.planFill（字段级）', () => {
  it('枚举到表单字段时：标题字段带值带选择器（auto），声明复选框标 attestation 且 needsUser', async () => {
    browser.enumerateFieldsResult = {
      ok: true,
      fields: [
        { key: 'title', label: 'Manuscript Title', kind: 'text', required: true, currentValue: '', selectorHint: '#title' },
        { key: 'agree-orig', label: 'I confirm this manuscript is original', kind: 'checkbox', required: true, currentValue: '', selectorHint: '[name="agree-orig"]' },
        { key: 'cover-upload', label: 'Cover Letter upload', kind: 'file', required: false, currentValue: '', selectorHint: '#coverUpload' },
      ],
    };
    const result = await service.planFill({ projectId: 'p1', caseId: 'case-submitting' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const title = result.actions.find((action) => action.fieldKey === 'field_title');
    expect(title).toMatchObject({ safetyLevel: 'auto', selector: '#title' });
    expect(title?.value).toContain('稿件-case-submitting');
    const attestation = result.actions.find((action) => action.fieldKey === 'field_agree-orig');
    expect(attestation).toMatchObject({ safetyLevel: 'attestation', needsUser: true, value: '' });
    const fileAction = result.actions.find((action) => action.fieldKey === 'field_cover-upload');
    expect(fileAction?.needsUser).toBe(true);
  });

  it('枚举不可用/无字段时退化为文本级计划（原有行为）', async () => {
    browser.extractResult = {
      ok: true,
      page: pageOf({ url: 'https://journal.example.com/portal', text: 'Copyright transfer agreement final submit' }),
    };
    const result = await service.planFill({ projectId: 'p1', caseId: 'case-submitting' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions.some((action) => action.safetyLevel === 'legal')).toBe(true);
    expect(result.actions.some((action) => action.safetyLevel === 'final_submit')).toBe(true);
  });
});

describe('SubmissionPortalService.markUncertain', () => {
  it('SUBMITTING 中断后推进 SUBMISSION_STATE_UNCERTAIN 并落事件', () => {
    const result = service.markUncertain({ projectId: 'p1', caseId: 'case-submitting', reason: '上传中途网络断开，远程状态不明' });
    expect(result).toEqual({ ok: true });
    expect(submissionRepository.getCase('p1', 'case-submitting')?.status).toBe('SUBMISSION_STATE_UNCERTAIN');
    const events = submissionRepository.listEvents('p1', 'case-submitting');
    const changed = events.find((event) => event.type === 'status_changed');
    expect(changed?.description).toContain('网络断开');
    expect(changed?.metadata).toMatchObject({ from: 'SUBMITTING', to: 'SUBMISSION_STATE_UNCERTAIN' });
  });

  it('DRAFT 状态不可标记不确定（防误推进）', () => {
    const result = service.markUncertain({ projectId: 'p1', caseId: 'case-draft', reason: '误操作' });
    expect(result).toMatchObject({ ok: false, code: 'illegal_status' });
    expect(submissionRepository.getCase('p1', 'case-draft')?.status).toBe('DRAFT');
  });
});
