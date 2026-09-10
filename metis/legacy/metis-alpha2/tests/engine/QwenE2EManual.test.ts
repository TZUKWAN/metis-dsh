/**
 * @vitest-environment node
 * Manual end-to-end check against the live Qwen gateway. Skipped by default;
 * run with `npx vitest run tests/engine/QwenE2EManual.test.ts` to verify.
 */
import { describe, it, expect } from 'vitest';
import { OpenAICompatProvider } from '../../engine/providers/OpenAICompatProvider.js';

const BASE_URL = process.env.QWEN_BASE_URL ?? 'http://218.197.140.7:3001/v1';
const API_KEY = process.env.QWEN_KEY ?? 'set-via-env';
const MODEL = process.env.QWEN_MODEL ?? 'Qwen3.5-122B-A10B';

describe('Qwen3.5-122B live gateway (manual)', { timeout: 120_000 }, () => {
  it.skipIf(!process.env.RUN_LIVE)('parses a text-protocol tool call from the live model', async () => {
    const provider = new OpenAICompatProvider({
      baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL,
      timeout: 60_000, maxRetries: 3, retryBackoffSeconds: 2,
    });
    const tools = [
      { name: 'web_search', description: '搜索网络', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    ];
    const response = await provider.complete(
      [
        { role: 'system', content: '你是科研助手。需要搜索时调用 web_search 工具。' },
        { role: 'user', content: '帮我搜索 2025 年大语言模型进展' },
      ],
      tools,
    );
    console.log('content:', JSON.stringify(response.content?.slice(0, 200)));
    console.log('toolCalls:', JSON.stringify(response.toolCalls));
    expect(response.toolCalls.length).toBeGreaterThan(0);
    expect(response.toolCalls[0]?.name).toBe('web_search');
  });

  // Connectivity check — also gated behind RUN_LIVE so the automated suite
  // never depends on an external gateway/key (CI has neither and the gateway
  // is intermittently flaky). Run locally with RUN_LIVE=1 to verify.
  it.skipIf(!process.env.RUN_LIVE)('connects to the gateway and gets a 200 response', async () => {
    const provider = new OpenAICompatProvider({
      baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL,
      timeout: 60_000, maxRetries: 3, retryBackoffSeconds: 2,
    });
    const response = await provider.complete([{ role: 'user', content: '只回复OK' }]);
    console.log('live content:', JSON.stringify(response.content?.slice(0, 60)));
    expect(response.finishReason).toBeDefined();
  });
});
