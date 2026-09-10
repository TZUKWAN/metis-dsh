/**
 * New API 系中转站自动注册客户端（2026-08-24 刘总需求）。
 *
 * 接口以主源 QuantumNous/new-api 为准（已核对 router/api-router.go、
 * controller/user.go、controller/token.go、model/user.go）：
 *  - GET  /api/status                站点状态（turnstile_check / email_verification 等）
 *  - GET  /api/verification?email=   发送邮箱验证码（TurnstileCheck 中间件）
 *  - POST /api/user/register         注册体：username/password/email/verification_code
 *  - POST /api/user/login            登录（session cookie；可能返回 require_2fa）
 *  - GET  /api/user/self             用户信息（quota 体验余额）
 *  - GET  /api/token/                令牌列表（分页 pageInfo.items，key 被掩码）
 *  - POST /api/token/                创建令牌（unlimited_quota + expired_time=-1）
 *  - POST /api/token/:id/key         取完整 key（新版隐藏 key 后的专用接口）
 *
 * 行为约束（刘总确认）：
 *  - 每个网络动作之间随机等待 3~5 秒模拟人类操作节奏；
 *  - 人机验证站点直接跳过（不做任何绕过）；
 *  - 注册密码统一 Metis123456；用户名 ≤ 20 字符（源码 validate max=20）；
 *  - 对旧版分支（令牌列表直出 key）做兼容回退。
 */

/** 统一注册密码（刘总指定）。 */
export const AUTO_REGISTER_PASSWORD = 'Metis123456';

export function humanDelayMs(random: () => number = Math.random): number {
  return 3000 + Math.floor(random() * 2001);
}

export async function humanDelay(sleep: (ms: number) => Promise<void>, random: () => number = Math.random): Promise<void> {
  await sleep(humanDelayMs(random));
}

/** 由邮箱本地部分生成合法用户名：≤20 字符、字母开头安全字符。 */
export function generateUsername(emailLocalPart: string, random: () => number = Math.random): string {
  const sanitized = emailLocalPart.toLowerCase().replace(/[^a-z0-9_]/gu, '').slice(0, 12);
  const base = sanitized.length >= 3 ? sanitized : 'metis';
  let suffix = '';
  for (let i = 0; i < 5; i += 1) suffix += Math.floor(random() * 36).toString(36);
  return (base + '_' + suffix).slice(0, 20);
}

export interface StationStatus {
  reachable: boolean;
  /** 判定为 New API / one-api 系：/api/status 返回 system_name 等特征字段 */
  compatible: boolean;
  turnstileCheck: boolean;
  emailVerification: boolean;
  passwordLoginEnabled: boolean | null;
  systemName: string;
  version: string;
  quotaPerUnit: number;
  raw: Record<string, unknown>;
}

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<Response>;

const DEFAULT_FETCH: FetchLike = (url, init) => fetch(url, init as never);
const DEFAULT_SLEEP = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/u, '') + path;
}

interface ApiEnvelope {
  success?: boolean;
  message?: string;
  data?: unknown;
}

async function readJson(response: Response): Promise<(ApiEnvelope & Record<string, unknown>) | null> {
  try { return await response.json() as ApiEnvelope & Record<string, unknown>; } catch { return null; }
}

/** 从响应头收集会话 Cookie（new-api 使用 gin-session，名为 session）。 */
export function collectSessionCookie(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const rawList = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get('set-cookie') ? [headers.get('set-cookie') as string] : []);
  const pairs: string[] = [];
  for (const raw of rawList) {
    const first = raw.split(';')[0]?.trim();
    if (first && first.includes('=')) pairs.push(first);
  }
  // 合并同名 cookie：后设置的覆盖先设置的。
  const merged = new Map<string, string>();
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    merged.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return [...merged.entries()].map(([name, value]) => name + '=' + value).join('; ');
}

export interface RegisterInput {
  username: string;
  password: string;
  email?: string;
  verificationCode?: string;
  affCode?: string;
}

export interface TokenRow {
  id: number;
  name: string;
  key?: string;
  status?: number;
  unlimitedQuota?: boolean;
  expiredTime?: number;
}

export class NewApiClient {
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;

  constructor(options?: { fetchLike?: FetchLike; sleep?: (ms: number) => Promise<void>; random?: () => number }) {
    this.#fetch = options?.fetchLike ?? DEFAULT_FETCH;
    this.#sleep = options?.sleep ?? DEFAULT_SLEEP;
    this.#random = options?.random ?? Math.random;
  }

  async #request(url: string, init: Record<string, unknown>, timeoutMs = 20_000): Promise<Response> {
    return await this.#fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }

  async getStatus(baseUrl: string): Promise<StationStatus> {
    let payload: ApiEnvelope & Record<string, unknown> | null;
    try {
      const response = await this.#request(joinUrl(baseUrl, '/api/status'), { method: 'GET' });
      if (!response.ok) return StationStatus_unreachable();
      payload = await readJson(response);
    } catch {
      return StationStatus_unreachable();
    }
    const data = (payload?.data && typeof payload.data === 'object' ? payload.data : payload ?? {}) as Record<string, unknown>;
    const str = (key: string): string => (typeof data[key] === 'string' ? data[key] as string : '');
    const bool = (key: string): boolean => data[key] === true;
    const systemName = str('system_name');
    const version = str('version');
    const compatible = systemName.length > 0 && (
      typeof data.email_verification === 'boolean'
      || typeof data.turnstile_check === 'boolean'
      || typeof data.quota_per_unit === 'number'
      || version.length > 0
    );
    const passwordLoginRaw = data.password_login_enabled;
    return {
      reachable: true,
      compatible,
      turnstileCheck: bool('turnstile_check'),
      emailVerification: bool('email_verification'),
      passwordLoginEnabled: typeof passwordLoginRaw === 'boolean' ? passwordLoginRaw : null,
      systemName,
      version,
      quotaPerUnit: typeof data.quota_per_unit === 'number' && data.quota_per_unit > 0 ? data.quota_per_unit : 500_000,
      raw: data,
    };
  }

  async sendEmailCode(baseUrl: string, email: string): Promise<{ ok: boolean; error?: string }> {
    const url = joinUrl(baseUrl, '/api/verification') + '?email=' + encodeURIComponent(email);
    const response = await this.#request(url, { method: 'GET' });
    const payload = await readJson(response);
    if (response.ok && payload?.success !== false) return { ok: true };
    return { ok: false, error: String(payload?.message ?? 'HTTP ' + response.status).slice(0, 200) };
  }

  async register(baseUrl: string, input: RegisterInput): Promise<{ ok: boolean; error?: string }> {
    const body: Record<string, unknown> = { username: input.username, password: input.password };
    if (input.email) body.email = input.email;
    if (input.verificationCode) body.verification_code = input.verificationCode;
    if (input.affCode) body.aff_code = input.affCode;
    const response = await this.#request(joinUrl(baseUrl, '/api/user/register'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await readJson(response);
    if (response.ok && payload?.success === true) return { ok: true };
    return { ok: false, error: String(payload?.message ?? 'HTTP ' + response.status).slice(0, 200) };
  }

  /**
   * 登录返回 cookie + userId。米醋API 实测（2026-08-24）：new-api 的 UserAuth 中间件
   * 对 /api/user/* 与 /api/token/* 除 session cookie 外还要求 `New-Api-User: <id>` 头，
   * 否则报 "Unauthorized, New-Api-User header not provided"。
   */
  async login(baseUrl: string, username: string, password: string): Promise<{ ok: true; cookie: string; userId: string } | { ok: false; error: string; require2fa: boolean }> {
    const response = await this.#request(joinUrl(baseUrl, '/api/user/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const payload = await readJson(response);
    const data = payload?.data as Record<string, unknown> | undefined;
    if (data && data.require_2fa === true) {
      return { ok: false, error: 'site_requires_2fa', require2fa: true };
    }
    if (response.ok && payload?.success === true) {
      const cookie = collectSessionCookie(response);
      if (!cookie) return { ok: false, error: 'no_session_cookie', require2fa: false };
      const userId = data && data.id !== undefined && data.id !== null ? String(data.id) : '';
      return { ok: true, cookie, userId };
    }
    return { ok: false, error: String(payload?.message ?? 'HTTP ' + response.status).slice(0, 200), require2fa: false };
  }

  /** 会话请求头：cookie + New-Api-User（部分站点强制）。 */
  #authHeaders(cookie: string, userId?: string): Record<string, string> {
    const headers: Record<string, string> = { cookie };
    if (userId) headers['New-Api-User'] = userId;
    return headers;
  }

  async getSelf(baseUrl: string, cookie: string, userId?: string): Promise<{ ok: boolean; quota?: number; usedQuota?: number; error?: string }> {
    const response = await this.#request(joinUrl(baseUrl, '/api/user/self'), {
      method: 'GET',
      headers: this.#authHeaders(cookie, userId),
    });
    const payload = await readJson(response);
    const data = payload?.data as Record<string, unknown> | undefined;
    if (response.ok && payload?.success === true && data && typeof data.quota === 'number') {
      return { ok: true, quota: data.quota, usedQuota: typeof data.used_quota === 'number' ? data.used_quota : 0 };
    }
    return { ok: false, error: String(payload?.message ?? 'HTTP ' + response.status).slice(0, 200) };
  }

  async listTokens(baseUrl: string, cookie: string, userId?: string): Promise<TokenRow[]> {
    const response = await this.#request(joinUrl(baseUrl, '/api/token/') + '?p=1&size=100', {
      method: 'GET',
      headers: this.#authHeaders(cookie, userId),
    });
    const payload = await readJson(response);
    const data = payload?.data as { items?: unknown } | undefined;
    const items = Array.isArray(data?.items) ? data!.items : (Array.isArray(payload?.data) ? payload!.data : []);
    return (items as Array<Record<string, unknown>>)
      .filter((item) => item && typeof item.id === 'number')
      .map((item) => ({
        id: item.id as number,
        name: typeof item.name === 'string' ? item.name : '',
        key: typeof item.key === 'string' && item.key.length > 0 ? item.key : undefined,
        status: typeof item.status === 'number' ? item.status : undefined,
        unlimitedQuota: item.unlimited_quota === true,
        expiredTime: typeof item.expired_time === 'number' ? item.expired_time : undefined,
      }));
  }

  async createToken(baseUrl: string, cookie: string, name: string, userId?: string): Promise<{ ok: boolean; error?: string }> {
    const response = await this.#request(joinUrl(baseUrl, '/api/token/'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.#authHeaders(cookie, userId) },
      body: JSON.stringify({
        name: name.slice(0, 50),
        remain_quota: 500_000,
        expired_time: -1,
        unlimited_quota: true,
        model_limits_enabled: false,
        model_limits: '',
        allow_ips: '',
        group: 'default',
      }),
    });
    const payload = await readJson(response);
    if (response.ok && payload?.success === true) return { ok: true };
    return { ok: false, error: String(payload?.message ?? 'HTTP ' + response.status).slice(0, 200) };
  }

  /** 新版通过 POST /token/:id/key 取完整 key；失败时回退列表内 key 字段（旧版）。 */
  async resolveTokenKey(baseUrl: string, cookie: string, token: TokenRow, userId?: string): Promise<{ ok: boolean; key?: string; error?: string }> {
    try {
      const response = await this.#request(joinUrl(baseUrl, '/api/token/' + token.id + '/key'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.#authHeaders(cookie, userId) },
        body: '{}',
      });
      const payload = await readJson(response);
      const data = payload?.data as Record<string, unknown> | undefined;
      const key = data && typeof data.key === 'string' ? data.key : undefined;
      if (response.ok && payload?.success === true && key) return { ok: true, key: normalizeSk(key) };
    } catch { /* 回退到列表 key */ }
    if (token.key) return { ok: true, key: normalizeSk(token.key) };
    return { ok: false, error: 'token_key_unavailable' };
  }

  async listModels(baseUrl: string, apiKey: string): Promise<{ ok: boolean; models: string[]; error?: string }> {
    const response = await this.#request(joinUrl(baseUrl, '/v1/models'), {
      method: 'GET',
      headers: { authorization: 'Bearer ' + apiKey },
    }, 30_000);
    const payload = await readJson(response);
    const data = payload?.data as Array<Record<string, unknown>> | undefined;
    if (response.ok && Array.isArray(data)) {
      return { ok: true, models: data.filter((m) => typeof m.id === 'string').map((m) => m.id as string) };
    }
    return { ok: false, models: [], error: String(payload?.message ?? 'HTTP ' + response.status).slice(0, 200) };
  }

  /**
   * 站点定价表（刘总 2026-08-24 指正：先读表，别逐个探）。
   * new-api 公开路由 GET /api/pricing：data 内含 model_ratio（倍率，0=免费）、
   * model_price（按次价格，0=免费）。宽容解析 data 平铺/嵌套与字符串数字。
   * 返回 null 表示定价表不可用（调用方回退逐模型实证）。
   */
  /**
   * 站点定价表（刘总 2026-08-24 指正：先读表，别逐个探）。
   * 两种真实形态都已实证：
   *  - 新版（米醋/Nebula 实测）：data 为数组，每项 {model_name, quota_type, model_ratio, model_price}，
   *    quota_type=0 按量（ratio=0 免费）、quota_type=1 按次（price=0 免费）；
   *  - 旧版：data.model_ratio / data.model_price 为 map。
   * 部分站点该接口需登录会话（米醋实测匿名 401），故支持带 auth。
   * 返回 null = 定价表不可用（调用方回退逐模型实证）。
   */
  async getPricing(baseUrl: string, auth?: { cookie?: string; userId?: string; apiKey?: string }): Promise<{ ratios: Record<string, number>; prices: Record<string, number>; quotaTypes: Record<string, number> } | null> {
    try {
      // 米醋实测：部分站点 /api/pricing 需鉴权（匿名 401）；会话或 Bearer key 均可。
      const headers: Record<string, string> = {};
      if (auth?.apiKey) headers.authorization = 'Bearer ' + auth.apiKey;
      else if (auth?.cookie) Object.assign(headers, this.#authHeaders(auth.cookie, auth.userId));
      // 匿名调用（无 auth）时 headers 为空对象。
      const response = await this.#request(joinUrl(baseUrl, '/api/pricing'), { method: 'GET', headers }, 20_000);
      if (!response.ok) return null;
      const payload = await readJson(response);
      const data = (payload?.data ?? payload ?? {}) as unknown;
      const num = (v: unknown): number | undefined => {
        const n = typeof v === 'number' ? v : (typeof v === 'string' ? Number(v) : NaN);
        return Number.isFinite(n) ? n : undefined;
      };
      const ratios: Record<string, number> = {};
      const prices: Record<string, number> = {};
      const quotaTypes: Record<string, number> = {};
      if (Array.isArray(data)) {
        for (const entry of data) {
          if (!entry || typeof entry !== 'object') continue;
          const rec = entry as Record<string, unknown>;
          const name = typeof rec.model_name === 'string' ? rec.model_name : (typeof rec.model === 'string' ? rec.model : '');
          if (!name) continue;
          const ratio = num(rec.model_ratio);
          const price = num(rec.model_price);
          const quotaType = num(rec.quota_type);
          if (ratio !== undefined) ratios[name] = ratio;
          if (price !== undefined) prices[name] = price;
          if (quotaType !== undefined) quotaTypes[name] = quotaType;
        }
      } else if (data && typeof data === 'object') {
        const obj = data as Record<string, unknown>;
        for (const [k, v] of Object.entries((obj.model_ratio ?? {}) as Record<string, unknown>)) {
          const n = num(v);
          if (n !== undefined) ratios[k] = n;
        }
        for (const [k, v] of Object.entries((obj.model_price ?? {}) as Record<string, unknown>)) {
          const n = num(v);
          if (n !== undefined) prices[k] = n;
        }
      }
      if (Object.keys(ratios).length === 0 && Object.keys(prices).length === 0) return null;
      return { ratios, prices, quotaTypes };
    } catch {
      return null;
    }
  }

  /**
   * 单模型免费性实证（2026-08-24 刘总反馈驱动）：零余额账号上，/v1/models 列出的
   * 模型未必可调用（米醋实测 21 个收费模型全部 403）。用最小 chat 请求判定：
   * 200 → ok（真免费/可用）；402/403 → quota（余额不足，收费模型）；429 → limited（限流待定）；其他 → error。
   */
  async probeModel(baseUrl: string, apiKey: string, modelId: string): Promise<'ok' | 'quota' | 'limited' | 'error'> {
    try {
      const response = await this.#request(joinUrl(baseUrl, '/v1/chat/completions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      }, 30_000);
      await response.text();
      if (response.ok) return 'ok';
      if (response.status === 402 || response.status === 403) return 'quota';
      if (response.status === 429) return 'limited';
      return 'error';
    } catch {
      return 'error';
    }
  }

  /** 访问验证链接（邮件激活型站点）。返回是否 2xx。 */
  async visitVerificationLink(link: string): Promise<boolean> {
    try {
      const response = await this.#request(link, { method: 'GET' }, 20_000);
      await response.text();
      return response.ok;
    } catch {
      return false;
    }
  }

  get paceForTest(): () => Promise<void> { return async () => { await humanDelay(this.#sleep, this.#random); }; }
}

function normalizeSk(key: string): string {
  return key.startsWith('sk-') ? key : 'sk-' + key;
}

function StationStatus_unreachable(): StationStatus {
  return {
    reachable: false,
    compatible: false,
    turnstileCheck: false,
    emailVerification: false,
    passwordLoginEnabled: null,
    systemName: '',
    version: '',
    quotaPerUnit: 500_000,
    raw: {},
  };
}
