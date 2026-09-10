/**
 * Context engine — builds the final message list within token budget.
 *
 * Ported from metis/context/engine.py.
 */

import { CONTEXT_CHARS_PER_TOKEN } from '../core/Config.js';
import type { BudgetConfig, ChatMessage } from '../core/types.js';
import { estimateMessagesTokens, estimateToolSchemaTokens } from './TokenEstimator.js';
import { compressMessages } from './Compressor.js';

export interface ContextBuildResult {
  messages: ChatMessage[];
  compressed: boolean;
  originalChars: number;
  finalChars: number;
  maxChars: number;
  summary: string;
  originalTokens: number;
  finalTokens: number;
  toolSchemaTokens: number;
  reservedOutputTokens: number;
  compression: {
    strategy: 'none' | 'tool_result_truncation' | 'semantic_summary' | 'conservative_truncation';
    summarized: boolean;
    summarySource?: { firstMessageIndex: number; lastMessageIndex: number; messageCount: number; originalChars: number };
    fallbackReason?: 'no_summarizer' | 'summarizer_failed' | 'summary_too_large';
  };
}

export class ContextEngine {
  private readonly budget: BudgetConfig;
  private readonly charsPerToken: number;
  private readonly overrideMaxContextTokens?: number;
  private readonly summarizer?: (msgs: ChatMessage[]) => Promise<string>;

  constructor(options: {
    budget: BudgetConfig;
    charsPerToken?: number;
    overrideMaxContextTokens?: number;
    summarizer?: (msgs: ChatMessage[]) => Promise<string>;
  }) {
    this.budget = options.budget;
    this.charsPerToken = options.charsPerToken ?? CONTEXT_CHARS_PER_TOKEN;
    this.overrideMaxContextTokens = options.overrideMaxContextTokens;
    this.summarizer = options.summarizer;
  }

  get maxContextTokens(): number {
    return this.overrideMaxContextTokens ?? this.budget.modelContextTokens;
  }

  get maxChars(): number {
    return this.maxCharsAtThreshold(this.budget.contextThreshold);
  }

  /** Expose budget for context overflow recovery. */
  get config(): BudgetConfig {
    return this.budget;
  }

  /**
   * Build the final message list within budget.
   * 1. Calculate tool schema token cost
   * 2. Subtract from total budget
   * 3. If messages exceed remaining budget, compress
   */
  async build(
    messages: ChatMessage[],
    toolSchemas?: object[],
    options?: { contextThreshold?: number },
  ): Promise<ContextBuildResult> {
    const toolSchemaTokens = toolSchemas ? estimateToolSchemaTokens(toolSchemas) : 0;
    const toolSchemaChars = toolSchemaTokens * this.charsPerToken;
    const threshold = options?.contextThreshold ?? this.budget.contextThreshold;

    const maxChars = Math.max(1000, this.maxCharsAtThreshold(threshold) - toolSchemaChars);
    const originalChars = countChars(messages);
    const originalTokens = estimateMessagesTokens(messages);

    const compression = await compressMessages(messages, maxChars, this.summarizer);

    const finalTokens = estimateMessagesTokens(compression.messages);

    return {
      messages: compression.messages,
      compressed: compression.compressed,
      originalChars,
      finalChars: compression.finalChars,
      maxChars,
      summary: compression.compressed
        ? `Compressed ${originalChars} → ${compression.finalChars} chars`
        : 'No compression needed',
      originalTokens,
      finalTokens,
      toolSchemaTokens,
      reservedOutputTokens: Math.max(0, this.budget.modelOutputTokens),
      compression: {
        strategy: compression.strategy,
        summarized: compression.summarized,
        ...(compression.summarySource ? { summarySource: compression.summarySource } : {}),
        ...(compression.fallbackReason ? { fallbackReason: compression.fallbackReason } : {}),
      },
    };
  }

  private maxCharsAtThreshold(threshold: number): number {
    // Provider context must reserve room for the final model output. Without
    // this subtraction a request can appear under budget yet still overflow as
    // soon as the provider reserves completion tokens.
    const usableInputTokens = Math.max(1, this.maxContextTokens - Math.max(0, this.budget.modelOutputTokens));
    return Math.floor(usableInputTokens * this.charsPerToken * threshold);
  }
}

function countChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, msg) => sum + (msg.content?.length ?? 0), 0);
}
