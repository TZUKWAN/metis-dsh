/**
 * Tests for MemoryManager — local memory system.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MemoryManager } from './MemoryManager.js';
import { PersistenceStore } from '../persistence/PersistenceStore.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-memory-test-'));
}

describe('MemoryManager', () => {
  let dataDir: string;
  let dbPath: string;
  let store: PersistenceStore;
  let manager: MemoryManager;

  beforeEach(() => {
    dataDir = tempDir();
    dbPath = path.join(dataDir, 'test.db');
    store = new PersistenceStore(dbPath);
    manager = new MemoryManager(store, dataDir);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it('loads and saves project memory', () => {
    expect(manager.loadProjectMemory()).toBe('');
    manager.saveProjectMemory('# Project Rules\n- Use TypeScript\n');
    expect(manager.loadProjectMemory()).toBe('# Project Rules\n- Use TypeScript\n');
  });

  it('saves and retrieves conversation summary', () => {
    manager.saveConversationSummary('sess-1', 'Summary of session 1');
    expect(manager.getConversationSummary('sess-1')).toBe('Summary of session 1');
    expect(manager.getConversationSummary('sess-2')).toBe('');
  });

  it('records and retrieves key decisions', () => {
    manager.recordKeyDecision('Use React 19', 'Frontend framework choice');
    const decisions = manager.getKeyDecisions();
    expect(decisions.length).toBe(1);
    expect(decisions[0]?.value).toContain('Use React 19');
    expect(decisions[0]?.value).toContain('Frontend framework choice');
  });

  it('records and retrieves preferences', () => {
    manager.recordPreference('language', 'zh');
    expect(manager.getPreference('language')).toBe('zh');
    expect(manager.getPreference('missing')).toBeUndefined();
  });

  it('builds memory context with all layers', () => {
    manager.saveProjectMemory('# Rules\nBe concise.\n');
    manager.recordKeyDecision('Use Zustand');
    manager.recordPreference('theme', 'dark');

    const ctx = manager.buildMemoryContext();
    expect(ctx).toContain('Project Memory');
    expect(ctx).toContain('Be concise');
    expect(ctx).toContain('Key Decisions');
    expect(ctx).toContain('Use Zustand');
    expect(ctx).toContain('User Preferences');
    expect(ctx).toContain('theme: dark');
  });

  it('returns empty context when no memory', () => {
    expect(manager.buildMemoryContext()).toBe('');
  });

  it('includes recorded key decisions in the memory context', () => {
    manager.recordKeyDecision('Adopted TF-IDF smoothing for small libraries');
    const context = manager.buildMemoryContext();
    expect(context).toContain('Key Decisions');
    expect(context).toContain('TF-IDF smoothing');
  });

  it('includes project memory in the context when saved', () => {
    manager.saveProjectMemory('# Notes\n- Prefer concise answers');
    const context = manager.buildMemoryContext();
    expect(context).toContain('Project Memory');
    expect(context).toContain('concise answers');
  });

  it('general set/get/delete works', () => {
    manager.set('foo', 'bar', 'test');
    expect(manager.get('foo')).toBe('bar');
    manager.delete('foo');
    expect(manager.get('foo')).toBeUndefined();
  });

  it('getByCategory filters correctly', () => {
    manager.set('a', '1', 'cat-a');
    manager.set('b', '2', 'cat-a');
    manager.set('c', '3', 'cat-b');
    expect(manager.getByCategory('cat-a').length).toBe(2);
    expect(manager.getByCategory('cat-b').length).toBe(1);
  });
});
