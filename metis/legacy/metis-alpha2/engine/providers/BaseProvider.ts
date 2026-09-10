/**
 * Abstract base class for LLM providers.
 *
 * Ported from metis/providers/base.py.
 */

import type {
  ChatMessage,
  NormalizedResponse,
  ProviderCapabilities,
  StreamChunk,
  ToolSpec,
} from '../core/types.js';

/**
 * A provider stream could not produce one complete SSE response.
 *
 * Request failures happen before stream data is accepted and may be retried by
 * the provider. Once a stream has started, there is no cursor continuation
 * contract, so the interrupted stream must never be presented as a transparent
 * resume by AgentLoop.
 */
export class ProviderStreamError extends Error {
  readonly phase: 'request' | 'interrupted';

  constructor(message: string, phase: 'request' | 'interrupted') {
    super(message);
    this.name = 'ProviderStreamError';
    this.phase = phase;
  }
}

/**
 * Detect a deterministic provider-side context-window rejection (the HTTP 400
 * "context length exceeded" family).
 *
 * These rejections are not transient: re-sending the same payload cannot
 * succeed. They must bypass transport-level retries and reach the AgentLoop's
 * dedicated overflow-recovery path (recompression + retry) immediately.
 */
export function isContextOverflowMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('context length')
    || lower.includes('maximum context')
    || lower.includes('context_length_exceeded')
    || lower.includes('context window');
}

export abstract class BaseProvider {
  /** Return this provider's capabilities. */
  abstract capabilities(): ProviderCapabilities;

  /** Non-streaming completion. */
  abstract complete(
    messages: ChatMessage[],
    tools?: ToolSpec[],
    params?: Record<string, unknown>,
  ): Promise<NormalizedResponse>;

  /** Streaming completion. Yields chunks as they arrive. */
  abstract completeStream(
    messages: ChatMessage[],
    tools?: ToolSpec[],
    params?: Record<string, unknown>,
  ): AsyncGenerator<StreamChunk, void, unknown>;

  /** Lightweight health check. */
  async healthCheck(): Promise<Record<string, unknown>> {
    return { status: 'unknown' };
  }

  /** Clean up resources (HTTP clients, etc). */
  async close(): Promise<void> {
    // no-op by default
  }
}
