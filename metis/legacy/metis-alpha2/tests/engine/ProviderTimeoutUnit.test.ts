import { describe, expect, it } from 'vitest';
import { OpenAICompatProvider } from '../../engine/providers/OpenAICompatProvider.js';

// 回归（2026-08-22 场景助手 agent_error 实证）：遗留配置曾以「秒」写入
// timeout（120 表示 120s），运行时按毫秒解释后每次请求 120ms 即中断。
describe('OpenAICompatProvider timeout unit self-heal', () => {
  function make(timeout: number | undefined) {
    return new OpenAICompatProvider({ baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: 'test-model', ...(timeout === undefined ? {} : { timeout }) } as ConstructorParameters<typeof OpenAICompatProvider>[0]);
  }

  it('treats sub-second legacy values as seconds and normalizes to milliseconds', () => {
    expect(make(120).timeout).toBe(120_000);
    expect(make(30).timeout).toBe(30_000);
  });

  it('keeps millisecond values untouched', () => {
    expect(make(60_000).timeout).toBe(60_000);
    expect(make(45_000).timeout).toBe(45_000);
  });

  it('falls back to the 180s default when timeout is absent (2026-08-22 requirement)', () => {
    expect(make(undefined).timeout).toBe(180_000);
  });
});
