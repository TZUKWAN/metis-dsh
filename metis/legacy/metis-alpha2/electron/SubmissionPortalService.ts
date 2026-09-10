/**
 * SubmissionPortalService — Browser-assisted Submission（投稿门户操作员）。
 *
 * 职责边界（安全敏感，不可放宽）：
 *  - 只帮用户「打开门户、看懂页面、预填系统已知事实」；
 *  - attestation（事实声明）/ external_auth（验证码）/ financial（支付）/
 *    legal（版权协议）/ final_submit（最终提交）一律人类专属——本服务只把
 *    它们写进计划供预览，结构上没有任何「替用户点提交」的方法；
 *  - 门户页面是不可信外部内容：只作为检测输入（正则启发），绝不作为指令来源；
 *  - 登录态判不了就是 null，不许猜；提交结果以人类 confirmSubmitted 为唯一入口。
 *
 * 失败一律返回结构化 { ok:false, code, message }，不抛裸异常（状态机断言除外，
 * 转移合法性已由调用前状态校验保证）。
 */
import { z } from 'zod';
import type { BrowserService, ExtractedPage } from './BrowserService.js';
import type { SubmissionRepository } from './SubmissionRepository.js';
import type { JournalProfileRepository } from './JournalProfileRepository.js';
import {
  PORTAL_PLATFORMS,
  PortalFieldActionSchema,
  PortalSessionSchema,
  isPortalActionAutomatable,
  type PortalActionSafetyLevel,
  type PortalFieldAction,
  type PortalPlatform,
  type PortalSession,
} from '../engine/submission/SubmissionPortalContract.js';
import type { SubmissionCase } from '../engine/submission/SubmissionRuntimeContract.js';
import { buildFillPlan as buildPortalFillPlan } from '../engine/submission/portalAdapters.js';
import type { PortalFormField } from '../engine/submission/SubmissionPortalContract.js';

/** 服务实际用到的浏览器能力子集（测试可用结构化 fake 注入）。 */
export type PortalBrowser = Pick<BrowserService, 'navigate' | 'extract'> &
  Partial<Pick<BrowserService, 'evaluateInView' | 'enumerateFormFields'>>;

type Failure<Code extends string> = { ok: false; code: Code; message: string };
const fail = <Code extends string>(code: Code, message: string): Failure<Code> => ({ ok: false, code, message });

// ─── 平台检测（纯函数，可解释特征） ────────────────────────────

/**
 * ScholarOne Manuscripts（原 Manuscript Central）：
 * 典型域名为 mc01./mc04.manuscriptcentral.com，或站点/页面直接出现 ScholarOne 字样。
 */
const SCHOLARONE_URL = /scholarone|manuscriptcentral|^https?:\/\/mc\d*\./iu;
const SCHOLARONE_TEXT = /scholarone|manuscript central/iu;
/** Editorial Manager：Aries Systems 统一域名 editorialmanager.com。 */
const EDITORIAL_MANAGER_URL = /editorialmanager/iu;
const EDITORIAL_MANAGER_TEXT = /editorial manager/iu;
/**
 * OJS（Open Journal Systems）：URL 特征取 OJS 标准投稿指南路径 /about/submissions；
 * 页面特征取页脚/标题常见的 “Open Journal Systems” 署名。
 * 不对裸 'ojs' 三个字母做 URL 匹配——误判面太大。
 */
const OJS_URL = /\/about\/submissions/iu;
const OJS_TEXT = /open journal systems/iu;

/**
 * 投稿平台检测：URL 正则优先（域名/路径是强信号），页面文本特征兜底；
 * 都不命中 → generic（宁可以通用策略慢处理，不误判平台）。
 */
export function detectPortalPlatform(url: string, page?: { title?: string; text?: string }): PortalPlatform {
  const haystackText = `${page?.title ?? ''}\n${page?.text ?? ''}`.slice(0, 20_000);
  if (SCHOLARONE_URL.test(url) || SCHOLARONE_TEXT.test(haystackText)) return 'scholarone';
  if (EDITORIAL_MANAGER_URL.test(url) || EDITORIAL_MANAGER_TEXT.test(haystackText)) return 'editorial_manager';
  if (OJS_URL.test(url) || OJS_TEXT.test(haystackText)) return 'ojs';
  return 'generic';
}

// ─── 登录态启发（判不了 = null） ───────────────────────────────

/** 已登录信号优先判定：门户页常同时出现 “Sign out” 与历史表单字样。 */
const LOGGED_IN_HINT = /log[\s-]?out|sign[\s-]?out|my submissions|author (?:centre|center|dashboard)|退出登录/iu;
const LOGGED_OUT_HINT = /sign[\s-]?in|log[\s-]?in|password|密码|登录/iu;

function detectLoggedIn(page: { title?: string; text?: string }): boolean | null {
  const haystack = `${page.title ?? ''}\n${page.text ?? ''}`.slice(0, 20_000);
  if (LOGGED_IN_HINT.test(haystack)) return true;
  if (LOGGED_OUT_HINT.test(haystack)) return false;
  return null;
}

// ─── 高风险表单特征（planFill 只进计划、value 恒空） ───────────

const HAZARD_PATTERNS: Array<{ safetyLevel: PortalActionSafetyLevel; pattern: RegExp; label: string; reason: string }> = [
  {
    safetyLevel: 'attestation',
    pattern: /(?:not|never)\s+(?:been\s+)?(?:submitted|published)\s+elsewhere|exclusiv\w+|originality|conflict of interest|ethics|一稿多投|利益冲突|伦理/iu,
    label: '事实声明（原创性/一稿多投/伦理）',
    reason: '声明类内容只有作者本人有资格确认，系统不代勾、不代写。',
  },
  {
    safetyLevel: 'legal',
    pattern: /copyright|licen[cs]e|transfer agreement|版权|许可协议|转让协议/iu,
    label: '版权 / License 协议',
    reason: '版权与许可协议属法律行为，必须由权利人本人签署。',
  },
  {
    safetyLevel: 'financial',
    pattern: /article processing charge|\bAPC\b|payment|publication fee|invoice|版面费|支付|发票/iu,
    label: 'APC / 支付环节',
    reason: '涉及资金操作，系统不触碰任何支付表单。',
  },
  {
    safetyLevel: 'external_auth',
    pattern: /captcha|verification code|two[- ]factor|2fa|验证码/iu,
    label: 'CAPTCHA / 验证码',
    reason: '验证码设计上就是「证明你是人」，禁止任何自动绕过。',
  },
  {
    safetyLevel: 'final_submit',
    pattern: /final submit|submit (?:your )?manuscript|complete submission|finish submission|提交稿件|完成投稿/iu,
    label: '最终提交按钮',
    reason: '最终提交是不可逆外部副作用，只能由人类在浏览器里亲自点击。',
  },
];

/** 作者事实字段（姓名/单位/基金）——计划里只放提醒位，value 永远为空。 */
const AUTHOR_FACT_HINT = /author(?:s| information)?|affiliation|funding|作者|单位|基金/iu;

/** 选择器级填表脚本：evaluateInView 内执行，返回值结构化可克隆。 */
function buildFillScript(selector: string, value: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'element_not_found' };
    el.focus();
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`;
}

export class SubmissionPortalService {
  constructor(private readonly options: {
    browserService: PortalBrowser;
    submissionRepository: SubmissionRepository;
    journalProfileRepository: JournalProfileRepository;
  }) {}

  /** 平台检测（委托纯函数，便于经服务调用）。 */
  detectPlatform(url: string, page?: { title?: string; text?: string }): PortalPlatform {
    return detectPortalPlatform(url, page);
  }

  /** 投稿 Case 的期刊档案（经 targetJournalId 关联，可能没有）。 */
  private profileFor(submissionCase: SubmissionCase) {
    return submissionCase.targetJournalId
      ? this.options.journalProfileRepository.getProfile(submissionCase.projectId, submissionCase.targetJournalId)
      : undefined;
  }

  /**
   * 打开投稿门户：三级解析入口 URL（显式入参 > case.submissionPortalUrl >
   * 期刊档案 submissionPortalUrl）→ 导航 → 抽取页面 → 平台与登录态检测 →
   * 落 portal_opened 事件。登录态只用可解释启发，判不了返回 null。
   */
  async openPortal(input: { projectId: string; caseId: string; portalUrl?: string }): Promise<
    { ok: true; session: PortalSession } | Failure<'case_not_found' | 'portal_url_missing' | 'browser_navigate_failed' | 'browser_extract_failed'>
  > {
    const submissionCase = this.options.submissionRepository.getCase(input.projectId, input.caseId);
    if (!submissionCase) return fail('case_not_found', `投稿 Case 不存在：${input.caseId}`);

    const profile = this.profileFor(submissionCase);
    const portalUrl = (input.portalUrl ?? '').trim()
      || submissionCase.submissionPortalUrl.trim()
      || (profile?.submissionPortalUrl ?? '').trim();
    if (!portalUrl) return fail('portal_url_missing', '缺少投稿门户 URL：请显式传入、在 Case 或期刊档案中配置。');

    const navigated = await this.options.browserService.navigate(portalUrl);
    if (!navigated.ok) return fail('browser_navigate_failed', `门户导航失败：${navigated.error ?? 'unknown'}`);
    const extracted = await this.options.browserService.extract();
    if (!extracted.ok || !extracted.page) return fail('browser_extract_failed', `页面抽取失败：${extracted.error ?? 'unknown'}`);
    const page = extracted.page;

    // 平台：URL/页面检测优先；generic 兜底时才采信档案里人工标注的平台。
    let platform = detectPortalPlatform(portalUrl, page);
    if (platform === 'generic' && profile && (PORTAL_PLATFORMS as readonly string[]).includes(profile.platform)) {
      platform = profile.platform as PortalPlatform;
    }
    const session: PortalSession = PortalSessionSchema.parse({
      caseId: submissionCase.id,
      portalUrl: navigated.url ?? portalUrl,
      platform,
      loggedIn: detectLoggedIn(page),
      currentUrl: page.url,
      pageTitle: page.title,
      detectedAt: Date.now(),
    });
    this.options.submissionRepository.addEvent(input.projectId, {
      caseId: submissionCase.id,
      type: 'portal_opened',
      source: 'browser',
      actor: 'portal-operator',
      description: `打开投稿门户（${platform}），登录态：${session.loggedIn === null ? '无法判定' : session.loggedIn ? '已登录' : '未登录'}`,
      metadata: { portalUrl: session.portalUrl, platform, loggedIn: session.loggedIn, pageTitle: session.pageTitle },
    });
    return { ok: true, session };
  }

  /**
   * 生成填表计划（供用户预览，不执行任何浏览器写操作）：
   *  - 页面可枚举表单字段时：走 portalAdapters.buildFillPlan 字段级计划
   *    （事实带值 + 选择器；高风险/作者事实/未识别 → needsUser 占位）；
   *  - 枚举不可用（旧浏览器能力/无表单）时：退化为文本级检测——系统已知
   *    事实（稿件标题/文章类型）→ auto/review 提醒位；高风险特征只进计划。
   */
  async planFill(input: { projectId: string; caseId: string }): Promise<
    { ok: true; actions: PortalFieldAction[] } | Failure<'case_not_found' | 'browser_extract_failed'>
  > {
    const submissionCase = this.options.submissionRepository.getCase(input.projectId, input.caseId);
    if (!submissionCase) return fail('case_not_found', `投稿 Case 不存在：${input.caseId}`);
    const extracted = await this.options.browserService.extract();
    if (!extracted.ok || !extracted.page) return fail('browser_extract_failed', `页面抽取失败：${extracted.error ?? 'unknown'}`);
    const page: ExtractedPage = extracted.page;
    const haystack = `${page.title}\n${page.text}`.slice(0, 60_000);
    const platform = detectPortalPlatform(page.url || '', page);

    // 字段级路径（优先）：DOM 枚举成功且页面确有表单字段。
    if (typeof this.options.browserService.enumerateFormFields === 'function') {
      const enumerated = await this.options.browserService.enumerateFormFields();
      const fields = (enumerated.ok && Array.isArray(enumerated.fields) ? enumerated.fields : []) as PortalFormField[];
      if (fields.length > 0) {
        const fieldActions = buildPortalFillPlan(fields, {
          title: submissionCase.title,
          abstract: '',
          keywords: [],
          articleType: submissionCase.articleType ?? '',
          targetJournalName: submissionCase.targetJournalName,
        }, platform);
        return { ok: true, actions: fieldActions };
      }
    }

    // 文本级退化路径。
    const actions: PortalFieldAction[] = [];
    if (submissionCase.title.trim()) {
      actions.push(PortalFieldActionSchema.parse({
        fieldKey: 'manuscript_title',
        label: '稿件标题',
        value: submissionCase.title,
        safetyLevel: 'auto',
        selector: '',
        reason: '系统已知事实（Case 标题），可直接填充；无选择器时退化为用户核对后手填。',
      }));
    }
    if (submissionCase.articleType) {
      actions.push(PortalFieldActionSchema.parse({
        fieldKey: 'article_type',
        label: '文章类型',
        value: submissionCase.articleType,
        safetyLevel: 'review',
        selector: '',
        reason: '文章类型需映射到门户特有选项，须用户确认后再执行。',
      }));
    }
    if (AUTHOR_FACT_HINT.test(haystack)) {
      actions.push(PortalFieldActionSchema.parse({
        fieldKey: 'author_facts_reminder',
        label: '作者信息（姓名/单位/基金）',
        value: '',
        safetyLevel: 'review',
        selector: '',
        reason: '作者事实系统不预填、不编造；请作者本人核对填写。此条目仅作提醒。',
      }));
    }
    // 高风险特征：每类只产出一条计划项，reason 固定，证据片段进 label 之外的元数据由 reason 说明。
    for (const hazard of HAZARD_PATTERNS) {
      hazard.pattern.lastIndex = 0;
      const match = hazard.pattern.exec(haystack);
      if (!match) continue;
      const snippet = haystack.slice(Math.max(0, match.index - 40), match.index + match[0].length + 40).replace(/\s+/gu, ' ').trim().slice(0, 200);
      actions.push(PortalFieldActionSchema.parse({
        fieldKey: `hazard_${hazard.safetyLevel}`,
        label: hazard.label,
        value: '',
        safetyLevel: hazard.safetyLevel,
        selector: '',
        reason: `${hazard.reason}（页面证据片段：${snippet}）`,
      }));
    }
    return { ok: true, actions };
  }

  /**
   * 白名单执行：仅允许 safetyLevel ∈ {auto, review}；review 级要求 confirmed === true。
   * 传入列表混入任何更高级别 → 整体拒绝（portal_action_forbidden），一步都不执行。
   * 每步结果落 portal_auto_step 事件（source 'browser'）。
   */
  async executeAutoSteps(input: { projectId: string; caseId: string; actions: PortalFieldAction[]; confirmed?: boolean }): Promise<
    { ok: true; results: Array<{ fieldKey: string; status: 'done' | 'skipped'; detail: string }> } |
    Failure<'case_not_found' | 'portal_invalid_actions' | 'portal_action_forbidden' | 'portal_confirmation_required'>
  > {
    const parsed = z.array(PortalFieldActionSchema).safeParse(input.actions);
    if (!parsed.success) return fail('portal_invalid_actions', '填表动作不合契约，已拒绝执行。');
    const actions = parsed.data;

    const forbidden = actions.find((action) => !isPortalActionAutomatable(action.safetyLevel));
    if (forbidden) {
      return fail(
        'portal_action_forbidden',
        `动作「${forbidden.fieldKey}」安全级别为 ${forbidden.safetyLevel}，属人类专属操作，整体拒绝执行。`,
      );
    }
    if (actions.some((action) => action.safetyLevel === 'review') && input.confirmed !== true) {
      return fail('portal_confirmation_required', '计划含 review 级动作，须用户显式确认（confirmed=true）后才能执行。');
    }
    const submissionCase = this.options.submissionRepository.getCase(input.projectId, input.caseId);
    if (!submissionCase) return fail('case_not_found', `投稿 Case 不存在：${input.caseId}`);

    const results: Array<{ fieldKey: string; status: 'done' | 'skipped'; detail: string }> = [];
    for (const action of actions) {
      let status: 'done' | 'skipped';
      let detail: string;
      if (!action.value.trim()) {
        status = 'skipped'; detail = 'value 为空（提醒位/人工核对项），不执行写入。';
      } else if (!action.selector.trim()) {
        status = 'skipped'; detail = '缺少 CSS 选择器，坐标级填表不可精确命中，留给用户手动填写。';
      } else if (!this.options.browserService.evaluateInView) {
        status = 'skipped'; detail = '浏览器缺少 evaluateInView 能力，无法按选择器填表。';
      } else {
        const evaluated = await this.options.browserService.evaluateInView<{ ok: boolean; error?: string }>(
          buildFillScript(action.selector, action.value),
        );
        if (evaluated.ok && evaluated.value?.ok) {
          status = 'done'; detail = '已按选择器填充并触发 input/change 事件。';
        } else {
          status = 'skipped'; detail = `填充失败：${evaluated.error ?? evaluated.value?.error ?? 'unknown'}，未写入。`;
        }
      }
      results.push({ fieldKey: action.fieldKey, status, detail });
      this.options.submissionRepository.addEvent(input.projectId, {
        caseId: submissionCase.id,
        type: 'portal_auto_step',
        source: 'browser',
        actor: 'portal-operator',
        description: `自动填表步骤 ${action.fieldKey}：${status}（${detail}）`,
        metadata: { fieldKey: action.fieldKey, safetyLevel: action.safetyLevel, status, detail },
      });
    }
    return { ok: true, results };
  }

  /**
   * 人类在浏览器里亲自点完最终提交后的确认入口（本服务绝不代点提交按钮）：
   * 校验当前状态是 SUBMITTING / SUBMISSION_STATE_UNCERTAIN → 推进 SUBMITTED →
   * 回写 remoteSubmissionId（若提供）→ 落 submission_receipt 事件（source 'human'）。
   */
  confirmSubmitted(input: { projectId: string; caseId: string; remoteSubmissionId?: string; receiptNote?: string }):
    { ok: true; case: SubmissionCase } | Failure<'case_not_found' | 'illegal_status' | 'illegal_transition'> {
    const submissionCase = this.options.submissionRepository.getCase(input.projectId, input.caseId);
    if (!submissionCase) return fail('case_not_found', `投稿 Case 不存在：${input.caseId}`);
    if (submissionCase.status !== 'SUBMITTING' && submissionCase.status !== 'SUBMISSION_STATE_UNCERTAIN') {
      return fail('illegal_status', `当前状态 ${submissionCase.status} 不允许确认提交：仅 SUBMITTING / SUBMISSION_STATE_UNCERTAIN 可确认。`);
    }

    const changed = this.options.submissionRepository.changeStatus(input.projectId, {
      caseId: submissionCase.id,
      to: 'SUBMITTED',
      reason: '用户已在投稿门户亲自完成最终提交并确认',
      source: 'human',
      actor: 'human',
    });
    if (!changed) return fail('illegal_transition', '状态推进失败，请核对 Case 状态。');

    const remoteId = (input.remoteSubmissionId ?? '').trim();
    if (remoteId) {
      this.options.submissionRepository.updateCase(input.projectId, { caseId: submissionCase.id, remoteSubmissionId: remoteId }, 'human');
    }
    this.options.submissionRepository.addEvent(input.projectId, {
      caseId: submissionCase.id,
      type: 'submission_receipt',
      source: 'human',
      actor: 'human',
      description: (input.receiptNote ?? '').trim() || '用户确认投稿系统已受理稿件',
      metadata: { remoteSubmissionId: remoteId || null, receiptNote: (input.receiptNote ?? '').trim() || null },
    });
    return { ok: true, case: this.options.submissionRepository.getCase(input.projectId, input.caseId)! };
  }

  /**
   * 上传/提交中断、远程状态不明时推进 SUBMISSION_STATE_UNCERTAIN：
   * 不确定是否成功就必须先进入不确定态，防止盲目重复提交（一稿多投风险）。
   */
  markUncertain(input: { projectId: string; caseId: string; reason: string }):
    { ok: true } | Failure<'case_not_found' | 'illegal_status' | 'illegal_transition'> {
    const submissionCase = this.options.submissionRepository.getCase(input.projectId, input.caseId);
    if (!submissionCase) return fail('case_not_found', `投稿 Case 不存在：${input.caseId}`);
    // SUBMISSION_STATE_UNCERTAIN → 同态重申允许（幂等）；其余活跃/终态一律拒绝。
    if (submissionCase.status !== 'SUBMITTING' && submissionCase.status !== 'SUBMISSION_STATE_UNCERTAIN') {
      return fail('illegal_status', `当前状态 ${submissionCase.status} 不可标记为提交状态不确定。`);
    }
    const changed = this.options.submissionRepository.changeStatus(input.projectId, {
      caseId: submissionCase.id,
      to: 'SUBMISSION_STATE_UNCERTAIN',
      reason: input.reason.trim() || '上传/提交中断，远程状态不明',
      source: 'system',
      actor: 'portal-operator',
    });
    if (!changed) return fail('illegal_transition', '状态推进失败，请核对 Case 状态。');
    return { ok: true };
  }
}
