/**
 * METIS-006 — End-to-end baseline matrix.
 *
 * Establishes which real user flows work BEFORE the HSS refactor begins, so later
 * stages can detect regressions against a trusted baseline. This exercises the real
 * engine code paths (no GUI, no Playwright): PersistenceStore + AgentLoop + Provider
 * + SecureStorage, exactly as the Electron main process wires them.
 *
 * Coverage matrix (per METIS-006 completion criteria):
 *   1. Isolated data dir initialization
 *   2. First-time provider config (encrypted save + reload)        [test Provider]
 *   3. Create session -> send message -> persist                   [test Provider]
 *   4. Full agent tool-loop produces a real artifact               [test Provider]
 *   5. Invalid API key returns a structured 401 failure (NOT pass) [real network]
 *   6. Restart recovers sessions/messages from a fresh store       [persistence]
 *
 * NOTE on "real Provider": an invalid-key 401 is a real OpenAI-compatible endpoint
 * interaction (no key works universally, so 401 is the deterministic, honest signal).
 * A successful real-model completion requires a user-provided key and is left to the
 * user-driven acceptance in stage 11; this baseline does not fake that success.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import { OpenAICompatProvider } from '../../engine/providers/OpenAICompatProvider.js';
import { FakeProvider } from '../../engine/providers/FakeProvider.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import {
  encryptProviderConfig,
  decryptProviderConfig,
  setSecureStorage,
} from '../../engine/core/SecureStorage.js';
import type { ProviderConfig, ChatMessage, NormalizedResponse, ToolSpec } from '../../engine/core/types.js';

// ─── SecureStorage stub (pure-Node; suppresses Electron fallback warning) ────

/** Deterministic in-process secure storage so encrypted configs round-trip reliably. */
class StubSecureStorage {
  private readonly keys = new Map<string, string>();
  private counter = 0;
  encrypt(plain: string): string {
    const id = `stub:v1:key_${this.counter++}_${Date.now()}`;
    this.keys.set(id, plain);
    return Buffer.from(id).toString('base64');
  }
  decrypt(cipher: string): string {
    const id = Buffer.from(cipher, 'base64').toString('utf-8');
    const plain = this.keys.get(id);
    if (plain === undefined) throw new Error(`Key not found: ${id}`);
    return plain;
  }
  isAvailable(): boolean {
    return true;
  }
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_CONFIG: ProviderConfig = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test-baseline-key-12345',
  model: 'gpt-4o',
  timeout: 30000,
  maxRetries: 2,
  retryBackoffSeconds: 1,
};

const ECHO_TOOL: ToolSpec = {
  name: 'echo',
  description: 'Echo back a message',
  parameters: {
    type: 'object',
    properties: { message: { type: 'string', description: 'Message to echo' } },
    required: ['message'],
  },
};

async function echoHandler(args: Record<string, unknown>): Promise<string> {
  return `Echo: ${String(args.message)}`;
}

// ─── Test harness ─────────────────────────────────────────────────────────────

describe('METIS-006 end-to-end baseline', () => {
  let dataDir: string;
  let dbPath: string;
  let configPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    setSecureStorage(new StubSecureStorage());
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-e2e-'));
    dbPath = path.join(dataDir, 'metis.db');
    configPath = path.join(dataDir, 'provider-config.json');
    store = new PersistenceStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // ── 1. Isolated data dir initialization ──────────────────────────────────

  it('initializes an isolated data directory with a working SQLite store', () => {
    expect(fs.existsSync(dataDir)).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);
    // A fresh store has no sessions.
    expect(store.listSessions()).toEqual([]);
    // Schema is usable: a session can be created and listed.
    const sid = store.createSession('baseline-session-1');
    expect(sid).toBe('baseline-session-1');
    const sessions = store.listSessions();
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.id).toBe('baseline-session-1');
  });

  // ── 2. First-time provider config: encrypted save + reload ───────────────

  it('encrypts, persists, and reloads provider config without leaking the raw key', () => {
    const encrypted = encryptProviderConfig(TEST_CONFIG);
    fs.writeFileSync(configPath, JSON.stringify(encrypted, null, 2), 'utf-8');

    // The persisted file must NOT contain the raw API key in plaintext.
    const raw = fs.readFileSync(configPath, 'utf-8');
    expect(raw).not.toContain(TEST_CONFIG.apiKey);
    expect(encrypted.encryptedApiKey).not.toBe(TEST_CONFIG.apiKey);

    // Reload and verify the key is recovered.
    const reloaded = decryptProviderConfig(JSON.parse(raw));
    expect(reloaded.apiKey).toBe(TEST_CONFIG.apiKey);
    expect(reloaded.baseUrl).toBe(TEST_CONFIG.baseUrl);
    expect(reloaded.model).toBe(TEST_CONFIG.model);
  });

  // ── 3. Create session -> send message -> persist (test Provider) ─────────

  it('runs a full agent turn with FakeProvider and persists messages to the store', async () => {
    const provider = new FakeProvider({ response: 'Baseline research answer.' });
    const registry = new ToolRegistry();
    registry.register(ECHO_TOOL);
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('echo', echoHandler);

    const loop = new AgentLoop({
      provider,
      registry,
      dispatcher,
      workspace: dataDir,
    });

    const sessionId = store.createSession('e2e-chat-1');
    const userMsg: ChatMessage = { role: 'user', content: 'What is your baseline answer?' };

    const result = await loop.run({
      messages: [userMsg],
      maxTurns: 3,
      sessionId,
      requestId: 'baseline-req-1',
      taskContractHash: '',
      promptStackHash: '',
      resumeFromCheckpoint: false,
    });

    // The turn completed and produced the scripted answer.
    expect(result.status).toBe('completed');
    expect(result.finalText).toContain('Baseline research answer');

    // Persist only this turn's user input and final response, matching agent:chat.
    store.appendMessage(sessionId, userMsg.role, userMsg.content);
    store.appendMessage(sessionId, 'assistant', result.finalText);

    // Reload messages from persistence — restart-equivalent.
    const reloaded = store.getMessages(sessionId);
    expect(reloaded.length).toBeGreaterThanOrEqual(2);
    expect(reloaded[0]?.role).toBe('user');
    expect(reloaded[0]?.content).toContain('baseline answer');
    const assistantMsg = reloaded.find((m) => m.role === 'assistant');
    expect(assistantMsg?.content).toContain('Baseline research answer');
  });

  // ── 4. Full agent tool-loop produces a real tool result ──────────────────

  it('executes a real tool call through the dispatcher and records the result', async () => {
    // Scripted NormalizedResponse that requests one tool call, then a follow-up
    // that consumes the tool result and finishes.
    const callId = 'call_e2e_1';
    const responses: NormalizedResponse[] = [
      {
        content: '',
        toolCalls: [{ name: 'echo', arguments: { message: 'tool-evidence' }, id: callId }],
        finishReason: 'tool_calls',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      },
      {
        content: 'Tool returned: tool-evidence',
        toolCalls: [],
        finishReason: 'stop',
        usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
      },
    ];

    // This scripted provider deliberately exposes NO streaming (it only overrides
    // complete()): the loop must fall back to complete() and dispatch the echoed
    // tool call exactly as a real non-streaming provider would.
    const provider = new (class extends FakeProvider {
      private idx = 0;
      override async complete(): Promise<NormalizedResponse> {
        const r = responses[this.idx] ?? responses[responses.length - 1]!;
        this.idx++;
        return r;
      }
      override completeStream: FakeProvider['completeStream'] = () => {
        throw new Error('no streaming in this baseline provider');
      };
    })();

    const registry = new ToolRegistry();
    registry.register(ECHO_TOOL);
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('echo', echoHandler);

    const loop = new AgentLoop({ provider, registry, dispatcher, workspace: dataDir });

    const result = await loop.run({
      messages: [{ role: 'user', content: 'Use echo then summarize' }],
      maxTurns: 5,
      sessionId: 'e2e-tool-1',
      requestId: 'baseline-req-2',
      taskContractHash: '',
      promptStackHash: '',
      resumeFromCheckpoint: false,
    });

    expect(result.status).toBe('completed');
    expect(result.toolResults.length).toBe(1);
    expect(result.toolResults[0]?.toolName).toBe('echo');
    expect(result.toolResults[0]?.content).toContain('Echo: tool-evidence');
    expect(result.finalText).toContain('Tool returned: tool-evidence');
  });

  // ── 5. Invalid API key returns a structured 401 failure (NOT pass) ───────
  //    Uses a real local HTTP server returning 401 to exercise the real undici
  //    fetch path in OpenAICompatProvider, deterministically and offline.

  it('treats an invalid API key (401) as a provider error, never as a success', async () => {
    // Spin up a local server that always returns 401 Unauthorized, mimicking a real
    // OpenAI-compatible endpoint rejecting a bad key.
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key', type: 'invalid_request_error' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}/v1`;

    const badProvider = new OpenAICompatProvider({
      baseUrl,
      apiKey: 'sk-invalid-baseline-key',
      model: 'gpt-4o',
      timeout: 5000,
      maxRetries: 0, // fail fast — 401 is not retryable anyway
    });

    try {
      // Direct provider call must reject with the 401 error.
      await expect(
        badProvider.complete([{ role: 'user', content: 'hi' }]),
      ).rejects.toThrow(/Provider error 401/);

      // And through the AgentLoop, the error is surfaced in result.errors with a
      // terminal status — it is NEVER reported as a successful completion.
      const registry = new ToolRegistry();
      const loop = new AgentLoop({
        provider: badProvider,
        registry,
        dispatcher: new ToolDispatcher(registry),
        workspace: dataDir,
      });
      const result = await loop.run({
        messages: [{ role: 'user', content: 'hi' }],
        maxTurns: 1,
        sessionId: 'e2e-401-1',
        requestId: 'baseline-req-401',
        taskContractHash: '',
        promptStackHash: '',
        resumeFromCheckpoint: false,
      });
      expect(['error', 'max_turns_reached']).toContain(result.status);
      expect(result.errors.some((e) => /Provider error 401/.test(e))).toBe(true);
      // A 401 must never look like a clean answer to the user.
      expect(result.finalText).not.toMatch(/^[A-Z].*\./); // no plausible model answer
    } finally {
      server.close();
    }
  });

  // ── 6. Restart recovers sessions/messages from a fresh store ─────────────

  it('recovers persisted sessions and messages after a simulated restart', async () => {
    // Phase 1: write data through one store instance.
    const sessionId = store.createSession('e2e-restart-1');
    store.appendMessage(sessionId, 'user', 'Research question before restart');
    store.appendMessage(sessionId, 'assistant', 'Pre-restart answer');
    store.close();

    // Phase 2: open a NEW store on the same DB file (simulates app restart).
    const restarted = new PersistenceStore(dbPath);
    try {
      const sessions = restarted.listSessions();
      expect(sessions.length).toBe(1);
      expect(sessions[0]?.id).toBe('e2e-restart-1');
      const msgs = restarted.getMessages('e2e-restart-1');
      expect(msgs.length).toBe(2);
      expect(msgs[0]?.content).toBe('Research question before restart');
      expect(msgs[1]?.content).toBe('Pre-restart answer');
    } finally {
      restarted.close();
    }
    // Re-open a store for afterEach cleanup to close.
    store = new PersistenceStore(dbPath);
  });
});
