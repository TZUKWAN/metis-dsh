/**
 * Conversation Node Store（2026-09-05 Conversation Streaming P0，Phase 1）。
 *
 * 对应 DeepSeek Harness chat-snapshot-builder.ts + ChatNodeSeat 的本质：
 * - 列表只订阅「稳定 key 的顺序数组」，order 引用仅在节点增删时变化；
 * - 每个节点 key 一个独立的订阅源（useSyncExternalStore 兼容：get 返回的引用
 *   在无变更时恒等，杜绝 React 无限循环）；
 * - publish 只通知 dirty keys（白名单），快照恒等则跳过——
 *   一条消息流式更新时只有它的 Seat 重渲染，其余全部零工作。
 */

export interface ConversationNodeBase {
  key: string;
}

export interface ConversationNodeSource<T> {
  get: () => T | undefined;
  subscribe: (listener: () => void) => () => void;
}

class MutableNodeSource<T extends ConversationNodeBase> {
  readonly listeners = new Set<() => void>();
  private published: T | undefined;
  private publishedExists = false;
  private readonly store: ConversationNodeStore<T>;
  private readonly key: string;

  constructor(store: ConversationNodeStore<T>, key: string) {
    this.store = store;
    this.key = key;
  }

  get = (): T | undefined => {
    return this.store.getNode(this.key);
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 快照恒等则不通知（引用比较，不做深比较——节点必须以新对象表达变更）。 */
  publish(): void {
    const next = this.store.getNode(this.key);
    if (this.publishedExists === (next !== undefined) && this.published === next) return;
    this.published = next;
    this.publishedExists = next !== undefined;
    for (const listener of [...this.listeners]) listener();
  }
}

export class ConversationNodeStore<T extends ConversationNodeBase> {
  private nodes = new Map<string, T>();
  private order: readonly string[] = [];
  private readonly orderListeners = new Set<() => void>();
  private readonly sources = new Map<string, MutableNodeSource<T>>();
  private readonly dirtyKeys = new Set<string>();
  private dirtyOrder = false;

  /** 插入或更新节点。节点以新对象表达变更：同引用 upsert 视为无变更，不进入脏名单。 */
  upsert(node: T): void {
    const previous = this.nodes.get(node.key);
    this.nodes.set(node.key, node);
    if (previous === undefined) {
      this.order = [...this.order, node.key];
      this.dirtyOrder = true;
    }
    if (previous !== node) {
      this.dirtyKeys.add(node.key);
    }
  }

  remove(key: string): void {
    if (!this.nodes.delete(key)) return;
    this.order = this.order.filter((k) => k !== key);
    this.dirtyOrder = true;
    this.dirtyKeys.add(key);
  }

  getNode(key: string): T | undefined {
    return this.nodes.get(key);
  }

  /** 稳定 key 顺序数组；引用仅在增删时变化，节点值更新不改变它。 */
  getOrder(): readonly string[] {
    return this.order;
  }

  subscribeOrder = (listener: () => void): (() => void) => {
    this.orderListeners.add(listener);
    return () => {
      this.orderListeners.delete(listener);
    };
  };

  /** useSyncExternalStore 兼容的 per-key 订阅源（每 key 缓存一个）。 */
  source(key: string): ConversationNodeSource<T> {
    let source = this.sources.get(key);
    if (!source) {
      source = new MutableNodeSource<T>(this, key);
      this.sources.set(key, source);
    }
    return source;
  }

  /**
   * 发布累积的脏变更：order 变更通知一次，节点值只通知 dirty keys。
   * 在 PublicationScheduler 的 flush 回调中调用（frame cadence 或 immediate）。
   */
  publish(): void {
    if (this.dirtyOrder) {
      this.dirtyOrder = false;
      for (const listener of [...this.orderListeners]) listener();
    }
    const dirty = [...this.dirtyKeys];
    this.dirtyKeys.clear();
    for (const key of dirty) {
      this.sources.get(key)?.publish();
    }
  }

  /** 诊断指标：当前节点数。 */
  get size(): number {
    return this.nodes.size;
  }
}
