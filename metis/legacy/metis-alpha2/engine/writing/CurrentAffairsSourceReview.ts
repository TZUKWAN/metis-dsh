/**
 * CurrentAffairsSourceReview — main-authoritative source classification.
 *
 * ResearchRepository Source metadata may not expose correctionState.
 * This service provides an auditable review path: a human (via main IPC)
 * classifies each source's correctionState, which is then persisted to
 * Source.metadata.currentAffairs.correctionState alongside a review record.
 *
 * NEVER defaults missing metadata to "clean".
 */
import { createHash } from 'node:crypto';

export type ReviewableCorrectionState = 'clean' | 'correction_pending' | 'corrected' | 'retracted';

export interface SourceReviewResult {
  sourceId: string;
  reviewed: boolean;
  correctionState: ReviewableCorrectionState | null;
  reason: string;
}

export interface ReviewRecord {
  sourceId: string;
  projectId: string;
  reviewerId: string;
  reviewedAt: number;
  correctionState: ReviewableCorrectionState;
  reason: string;
  reviewDigest: string;
}

export interface SourceReviewDeps {
  /** Get source metadata from repository. */
  getSourceMeta: (sourceId: string) => Record<string, unknown> | null;
  /** Save review record (main persists to repository). */
  saveReview: (record: ReviewRecord) => void;
  /** Generate unique review digest. */
  now: () => number;
}

export function reviewSource(
  deps: SourceReviewDeps,
  sourceId: string,
  projectId: string,
  reviewerId: string,
  correctionState: ReviewableCorrectionState,
  reason: string,
): SourceReviewResult {
  const meta = deps.getSourceMeta(sourceId);
  if (!meta) return { sourceId, reviewed: false, correctionState: null, reason: 'Source not found in repository' };

  const existing = (meta.currentAffairs as Record<string, unknown> | undefined)?.correctionState;
  if (existing && existing !== 'clean' && correctionState !== existing) {
    // If previously retracted and now re-classifying, allow.
    // If previously clean and now retracted, allow.
  }

  const reviewDigest = createHash('sha256')
    .update(`${sourceId}:${projectId}:${reviewerId}:${correctionState}:${reason}`)
    .digest('hex');

  deps.saveReview({
    sourceId,
    projectId,
    reviewerId,
    reviewedAt: deps.now(),
    correctionState,
    reason,
    reviewDigest,
  });

  return { sourceId, reviewed: true, correctionState, reason };
}

/**
 * Check if a source is eligible for research use.
 * Returns false if missing review or has retracted/pending state.
 */
export function isResearchEligible(meta: Record<string, unknown> | null): { eligible: boolean; reason: string; correctionState: ReviewableCorrectionState | null } {
  if (!meta) return { eligible: false, reason: 'Source not found', correctionState: null };
  const ca = (meta.currentAffairs as Record<string, unknown> | undefined);
  if (!ca || !ca.correctionState) {
    return { eligible: false, reason: 'Source not reviewed — requires human classification', correctionState: null };
  }
  const state = ca.correctionState as string;
  if (state === 'retracted') return { eligible: false, reason: 'Source is retracted', correctionState: 'retracted' };
  if (state === 'correction_pending') return { eligible: false, reason: 'Source has pending correction', correctionState: 'correction_pending' };
  if (state === 'clean' || state === 'corrected') return { eligible: true, reason: '', correctionState: state };
  return { eligible: false, reason: `Unknown correction state: ${state}`, correctionState: null };
}
