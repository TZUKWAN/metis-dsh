/**
 * 自动注册分批调度器（2026-08-24 刘总需求，同日 e2e 实证修正版）。
 *
 * 每批最多处理 5 个站点；逐站执行：探活 → 发送验证码 → IMAP 收码 →
 * 注册 → 登录 → 读体验余额 → 创建令牌 → 取 key → 列免费模型。
 * 所有网络动作之间保持 3~5 秒随机间隔；人机验证站点按刘总要求直接跳过。
 * 全程通过 onProgress 快照上报，UI 可实时展示 绿(可用)/红(失败)/灰(待处理)。
 *
 * 实证修正（米醋API/Nebula/PackyAPI 真实运行中发现）：
 *  - 登录后请求必须带 New-Api-User 头（在 NewApiClient 内处理）；
 *  - 验证码可为字母数字混合（提取在 MailboxPool 内处理）；
 *  - 发码即可能报 "Email already in use"：有既有用户名时直接转登录；
 *  - 腾讯验证码票据缺失等归为人机验证跳过。
 */

import {
  AUTO_REGISTER_PASSWORD,
  generateUsername,
  humanDelayMs,
  NewApiClient,
  type StationStatus,
} from './NewAPIClient.js';

export type StationPhase =
  | 'pending'
  | 'probing'
  | 'sending_code'
  | 'waiting_code'
  | 'registering'
  | 'logging_in'
  | 'creating_token'
  | 'listing_models'
  | 'verifying'
  | 'available'
  | 'failed'
  | 'skipped';

export interface StationRunState {
  baseUrl: string;
  name: string;
  phase: StationPhase;
  message: string;
  balanceQuota: number | null;
  balanceUsd: number | null;
  modelCount: number;
  username: string | null;
  systemName: string;
  updatedAt: number;
}

export interface AutoRegisterProgress {
  running: boolean;
  batchTotal: number;
  batchDone: number;
  startedAt: number | null;
  finishedAt: number | null;
  stations: StationRunState[];
}

export interface VerificationCandidate {
  codes: string[];
  links: string[];
  from: string;
  subject: string;
  date: number;
}

/** 邮箱读码器抽象：由 FreeModelService 用 ImapFlow 实现，测试可注入假件。 */
export interface AutoRegisterMailboxReader {
  fetchVerificationCandidates(mailboxUser: string, sinceMs: number): Promise<VerificationCandidate[]>;
}

export interface StationTarget {
  baseUrl: string;
  name: string;
  existingUsername?: string | null;
}

export interface StationOutcome {
  state: StationRunState;
  apiKey: string | null;
  /** 实际可调用（免费或余额可用）的模型；零余额站点已逐个实证过滤。 */
  models: string[];
  /** 零余额站点上被实证挡下的收费模型数。 */
  blockedCount: number;
  /** 探活遇到限流（429，状态待定）的模型数。 */
  rateLimitedCount: number;
}

export interface SchedulerDeps {
  client: NewApiClient;
  mailboxReader: AutoRegisterMailboxReader;
  mailboxUser: string;
  password?: string;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  onProgress?: (snapshot: AutoRegisterProgress) => void;
  /** 等待验证码的总时长（默认 150 秒）。 */
  codeWaitMs?: number;
  /** 收码轮询间隔（默认 10 秒）。 */
  codePollMs?: number;
}

export const AUTO_REGISTER_BATCH_SIZE = 5;

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/u, '');
}

function emptyState(target: StationTarget, now: number): StationRunState {
  return {
    baseUrl: normalizeBaseUrl(target.baseUrl),
    name: target.name,
    phase: 'pending',
    message: '',
    balanceQuota: null,
    balanceUsd: null,
    modelCount: 0,
    username: target.existingUsername ?? null,
    systemName: '',
    updatedAt: now,
  };
}

const REGISTER_CLOSED_PATTERN = /关闭.{0,6}注册|注册已关闭|注册未开放|not.{0,10}(open|allowed|enabled)|registration.{0,16}disabled/iu;
const CODE_ERROR_PATTERN = /验证码|verification.?code/iu;
const USERNAME_TAKEN_PATTERN = /用户名.{0,8}(存在|已)|已被注册|already.{0,10}exist|username.{0,16}(exist|taken)/iu;
const EMAIL_TAKEN_PATTERN = /邮箱.{0,12}(已|被|存在|占用)|email.{0,24}(taken|exist|registered|in use)/iu;
const CAPTCHA_PATTERN = /票据|captcha|人机验证|图形验证|滑块/iu;

interface SessionInfo { cookie: string; userId?: string }

export class AutoRegisterScheduler {
  readonly #deps: SchedulerDeps & Required<Pick<SchedulerDeps, 'sleep' | 'random' | 'now'>>;

  constructor(deps: SchedulerDeps) {
    this.#deps = {
      ...deps,
      sleep: deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
      random: deps.random ?? Math.random,
      now: deps.now ?? (() => Date.now()),
    };
  }

  async #pace(): Promise<void> {
    await this.#deps.sleep(humanDelayMs(this.#deps.random));
  }

  async runBatch(targets: StationTarget[]): Promise<{ progress: AutoRegisterProgress; outcomes: StationOutcome[] }> {
    const batch = targets.slice(0, AUTO_REGISTER_BATCH_SIZE);
    const states = new Map<string, StationRunState>();
    for (const target of batch) states.set(normalizeBaseUrl(target.baseUrl), emptyState(target, this.#deps.now()));
    const progress: AutoRegisterProgress = {
      running: true,
      batchTotal: batch.length,
      batchDone: 0,
      startedAt: this.#deps.now(),
      finishedAt: null,
      stations: [...states.values()].map((item) => ({ ...item })),
    };
    const emit = (): void => {
      progress.stations = [...states.values()].map((item) => ({ ...item }));
      this.#deps.onProgress?.({ ...progress, stations: progress.stations.map((item) => ({ ...item })) });
    };
    emit();
    const outcomes: StationOutcome[] = [];
    for (const target of batch) {
      const state = states.get(normalizeBaseUrl(target.baseUrl))!;
      outcomes.push(await this.#runStation(target, state, emit));
      progress.batchDone += 1;
      emit();
      if (progress.batchDone < batch.length) await this.#pace();
    }
    progress.running = false;
    progress.finishedAt = this.#deps.now();
    emit();
    return { progress, outcomes };
  }

  async #step(state: StationRunState, emit: () => void, phase: StationPhase, message = ''): Promise<void> {
    state.phase = phase;
    state.message = message;
    state.updatedAt = this.#deps.now();
    emit();
    await this.#pace();
  }

  #finish(state: StationRunState, emit: () => void, phase: 'failed' | 'skipped', message: string, extra?: { apiKey?: string | null; models?: string[]; blockedCount?: number; rateLimitedCount?: number }): StationOutcome {
    state.phase = phase;
    state.message = message.slice(0, 300);
    state.updatedAt = this.#deps.now();
    emit();
    return { state: { ...state }, apiKey: extra?.apiKey ?? null, models: extra?.models ?? [], blockedCount: extra?.blockedCount ?? 0, rateLimitedCount: extra?.rateLimitedCount ?? 0 };
  }

  async #runStation(target: StationTarget, state: StationRunState, emit: () => void): Promise<StationOutcome> {
    const finish = (phase: 'failed' | 'skipped', message: string): StationOutcome => this.#finish(state, emit, phase, message);
    // 1. 探活与站点能力判定。
    await this.#step(state, emit, 'probing');
    let status: StationStatus;
    try {
      status = await this.#deps.client.getStatus(state.baseUrl);
    } catch (error) {
      return finish('failed', '探活异常：' + String(error instanceof Error ? error.message : error));
    }
    if (!status.reachable) return finish('failed', '站点不可达');
    if (!status.compatible) return finish('failed', '非 New API 系站点（缺少特征字段）');
    if (status.turnstileCheck) return finish('skipped', '人机验证站点，按要求跳过');
    state.systemName = status.systemName;
    emit();
    const password = this.#deps.password ?? AUTO_REGISTER_PASSWORD;
    const username = target.existingUsername || generateUsername(this.#deps.mailboxUser.split('@')[0] ?? 'metis', this.#deps.random);
    state.username = username;

    // 2. 注册或转入既有账号登录。
    if (status.emailVerification && this.#deps.mailboxUser) {
      const registered = await this.#registerWithEmailCode(target, state, username, password, emit);
      if (registered.kind !== 'ok') return registered.outcome;
    } else {
      const registered = await this.#registerWithoutEmailCode(target, state, username, password, emit);
      if (registered.kind !== 'ok') return registered.outcome;
    }

    // 3+. 登录及后续（余额/令牌/模型）。
    return this.#afterRegister(state, status, password, emit);
  }

  /** 邮箱验证型注册；返回 ok 或终态 outcome。 */
  async #registerWithEmailCode(
    target: StationTarget,
    state: StationRunState,
    username: string,
    password: string,
    emit: () => void,
  ): Promise<{ kind: 'ok' } | { kind: 'done'; outcome: StationOutcome }> {
    const stationStartedAt = this.#deps.now();
    await this.#step(state, emit, 'sending_code', '发送验证码邮件…');
    let sent: { ok: boolean; error?: string };
    try {
      sent = await this.#deps.client.sendEmailCode(state.baseUrl, this.#deps.mailboxUser);
    } catch (error) {
      return { kind: 'done', outcome: this.#finish(state, emit, 'failed', '发送验证码异常：' + String(error instanceof Error ? error.message : error)) };
    }
    if (!sent.ok) {
      const sendError = sent.error ?? '';
      // 米醋实测：重扫时发码即报 Email already in use——有既有账号直接转登录。
      if (EMAIL_TAKEN_PATTERN.test(sendError) && target.existingUsername) {
        state.username = target.existingUsername;
        state.message = '账号已存在，直接登录';
        emit();
        return { kind: 'ok' };
      }
      // PackyAPI 实测：腾讯验证码票据缺失——人机验证站点按刘总要求跳过。
      if (CAPTCHA_PATTERN.test(sendError)) {
        return { kind: 'done', outcome: this.#finish(state, emit, 'skipped', '人机验证站点（发码需验证码票据），按要求跳过') };
      }
      return { kind: 'done', outcome: this.#finish(state, emit, 'failed', '发送验证码失败：' + sendError) };
    }

    await this.#step(state, emit, 'waiting_code', '等待邮箱验证码…');
    const waitMs = this.#deps.codeWaitMs ?? 150_000;
    const deadline = this.#deps.now() + waitMs;
    const pollMs = this.#deps.codePollMs ?? 10_000;
    const triedCodes = new Set<string>();
    let registerError = '';
    while (this.#deps.now() < deadline) {
      let candidates: VerificationCandidate[];
      try {
        candidates = await this.#deps.mailboxReader.fetchVerificationCandidates(this.#deps.mailboxUser, stationStartedAt);
      } catch (error) {
        registerError = '收件异常：' + String(error instanceof Error ? error.message : error);
        await this.#deps.sleep(pollMs);
        continue;
      }
      const freshCodes = candidates.flatMap((mail) => mail.codes).filter((code) => !triedCodes.has(code)).slice(0, 3);
      if (freshCodes.length === 0) {
        await this.#deps.sleep(pollMs);
        continue;
      }
      for (const code of freshCodes) {
        triedCodes.add(code);
        await this.#step(state, emit, 'registering', '提交注册（验证码 ' + code + '）…');
        let attempt: { ok: boolean; error?: string };
        try {
          attempt = await this.#deps.client.register(state.baseUrl, { username, password, email: this.#deps.mailboxUser, verificationCode: code });
        } catch (error) {
          attempt = { ok: false, error: String(error instanceof Error ? error.message : error) };
        }
        if (attempt.ok) return { kind: 'ok' };
        registerError = attempt.error ?? '';
        if (EMAIL_TAKEN_PATTERN.test(registerError) && target.existingUsername) {
          state.username = target.existingUsername;
          return { kind: 'ok' };
        }
        if (REGISTER_CLOSED_PATTERN.test(registerError)) return { kind: 'done', outcome: this.#finish(state, emit, 'failed', '站点已关闭注册：' + registerError) };
        if (USERNAME_TAKEN_PATTERN.test(registerError) && !CODE_ERROR_PATTERN.test(registerError)) {
          return { kind: 'done', outcome: this.#finish(state, emit, 'failed', '用户名冲突，请重扫：' + registerError) };
        }
        // 验证码类错误 → 尝试下一个候选码或继续等新邮件。
        await this.#pace();
      }
    }
    return { kind: 'done', outcome: this.#finish(state, emit, 'failed', registerError || '等待验证码超时（' + Math.round(waitMs / 1000) + ' 秒）') };
  }

  /** 无邮箱验证型注册。 */
  async #registerWithoutEmailCode(
    target: StationTarget,
    state: StationRunState,
    username: string,
    password: string,
    emit: () => void,
  ): Promise<{ kind: 'ok' } | { kind: 'done'; outcome: StationOutcome }> {
    await this.#step(state, emit, 'registering', '提交注册（无邮箱验证）…');
    let attempt: { ok: boolean; error?: string };
    try {
      attempt = await this.#deps.client.register(state.baseUrl, { username, password });
    } catch (error) {
      return { kind: 'done', outcome: this.#finish(state, emit, 'failed', '注册异常：' + String(error instanceof Error ? error.message : error)) };
    }
    if (attempt.ok) return { kind: 'ok' };
    const error = attempt.error ?? '';
    if (EMAIL_TAKEN_PATTERN.test(error) && target.existingUsername) {
      state.username = target.existingUsername;
      return { kind: 'ok' };
    }
    if (REGISTER_CLOSED_PATTERN.test(error)) return { kind: 'done', outcome: this.#finish(state, emit, 'failed', '站点已关闭注册：' + error) };
    if (CAPTCHA_PATTERN.test(error)) return { kind: 'done', outcome: this.#finish(state, emit, 'skipped', '人机验证站点，按要求跳过') };
    if (USERNAME_TAKEN_PATTERN.test(error) && !target.existingUsername) {
      // 用户名撞车：换一个重试一次。
      const alternative = generateUsername(username, this.#deps.random);
      state.username = alternative;
      emit();
      await this.#pace();
      try {
        const retried = await this.#deps.client.register(state.baseUrl, { username: alternative, password });
        if (retried.ok) return { kind: 'ok' };
        return { kind: 'done', outcome: this.#finish(state, emit, 'failed', '注册失败：' + (retried.error ?? '')) };
      } catch (retryError) {
        return { kind: 'done', outcome: this.#finish(state, emit, 'failed', '注册异常：' + String(retryError instanceof Error ? retryError.message : retryError)) };
      }
    }
    return { kind: 'done', outcome: this.#finish(state, emit, 'failed', '注册失败：' + error) };
  }

  /** 登录 → 余额 → 令牌 → key → 模型列表。 */
  async #afterRegister(
    state: StationRunState,
    status: StationStatus,
    password: string,
    emit: () => void,
  ): Promise<StationOutcome> {
    await this.#step(state, emit, 'logging_in', '登录…');
    let session: { ok: true; cookie: string; userId: string } | { ok: false; error: string; require2fa: boolean };
    try {
      session = await this.#deps.client.login(state.baseUrl, state.username ?? '', password);
    } catch (error) {
      return this.#finish(state, emit, 'failed', '登录异常：' + String(error instanceof Error ? error.message : error));
    }
    if (!session.ok) {
      return this.#finish(state, emit, 'failed', session.require2fa ? '站点登录需要2FA，无法自动化' : '登录失败：' + session.error);
    }
    const auth: SessionInfo = { cookie: session.cookie, userId: session.userId };

    await this.#step(state, emit, 'creating_token', '读取账户余额…');
    let quota: number | null = null;
    try {
      const self = await this.#deps.client.getSelf(state.baseUrl, auth.cookie, auth.userId);
      if (self.ok && typeof self.quota === 'number') quota = self.quota;
    } catch { /* 余额读取失败不阻塞后续流程 */ }
    state.balanceQuota = quota;
    state.balanceUsd = quota === null ? null : Math.round((quota / status.quotaPerUnit) * 10000) / 10000;
    emit();

    let tokens: Awaited<ReturnType<NewApiClient['listTokens']>>;
    try { tokens = await this.#deps.client.listTokens(state.baseUrl, auth.cookie, auth.userId); } catch { tokens = []; }
    let tokenRow = tokens.find((token) => token.status !== 2 && token.status !== 4) ?? tokens[0] ?? null;
    if (!tokenRow) {
      let created: { ok: boolean; error?: string };
      try {
        created = await this.#deps.client.createToken(state.baseUrl, auth.cookie, 'metis-auto', auth.userId);
      } catch (error) {
        return this.#finish(state, emit, 'failed', '创建令牌异常：' + String(error instanceof Error ? error.message : error));
      }
      if (!created.ok) return this.#finish(state, emit, 'failed', '创建令牌失败：' + (created.error ?? ''));
      await this.#pace();
      try { tokens = await this.#deps.client.listTokens(state.baseUrl, auth.cookie, auth.userId); } catch { tokens = []; }
      tokenRow = tokens.sort((a, b) => b.id - a.id)[0] ?? null;
      if (!tokenRow) return this.#finish(state, emit, 'failed', '创建令牌后未能取到令牌列表');
    }
    let resolved: { ok: boolean; key?: string; error?: string };
    try {
      resolved = await this.#deps.client.resolveTokenKey(state.baseUrl, auth.cookie, tokenRow, auth.userId);
    } catch (error) {
      return this.#finish(state, emit, 'failed', '获取密钥异常：' + String(error instanceof Error ? error.message : error));
    }
    if (!resolved.ok || !resolved.key) return this.#finish(state, emit, 'failed', '获取密钥失败：' + (resolved.error ?? ''));

    await this.#step(state, emit, 'listing_models', '获取模型列表…');
    let listed: Awaited<ReturnType<NewApiClient['listModels']>>;
    try {
      listed = await this.#deps.client.listModels(state.baseUrl, resolved.key);
    } catch (error) {
      return this.#finish(state, emit, 'failed', '模型列表异常：' + String(error instanceof Error ? error.message : error), { apiKey: resolved.key });
    }
    if (!listed.ok) return this.#finish(state, emit, 'failed', '获取模型列表失败：' + (listed.error ?? ''), { apiKey: resolved.key });

    // 免费性实证（刘总 2026-08-24 反馈）：/v1/models 列的是站点支持的全部模型，
    // 零余额账号上收费模型实际 403 不可调用，不得混入免费发现列表。
    // 有余额 → 全部可按余额调用；零余额/未知 → 逐个最小请求实证（3~5 秒节奏，上限 20 个）。
    let usableModels = listed.models;
    let blockedCount = 0;
    let rateLimitedCount = 0;
    const hasBalance = quota !== null && quota > 0;
    let judgeNote = '';
    if (!hasBalance && listed.models.length > 0) {
      // 刘总指正：先读定价表（/api/pricing 倍率/价格为 0 = 免费），表缺失的模型才逐个实证。
      let pricing: Awaited<ReturnType<NewApiClient['getPricing']>>;
      try { pricing = await this.#deps.client.getPricing(state.baseUrl, auth); } catch { pricing = null; }
      const passed: string[] = [];
      const unknown: string[] = [];
      if (pricing) {
        for (const modelId of listed.models) {
          const quotaType = pricing.quotaTypes?.[modelId];
          const price = pricing.prices[modelId];
          const ratio = pricing.ratios[modelId];
          if (quotaType === 1 && price !== undefined) {
            // 按次计费：价格为准。
            if (price > 0) blockedCount += 1; else passed.push(modelId);
          } else if (quotaType === 0 && ratio !== undefined) {
            // 按量计费：倍率为准。
            if (ratio > 0) blockedCount += 1; else passed.push(modelId);
          } else if (price !== undefined && ratio !== undefined) {
            if (price > 0 || ratio > 0) blockedCount += 1; else passed.push(modelId);
          } else if (ratio !== undefined) {
            if (ratio > 0) blockedCount += 1; else passed.push(modelId);
          } else if (price !== undefined) {
            if (price > 0) blockedCount += 1; else passed.push(modelId);
          } else {
            unknown.push(modelId);
          }
        }
        judgeNote = '定价表判定 ' + passed.length + ' 免费 / ' + blockedCount + ' 收费';
      } else {
        unknown.push(...listed.models);
        judgeNote = '定价表不可用，逐模型实证';
      }
      if (unknown.length > 0) {
        await this.#step(state, emit, 'verifying', judgeNote + '；实证 ' + unknown.length + ' 个未知项…');
        const capped = unknown.slice(0, 20);
        for (const modelId of capped) {
          let verdict: 'ok' | 'quota' | 'limited' | 'error';
          try {
            verdict = await this.#deps.client.probeModel(state.baseUrl, resolved.key, modelId);
          } catch {
            verdict = 'error';
          }
          if (verdict === 'ok') passed.push(modelId);
          else if (verdict === 'quota') blockedCount += 1;
          else if (verdict === 'limited') { rateLimitedCount += 1; passed.push(modelId); }
          else blockedCount += 1;
          state.message = '实证 ' + modelId + ' → ' + verdict;
          state.updatedAt = this.#deps.now();
          emit();
          await this.#pace();
        }
      }
      usableModels = passed;
    }
    state.modelCount = usableModels.length;
    state.phase = 'available';
    state.message = hasBalance
      ? '注册完成，体验余额 $' + (state.balanceUsd ?? 0) + '，' + listed.models.length + ' 个模型按余额可调用'
      : '注册完成，体验余额 $0：' + judgeNote + '，最终免费可用 ' + usableModels.length + ' 个' + (rateLimitedCount > 0 ? '（' + rateLimitedCount + ' 个限流待定）' : '');
    state.updatedAt = this.#deps.now();
    emit();
    return { state: { ...state }, apiKey: resolved.key, models: usableModels, blockedCount, rateLimitedCount };
  }
}
