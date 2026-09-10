/**
 * 任务2：METIS Context Isolation、领域所有权与跨项目零污染（2026-09-05 刘总规格书）。
 *
 * 核心回归（任务第六节）：Topic A 捕获 A-only-reference、Topic B 捕获 B-only-reference，
 * B 的上下文必须含 B、必须不含 A；跨 Project 同样零交叉；null scope 不等于所有 scope。
 * Provider Request 级测试（任务第十四节）：在模型发送前拦截（spy agentLoop 断言
 * run 未被调用 / 请求文本无 A-only marker）。
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';

import path from 'node:path';
import { realTempRoot } from './helpers/realTempDir.mjs';

import { ExternalReferenceService } from '../../electron/ExternalReferenceService.js';
import { buildTopicContextPackage } from '../../src/topic/contextPackage.js';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { MemoryManager } from '../../engine/memory/MemoryManager.js';
import { runPersistedChatTurn } from '../../electron/ChatTurnService.js';
import type { AgentLoop } from '../../engine/core/AgentLoop.js';
import type { AgentRunResult } from '../../engine/core/types.js';
import {
  sanitizeContextScope,
  checkSessionProjectBinding,
  requireScopeOwnership,
  assertNoForeignScopeMarkers,
  buildContextProvenance,
  describeScope,
} from '../../engine/runtime/ContextScopeContract.js';

function newDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

const A_REF = {
  v: 1 as const,
  model: 'ChatGPT',
  url: 'https://chatgpt.com/c/a-only',
  quotedText: 'A-only-marker-9f2: 建议聚焦劳动过程理论的时间维度。',
  capturedAt: 1_786_000_000_000,
  projectId: null,
  sessionId: 'topicA',
};
const B_REF = {
  v: 1 as const,
  model: 'Claude',
  url: 'https://claude.ai/c/b-only',
  quotedText: 'B-only-marker-4c7: 建议比较平台化对技能结构的影响。',
  capturedAt: 1_786_000_000_001,
  projectId: null,
  sessionId: 'topicB',
};

describe('ContextScope 契约', () => {
  it('sanitizes unknown/empty fields and keeps explicit ownership only', () => {
    const scope = sanitizeContextScope({ projectId: ' p1 ', sessionId: '', topicSessionId: 't1', junk: 'x' });
    expect(scope).toEqual({ projectId: 'p1', topicSessionId: 't1' });
    expect(describeScope({})).toBe('global');
  });

  it('rejects session↔project mismatch only when both sides are known', () => {
    expect(checkSessionProjectBinding({ projectId: 'proj-A' }, { projectId: 'proj-B' })?.code).toBe('scope_mismatch');
    // null 不等于通配，也不自动等于对方：空侧不判定。
    expect(checkSessionProjectBinding({ projectId: null }, { projectId: 'proj-B' })).toBeNull();
    expect(checkSessionProjectBinding({ projectId: 'proj-A' }, { projectId: null })).toBeNull();
    expect(checkSessionProjectBinding({ projectId: 'proj-A' }, { projectId: 'proj-A' })).toBeNull();
  });

  it('requires explicit ownership for context reads (empty scope ≠ all data)', () => {
    expect(requireScopeOwnership({}, 'projectId')?.code).toBe('scope_required');
    expect(requireScopeOwnership({ sessionId: 's1' }, 'projectId')).toBeNull();
  });

  it('assertNoForeignScopeMarkers detects foreign markers in the final prompt text', () => {
    const issue = assertNoForeignScopeMarkers({
      requestScope: { projectId: 'proj-B' },
      promptText: '计划：A-only-marker-9f2 相关内容',
      foreignMarkers: [{ projectId: 'proj-A', markers: ['A-only-marker-9f2'] }],
    });
    expect(issue?.code).toBe('scope_mismatch');
    expect(assertNoForeignScopeMarkers({
      requestScope: { projectId: 'proj-B' },
      promptText: '仅 B 内容',
      foreignMarkers: [{ projectId: 'proj-A', markers: ['A-only-marker-9f2'] }],
    })).toBeNull();
  });

  it('buildContextProvenance is deterministic and bounded', () => {
    const a = buildContextProvenance({ projectId: 'p', sessionId: 's', injectedParts: [{ kind: 'memory', content: 'abc' }] });
    const b = buildContextProvenance({ projectId: 'p', sessionId: 's', injectedParts: [{ kind: 'memory', content: 'abc' }] });
    expect(a.contextDigest).toBe(b.contextDigest);
    expect(a.contextDigest).toHaveLength(16);
  });
});

describe('ExternalReference 跨 Topic/Project 串线修复（任务第六节）', () => {
  it('Topic B context contains B-only and never A-only (same project, separate topics)', () => {
    const db = newDb();
    const service = new ExternalReferenceService(db);
    const addA = service.add(A_REF);
    const addB = service.add(B_REF);
    expect(addA.ok && addB.ok).toBe(true);

    // Topic B 的读取 scope（TopicWorkspacePage 接线后的实际调用形态）。
    const refsB = service.listForScope({ sessionId: 'topicB' });
    expect(refsB.map((r) => r.quotedText).join('|')).toContain('B-only-marker-4c7');
    expect(refsB.map((r) => r.quotedText).join('|')).not.toContain('A-only-marker-9f2');

    // Topic A 对称。
    const refsA = service.listForScope({ sessionId: 'topicA' });
    expect(refsA.map((r) => r.quotedText).join('|')).toContain('A-only-marker-9f2');
    expect(refsA.map((r) => r.quotedText).join('|')).not.toContain('B-only-marker-4c7');

    // 上下文包（prompt 组装层）同样零交叉。
    const packB = buildTopicContextPackage({
      hasSession: true,
      sessionTitle: '选题B',
      sessionStatus: '研究',
      candidates: [],
      messages: [{ role: 'user', content: '继续' }],
      externalReferences: refsB.map((r) => ({ model: r.model, quotedText: r.quotedText })),
    });
    expect(packB).toContain('B-only-marker-4c7');
    expect(packB).not.toContain('A-only-marker-9f2');
  });

  it('cross-project: project A refs never enter project B reads', () => {
    const db = newDb();
    const service = new ExternalReferenceService(db);
    service.add({ ...A_REF, sessionId: 'topicShared', projectId: 'proj-A' });
    service.add({ ...B_REF, sessionId: 'topicShared', projectId: 'proj-B' });

    const projB = service.listForScope({ sessionId: 'topicShared', projectId: 'proj-B' });
    expect(projB.map((r) => r.projectId)).toEqual(['proj-B']);
    expect(service.listForProject('proj-A').map((r) => r.projectId)).toEqual(['proj-A']);
  });

  it('empty scope is rejected (null ≠ all scopes) and global browsing is explicit', () => {
    const service = new ExternalReferenceService(newDb());
    expect(() => service.listForScope({})).toThrow(/scope_required/);
    expect(() => service.listForProject('')).toThrow(/scope_required/);
    expect(() => service.listForSession('  ')).toThrow(/scope_required/);
    // 管理页显式 global 才能浏览全量。
    service.add(A_REF);
    expect(service.listGlobal()).toHaveLength(1);
  });
});

describe('ChatTurnService fail-closed scope 校验（任务第十三/十四节）', () => {
  // Windows + WAL：必须先 close 再删目录，否则 rmSync EPERM。
  function makeStore(): { store: PersistenceStore; dir: string } {
    const dir = fs.mkdtempSync(path.join(realTempRoot(), 'metis-scope-'));
    return { store: new PersistenceStore(path.join(dir, 'scope.db')), dir };
  }

  function cleanup(store: PersistenceStore, dir: string): void {
    try { store.close(); } catch { /* 已关闭 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  function spyAgentLoop(result: Partial<AgentRunResult> = {}): { loop: AgentLoop; calls: Array<Record<string, unknown>> } {
    const calls: Array<Record<string, unknown>> = [];
    const loop = {
      run: async (request: Record<string, unknown>) => {
        calls.push(request);
        return {
          status: 'completed', finalText: 'ok', finalVerified: true, errors: [],
          toolResults: [], traceEvents: [], ...result,
        } as AgentRunResult;
      },
    } as unknown as AgentLoop;
    return { loop, calls };
  }

  const messages = [{ role: 'user' as const, content: 'hello' }];

  it('rejects scope_mismatch BEFORE the model is called when session belongs to project A but request declares B', async () => {
    const { store, dir } = makeStore();
    try {
      store.createSession('sess-a', undefined, 'proj-A');
      const { loop, calls } = spyAgentLoop();
      const response = await runPersistedChatTurn({
        agentLoop: loop,
        store,
        sessionId: 'sess-a',
        messages,
        requestId: 'req-mismatch',
        projectId: 'proj-B',
      });
      expect(response.diagnostics[0]?.code).toBe('scope_mismatch');
      // 模型发送前拦截：AgentLoop.run 零调用，项目 A 历史零注入。
      expect(calls).toHaveLength(0);
    } finally { cleanup(store, dir); }
  });

  it('implicit session creation inherits the request projectId (no ownerless sessions)', async () => {
    const { store, dir } = makeStore();
    try {
      const { loop } = spyAgentLoop();
      await runPersistedChatTurn({
        agentLoop: loop, store, sessionId: 'sess-new', messages, requestId: 'req-new', projectId: 'proj-B',
      });
      expect(store.getSession('sess-new')?.projectId).toBe('proj-B');
    } finally { cleanup(store, dir); }
  });

  it('binds an ownerless legacy session explicitly to the requesting project', async () => {
    const { store, dir } = makeStore();
    try {
      store.createSession('sess-legacy'); // 存量无主会话
      const { loop } = spyAgentLoop();
      await runPersistedChatTurn({
        agentLoop: loop, store, sessionId: 'sess-legacy', messages, requestId: 'req-legacy', projectId: 'proj-B',
      });
      expect(store.getSession('sess-legacy')?.projectId).toBe('proj-B');
    } finally { cleanup(store, dir); }
  });
});

describe('跨项目 Provider Request 零泄漏（任务第十四节，模型发送前断言）', () => {
  it('project B request text contains no project-A-only memory markers', async () => {
    const dir = fs.mkdtempSync(path.join(realTempRoot(), 'metis-leak-'));
    const store = new PersistenceStore(path.join(dir, 'leak.db'));
    try {
      const memory = new MemoryManager(store, dir);

      // Project A：scoped 记忆 + per-project 记忆文件。
      memory.recordKeyDecision('A 项目独占决策 7d1：采用队列样本', undefined, 'proj-A');
      memory.saveProjectMemory('A-only-project-file-marker-5aa：A 项目专用规则', 'proj-A');
      // 全局行（历史遗留/显式 global 语义）也不得进入项目 prompt。
      memory.recordKeyDecision('全局遗留决策 9z3');

      const calls: Array<Record<string, unknown>> = [];
      const agentLoop = {
        run: async (request: Record<string, unknown>) => {
          calls.push(request);
          return { status: 'completed', finalText: 'ok', finalVerified: true, errors: [], toolResults: [], traceEvents: [] } as AgentRunResult;
        },
      } as unknown as AgentLoop;

      store.createSession('sess-b1', undefined, 'proj-B');
      await runPersistedChatTurn({
        agentLoop, store, sessionId: 'sess-b1',
        messages: [{ role: 'user', content: '请继续 B 的研究' }],
        requestId: 'req-b1',
        skillPrompt: memory.buildMemoryContext('proj-B'),
        projectId: 'proj-B',
      });

      expect(calls).toHaveLength(1);
      const sentText = JSON.stringify(calls[0]);
      expect(sentText).not.toContain('A-only-project-file-marker-5aa');
      expect(sentText).not.toContain('A 项目独占决策 7d1');
      expect(sentText).not.toContain('全局遗留决策 9z3');

      // 对称验证：A 项目上下文确实含自己的 scoped 内容（功能未被误伤）。
      const ctxA = memory.buildMemoryContext('proj-A');
      expect(ctxA).toContain('A 项目独占决策 7d1');
      expect(ctxA).toContain('A-only-project-file-marker-5aa');
      expect(ctxA).not.toContain('全局遗留决策 9z3');
    } finally {
      try { store.close(); } catch { /* 已关闭 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('searchLibrary with a project scope excludes papers linked to other projects', () => {
    const dir = fs.mkdtempSync(path.join(realTempRoot(), 'metis-lib-'));
    const store = new PersistenceStore(path.join(dir, 'lib.db'));
    const save = (id: string, title: string, pdfText: string, addedAt: number): void => store.savePaper({
      id, title, authors: [], year: 2024, venue: '', abstract: '', pdfText,
      tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt,
    });
    const link = (paperId: string, projectId: string): void => {
      const db = (store as unknown as { db: Database.Database }).db;
      // paper_project_links 外键引用 projects(id)：先补最小父行。
      db.prepare(
        'INSERT OR IGNORE INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ).run(projectId, `项目${projectId}`, Date.now(), Date.now());
      db.prepare(
        'INSERT OR IGNORE INTO paper_project_links (paper_id, project_id, linked_at) VALUES (?, ?, ?)',
      ).run(paperId, projectId, Date.now());
    };
    try {
      save('pap-a', 'A项目论文 alpha7d1', 'A-only-fulltext-9f2', 1);
      save('pap-b', 'B项目论文 beta4c7', 'B-only-fulltext-2e8', 2);
      link('pap-a', 'proj-A');
      link('pap-b', 'proj-B');

      const scopedB = store.searchLibrary('alpha7d1', 5, { projectId: 'proj-B' });
      expect(scopedB).toHaveLength(0); // A 的论文对 B 不可见
      // 对照组：同一查询不带 scope 能命中 A 的论文——证明上面的 0 是过滤
      // 生效，而不是分词/命中问题。
      expect(store.searchLibrary('alpha7d1', 5).map((h) => h.id)).toEqual(['pap-a']);
      const scopedOwnB = store.searchLibrary('beta4c7', 5, { projectId: 'proj-B' });
      expect(scopedOwnB.map((h) => h.id)).toEqual(['pap-b']);
      // 未链接的全局文献对任何项目可见。
      save('pap-g', '全局文献 gamma1k9', '', 3);
      expect(store.searchLibrary('gamma1k9', 5, { projectId: 'proj-B' }).map((h) => h.id)).toEqual(['pap-g']);
    } finally {
      try { store.close(); } catch { /* 已关闭 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('context provenance is recorded and diagnosable per run', async () => {
    const dir = fs.mkdtempSync(path.join(realTempRoot(), 'metis-prov-'));
    const store = new PersistenceStore(path.join(dir, 'prov.db'));
    try {
      const agentLoop = {
        run: async () => ({ status: 'completed', finalText: 'ok', finalVerified: true, errors: [], toolResults: [], traceEvents: [] } as AgentRunResult),
      } as unknown as AgentLoop;
      store.recordContextProvenance({
        runId: 'run-p1', sessionId: 'sess-p', projectId: 'proj-B',
        provenance: buildContextProvenance({ projectId: 'proj-B', sessionId: 'sess-p', injectedParts: [{ kind: 'systemPrompt', content: 'B 内容' }] }),
      });
      const prov = store.getContextProvenance('run-p1');
      expect(prov?.projectId).toBe('proj-B');
      expect(String((prov?.provenance as { contextDigest?: string }).contextDigest ?? '')).toHaveLength(16);
      expect(store.getContextProvenance('run-missing')).toBeUndefined();
      void agentLoop;
    } finally {
      try { store.close(); } catch { /* 已关闭 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
