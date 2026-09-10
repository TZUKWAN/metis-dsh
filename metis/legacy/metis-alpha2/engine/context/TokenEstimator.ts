/**
 * Token estimation for LLM context budgeting.
 *
 * Ported from metis/context/tokenizer.py.
 * Uses heuristic estimation with CJK awareness.
 */

import { CONTEXT_CHARS_PER_TOKEN } from '../core/Config.js';
import type { ChatMessage } from '../core/types.js';

// CJK Unified Ideographs ranges
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g;

/**
 * Estimate token count for a text string.
 * CJK characters are denser (~1.5 chars/token) vs ASCII (~4 chars/token).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  const cjkMatches = text.match(CJK_REGEX);
  const cjkCount = cjkMatches?.length ?? 0;
  const asciiCount = text.length - cjkCount;

  const asciiTokens = Math.ceil(asciiCount / CONTEXT_CHARS_PER_TOKEN);
  const cjkTokens = Math.ceil(cjkCount / 1.5);

  return asciiTokens + cjkTokens;
}

/**
 * Estimate total token count for a list of chat messages.
 * Includes role overhead (~4 tokens per message).
 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    // Role overhead: ~4 tokens per message
    total += 4;
    // Content
    if (msg.content) {
      total += estimateTokens(msg.content);
    }
    // Tool calls
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        total += estimateTokens(tc.name);
        total += estimateTokens(JSON.stringify(tc.arguments));
      }
    }
  }
  return total;
}

/**
 * Estimate token cost of tool JSON schemas.
 */
export function estimateToolSchemaTokens(schemas: object[]): number {
  if (!schemas.length) return 0;
  const json = JSON.stringify(schemas);
  return estimateTokens(json);
}
