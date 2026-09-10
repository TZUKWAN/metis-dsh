/**
 * Text tool protocol — verifies the provider correctly parses JSON tool calls
 * emitted as prose by thinking models whose gateways reject native `tools`.
 *
 * Uses a real localhost HTTP server (like ProviderVision.test.ts) so the full
 * fetch → parse path is exercised.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatProvider } from '../../engine/providers/OpenAICompatProvider.js';

interface CapturedRequest {
  body: Record<string, unknown>;
}

function startServer(responder: (body: Record<string, unknown>) => unknown): Promise<{ port: number; close: () => void; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk.toString(); });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responder(body)));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ port: addr.port, close: () => server.close(), requests });
    });
  });
}

function makeProvider(port: number, model: string): OpenAICompatProvider {
  return new OpenAICompatProvider({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'test-key',
    model,
    timeout: 5000,
    maxRetries: 0,
    retryBackoffSeconds: 0,
  });
}

describe('text tool protocol (Qwen3 thinking models)', () => {
  let server: Awaited<ReturnType<typeof startServer>>;

  afterEach(() => { server?.close(); });

  it('detects qwen3.5-122b-a10b as thinking + non-native-tool-calling', () => {
    const provider = makeProvider(1, 'Qwen3.5-122B-A10B');
    const caps = provider.capabilities();
    expect(caps.thinking).toBe(true);
    expect(caps.nativeToolCalling).toBe(false);
    expect(caps.maxOutputTokens).toBeGreaterThanOrEqual(16384);
    expect(caps.retryableStatusCodes).toContain(400);
  });

  it('parses a bare-JSON tool call from content into toolCalls', async () => {
    server = await startServer(() => ({
      choices: [{
        message: { role: 'assistant', content: '{"tool":"get_time","args":{}}', reasoning_content: null },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    }));
    const provider = makeProvider(server.port, 'Qwen3.5-122B-A10B');

    const response = await provider.complete([{ role: 'user', content: 'time?' }]);

    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]?.name).toBe('get_time');
    expect(response.content).toBe('');
  });

  it('parses a fenced JSON tool call embedded in prose', async () => {
    server = await startServer(() => ({
      choices: [{
        message: { role: 'assistant', content: '我来查询时间。\n```json\n{"tool":"get_time","args":{"tz":"UTC"}}\n```' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 20, total_tokens: 25 },
    }));
    const provider = makeProvider(server.port, 'qwen3.5-35b-a3b');

    const response = await provider.complete([{ role: 'user', content: 'time?' }]);
    expect(response.toolCalls[0]?.name).toBe('get_time');
    expect(response.toolCalls[0]?.arguments).toEqual({ tz: 'UTC' });
  });

  it('leaves normal prose content untouched', async () => {
    server = await startServer(() => ({
      choices: [{
        message: { role: 'assistant', content: '现在是下午三点。没有可用的工具。' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    }));
    const provider = makeProvider(server.port, 'Qwen3.5-122B-A10B');

    const response = await provider.complete([{ role: 'user', content: 'time?' }]);
    expect(response.toolCalls).toHaveLength(0);
    expect(response.content).toContain('下午三点');
  });

  it('does not misparse ordinary JSON with a name field as a tool call', async () => {
    server = await startServer(() => ({
      choices: [{
        message: { role: 'assistant', content: '{"id":"rag-review","name":"RAG Review","systemPrompt":"steps"}' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 15, total_tokens: 20 },
    }));
    const provider = makeProvider(server.port, 'Qwen3.5-122B-A10B');

    const response = await provider.complete([{ role: 'user', content: 'generate a skill' }]);
    expect(response.toolCalls).toHaveLength(0);
    expect(response.content).toContain('rag-review');
  });

  it('sends enable_thinking=false by default, true when params.thinking=true', async () => {
    server = await startServer(() => ({
      choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
    const provider = makeProvider(server.port, 'Qwen3.5-122B-A10B');

    await provider.complete([{ role: 'user', content: 'hi' }]);
    await provider.complete([{ role: 'user', content: 'hi' }], undefined, { thinking: true });

    expect(server.requests[0]?.body.enable_thinking).toBe(false);
    expect((server.requests[0]?.body.chat_template_kwargs as Record<string, unknown>)?.enable_thinking).toBe(false);
    expect(server.requests[1]?.body.enable_thinking).toBe(true);
  });

  it('injects tool docs into the system prompt (no native tools field)', async () => {
    server = await startServer(() => ({
      choices: [{ message: { role: 'assistant', content: '{"tool":"search","args":{"q":"x"}}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
    const provider = makeProvider(server.port, 'Qwen3.5-122B-A10B');

    await provider.complete(
      [{ role: 'user', content: 'search for x' }],
      [{ name: 'search', description: 'search the web', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
    );

    const body = server.requests[0]?.body;
    expect(body?.tools).toBeUndefined();
    expect(body?.enable_thinking).toBe(false);
    const messages = body?.messages as Array<{ role: string; content: string }>;
    expect(messages.some((m) => m.content.includes('Available Tools') && m.content.includes('search'))).toBe(true);
  });
});

// ─── stripTextToolMarkup (F4: <tool_calls> leak) ─────────────

import { parseTextToolCall, stripTextToolMarkup } from '../../engine/tools/TextToolProtocol.js';

describe('stripTextToolMarkup', () => {
  it('removes a paired <tool_calls> block and keeps the real answer', () => {
    const input = '我会先检索。<tool_calls> <thorough_search> <query>meta-analysis</query> </thorough_search> </tool_calls> 元分析是一种统计方法。';
    expect(stripTextToolMarkup(input)).toBe('我会先检索。 元分析是一种统计方法。');
  });

  it('removes an unclosed trailing <tool_calls> block (truncated stream)', () => {
    const input = '答案是 42。\n<tool_calls> <thorough_search> <query>unfinished';
    expect(stripTextToolMarkup(input)).toBe('答案是 42。');
  });

  it('removes <tool_call> singular blocks too', () => {
    expect(stripTextToolMarkup('A<tool_call>{"name":"x"}</tool_call>B')).toBe('AB');
  });

  it('passes through text without markup unchanged', () => {
    const plain = '元分析合并多个独立研究的结果。\n\n第二段。';
    expect(stripTextToolMarkup(plain)).toBe(plain);
  });

  it('returns empty string when the whole output was markup', () => {
    expect(stripTextToolMarkup('<tool_calls> <query>x</query> </tool_calls>')).toBe('');
  });
});

// 回归（2026-08-22 场景增量编译冒烟实测）：模型输出的 text-call JSON 带尾部
// 杂散字符（…}]}}"}），或被输出上限截断。解析器必须容错提取，否则增量构建
// 在第二轮就中断回退。
describe('TextToolProtocol tolerant extraction', () => {
  it('parses a tool call with a stray trailing quote/brace after valid JSON', () => {
    const content = '{"tool": "scenario_apply_update", "args": {"fields": {"workflow": [{"id": "a"}, {"id": "b"}]}}}"}"';
    const parsed = parseTextToolCall(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('scenario_apply_update');
    const fields = (parsed!.arguments as { fields?: { workflow?: unknown[] } }).fields;
    expect(fields?.workflow).toHaveLength(2);
  });

  it('repairs a truncated tool call cut off mid-object by an output ceiling', () => {
    const content = '{"tool": "scenario_apply_update", "args": {"fields": {"workflow": [{"id": "step-1", "prompt": "解读申报指南"';
    const parsed = parseTextToolCall(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('scenario_apply_update');
  });

  it('still rejects ordinary JSON without a tool field', () => {
    expect(parseTextToolCall('{"summary":"普通总结","scenario":{"name":"x"}}')).toBeNull();
  });
});
