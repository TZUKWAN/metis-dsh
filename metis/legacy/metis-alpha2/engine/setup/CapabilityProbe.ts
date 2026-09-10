/**
 * Provider Capability Probe (METIS-302).
 *
 * After the user configures a provider (METIS-301), this sends MINIMAL real requests to
 * auto-detect what the model actually supports: streaming, native tool calling, JSON output,
 * context length, multimodal. The user never hand-toggles capability switches (task list
 * METIS-302: "users don't manually select capability toggles").
 *
 * The network call is injected (ProbeTransport) so the probe-decision logic is testable
 * offline against scripted responses — including the four required scenarios: GLM
 * OpenAI-compatible, standard OpenAI-compatible, no-tool model, and bad key (401).
 *
 * This complements (does not replace) the static MODEL_CAPS table in OpenAICompatProvider:
 * the static table gives a fast first guess; the probe CONFIRMS against the live endpoint
 * and overrides when reality differs.
 */

// ─── Probe result ─────────────────────────────────────────────

export interface ProbedCapabilities {
  reachable: boolean;
  streaming: boolean;
  nativeToolCalling: boolean;
  jsonOutput: boolean;
  maxContextTokens: number | null;
  multimodal: boolean;
  modelEcho?: string;
  /** If not reachable, a structured, user-readable reason. */
  failureReason?: string;
  failureCode?: 'auth_failed' | 'network' | 'timeout' | 'model_not_found' | 'unknown';
}

// ─── Injected transport (offline-testable) ────────────────────

export interface ChatProbeResponse {
  /** HTTP status of the non-streaming chat probe. */
  status: number;
  /** Did the assistant message include a tool_calls array? */
  hasToolCalls: boolean;
  /** Did the assistant message include content text? */
  hasContent: boolean;
  /** Did a JSON-mode probe return valid JSON content? */
  jsonValid: boolean;
}
export interface StreamProbeResponse {
  status: number;
  /** Did the streaming endpoint yield at least one delta chunk? */
  receivedChunk: boolean;
}
export interface ModelsProbeResponse {
  status: number;
  /** Parsed context-length for the model from /models or known metadata, if exposed. */
  maxContextTokens?: number;
  /** Whether the model advertises vision/image input. */
  multimodal?: boolean;
}

export interface ProbeTransport {
  chatProbe(baseUrl: string, apiKey: string, model: string, opts: { tools?: boolean; jsonMode?: boolean }): Promise<ChatProbeResponse>;
  streamProbe(baseUrl: string, apiKey: string, model: string): Promise<StreamProbeResponse>;
  modelsProbe(baseUrl: string, apiKey: string, model: string): Promise<ModelsProbeResponse>;
}

// ─── Probe ───────────────────────────────────────────────────

export async function probeCapabilities(
  baseUrl: string,
  apiKey: string,
  model: string,
  transport: ProbeTransport,
): Promise<ProbedCapabilities> {
  // 1. Base chat reachability + tool-calling probe (single request with a trivial tool).
  let chat: ChatProbeResponse;
  try {
    chat = await transport.chatProbe(baseUrl, apiKey, model, { tools: true });
  } catch (err) {
    return {
      reachable: false, streaming: false, nativeToolCalling: false, jsonOutput: false,
      maxContextTokens: null, multimodal: false,
      failureReason: `无法连接到模型服务：${(err as Error).message}`,
      failureCode: 'network',
    };
  }

  if (chat.status === 401 || chat.status === 403) {
    return {
      reachable: false, streaming: false, nativeToolCalling: false, jsonOutput: false,
      maxContextTokens: null, multimodal: false,
      failureReason: 'API 密钥无效或无权限（401/403）。请检查密钥后重试。',
      failureCode: 'auth_failed',
    };
  }
  if (chat.status === 404) {
    return {
      reachable: false, streaming: false, nativeToolCalling: false, jsonOutput: false,
      maxContextTokens: null, multimodal: false,
      failureReason: `未找到模型 '${model}'。请确认模型名称正确。`,
      failureCode: 'model_not_found',
    };
  }
  if (chat.status >= 500) {
    return {
      reachable: false, streaming: false, nativeToolCalling: false, jsonOutput: false,
      maxContextTokens: null, multimodal: false,
      failureReason: `模型服务返回错误（${chat.status}）。可稍后重试。`,
      failureCode: 'unknown',
    };
  }
  if (chat.status !== 200) {
    return {
      reachable: false, streaming: false, nativeToolCalling: false, jsonOutput: false,
      maxContextTokens: null, multimodal: false,
      failureReason: `探测失败（HTTP ${chat.status}）。`,
      failureCode: 'unknown',
    };
  }

  // Reachable. Now probe JSON mode, streaming, and metadata — each is best-effort and does
  // not block the overall result if it fails.
  const result: ProbedCapabilities = {
    reachable: true,
    streaming: false,
    nativeToolCalling: chat.hasToolCalls,
    jsonOutput: false,
    maxContextTokens: null,
    multimodal: false,
    modelEcho: model,
  };

  try {
    const jsonProbe = await transport.chatProbe(baseUrl, apiKey, model, { jsonMode: true });
    result.jsonOutput = jsonProbe.status === 200 && jsonProbe.jsonValid;
  } catch { /* best-effort: leave false */ }

  try {
    const stream = await transport.streamProbe(baseUrl, apiKey, model);
    result.streaming = stream.status === 200 && stream.receivedChunk;
  } catch { /* best-effort */ }

  try {
    const meta = await transport.modelsProbe(baseUrl, apiKey, model);
    if (meta.status === 200) {
      if (typeof meta.maxContextTokens === 'number') result.maxContextTokens = meta.maxContextTokens;
      if (typeof meta.multimodal === 'boolean') result.multimodal = meta.multimodal;
    }
  } catch { /* best-effort */ }

  return result;
}
