/**
 * Tests for ContextEngine summarizer — long conversation condensation.
 */

import { describe, it, expect, vi } from 'vitest';
import { ContextEngine } from '../../engine/context/ContextEngine.js';
import type { ChatMessage } from '../../engine/core/types.js';

function longMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: 'user' as const,
    content: `Message ${i}: ${'x'.repeat(500)}`,
  }));
}

describe('ContextEngine summarizer', () => {
  it('uses the summarizer to condense old messages instead of dropping them', async () => {
    const summarizer = vi.fn(async (msgs: ChatMessage[]) => `SUMMARY of ${msgs.length} messages`);
    const engine = new ContextEngine({
      budget: { modelContextTokens: 4000, modelOutputTokens: 1000, contextThreshold: 0.5, perToolChars: 2000, maxToolResultChars: 8000, maxTurns: 12 },
      summarizer,
    });
    const result = await engine.build(longMessages(50));
    expect(summarizer).toHaveBeenCalled();
    const hasSummary = result.messages.some((m) => m.content.includes('SUMMARY'));
    expect(hasSummary).toBe(true);
  });

  it('drops messages when no summarizer is provided', async () => {
    const engine = new ContextEngine({
      budget: { modelContextTokens: 4000, modelOutputTokens: 1000, contextThreshold: 0.5, perToolChars: 2000, maxToolResultChars: 8000, maxTurns: 12 },
    });
    const result = await engine.build(longMessages(50));
    expect(result.compressed).toBe(true);
    expect(result.messages.length).toBeLessThan(50);
  });

  it('uses a truthful conservative fallback when semantic summarization fails', async () => {
    const engine = new ContextEngine({
      budget: { modelContextTokens: 4000, modelOutputTokens: 1000, contextThreshold: 0.5, perToolChars: 2000, maxToolResultChars: 8000, maxTurns: 12 },
      summarizer: async () => { throw new Error('provider unavailable'); },
    });

    const result = await engine.build(longMessages(50));

    expect(result.compression.strategy).toBe('conservative_truncation');
    expect(result.compression.fallbackReason).toBe('summarizer_failed');
    expect(result.messages.every((message) => !message.content.includes('[Autocompact:'))).toBe(true);
    expect(result.finalChars).toBeLessThanOrEqual(result.maxChars);
  });

  it('fits six oversized non-tool messages instead of returning an over-budget context', async () => {
    const engine = new ContextEngine({
      budget: { modelContextTokens: 1000, modelOutputTokens: 500, contextThreshold: 0.5, perToolChars: 2000, maxToolResultChars: 8000, maxTurns: 12 },
    });
    const messages = Array.from({ length: 6 }, (_, index) => ({
      role: 'user' as const,
      content: `critical-${index}:${'x'.repeat(800)}`,
    }));

    const result = await engine.build(messages);

    expect(result.compression.strategy).toBe('conservative_truncation');
    expect(result.compression.fallbackReason).toBe('no_summarizer');
    expect(result.finalChars).toBeLessThanOrEqual(result.maxChars);
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it('reserves model output tokens before calculating the usable input budget', async () => {
    const engine = new ContextEngine({
      budget: { modelContextTokens: 1000, modelOutputTokens: 500, contextThreshold: 1, perToolChars: 2000, maxToolResultChars: 8000, maxTurns: 12 },
    });

    const result = await engine.build([{ role: 'user', content: 'short prompt' }]);

    expect(result.reservedOutputTokens).toBe(500);
    expect(result.maxChars).toBe(2000);
  });
});
