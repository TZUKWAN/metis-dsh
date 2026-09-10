/**
 * LearningEngine — autonomous learning A/B/C:
 *   A. memory-driven extraction (decisions / preferences / experiences)
 *   B. prompt adaptation from user feedback signals
 *   C. tool usage optimization via reliability statistics
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LearningEngine } from '../../engine/learning/LearningEngine.js';
import { MemoryManager } from '../../engine/memory/MemoryManager.js';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { FakeProvider } from '../../engine/providers/FakeProvider.js';
import type { ChatMessage } from '../../engine/core/types.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-learning-test-'));
}

function user(text: string): ChatMessage {
  return { role: 'user', content: text };
}

function assistant(text: string): ChatMessage {
  return { role: 'assistant', content: text };
}

describe('LearningEngine', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;
  let memory: MemoryManager;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
    memory = new MemoryManager(store, dataDir);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  describe('C — tool usage optimization', () => {
    it('records outcomes and builds guidance from reliable tools', () => {
      const engine = new LearningEngine({ store });
      engine.recordToolOutcome({ name: 'web_search', status: 'ok' });
      engine.recordToolOutcome({ name: 'web_search', status: 'ok' });
      engine.recordToolOutcome({ name: 'web_search', status: 'ok' });
      engine.recordToolOutcome({ name: 'web_fetch', status: 'ok' });
      engine.recordToolOutcome({ name: 'web_fetch', status: 'error' });
      engine.recordToolOutcome({ name: 'web_fetch', status: 'error' });

      const stats = engine.getToolStats();
      expect(stats.get('web_search')).toEqual({ attempts: 3, failures: 0 });
      expect(stats.get('web_fetch')).toEqual({ attempts: 3, failures: 2 });

      const guidance = engine.buildToolGuidance();
      expect(guidance).toContain('web_search');
      expect(guidance).toContain('web_fetch');
      // web_search (100%) is listed before web_fetch (33%)
      expect(guidance.indexOf('web_search')).toBeLessThan(guidance.indexOf('web_fetch'));
      // web_fetch's low success rate is flagged
      expect(guidance).toContain('失败率偏高');
    });

    it('hides tools with too few attempts (noise guard)', () => {
      const engine = new LearningEngine({ store });
      engine.recordToolOutcome({ name: 'rare_tool', status: 'ok' });
      engine.recordToolOutcome({ name: 'rare_tool', status: 'ok' });
      expect(engine.buildToolGuidance()).toBe('');
    });

    it('persists stats and restores them on a new engine', () => {
      const engine = new LearningEngine({ store });
      engine.recordToolOutcome({ name: 'read_pdf', status: 'ok' });
      engine.recordToolOutcome({ name: 'read_pdf', status: 'ok' });
      engine.recordToolOutcome({ name: 'read_pdf', status: 'error' });
      engine.persistToolStats();

      const restored = new LearningEngine({ store });
      expect(restored.getToolStats().get('read_pdf')).toEqual({ attempts: 3, failures: 1 });
    });
  });

  describe('B — prompt adaptation from feedback', () => {
    it('detects verbosity feedback', () => {
      const engine = new LearningEngine({ memory });
      const signals = engine.detectFeedbackSignals([
        assistant('这是一份很长的综述……'),
        user('太长了，简短一点'),
      ]);
      expect(signals).toContainEqual({ key: 'behavior:verbosity', value: 'concise' });
    });

    it('detects table preference', () => {
      const engine = new LearningEngine({ memory });
      const signals = engine.detectFeedbackSignals([user('把这些数据用表格整理一下')]);
      expect(signals).toContainEqual({ key: 'behavior:format', value: 'table' });
    });

    it('detects language preference', () => {
      const engine = new LearningEngine({ memory });
      const signals = engine.detectFeedbackSignals([user('请用中文回答')]);
      expect(signals).toContainEqual({ key: 'behavior:language', value: 'zh' });
    });

    it('persists signals as behavior preferences', () => {
      const engine = new LearningEngine({ memory });
      engine.applyFeedbackSignals([user('不要用列表，写成段落')]);
      expect(memory.getPreference('behavior:format')).toBe('prose');
    });

    it('builds a human-readable preference fragment into the prompt', () => {
      const engine = new LearningEngine({ memory });
      engine.applyFeedbackSignals([user('太啰嗦了，说中文')]);
      const ctx = engine.buildBehaviorPreferences();
      expect(ctx).toContain('回答应简洁精炼');
      expect(ctx).toContain('使用中文回答');
      expect(ctx).toContain('用户偏好');
    });

    it('returns empty when no behavior preferences exist', () => {
      const engine = new LearningEngine({ memory });
      expect(engine.buildBehaviorPreferences()).toBe('');
    });
  });

  describe('A — memory-driven extraction', () => {
    it('extracts decisions, preferences and experiences into memory', async () => {
      const provider = new FakeProvider({
        response: JSON.stringify({
          decisions: ['项目使用 TypeScript 严格模式'],
          preferences: [{ key: 'language', value: 'zh' }],
          experiences: ['调研文献时应优先使用 web_search 进行交叉验证'],
        }),
      });
      const engine = new LearningEngine({ memory, provider, store });
      await engine.ingestConversation([
        user('我们决定项目用 TypeScript 严格模式，帮我调研一下相关资料'),
        assistant('好的，我会先搜索资料再给出建议。'),
      ], 'proj-1');

      const decisions = memory.getByCategory('key_decision', 'proj-1');
      expect(decisions.some((d) => d.value.includes('TypeScript'))).toBe(true);
      expect(memory.getPreference('language', 'proj-1')).toBe('zh');
      const experiences = memory.getByCategory('experience', 'proj-1');
      expect(experiences.some((e) => e.value.includes('web_search'))).toBe(true);
    });

    it('skips trivial turns without calling the provider', async () => {
      const provider = new FakeProvider({ response: JSON.stringify({ decisions: ['X'], preferences: [], experiences: [] }) });
      const engine = new LearningEngine({ memory, provider, store });
      await engine.ingestConversation([user('继续')]);
      expect(memory.getByCategory('key_decision')).toHaveLength(0);
    });

    it('degrades silently on malformed extraction output', async () => {
      const provider = new FakeProvider({ response: '抱歉，我无法处理这个请求。' });
      const engine = new LearningEngine({ memory, provider, store });
      await expect(engine.ingestConversation([user('这是一条足够长的用户消息，用来触发提取流程，包含足够的信息量以便模型进行知识抽取。')])).resolves.toBeUndefined();
      expect(memory.getByCategory('key_decision')).toHaveLength(0);
    });

    it('parses fenced JSON output', async () => {
      const provider = new FakeProvider({
        response: '```json\n{"decisions": ["采用 vitest 作为测试框架"], "preferences": [], "experiences": []}\n```',
      });
      const engine = new LearningEngine({ memory, provider, store });
      await engine.ingestConversation([user('这是一条足够长的用户消息，用来触发提取流程，包含足够的信息量以便模型进行知识抽取。')]);
      const decisions = memory.getByCategory('key_decision');
      expect(decisions.some((d) => d.value.includes('vitest'))).toBe(true);
    });
  });

  describe('combined context', () => {
    it('merges behavior preferences and tool guidance', () => {
      const engine = new LearningEngine({ memory, store });
      engine.recordToolOutcome({ name: 'web_search', status: 'ok' });
      engine.recordToolOutcome({ name: 'web_search', status: 'ok' });
      engine.recordToolOutcome({ name: 'web_search', status: 'ok' });
      engine.applyFeedbackSignals([user('说中文')]);
      const ctx = engine.buildLearningContext();
      expect(ctx).toContain('工具可靠性');
      expect(ctx).toContain('使用中文回答');
    });

    it('returns empty string when nothing was learned yet', () => {
      const engine = new LearningEngine({ memory, store });
      expect(engine.buildLearningContext()).toBe('');
    });
  });

  describe('feedback rule coverage (all rule keys)', () => {
    it('covers every rule in the table with a signal', () => {
      const engine = new LearningEngine({ memory });
      const cases: Array<[string, string, string]> = [
        ['太长了', 'behavior:verbosity', 'concise'],
        ['请详细一点', 'behavior:verbosity', 'detailed'],
        ['别用列表', 'behavior:format', 'prose'],
        ['用列表列出来', 'behavior:format', 'bullets'],
        ['做成表格', 'behavior:format', 'table'],
        ['用中文', 'behavior:language', 'zh'],
        ['in English please', 'behavior:language', 'en'],
        ['轻松一点', 'behavior:tone', 'casual'],
        ['正式一点', 'behavior:tone', 'formal'],
      ];
      for (const [text, key, value] of cases) {
        const signals = engine.detectFeedbackSignals([user(text)]);
        expect(signals).toContainEqual({ key, value });
      }
    });
  });

  describe('error resilience', () => {
    it('never throws when provider fails', async () => {
      const failingProvider = new FakeProvider({ response: 'x' });
      vi.spyOn(failingProvider, 'complete').mockRejectedValue(new Error('network down'));
      const engine = new LearningEngine({ memory, provider: failingProvider, store });
      await expect(engine.ingestConversation([user('这是一条足够长的用户消息，用来触发提取流程，包含足够的信息量以便模型进行知识抽取。')])).resolves.toBeUndefined();
    });

    it('recordToolOutcome ignores malformed input', () => {
      const engine = new LearningEngine({ store });
      expect(() => engine.recordToolOutcome({ name: '', status: 'ok' })).not.toThrow();
      expect(engine.getToolStats().size).toBe(0);
    });
  });
});
