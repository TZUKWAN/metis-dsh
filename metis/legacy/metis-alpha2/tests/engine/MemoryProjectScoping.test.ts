/**
 * @vitest-environment node
 *
 * METIS-F12 — project-scoped memory isolation, remember/recall tools, and the
 * memory migration for legacy databases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { MemoryManager } from '../../engine/memory/MemoryManager.js';
import {
  MEMORY_REMEMBER_TOOL,
  MEMORY_RECALL_TOOL,
  getMemoryToolSpecs,
  getMemoryToolHandlers,
} from '../../engine/tools/builtin/MemoryTools.js';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { registerBuiltinTools } from '../../engine/tools/index.js';
import { FakeProvider } from '../../engine/providers/FakeProvider.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-memory-'));
}

describe('PersistenceStore project-scoped memory', () => {
  let dir: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dir = tempDir();
    store = new PersistenceStore(path.join(dir, 'metis.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('scopes identical keys to separate projects without collision', () => {
    store.setMemoryScoped('proj-a', 'theme', 'chunking', 'general');
    store.setMemoryScoped('proj-b', 'theme', 'attention', 'general');

    expect(store.getMemoryScoped('proj-a', 'theme')?.value).toBe('chunking');
    expect(store.getMemoryScoped('proj-b', 'theme')?.value).toBe('attention');
    // The namespaced rows are stored under distinct physical keys.
    expect(store.listMemoryKeys('proj-a')).toHaveLength(1);
    expect(store.listMemoryKeys('proj-b')).toHaveLength(1);
  });

  it('keeps legacy global memory API behavior unchanged', () => {
    store.setMemory('global-key', 'legacy value', 'general');

    expect(store.getMemory('global-key')?.value).toBe('legacy value');
    expect(store.getMemoryByCategory('general').map((e) => e.key)).toEqual(['global-key']);
    // Project queries never see global rows.
    expect(store.getMemoryByCategory('general', 'proj-a')).toHaveLength(0);
  });

  it('filters category queries by project and combines via the manager', () => {
    store.setMemoryScoped('proj-a', 'k1', 'v-a', 'key_decision');
    store.setMemoryScoped('proj-b', 'k2', 'v-b', 'key_decision');
    store.setMemory('global-dec', 'v-global', 'key_decision');

    const projectEntries = store.getMemoryByCategory('key_decision', 'proj-a');
    expect(projectEntries.map((e) => e.value)).toEqual(['v-a']);
    const globalEntries = store.getMemoryByCategory('key_decision');
    expect(globalEntries.map((e) => e.value)).toEqual(['v-global']);
  });

  it('deletes scoped entries without touching other projects', () => {
    store.setMemoryScoped('proj-a', 'key', 'value-a');
    store.setMemoryScoped('proj-b', 'key', 'value-b');

    store.deleteMemoryScoped('proj-a', 'key');
    expect(store.getMemoryScoped('proj-a', 'key')).toBeUndefined();
    expect(store.getMemoryScoped('proj-b', 'key')?.value).toBe('value-b');
  });
});

describe('memory migration for legacy databases (METIS-F12, unified pipeline v112)', () => {
  it('adds the project_id column through the real startup pipeline, idempotently', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'legacy.db');
    const db = new Database(dbPath);
    // Simulate a legacy database: memory exists WITHOUT project_id.
    db.exec(`
      CREATE TABLE memory (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'general',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO memory (key, value, category, created_at, updated_at)
        VALUES ('legacy', 'data', 'general', 1, 1);
    `);
    db.close();

    // The real startup path: PersistenceStore runs baseline + migrations + health checks.
    const store = new PersistenceStore(dbPath);
    const raw = store.raw;
    const cols = (raw.prepare('PRAGMA table_info(memory)').all() as Array<{ name: string }>).map((row) => row.name);
    expect(cols).toContain('project_id');
    // Legacy rows remain visible as global memory.
    const row = raw.prepare('SELECT * FROM memory WHERE key = ?').get('legacy') as { project_id: unknown };
    expect(row.project_id).toBeNull();
    // The migration was recorded.
    expect((raw.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number }).v)
      .toBeGreaterThanOrEqual(112);
    store.close();

    // Reopening is a no-op: no pending migrations, row untouched.
    const store2 = new PersistenceStore(dbPath);
    const again = store2.getLastMigrationResult();
    expect(again?.appliedVersions).toEqual([]);
    const row2 = store2.raw.prepare('SELECT * FROM memory WHERE key = ?').get('legacy') as { project_id: unknown };
    expect(row2.project_id).toBeNull();
    store2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('MemoryManager project scoping', () => {
  let dir: string;
  let store: PersistenceStore;
  let manager: MemoryManager;

  beforeEach(() => {
    dir = tempDir();
    store = new PersistenceStore(path.join(dir, 'metis.db'));
    manager = new MemoryManager(store, dir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('isolates key decisions per project in buildMemoryContext', () => {
    manager.recordKeyDecision('Use chunk size 512', undefined, 'proj-a');
    manager.recordKeyDecision('Use RoPE embeddings', undefined, 'proj-b');

    const contextA = manager.buildMemoryContext('proj-a');
    expect(contextA).toContain('Use chunk size 512');
    expect(contextA).not.toContain('RoPE');
    const contextB = manager.buildMemoryContext('proj-b');
    expect(contextB).toContain('RoPE');
    expect(contextB).not.toContain('chunk size 512');
  });

  it('keeps global decisions out of project contexts; only explicit global calls see them', () => {
    manager.recordKeyDecision('Global policy: never fabricate citations');
    manager.recordKeyDecision('Project specific note', undefined, 'proj-a');

    // 任务2 上下文隔离（默认隔离，显式共享）：全局行可能来自其他项目对话的
    // 自动提取（key_decision/preference），不得混入任何项目的 prompt——项目
    // 上下文只含本项目 scoped 行；仅显式 global 调用（无 projectId）读全局行。
    const contextA = manager.buildMemoryContext('proj-a');
    expect(contextA).toContain('Project specific note');
    expect(contextA).not.toContain('never fabricate citations');

    const contextB = manager.buildMemoryContext('proj-b');
    expect(contextB).not.toContain('never fabricate citations');

    const globalContext = manager.buildMemoryContext();
    expect(globalContext).toContain('never fabricate citations');
    expect(globalContext).not.toContain('Project specific note');
  });

  it('isolates per-project memory files from the global CLAUDE_MEMORY.md and each other', () => {
    manager.saveProjectMemory('全局记忆 g77：跨项目通用说明');
    manager.saveProjectMemory('A-only-file-marker-k3：A 项目专用记忆', 'proj-a');
    manager.saveProjectMemory('B-only-file-marker-m8：B 项目专用记忆', 'proj-b');

    expect(manager.buildMemoryContext('proj-a')).toContain('A-only-file-marker-k3');
    expect(manager.buildMemoryContext('proj-a')).not.toContain('B-only-file-marker-m8');
    expect(manager.buildMemoryContext('proj-a')).not.toContain('全局记忆 g77');
    expect(manager.buildMemoryContext('proj-b')).toContain('B-only-file-marker-m8');
    expect(manager.buildMemoryContext('proj-b')).not.toContain('A-only-file-marker-k3');
    // 显式 global 调用（无 projectId）读全局文件。
    expect(manager.buildMemoryContext()).toContain('全局记忆 g77');
    expect(manager.buildMemoryContext()).not.toContain('A-only-file-marker-k3');
  });

  it('scopes preferences via the manager API', () => {
    manager.recordPreference('language', '中文', 'proj-a');
    manager.recordPreference('language', 'English', 'proj-b');

    expect(manager.getPreference('language', 'proj-a')).toBe('中文');
    expect(manager.getPreference('language', 'proj-b')).toBe('English');
    expect(manager.getPreference('language')).toBeUndefined();
  });
});

describe('memory tools (METIS-F12)', () => {
  let dir: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dir = tempDir();
    store = new PersistenceStore(path.join(dir, 'metis.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const context = (projectId?: string) => ({ projectId } as never);

  it('registers both memory tools in the builtin registry', () => {
    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);
    registerBuiltinTools(registry, dispatcher);
    const names = registry.list().map((t) => t.name);
    expect(names).toContain(MEMORY_REMEMBER_TOOL.name);
    expect(names).toContain(MEMORY_RECALL_TOOL.name);
    expect(getMemoryToolSpecs().length).toBe(2);
  });

  it('remembers into the active project when projectId is present', async () => {
    const handlers = getMemoryToolHandlers(store);
    const remember = handlers.get(MEMORY_REMEMBER_TOOL.name)!;
    const result = await remember(
      { content: 'The evaluation uses top-5 accuracy', category: 'key_decision', key: 'eval-metric' },
      context('proj-a'),
    );
    expect(result).toContain('memory_remembered');
    expect(result).toContain('project=proj-a');
    expect(store.getMemoryScoped('proj-a', 'eval-metric')?.value).toBe('The evaluation uses top-5 accuracy');

    const recall = handlers.get(MEMORY_RECALL_TOOL.name)!;
    const recalled = await recall({ category: 'key_decision' }, context('proj-a'));
    expect(recalled).toContain('The evaluation uses top-5 accuracy');
  });

  it('never leaks another project\'s memories into recall', async () => {
    const handlers = getMemoryToolHandlers(store);
    await handlers.get(MEMORY_REMEMBER_TOOL.name)!(
      { content: 'Secret of project A' },
      context('proj-a'),
    );
    await handlers.get(MEMORY_REMEMBER_TOOL.name)!(
      { content: 'Secret of project B' },
      context('proj-b'),
    );

    const recalled = await handlers.get(MEMORY_RECALL_TOOL.name)!({}, context('proj-a'));
    expect(recalled).toContain('Secret of project A');
    expect(recalled).not.toContain('Secret of project B');
  });

  it('writes to global memory and says so when no project scope exists', async () => {
    const handlers = getMemoryToolHandlers(store);
    const result = await handlers.get(MEMORY_REMEMBER_TOOL.name)!(
      { content: 'global note', key: 'g1' },
      context(),
    );
    expect(result).toContain('scope=global');
    expect(store.getMemory('g1')?.value).toBe('global note');
  });

  it('rejects empty content and reports an unavailable store', async () => {
    const handlers = getMemoryToolHandlers(store);
    const remember = handlers.get(MEMORY_REMEMBER_TOOL.name)!;
    const empty = await remember({ content: '   ' }, context('proj-a'));
    expect(empty).toContain('content is required');

    const noStore = getMemoryToolHandlers(undefined);
    const unavailable = await noStore.get(MEMORY_REMEMBER_TOOL.name)!(
      { content: 'x' },
      context('proj-a'),
    );
    expect(unavailable).toContain('memory_unavailable');
  });

  it('forwards projectId from AgentRunRequest into the tool context', async () => {
    // A registry tool that echoes its context projectId.
    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);
    const captured: string[] = [];
    registry.register({
      name: 'probe_project',
      description: 'probe',
      parameters: { type: 'object', properties: {}, required: [] },
    });
    dispatcher.registerHandler('probe_project', async (_args, toolCtx) => {
      captured.push(toolCtx.projectId ?? '');
      return `project=${toolCtx.projectId ?? ''}`;
    });
    // Scripted two-round provider: first round requests the tool, second finishes.
    const provider = new (class extends FakeProvider {
      private calls = 0;
      override async complete(): Promise<import('../../engine/core/types.js').NormalizedResponse> {
        this.calls++;
        if (this.calls === 1) {
          return {
            content: '',
            toolCalls: [{ name: 'probe_project', arguments: {}, id: 'p1' }],
            finishReason: 'tool_calls',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        }
        return {
          content: 'done',
          toolCalls: [],
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      }
      override completeStream: FakeProvider['completeStream'] = () => {
        throw new Error('no streaming in this probe');
      };
    })();
    const loop = new AgentLoop({ provider, registry, dispatcher });
    const result = await loop.run({
      messages: [{ role: 'user', content: 'probe' }],
      maxTurns: 2,
      sessionId: 's1',
      taskContractHash: '',
      promptStackHash: '',
      resumeFromCheckpoint: false,
      requestId: 'r1',
      projectId: 'proj-x',
    });
    expect(result.status).toBe('completed');
    expect(captured).toEqual(['proj-x']);
  });
});
