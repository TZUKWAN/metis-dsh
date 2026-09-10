/**
 * AssistantStreamAccumulator 回归测试（2026-09-05 P0 Phase 1）。
 * 验证 DSH 移植本质：dense index、settle swap、abandonment、rebaseline。
 */

import { describe, it, expect } from 'vitest';
import { AssistantStreamAccumulator } from '../../src/conversation/runtime/AssistantStreamAccumulator.js';
import type { AssistantStreamFrame } from '../../src/conversation/contract/AssistantStreamContract.js';

const start = (attemptId: string): AssistantStreamFrame => ({ type: 'start', attemptId });
const chunk = (attemptId: string, index: number, textDelta: string): AssistantStreamFrame => ({
  type: 'chunk', attemptId, index, textDelta,
});
const endSettled = (attemptId: string, index: number, finalContent: string): AssistantStreamFrame => ({
  type: 'end', attemptId, index,
  outcome: 'settled', finalContent, status: 'completed',
});

describe('AssistantStreamAccumulator', () => {
  it('accumulates chunks byte-identically and settles with authoritative content', () => {
    const acc = new AssistantStreamAccumulator();
    expect(acc.acceptFrame(start('a1')).type).toBe('accepted');
    acc.acceptFrame(chunk('a1', 0, '生成'));
    acc.acceptFrame(chunk('a1', 1, '式人工'));
    acc.acceptFrame(chunk('a1', 2, '智能'));
    const decision = acc.acceptFrame(endSettled('a1', 3, '生成式人工智能'));

    expect(decision).toMatchObject({ type: 'settled', attemptId: 'a1', content: '生成式人工智能', status: 'completed' });
    expect(acc.snapshot()).toMatchObject({ attemptId: 'a1', content: '生成式人工智能', status: 'completed' });
    expect(acc.isStreaming()).toBe(false);
  });

  it('settle swap overwrites accumulated content with the authoritative final content', () => {
    const acc = new AssistantStreamAccumulator();
    acc.acceptFrame(start('a1'));
    acc.acceptFrame(chunk('a1', 0, '流式累积的可能漂移文本'));
    const decision = acc.acceptFrame(endSettled('a1', 1, '权威最终内容'));

    expect(decision).toMatchObject({ type: 'settled', content: '权威最终内容' });
  });

  it('rejects dense-index gaps with a rebaseline decision instead of guessing', () => {
    const acc = new AssistantStreamAccumulator();
    acc.acceptFrame(start('a1'));
    acc.acceptFrame(chunk('a1', 0, 'a'));
    const decision = acc.acceptFrame(chunk('a1', 2, 'c'));

    expect(decision).toMatchObject({ type: 'rebaseline', attemptId: 'a1' });
    expect(acc.isStreaming()).toBe(true);
  });

  it('ignores chunks and ends from a stale attempt', () => {
    const acc = new AssistantStreamAccumulator();
    acc.acceptFrame(start('a1'));
    acc.acceptFrame(start('a2'));

    expect(acc.acceptFrame(chunk('a1', 0, 'x')).type).toBe('ignored');
    expect(acc.acceptFrame(endSettled('a1', 1, 'x')).type).toBe('ignored');
    expect(acc.isStreaming()).toBe(true);
  });

  it('abandonment clears transient content', () => {
    const acc = new AssistantStreamAccumulator();
    acc.acceptFrame(start('a1'));
    acc.acceptFrame(chunk('a1', 0, '半截内容'));
    const decision = acc.acceptFrame({
      type: 'end', attemptId: 'a1', index: 1, outcome: 'abandoned', reason: 'provider_error',
    });

    expect(decision).toMatchObject({ type: 'abandoned', attemptId: 'a1' });
    expect(acc.snapshot()).toMatchObject({ content: '', status: 'abandoned' });
  });

  it('reasoning accumulates separately from content', () => {
    const acc = new AssistantStreamAccumulator();
    acc.acceptFrame(start('a1'));
    acc.acceptFrame({ type: 'chunk', attemptId: 'a1', index: 0, reasoningDelta: '思考中' });
    acc.acceptFrame({ type: 'chunk', attemptId: 'a1', index: 1, textDelta: '答案', reasoningDelta: '+检索' });

    expect(acc.snapshot()).toMatchObject({ content: '答案', reasoning: '思考中+检索' });
  });

  it('a fresh start resets accumulation for the new attempt', () => {
    const acc = new AssistantStreamAccumulator();
    acc.acceptFrame(start('a1'));
    acc.acceptFrame(chunk('a1', 0, '旧内容'));
    acc.acceptFrame(start('a2'));

    expect(acc.snapshot()).toMatchObject({ attemptId: 'a2', content: '', status: 'streaming' });
  });
});
