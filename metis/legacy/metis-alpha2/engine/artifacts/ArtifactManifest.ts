/**
 * Artifact Manifest (METIS-601).
 *
 * Every research artifact records its full provenance: the inputs it was generated from,
 * the method/capability that produced it, the model + code, the source materials it cites,
 * the renderer (viewer) to display it, and its review history. A result with no sources
 * CANNOT be marked as a verified artifact (METIS-601 completion).
 *
 * Zod-validated so malformed manifests are rejected before storage.
 */

import { z } from 'zod';
import type { ArtifactType, ArtifactReviewStatus } from '../persistence/researchModel.js';
import {
  RESEARCH_MEDIA_LIMITS,
  ResearchMediaDescriptorSchema,
} from '../runtime/ResearchMediaRuntimeContract.js';
import {
  DeliverableProfileBindingSchema,
  getDeliverableProfile,
} from '../writing/DeliverableProfile.js';
import {
  CitationTruthAttestationSchema,
  isTrustedCitationAttestation,
} from '../writing/CitationTruth.js';
import {
  CitationTruthReceiptSchema,
  CitationTruthRequestSchema,
} from '../writing/CitationTruthReceipt.js';
import {
  DeliverableComplianceSchema,
  DeliverableContextSchema,
} from '../writing/ProfileEnforcer.js';

export const ARTIFACT_TYPES: readonly ArtifactType[] = ['manuscript', 'chart', 'table', 'report', 'network', 'other'];
export const REVIEW_STATUSES: readonly ArtifactReviewStatus[] = ['draft', 'pending', 'partial', 'verified', 'stale'];

// Re-export so consumers can import the status type from the manifest module.
export type { ArtifactReviewStatus, ArtifactType };

export const ArtifactManifestSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  artifactType: z.enum(ARTIFACT_TYPES as unknown as [ArtifactType, ...ArtifactType[]]),
  reviewStatus: z.enum(REVIEW_STATUSES as unknown as [ArtifactReviewStatus, ...ArtifactReviewStatus[]]).default('draft'),

  // ── Inputs (what it was generated from) ──
  inputs: z.array(z.object({
    kind: z.enum(['claim', 'evidence', 'source', 'dataset', 'previous_artifact']),
    id: z.string().min(1),
  })).default([]),

  // ── Method + model + code ──
  generatedBy: z.object({
    capabilityId: z.string().min(1),
    method: z.string().min(1),
    model: z.string().optional(),
    codeRef: z.string().optional(),     // path or inline id of the generating code
    promptHash: z.string().optional(),
  }),

  // ── Sources cited (METIS-601: traceable; METIS-806: only registered sources) ──
  citedSourceIds: z.array(z.string()).default([]),

  // Versioned output contract + release truth. Optional profile keeps legacy
  // artifacts readable; unprofiled artifacts are always treated as draft.
  deliverableProfile: DeliverableProfileBindingSchema.optional(),
  deliverableContext: DeliverableContextSchema.optional(),
  deliverableCompliance: DeliverableComplianceSchema.optional(),
  citationRequests: z.array(CitationTruthRequestSchema).optional(),
  citationTruthReceipts: z.array(CitationTruthReceiptSchema).optional(),
  // Legacy renderer-authored attestations remain parseable for migration only;
  // they are never sufficient for verified status.
  citationTruth: z.array(CitationTruthAttestationSchema).optional(),

  // ── Renderer / viewer ──
  renderer: z.object({
    kind: z.enum(['text', 'markdown', 'vega_lite', 'image', 'table_html', 'pdf', 'react_component']),
    spec: z.string().optional(),        // the declarative spec (e.g. vega-lite JSON)
    contentRef: z.string().optional(),  // path or inline content id
  }),

  // Main-authoritative media bound to this exact artifact version. Optional without a
  // default so parsing legacy manifests does not change their canonical digest.
  media: z.array(ResearchMediaDescriptorSchema)
    .max(RESEARCH_MEDIA_LIMITS.mediaPerArtifact)
    .optional(),

  // ── Input hash (for staleness detection — METIS-603) ──
  inputHash: z.string().optional(),

  // ── Audit / review trail ──
  reviewTrail: z.array(z.object({
    at: z.number(),
    from: z.enum(REVIEW_STATUSES as unknown as [ArtifactReviewStatus, ...ArtifactReviewStatus[]]),
    to: z.enum(REVIEW_STATUSES as unknown as [ArtifactReviewStatus, ...ArtifactReviewStatus[]]),
    reason: z.string(),
  })).default([]),

  version: z.number().int().min(1).default(1),
  createdAt: z.number(),
  updatedAt: z.number(),
}).superRefine((manifest, context) => {
  const cited = new Set<string>();
  manifest.citedSourceIds.forEach((sourceId, index) => {
    if (cited.has(sourceId)) {
      context.addIssue({
        code: 'custom',
        message: 'Cited source ids must be unique',
        path: ['citedSourceIds', index],
      });
    }
    cited.add(sourceId);
  });
  const requested = new Set<string>();
  manifest.citationRequests?.forEach((citation, index) => {
    if (requested.has(citation.sourceId)) {
      context.addIssue({
        code: 'custom',
        message: 'Citation locator requests must be unique per source',
        path: ['citationRequests', index, 'sourceId'],
      });
    }
    requested.add(citation.sourceId);
  });
  if (!manifest.media) return;
  const inputSourceIds = new Set(
    manifest.inputs
      .filter((input) => input.kind === 'source')
      .map((input) => input.id),
  );
  const sourceIds = new Set<string>();
  const ordinals = new Set<number>();
  manifest.media.forEach((media, index) => {
    if (!inputSourceIds.has(media.sourceId)) {
      context.addIssue({
        code: 'custom',
        message: 'Artifact media must be recorded as a source input',
        path: ['media', index, 'sourceId'],
      });
    }
    if (sourceIds.has(media.sourceId)) {
      context.addIssue({
        code: 'custom',
        message: 'Artifact media source ids must be unique',
        path: ['media', index, 'sourceId'],
      });
    }
    if (ordinals.has(media.ordinal)) {
      context.addIssue({
        code: 'custom',
        message: 'Artifact media ordinals must be unique',
        path: ['media', index, 'ordinal'],
      });
    }
    sourceIds.add(media.sourceId);
    ordinals.add(media.ordinal);
  });
});

export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

export function parseArtifactManifest(unknown: unknown):
  | { success: true; manifest: ArtifactManifest }
  | { success: false; errors: string[] } {
  const r = ArtifactManifestSchema.safeParse(unknown);
  if (r.success) return { success: true, manifest: r.data };
  return { success: false, errors: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
}

/** Restoring always creates a new version, so version-bound trust is stripped. */
export function prepareArtifactManifestForRestore(value: unknown): ArtifactManifest | undefined {
  const parsed = ArtifactManifestSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const manifest: ArtifactManifest = { ...parsed.data };
  delete manifest.citationTruthReceipts;
  delete manifest.deliverableCompliance;
  return {
    ...manifest,
    reviewStatus: parsed.data.reviewStatus === 'verified' ? 'draft' : parsed.data.reviewStatus,
  };
}

/**
 * Can this artifact be marked VERIFIED? Only if it has at least one cited source — a
 * sourceless result cannot be a trusted research output (METIS-601 completion).
 */
export function canBeVerified(
  manifest: ArtifactManifest,
  authority: { receiptVerified?: boolean; profileEnforced?: boolean } = {},
): { ok: boolean; reason?: string } {
  if (manifest.citedSourceIds.length === 0) {
    return { ok: false, reason: '无来源的成果不能标记为已核验（METIS-601）。' };
  }
  if (manifest.inputs.length === 0) {
    return { ok: false, reason: '缺少输入记录，无法核验。' };
  }
  if (!manifest.deliverableProfile) {
    return { ok: false, reason: 'Legacy artifact has no versioned deliverable profile and remains unverified.' };
  }
  const profile = getDeliverableProfile(manifest.deliverableProfile.id);
  if (
    !profile
    || profile.schemaVersion !== manifest.deliverableProfile.schemaVersion
    || profile.profileVersion !== manifest.deliverableProfile.profileVersion
  ) {
    return { ok: false, reason: 'Deliverable profile binding is unknown or stale.' };
  }
  if (!manifest.deliverableContext || !manifest.deliverableCompliance || !authority.profileEnforced) {
    return { ok: false, reason: 'Deliverable profile has not been enforced by the main process.' };
  }
  if (
    manifest.deliverableCompliance.profileId !== manifest.deliverableProfile.id
    || manifest.deliverableCompliance.templateId !== manifest.deliverableContext.templateId
    || manifest.deliverableCompliance.templateSourceId !== manifest.deliverableContext.templateSourceId
    || manifest.deliverableCompliance.contentFormat !== manifest.deliverableContext.contentFormat
    || manifest.deliverableCompliance.citationStyle !== manifest.deliverableContext.citationStyle
  ) {
    return { ok: false, reason: 'Deliverable compliance does not match its profile context.' };
  }
  if (!authority.receiptVerified) {
    return { ok: false, reason: 'Citation truth receipts have not been verified by the main process.' };
  }
  const receipts = manifest.citationTruthReceipts ?? [];
  if (receipts.length !== manifest.citedSourceIds.length) {
    return { ok: false, reason: 'Citation truth receipt count does not match cited sources.' };
  }
  const requests = manifest.citationRequests ?? [];
  if (
    requests.length !== manifest.citedSourceIds.length
    || manifest.citedSourceIds.some((sourceId) => requests.filter((item) => item.sourceId === sourceId).length !== 1)
  ) {
    return { ok: false, reason: 'Citation locator requests do not match cited sources.' };
  }
  for (const sourceId of manifest.citedSourceIds) {
    const matching = receipts.filter((receipt) => receipt.sourceId === sourceId);
    if (matching.length !== 1) {
      return { ok: false, reason: `Cited source ${sourceId} requires exactly one main-issued truth receipt.` };
    }
    const truth = isTrustedCitationAttestation(matching[0]?.attestation);
    if (!truth.ok) {
      return { ok: false, reason: `Cited source ${sourceId} is not release-trusted: ${truth.reasons.join(', ')}` };
    }
  }
  return { ok: true };
}

/** Legacy/untrusted "verified" rows are presented as draft until migrated and rechecked. */
export function effectiveArtifactReviewStatus(
  manifest: ArtifactManifest,
  authority: { receiptVerified?: boolean; profileEnforced?: boolean } = {},
): ArtifactReviewStatus {
  if (manifest.reviewStatus !== 'verified') return manifest.reviewStatus;
  return canBeVerified(manifest, authority).ok ? 'verified' : 'draft';
}
