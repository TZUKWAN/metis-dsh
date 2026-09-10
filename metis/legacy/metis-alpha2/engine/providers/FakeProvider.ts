/**
 * Fake provider for testing.
 *
 * Ported from metis/providers/fake.py.
 */

import { BaseProvider } from './BaseProvider.js';
import type {
  ChatMessage,
  NormalizedResponse,
  ProviderCapabilities,
  StreamChunk,
  ToolSpec,
} from '../core/types.js';

export interface FakeProviderOptions {
  response?: string;
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown>; id: string }>;
  streamChunks?: string[];
  delayMs?: number;
  model?: string;
}

export class FakeProvider extends BaseProvider {
  private readonly options: Required<Pick<FakeProviderOptions, 'response' | 'delayMs' | 'model'>> & {
    toolCalls: NonNullable<FakeProviderOptions['toolCalls']>;
    streamChunks: NonNullable<FakeProviderOptions['streamChunks']>;
  };

  constructor(options: FakeProviderOptions = {}) {
    super();
    this.options = {
      response: options.response ?? 'Hello from fake provider',
      toolCalls: options.toolCalls ?? [],
      streamChunks: options.streamChunks ?? [],
      delayMs: options.delayMs ?? 0,
      model: options.model ?? 'fake-model',
    };
  }

  capabilities(): ProviderCapabilities {
    return {
      providerType: 'FakeProvider',
      model: this.options.model,
      nativeToolCalling: true,
      jsonSchemaOutput: false,
      streaming: true,
      thinking: false,
      maxContextTokens: 128000,
      maxOutputTokens: 4096,
      retryableStatusCodes: [],
    };
  }

  async complete(
    messages: ChatMessage[],
    tools?: ToolSpec[],
    params?: Record<string, unknown>,
  ): Promise<NormalizedResponse> {
    void messages; void tools; void params;
    if (this.options.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.options.delayMs));
    }
    return {
      content: this.options.response,
      toolCalls: this.options.toolCalls.map((tc) => ({
        name: tc.name,
        arguments: tc.arguments,
        id: tc.id,
      })),
      finishReason: this.options.toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    };
  }

  async *completeStream(
    messages: ChatMessage[],
    tools?: ToolSpec[],
    params?: Record<string, unknown>,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    void messages; void tools; void params;
    const chunks =
      this.options.streamChunks.length > 0
        ? this.options.streamChunks
        : this.options.response.split(' ');

    for (let i = 0; i < chunks.length; i++) {
      if (this.options.delayMs > 0) {
        await new Promise((r) => setTimeout(r, this.options.delayMs));
      }
      const chunk = chunks[i];
      if (chunk === undefined) continue;
      yield {
        content: i < chunks.length - 1 ? chunk + ' ' : chunk,
        isFinished: i === chunks.length - 1,
        usage:
          i === chunks.length - 1
            ? { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
            : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    }

    // Mirror the real SSE streamer: tool calls arrive in a final chunk after the
    // text stream, so streaming consumers see the same tool calls as complete().
    if (this.options.toolCalls.length > 0) {
      yield {
        content: '',
        toolCalls: this.options.toolCalls.map((tc) => ({
          name: tc.name,
          arguments: tc.arguments,
          id: tc.id,
        })),
        isFinished: true,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      };
    }
  }
}
