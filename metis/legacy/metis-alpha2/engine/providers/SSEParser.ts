/**
 * SSE (Server-Sent Events) stream parser for OpenAI-compatible APIs.
 *
 * Ported from metis/providers/parsers/openai_native.py + metis/providers/openai_compat.py SSE logic.
 *
 * Design goals:
 * - Parse SSE streams from any OpenAI-compatible API (OpenAI, GLM, Kimi, DeepSeek, etc.)
 * - Handle chunked transfer encoding
 * - Emit structured StreamChunk objects
 * - Support tool_calls in streaming responses
 * - Handle reasoning/thinking content
 */

import { ProviderStreamError } from './BaseProvider.js';
import type { StreamChunk, ToolCall, ProviderUsage } from '../core/types.js';

// ─── SSE Line Parser ──────────────────────────────────────────

/**
 * Parse raw SSE text into individual event data strings.
 * Handles: "data: ...\n\n", "data: [DONE]\n\n", comments, etc.
 */
export function* parseSSELines(rawText: string): Generator<string, void, unknown> {
  let buffer = '';

  for (const char of rawText) {
    buffer += char;
    if (buffer.endsWith('\n\n') || buffer.endsWith('\r\n\r\n')) {
      const event = buffer;
      buffer = '';

      for (const line of event.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;
          yield data;
        }
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    for (const line of buffer.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        yield data;
      }
    }
  }
}

// ─── Streaming Tool Call Accumulator ──────────────────────────

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
  index: number;
}

/**
 * Accumulates streaming tool call fragments into complete ToolCall objects.
 */
export class ToolCallAccumulator {
  private readonly tools = new Map<number, AccumulatedToolCall>();

  feed(chunk: { index: number; id?: string; function?: { name?: string; arguments?: string } }): void {
    const existing = this.tools.get(chunk.index);
    if (existing) {
      if (chunk.function?.name) existing.name += chunk.function.name;
      if (chunk.function?.arguments) existing.arguments += chunk.function.arguments;
    } else {
      this.tools.set(chunk.index, {
        id: chunk.id ?? '',
        name: chunk.function?.name ?? '',
        arguments: chunk.function?.arguments ?? '',
        index: chunk.index,
      });
    }
  }

  getComplete(): ToolCall[] {
    return [...this.tools.values()]
      .filter((t) => t.name && t.arguments)
      .map((t) => ({
        name: t.name,
        arguments: safeParseJSON(t.arguments) ?? {},
        id: t.id,
      }));
  }
}

// ─── OpenAI Streaming Response Parser ─────────────────────────

export interface OpenAIStreamDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

export interface OpenAIStreamChunk {
  id: string;
  object: string;
  choices: Array<{
    index: number;
    delta: OpenAIStreamDelta;
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Parse a single OpenAI-format SSE chunk JSON into our StreamChunk type.
 */
export function parseOpenAIChunk(json: string): StreamChunk | null {
  const parsed: OpenAIStreamChunk = JSON.parse(json);
  const choice = parsed.choices?.[0];
  if (!choice) return null;

  const delta = choice.delta;
  const content = delta?.content ?? '';
  const reasoning = delta?.reasoning_content;
  const toolCalls = delta?.tool_calls;

  const usage: ProviderUsage = parsed.usage
    ? {
        promptTokens: parsed.usage.prompt_tokens,
        completionTokens: parsed.usage.completion_tokens,
        totalTokens: parsed.usage.total_tokens,
      }
    : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  return {
    content,
    reasoning,
    toolCalls: toolCalls?.map((tc) => ({
      name: tc.function?.name ?? '',
      arguments: safeParseJSON(tc.function?.arguments ?? '') ?? {},
      id: tc.id ?? '',
    })),
    isFinished: choice.finish_reason !== null && choice.finish_reason !== undefined,
    usage,
  };
}

// ─── Response Streamer ────────────────────────────────────────

/**
 * 死流看门狗（2026-08-24 实证缺陷）：服务端可能保持 SSE 连接开着却长期不再
 * 发送任何字节（网关假死）。绝对超时（30 分钟）兜底之外，活跃生成每隔几秒
 * 必有 token；连续 5 分钟零字节即判定死流，中止读取并抛 interrupted，让上层
 * 走重试/换路，而不是把「正在生成」永远挂在 UI 上。只掐死流，不掐慢流。
 */
export const SSE_IDLE_TIMEOUT_MS = 300_000;

/**
 * Stream an OpenAI-compatible chat completion response.
 * Yields StreamChunks as they arrive.
 */
export async function* streamOpenAIResponse(
  response: Response,
  idleTimeoutMs: number = SSE_IDLE_TIMEOUT_MS,
): AsyncGenerator<StreamChunk, void, unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderStreamError('Response body is not readable', 'interrupted');

  const decoder = new TextDecoder();
  const accumulator = new ToolCallAccumulator();
  let totalUsage: ProviderUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let sawDone = false;
  let sawFinishedChunk = false;

  try {
    let buffer = '';

    while (true) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          idleTimer = setTimeout(() => {
            void reader.cancel().catch(() => undefined);
            reject(new ProviderStreamError(`Provider SSE stream idle for ${Math.round(idleTimeoutMs / 1000)}s without any bytes`, 'interrupted'));
          }, idleTimeoutMs);
          // Node 环境下不让看门狗计时器阻止进程退出。
          (idleTimer as unknown as { unref?: () => void }).unref?.();
        }),
      ]).finally(() => { if (idleTimer !== undefined) clearTimeout(idleTimer); });
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events from buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';  // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          sawDone = true;
          // Emit the accumulated tool calls if the stream did not already emit
          // a finished choice. This makes a bare [DONE] a valid empty answer,
          // while still preserving the exact final tool-call payload.
          const finalTools = accumulator.getComplete();
          if (finalTools.length > 0 || !sawFinishedChunk) {
            yield {
              content: '',
              ...(finalTools.length > 0 ? { toolCalls: finalTools } : {}),
              isFinished: true,
              usage: totalUsage,
            };
          }
          return;
        }

        try {
          const rawParsed = JSON.parse(data);
          const rawChoice = rawParsed.choices && rawParsed.choices[0];

          if (rawChoice && rawChoice.delta && rawChoice.delta.tool_calls) {
            for (const tc of rawChoice.delta.tool_calls) {
              accumulator.feed({
                index: tc.index,
                id: tc.id,
                function: { name: tc.function ? tc.function.name : undefined, arguments: tc.function ? tc.function.arguments : undefined },
              });
            }
          }

          const chunk = parseOpenAIChunk(data);
          if (!chunk) continue;

          if (chunk.usage.totalTokens > 0) {
            totalUsage = chunk.usage;
          }
          sawFinishedChunk ||= chunk.isFinished;

          yield chunk;
        } catch {
          // Skip malformed chunks
        }
      }
    }

    if (!sawDone) {
      // 部分本地网关（如 Codex 代理）在 finish_reason:"stop" + usage 后直接
      // 关闭连接，不发 [DONE] 哨兵帧。只要已经收到过 finished choice，回答
      // 就是完整的；只有真正半途而废的流才判为 interrupted。
      if (sawFinishedChunk) {
        const finalTools = accumulator.getComplete();
        if (finalTools.length > 0) {
          yield {
            content: '',
            toolCalls: finalTools,
            isFinished: true,
            usage: totalUsage,
          };
        }
        return;
      }
      throw new ProviderStreamError('Provider SSE stream ended before [DONE]', 'interrupted');
    }
  } catch (error) {
    if (error instanceof ProviderStreamError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderStreamError(`Provider SSE stream interrupted: ${message}`, 'interrupted');
  } finally {
    reader.releaseLock();
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function safeParseJSON(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}
