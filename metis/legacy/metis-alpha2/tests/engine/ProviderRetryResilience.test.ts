import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatProvider } from '../../engine/providers/OpenAICompatProvider.js';

// 回归（2026-08-22 刘总要求 + 场景助手 agent_error 排查）：
// 1) 所有 AI 交互默认至少 20 次传输层重试、180s 超时；
// 2) 非 2xx 响应体里的真实错误原因必须进入异常消息（可观测性）；
// 3) 确定性配置错误（模型名不存在）立即失败，不烧重试预算；
// 4) 瞬时服务端错误仍在预算内自动重试。

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('undici', () => ({ fetch: fetchMock }));

function make(overrides: Partial<ConstructorParameters<typeof OpenAICompatProvider>[0]> = {}) {
  return new OpenAICompatProvider({
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'k',
    model: 'test-model',
    ...overrides,
  } as ConstructorParameters<typeof OpenAICompatProvider>[0]);
}

function jsonResponse(body: unknown, status: number, statusText: string): Response {
  return new Response(JSON.stringify(body), { status, statusText });
}

afterEach(() => {
  fetchMock.mockReset();
});

describe('OpenAICompatProvider retry resilience defaults', () => {
  it('defaults to a 180s timeout and a 20-attempt retry budget', () => {
    const provider = make();
    expect(provider.timeout).toBe(180_000);
    expect(provider.maxRetries).toBe(20);
  });

  it('keeps explicit configuration authoritative', () => {
    const provider = make({ timeout: 240_000, maxRetries: 5 });
    expect(provider.timeout).toBe(240_000);
    expect(provider.maxRetries).toBe(5);
  });

  it('includes the provider error body in the thrown message for non-2xx responses', async () => {
    const provider = make({ maxRetries: 0 });
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'No endpoints found for ox-alpha.' } }, 404, 'Not Found'));
    await expect(provider.complete([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/No endpoints found for ox-alpha/u);
    // 404 不在可重试列表：只调用一次。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast on deterministic invalid-model 400s instead of burning the retry budget', async () => {
    const provider = make({ maxRetries: 20, retryBackoffSeconds: 1 });
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'No endpoints found for ox-alpha.' } }, 400, 'Bad Request'));
    await expect(provider.complete([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow(/No endpoints found/u);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries transient server errors within the configured budget', async () => {
    const provider = make({ maxRetries: 3, retryBackoffSeconds: 0 });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'upstream overloaded' } }, 503, 'Service Unavailable'))
      .mockResolvedValueOnce(jsonResponse({
        id: 'resp-1', object: 'chat.completion', created: 1, model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }, 200, 'OK'));
    const result = await provider.complete([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
