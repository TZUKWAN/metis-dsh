/**
 * ConversationNodeStore 回归测试（2026-09-05 P0 Phase 1）。
 * 验证：order 引用稳定性、per-key 脏键白名单发布、快照恒等跳过。
 */

import { describe, it, expect } from 'vitest';
import { ConversationNodeStore } from '../../src/conversation/store/conversationNodeStore.js';

interface TestNode {
  key: string;
  content: string;
}

const node = (key: string, content: string): TestNode => ({ key, content });

describe('ConversationNodeStore', () => {
  it('keeps the order array identity stable across node value updates', () => {
    const store = new ConversationNodeStore<TestNode>();
    store.upsert(node('a', '1'));
    store.upsert(node('b', '2'));
    const orderBefore = store.getOrder();

    store.upsert(node('a', '1-updated'));
    expect(store.getOrder()).toBe(orderBefore);

    store.upsert(node('c', '3'));
    expect(store.getOrder()).not.toBe(orderBefore);
    expect([...store.getOrder()]).toEqual(['a', 'b', 'c']);
  });

  it('notifies only the dirty key source on publish', () => {
    const store = new ConversationNodeStore<TestNode>();
    store.upsert(node('a', '1'));
    store.upsert(node('b', '2'));
    store.publish();

    const aNotifications: string[] = [];
    const bNotifications: string[] = [];
    store.source('a').subscribe(() => aNotifications.push('a'));
    store.source('b').subscribe(() => bNotifications.push('b'));

    store.upsert(node('a', '1-updated'));
    store.publish();

    expect(aNotifications).toEqual(['a']);
    expect(bNotifications).toEqual([]);
    expect(store.source('a').get()?.content).toBe('1-updated');
  });

  it('skips notification when the node reference is identical', () => {
    const store = new ConversationNodeStore<TestNode>();
    const same = node('a', '1');
    store.upsert(same);
    store.publish();

    let notifications = 0;
    store.source('a').subscribe(() => {
      notifications += 1;
    });

    store.upsert(same);
    store.publish();
    expect(notifications).toBe(0);

    store.upsert(node('a', '1'));
    store.publish();
    expect(notifications).toBe(1);
  });

  it('removes nodes, updates order, and reports undefined from the source', () => {
    const store = new ConversationNodeStore<TestNode>();
    store.upsert(node('a', '1'));
    store.upsert(node('b', '2'));
    store.publish();

    const orderChanges: number[] = [];
    store.subscribeOrder(() => orderChanges.push(store.getOrder().length));

    store.remove('a');
    store.publish();

    expect(orderChanges).toEqual([1]);
    expect(store.source('a').get()).toBeUndefined();
    expect(store.source('b').get()?.content).toBe('2');
  });

  it('returns a cached per-key source (stable identity for useSyncExternalStore)', () => {
    const store = new ConversationNodeStore<TestNode>();
    expect(store.source('a')).toBe(store.source('a'));
  });
});
