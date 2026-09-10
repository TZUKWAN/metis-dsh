/**
 * 免费模型发现服务（2026-08-23 刘总需求）。
 *
 * 扫描源：
 *  - OpenRouter：GET /api/v1/models（公开），pricing 全零判定免费；
 *    探活需已有 OpenRouter key（复用用户已配置 profile 的密钥）。
 *  - 自定义 New API 系中转站：用户提供 baseUrl + 可选 key；站点性质即公益，
 *    列出的模型默认全部视为免费候选，探活验证可用性。
 *
 * 每个候选记录延迟与上次验证时间；接入动作由调用方经正规 profile save 路径完成。
 */

export interface DiscoverySource {
  id: string;
  kind: 'openrouter' | 'newapi' | 'omniroute';
  name: string;
  baseUrl: string;
  /** 加密后的可选 key（OpenRouter 复用已激活 profile 的 key，无需在此存储） */
  encryptedKey?: string;
  enabled: boolean;
}

export interface DiscoveredModel {
  key: string; // sourceId + '|' + modelId 唯一标识
  sourceId: string;
  sourceName: string;
  sourceKind: 'openrouter' | 'newapi' | 'omniroute';
  modelId: string;
  freeTierNote: string;
  latencyMs: number | null;
  probeOk: boolean | null;
  probedAt: number | null;
  discoveredAt: number;
}

type FetchLike = (url: string, options?: Record<string, unknown>) => Promise<Response>;

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** 复用 NewApiClient 的定价表解析（数组/map 双形态已实证）。 */
async function fetchStationPricing(fetchLike: FetchLike, baseUrl: string, apiKey: string) {
  try {
    const { NewApiClient } = await import('./NewAPIClient.js');
    const client = new NewApiClient({ fetchLike, sleep: async () => {} });
    return await client.getPricing(baseUrl, { apiKey });
  } catch {
    return null;
  }
}

/** 定价表免费判定：未知模型一律不当免费（宁可少列，不可误导——刘总 2026-08-24）。 */
export function isFreeByPricing(pricing: { ratios: Record<string, number>; prices: Record<string, number>; quotaTypes?: Record<string, number> }, modelId: string): boolean {
  const quotaType = pricing.quotaTypes?.[modelId];
  const price = pricing.prices[modelId];
  const ratio = pricing.ratios[modelId];
  if (quotaType === 1 && price !== undefined) return price === 0;
  if (quotaType === 0 && ratio !== undefined) return ratio === 0;
  if (price !== undefined && ratio !== undefined) return price === 0 && ratio === 0;
  if (ratio !== undefined) return ratio === 0;
  if (price !== undefined) return price === 0;
  return false;
}

/** OpenRouter models 响应中的定价全零 → 免费。导出仅为测试。 */
export function filterOpenRouterFreeModels(payload: unknown): Array<{ id: string; note: string }> {
  const data = (payload as { data?: Array<{ id?: unknown; pricing?: Record<string, unknown> }> }).data ?? [];
  return (Array.isArray(data) ? data : [])
    .filter((model) => typeof model.id === 'string')
    .filter((model) => {
      const pricing = model.pricing ?? {};
      const prompt = String(pricing.prompt ?? '1');
      const completion = String(pricing.completion ?? '1');
      return prompt === '0' && completion === '0';
    })
    .map((model) => ({ id: model.id as string, note: 'OpenRouter 免费档（限速：约20次/分钟、每日数十次）' }));
}

async function timedProbe(fetchLike: FetchLike, baseUrl: string, apiKey: string | undefined, modelId: string): Promise<{ ok: boolean; latencyMs: number }> {
  const started = Date.now();
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;
    const response = await fetchLike(baseUrl.replace(new RegExp("/+$"), "") + "/chat/completions", {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(30_000),
    });
    // 消费少量字节即可判定可达；无需读完整个响应。
    await response.text();
    return { ok: response.ok, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: Date.now() - started };
  }
}

export interface DiscoveryScanOptions {
  sources: DiscoverySource[];
  /** 解密后的各源 key：sourceId -> 明文 key（OpenRouter 取自已激活 profile） */
  keysBySource: Map<string, string | undefined>;
  fetchLike?: FetchLike;
  probe?: boolean;
  probeConcurrency?: number;
}

/** 扫描所有启用源，返回去重后的免费模型清单。 */
export async function scanFreeModels(options: DiscoveryScanOptions): Promise<DiscoveredModel[]> {
  const fetchLike = options.fetchLike ?? ((url, init) => fetch(url, init as never));
  const results: DiscoveredModel[] = [];
  for (const source of options.sources.filter((source) => source.enabled)) {
    try {
      if (source.kind === 'openrouter') {
        const response = await fetchLike(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(30_000) } as never);
        if (!response.ok) continue;
        const payload = await response.json();
        const freeModels = filterOpenRouterFreeModels(payload);
        for (const model of freeModels) {
          results.push({
            key: source.id + '|' + model.id,
            sourceId: source.id,
            sourceName: source.name,
            sourceKind: 'openrouter',
            modelId: model.id,
            freeTierNote: model.note,
            latencyMs: null,
            probeOk: null,
            probedAt: null,
            discoveredAt: Date.now(),
          });
        }
      } else if (source.kind === 'omniroute') {
        // OmniRoute 本地网关：列出的模型走免费层聚合；已自动配置 key 时带 Bearer。
        const modelsUrl = source.baseUrl.replace(/\/+$/u, '') + '/models';
        const omniKey = options.keysBySource.get(source.id);
        const omniHeaders: Record<string, string> = omniKey ? { authorization: 'Bearer ' + omniKey } : {};
        const response = await fetchLike(modelsUrl, { headers: omniHeaders, signal: AbortSignal.timeout(8_000) } as never);
        if (!response.ok) continue;
        const payload = await response.json();
        const data = Array.isArray((payload as { data?: unknown }).data) ? (payload as { data: Array<{ id?: unknown }> }).data : [];
        for (const model of data) {
          if (typeof model.id !== 'string') continue;
          results.push({
            key: source.id + '|' + model.id,
            sourceId: source.id,
            sourceName: source.name,
            sourceKind: 'omniroute',
            modelId: model.id,
            freeTierNote: 'OmniRoute 本地网关 · 免费层聚合',
            latencyMs: null,
            probeOk: null,
            probedAt: null,
            discoveredAt: Date.now(),
          });
        }
      } else {
        const headers: Record<string, string> = {};
        const key = options.keysBySource.get(source.id);
        if (key) headers.authorization = 'Bearer ' + key;
        const modelsUrl = source.baseUrl.replace(/\/+$/u, '') + '/models';
        const response = await fetchLike(modelsUrl, { headers, signal: AbortSignal.timeout(30_000) } as never);
        if (!response.ok) continue;
        const payload = await response.json() as { data?: Array<{ id?: unknown }> };
        const listed = (Array.isArray(payload.data) ? payload.data : [])
          .map((model) => model.id)
          .filter((id): id is string => typeof id === 'string');
        // 刘总 2026-08-24：/v1/models 是站点支持全集，收费模型不得混入免费列表。
        // 有 key 时先读定价表（0 倍率/0 价格 = 免费）；表不可得则保留但如实标注未验证。
        let usable = listed;
        let note = '站点模型（定价未验证，可能收费）';
        if (key) {
          const pricing = await fetchStationPricing(fetchLike, source.baseUrl, key);
          if (pricing) {
            usable = listed.filter((modelId) => isFreeByPricing(pricing, modelId));
            note = usable.length === listed.length
              ? '定价表确认全部免费'
              : '定价表判定免费（滤除 ' + (listed.length - usable.length) + ' 个收费模型）';
          }
        }
        for (const modelId of usable) {
          results.push({
            key: source.id + '|' + modelId,
            sourceId: source.id,
            sourceName: source.name,
            sourceKind: 'newapi',
            modelId,
            freeTierNote: note,
            latencyMs: null,
            probeOk: null,
            probedAt: null,
            discoveredAt: Date.now(),
          });
        }
      }
    } catch {
      // 单源失败不影响其他源；健康状态由调用方按 lastScan 结果呈现。
    }
  }

  // 探活（可选）：限制并发，逐个测延迟与可用性。
  if (options.probe && results.length > 0) {
    const concurrency = Math.max(1, Math.min(options.probeConcurrency ?? 4, 8));
    let cursor = 0;
    async function worker(): Promise<void> {
      while (cursor < results.length) {
        const index = cursor;
        cursor += 1;
        const item = results[index]!;
        const source = options.sources.find((candidate) => candidate.id === item.sourceId);
        const outcome = await timedProbe(fetchLike, source?.baseUrl ?? '', options.keysBySource.get(item.sourceId), item.modelId);
        item.probeOk = outcome.ok;
        item.latencyMs = outcome.latencyMs;
        item.probedAt = Date.now();
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }
  return results;
}
