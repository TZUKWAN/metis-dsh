/**
 * OmniRouteGateway 单元测试（2026-08-24）：本地网关探测与模型解析。
 * OmniRoute 是自托管项目（非注册站点）——契约：只探测 /v1/models，不做任何账号操作。
 */
import { describe, it, expect } from 'vitest';
import {
  collectAuthCookie,
  OMNIROUTE_DEFAULT_BASE_URL,
  OMNIROUTE_DEFAULT_PASSWORD,
  OMNIROUTE_DEFAULT_PORT,
  omniRouteBaseUrl,
  omniRouteCreateApiKey,
  omniRouteKeyWorks,
  omniRouteLaunchSpec,
  omniRouteLogin,
  omniRouteServerBase,
  parseOmniRouteModels,
  probeOmniRoute,
} from '../../engine/providers/discovery/OmniRouteGateway.js';

function fakeResponse(body: unknown, status = 200, setCookies: string[] = []): Response {
  const payload = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(payload) as unknown,
    text: async () => payload,
    headers: { get: () => null, getSetCookie: () => setCookies },
  } as unknown as Response;
}

describe('parseOmniRouteModels', () => {
  it('parses OpenAI-shaped data[].id', () => {
    expect(parseOmniRouteModels({ data: [{ id: 'oc/gpt-4o-free' }, { id: 'felo/llama' }, { nope: 1 }] })).toEqual(['oc/gpt-4o-free', 'felo/llama']);
  });
  it('tolerates plain string arrays', () => {
    expect(parseOmniRouteModels(['auto', 'auto/fast'])).toEqual(['auto', 'auto/fast']);
  });
  it('returns empty on malformed payloads', () => {
    expect(parseOmniRouteModels(null)).toEqual([]);
    expect(parseOmniRouteModels({})).toEqual([]);
    expect(parseOmniRouteModels({ data: 'nope' })).toEqual([]);
  });
});

describe('probeOmniRoute', () => {
  it('reports running with models when /v1/models responds', async () => {
    const result = await probeOmniRoute(async () => new Response(JSON.stringify({ data: [{ id: 'auto' }] }), { status: 200 }));
    expect(result.running).toBe(true);
    expect(result.models).toEqual(['auto']);
    expect(result.latencyMs).not.toBeNull();
  });
  it('reports not-running on HTTP error', async () => {
    const result = await probeOmniRoute(async () => new Response('nope', { status: 503 }));
    expect(result.running).toBe(false);
    expect(result.error).toContain('503');
  });
  it('reports not-running when nothing listens', async () => {
    const result = await probeOmniRoute(async () => { throw new Error('ECONNREFUSED'); });
    expect(result.running).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });
});

describe('launch spec / base url', () => {
  it('targets npx omniroute@latest and default port 20128', () => {
    const spec = omniRouteLaunchSpec();
    expect(spec.args).toContain('-y');
    expect(spec.args).toContain('omniroute@latest');
    expect(spec.readyUrl).toBe('http://127.0.0.1:' + OMNIROUTE_DEFAULT_PORT + '/v1/models');
    expect(omniRouteBaseUrl()).toBe(OMNIROUTE_DEFAULT_BASE_URL);
  });
  it('supports custom port', () => {
    expect(omniRouteBaseUrl(30000)).toBe('http://127.0.0.1:30000/v1');
  });
});

describe('management API (刘总 2026-08-24 自动配置链路)', () => {
  it('serverBase strips /v1 suffix', () => {
    expect(omniRouteServerBase('http://127.0.0.1:20128/v1')).toBe('http://127.0.0.1:20128');
    expect(omniRouteServerBase('http://127.0.0.1:20128/v1/')).toBe('http://127.0.0.1:20128');
  });
  it('default password is CHANGEME per package .env INITIAL_PASSWORD', () => {
    expect(OMNIROUTE_DEFAULT_PASSWORD).toBe('CHANGEME');
  });
  it('login posts password and captures auth_token cookie', async () => {
    let seen: Record<string, unknown> = {};
    const login = await omniRouteLogin(async (url, init) => {
      seen = { url: String(url), body: JSON.parse(String((init as { body: string }).body)) };
      return fakeResponse({ success: true }, 200, ['auth_token=jwt.here; Path=/; HttpOnly']);
    }, 'http://127.0.0.1:20128/v1', 'CHANGEME');
    expect(login.ok).toBe(true);
    if (login.ok) expect(login.cookie).toBe('auth_token=jwt.here');
    expect(seen.url).toBe('http://127.0.0.1:20128/api/auth/login');
    expect(seen.body).toEqual({ password: 'CHANGEME' });
  });
  it('login reports failure on wrong password', async () => {
    const login = await omniRouteLogin(async () => fakeResponse({ error: 'invalid password' }, 401), 'http://127.0.0.1:20128/v1', 'wrong');
    expect(login.ok).toBe(false);
  });
  it('createApiKey posts name with session cookie and returns key', async () => {
    let seen: Record<string, unknown> = {};
    const created = await omniRouteCreateApiKey(async (url, init) => {
      seen = { url: String(url), init };
      return fakeResponse({ key: 'sk-test-123', id: 'k1' }, 201);
    }, 'http://127.0.0.1:20128/v1', 'auth_token=jwt', 'metis-auto');
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.key).toBe('sk-test-123');
    expect(seen.url).toBe('http://127.0.0.1:20128/api/keys');
    expect((seen.init as { headers: Record<string, string> }).headers.cookie).toBe('auth_token=jwt');
  });
  it('keyWorks validates via /v1/models bearer', async () => {
    const ok = await omniRouteKeyWorks(async () => fakeResponse({ data: [] }, 200), 'http://127.0.0.1:20128/v1', 'sk-x');
    const bad = await omniRouteKeyWorks(async () => fakeResponse({}, 401), 'http://127.0.0.1:20128/v1', 'sk-x');
    expect(ok).toBe(true);
    expect(bad).toBe(false);
  });
  it('collectAuthCookie merges set-cookie pairs', () => {
    const cookie = collectAuthCookie(fakeResponse({}, 200, ['auth_token=a; Path=/', 'other=b; HttpOnly']));
    expect(cookie).toBe('auth_token=a; other=b');
  });
});
