/**
 * NewApiClient 单元测试（2026-08-24）：以 QuantumNous/new-api 主源接口为契约。
 * 全部使用假 fetch，不发真实网络请求。
 */
import { describe, it, expect } from 'vitest';
import {
  AUTO_REGISTER_PASSWORD,
  collectSessionCookie,
  generateUsername,
  humanDelayMs,
  NewApiClient,
} from '../../engine/providers/discovery/NewAPIClient.js';

interface RecordedCall { url: string; init?: Record<string, unknown> }

function makeResponse(body: unknown, options?: { status?: number; setCookies?: string[] }): Response {
  const status = options?.status ?? 200;
  const payload = JSON.stringify(body);
  const setCookies = options?.setCookies ?? [];
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(payload) as unknown,
    text: async () => payload,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'set-cookie' ? setCookies.join('\n') : null),
      getSetCookie: () => setCookies,
    },
  } as unknown as Response;
}

function setup(responder: (call: RecordedCall, index: number) => Response): { client: NewApiClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client = new NewApiClient({
    fetchLike: async (url, init) => {
      calls.push({ url: String(url), init });
      return responder(calls[calls.length - 1]!, calls.length - 1);
    },
    sleep: async () => {},
    random: () => 0,
  });
  return { client, calls };
}

describe('humanDelayMs / generateUsername / password contract', () => {
  it('delay stays inside 3~5s band (刘总要求)', () => {
    for (let i = 0; i < 50; i += 1) {
      const ms = humanDelayMs();
      expect(ms).toBeGreaterThanOrEqual(3000);
      expect(ms).toBeLessThanOrEqual(5000);
    }
  });
  it('username ≤20 chars and sanitized', () => {
    expect(generateUsername('very.long.local-part@example').length).toBeLessThanOrEqual(20);
    expect(generateUsername('abc')).toMatch(/^abc_[0-9a-z]{5}$/u);
    expect(generateUsername('中文用户名')).toMatch(/^metis_[0-9a-z]{5}$/u);
  });
  it('password matches site constraint 8~20 chars', () => {
    expect(AUTO_REGISTER_PASSWORD.length).toBeGreaterThanOrEqual(8);
    expect(AUTO_REGISTER_PASSWORD.length).toBeLessThanOrEqual(20);
    expect(AUTO_REGISTER_PASSWORD).toBe('Metis123456');
  });
});

describe('collectSessionCookie', () => {
  it('merges same-name cookies keeping the last value', () => {
    const cookie = collectSessionCookie({ headers: { getSetCookie: () => ['session=a; Path=/', 'session=b; HttpOnly'], get: () => null } } as unknown as Response);
    expect(cookie).toBe('session=b');
  });
});

describe('getStatus compatibility detection', () => {
  it('marks station compatible with feature flags', async () => {
    const { client, calls } = setup(() => makeResponse({
      success: true,
      data: { system_name: '米醋API', version: 'v1.2.3', email_verification: true, turnstile_check: false, quota_per_unit: 500000 },
    }));
    const status = await client.getStatus('https://station.example.com');
    expect(calls[0]!.url).toBe('https://station.example.com/api/status');
    expect(status.reachable).toBe(true);
    expect(status.compatible).toBe(true);
    expect(status.emailVerification).toBe(true);
    expect(status.turnstileCheck).toBe(false);
    expect(status.quotaPerUnit).toBe(500000);
  });
  it('unreachable on network error', async () => {
    const { client } = setup(() => { throw new Error('ECONNREFUSED'); });
    const status = await client.getStatus('https://dead.example.com');
    expect(status.reachable).toBe(false);
    expect(status.compatible).toBe(false);
  });
  it('incompatible when system_name missing', async () => {
    const { client } = setup(() => makeResponse({ success: true, data: { foo: 1 } }));
    const status = await client.getStatus('https://x.example.com');
    expect(status.compatible).toBe(false);
  });
});

describe('register / login flow', () => {
  it('register maps verification_code field per source struct tags', async () => {
    const { client, calls } = setup(() => makeResponse({ success: true, message: '' }));
    const result = await client.register('https://s.example.com', { username: 'u_abc12', password: 'Metis123456', email: 'a@qq.com', verificationCode: '654321' });
    expect(result.ok).toBe(true);
    const body = JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>;
    expect(body.username).toBe('u_abc12');
    expect(body.password).toBe('Metis123456');
    expect(body.email).toBe('a@qq.com');
    expect(body.verification_code).toBe('654321');
  });
  it('register surfaces server error message', async () => {
    const { client } = setup(() => makeResponse({ success: false, message: '管理员关闭了注册' }, { status: 200 }));
    const result = await client.register('https://s.example.com', { username: 'u', password: 'Metis123456' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('关闭');
  });
  it('login returns session cookie', async () => {
    const { client, calls } = setup(() => makeResponse({ success: true, data: { id: 9 } }, { setCookies: ['session=MTcw...; Path=/'] }));
    const result = await client.login('https://s.example.com', 'u_abc12', 'Metis123456');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cookie).toBe('session=MTcw...');
    expect(calls[0]!.url).toBe('https://s.example.com/api/user/login');
  });
  it('login extracts userId from data.id (米醋实证：New-Api-User 头所需)', async () => {
    const { client } = setup(() => makeResponse({ success: true, data: { id: 72336 } }, { setCookies: ['session=x; Path=/'] }));
    const result = await client.login('https://s.example.com', 'u', 'p');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.userId).toBe('72336');
  });
  it('getSelf sends New-Api-User header when userId known', async () => {
    const { client, calls } = setup(() => makeResponse({ success: true, data: { quota: 0, used_quota: 0 } }));
    await client.getSelf('https://s.example.com', 'session=x', '72336');
    expect(calls[0]!.init!.headers).toMatchObject({ cookie: 'session=x', 'New-Api-User': '72336' });
  });
  it('login detects require_2fa', async () => {
    const { client } = setup(() => makeResponse({ success: true, data: { require_2fa: true, flow_token: 'x' } }));
    const result = await client.login('https://s.example.com', 'u', 'p');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.require2fa).toBe(true);
  });
});

describe('token lifecycle', () => {
  it('createToken sends unlimited quota + never-expire body', async () => {
    const { client, calls } = setup(() => makeResponse({ success: true }));
    await client.createToken('https://s.example.com', 'session=x', 'metis-auto');
    const body = JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>;
    expect(body.unlimited_quota).toBe(true);
    expect(body.expired_time).toBe(-1);
    expect(calls[0]!.init!.headers).toMatchObject({ cookie: 'session=x' });
  });
  it('listTokens reads pageInfo.items', async () => {
    const { client } = setup(() => makeResponse({ success: true, data: { items: [{ id: 3, name: 't', unlimited_quota: true, expired_time: -1 }], total: 1 } }));
    const tokens = await client.listTokens('https://s.example.com', 'session=x');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.id).toBe(3);
  });
  it('resolveTokenKey prefers POST :id/key then normalizes sk- prefix', async () => {
    const { client, calls } = setup((call) => {
      if (String(call.url).endsWith('/key')) return makeResponse({ success: true, data: { key: 'abcdef123456' } });
      return makeResponse({ success: true, data: { items: [] } });
    });
    const resolved = await client.resolveTokenKey('https://s.example.com', 'session=x', { id: 3, name: 't' });
    expect(resolved.ok).toBe(true);
    expect(resolved.key).toBe('sk-abcdef123456');
    expect(String(calls[0]!.url)).toContain('/api/token/3/key');
  });
  it('resolveTokenKey falls back to legacy list key', async () => {
    const { client } = setup(() => makeResponse({ success: false }, { status: 404 }));
    const resolved = await client.resolveTokenKey('https://s.example.com', 'session=x', { id: 3, name: 't', key: 'legacy48charkey' });
    expect(resolved.ok).toBe(true);
    expect(resolved.key).toBe('sk-legacy48charkey');
  });
});

describe('getPricing (米醋/Nebula 实证形态)', () => {
  it('parses array-form pricing with quota_type', async () => {
    const { client } = setup(() => makeResponse({
      success: true,
      data: [
        { model_name: 'free-m', quota_type: 0, model_ratio: 0, model_price: 0 },
        { model_name: 'paid-m', quota_type: 0, model_ratio: 37.5, model_price: 0 },
        { model_name: 'percall-m', quota_type: 1, model_ratio: 0, model_price: 0.02 },
      ],
    }));
    const pricing = await client.getPricing('https://s.example.com');
    expect(pricing).not.toBeNull();
    expect(pricing!.ratios['paid-m']).toBe(37.5);
    expect(pricing!.ratios['free-m']).toBe(0);
    expect(pricing!.prices['percall-m']).toBe(0.02);
    expect(pricing!.quotaTypes['percall-m']).toBe(1);
  });
  it('parses legacy map-form pricing', async () => {
    const { client } = setup(() => makeResponse({ success: true, data: { model_ratio: { a: 0, b: 5 }, model_price: {} } }));
    const pricing = await client.getPricing('https://s.example.com');
    expect(pricing!.ratios).toEqual({ a: 0, b: 5 });
  });
  it('returns null when pricing endpoint unusable', async () => {
    const { client } = setup(() => makeResponse({ message: 'nope' }, { status: 401 }));
    expect(await client.getPricing('https://s.example.com')).toBeNull();
  });
  it('sends session headers when auth provided', async () => {
    const { client, calls } = setup(() => makeResponse({ success: true, data: { model_ratio: { a: 0 } } }));
    await client.getPricing('https://s.example.com', { cookie: 'session=x', userId: '7' });
    expect(calls[0]!.init!.headers).toMatchObject({ cookie: 'session=x', 'New-Api-User': '7' });
  });
});

describe('listModels', () => {
  it('extracts data[].id with bearer auth', async () => {
    const { client, calls } = setup(() => makeResponse({ data: [{ id: 'gpt-4o-mini' }, { id: 'deepseek-v3' }] }));
    const listed = await client.listModels('https://s.example.com', 'sk-k');
    expect(listed.ok).toBe(true);
    expect(listed.models).toEqual(['gpt-4o-mini', 'deepseek-v3']);
    expect(calls[0]!.url).toBe('https://s.example.com/v1/models');
    expect(calls[0]!.init!.headers).toMatchObject({ authorization: 'Bearer sk-k' });
  });
});
