import type {
  AbortableSetupProbeTransport,
} from './FirstRunSetupService.js';
import type {
  ChatProbeResponse,
  ModelsProbeResponse,
  StreamProbeResponse,
} from '../engine/setup/CapabilityProbe.js';

const PROBE_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_CHARS = 1_000_000;

interface JsonRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function endpoint(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}/${suffix.replace(/^\/+/, '')}`;
}

function authHeaders(apiKey: string): HeadersInit {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0 || text.length > MAX_RESPONSE_CHARS) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function assistantMessage(payload: unknown): JsonRecord | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined;
  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return undefined;
  return first.message;
}

function contentText(message: JsonRecord | undefined): string {
  return typeof message?.content === 'string' ? message.content : '';
}

function readContextTokens(payload: unknown, model: string): number | undefined {
  if (!isRecord(payload)) return undefined;
  const candidates: unknown[] = [
    payload.context_window,
    payload.context_length,
    payload.max_context_length,
  ];
  if (Array.isArray(payload.data)) {
    const item = payload.data.find((entry) => isRecord(entry) && entry.id === model);
    if (isRecord(item)) {
      candidates.push(item.context_window, item.context_length, item.max_context_length);
    }
  }
  return candidates.find((value): value is number => (
    typeof value === 'number'
    && Number.isInteger(value)
    && value > 0
    && value <= 10_000_000
  ));
}

function readMultimodal(payload: unknown, model: string): boolean | undefined {
  if (!isRecord(payload)) return undefined;
  const item = Array.isArray(payload.data)
    ? payload.data.find((entry) => isRecord(entry) && entry.id === model)
    : payload;
  if (!isRecord(item)) return undefined;
  const modalities = item.input_modalities ?? item.modalities;
  if (Array.isArray(modalities)) {
    return modalities.some((value) => value === 'image' || value === 'vision');
  }
  if (typeof item.vision === 'boolean') return item.vision;
  if (typeof item.multimodal === 'boolean') return item.multimodal;
  return undefined;
}

/** Real, bounded OpenAI-compatible transport used by first-run capability probing. */
export class OpenAISetupProbeTransport implements AbortableSetupProbeTransport {
  readonly #controllers = new Set<AbortController>();

  async chatProbe(
    baseUrl: string,
    apiKey: string,
    model: string,
    options: { tools?: boolean; jsonMode?: boolean },
  ): Promise<ChatProbeResponse> {
    const body: JsonRecord = {
      model,
      messages: [{ role: 'user', content: options.jsonMode ? 'Return {"ok":true}.' : 'Reply with OK.' }],
      max_tokens: 32,
      temperature: 0,
      stream: false,
    };
    if (options.tools) {
      body.tools = [{
        type: 'function',
        function: {
          name: 'metis_probe',
          description: 'Return a fixed capability probe result.',
          parameters: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
        },
      }];
      body.tool_choice = 'auto';
    }
    if (options.jsonMode) body.response_format = { type: 'json_object' };

    const response = await this.#fetch(endpoint(baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
    });
    const payload = await boundedJson(response);
    const message = assistantMessage(payload);
    const content = contentText(message);
    let jsonValid = false;
    if (content) {
      try {
        const parsed: unknown = JSON.parse(content);
        jsonValid = isRecord(parsed);
      } catch {
        jsonValid = false;
      }
    }
    return {
      status: response.status,
      hasToolCalls: Array.isArray(message?.tool_calls) && message.tool_calls.length > 0,
      hasContent: content.trim().length > 0,
      jsonValid,
    };
  }

  async streamProbe(
    baseUrl: string,
    apiKey: string,
    model: string,
  ): Promise<StreamProbeResponse> {
    const response = await this.#fetch(endpoint(baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 16,
        temperature: 0,
        stream: true,
      }),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, receivedChunk: false };
    }
    const reader = response.body.getReader();
    try {
      const first = await reader.read();
      return {
        status: response.status,
        receivedChunk: !first.done && first.value.byteLength > 0,
      };
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async modelsProbe(
    baseUrl: string,
    apiKey: string,
    model: string,
  ): Promise<ModelsProbeResponse> {
    let response = await this.#fetch(
      endpoint(baseUrl, `models/${encodeURIComponent(model)}`),
      { method: 'GET', headers: authHeaders(apiKey) },
    );
    if (response.status === 404 || response.status === 405) {
      response = await this.#fetch(endpoint(baseUrl, 'models'), {
        method: 'GET',
        headers: authHeaders(apiKey),
      });
    }
    const payload = await boundedJson(response);
    return {
      status: response.status,
      maxContextTokens: readContextTokens(payload, model),
      multimodal: readMultimodal(payload, model),
    };
  }

  abort(): void {
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
  }

  async #fetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
    } finally {
      clearTimeout(timeout);
      this.#controllers.delete(controller);
    }
  }
}
