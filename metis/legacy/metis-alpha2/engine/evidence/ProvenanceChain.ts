/**
 * Provenance Chain — traceability system for LLM-generated claims.
 *
 * Every declarative statement in agent output can be traced back to:
 *   1. A specific tool call (which tool, with what args, returning what data)
 *   2. A specific LLM reasoning step (which turn, what prompt)
 *   3. An external verified source (DOI, arXiv ID, verified URL)
 *
 * This is the foundation of Metis's "trust but verify" research integrity system.
 */

import type { ToolResult, ToolCall } from '../core/types.js';

// ─── Types ──────────────────────────────────────────────────

export type ProvenanceSource = 'tool_result' | 'llm_reasoning' | 'external_source' | 'unknown';

export interface ProvenanceEntry {
  /** Unique ID for this provenance record */
  id: string;
  /** The claim being made (exact text from agent output) */
  claim: string;
  /** What kind of source supports this claim */
  sourceType: ProvenanceSource;
  /** Which turn (0-indexed) did this claim originate */
  turnIndex: number;
  /** Which tool call produced the evidence (if sourceType === 'tool_result') */
  toolCall?: { name: string; args: Record<string, unknown>; id: string };
  /** Reference to the tool result that supports the claim */
  toolResultId?: string;
  /** External reference (DOI, arXiv ID, URL) */
  externalRef?: string;
  /** Confidence assessment (0-1): how strongly does the source support the claim */
  confidence: number;
  /** The evidence text that supports the claim */
  evidence: string;
  /** Timestamp when this provenance was recorded */
  timestamp: number;
}

export interface ProvenanceReport {
  /** All provenance entries for this session */
  entries: ProvenanceEntry[];
  /** Claims that could NOT be traced to any source */
  unverifiableClaims: string[];
  /** Claims that contradict tool results */
  contradictoryClaims: Array<{ claim: string; evidence: string }>;
  /** Summary statistics */
  stats: {
    totalClaims: number;
    verifiedCount: number;
    unverifiableCount: number;
    contradictoryCount: number;
    averageConfidence: number;
  };
  /** Session ID */
  sessionId: string;
  /** When this report was generated */
  generatedAt: number;
}

// ─── Hash Utility ──────────────────────────────────────────

function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

// ─── Provenance Chain ──────────────────────────────────────

export class ProvenanceChain {
  private entries: ProvenanceEntry[] = [];
  private sessionId: string;
  private toolResults = new Map<string, ToolResult>();
  private externalRefs = new Map<string, { verified: boolean; metadata: Record<string, string> }>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Record a tool result for later provenance lookup. */
  recordToolResult(result: ToolResult): void {
    this.toolResults.set(result.toolCallId, result);
  }

  /** Register a verified external reference. */
  registerExternalRef(ref: string, verified: boolean, metadata?: Record<string, string>): void {
    this.externalRefs.set(ref, { verified, metadata: metadata ?? {} });
  }

  /**
   * Create a provenance entry linking a claim to its supporting evidence.
   * Called whenever the agent makes a factual statement.
   */
  trace(
    claim: string,
    sourceType: ProvenanceSource,
    turnIndex: number,
    options?: {
      toolCall?: ToolCall;
      toolResultId?: string;
      externalRef?: string;
      confidence?: number;
      evidence?: string;
    },
  ): ProvenanceEntry {
    const entry: ProvenanceEntry = {
      id: `prov-${simpleHash(claim + Date.now().toString())}`,
      claim: claim.slice(0, 500), // Truncate very long claims
      sourceType,
      turnIndex,
      toolCall: options?.toolCall ? {
        name: options.toolCall.name,
        args: options.toolCall.arguments,
        id: options.toolCall.id,
      } : undefined,
      toolResultId: options?.toolResultId,
      externalRef: options?.externalRef,
      confidence: options?.confidence ?? this.estimateConfidence(sourceType, options?.evidence),
      evidence: options?.evidence ?? claim,
      timestamp: Date.now(),
    };
    this.entries.push(entry);
    return entry;
  }

  /**
   * Auto-extract claims from agent output text and attempt to trace them.
   * Uses heuristic pattern matching for common research claims.
   */
  autoTrace(agentOutput: string, turnIndex: number, toolResults?: ToolResult[]): ProvenanceEntry[] {
    const newEntries: ProvenanceEntry[] = [];

    // Pattern 1: Numerical claims ("accuracy: 0.92", "F1 score of 0.87", "95.3%")
    const numPattern = /(\b(?:accuracy|precision|recall|F1|BLEU|perplexity|loss|AUC|MAPE|score)\b[:\s]*\d+\.?\d*%?)/gi;
    // Pattern 2: DOI references ("10.xxxx/xxxxx")
    const doiPattern = /\b(10\.\d{4,}\/[\w._\-()/]+)\b/g;
    // Pattern 3: arXiv ID references ("arXiv:xxxx.xxxxx")
    const arxivPattern = /\b(?:arXiv:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?)\b/g;
    // Pattern 4: Comparative / superlative claims ("outperforms", "state-of-the-art", "better than")
    const comparePattern = /\b(?:outperforms?|state-of-the-art|better than|superior|achieves|improves? by|reduces? by)\b/gi;

    const numericalClaims = agentOutput.match(numPattern);
    const doiRefs = agentOutput.match(doiPattern);
    const arxivRefs = agentOutput.match(arxivPattern);
    const comparativeClaims = agentOutput.match(comparePattern);

    // Trace numerical claims against tool results
    if (numericalClaims && toolResults) {
      for (const claim of numericalClaims) {
        const matchingResult = toolResults.find((tr) =>
          tr.content.toLowerCase().includes(claim.toLowerCase())
        );
        if (matchingResult) {
          newEntries.push(this.trace(claim, 'tool_result', turnIndex, {
            toolResultId: matchingResult.toolCallId,
            evidence: matchingResult.content.slice(0, 500),
            confidence: 0.9,
          }));
        } else {
          newEntries.push(this.trace(claim, 'unknown', turnIndex, { confidence: 0.3 }));
        }
      }
    }

    // Trace DOI references
    if (doiRefs) {
      for (const doi of doiRefs) {
        const verified = this.externalRefs.get(doi);
        newEntries.push(this.trace(doi, 'external_source', turnIndex, {
          externalRef: doi,
          confidence: verified?.verified ? 0.95 : 0.4,
          evidence: `DOI: ${doi}`,
        }));
      }
    }

    // Trace arXiv references
    if (arxivRefs) {
      for (const arxivId of arxivRefs) {
        const verified = this.externalRefs.get(arxivId);
        newEntries.push(this.trace(arxivId, 'external_source', turnIndex, {
          externalRef: arxivId,
          confidence: verified?.verified ? 0.85 : 0.4,
          evidence: `arXiv: ${arxivId}`,
        }));
      }
    }

    // Mark comparative claims as llm_reasoning (need human/LLM verification)
    if (comparativeClaims) {
      for (const claim of comparativeClaims) {
        newEntries.push(this.trace(claim, 'llm_reasoning', turnIndex, { confidence: 0.5 }));
      }
    }

    return newEntries;
  }

  /**
   * Detect contradictions between agent claims and tool results.
   */
  detectContradictions(): Array<{ claim: string; evidence: string }> {
    const contradictions: Array<{ claim: string; evidence: string }> = [];

    for (const entry of this.entries) {
      if (entry.sourceType === 'tool_result' && entry.toolResultId && this.toolResults.has(entry.toolResultId)) {
        // Extract numeric values and compare
        const claimNums = entry.claim.match(/\d+\.?\d*/g);
        const evidenceNums = entry.evidence.match(/\d+\.?\d*/g);

        if (claimNums && evidenceNums && claimNums.length > 0 && evidenceNums.length > 0) {
          // Check if main numeric claim is significantly different from evidence
          const claimVal = parseFloat(claimNums[0] ?? '0');
          const evidenceVal = parseFloat(evidenceNums[0] ?? '0');
          const diff = Math.abs(claimVal - evidenceVal);

          // Flag if difference > 10% relative or > 5 absolute
          if (
            (diff > 0.1 * Math.max(Math.abs(claimVal), Math.abs(evidenceVal))) &&
            diff > 0.05
          ) {
            contradictions.push({
              claim: entry.claim,
              evidence: `Expected ~${evidenceVal} but claimed ${claimVal} (diff: ${diff.toFixed(2)})`,
            });
          }
        }
      }
    }

    return contradictions;
  }

  /** Generate a complete provenance report. */
  generateReport(): ProvenanceReport {
    const unverifiableClaims = this.entries
      .filter((e) => e.sourceType === 'unknown' || e.confidence < 0.5)
      .map((e) => e.claim);

    const contradictions = this.detectContradictions();

    const verifiedCount = this.entries.filter(
      (e) => e.sourceType !== 'unknown' && e.confidence >= 0.5
    ).length;

    const totalConfidence = this.entries.reduce((sum, e) => sum + e.confidence, 0);

    return {
      entries: this.entries,
      unverifiableClaims,
      contradictoryClaims: contradictions,
      stats: {
        totalClaims: this.entries.length,
        verifiedCount,
        unverifiableCount: unverifiableClaims.length,
        contradictoryCount: contradictions.length,
        averageConfidence: this.entries.length > 0
          ? totalConfidence / this.entries.length
          : 1.0,
      },
      sessionId: this.sessionId,
      generatedAt: Date.now(),
    };
  }

  /** Clear all entries (for session reset). */
  clear(): void {
    this.entries = [];
    this.toolResults.clear();
  }

  // ─── Private ─────────────────────────────────────────────

  private estimateConfidence(sourceType: ProvenanceSource, evidence?: string): number {
    switch (sourceType) {
      case 'tool_result': return 0.9;
      case 'external_source':
        // Higher if evidence contains verified DOI/arXiv pattern
        if (evidence?.match(/10\.\d{4,}\//) || evidence?.match(/arXiv:\s*\d{4}\.\d{4,5}/)) {
          return 0.85;
        }
        return 0.6;
      case 'llm_reasoning': return 0.5;
      default: return 0.3;
    }
  }
}
