/**
 * OpenAI-compatible chat completions provider.
 *
 * Ported from metis/providers/openai_compat.py.
 * Supports: OpenAI, GLM, Kimi, DeepSeek, any OpenAI-compatible API.
 */

import { BaseProvider, isContextOverflowMessage, ProviderStreamError } from './BaseProvider.js';
import { fetch } from 'undici';
import { streamOpenAIResponse } from './SSEParser.js';
import {
  DEFAULT_MODEL,
  DEFAULT_TEMPERATURE,
  MAX_TIMEOUT_MS,
} from '../core/Config.js';
import { getRateLimiter } from '../core/RateLimiter.js';
import { parseTextToolCall } from '../tools/TextToolProtocol.js';
import type {
  ChatMessage,
  NormalizedResponse,
  ProviderCapabilities,
  StreamChunk,
  ToolSpec,
  ToolCall,
  ProviderUsage,
} from '../core/types.js';

export interface OpenAICompatProviderConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
  timeout?: number;
  maxRetries?: number;
  retryBackoffSeconds?: number;
  /** User-declared multimodal support (gates inline image content). */
  vision?: boolean;
}

interface OpenAIMessage {
  role: string;
  content: string | null | Array<{
    type: 'text' | 'image_url';
    text?: string;
    image_url?: { url: string };
  }>;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ─── Known Model Capabilities ─────────────────────────────────

const MODEL_CAPS: Record<string, Partial<ProviderCapabilities>> = {
  // Large / flagship models
  'gpt-4o': { maxContextTokens: 128000, maxOutputTokens: 16384, nativeToolCalling: true, streaming: true, thinking: false },
  'gpt-4o-mini': { maxContextTokens: 128000, maxOutputTokens: 16384, nativeToolCalling: true, streaming: true, thinking: false },
  'gpt-4': { maxContextTokens: 8192, maxOutputTokens: 8192, nativeToolCalling: true, streaming: true, thinking: false },
  // GPT-5 family (incl. codex-style relays serving gpt-5.x under custom names):
  // these models only honour native function calling — the text tool protocol
  // makes them report "no tools available" even when the prompt lists them.
  'gpt-5.6': { maxContextTokens: 272_000, maxOutputTokens: 16_384, nativeToolCalling: true, streaming: true, thinking: false },
  'gpt-5.5': { maxContextTokens: 272_000, maxOutputTokens: 16_384, nativeToolCalling: true, streaming: true, thinking: false },
  'gpt-5': { maxContextTokens: 272_000, maxOutputTokens: 16_384, nativeToolCalling: true, streaming: true, thinking: false },
  'gpt-4.1': { maxContextTokens: 1_000_000, maxOutputTokens: 32_768, nativeToolCalling: true, streaming: true, thinking: false },
  // GLM series — native priority support
  'glm-4': { maxContextTokens: 128000, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: false },
  'glm-4.5': { maxContextTokens: 128000, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: true },
  'glm-4.7': { maxContextTokens: 128000, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: true },
  'glm-4.9': { maxContextTokens: 128000, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: true },
  'glm-4.7-flash': { maxContextTokens: 200000, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: false, maxConcurrency: 2 },
  'deepseek-chat': { maxContextTokens: 64000, maxOutputTokens: 8192, nativeToolCalling: true, streaming: true, thinking: false },
  'deepseek-reasoner': { maxContextTokens: 64000, maxOutputTokens: 8192, nativeToolCalling: false, streaming: true, thinking: true },
  'claude-3-5-sonnet': { maxContextTokens: 200000, maxOutputTokens: 8192, nativeToolCalling: true, streaming: true, thinking: false },
  'claude-3-5-haiku': { maxContextTokens: 200000, maxOutputTokens: 8192, nativeToolCalling: true, streaming: true, thinking: false },
  // Qwen3.5 / Qwen3.6 series — these are thinking models (reasoning_content).
  // Some OpenAI-compatible gateways reject the native `tools` field for these
  // models with HTTP 400; the text tool protocol (injectToolPrompt) is the
  // reliable path. enable_thinking defaults off for stability + token budget.
  'qwen3.5': { maxContextTokens: 128000, maxOutputTokens: 16384, nativeToolCalling: false, streaming: true, thinking: true },
  'qwen3.5-122b-a10b': { maxContextTokens: 128000, maxOutputTokens: 16384, nativeToolCalling: false, streaming: true, thinking: true },
  'qwen3.5-35b-a3b': { maxContextTokens: 128000, maxOutputTokens: 16384, nativeToolCalling: false, streaming: true, thinking: true },
  'qwen3.5-27b': { maxContextTokens: 128000, maxOutputTokens: 16384, nativeToolCalling: false, streaming: true, thinking: true },
  'qwen3-30b-a3b': { maxContextTokens: 128000, maxOutputTokens: 16384, nativeToolCalling: false, streaming: true, thinking: true },
  'qwen3.6': { maxContextTokens: 128000, maxOutputTokens: 16384, nativeToolCalling: false, streaming: true, thinking: true },
  // Small / lightweight models (7B-14B class)
  'qwen2.5-14b': { maxContextTokens: 32768, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: false },
  'qwen2.5-7b': { maxContextTokens: 32768, maxOutputTokens: 2048, nativeToolCalling: true, streaming: true, thinking: false },
  'qwen2.5-3b': { maxContextTokens: 32768, maxOutputTokens: 2048, nativeToolCalling: false, streaming: true, thinking: false },
  'llama3.1-8b': { maxContextTokens: 8192, maxOutputTokens: 2048, nativeToolCalling: false, streaming: true, thinking: false },
  'llama3.1-70b': { maxContextTokens: 32768, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: false },
  'llama3.2-3b': { maxContextTokens: 4096, maxOutputTokens: 2048, nativeToolCalling: false, streaming: true, thinking: false },
  'mistral-7b': { maxContextTokens: 8192, maxOutputTokens: 2048, nativeToolCalling: false, streaming: true, thinking: false },
  'mixtral-8x7b': { maxContextTokens: 32768, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: false },
  'gemma2-9b': { maxContextTokens: 8192, maxOutputTokens: 2048, nativeToolCalling: false, streaming: true, thinking: false },
  'gemma2-27b': { maxContextTokens: 8192, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: false },
  'phi-3-mini': { maxContextTokens: 4096, maxOutputTokens: 2048, nativeToolCalling: false, streaming: true, thinking: false },
  'phi-3-small': { maxContextTokens: 8192, maxOutputTokens: 2048, nativeToolCalling: false, streaming: true, thinking: false },
  'phi-4': { maxContextTokens: 16384, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: false },
  'yi-1.5-9b': { maxContextTokens: 4096, maxOutputTokens: 2048, nativeToolCalling: false, streaming: true, thinking: false },
  'command-r': { maxContextTokens: 32768, maxOutputTokens: 4096, nativeToolCalling: true, streaming: true, thinking: false },
};

// 传输层重试的退避上限（秒）：指数退避在重试预算增大后必须封顶。
const MAX_RETRY_BACKOFF_SECONDS = 8;
// 确定性 400 的响应体特征：模型名不存在/无效等配置错误，重试不可能成功。
const DETERMINISTIC_REQUEST_ERROR = /no endpoints found|not a valid model|unknown model|invalid model|model not found|no such model/iu;

const DEFAULT_CAPS: Omit<ProviderCapabilities, 'model'> = {
  providerType: 'OpenAICompatProvider',
  nativeToolCalling: false,
  jsonSchemaOutput: false,
  streaming: true,
  thinking: false,
  maxContextTokens: 32000,
  // 未知模型的输出预算默认 16k（2026-08-22）：推理模型的思考与正文共享输出预算，
  // 旧的 4096 默认会让长任务在输出中途被截断。
  maxOutputTokens: 16_384,
  // 400 is included: some OpenAI-compatible gateways intermittently proxy
  // upstream errors (reasoning models, warm-up) as transient 400s that clear
  // on retry. Non-retryable 400s (genuine bad request) fail fast after the
  // retry budget is exhausted. Exception: deterministic context-overflow 400s
  // skip transport retries entirely (see isContextOverflowMessage) so the
  // AgentLoop recovery path owns them.
  retryableStatusCodes: [400, 429, 500, 502, 503, 504],
};

function detectCapabilities(model: string): ProviderCapabilities {
  const normalizedModel = model.toLowerCase();

  // Exact match takes priority (case-insensitive).
  for (const key of Object.keys(MODEL_CAPS)) {
    if (key.toLowerCase() === normalizedModel) {
      return { ...DEFAULT_CAPS, model, ...MODEL_CAPS[key] };
    }
  }

  // Then longest-prefix match (case-insensitive).
  const entries = Object.entries(MODEL_CAPS).sort((a, b) => b[0].length - a[0].length);
  for (const [key, caps] of entries) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedModel.startsWith(normalizedKey + '-') ||
      normalizedModel.startsWith(normalizedKey + '.')
    ) {
      return { ...DEFAULT_CAPS, model, ...caps };
    }
  }
  return { ...DEFAULT_CAPS, model };
}

// ─── Provider Implementation ──────────────────────────────────

export class OpenAICompatProvider extends BaseProvider {
  public readonly baseUrl: string;
  public readonly apiKey: string;
  public readonly model: string;
  public readonly timeout: number;
  public readonly maxRetries: number;
  public readonly retryBackoffSeconds: number;
  private readonly caps: ProviderCapabilities;
  private readonly rateLimiter: ReturnType<typeof getRateLimiter>;

  constructor(config: OpenAICompatProviderConfig) {
    super();
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODEL;
    // 单位自愈（2026-08-22 实证缺陷）：历史版本曾以「秒」写入 timeout（如 120
    // 表示 120s），而运行时按毫秒解释——120ms 的超时让每次模型调用必然中断。
    // 任何 <1000 的值不可能是合理的毫秒超时，按秒×1000 归一。
    // 默认 180s（刘总 2026-08-22 要求）：推理模型生成完整场景/长文需要分钟级窗口；
    // 显式配置仍受 MAX_TIMEOUT_MS（10 分钟）约束。
    const rawTimeout = config.timeout ?? 180_000;
    const timeoutMs = rawTimeout > 0 && rawTimeout < 1000 ? rawTimeout * 1000 : rawTimeout;
    this.timeout = Math.min(timeoutMs, MAX_TIMEOUT_MS);
    // 默认 20 次重试（刘总 2026-08-22 要求）：所有 AI 交互的传输层重试预算；
    // 仅对可重试错误生效，确定性配置错误仍立即失败。
    this.maxRetries = config.maxRetries ?? 20;
    this.retryBackoffSeconds = config.retryBackoffSeconds ?? 2;
    this.caps = {
      ...detectCapabilities(this.model),
      ...(config.vision ? { vision: true } : {}),
    };
    this.rateLimiter = getRateLimiter(this.model, this.caps.maxConcurrency ?? 2);
  }

  capabilities(): ProviderCapabilities {
    return { ...this.caps };
  }

  // ─── Non-streaming ─────────────────────────────────────────

  async complete(
    messages: ChatMessage[],
    tools?: ToolSpec[],
    params?: Record<string, unknown>,
  ): Promise<NormalizedResponse> {
    const signal = toAbortSignal(params?.signal);
    const response = await this.withRetry(() =>
      this.rateLimiter.execute(() =>
        this.callFetch('/chat/completions', this.buildRequestBody(messages, tools, params, false), signal)
      , signal),
      signal,
    );
    const json = await response.json() as Record<string, unknown>;
    return this.parseResponse(json);
  }

  // ─── Streaming ─────────────────────────────────────────────

  async *completeStream(
    messages: ChatMessage[],
    tools?: ToolSpec[],
    params?: Record<string, unknown>,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const signal = toAbortSignal(params?.signal);
    let response: Response;
    try {
      response = await this.withRetry(() =>
        this.rateLimiter.execute(() =>
          this.callFetch('/chat/completions', this.buildRequestBody(messages, tools, params, true), signal)
        , signal),
        signal,
      );
    } catch (error) {
      if (error instanceof ProviderStreamError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderStreamError(`Provider stream request failed: ${message}`, 'request');
    }

    if (!response.ok) {
      let detail: string;
      try {
        const bodyText = await response.text();
        const parsed = JSON.parse(bodyText) as { error?: { message?: string } | string; message?: string };
        const bodyMessage = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message ?? '';
        detail = String(bodyMessage).replace(/\s+/gu, ' ').slice(0, 300);
      } catch {
        detail = '';
      }
      const statusText = response.statusText || 'request failed';
      throw new Error(`Provider error ${response.status}: ${statusText}${detail ? ` - ${detail}` : ''}`);
    }

    try {
      yield* streamOpenAIResponse(response);
    } catch (error) {
      if (error instanceof ProviderStreamError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ProviderStreamError(`Provider SSE stream interrupted: ${message}`, 'interrupted');
    }
  }

  // ─── Health Check ──────────────────────────────────────────

  override async healthCheck(): Promise<Record<string, unknown>> {
    return this.rateLimiter.execute(async () => {
      try {
        const response = await fetch(`${this.baseUrl}/models`, {
          headers: this.buildHeaders(),
          signal: AbortSignal.timeout(10000),
        }) as unknown as Response;

        if (response.status === 404) {
          // Fallback: probe with a lightweight chat completion
          return this.probeHealthViaChat();
        }

        return {
          status: response.ok ? 'healthy' : 'unhealthy',
          statusCode: response.status,
          model: this.model,
        };
      } catch (err) {
        return {
          status: 'unhealthy',
          error: err instanceof Error ? err.message : String(err),
          model: this.model,
        };
      }
    });
  }

  // ─── Internals ─────────────────────────────────────────────

  private async probeHealthViaChat(): Promise<Record<string, unknown>> {
    try {
      const body = {
        model: this.model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      };
      const response = await this.callFetch('/chat/completions', body);
      return {
        status: response.ok ? 'healthy' : 'unhealthy',
        statusCode: response.status,
        model: this.model,
        fallback: 'chat_probe',
      };
    } catch (err) {
      return {
        status: 'unhealthy',
        error: err instanceof Error ? err.message : String(err),
        model: this.model,
        fallback: 'chat_probe',
      };
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private buildRequestBody(
    messages: ChatMessage[],
    tools: ToolSpec[] | undefined,
    params: Record<string, unknown> | undefined,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.formatMessages(messages),
      temperature: params?.temperature ?? DEFAULT_TEMPERATURE,
      stream,
    };

    if (tools && tools.length > 0) {
      if (this.caps.nativeToolCalling) {
        body.tools = this.formatTools(tools);
      } else {
        // Fallback: inject tool instructions into system prompt for non-native models
        console.log(`[ProviderToolProtocol] model=${this.model} native=false textInject=${tools.length}`);
        body.messages = this.injectToolPrompt(body.messages as OpenAIMessage[], tools);
      }
    }

    if (params?.max_tokens) {
      body.max_tokens = params.max_tokens;
    }

    if (params?.timeout) {
      body.timeout = params.timeout;
    }

    // GLM-specific thinking parameter (user-selectable)
    if (this.caps.thinking && params?.thinking === true) {
      body.thinking = { type: 'enabled' };
    }

    // Qwen3-style thinking models: the vLLM/serving runtime accepts an
    // `enable_thinking` flag (and chat_template_kwargs). Default OFF for
    // stability and token budget — the agent loop turns it ON explicitly via
    // params.thinking=true when deep reasoning is required (e.g. reflection).
    if (this.caps.thinking) {
      const enableThinking = params?.thinking === true;
      body.enable_thinking = enableThinking;
      body.chat_template_kwargs = { enable_thinking: enableThinking };
    }

    return body;
  }

  private formatMessages(messages: ChatMessage[]): OpenAIMessage[] {
    return messages.map((msg) => {
      const formatted: OpenAIMessage = {
        role: msg.role,
        content: msg.content,
      };

      // METIS-WX-2 vision: inline images become standard OpenAI image_url
      // content blocks (data URIs). Text + images share one message so
      // multimodal models see them together. Only when the model declares
      // vision — otherwise image content is dropped to avoid 4xx errors.
      if (msg.images && msg.images.length > 0 && this.caps.vision) {
        formatted.content = [
          { type: 'text', text: msg.content ?? '' },
          ...msg.images.map((image) => ({
            type: 'image_url' as const,
            image_url: {
              url: `data:${image.mime ?? 'image/jpeg'};base64,${image.dataBase64}`,
            },
          })),
        ];
      }

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        formatted.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments:
              typeof tc.arguments === 'string'
                ? tc.arguments
                : JSON.stringify(tc.arguments),
          },
        }));
      }

      // Embed status/code envelope for tool messages so the wire always carries
      // an un-confusable, non-user-controllable status signal.
      if (msg.role === 'tool' && msg.metadata && typeof msg.metadata === 'object') {
        const meta = msg.metadata as Record<string, unknown>;
        const status = typeof meta.status === 'string' ? meta.status : 'unknown';
        const code = typeof meta.code === 'string' ? meta.code : '';
        const envelope = code ? `[status=${status} code=${code}]` : `[status=${status}]`;
        // Prepend the envelope so it is always present and non-removable.
        formatted.content = formatted.content ? `${envelope} ${formatted.content}` : envelope;
      }

      if (msg.toolCallId) {
        formatted.tool_call_id = msg.toolCallId;
      }

      if (msg.name) {
        formatted.name = msg.name;
      }

      return formatted;
    });
  }

  private formatTools(tools: ToolSpec[]): OpenAIToolDef[] {
    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /**
   * Inject tool definitions as text into the system prompt for models
   * that do not support native function calling (thinking models, 7B-class).
   * The model is asked to emit ONE tool call as JSON; parseTextToolCall then
   * extracts it. Multi-turn tool use works because the agent loop re-prompts
   * after each tool result.
   */
  private injectToolPrompt(messages: OpenAIMessage[], tools: ToolSpec[]): OpenAIMessage[] {
    const toolDescriptions = tools.map((t) =>
      `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.parameters)}`,
    ).join('\n\n');
    const toolBlock = [
      '',
      '## Available Tools',
      '',
      'You have access to the following tools:',
      '',
      toolDescriptions,
      '',
      '## How to call a tool',
      '',
      'When you need a tool, respond with ONLY a single JSON object on one line, no prose, no code fences:',
      '',
      '{"tool": "<tool_name>", "args": {<parameter values>}}',
      '',
      'Rules:',
      '- Call AT MOST ONE tool per response. After the tool returns its result, you will be prompted again to continue.',
      '- If you can answer without a tool, answer normally in prose (no JSON).',
      '- Never wrap the JSON in markdown fences or surround it with explanation.',
      '- "args" must match the tool\'s parameter schema; omit unknown keys.',
    ].join('\n');

    const updated = [...messages];
    const sysIdx = updated.findIndex((m) => m.role === 'system');
    if (sysIdx >= 0 && updated[sysIdx]) {
      updated[sysIdx] = { ...updated[sysIdx], content: (updated[sysIdx].content ?? '') + toolBlock };
    } else {
      updated.unshift({ role: 'system', content: toolBlock });
    }
    return updated;
  }

  private parseResponse(json: Record<string, unknown>): NormalizedResponse {
    const choices = json.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) {
      throw new Error('No choices in provider response');
    }

    const message = choice.message as Record<string, unknown> | undefined;
    const refusal = message?.refusal as string | undefined;
    const messageContent = (message?.content as string) ?? '';
    const content = messageContent || refusal || '';
    const finishReason = (choice.finish_reason as string | null) ?? '';

    // Parse tool calls
    const toolCalls: ToolCall[] = [];
    const rawToolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (rawToolCalls) {
      for (const tc of rawToolCalls) {
        const fn = tc.function as Record<string, unknown> | undefined;
        if (!fn || typeof fn !== 'object') {
          toolCalls.push({
            name: '',
            arguments: {},
            id: (tc.id as string) ?? '',
          });
          continue;
        }
        const argsStr = (fn.arguments as string) ?? '{}';
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(argsStr);
        } catch {
          args = {};
        }
        toolCalls.push({
          name: (fn.name as string) ?? '',
          arguments: args,
          id: (tc.id as string) ?? '',
        });
      }
    }

    // Parse usage
    const rawUsage = json.usage as Record<string, number> | undefined;
    const usage: ProviderUsage = rawUsage
      ? {
          promptTokens: rawUsage.prompt_tokens ?? 0,
          completionTokens: rawUsage.completion_tokens ?? 0,
          totalTokens: rawUsage.total_tokens ?? 0,
        }
      : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    // Parse reasoning (for models that support thinking)
    const reasoning = (message?.reasoning_content as string) ?? undefined;

    // Text tool protocol: when the model does not support native function
    // calling, injectToolPrompt asks it to emit {"tool":"<name>","args":{...}}.
    // Parse that JSON out of the content so the agent loop sees real toolCalls.
    let finalContent = content;
    let finalToolCalls = toolCalls;
    if (toolCalls.length === 0 && !this.caps.nativeToolCalling && content) {
      const parsed = parseTextToolCall(content);
      if (parsed) {
        finalToolCalls = [parsed];
        finalContent = ''; // the content was a tool call, not prose
      }
    }

    return {
      content: finalContent,
      reasoning,
      toolCalls: finalToolCalls,
      finishReason,
      usage,
      raw: json,
    };
  }

  private async callFetch(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const requestTimeout = typeof body.timeout === 'number'
      ? Math.min(body.timeout as number, MAX_TIMEOUT_MS)
      : this.timeout;
    // Do not send timeout or the local cancellation signal to the remote API.
    const { timeout: _timeout, signal: _signal, ...bodyWithoutTimeout } = body;
    void _timeout;
    void _signal;
    const combinedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeout)])
      : AbortSignal.timeout(requestTimeout);
    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(bodyWithoutTimeout),
      signal: combinedSignal,
    }) as unknown as Response;

    if (!response.ok) {
      // 把响应体里的真实错误原因带进异常消息：既让 UI 能显示根因
      // （如"No endpoints found for ox-alpha"），也让确定性错误可被识别。
      let detail: string;
      try {
        const bodyText = await response.text();
        const parsed = JSON.parse(bodyText) as { error?: { message?: string } | string; message?: string };
        const bodyMessage = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message ?? '';
        detail = String(bodyMessage).replace(/\s+/gu, ' ').slice(0, 300);
      } catch {
        detail = '';
      }
      const statusText = response.statusText || 'request failed';
      throw new Error(`Provider error ${response.status}: ${statusText}${detail ? ` - ${detail}` : ''}`);
    }

    return response;
  }

  private async withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted');
      try {
        return await fn();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (signal?.aborted) throw lastError;

        // SSE 流中断（2026-08-22 刘总指示：要时间不要结果）：流不可原地续传，
        // 但重新发起新请求没有副作用且完全安全——纳入重试预算，而不是让
        // 一次偶发的服务端断流杀死整个编译任务。仍受 maxRetries 与退避约束。

        // A deterministic context-overflow rejection is not transient: the
        // same payload can never fit. Surface it immediately so the AgentLoop
        // overflow-recovery path (recompression + retry) owns the retry;
        // blind transport retries only hide the overflow, burn the budget,
        // and add exponential backoff latency to every recovery cycle.
        if (isContextOverflowMessage(lastError.message)) throw lastError;

        // Check if error is retryable
        const statusMatch = lastError.message.match(/Provider error (\d+)/) ?? undefined;
        const status = statusMatch?.[1] ? parseInt(statusMatch[1], 10) : 0;
        if (!this.caps.retryableStatusCodes.includes(status) && status !== 0) {
          throw lastError;
        }
        // 确定性请求错误（模型名不存在等）重试永远不会成功：立即失败并保留
        // 真实原因，避免烧完整个重试预算才把配置问题暴露给用户。
        if (status === 400 && DETERMINISTIC_REQUEST_ERROR.test(lastError.message)) {
          throw lastError;
        }

        if (attempt < this.maxRetries) {
          // 指数退避必须设上限：maxRetries=20 时 2^19 秒≈6 天的等待毫无意义。
          // 上限 8s 让 20 次重试的总退避约 2.5 分钟，失败反馈保持可用。
          const backoff = Math.min(this.retryBackoffSeconds * Math.pow(2, attempt), MAX_RETRY_BACKOFF_SECONDS);
          await waitForRetry(backoff * 1000, signal);
        }
      }
    }
    throw lastError ?? new Error('Retry failed');
  }
}

function toAbortSignal(value: unknown): AbortSignal | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<AbortSignal>;
  return typeof candidate.aborted === 'boolean'
    && typeof candidate.addEventListener === 'function'
    && typeof candidate.removeEventListener === 'function'
    ? value as AbortSignal
    : undefined;
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted'));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Re-exported for backwards compatibility (tests import from here).
export { parseTextToolCall } from '../tools/TextToolProtocol.js';
