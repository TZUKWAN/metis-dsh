/**
 * Message compression for context budget management.
 *
 * Supports two strategies:
 *   1. Truncation + dropping (fast, no LLM call) — default
 *   2. LLM summarization (slower, preserves semantics) — for small-context models
 *
 * Ported from metis/context/compressor.py.
 */

import { COMPRESS_PREVIEW_CHARS } from '../core/Config.js';
import type { ChatMessage } from '../core/types.js';

export interface CompressionResult {
  messages: ChatMessage[];
  compressed: boolean;
  originalChars: number;
  finalChars: number;
  /** Whether LLM summarization was used (vs truncation) */
  summarized: boolean;
  /** The truthful strategy used to make this provider request fit. */
  strategy: 'none' | 'tool_result_truncation' | 'semantic_summary' | 'conservative_truncation';
  /** Original message range condensed into the semantic summary, when one exists. */
  summarySource?: { firstMessageIndex: number; lastMessageIndex: number; messageCount: number; originalChars: number };
  /** Why semantic summarization was unavailable; never represented as a fake summary message. */
  fallbackReason?: 'no_summarizer' | 'summarizer_failed' | 'summary_too_large';
}

/**
 * Compress messages to fit within a character budget.
 *
 * @param messages - Full message history
 * @param maxChars - Character budget
 * @param summarizer - Optional LLM summarizer function. If provided,
 *   old non-system messages are summarized instead of being dropped.
 */
export async function compressMessages(
  messages: ChatMessage[],
  maxChars: number,
  summarizer?: (msgs: ChatMessage[]) => Promise<string>,
): Promise<CompressionResult> {
  const originalChars = countChars(messages);
  if (originalChars <= maxChars) {
    return { messages, compressed: false, originalChars, finalChars: originalChars, summarized: false, strategy: 'none' };
  }

  // Step 1: Truncate large tool results
  let compressed = messages.map((msg) => truncateToolResult(msg));

  let finalChars = countChars(compressed);
  if (finalChars <= maxChars) {
    return {
      messages: compressed, compressed: true, originalChars, finalChars, summarized: false,
      strategy: 'tool_result_truncation',
    };
  }

  // Step 2: Semantic summary. A failed summarizer must not inject pretend
  // content; the catch below keeps a bounded, explicitly degraded source set.
  if (summarizer) {
    try {
      const result = await summarizeOldMessages(compressed, summarizer);
      const fitted = fitConservatively(result.messages, maxChars);
      return {
        messages: fitted,
        compressed: true,
        originalChars,
        finalChars: countChars(fitted),
        summarized: true,
        strategy: 'semantic_summary',
        summarySource: result.source,
        ...(countChars(result.messages) > maxChars ? { fallbackReason: 'summary_too_large' as const } : {}),
      };
    } catch {
      const fitted = fitConservatively(compressed, maxChars);
      return {
        messages: fitted,
        compressed: true,
        originalChars,
        finalChars: countChars(fitted),
        summarized: false,
        strategy: 'conservative_truncation',
        fallbackReason: 'summarizer_failed',
      };
    }
  }

  // Step 3: No summarizer. Keep system/checkpoint/artifact markers plus the
  // newest messages, then truthfully truncate content until it fits.
  compressed = fitConservatively(compressed, maxChars);
  finalChars = countChars(compressed);
  return {
    messages: compressed,
    compressed: true,
    originalChars,
    finalChars,
    summarized: false,
    strategy: 'conservative_truncation',
    fallbackReason: 'no_summarizer',
  };
}

/**
 * Summarize old messages by calling the LLM summarizer and merging
 * the result into a single system-level summary message, then keeping
 * recent messages intact.
 *
 * Strategy:
 *   - Split messages into "old" (first 50%) and "recent" (last 50%)
 *   - Call summarizer on old messages to produce a condensed summary
 *   - Replace old messages with a single system message containing the summary
 *   - Keep recent messages intact
 */
async function summarizeOldMessages(
  _messages: ChatMessage[],
  _summarizer: (msgs: ChatMessage[]) => Promise<string>,
): Promise<{ messages: ChatMessage[]; source: NonNullable<CompressionResult['summarySource']> }> {
  const systemMessages = _messages.filter((m) => m.role === 'system');
  const nonSystem = _messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role !== 'system');

  if (nonSystem.length <= 6) {
    throw new Error('Not enough non-system messages for semantic summary');
  }

  const splitPoint = Math.floor(nonSystem.length * 0.5);
  const oldEntries = nonSystem.slice(0, splitPoint);
  const oldMessages = oldEntries.map(({ message }) => message);
  const recentMessages = nonSystem.slice(splitPoint).map(({ message }) => message);

  const summaryContent = (await _summarizer(oldMessages)).trim();
  if (!summaryContent) throw new Error('Summarizer returned an empty summary');

  const summaryMessage: ChatMessage = {
    role: 'system',
    content: summaryContent,
    metadata: {
      contextCompressionSummary: true,
      summarizedCount: oldMessages.length,
      originalChars: countChars(oldMessages),
      sourceFirstMessageIndex: oldEntries[0]?.index ?? 0,
      sourceLastMessageIndex: oldEntries.at(-1)?.index ?? 0,
    },
  };

  return {
    messages: [...systemMessages, summaryMessage, ...recentMessages],
    source: {
      firstMessageIndex: oldEntries[0]?.index ?? 0,
      lastMessageIndex: oldEntries.at(-1)?.index ?? 0,
      messageCount: oldMessages.length,
      originalChars: countChars(oldMessages),
    },
  };
}

/** Keep only a bounded, auditable subset when semantic compression is unavailable. */
function fitConservatively(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  const retained = new Set<number>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message && isPinned(message)) retained.add(index);
  }

  let retainedChars = Array.from(retained).reduce((total, index) => total + (messages[index]?.content.length ?? 0), 0);
  for (let index = messages.length - 1; index >= 0; index--) {
    if (retained.has(index)) continue;
    const message = messages[index];
    if (!message) continue;
    if (retainedChars + message.content.length <= maxChars || retained.size === 0) {
      retained.add(index);
      retainedChars += message.content.length;
    }
  }

  const selected = messages.filter((_, index) => retained.has(index)).map((message) => ({ ...message }));
  return trimToBudget(selected, maxChars);
}

function isPinned(message: ChatMessage): boolean {
  if (message.role === 'system') return true;
  const metadata = message.metadata ?? {};
  return metadata.contextPin === true
    || metadata.goalCheckpoint === true
    || typeof metadata.artifactId === 'string'
    || metadata.contextCompressionSummary === true;
}

/** Last-resort character trimming; it labels lost source text as truncation, never as a summary. */
function trimToBudget(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  const result = messages.map((message) => ({ ...message }));
  let total = countChars(result);
  for (let index = 0; index < result.length && total > maxChars; index++) {
    const message = result[index];
    if (!message?.content) continue;
    const originalLength = message.content.length;
    const excess = total - maxChars;
    const marker = `\n… [truncated ${Math.min(originalLength, excess)} chars to fit context budget]`;
    const keep = Math.max(0, originalLength - excess - marker.length);
    const content = keep > 0 ? `${message.content.slice(0, keep)}${marker}` : '';
    result[index] = { ...message, content };
    total = countChars(result);
  }
  return result;
}

// ─── Helpers ──────────────────────────────────────────────────

function countChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, msg) => sum + (msg.content?.length ?? 0), 0);
}

/**
 * Compute semantic importance score for a message (0-1).
 * Higher score = more important, lower = more drop-able.
 *
 * Scoring factors:
 *   - Role weight: user(1.0) > assistant(0.8) > system(0.6) > tool(0.4)
 *   - Recency bonus: messages in last 25% of list get +0.2
 *   - Content markers: +0.15 for research questions, findings, decisions, errors
 *   - Penalty: very long tool results (-0.1), very short messages (-0.05)
 */
export function scoreMessageImportance(
  msg: ChatMessage,
  index: number,
  total: number,
): number {
  let score: number;

  // Role-based base score
  switch (msg.role) {
    case 'user': score = 1.0; break;
    case 'assistant': score = 0.8; break;
    case 'system': score = 0.6; break;
    default: score = 0.4; break; // tool
  }

  // Recency bonus (later messages more important)
  if (index > total * 0.75) score += 0.2;
  else if (index > total * 0.5) score += 0.1;

  // Content signal boost (key semantic markers)
  const content = msg.content?.toLowerCase() ?? '';
  const signals = [
    'research question', 'hypothesis', 'finding', 'conclusion',
    'methodology', 'result', 'key insight', 'important',
    'error:', 'failed:', 'decision:', 'next step',
  ];
  const signalCount = signals.filter((s) => content.includes(s)).length;
  if (signalCount > 0) score += Math.min(0.15, signalCount * 0.05);

  // Penalties
  if (msg.role === 'tool' && content.length > 2000) score -= 0.1;
  if (content.length < 10) score -= 0.05;

  return Math.max(0, Math.min(1.0, score));
}

function truncateToolResult(msg: ChatMessage): ChatMessage {
  if (msg.role !== 'tool' || !msg.content) return msg;
  if (msg.content.length <= COMPRESS_PREVIEW_CHARS) return msg;

  const truncated = msg.content.slice(0, COMPRESS_PREVIEW_CHARS) +
    `\n... [truncated ${msg.content.length - COMPRESS_PREVIEW_CHARS} chars]`;

  return { ...msg, content: truncated };
}
