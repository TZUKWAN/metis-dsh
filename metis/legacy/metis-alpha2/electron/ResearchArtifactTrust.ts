import type { ArtifactManifest } from '../engine/artifacts/ArtifactManifest.js';
import { createHash } from 'node:crypto';
import type {
  ArtifactTrustVerification,
  ResearchRepository,
} from '../engine/persistence/ResearchRepository.js';
import type { CitationTruthAttestation } from '../engine/writing/CitationTruth.js';
import {
  DeliverableComplianceSchema,
  enforceDeliverableProfile,
  type DeliverableCompliance,
} from '../engine/writing/ProfileEnforcer.js';
import type { CitationTruthReceiptService } from './CitationTruthReceiptService.js';

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function complianceMatches(
  stored: DeliverableCompliance | undefined,
  current: DeliverableCompliance | undefined,
): boolean {
  if (!stored || !current) return false;
  return stored.schemaVersion === current.schemaVersion
    && stored.profileId === current.profileId
    && stored.templateId === current.templateId
    && stored.templateSourceId === current.templateSourceId
    && stored.contentFormat === current.contentFormat
    && stored.citationStyle === current.citationStyle
    && sameStrings(stored.sourceIds, current.sourceIds)
    && sameStrings(stored.approvalDecisionIds, current.approvalDecisionIds)
    && stored.approvalArtifactVersion === current.approvalArtifactVersion
    && stored.contentDigest === current.contentDigest;
}

export function enforceCurrentArtifactProfile(
  repository: ResearchRepository,
  manifest: ArtifactManifest,
  content: string,
  now = Date.now(),
): DeliverableCompliance | undefined {
  if (!manifest.deliverableProfile || !manifest.deliverableContext) return undefined;
  const storedCompliance = DeliverableComplianceSchema.safeParse(manifest.deliverableCompliance);
  if (!storedCompliance.success) return undefined;
  const contentDigest = createHash('sha256').update(content, 'utf8').digest('hex');
  if (storedCompliance.data.contentDigest !== contentDigest) return undefined;
  const result = enforceDeliverableProfile({
    projectId: manifest.projectId,
    artifactId: manifest.id,
    binding: manifest.deliverableProfile,
    context: manifest.deliverableContext,
    content,
    citedSourceIds: manifest.citedSourceIds,
    sources: repository.listSources(manifest.projectId, false),
    decisions: repository.listDecisions(manifest.projectId),
    approvalArtifactVersion: storedCompliance.data.approvalArtifactVersion,
    contentDigest,
    now,
  });
  return result.passed ? result.compliance : undefined;
}

/** Sync authority used at the repository transaction boundary. */
export function verifyArtifactForPersistence(
  repository: ResearchRepository,
  receiptService: CitationTruthReceiptService,
  manifest: ArtifactManifest,
  content: string,
  now = Date.now(),
): ArtifactTrustVerification {
  const receipt = receiptService.verifyManifestCurrent(repository, manifest, content, now);
  const currentCompliance = enforceCurrentArtifactProfile(repository, manifest, content, now);
  const storedCompliance = DeliverableComplianceSchema.safeParse(manifest.deliverableCompliance);
  return {
    receiptVerified: receipt.ok,
    profileEnforced: storedCompliance.success && complianceMatches(storedCompliance.data, currentCompliance),
  };
}

export interface TrustedArtifactReleaseEvaluation {
  receiptVerified: true;
  profileEnforced: true;
  attestations: CitationTruthAttestation[];
}

/** Async export authority: verifies the HMAC/current snapshot and performs a
 * fresh ReferenceValidator + CitationTruthResolver check for every source. */
export async function verifyArtifactForExport(
  repository: ResearchRepository,
  receiptService: CitationTruthReceiptService,
  manifest: ArtifactManifest,
  content: string,
  now = Date.now(),
): Promise<TrustedArtifactReleaseEvaluation | null> {
  const receipt = await receiptService.verifyAndRevalidateManifest(repository, manifest, content, now);
  const currentCompliance = enforceCurrentArtifactProfile(repository, manifest, content, now);
  const storedCompliance = DeliverableComplianceSchema.safeParse(manifest.deliverableCompliance);
  if (
    !receipt.ok
    || !receipt.attestations
    || !storedCompliance.success
    || !complianceMatches(storedCompliance.data, currentCompliance)
  ) return null;
  return {
    receiptVerified: true,
    profileEnforced: true,
    attestations: receipt.attestations,
  };
}
