/**
 * Evidence ledger — records and verifies tool call evidence chains.
 *
 * Ported from metis/evidence/ledger.py + metis/evidence/extractor.py.
 */

import type { ToolResult } from '../core/types.js';

// ─── Evidence Types ───────────────────────────────────────────

export interface EvidenceEntry {
  id: string;
  toolName: string;
  toolCallId: string;
  sessionId: string;
  timestamp: number;
  inputHash: string;
  outputHash: string;
  status: 'verified' | 'unverified' | 'failed';
  metadata: Record<string, unknown>;
}

export interface VerificationResult {
  verified: boolean;
  issues: string[];
}

// ─── Evidence Ledger ──────────────────────────────────────────

export class EvidenceLedger {
  private readonly entries = new Map<string, EvidenceEntry>();

  /**
   * Record evidence from a tool execution.
   */
  record(
    toolResult: ToolResult,
    sessionId: string,
    inputArgs: Record<string, unknown>,
  ): EvidenceEntry {
    const id = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry: EvidenceEntry = {
      id,
      toolName: toolResult.toolName,
      toolCallId: toolResult.toolCallId,
      sessionId,
      timestamp: Date.now(),
      inputHash: hashObject(inputArgs),
      outputHash: hashString(toolResult.content),
      status: toolResult.status === 'ok' ? 'unverified' : 'failed',
      metadata: {
        ...toolResult.metadata,
        _rawInput: JSON.stringify(inputArgs),
        _rawOutput: typeof toolResult.content === "string" ? toolResult.content : JSON.stringify(toolResult.content),
      },
    };
    this.entries.set(id, entry);
    return entry;
  }

  /**
   * Verify evidence integrity.
   */
  verify(entryId: string): VerificationResult {
    const entry = this.entries.get(entryId);
    if (!entry) {
      return { verified: false, issues: ['Evidence entry not found'] };
    }

    const issues: string[] = [];

    if (!entry.inputHash) issues.push('Missing input hash');
    if (!entry.outputHash) issues.push('Missing output hash');
    if (entry.status === 'failed') issues.push('Tool execution failed');

    // Recompute hashes from stored raw data and compare
    const rawInput = entry.metadata._rawInput as string | undefined;
    const rawOutput = entry.metadata._rawOutput as string | undefined;

    if (rawInput !== undefined) {
      const recomputedInputHash = hashString(rawInput);
      if (recomputedInputHash !== entry.inputHash) {
        issues.push(`Input hash mismatch: stored=${entry.inputHash}, recomputed=${recomputedInputHash}`);
      }
    } else {
      issues.push('No raw input data stored for hash verification');
    }

    if (rawOutput !== undefined) {
      const recomputedOutputHash = hashString(rawOutput);
      if (recomputedOutputHash !== entry.outputHash) {
        issues.push(`Output hash mismatch: stored=${entry.outputHash}, recomputed=${recomputedOutputHash}`);
      }
    } else {
      issues.push('No raw output data stored for hash verification');
    }

    return {
      verified: issues.length === 0,
      issues,
    };
  }

  /**
   * Get all evidence for a session.
   */
  getBySession(sessionId: string): EvidenceEntry[] {
    return [...this.entries.values()].filter((e) => e.sessionId === sessionId);
  }

  /**
   * Get a specific evidence entry.
   */
  get(id: string): EvidenceEntry | undefined {
    return this.entries.get(id);
  }

  get size(): number {
    return this.entries.size;
  }
}

// ─── Tool Evidence Extractor ──────────────────────────────────

export class ToolEvidenceExtractor {
  /**
   * Extract evidence-worthy data from a tool result.
   */
  extract(toolResult: ToolResult): {
    hasFileEvidence: boolean;
    filePaths: string[];
    hasDataEvidence: boolean;
    dataIndicators: string[];
  } {
    const content = toolResult.content;

    return {
      hasFileEvidence: /\/[\w.-]+\.\w{1,10}/.test(content),
      filePaths: extractPaths(content),
      hasDataEvidence: /\d+/.test(content) && content.length > 50,
      dataIndicators: extractDataIndicators(content),
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function hashString(text: string): string {
  // Simple hash — for evidence integrity, not cryptographic
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return Math.abs(hash).toString(36);
}

function hashObject(obj: Record<string, unknown>): string {
  return hashString(JSON.stringify(obj));
}

function extractPaths(text: string): string[] {
  const matches = text.match(/(?:\/[\w.-]+)+\.\w{1,10}|(?:[A-Z]:\\[\w.-]+)+\.\w{1,10}/g);
  return matches ?? [];
}

function extractDataIndicators(text: string): string[] {
  const indicators: string[] = [];
  if (/\d+\s*(lines?|rows?|entries?|records?|files?)/i.test(text)) {
    indicators.push('count');
  }
  if (/error|fail|exception/i.test(text)) {
    indicators.push('error');
  }
  if (/success|ok|complete/i.test(text)) {
    indicators.push('success');
  }
  return indicators;
}
