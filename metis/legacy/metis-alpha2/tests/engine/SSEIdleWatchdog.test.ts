/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { streamOpenAIResponse } from '../../engine/providers/SSEParser.js';

function fakeResponse(read: () => Promise<{ done: boolean; value?: Uint8Array }>) {
  return {
    body: {
      getReader: () => ({
        read,
        cancel: () => Promise.resolve(),
        releaseLock: () => undefined,
      }),
    },
  } as unknown as Response;
}

describe('streamOpenAIResponse idle watchdog', () => {
  it('aborts a dead stream that never delivers bytes within the idle window', async () => {
    // 模拟网关假死：连接保持打开，但永远不产生任何字节。
    const response = fakeResponse(() => new Promise(() => undefined));
    const started = Date.now();
    await expect(async () => {
      for await (const chunk of streamOpenAIResponse(response, 50)) void chunk;
    }).rejects.toThrowError(/idle/u);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('still completes a healthy stream that delivers bytes promptly', async () => {
    const encoder = new TextEncoder();
    const payload = [
      'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"世界"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ].map((line) => encoder.encode(line));
    let index = 0;
    const response = fakeResponse(async () => (
      index < payload.length
        ? { done: false, value: payload[index++] }
        : { done: true }
    ));
    const chunks: string[] = [];
    for await (const chunk of streamOpenAIResponse(response, 1000)) chunks.push(chunk.content ?? '');
    expect(chunks.join('')).toContain('你好');
    expect(chunks.join('')).toContain('世界');
  });

  it('completes a stream that ends without [DONE] after a finished choice (Codex-style gateways)', async () => {
    const encoder = new TextEncoder();
    // 部分本地网关在 finish_reason:"stop" + usage 后直接关闭连接，不发 [DONE]。
    const payload = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"pong"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":304,"completion_tokens":5,"total_tokens":309}}\n\n',
    ].map((line) => encoder.encode(line));
    let index = 0;
    const response = fakeResponse(async () => (
      index < payload.length
        ? { done: false, value: payload[index++] }
        : { done: true }
    ));
    const chunks: Array<{ content?: string; isFinished?: boolean }> = [];
    for await (const chunk of streamOpenAIResponse(response, 1000)) chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.content ?? '').join('')).toContain('pong');
    expect(chunks.some((chunk) => chunk.isFinished === true)).toBe(true);
  });

  it('still rejects a stream that dies mid-answer with no finished choice and no [DONE]', async () => {
    const encoder = new TextEncoder();
    const payload = [
      'data: {"choices":[{"delta":{"content":"半截"},"finish_reason":null}]}\n\n',
    ].map((line) => encoder.encode(line));
    let index = 0;
    const response = fakeResponse(async () => (
      index < payload.length
        ? { done: false, value: payload[index++] }
        : { done: true }
    ));
    await expect(async () => {
      for await (const chunk of streamOpenAIResponse(response, 1000)) void chunk;
    }).rejects.toThrowError(/DONE/u);
  });
});
