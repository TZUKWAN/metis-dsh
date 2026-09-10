/**
 * Tests for MessageFork (O16): regenerated-answer branch switching.
 */

import { describe, it, expect } from 'vitest';
import {
  toggleForkActive,
  visibleMessages,
  activeForkSibling,
} from '../../engine/core/MessageFork.js';

interface Msg {
  id: string;
  content: string;
  forkId?: string;
  forkIndex?: number;
  forkCount?: number;
  forkActive?: boolean;
}

describe('toggleForkActive', () => {
  it('flips which sibling is active within a fork group', () => {
    const messages: Msg[] = [
      { id: 'u1', content: 'question' },
      { id: 'a1', content: 'first', forkId: 'f1', forkIndex: 0, forkCount: 2, forkActive: false },
      { id: 'a2', content: 'second', forkId: 'f1', forkIndex: 1, forkCount: 2, forkActive: true },
    ];
    const next = toggleForkActive(messages, 'f1', 0);
    expect(next.find((m) => m.id === 'a1')?.forkActive).toBe(true);
    expect(next.find((m) => m.id === 'a2')?.forkActive).toBe(false);
  });

  it('does not touch messages outside the fork group', () => {
    const messages: Msg[] = [
      { id: 'u1', content: 'question' },
      { id: 'a1', content: 'first', forkId: 'f1', forkIndex: 0, forkActive: false },
      { id: 'other', content: 'unrelated' },
    ];
    const next = toggleForkActive(messages, 'f1', 0);
    expect(next.find((m) => m.id === 'other')).toEqual({ id: 'other', content: 'unrelated' });
  });

  it('returns a new array (immutability)', () => {
    const messages: Msg[] = [{ id: 'a1', content: 'x', forkId: 'f1', forkIndex: 0, forkActive: false }];
    const next = toggleForkActive(messages, 'f1', 0);
    expect(next).not.toBe(messages);
  });
});

describe('visibleMessages', () => {
  it('hides inactive fork siblings, keeps active and non-fork messages', () => {
    const messages: Msg[] = [
      { id: 'u1', content: 'q' },
      { id: 'a1', content: 'first', forkId: 'f1', forkIndex: 0, forkActive: false },
      { id: 'a2', content: 'second', forkId: 'f1', forkIndex: 1, forkActive: true },
    ];
    const visible = visibleMessages(messages);
    expect(visible.map((m) => m.id)).toEqual(['u1', 'a2']);
  });

  it('keeps everything when there are no forks', () => {
    const messages: Msg[] = [{ id: 'u1', content: 'q' }, { id: 'a1', content: 'a' }];
    expect(visibleMessages(messages)).toHaveLength(2);
  });
});

describe('activeForkSibling', () => {
  it('returns the active sibling of a fork group', () => {
    const messages: Msg[] = [
      { id: 'a1', content: 'first', forkId: 'f1', forkIndex: 0, forkActive: false },
      { id: 'a2', content: 'second', forkId: 'f1', forkIndex: 1, forkActive: true },
    ];
    expect(activeForkSibling(messages, 'f1')?.id).toBe('a2');
  });
});

// ─── Fork persistence (O16) ─────────────────────────────────

import { loadForkMap, saveForkMap, type ForkRecord } from '../../engine/core/MessageFork.js';

class FakeStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
}

describe('fork persistence (O16)', () => {
  it('round-trips a fork map through injected storage', () => {
    const storage = new FakeStorage();
    const record: ForkRecord = { forkId: 'f1', forkIndex: 0, forkCount: 2, content: 'first answer', timestamp: 1 };
    const map = new Map<string, ForkRecord>([['f1', record]]);
    saveForkMap('sess-1', map, storage);
    const loaded = loadForkMap('sess-1', storage);
    expect(loaded.get('f1')?.content).toBe('first answer');
    expect(loaded.get('f1')?.forkCount).toBe(2);
  });

  it('returns an empty map for a missing or malformed entry', () => {
    const storage = new FakeStorage();
    expect(loadForkMap('missing', storage).size).toBe(0);
    storage.setItem('metis-fork-map:bad', '{not json');
    expect(loadForkMap('bad', storage).size).toBe(0);
  });

  it('does not write when storage is null (DOM-free)', () => {
    expect(() => saveForkMap('s', new Map(), null)).not.toThrow();
    expect(loadForkMap('s', null).size).toBe(0);
  });
});
