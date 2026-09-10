/**
 * AutoRegisterScheduler 单元测试（2026-08-24）：假件注入，无网络无 IMAP。
 * 覆盖：探活跳过（人机验证/不可达/非 NewAPI）、验证码重试、注册成功全链路、
 * 批量上限 5、注册关闭识别、余额换算。
 */
import { describe, it, expect } from 'vitest';
import {
  AUTO_REGISTER_BATCH_SIZE,
  AutoRegisterScheduler,
  type AutoRegisterMailboxReader,
  type StationOutcome,
  type StationTarget,
  type VerificationCandidate,
} from '../../engine/providers/discovery/AutoRegisterScheduler.js';
import type { NewApiClient } from '../../engine/providers/discovery/NewAPIClient.js';

interface ClientCalls {
  getStatus: number;
  sendEmailCode: number;
  register: Array<{ username: string; password: string; email?: string; verificationCode?: string }>;
  login: number;
  createToken: number;
}

interface FakeConfig {
  status?: Record<string, unknown>;
  registerResults?: Array<{ ok: boolean; error?: string }>;
  tokensBefore?: Array<Record<string, unknown>>;
  tokenKeyResponse?: { ok: boolean; key?: string; error?: string };
  models?: string[];
  selfQuota?: number | null;
  sendCodeOk?: boolean;
  /** 逐模型实证判定表：modelId → verdict；缺省全部 ok。 */
  probeResults?: Record<string, 'ok' | 'quota' | 'limited' | 'error'>;
  /** 定价表；undefined=接口不可用。 */
  pricing?: { ratios: Record<string, number>; prices: Record<string, number>; quotaTypes?: Record<string, number> } | null;
}

function makeClient(config: FakeConfig): { client: NewApiClient; calls: ClientCalls } {
  const calls: ClientCalls = { getStatus: 0, sendEmailCode: 0, register: [], login: 0, createToken: 0 };
  const status = {
    reachable: true,
    compatible: true,
    turnstileCheck: false,
    emailVerification: true,
    passwordLoginEnabled: true,
    systemName: '测试站',
    version: 'v1',
    quotaPerUnit: 500000,
    raw: {},
    ...(config.status ?? {}),
  };
  let registerIndex = 0;
  let tokenListCount = 0;
  const fake = {
    async getStatus() { calls.getStatus += 1; return status; },
    async sendEmailCode() { calls.sendEmailCode += 1; return { ok: config.sendCodeOk !== false }; },
    async register(_base: string, input: { username: string; password: string; email?: string; verificationCode?: string }) {
      calls.register.push(input);
      const result = config.registerResults?.[registerIndex] ?? { ok: true };
      registerIndex += 1;
      return result;
    },
    async login() { calls.login += 1; return { ok: true, cookie: 'session=test' }; },
    async getSelf() { return config.selfQuota === null ? { ok: false } : { ok: true, quota: config.selfQuota ?? 2500000, usedQuota: 0 }; },
    async listTokens() {
      tokenListCount += 1;
      return tokenListCount === 1 ? (config.tokensBefore ?? []) : [{ id: 77, name: 'metis-auto' }];
    },
    async createToken() { calls.createToken += 1; return { ok: true }; },
    async resolveTokenKey() { return config.tokenKeyResponse ?? { ok: true, key: 'sk-rawkey123' }; },
    async listModels() { return { ok: true, models: config.models ?? ['model-a', 'model-b'] }; },
    async probeModel(_base: string, _key: string, modelId: string) {
      return config.probeResults?.[modelId] ?? 'ok';
    },
    async getPricing() {
      return config.pricing === undefined ? null : { quotaTypes: {}, ...config.pricing };
    },
  } as unknown as NewApiClient;
  return { client: fake, calls };
}

function makeReader(codesByPoll: string[][]): { reader: AutoRegisterMailboxReader; polls: number } {
  const poll = 0;
  let polls = 0;
  return {
    get polls() { return polls; },
    reader: {
      async fetchVerificationCandidates(): Promise<VerificationCandidate[]> {
        polls += 1;
        const codes = codesByPoll[Math.min(poll, codesByPoll.length - 1)] ?? [];
        return codes.map((code) => ({ codes: [code], links: [], from: 'noreply@site', subject: '验证码', date: Date.now() }));
      },
    },
  };
}

function makeScheduler(client: NewApiClient, reader: AutoRegisterMailboxReader, onProgress?: (snapshot: unknown) => void): AutoRegisterScheduler {
  return new AutoRegisterScheduler({
    client,
    mailboxReader: reader,
    mailboxUser: 'tester@qq.com',
    sleep: async () => {},
    random: () => 0.5,
    now: () => Date.now(),
    codePollMs: 1,
    onProgress,
  });
}

const TARGET: StationTarget = { baseUrl: 'https://s.example.com/', name: '示例站' };

describe('AutoRegisterScheduler', () => {
  it('full happy path: code → register → login → balance → token → models', async () => {
    const { client, calls } = makeClient({ selfQuota: 2_500_000, models: ['m1', 'm2'] });
    const box = makeReader([['123456']]);
    const scheduler = makeScheduler(client, box.reader);
    const { progress, outcomes } = await scheduler.runBatch([TARGET]);
    expect(progress.running).toBe(false);
    expect(progress.batchDone).toBe(1);
    expect(outcomes[0]!.state.phase).toBe('available');
    expect(outcomes[0]!.apiKey).toBe('sk-rawkey123');
    expect(outcomes[0]!.models).toEqual(['m1', 'm2']);
    expect(outcomes[0]!.state.balanceQuota).toBe(2_500_000);
    expect(outcomes[0]!.state.balanceUsd).toBe(5);
    expect(calls.register).toHaveLength(1);
    expect(calls.register[0]!.password).toBe('Metis123456');
    expect(calls.register[0]!.verificationCode).toBe('123456');
    expect(calls.register[0]!.username!.length).toBeLessThanOrEqual(20);
    expect(calls.createToken).toBe(1);
  });

  it('skips human-verification stations without any register attempt (刘总要求)', async () => {
    const { client, calls } = makeClient({ status: { turnstileCheck: true } });
    const box = makeReader([[]]);
    const scheduler = makeScheduler(client, box.reader);
    const { outcomes } = await scheduler.runBatch([TARGET]);
    expect(outcomes[0]!.state.phase).toBe('skipped');
    expect(calls.sendEmailCode).toBe(0);
    expect(calls.register).toHaveLength(0);
  });

  it('fails fast on unreachable / incompatible stations', async () => {
    const dead = makeClient({ status: { reachable: false, compatible: false } });
    const foreign = makeClient({ status: { compatible: false } });
    const s1 = makeScheduler(dead.client, makeReader([[]]).reader);
    const s2 = makeScheduler(foreign.client, makeReader([[]]).reader);
    const [r1, r2] = await Promise.all([s1.runBatch([TARGET]), s2.runBatch([TARGET])]);
    expect(r1.outcomes[0]!.state.phase).toBe('failed');
    expect(r1.outcomes[0]!.state.message).toContain('不可达');
    expect(r2.outcomes[0]!.state.phase).toBe('failed');
    expect(r2.outcomes[0]!.state.message).toContain('非 New API');
  });

  it('retries wrong codes then succeeds on a later candidate', async () => {
    const { client, calls } = makeClient({
      registerResults: [
        { ok: false, error: '验证码错误' },
        { ok: false, error: '验证码已过期' },
        { ok: true },
      ],
    });
    const box = makeReader([['111111', '222222', '333333']]);
    const scheduler = makeScheduler(client, box.reader);
    const { outcomes } = await scheduler.runBatch([TARGET]);
    expect(outcomes[0]!.state.phase).toBe('available');
    expect(calls.register).toHaveLength(3);
    expect(calls.register.map((r) => r.verificationCode)).toEqual(['111111', '222222', '333333']);
  });

  it('marks registration-closed stations as failed without retry storm', async () => {
    const { client, calls } = makeClient({ registerResults: [{ ok: false, error: '管理员关闭了新用户注册' }] });
    const box = makeReader([['123456']]);
    const scheduler = makeScheduler(client, box.reader);
    const { outcomes } = await scheduler.runBatch([TARGET]);
    expect(outcomes[0]!.state.phase).toBe('failed');
    expect(outcomes[0]!.state.message).toContain('关闭');
    expect(calls.register).toHaveLength(1);
  });

  it('processes at most 5 stations per batch (每批5个)', async () => {
    const outcomes: StationOutcome[] = [];
    const targets: StationTarget[] = Array.from({ length: 7 }, (_, i) => ({ baseUrl: 'https://s' + i + '.example.com', name: '站' + i }));
    const { client } = makeClient({ selfQuota: null, models: [] });
    const scheduler = makeScheduler(client, makeReader([['999999']]).reader);
    const result = await scheduler.runBatch(targets);
    outcomes.push(...result.outcomes);
    expect(AUTO_REGISTER_BATCH_SIZE).toBe(5);
    expect(outcomes).toHaveLength(5);
    expect(result.progress.batchTotal).toBe(5);
  });

  it('emits progress snapshots on every phase change', async () => {
    let emissions = 0;
    let lastRunning = true;
    const { client } = makeClient({});
    const scheduler = makeScheduler(client, makeReader([['123456']]).reader, (snapshot) => {
      emissions += 1;
      lastRunning = (snapshot as { running: boolean }).running;
    });
    await scheduler.runBatch([TARGET]);
    expect(emissions).toBeGreaterThan(3);
    expect(lastRunning).toBe(false);
  });

  it('falls back to login when email already registered (idempotent rescan)', async () => {
    const { client, calls } = makeClient({ registerResults: [{ ok: false, error: '该邮箱已被注册' }] });
    const box = makeReader([['123456']]);
    const scheduler = makeScheduler(client, box.reader);
    const { outcomes } = await scheduler.runBatch([{ baseUrl: 'https://s.example.com', name: '示例站', existingUsername: 'metis_old9' }]);
    expect(outcomes[0]!.state.phase).toBe('available');
    expect(outcomes[0]!.state.username).toBe('metis_old9');
    expect(calls.login).toBe(1);
  });

  it('zero-balance stations filter out paywalled models via per-model probes (米醋实证)', async () => {
    const { client } = makeClient({
      selfQuota: 0,
      models: ['free-1', 'claude-fable-5', 'free-2'],
      probeResults: { 'free-1': 'ok', 'claude-fable-5': 'quota', 'free-2': 'ok' },
    });
    const scheduler = makeScheduler(client, makeReader([['123456']]).reader);
    const { outcomes } = await scheduler.runBatch([TARGET]);
    expect(outcomes[0]!.state.phase).toBe('available');
    expect(outcomes[0]!.models).toEqual(['free-1', 'free-2']);
    expect(outcomes[0]!.blockedCount).toBe(1);
    expect(outcomes[0]!.state.message).toContain('定价表不可用');
    expect(outcomes[0]!.state.message).toContain('免费可用 2 个');
  });

  it('prefers pricing table over probing when available (刘总指正：先读表)', async () => {
    const { client } = makeClient({
      selfQuota: 0,
      models: ['claude-fable-5', 'free-model-x', 'unknown-y'],
      pricing: { ratios: { 'claude-fable-5': 30, 'free-model-x': 0 }, prices: {} },
      probeResults: { 'unknown-y': 'ok' },
    });
    const scheduler = makeScheduler(client, makeReader([['123456']]).reader);
    const { outcomes } = await scheduler.runBatch([TARGET]);
    expect(outcomes[0]!.models).toEqual(['free-model-x', 'unknown-y']);
    expect(outcomes[0]!.blockedCount).toBe(1);
    expect(outcomes[0]!.state.message).toContain('定价表判定 1 免费 / 1 收费');
  });

  it('stations with trial balance keep all models without probing (按余额计费可调用)', async () => {
    const { client } = makeClient({
      selfQuota: 2_500_000,
      models: ['a', 'b', 'c'],
      probeResults: { a: 'quota', b: 'quota', c: 'quota' },
    });
    const scheduler = makeScheduler(client, makeReader([['123456']]).reader);
    const { outcomes } = await scheduler.runBatch([TARGET]);
    expect(outcomes[0]!.models).toEqual(['a', 'b', 'c']);
    expect(outcomes[0]!.blockedCount).toBe(0);
    expect(outcomes[0]!.state.message).toContain('按余额可调用');
  });

  it('no-email-verification stations register without code', async () => {
    const { client, calls } = makeClient({ status: { emailVerification: false } });
    const scheduler = makeScheduler(client, makeReader([[]]).reader);
    const { outcomes } = await scheduler.runBatch([TARGET]);
    expect(outcomes[0]!.state.phase).toBe('available');
    expect(calls.sendEmailCode).toBe(0);
    expect(calls.register[0]!.verificationCode).toBeUndefined();
  });
});
