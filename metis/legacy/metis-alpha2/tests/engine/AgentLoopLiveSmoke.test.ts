/**
 * @vitest-environment node
 *
 * Live AgentLoop smoke test against the real Qwen gateway. Verifies the full
 * chain: OpenAICompatProvider (text tool protocol) → AgentLoop turn loop →
 * tool dispatch → finalize. Gated behind RUN_LIVE=1 (no key in source, never
 * runs in CI).
 */

import { describe, it, expect } from 'vitest';
import { OpenAICompatProvider } from '../../engine/providers/OpenAICompatProvider.js';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import type { ToolHandler } from '../../engine/tools/ToolDispatcher.js';

const BASE_URL = process.env.QWEN_BASE_URL ?? 'http://218.197.140.7:3001/v1';
const API_KEY = process.env.QWEN_KEY ?? '';
const MODEL = process.env.QWEN_MODEL ?? 'Qwen3.5-122B-A10B';

describe('AgentLoop live smoke (Qwen3.5-122B)', { timeout: 180_000 }, () => {
  it.skipIf(!process.env.RUN_LIVE || !API_KEY)('runs a full turn that calls a tool, then finalizes', async () => {
    const provider = new OpenAICompatProvider({
      baseUrl: BASE_URL, apiKey: API_KEY, model: MODEL,
      timeout: 90_000, maxRetries: 3, retryBackoffSeconds: 2,
    });

    // Register one toy tool so the agent loop can dispatch it.
    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);
    registry.register({
      name: 'get_weather',
      description: '获取指定城市的天气。参数 city 是城市名（必填）。',
      parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名，例如 北京、上海' } }, required: ['city'] },
    });
    const weatherHandler: ToolHandler = async (args) => {
      console.log('  [handler] received args:', JSON.stringify(args));
      const city = String(args.city ?? args.location ?? '未知');
      return JSON.stringify({ city, weather: '晴', temperature: 25 });
    };
    dispatcher.registerHandler('get_weather', weatherHandler);

    const loop = new AgentLoop({ provider, registry, dispatcher, workspace: '.' });

    const result = await loop.run({
      sessionId: 'live-smoke',
      messages: [
        { role: 'system', content: '你是天气助手。需要天气信息时调用 get_weather 工具，参数 city 填城市名。' },
        { role: 'user', content: '北京今天天气怎么样？' },
      ],
      allowedTools: ['get_weather'],
      maxTurns: 6,
      requestId: 'live-smoke-1',
    });

    console.log('AgentLoop status:', result.status);
    console.log('finalText:', JSON.stringify(result.finalText?.slice(0, 200)));
    const toolSummary = result.toolResults.map((r) => ({ toolName: r.toolName, status: r.status }));
    console.log('toolResults:', JSON.stringify(toolSummary));

    expect(['completed', 'max_turns']).toContain(result.status);
    // The agent should have dispatched the weather tool at least once.
    expect(result.toolResults.length).toBeGreaterThan(0);
    expect(result.toolResults.some((r) => r.toolName === 'get_weather')).toBe(true);
    // And at least one weather call should have succeeded.
    expect(result.toolResults.some((r) => r.toolName === 'get_weather' && r.status === 'ok')).toBe(true);
  });
});
