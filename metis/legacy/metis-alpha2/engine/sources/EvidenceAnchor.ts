/**
 * Evidence Anchor service (METIS-404).
 *
 * Pins each Evidence item to a precise, stable location in its Source:
 *   - page (PDF page number)
 *   - char_range (character offsets in the text layer)
 *   - timestamp (audio/video seconds)
 *   - region (image bounding box)
 *   - row (structured data row index)
 *
 * Each anchor also stores a SNAPSHOT of the cited text at capture time plus the source's
 * version hash. If the source is later updated (its version hash changes), the evidence is
 * flagged STALE so the user knows the citation may have shifted (METIS-404: "clicking
 * evidence returns to the original location"; "file reopened / project restarted / source
 * updated" tests).
 */

import { createHash } from 'node:crypto';
import type { Evidence, AnchorType } from '../persistence/researchModel.js';

export interface AnchorSpec {
  type: AnchorType;
  pageNumber?: number;
  start?: number; // char start / region start / row
  end?: number;   // char end / region end
  timestamp?: number; // seconds (audio/video)
}

export interface CreateEvidenceInput {
  id: string;
  projectId: string;
  sourceId: string;
  anchor: AnchorSpec;
  snippet: string;
  sourceVersionHash: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface AnchorValidation {
  valid: boolean;
  errors: string[];
}

/** Validate that an anchor spec is well-formed for its type. */
export function validateAnchor(anchor: AnchorSpec): AnchorValidation {
  const errors: string[] = [];
  switch (anchor.type) {
    case 'page':
      if (typeof anchor.pageNumber !== 'number' || anchor.pageNumber < 1) errors.push('page anchor requires pageNumber >= 1');
      break;
    case 'char_range':
      if (typeof anchor.start !== 'number' || typeof anchor.end !== 'number') errors.push('char_range requires start and end');
      else if (anchor.start < 0 || anchor.end <= anchor.start) errors.push('char_range requires 0 <= start < end');
      break;
    case 'timestamp':
      if (typeof anchor.timestamp !== 'number' || anchor.timestamp < 0) errors.push('timestamp requires >= 0 seconds');
      break;
    case 'region':
      if (typeof anchor.start !== 'number' || typeof anchor.end !== 'number') errors.push('region requires start and end bounds');
      break;
    case 'row':
      if (typeof anchor.start !== 'number' || anchor.start < 0) errors.push('row requires start >= 0');
      break;
    case 'none':
      break;
    default:
      errors.push(`unknown anchor type: ${anchor.type as string}`);
  }
  return { valid: errors.length === 0, errors };
}

/** SHA-256 of the snippet — the content fingerprint at capture time. */
export function snippetHash(snippet: string): string {
  return createHash('sha256').update(snippet).digest('hex');
}

/** Build an Evidence record from a validated anchor + snippet + source version. */
export function buildEvidence(input: CreateEvidenceInput, now: number = Date.now()): Evidence {
  const validation = validateAnchor(input.anchor);
  if (!validation.valid) {
    throw new Error(`Invalid anchor: ${validation.errors.join('; ')}`);
  }
  return {
    id: input.id,
    projectId: input.projectId,
    sourceId: input.sourceId,
    anchorType: input.anchor.type,
    // For timestamp anchors, the value lives in `timestamp`; store it in anchorStart so the
    // single anchorStart/anchorEnd pair covers all anchor types uniformly.
    anchorStart: input.anchor.type === 'timestamp' ? (input.anchor.timestamp ?? null) : (input.anchor.start ?? null),
    anchorEnd: input.anchor.end ?? null,
    pageNumber: input.anchor.pageNumber ?? null,
    snippet: input.snippet,
    snippetHash: snippetHash(input.snippet),
    sourceVersionHash: input.sourceVersionHash,
    confidence: input.confidence ?? 0,
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

export type EvidenceFreshness = 'fresh' | 'stale';

/**
 * Determine whether an evidence item is still valid against the CURRENT source version.
 * If the source's content hash changed since capture, the evidence is STALE (its anchor may
 * no longer point to the right place). METIS-404: "source updated test".
 */
export function checkFreshness(evidence: Evidence, currentSourceVersionHash: string): EvidenceFreshness {
  if (!evidence.sourceVersionHash) return 'fresh'; // no baseline to compare
  return evidence.sourceVersionHash === currentSourceVersionHash ? 'fresh' : 'stale';
}

/**
 * Produce a re-location descriptor for "click evidence → jump to original position". This is
 * what the viewer uses to scroll/highlight the cited span (METIS-404: "clicking evidence
 * returns to the corresponding original-text position").
 */
export interface RelocationTarget {
  sourceId: string;
  anchorType: AnchorType;
  pageNumber: number | null;
  start: number | null;
  end: number | null;
  timestamp: number | null;
  snippet: string;
  snippetHash: string;
}

export function relocationFor(evidence: Evidence): RelocationTarget {
  return {
    sourceId: evidence.sourceId,
    anchorType: evidence.anchorType,
    pageNumber: evidence.pageNumber,
    start: evidence.anchorStart,
    end: evidence.anchorEnd,
    timestamp: evidence.anchorType === 'timestamp' ? evidence.anchorStart : null,
    snippet: evidence.snippet,
    snippetHash: evidence.snippetHash,
  };
}
