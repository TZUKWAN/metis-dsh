/**
 * OmniRoute 本地网关集成（2026-08-24 刘总需求）。
 *
 * OmniRoute（github.com/diegosouzapw/OmniRoute）不是中转站聚合平台，而是
 * 自托管 AI 网关项目：`npm i -g omniroute` 后在 localhost:20128 暴露
 * OpenAI 兼容 /v1 端点，聚合 290 个 provider（90+ 免费层），零配置即可用
 * （内置 OpenCode Free、Felo 等免 key provider，auto 组合开箱即答）。
 *
 * 因此本模块只做三件事：
 *  1. 探测本地实例是否在运行（GET /v1/models）；
 *  2. 解析模型清单；
 *  3. 给出启动命令规格（实际 spawn 由 electron 主进程执行）。
 * 绝不把 OmniRoute 当作需要注册的站点处理。
 */

export const OMNIROUTE_DEFAULT_PORT = 20128;
export const OMNIROUTE_DEFAULT_BASE_URL = 'http://127.0.0.1:' + OMNIROUTE_DEFAULT_PORT + '/v1';

/** 启动命令规格：主进程用 child_process.spawn 以 shell 执行。 */
export interface OmniRouteLaunchSpec {
  command: string;
  args: string[];
  /** 就绪探测 URL（/v1/models）。 */
  readyUrl: string;
}

export function omniRouteLaunchSpec(port: number = OMNIROUTE_DEFAULT_PORT): OmniRouteLaunchSpec {
  return {
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: ['-y', 'omniroute@latest'],
    readyUrl: 'http://127.0.0.1:' + port + '/v1/models',
  };
}

export function omniRouteBaseUrl(port: number = OMNIROUTE_DEFAULT_PORT): string {
  return 'http://127.0.0.1:' + port + '/v1';
}

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<Response>;

/** 解析 OmniRoute /v1/models 响应（OpenAI 格式 data[].id；容忍字符串数组）。导出仅为测试。 */
export function parseOmniRouteModels(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return payload.filter((item): item is string => typeof item === 'string');
  }
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => (typeof item === 'string' ? item : (item as { id?: unknown } | null)?.id))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export interface OmniRouteProbeResult {
  running: boolean;
  models: string[];
  latencyMs: number | null;
  error?: string;
}

/** 管理 API 基址：/v1 → 去掉 /v1 后缀。 */
export function omniRouteServerBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, '').replace(/\/v1$/u, '');
}

/** 收集会话 cookie（auth_token）。 */
export function collectAuthCookie(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const rawList = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get('set-cookie') ? [headers.get('set-cookie') as string] : []);
  const merged = new Map<string, string>();
  for (const raw of rawList) {
    const first = raw.split(';')[0]?.trim();
    if (!first || !first.includes('=')) continue;
    const eq = first.indexOf('=');
    merged.set(first.slice(0, eq), first.slice(eq + 1));
  }
  return [...merged.entries()].map(([name, value]) => name + '=' + value).join('; ');
}

/**
 * 刘总 2026-08-24 需求：用初始管理密码（默认 CHANGEME，见包内 .env INITIAL_PASSWORD）
 * 登录 OmniRoute 控制台，拿 JWT session cookie。
 */
export async function omniRouteLogin(
  fetchLike: FetchLike,
  baseUrl: string,
  password: string,
): Promise<{ ok: true; cookie: string } | { ok: false; error: string }> {
  try {
    const response = await fetchLike(omniRouteServerBase(baseUrl) + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null) as { success?: boolean } | null;
    if (response.ok && body?.success === true) {
      const cookie = collectAuthCookie(response);
      if (!cookie) return { ok: false, error: 'no_session_cookie' };
      return { ok: true, cookie };
    }
    return { ok: false, error: 'HTTP ' + response.status };
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 200) };
  }
}

/** 用控制台会话创建推理 API key（POST /api/keys {name} → 201 {key}）。 */
export async function omniRouteCreateApiKey(
  fetchLike: FetchLike,
  baseUrl: string,
  cookie: string,
  name: string,
): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  try {
    const response = await fetchLike(omniRouteServerBase(baseUrl) + '/api/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null) as { key?: unknown } | null;
    if ((response.status === 200 || response.status === 201) && body && typeof body.key === 'string' && body.key.length > 0) {
      return { ok: true, key: body.key };
    }
    return { ok: false, error: 'HTTP ' + response.status };
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 200) };
  }
}

/** 验证 key 是否可用（GET /v1/models + Bearer）。 */
export async function omniRouteKeyWorks(fetchLike: FetchLike, baseUrl: string, key: string): Promise<boolean> {
  try {
    const response = await fetchLike(baseUrl.replace(/\/+$/u, '') + '/models', {
      headers: { authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(8000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export const OMNIROUTE_DEFAULT_PASSWORD = 'CHANGEME';

export async function probeOmniRoute(fetchLike: FetchLike, baseUrl: string = OMNIROUTE_DEFAULT_BASE_URL): Promise<OmniRouteProbeResult> {
  const started = Date.now();
  try {
    const response = await fetchLike(baseUrl.replace(/\/+$/u, '') + '/models', {
      signal: AbortSignal.timeout(5000),
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return { running: false, models: [], latencyMs, error: 'HTTP ' + response.status };
    }
    const payload = await response.json();
    return { running: true, models: parseOmniRouteModels(payload), latencyMs };
  } catch (error) {
    return {
      running: false,
      models: [],
      latencyMs: null,
      error: String(error instanceof Error ? error.message : error).slice(0, 200),
    };
  }
}
