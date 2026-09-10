/**
 * Wire-level context isolation gate (Task 5 §13).
 *
 * tests/electron/ContextScopeIsolation.test.ts asserts scoping at the spy
 * level (agentLoop.run arguments). This suite closes the remaining gap: it
 * drives a REAL AgentLoop over a REAL loopback OpenAI-compatible provider and
 * captures the actual HTTP request bodies, proving that Project A markers
 * never reach the wire in a Project B turn, and that cross-project session
 * reuse is refused before any request is sent.
 */
import { describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import { MemoryManager } from '../../engine/memory/MemoryManager.js';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import { OpenAICompatProvider } from '../../engine/providers/OpenAICompatProvider.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { runPersistedChatTurn } from '../../electron/ChatTurnService.js';

const A_MEMORY_DECISION_MARKER = 'PROJA-DECISION-MARKER-7f3a1c';
const A_PROJECT_FILE_MARKER = 'PROJA-PROJECTFILE-MARKER-9b2c4e';
const A_NOTE_MARKER = 'PROJA-NOTE-MARKER-3d5a7f';

function sse(data: unknown): string {
  return `data: ${data === '[DONE]' ? '[DONE]' : JSON.stringify(data)}\n\n`;
}

function makeProject(id: string, title: string) {
  return {
    id,
    title,
    originalIntent: '',
    researchQuestion: '',
    lifecycle: 'active',
    methodology: '',
    discipline: '',
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    version: 1,
    source: 'user',
    deletedAt: null,
  };
}

interface CapturingServer {
  port: number;
  requests: number;
  bodies: string[];
  close: () => Promise<void>;
}

function startCapturingServer(): Promise<CapturingServer> {
  let requests = 0;
  const bodies: string[] = [];
  const server = http.createServer((request, response) => {
    requests += 1;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(sse({
        id: 'isolation-run',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      }));
      response.end(sse('[DONE]'));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        get requests() { return requests; },
        get bodies() { return bodies; },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe('Wire-level provider request isolation (Project A → Project B)', () => {
  it("Project A's memory, project-file, and note markers never appear in Project B's captured request bodies", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-wire-isolation-'));
    const server = await startCapturingServer();
    let store: PersistenceStore | null = null;
    try {
      store = new PersistenceStore(path.join(dir, 'metis.db'));
      const repo = new ResearchRepository(store.raw);
      repo.createProject(makeProject('proj-a', '项目A'));
      repo.createProject(makeProject('proj-b', '项目B'));

      const memory = new MemoryManager(store, dir);
      memory.recordKeyDecision(`${A_MEMORY_DECISION_MARKER}：A 项目采用队列样本`, undefined, 'proj-a');
      memory.saveProjectMemory(`${A_PROJECT_FILE_MARKER}：A 项目专用规则`, 'proj-a');
      store.saveNote({
        id: 'note-a-1',
        title: 'A 项目笔记',
        content: `${A_NOTE_MARKER} A 项目独占内容`,
        tags: [],
        linkedPaperIds: [],
        linkedNoteIds: [],
        updatedAt: 1,
        scope: 'research',
        projectId: 'proj-a',
      });

      store.createSession('sess-b-iso', undefined, 'proj-b');
      const provider = new OpenAICompatProvider({
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: 'loopback-key',
        model: 'gpt-4o-mini',
        timeout: 5_000,
        maxRetries: 0,
        retryBackoffSeconds: 0,
      });
      const registry = new ToolRegistry();
      const agentLoop = new AgentLoop({ provider, registry, dispatcher: new ToolDispatcher(registry) });

      const result = await runPersistedChatTurn({
        agentLoop,
        store,
        sessionId: 'sess-b-iso',
        messages: [{ role: 'user', content: '继续 B 项目的分析（B-TURN-MARKER）' }],
        requestId: 'req-b-iso-1',
        skillPrompt: memory.buildMemoryContext('proj-b'),
        projectId: 'proj-b',
      });
      expect(result.status).toBe('completed');
      expect(server.requests).toBeGreaterThanOrEqual(1);

      const allWire = server.bodies.join('\n---\n');
      expect(allWire).toContain('B-TURN-MARKER');
      expect(allWire).not.toContain(A_MEMORY_DECISION_MARKER);
      expect(allWire).not.toContain(A_PROJECT_FILE_MARKER);
      expect(allWire).not.toContain(A_NOTE_MARKER);

      // Data layer sanity: nothing A-scoped persisted into B's session.
      const sessionMessages = store.getMessages('sess-b-iso').map((m) => m.content).join('\n');
      expect(sessionMessages).not.toContain(A_MEMORY_DECISION_MARKER);
      expect(sessionMessages).not.toContain(A_PROJECT_FILE_MARKER);
    } finally {
      await server.close();
      try { store?.close(); } catch { /* already closed */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows EPERM */ }
    }
  });

  it('refuses to run a session bound to Project A under Project B before any request is sent', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-wire-binding-'));
    const server = await startCapturingServer();
    let store: PersistenceStore | null = null;
    try {
      store = new PersistenceStore(path.join(dir, 'metis.db'));
      const repo = new ResearchRepository(store.raw);
      repo.createProject(makeProject('proj-a', '项目A'));
      repo.createProject(makeProject('proj-b', '项目B'));
      const memory = new MemoryManager(store, dir);
      memory.recordKeyDecision(`${A_MEMORY_DECISION_MARKER}：A 项目独占`, undefined, 'proj-a');

      store.createSession('sess-a-bound', undefined, 'proj-a');
      const provider = new OpenAICompatProvider({
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: 'loopback-key',
        model: 'gpt-4o-mini',
        timeout: 5_000,
        maxRetries: 0,
        retryBackoffSeconds: 0,
      });
      const registry = new ToolRegistry();
      const agentLoop = new AgentLoop({ provider, registry, dispatcher: new ToolDispatcher(registry) });

      const result = await runPersistedChatTurn({
        agentLoop,
        store,
        sessionId: 'sess-a-bound',
        messages: [{ role: 'user', content: '试图用 B 的身份驱动 A 的会话' }],
        requestId: 'req-cross-1',
        skillPrompt: memory.buildMemoryContext('proj-b'),
        projectId: 'proj-b',
      });

      expect(result.status).toBe('error');
      expect(result.diagnostics.some((d) => d.code === 'scope_mismatch')).toBe(true);
      expect(server.requests).toBe(0);
    } finally {
      await server.close();
      try { store?.close(); } catch { /* already closed */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows EPERM */ }
    }
  });
});
