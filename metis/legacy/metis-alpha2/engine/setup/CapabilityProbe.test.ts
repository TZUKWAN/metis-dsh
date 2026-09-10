/**
 * METIS-302 — Provider capability probe tests.
 *
 * Drives the probe with scripted ProbeTransport responses to cover the four required
 * scenarios (GLM OpenAI-compatible, standard OpenAI-compatible, no-tool model, bad key),
 * plus timeout/model-not-found/500.
 */

import { describe, it, expect } from 'vitest';
import { probeCapabilities, type ProbeTransport } from './CapabilityProbe.js';

function makeTransport(overrides: Partial<{
  chat: { status: number; hasToolCalls: boolean; hasContent: boolean; jsonValid: boolean };
  stream: { status: number; receivedChunk: boolean };
  models: { status: number; maxContextTokens?: number; multimodal?: boolean };
  chatThrows?: Error;
}>): ProbeTransport {
  const chat = overrides.chat ?? { status: 200, hasToolCalls: true, hasContent: true, jsonValid: true };
  const stream = overrides.stream ?? { status: 200, receivedChunk: true };
  const models = overrides.models ?? { status: 200, maxContextTokens: 128000, multimodal: false };
  return {
    async chatProbe() {
      if (overrides.chatThrows) throw overrides.chatThrows;
      return chat;
    },
    async streamProbe() { return stream; },
    async modelsProbe() { return models; },
  };
}

describe('METIS-302 CapabilityProbe — standard OpenAI-compatible', () => {
  it('detects full capabilities (tools + json + stream + context)', async () => {
    const t = makeTransport({
      chat: { status: 200, hasToolCalls: true, hasContent: true, jsonValid: true },
      stream: { status: 200, receivedChunk: true },
      models: { status: 200, maxContextTokens: 128000, multimodal: false },
    });
    const r = await probeCapabilities('https://api.openai.com/v1', 'sk-valid', 'gpt-4o', t);
    expect(r.reachable).toBe(true);
    expect(r.nativeToolCalling).toBe(true);
    expect(r.jsonOutput).toBe(true);
    expect(r.streaming).toBe(true);
    expect(r.maxContextTokens).toBe(128000);
    expect(r.multimodal).toBe(false);
  });
});

describe('METIS-302 CapabilityProbe — GLM OpenAI-compatible', () => {
  it('detects GLM with thinking/streaming/tools', async () => {
    const t = makeTransport({
      chat: { status: 200, hasToolCalls: true, hasContent: true, jsonValid: true },
      stream: { status: 200, receivedChunk: true },
      models: { status: 200, maxContextTokens: 128000, multimodal: true },
    });
    const r = await probeCapabilities('https://open.bigmodel.cn/api/paas/v4', 'glm-key', 'glm-4.5', t);
    expect(r.reachable).toBe(true);
    expect(r.nativeToolCalling).toBe(true);
    expect(r.streaming).toBe(true);
    expect(r.multimodal).toBe(true);
  });
});

describe('METIS-302 CapabilityProbe — no-tool model', () => {
  it('detects a model that has NO native tool calling but does stream', async () => {
    const t = makeTransport({
      chat: { status: 200, hasToolCalls: false, hasContent: true, jsonValid: false },
      stream: { status: 200, receivedChunk: true },
      models: { status: 200, maxContextTokens: 8192, multimodal: false },
    });
    const r = await probeCapabilities('https://x', 'k', 'llama3.1-8b', t);
    expect(r.reachable).toBe(true);
    expect(r.nativeToolCalling).toBe(false); // critical: no tools
    expect(r.streaming).toBe(true);
    expect(r.jsonOutput).toBe(false);
  });
});

describe('METIS-302 CapabilityProbe — bad key (401)', () => {
  it('reports auth_failed with a clear, user-readable reason (NOT a pass)', async () => {
    const t = makeTransport({ chat: { status: 401, hasToolCalls: false, hasContent: false, jsonValid: false } });
    const r = await probeCapabilities('https://api.openai.com/v1', 'sk-invalid', 'gpt-4o', t);
    expect(r.reachable).toBe(false);
    expect(r.failureCode).toBe('auth_failed');
    expect(r.failureReason).toMatch(/密钥|401/i);
    expect(r.nativeToolCalling).toBe(false);
  });

  it('reports model_not_found on 404', async () => {
    const t = makeTransport({ chat: { status: 404, hasToolCalls: false, hasContent: false, jsonValid: false } });
    const r = await probeCapabilities('https://x', 'k', 'no-such-model', t);
    expect(r.reachable).toBe(false);
    expect(r.failureCode).toBe('model_not_found');
  });

  it('reports unknown on 500', async () => {
    const t = makeTransport({ chat: { status: 500, hasToolCalls: false, hasContent: false, jsonValid: false } });
    const r = await probeCapabilities('https://x', 'k', 'm', t);
    expect(r.reachable).toBe(false);
    expect(r.failureCode).toBe('unknown');
  });

  it('reports network when the chat probe throws', async () => {
    const t = makeTransport({ chatThrows: new Error('ENOTFOUND offline') });
    const r = await probeCapabilities('https://x', 'k', 'm', t);
    expect(r.reachable).toBe(false);
    expect(r.failureCode).toBe('network');
    expect(r.failureReason).toMatch(/无法连接|offline/i);
  });
});

describe('METIS-302 CapabilityProbe — best-effort sub-probes', () => {
  it('still reports reachable=true even if json/stream/models sub-probes throw', async () => {
    const t: ProbeTransport = {
      async chatProbe() { return { status: 200, hasToolCalls: true, hasContent: true, jsonValid: false }; },
      async streamProbe() { throw new Error('stream down'); },
      async modelsProbe() { throw new Error('models down'); },
    };
    const r = await probeCapabilities('https://x', 'k', 'm', t);
    expect(r.reachable).toBe(true);
    expect(r.nativeToolCalling).toBe(true);
    expect(r.streaming).toBe(false); // best-effort: stream probe failed
    expect(r.maxContextTokens).toBe(null);
  });
});
