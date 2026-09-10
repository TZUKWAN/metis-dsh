import { createHash } from 'node:crypto';
import {
  ArtifactManifestSchema,
  effectiveArtifactReviewStatus,
} from '../engine/artifacts/ArtifactManifest.js';
import type {
  ProjectSnapshot,
  Source,
} from '../engine/persistence/researchModel.js';
import type {
  ResearchExportRecord,
  ResearchExportSnapshot,
} from '../engine/export/ResearchExportBuilder.js';
import type { CitationTruthAttestation } from '../engine/writing/CitationTruth.js';

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function joined(values: readonly string[]): string {
  return values.filter(Boolean).join('; ');
}

export interface TrustedArtifactExportBinding {
  artifactId: string;
  artifactVersion: number;
  artifactManifestDigest: string;
}

export interface TrustedArtifactExportEvaluation {
  receiptVerified: true;
  profileEnforced: true;
  attestations: readonly CitationTruthAttestation[];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

export function canonicalArtifactManifestDigest(manifest: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(manifest)), 'utf8')
    .digest('hex');
}

export function resolveTrustedArtifactExportBinding(
  snapshot: ProjectSnapshot,
  artifactId: string,
  artifactVersion: number,
): TrustedArtifactExportBinding | null {
  if (snapshot.project.deletedAt !== null) return null;
  const artifact = snapshot.artifacts.find((candidate) => (
    candidate.id === artifactId
    && candidate.projectId === snapshot.project.id
    && candidate.deletedAt === null
  ));
  if (!artifact) return null;
  const version = snapshot.artifactVersions.find((candidate) => (
    candidate.artifactId === artifactId && candidate.version === artifactVersion
  ));
  if (!version) return null;
  const parsedManifest = ArtifactManifestSchema.safeParse(version.manifest);
  if (!parsedManifest.success) return null;
  const manifest = parsedManifest.data;
  if (
    manifest.id !== artifactId
    || manifest.projectId !== snapshot.project.id
    || manifest.version !== artifactVersion
  ) return null;
  const contentDigest = createHash('sha256').update(version.content, 'utf8').digest('hex');
  if (contentDigest !== version.contentHash) return null;
  return {
    artifactId,
    artifactVersion,
    artifactManifestDigest: canonicalArtifactManifestDigest(manifest),
  };
}

function citationContent(source: Source): string {
  const authors = joined(source.authors);
  const year = source.year === null ? '' : String(source.year);
  return [authors, year, source.title, source.venue]
    .filter(Boolean)
    .join('. ');
}

/**
 * Converts the main-process persistence snapshot into the deliberately narrow,
 * sensitivity-labelled export builder input. Local paths, provider/runtime
 * profiles, manifests, prompts, tool arguments and decision before/after
 * values are never copied into this intermediate snapshot.
 */
export function buildExportSnapshot(
  snapshot: ProjectSnapshot,
  binding: TrustedArtifactExportBinding,
  artifactImages: NonNullable<ResearchExportRecord['images']> = [],
  trust: TrustedArtifactExportEvaluation | null = null,
): ResearchExportSnapshot {
  const sourceById = new Map(snapshot.sources.map((source) => [source.id, source]));
  const selectedVersion = snapshot.artifactVersions.find((candidate) => (
    candidate.artifactId === binding.artifactId
    && candidate.version === binding.artifactVersion
  ));
  const selectedManifest = selectedVersion
    ? ArtifactManifestSchema.safeParse(selectedVersion.manifest)
    : null;
  return {
    artifactBinding: binding,
    project: [{
      id: snapshot.project.id,
      title: snapshot.project.title,
      content: snapshot.project.originalIntent,
      sensitivity: 'none',
      fields: [
        { key: 'researchQuestion', value: snapshot.project.researchQuestion, sensitivity: 'none' },
        { key: 'discipline', value: snapshot.project.discipline, sensitivity: 'none' },
        { key: 'methodology', value: snapshot.project.methodology, sensitivity: 'none' },
        { key: 'lifecycle', value: snapshot.project.lifecycle, sensitivity: 'none' },
      ],
    }],
    artifact: snapshot.artifacts
      .filter((artifact) => (
        artifact.deletedAt === null && artifact.id === binding.artifactId
      ))
      .map((artifact) => ({
        id: artifact.id,
        title: selectedManifest?.success ? selectedManifest.data.title : artifact.title,
        content: selectedVersion?.content ?? '',
        sensitivity: 'none' as const,
        images: artifactImages,
        fields: [
          {
            key: 'type',
            value: selectedManifest?.success
              ? selectedManifest.data.artifactType
              : artifact.artifactType,
            sensitivity: 'none' as const,
          },
          {
            key: 'reviewStatus',
            value: selectedManifest?.success
              ? effectiveArtifactReviewStatus(selectedManifest.data, {
                  receiptVerified: trust?.receiptVerified,
                  profileEnforced: trust?.profileEnforced,
                })
              : 'draft',
            sensitivity: 'none' as const,
          },
          ...(selectedManifest?.success && selectedManifest.data.deliverableProfile ? [
            { key: 'deliverableProfileId', value: selectedManifest.data.deliverableProfile.id, sensitivity: 'none' as const },
            { key: 'deliverableProfileSchemaVersion', value: String(selectedManifest.data.deliverableProfile.schemaVersion), sensitivity: 'none' as const },
            { key: 'deliverableProfileVersion', value: selectedManifest.data.deliverableProfile.profileVersion, sensitivity: 'none' as const },
          ] : []),
          { key: 'version', value: String(binding.artifactVersion), sensitivity: 'none' as const },
        ],
      })),
    citations: snapshot.sources
      .filter((source) => source.deletedAt === null)
      .map((source, sourceIndex) => {
        const attestation = trust?.attestations.find((item) => item.sourceId === source.id);
        return {
        id: source.id,
        title: source.title,
        content: citationContent(source),
        sensitivity: 'none' as const,
        fields: [
          { key: 'kind', value: source.kind, sensitivity: 'none' as const },
          { key: 'identifierType', value: source.identifierType, sensitivity: 'none' as const },
          { key: 'identifier', value: source.identifier, sensitivity: 'none' as const },
          { key: 'bibliographyKey', value: source.id, sensitivity: 'none' as const },
          { key: 'bibliographyIndex', value: String(sourceIndex + 1), sensitivity: 'none' as const },
          { key: 'authors', value: joined(source.authors), sensitivity: 'none' as const },
          { key: 'year', value: source.year === null ? '' : String(source.year), sensitivity: 'none' as const },
          ...(attestation ? [
            { key: 'citationKeys', value: joined(attestation.citationKeys), sensitivity: 'none' as const },
            { key: 'locator', value: attestation.locator, sensitivity: 'none' as const },
            { key: 'triangulation', value: attestation.triangulation, sensitivity: 'none' as const },
            { key: 'passport', value: attestation.passport, sensitivity: 'none' as const },
            { key: 'retraction', value: attestation.retraction, sensitivity: 'none' as const },
            { key: 'journalIntegrity', value: attestation.journalIntegrity, sensitivity: 'none' as const },
            { key: 'checkedAt', value: String(attestation.checkedAt), sensitivity: 'none' as const },
          ] : []),
          { key: 'externalUrl', value: source.externalUrl ?? '', sensitivity: 'none' as const },
          { key: 'tags', value: joined(source.tags), sensitivity: 'none' as const },
        ],
      };
      }),
    evidence: snapshot.evidence
      .filter((evidence) => evidence.deletedAt === null)
      .map((evidence) => {
        const source = sourceById.get(evidence.sourceId);
        const rawTranscript = source?.kind === 'audio';
        return {
          id: evidence.id,
          title: source?.title ?? 'Evidence',
          content: evidence.snippet,
          sensitivity: rawTranscript ? 'raw-transcript' as const : 'none' as const,
          fields: [
            { key: 'sourceId', value: evidence.sourceId, sensitivity: 'none' as const },
            { key: 'anchorType', value: evidence.anchorType, sensitivity: 'none' as const },
            { key: 'anchorStart', value: evidence.anchorStart === null ? '' : String(evidence.anchorStart), sensitivity: 'none' as const },
            { key: 'anchorEnd', value: evidence.anchorEnd === null ? '' : String(evidence.anchorEnd), sensitivity: 'none' as const },
            { key: 'pageNumber', value: evidence.pageNumber === null ? '' : String(evidence.pageNumber), sensitivity: 'none' as const },
            { key: 'confidence', value: String(evidence.confidence), sensitivity: 'none' as const },
          ],
        };
      }),
    audit: [
      ...snapshot.runs.map((run) => ({
        id: run.id,
        title: 'Research run',
        content: run.status,
        sensitivity: 'none' as const,
        fields: [
          { key: 'currentStepId', value: run.currentStepId ?? '', sensitivity: 'none' as const },
          { key: 'createdAt', value: String(run.createdAt), sensitivity: 'none' as const },
          { key: 'completedAt', value: run.completedAt === null ? '' : String(run.completedAt), sensitivity: 'none' as const },
        ],
      })),
      ...snapshot.decisions.map((decision) => ({
        id: decision.id,
        title: `Decision: ${decision.decision}`,
        content: text(decision.note),
        sensitivity: 'none' as const,
        fields: [
          { key: 'targetKind', value: decision.targetKind, sensitivity: 'none' as const },
          { key: 'targetId', value: decision.targetId, sensitivity: 'none' as const },
          { key: 'origin', value: decision.origin, sensitivity: 'none' as const },
          { key: 'createdAt', value: String(decision.createdAt), sensitivity: 'none' as const },
        ],
      })),
      ...snapshot.checkpoints.map((checkpoint) => ({
        id: checkpoint.id,
        title: 'Research checkpoint',
        content: checkpoint.recoveryStrategy ?? '',
        sensitivity: 'none' as const,
        fields: [
          { key: 'runId', value: checkpoint.runId, sensitivity: 'none' as const },
          { key: 'stepId', value: checkpoint.stepId, sensitivity: 'none' as const },
          { key: 'lifecycle', value: checkpoint.lifecycle, sensitivity: 'none' as const },
          { key: 'errorCategory', value: checkpoint.errorCategory ?? '', sensitivity: 'none' as const },
          { key: 'createdAt', value: String(checkpoint.createdAt), sensitivity: 'none' as const },
        ],
      })),
    ],
  };
}
