/**
 * Tool result store — caches tool execution results with LRU eviction.
 *
 * Ported from metis/tools/result_store.py.
 */

import type { ToolResult } from '../core/types.js';

const DEFAULT_MAX_SIZE = 256;

export class ResultStore {
  private readonly store = new Map<string, { result: ToolResult; timestamp: number }>();
  private readonly maxSize: number;

  constructor(maxSize = DEFAULT_MAX_SIZE) {
    this.maxSize = maxSize;
  }

  save(toolCallId: string, result: ToolResult): void {
    if (this.store.size >= this.maxSize) {
      // Evict oldest
      const oldest = [...this.store.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      if (oldest) this.store.delete(oldest[0]);
    }
    this.store.set(toolCallId, { result, timestamp: Date.now() });
  }

  get(toolCallId: string): ToolResult | undefined {
    return this.store.get(toolCallId)?.result;
  }

  has(toolCallId: string): boolean {
    return this.store.has(toolCallId);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
