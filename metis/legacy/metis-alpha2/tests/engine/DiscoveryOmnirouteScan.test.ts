/**
 * scanFreeModels 的 OmniRoute 分支测试（2026-08-24）：
 * 本地网关源应通过 GET {baseUrl}/models 列出免费模型，无需 key。
 */
import { describe, it, expect } from 'vitest';
import { isFreeByPricing, scanFreeModels, type DiscoverySource } from '../../engine/providers/discovery/ProviderDiscoveryService.js';

const OMNI_SOURCE: DiscoverySource = {
  id: 'omniroute-local',
  kind: 'omniroute',
  name: 'OmniRoute 本地网关',
  baseUrl: 'http://127.0.0.1:20128/v1',
  enabled: true,
};

describe('isFreeByPricing (刘总：收费模型不得入免费列表)', () => {
  const pricing = { ratios: { free: 0, paid: 30 }, prices: { percall: 0.02 }, quotaTypes: { percall: 1 } };
  it('zero ratio is free, positive ratio is not', () => {
    expect(isFreeByPricing(pricing, 'free')).toBe(true);
    expect(isFreeByPricing(pricing, 'paid')).toBe(false);
  });
  it('quota_type=1 uses price', () => {
    expect(isFreeByPricing(pricing, 'percall')).toBe(false);
  });
  it('unknown models are NOT treated as free', () => {
    expect(isFreeByPricing(pricing, 'mystery')).toBe(false);
  });
});

describe('scanFreeModels newapi pricing filter', () => {
  const NEWAPI_SOURCE: DiscoverySource = {
    id: 'src-test',
    kind: 'newapi',
    name: '测试站',
    baseUrl: 'https://s.example.com',
    enabled: true,
  };
  it('filters paid models out when pricing table available (米醋实证形态)', async () => {
    const models = await scanFreeModels({
      sources: [NEWAPI_SOURCE],
      keysBySource: new Map([['src-test', 'sk-test']]),
      probe: false,
      fetchLike: async (url) => {
        const u = String(url);
        if (u.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'free-m' }, { id: 'claude-fable-5' }] }), { status: 200 });
        if (u.endsWith('/api/pricing')) return new Response(JSON.stringify({ success: true, data: [{ model_name: 'free-m', quota_type: 0, model_ratio: 0, model_price: 0 }, { model_name: 'claude-fable-5', quota_type: 0, model_ratio: 30, model_price: 0 }] }), { status: 200 });
        return new Response('nf', { status: 404 });
      },
    });
    expect(models.map((m) => m.modelId)).toEqual(['free-m']);
    expect(models[0]!.freeTierNote).toContain('滤除 1 个收费模型');
  });
  it('keeps models with honest note when pricing unavailable', async () => {
    const models = await scanFreeModels({
      sources: [NEWAPI_SOURCE],
      keysBySource: new Map([['src-test', 'sk-test']]),
      probe: false,
      fetchLike: async (url) => {
        const u = String(url);
        if (u.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'x' }] }), { status: 200 });
        return new Response('nope', { status: 404 });
      },
    });
    expect(models.map((m) => m.modelId)).toEqual(['x']);
    expect(models[0]!.freeTierNote).toContain('定价未验证');
  });
});

describe('scanFreeModels omniroute branch', () => {
  it('lists gateway models without auth and tags them as omniroute', async () => {
    const calls: Array<string> = [];
    const models = await scanFreeModels({
      sources: [OMNI_SOURCE],
      keysBySource: new Map(),
      probe: false,
      fetchLike: async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ data: [{ id: 'auto' }, { id: 'oc/gpt-4o-free' }] }), { status: 200 });
      },
    });
    expect(calls).toEqual(['http://127.0.0.1:20128/v1/models']);
    expect(models.map((m) => m.modelId)).toEqual(['auto', 'oc/gpt-4o-free']);
    expect(models.every((m) => m.sourceKind === 'omniroute')).toBe(true);
    expect(models[0]!.sourceId).toBe('omniroute-local');
  });

  it('skips the source silently when gateway is down (单源失败不影响其他源)', async () => {
    const openrouterSource: DiscoverySource = { ...OMNI_SOURCE, id: 'openrouter-builtin', kind: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' };
    const models = await scanFreeModels({
      sources: [OMNI_SOURCE, openrouterSource],
      keysBySource: new Map(),
      probe: false,
      fetchLike: async (url) => {
        if (String(url).startsWith('http://127.0.0.1')) return new Response('connection refused', { status: 503 });
        return new Response(JSON.stringify({ data: [{ id: 'free-model-x', pricing: { prompt: '0', completion: '0' } }, { id: 'paid-model', pricing: { prompt: '0.001', completion: '0.002' } }] }), { status: 200 });
      },
    });
    expect(models.every((m) => m.sourceKind !== 'omniroute')).toBe(true);
    expect(models.some((m) => m.modelId === 'free-model-x')).toBe(true);
    expect(models.some((m) => m.modelId === 'paid-model')).toBe(false);
  });
});
