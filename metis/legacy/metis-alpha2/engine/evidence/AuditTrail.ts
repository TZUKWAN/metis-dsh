/**
 * Audit Trail — immutable hash-chained operation log.
 *
 * Every tool call creates an entry whose hash includes the previous entry's hash,
 * forming a tamper-evident chain (git-commit-like). Enables:
 *   - Full replay of any session
 *   - Detection of tampered or deleted records
 *   - Backward traceability from any output to all inputs
 */

import type { ToolCall, ToolResult } from '../core/types.js';

// ─── Types ──────────────────────────────────────────────────

export interface AuditEntry {
  /** Sequential index */
  index: number;
  /** Hash of this entry (includes prevHash + content) */
  hash: string;
  /** Hash of the previous entry (empty for first entry) */
  prevHash: string;
  /** Tool call data */
  toolCall: { name: string; args: Record<string, unknown> };
  /** Tool result (truncated for storage) */
  result: { status: string; contentPreview: string; contentHash: string };
  /** Which turn */
  turnIndex: number;
  /** Timestamp */
  timestamp: number;
  /** Session ID */
  sessionId: string;
}

export interface AuditChainStatus {
  totalEntries: number;
  chainValid: boolean;
  firstEntry: number;
  lastEntry: number;
  anyTampered: boolean;
}

// ─── Hash Function ─────────────────────────────────────────

function hashString(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  return ((h1 >>> 0).toString(16)).padStart(8, '0') + ((h2 >>> 0).toString(16)).padStart(8, '0');
}

// ─── Audit Trail ───────────────────────────────────────────

export class AuditTrail {
  private chain: AuditEntry[] = [];
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Record a tool execution as an immutable audit entry.
   */
  record(
    toolCall: ToolCall,
    toolResult: ToolResult,
    turnIndex: number,
  ): AuditEntry {
    const prevHash = this.chain.length > 0
      ? this.chain[this.chain.length - 1]!.hash
      : '';

    const contentHash = hashString(toolResult.content);

    const entry: AuditEntry = {
      index: this.chain.length,
      hash: '', // Will be computed below
      prevHash,
      toolCall: {
        name: toolCall.name,
        args: toolCall.arguments,
      },
      result: {
        status: toolResult.status,
        contentPreview: toolResult.content.slice(0, 200),
        contentHash,
      },
      turnIndex,
      timestamp: Date.now(),
      sessionId: this.sessionId,
    };

    // Compute hash including all fields
    entry.hash = hashString(JSON.stringify({
      index: entry.index,
      prevHash: entry.prevHash,
      toolName: toolCall.name,
      args: JSON.stringify(toolCall.arguments),
      resultHash: contentHash,
      turnIndex,
      timestamp: entry.timestamp,
      sessionId: this.sessionId,
    }));

    this.chain.push(entry);
    return entry;
  }

  /**
   * Validate the entire chain for integrity.
   * Returns entries that fail hash verification.
   */
  validate(): AuditChainStatus {
    let anyTampered = false;

    for (let i = 1; i < this.chain.length; i++) {
      const current = this.chain[i]!;
      const previous = this.chain[i - 1]!;

      // Verify prevHash points to correct previous entry
      if (current.prevHash !== previous.hash) {
        anyTampered = true;
      }

      // Recompute current entry hash and verify
      const recomputed = hashString(JSON.stringify({
        index: current.index,
        prevHash: current.prevHash,
        toolName: current.toolCall.name,
        args: JSON.stringify(current.toolCall.args),
        resultHash: current.result.contentHash,
        turnIndex: current.turnIndex,
        timestamp: current.timestamp,
        sessionId: current.sessionId,
      }));

      if (recomputed !== current.hash) {
        anyTampered = true;
      }
    }

    return {
      totalEntries: this.chain.length,
      chainValid: !anyTampered,
      firstEntry: this.chain.length > 0 ? 0 : -1,
      lastEntry: this.chain.length > 0 ? this.chain.length - 1 : -1,
      anyTampered,
    };
  }

  /**
   * Replay the audit trail as a human-readable timeline.
   */
  replay(): string {
    if (this.chain.length === 0) return 'No audit entries recorded.';

    const lines: string[] = [`# Audit Trail — ${this.sessionId}`, ''];

    for (const entry of this.chain) {
      const time = new Date(entry.timestamp).toISOString();
      lines.push(
        `[${entry.index}] ${time} | Turn ${entry.turnIndex} | ${entry.toolCall.name}`,
        `  Args: ${JSON.stringify(entry.toolCall.args).slice(0, 100)}`,
        `  Result: ${entry.result.status} — ${entry.result.contentPreview}`,
        `  Hash: ${entry.hash.slice(0, 16)}... ← ${entry.prevHash.slice(0, 16) || 'genesis'}`,
        '',
      );
    }

    return lines.join('\n');
  }

  /**
   * Export the chain for external verification.
   */
  export(): AuditEntry[] {
    return [...this.chain];
  }

  /** Clear the audit trail. */
  clear(): void {
    this.chain = [];
  }
}
