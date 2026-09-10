import { createHash, randomUUID } from 'node:crypto';
import {
  ArtifactManifestSchema,
  effectiveArtifactReviewStatus,
  type ArtifactManifest,
} from '../engine/artifacts/ArtifactManifest.js';
import { ResearchRepository } from '../engine/persistence/ResearchRepository.js';
import type {
  ArtifactVersionRecord,
  Claim,
  ClaimEvidenceLink,
  Evidence,
  NoteCode,
  Project,
  ProjectSnapshot,
  ResearchArtifact,
  ResearchCheckpoint,
  ResearchDecision,
  ResearchRun,
  Source,
} from '../engine/persistence/researchModel.js';
import {
  ProjectSnapshotRuntimeSchema,
  ResearchArtifactDtoSchema,
  ResearchArtifactVersionDtoSchema,
  ResearchCheckpointDtoSchema,
  ResearchClaimDtoSchema,
  ResearchClaimEvidenceLinkDtoSchema,
  ResearchContentRefSchema,
  ResearchDecisionDtoSchema,
  ResearchEntityEnvelopeSchema,
  ResearchEvidenceDtoSchema,
  ResearchNoteCodeDtoSchema,
  ResearchProjectDtoSchema,
  ResearchRunDtoSchema,
  ResearchSourceDtoSchema,
  type ProjectSnapshotRuntime,
  type ResearchArtifactVersionListResult,
  type ResearchArtifactVersionRequest,
  type ResearchArtifactVersionResult,
  type ResearchCheckpointListResult,
  type ResearchCheckpointRequest,
  type ResearchCheckpointResult,
  type ResearchCrudRequest,
  type ResearchDecisionListResult,
  type ResearchDecisionRequest,
  type ResearchDecisionResult,
  type ResearchEntityEnvelope,
  type ResearchEntityListResult,
  type ResearchEntityResult,
  type ResearchLinkListResult,
  type ResearchLinkRequest,
  type ResearchMutationResult,
  type ResearchRestoreRequest,
  type ResearchReviewRequest,
  type ResearchSnapshotResult,
} from '../engine/runtime/ResearchRuntimeContract.js';
import type {
  ResearchMediaDescriptor,
  ResearchMediaReference,
} from '../engine/runtime/ResearchMediaRuntimeContract.js';
import { enforceDeliverableProfile } from '../engine/writing/ProfileEnforcer.js';
import type { CitationTruthReceiptService } from './CitationTruthReceiptService.js';
import { verifyArtifactForPersistence } from './ResearchArtifactTrust.js';

type CrudResult = ResearchMutationResult | ResearchEntityResult | ResearchEntityListResult;
type LinkResult = ResearchMutationResult | ResearchLinkListResult;
type VersionResult =
  | ResearchMutationResult
  | ResearchArtifactVersionResult
  | ResearchArtifactVersionListResult;
type CheckpointResult =
  | ResearchMutationResult
  | ResearchCheckpointResult
  | ResearchCheckpointListResult;
type DecisionResult =
  | ResearchMutationResult
  | ResearchDecisionResult
  | ResearchDecisionListResult;

export interface ResearchMediaManifestResolver {
  isManagedSource(source: Source): boolean;
  resolveManifestDescriptors(
    projectId: string,
    references: readonly ResearchMediaReference[],
  ): ResearchMediaDescriptor[] | null;
}

function scrubPublicUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function scrubIdentifier(value: string, kind: Source['identifierType']): string {
  if (kind !== 'url') return value;
  return scrubPublicUrl(value) ?? '';
}

function scrubContentRef(value: string | null): string | null {
  if (value === null) return null;
  const parsed = ResearchContentRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function presentProject(value: Project) {
  const parsed = ResearchProjectDtoSchema.safeParse({
    id: value.id,
    title: value.title,
    originalIntent: value.originalIntent,
    researchQuestion: value.researchQuestion,
    lifecycle: value.lifecycle,
    methodology: value.methodology,
    discipline: value.discipline,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    archivedAt: value.archivedAt,
    version: value.version,
    deletedAt: value.deletedAt,
  });
  return parsed.success ? parsed.data : undefined;
}

function presentSource(value: Source) {
  const parsed = ResearchSourceDtoSchema.safeParse({
    id: value.id,
    projectId: value.projectId,
    libraryPaperId: value.libraryPaperId ?? null,
    kind: value.kind,
    title: value.title,
    authors: value.authors,
    year: value.year,
    venue: value.venue,
    identifier: scrubIdentifier(value.identifier, value.identifierType),
    identifierType: value.identifierType,
    externalUrl: scrubPublicUrl(value.externalUrl),
    tags: value.tags,
    deliverableSourceKind: typeof value.metadata.deliverableSourceKind === 'string'
      ? value.metadata.deliverableSourceKind
      : null,
    deliverableRuleKind: typeof value.metadata.deliverableRuleKind === 'string'
      ? value.metadata.deliverableRuleKind
      : null,
    sourceVersionHash: value.sourceVersionHash,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    deletedAt: value.deletedAt,
  });
  return parsed.success ? parsed.data : undefined;
}

function presentEvidence(value: Evidence) {
  const parsed = ResearchEvidenceDtoSchema.safeParse({
    id: value.id,
    projectId: value.projectId,
    sourceId: value.sourceId,
    anchorType: value.anchorType,
    anchorStart: value.anchorStart,
    anchorEnd: value.anchorEnd,
    pageNumber: value.pageNumber,
    snippet: value.snippet,
    snippetHash: value.snippetHash,
    sourceVersionHash: value.sourceVersionHash,
    confidence: value.confidence,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    deletedAt: value.deletedAt,
  });
  return parsed.success ? parsed.data : undefined;
}

function presentNoteCode(value: NoteCode) {
  const parsed = ResearchNoteCodeDtoSchema.safeParse({
    id: value.id,
    projectId: value.projectId,
    evidenceId: value.evidenceId,
    code: value.code,
    content: value.content,
    author: value.author,
    confidence: value.confidence,
    accepted: value.accepted,
    tags: value.tags,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    deletedAt: value.deletedAt,
  });
  return parsed.success ? parsed.data : undefined;
}

function presentClaim(value: Claim) {
  const parsed = ResearchClaimDtoSchema.safeParse({
    id: value.id,
    projectId: value.projectId,
    statement: value.statement,
    claimType: value.claimType,
    confidence: value.confidence,
    status: value.status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    deletedAt: value.deletedAt,
  });
  return parsed.success ? parsed.data : undefined;
}

function presentArtifact(
  value: ResearchArtifact,
  reviewStatus: ResearchArtifact['reviewStatus'] = value.reviewStatus === 'verified' ? 'draft' : value.reviewStatus,
) {
  const parsed = ResearchArtifactDtoSchema.safeParse({
    id: value.id,
    projectId: value.projectId,
    title: value.title,
    artifactType: value.artifactType,
    reviewStatus,
    contentRef: scrubContentRef(value.contentRef),
    inputHash: value.inputHash,
    version: value.version,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    deletedAt: value.deletedAt,
  });
  return parsed.success ? parsed.data : undefined;
}

function presentLink(value: ClaimEvidenceLink) {
  const parsed = ResearchClaimEvidenceLinkDtoSchema.safeParse({
    id: value.id,
    claimId: value.claimId,
    evidenceId: value.evidenceId,
    relation: value.relation,
    weight: value.weight,
    note: value.note,
    createdAt: value.createdAt,
  });
  return parsed.success ? parsed.data : undefined;
}

function presentArtifactVersion(value: ArtifactVersionRecord) {
  const parsed = ResearchArtifactVersionDtoSchema.safeParse({
    artifactId: value.artifactId,
    version: value.version,
    contentHash: value.contentHash,
    createdAt: value.createdAt,
    createdBy: value.createdBy,
    branchFromVersion: value.branchFromVersion,
  });
  return parsed.success ? parsed.data : undefined;
}

function presentRun(value: ResearchRun) {
  const parsed = ResearchRunDtoSchema.safeParse({
    id: value.id,
    projectId: value.projectId,
    status: value.status,
    currentStepId: value.currentStepId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt,
    deletedAt: value.deletedAt,
  });
  return parsed.success ? parsed.data : undefined;
}

function presentCheckpoint(value: ResearchCheckpoint) {
  const parsed = ResearchCheckpointDtoSchema.safeParse({
    id: value.id,
    projectId: value.projectId,
    runId: value.runId,
    stepId: value.stepId,
    lifecycle: value.lifecycle,
    inputHash: value.inputHash,
    outputHash: value.outputHash,
    completedSteps: value.completedSteps,
    decisions: value.decisions,
    pendingSteps: value.pendingSteps,
    runtimeProfileVersion: value.runtimeProfileVersion,
    errorCategory: value.errorCategory,
    recoveryStrategy: value.recoveryStrategy,
    createdAt: value.createdAt,
  });
  return parsed.success ? parsed.data : undefined;
}

function presentDecision(value: ResearchDecision) {
  const parsed = ResearchDecisionDtoSchema.safeParse({
    id: value.id,
    projectId: value.projectId,
    runId: value.runId,
    targetKind: value.targetKind,
    targetId: value.targetId,
    decision: value.decision,
    origin: value.origin,
    note: value.note,
    createdAt: value.createdAt,
    undoneAt: value.undoneAt,
  });
  return parsed.success ? parsed.data : undefined;
}

function presentEntity(
  kind: ResearchCrudRequest['entityKind'],
  value: Project | Source | Evidence | NoteCode | Claim | ResearchArtifact,
  artifactReviewStatus?: (artifact: ResearchArtifact) => ResearchArtifact['reviewStatus'],
): ResearchEntityEnvelope | undefined {
  const candidate = kind === 'project'
    ? { entityKind: kind, value: presentProject(value as Project) }
    : kind === 'source'
      ? { entityKind: kind, value: presentSource(value as Source) }
      : kind === 'evidence'
        ? { entityKind: kind, value: presentEvidence(value as Evidence) }
        : kind === 'note_code'
          ? { entityKind: kind, value: presentNoteCode(value as NoteCode) }
          : kind === 'claim'
            ? { entityKind: kind, value: presentClaim(value as Claim) }
            : {
                entityKind: kind,
                value: presentArtifact(
                  value as ResearchArtifact,
                  artifactReviewStatus?.(value as ResearchArtifact),
                ),
              };
  if (candidate.value === undefined) return undefined;
  const parsed = ResearchEntityEnvelopeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function presentSnapshot(
  value: ProjectSnapshot,
  artifactReviewStatus?: (artifact: ResearchArtifact) => ResearchArtifact['reviewStatus'],
): ProjectSnapshotRuntime | undefined {
  const project = presentProject(value.project);
  const sources = value.sources.map(presentSource);
  const evidence = value.evidence.map(presentEvidence);
  const noteCodes = value.noteCodes.map(presentNoteCode);
  const claims = value.claims.map(presentClaim);
  const claimEvidenceLinks = value.claimEvidenceLinks.map(presentLink);
  const artifacts = value.artifacts.map((artifact) => presentArtifact(
    artifact,
    artifactReviewStatus?.(artifact),
  ));
  const artifactVersions = value.artifactVersions.map(presentArtifactVersion);
  const runs = value.runs.map(presentRun);
  const checkpoints = value.checkpoints.map(presentCheckpoint);
  const decisions = value.decisions.map(presentDecision);
  const allPresent = project !== undefined
    && !sources.includes(undefined)
    && !evidence.includes(undefined)
    && !noteCodes.includes(undefined)
    && !claims.includes(undefined)
    && !claimEvidenceLinks.includes(undefined)
    && !artifacts.includes(undefined)
    && !artifactVersions.includes(undefined)
    && !runs.includes(undefined)
    && !checkpoints.includes(undefined)
    && !decisions.includes(undefined);
  if (!allPresent || project === undefined) return undefined;
  const parsed = ProjectSnapshotRuntimeSchema.safeParse({
    project,
    sources,
    evidence,
    noteCodes,
    claims,
    claimEvidenceLinks,
    artifacts,
    artifactVersions,
    runs,
    checkpoints,
    decisions,
    capturedAt: value.capturedAt,
  });
  return parsed.success ? parsed.data : undefined;
}

function mutationFailure(
  code: 'not_found' | 'conflict' | 'rejected' | 'forbidden' | 'research_mutation_unavailable',
): ResearchMutationResult {
  return { success: false, code };
}

function mutationSuccess(
  code: Extract<ResearchMutationResult, { success: true }>['code'],
  projectId: string,
  resourceKind: Extract<ResearchMutationResult, { success: true }>['resourceKind'],
  resourceId: string,
  version?: number,
): ResearchMutationResult {
  return version === undefined
    ? { success: true, code, projectId, resourceKind, resourceId }
    : { success: true, code, projectId, resourceKind, resourceId, version };
}

function paginate<T>(items: T[], offset: number, limit: number): T[] {
  return items.slice(offset, offset + limit);
}

/**
 * Main-process application boundary for the persistent research model.
 *
 * This class accepts only already-decoded runtime requests and returns only
 * renderer-safe result unions. It never passes persistence records, local paths,
 * prompts, provider profiles, manifests, checkpoint output, or decision snapshots
 * across IPC.
 */
export class ResearchRuntimeService {
  constructor(
    private readonly repository: ResearchRepository,
    private readonly mediaResolver?: ResearchMediaManifestResolver,
    private readonly citationReceipts?: CitationTruthReceiptService,
  ) {}

  handleCrud(request: ResearchCrudRequest): CrudResult {
    try {
      if (request.operation === 'create') return this.createEntity(request);
      if (request.operation === 'get') {
        const value = this.getScopedEntity(
          request.entityKind,
          request.entityId,
          request.projectId,
          request.includeDeleted,
        );
        const entity = value
          ? presentEntity(request.entityKind, value, (artifact) => this.trustedArtifactReviewStatus(artifact))
          : undefined;
        return entity ? { success: true, entity } : { success: false, code: 'research_entity_unavailable' };
      }
      if (request.operation === 'list') return this.listEntities(request);
      if (request.operation === 'update') return this.updateEntity(request);
      return this.deleteEntity(request);
    } catch {
      return request.operation === 'get'
        ? { success: false, code: 'research_entity_unavailable' }
        : request.operation === 'list'
          ? { success: false, code: 'research_entity_list_unavailable', items: [] }
          : mutationFailure('research_mutation_unavailable');
    }
  }

  handleLink(request: ResearchLinkRequest): LinkResult {
    try {
      if (request.operation === 'list_links') {
        const items = this.repository.listClaimEvidenceLinks(request.projectId)
          .filter((item) => request.claimId === undefined || item.claimId === request.claimId)
          .filter((item) => request.evidenceId === undefined || item.evidenceId === request.evidenceId)
          .map(presentLink);
        return items.includes(undefined)
          ? { success: false, code: 'research_link_list_unavailable', items: [] }
          : { success: true, items: items as NonNullable<(typeof items)[number]>[] };
      }
      if (request.operation === 'unlink') {
        const link = this.repository.listClaimEvidenceLinks(request.projectId)
          .find((item) => item.id === request.linkId);
        if (!link) return mutationFailure('not_found');
        return this.repository.unlinkClaimEvidence(request.linkId)
          ? mutationSuccess('unlinked', request.projectId, 'claim_evidence_link', request.linkId)
          : mutationFailure('not_found');
      }
      const { link } = request;
      const claim = this.repository.getClaim(link.claimId);
      const evidence = this.repository.getEvidence(link.evidenceId);
      if (!claim || !evidence || claim.projectId !== request.projectId || evidence.projectId !== request.projectId) {
        return mutationFailure('not_found');
      }
      if (this.repository.listClaimEvidenceLinks(request.projectId).some((item) => item.id === link.id)) {
        return mutationFailure('conflict');
      }
      this.repository.linkClaimEvidence({ ...link, createdAt: Date.now() });
      return mutationSuccess('linked', request.projectId, 'claim_evidence_link', link.id);
    } catch {
      return request.operation === 'list_links'
        ? { success: false, code: 'research_link_list_unavailable', items: [] }
        : mutationFailure('research_mutation_unavailable');
    }
  }

  handleReview(request: ResearchReviewRequest): ResearchMutationResult | Promise<ResearchMutationResult> {
    try {
      if (request.reviewKind === 'note_code') {
        const before = this.repository.getNoteCode(request.entityId);
        if (!before || before.projectId !== request.projectId) return mutationFailure('not_found');
        const after = this.repository.reviewNoteCode(request.entityId, request.decision, request.edits ?? {});
        if (!after) return mutationFailure('not_found');
        if (request.decision !== 'pending') {
          this.repository.recordDecision({
            id: `decision_${randomUUID().replaceAll('-', '')}`,
            projectId: request.projectId,
            runId: null,
            targetKind: 'note_code',
            targetId: request.entityId,
            decision: request.decision === 'rejected'
              ? 'reject'
              : request.edits
                ? 'edit'
                : 'accept',
            origin: 'human',
            beforeValue: before as unknown as Record<string, unknown>,
            afterValue: after as unknown as Record<string, unknown>,
            note: request.reason,
            createdAt: Date.now(),
            undoneAt: null,
          });
        }
        return mutationSuccess('reviewed', request.projectId, 'note_code', request.entityId);
      }

      const artifact = this.repository.getArtifact(request.entityId);
      if (!artifact || artifact.projectId !== request.projectId) return mutationFailure('not_found');
      if (artifact.version !== request.expectedVersion) return mutationFailure('conflict');
      const latest = this.repository.getArtifactVersion(artifact.id, request.expectedVersion);
      if (!latest) return mutationFailure('rejected');
      const manifest = ArtifactManifestSchema.safeParse(latest.manifest);
      if (!manifest.success) return mutationFailure('rejected');
      const nextManifest: ArtifactManifest = {
        ...manifest.data,
        reviewStatus: request.toStatus,
        version: artifact.version + 1,
        reviewTrail: [
          ...manifest.data.reviewTrail,
          {
            at: Date.now(),
            from: artifact.reviewStatus,
            to: request.toStatus,
            reason: request.reason,
          },
        ],
      };
      if (request.toStatus === 'verified') {
        return this.saveVerifiedArtifactReview(request, nextManifest, latest.content, latest.thumbnailRef);
      }
      const version = this.repository.saveArtifactVersion(nextManifest, latest.content, {
        createdBy: 'user',
        branchFromVersion: latest.version,
        thumbnailRef: latest.thumbnailRef,
      });
      return mutationSuccess('reviewed', request.projectId, 'artifact', artifact.id, version.version);
    } catch {
      return mutationFailure('research_mutation_unavailable');
    }
  }

  private async saveVerifiedArtifactReview(
    request: Extract<ResearchReviewRequest, { reviewKind: 'artifact' }>,
    manifest: ArtifactManifest,
    content: string,
    thumbnailRef: string | null,
  ): Promise<ResearchMutationResult> {
    try {
      if (
        !this.citationReceipts
        || !manifest.deliverableProfile
        || !manifest.deliverableContext
        || !manifest.citationRequests
      ) return mutationFailure('rejected');
      const approvalArtifactVersion = request.expectedVersion;
      const contentDigest = createHash('sha256').update(content, 'utf8').digest('hex');
      const profile = enforceDeliverableProfile({
        projectId: manifest.projectId,
        artifactId: manifest.id,
        binding: manifest.deliverableProfile,
        context: manifest.deliverableContext,
        content,
        citedSourceIds: manifest.citedSourceIds,
        sources: this.repository.listSources(manifest.projectId, false),
        decisions: this.repository.listDecisions(manifest.projectId),
        approvalArtifactVersion,
        contentDigest,
      });
      if (!profile.passed || !profile.compliance) return mutationFailure('rejected');
      const receipts = await this.citationReceipts.issueReceipts(this.repository, {
        projectId: manifest.projectId,
        artifactId: manifest.id,
        artifactVersion: manifest.version,
        content,
        citedSourceIds: manifest.citedSourceIds,
        citations: manifest.citationRequests,
      });
      if (!receipts) return mutationFailure('rejected');
      const version = this.repository.saveArtifactVersion({
        ...manifest,
        deliverableCompliance: profile.compliance,
        citationTruthReceipts: receipts,
      }, content, {
        createdBy: 'user',
        branchFromVersion: request.expectedVersion,
        thumbnailRef,
      });
      return mutationSuccess('reviewed', request.projectId, 'artifact', manifest.id, version.version);
    } catch {
      return mutationFailure('research_mutation_unavailable');
    }
  }

  handleRestore(request: ResearchRestoreRequest): ResearchMutationResult {
    try {
      const value = this.getScopedEntity(request.entityKind, request.entityId, request.projectId, true);
      if (!value) return mutationFailure('not_found');
      const restored = request.entityKind === 'project'
        ? this.repository.restoreProject(request.entityId)
        : request.entityKind === 'source'
          ? this.repository.restoreSource(request.entityId)
          : request.entityKind === 'evidence'
            ? this.repository.restoreEvidence(request.entityId)
            : request.entityKind === 'note_code'
              ? this.repository.restoreNoteCode(request.entityId)
              : request.entityKind === 'claim'
                ? this.repository.restoreClaim(request.entityId)
                : this.repository.restoreArtifact(request.entityId);
      return restored
        ? mutationSuccess('restored', request.projectId, request.entityKind, request.entityId)
        : mutationFailure('conflict');
    } catch {
      return mutationFailure('research_mutation_unavailable');
    }
  }

  handleVersion(request: ResearchArtifactVersionRequest): VersionResult | Promise<VersionResult> {
    try {
      if (request.operation === 'get_version') {
        const artifact = this.repository.getArtifact(request.artifactId, true);
        if (!artifact || artifact.projectId !== request.projectId) {
          return { success: false, code: 'research_version_unavailable' };
        }
        const item = this.repository.getArtifactVersion(request.artifactId, request.version);
        const presented = item ? presentArtifactVersion(item) : undefined;
        return presented
          ? { success: true, item: presented }
          : { success: false, code: 'research_version_unavailable' };
      }
      if (request.operation === 'list_versions') {
        const artifact = this.repository.getArtifact(request.artifactId, true);
        if (!artifact || artifact.projectId !== request.projectId) {
          return { success: false, code: 'research_version_list_unavailable', items: [] };
        }
        const items = paginate(
          this.repository.listArtifactVersions(request.artifactId),
          request.offset,
          request.limit,
        ).map(presentArtifactVersion);
        return items.includes(undefined)
          ? { success: false, code: 'research_version_list_unavailable', items: [] }
          : { success: true, items: items as NonNullable<(typeof items)[number]>[] };
      }
      if (request.operation === 'restore_version') {
        const artifact = this.repository.getArtifact(request.artifactId, true);
        if (!artifact || artifact.projectId !== request.projectId) return mutationFailure('not_found');
        const restored = this.repository.restoreArtifactVersion(
          request.artifactId,
          request.version,
          request.createdBy,
        );
        return restored
          ? mutationSuccess('versioned', request.projectId, 'artifact_version', request.artifactId, restored.version)
          : mutationFailure('not_found');
      }

      const current = this.repository.getArtifact(request.artifactId, true);
      if (current && current.projectId !== request.projectId) return mutationFailure('forbidden');
      if ((current?.version ?? null) !== request.expectedVersion) return mutationFailure('conflict');
      const latest = current ? this.repository.getArtifactVersion(current.id) : undefined;
      const latestManifest = latest ? ArtifactManifestSchema.safeParse(latest.manifest) : undefined;
      const media = request.media.length === 0
        ? []
        : this.mediaResolver?.resolveManifestDescriptors(request.projectId, request.media);
      if (media === null || media === undefined) return mutationFailure('rejected');
      const inputs = [...request.inputs];
      for (const item of media) {
        if (!inputs.some((input) => input.kind === 'source' && input.id === item.sourceId)) {
          inputs.push({ kind: 'source', id: item.sourceId });
        }
      }
      const now = Date.now();
      const nextVersion = current ? current.version + 1 : 1;
      const manifest: ArtifactManifest = {
        id: request.artifactId,
        projectId: request.projectId,
        title: request.title,
        artifactType: request.artifactType,
        reviewStatus: request.reviewStatus,
        inputs,
        generatedBy: {
          capabilityId: request.capabilityId,
          method: request.method,
        },
        citedSourceIds: request.citedSourceIds,
        ...(request.deliverableProfile === undefined ? {} : { deliverableProfile: request.deliverableProfile }),
        ...(request.deliverableContext === undefined ? {} : { deliverableContext: request.deliverableContext }),
        ...(request.citationRequests.length === 0 ? {} : { citationRequests: request.citationRequests }),
        renderer: {
          kind: request.rendererKind,
          ...(request.rendererSpec === undefined ? {} : { spec: request.rendererSpec }),
          ...(request.contentRef === null ? {} : { contentRef: request.contentRef }),
        },
        ...(media.length === 0 ? {} : { media }),
        ...(request.inputHash === null ? {} : { inputHash: request.inputHash }),
        reviewTrail: latestManifest?.success ? latestManifest.data.reviewTrail : [],
        version: nextVersion,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      if (request.reviewStatus === 'verified') {
        return this.saveVerifiedArtifactVersion(request, manifest, latest);
      }
      const saved = this.repository.saveArtifactVersion(manifest, request.content, {
        createdBy: request.createdBy,
        branchFromVersion: request.branchFromVersion,
      });
      return mutationSuccess('versioned', request.projectId, 'artifact_version', request.artifactId, saved.version);
    } catch {
      return request.operation === 'get_version'
        ? { success: false, code: 'research_version_unavailable' }
        : request.operation === 'list_versions'
          ? { success: false, code: 'research_version_list_unavailable', items: [] }
          : mutationFailure('research_mutation_unavailable');
    }
  }

  private async saveVerifiedArtifactVersion(
    request: Extract<ResearchArtifactVersionRequest, { operation: 'save_version' }>,
    manifest: ArtifactManifest,
    approvalVersion: ArtifactVersionRecord | undefined,
  ): Promise<VersionResult> {
    try {
      if (!this.citationReceipts || !manifest.deliverableProfile || !manifest.deliverableContext) {
        return mutationFailure('rejected');
      }
      const contentDigest = createHash('sha256').update(request.content, 'utf8').digest('hex');
      if (
        !approvalVersion
        || approvalVersion.version !== manifest.version - 1
        || approvalVersion.contentHash !== contentDigest
      ) return mutationFailure('rejected');
      const profile = enforceDeliverableProfile({
        projectId: manifest.projectId,
        artifactId: manifest.id,
        binding: manifest.deliverableProfile,
        context: manifest.deliverableContext,
        content: request.content,
        citedSourceIds: manifest.citedSourceIds,
        sources: this.repository.listSources(manifest.projectId, false),
        decisions: this.repository.listDecisions(manifest.projectId),
        approvalArtifactVersion: approvalVersion.version,
        contentDigest,
      });
      if (!profile.passed || !profile.compliance) return mutationFailure('rejected');
      const receipts = await this.citationReceipts.issueReceipts(this.repository, {
        projectId: manifest.projectId,
        artifactId: manifest.id,
        artifactVersion: manifest.version,
        content: request.content,
        citedSourceIds: manifest.citedSourceIds,
        citations: request.citationRequests,
      });
      if (!receipts) return mutationFailure('rejected');
      const trustedManifest: ArtifactManifest = {
        ...manifest,
        deliverableCompliance: profile.compliance,
        citationTruthReceipts: receipts,
      };
      const saved = this.repository.saveArtifactVersion(trustedManifest, request.content, {
        createdBy: request.createdBy,
        branchFromVersion: request.branchFromVersion,
      });
      return mutationSuccess('versioned', request.projectId, 'artifact_version', request.artifactId, saved.version);
    } catch {
      return mutationFailure('research_mutation_unavailable');
    }
  }

  handleCheckpoint(request: ResearchCheckpointRequest): CheckpointResult {
    try {
      const run = this.repository.getRun(request.runId, true);
      if (!run || run.projectId !== request.projectId) {
        return request.operation === 'latest_checkpoint'
          ? { success: false, code: 'research_checkpoint_unavailable' }
          : request.operation === 'list_checkpoints'
            ? { success: false, code: 'research_checkpoint_list_unavailable', items: [] }
            : mutationFailure('not_found');
      }
      if (request.operation === 'latest_checkpoint') {
        const item = this.repository.latestCheckpoint(request.runId);
        const presented = item ? presentCheckpoint(item) : undefined;
        return presented
          ? { success: true, item: presented }
          : { success: false, code: 'research_checkpoint_unavailable' };
      }
      if (request.operation === 'list_checkpoints') {
        const items = paginate(
          this.repository.listCheckpoints(request.runId),
          request.offset,
          request.limit,
        ).map(presentCheckpoint);
        return items.includes(undefined)
          ? { success: false, code: 'research_checkpoint_list_unavailable', items: [] }
          : { success: true, items: items as NonNullable<(typeof items)[number]>[] };
      }
      const checkpoint: ResearchCheckpoint = {
        id: request.checkpointId,
        projectId: request.projectId,
        runId: request.runId,
        stepId: request.stepId,
        lifecycle: request.lifecycle,
        inputHash: request.inputHash,
        outputHash: request.outputHash,
        completedSteps: request.completedSteps,
        output: request.outputSummary ? { summary: request.outputSummary } : {},
        decisions: request.decisionIds,
        sideEffectKeys: [],
        pendingSteps: request.pendingSteps,
        runtimeProfileVersion: request.runtimeProfileVersion,
        errorCategory: request.errorCategory,
        recoveryStrategy: request.recoveryStrategy,
        createdAt: Date.now(),
      };
      this.repository.recordCheckpoint(checkpoint);
      return mutationSuccess('checkpointed', request.projectId, 'checkpoint', request.checkpointId);
    } catch {
      return request.operation === 'latest_checkpoint'
        ? { success: false, code: 'research_checkpoint_unavailable' }
        : request.operation === 'list_checkpoints'
          ? { success: false, code: 'research_checkpoint_list_unavailable', items: [] }
          : mutationFailure('research_mutation_unavailable');
    }
  }

  handleDecision(request: ResearchDecisionRequest): DecisionResult {
    try {
      if (request.operation === 'list_decisions') {
        const items = paginate(
          this.repository.listDecisions(request.projectId, request.runId),
          request.offset,
          request.limit,
        ).map(presentDecision);
        return items.includes(undefined)
          ? { success: false, code: 'research_decision_list_unavailable', items: [] }
          : { success: true, items: items as NonNullable<(typeof items)[number]>[] };
      }
      if (request.operation === 'undo_decision') {
        const existing = this.repository.listDecisions(request.projectId)
          .find((item) => item.id === request.decisionId);
        if (!existing) return mutationFailure('not_found');
        const undone = this.repository.undoDecision(request.decisionId);
        return undone
          ? mutationSuccess('undone', request.projectId, 'decision', request.decisionId)
          : mutationFailure('conflict');
      }

      if (this.repository.listDecisions(request.projectId).some((item) => item.id === request.decisionId)) {
        return mutationFailure('conflict');
      }
      if (request.runId) {
        const run = this.repository.getRun(request.runId, true);
        if (!run || run.projectId !== request.projectId) return mutationFailure('not_found');
      }
      const current = this.readDecisionTarget(request.projectId, request.targetKind, request.targetId);
      if (request.targetKind !== 'plan' && current === undefined) return mutationFailure('not_found');
      let approvalBinding: Record<string, unknown> = {};
      if (request.approvalStage !== undefined) {
        const artifact = this.repository.getArtifact(request.targetId);
        const version = artifact
          ? this.repository.getArtifactVersion(artifact.id, artifact.version)
          : undefined;
        if (!artifact || artifact.projectId !== request.projectId || !version) return mutationFailure('rejected');
        approvalBinding = {
          deliverableApprovalStage: request.approvalStage,
          deliverableApprovalArtifactVersion: version.version,
          deliverableApprovalContentDigest: version.contentHash,
        };
      }
      this.repository.recordDecision({
        id: request.decisionId,
        projectId: request.projectId,
        runId: request.runId,
        targetKind: request.targetKind,
        targetId: request.targetId,
        decision: request.decision,
        origin: 'human',
        beforeValue: current ?? {},
        afterValue: request.approvalStage === undefined
          ? (current ?? {})
          : { ...(current ?? {}), ...approvalBinding },
        note: request.note,
        createdAt: Date.now(),
        undoneAt: null,
      });
      return mutationSuccess('decided', request.projectId, 'decision', request.decisionId);
    } catch {
      return request.operation === 'list_decisions'
        ? { success: false, code: 'research_decision_list_unavailable', items: [] }
        : mutationFailure('research_mutation_unavailable');
    }
  }

  getSnapshot(projectId: string): ResearchSnapshotResult {
    try {
      const value = this.repository.snapshotProject(projectId);
      const snapshot = value
        ? presentSnapshot(value, (artifact) => this.trustedArtifactReviewStatus(artifact))
        : undefined;
      return snapshot
        ? { success: true, snapshot }
        : { success: false, code: 'research_snapshot_unavailable' };
    } catch {
      return { success: false, code: 'research_snapshot_unavailable' };
    }
  }

  private createEntity(request: Extract<ResearchCrudRequest, { operation: 'create' }>): ResearchMutationResult {
    const now = Date.now();
    if (request.entityKind === 'project') {
      if (this.repository.getProject(request.projectId, true)) return mutationFailure('conflict');
      const project: Project = {
        id: request.projectId,
        ...request.value,
        metadata: {},
        createdAt: now,
        updatedAt: now,
        archivedAt: request.value.lifecycle === 'archived' ? now : null,
        version: 1,
        source: 'user',
        deletedAt: null,
      };
      this.repository.createProject(project);
      return mutationSuccess('created', project.id, 'project', project.id, project.version);
    }
    if (!this.repository.getProject(request.projectId)) return mutationFailure('not_found');
    if (this.getScopedEntity(request.entityKind, request.value.id, request.projectId, true)) {
      return mutationFailure('conflict');
    }
    if (request.entityKind === 'source') {
      if (request.value.sourceVersionHash !== null) return mutationFailure('rejected');
      const { deliverableSourceKind, deliverableRuleKind, ...sourceValue } = request.value;
      const source: Source = {
        ...sourceValue,
        projectId: request.projectId,
        filePath: null,
        metadata: {
          ...(deliverableSourceKind === null ? {} : { deliverableSourceKind }),
          ...(deliverableRuleKind === null ? {} : { deliverableRuleKind }),
        },
        sourceVersionHash: null,
        provenance: { origin: 'user', importedAt: now },
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      this.repository.saveSource(source);
      return mutationSuccess('created', request.projectId, 'source', source.id);
    }
    if (request.entityKind === 'evidence') {
      const source = this.repository.getSource(request.value.sourceId);
      if (!source || source.projectId !== request.projectId) return mutationFailure('not_found');
      const evidence: Evidence = {
        ...request.value,
        projectId: request.projectId,
        metadata: {},
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      this.repository.saveEvidence(evidence);
      return mutationSuccess('created', request.projectId, 'evidence', evidence.id);
    }
    if (request.entityKind === 'note_code') {
      if (request.value.evidenceId) {
        const evidence = this.repository.getEvidence(request.value.evidenceId);
        if (!evidence || evidence.projectId !== request.projectId) return mutationFailure('not_found');
      }
      const noteCode: NoteCode = {
        ...request.value,
        projectId: request.projectId,
        accepted: request.value.author === 'ai' ? 'pending' : request.value.accepted,
        metadata: {},
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      this.repository.saveNoteCode(noteCode);
      return mutationSuccess('created', request.projectId, 'note_code', noteCode.id);
    }
    if (request.entityKind === 'claim') {
      const claim: Claim = {
        ...request.value,
        projectId: request.projectId,
        status: 'unsupported',
        metadata: { origin: 'human' },
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      this.repository.saveClaim(claim);
      return mutationSuccess('created', request.projectId, 'claim', claim.id);
    }
    if (request.value.reviewStatus === 'verified') return mutationFailure('rejected');
    const artifact: ResearchArtifact = {
      ...request.value,
      projectId: request.projectId,
      provenance: {},
      metadata: {},
      version: 1,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.repository.saveArtifact(artifact);
    return mutationSuccess('created', request.projectId, 'artifact', artifact.id, artifact.version);
  }

  private listEntities(request: Extract<ResearchCrudRequest, { operation: 'list' }>): ResearchEntityListResult {
    const values = request.entityKind === 'project'
      ? this.repository.listProjects({
          includeDeleted: request.includeDeleted,
          limit: request.limit,
          offset: request.offset,
        })
      : request.entityKind === 'source'
        ? paginate(this.repository.listSources(request.projectId, request.includeDeleted), request.offset, request.limit)
        : request.entityKind === 'evidence'
          ? paginate(
              this.repository.listEvidence(request.projectId, request.sourceId, request.includeDeleted),
              request.offset,
              request.limit,
            )
          : request.entityKind === 'note_code'
            ? paginate(this.repository.listNoteCodes(request.projectId, {
                includeDeleted: request.includeDeleted,
                evidenceId: request.evidenceId,
                acceptance: request.acceptance,
              }), request.offset, request.limit)
            : request.entityKind === 'claim'
              ? paginate(this.repository.listClaims(request.projectId, request.includeDeleted), request.offset, request.limit)
              : paginate(this.repository.listArtifacts(request.projectId, request.includeDeleted), request.offset, request.limit);
    const items = values.map((value) => presentEntity(
      request.entityKind,
      value,
      (artifact) => this.trustedArtifactReviewStatus(artifact),
    ));
    return items.includes(undefined)
      ? { success: false, code: 'research_entity_list_unavailable', items: [] }
      : { success: true, items: items as ResearchEntityEnvelope[] };
  }

  private updateEntity(request: Extract<ResearchCrudRequest, { operation: 'update' }>): ResearchMutationResult {
    const current = this.getScopedEntity(request.entityKind, request.entityId, request.projectId, false);
    if (!current) return mutationFailure('not_found');
    if (request.entityKind === 'project') {
      const updated = this.repository.updateProject(request.entityId, request.patch);
      return updated
        ? mutationSuccess('updated', request.projectId, 'project', request.entityId, updated.version)
        : mutationFailure('not_found');
    }
    const now = Date.now();
    if (request.entityKind === 'source') {
      const source = current as Source;
      if (Object.hasOwn(request.patch, 'sourceVersionHash')) return mutationFailure('rejected');
      if (
        this.mediaResolver?.isManagedSource(source)
        && (
          Object.hasOwn(request.patch, 'kind')
          || Object.hasOwn(request.patch, 'identifier')
          || Object.hasOwn(request.patch, 'identifierType')
        )
      ) return mutationFailure('rejected');
      const { deliverableSourceKind, deliverableRuleKind, ...sourcePatch } = request.patch;
      const metadata = { ...source.metadata };
      if (deliverableSourceKind !== undefined) {
        if (deliverableSourceKind === null) delete metadata.deliverableSourceKind;
        else metadata.deliverableSourceKind = deliverableSourceKind;
      }
      if (deliverableRuleKind !== undefined) {
        if (deliverableRuleKind === null) delete metadata.deliverableRuleKind;
        else metadata.deliverableRuleKind = deliverableRuleKind;
      }
      this.repository.saveSource({ ...source, ...sourcePatch, metadata, updatedAt: now });
    } else if (request.entityKind === 'evidence') {
      const next = { ...(current as Evidence), ...request.patch, updatedAt: now };
      const source = this.repository.getSource(next.sourceId);
      if (!source || source.projectId !== request.projectId) return mutationFailure('not_found');
      if (next.anchorStart !== null && next.anchorEnd !== null && next.anchorEnd < next.anchorStart) {
        return mutationFailure('rejected');
      }
      this.repository.saveEvidence(next);
      this.repository.markArtifactsStaleForInput('evidence', next.id);
    } else if (request.entityKind === 'note_code') {
      const next = { ...(current as NoteCode), ...request.patch, updatedAt: now };
      if (next.evidenceId) {
        const evidence = this.repository.getEvidence(next.evidenceId);
        if (!evidence || evidence.projectId !== request.projectId) return mutationFailure('not_found');
      }
      if (next.author === 'ai' && (current as NoteCode).author !== 'ai') next.accepted = 'pending';
      this.repository.saveNoteCode(next);
    } else if (request.entityKind === 'claim') {
      const next = { ...(current as Claim), ...request.patch, updatedAt: now };
      this.repository.saveClaim(next);
      this.repository.markArtifactsStaleForInput('claim', next.id);
    } else {
      const next = { ...(current as ResearchArtifact), ...request.patch, updatedAt: now };
      this.repository.saveArtifact(next);
    }
    return mutationSuccess('updated', request.projectId, request.entityKind, request.entityId);
  }

  private deleteEntity(request: Extract<ResearchCrudRequest, { operation: 'delete' }>): ResearchMutationResult {
    const current = this.getScopedEntity(request.entityKind, request.entityId, request.projectId, false);
    if (!current) return mutationFailure('not_found');
    const deleted = request.entityKind === 'project'
      ? this.repository.softDeleteProject(request.entityId)
      : request.entityKind === 'source'
        ? this.repository.softDeleteSource(request.entityId)
        : request.entityKind === 'evidence'
          ? this.repository.softDeleteEvidence(request.entityId)
          : request.entityKind === 'note_code'
            ? this.repository.softDeleteNoteCode(request.entityId)
            : request.entityKind === 'claim'
              ? this.repository.softDeleteClaim(request.entityId)
              : this.repository.softDeleteArtifact(request.entityId);
    return deleted
      ? mutationSuccess('deleted', request.projectId, request.entityKind, request.entityId)
      : mutationFailure('not_found');
  }

  private trustedArtifactReviewStatus(artifact: ResearchArtifact): ResearchArtifact['reviewStatus'] {
    if (artifact.reviewStatus !== 'verified') return artifact.reviewStatus;
    if (!this.citationReceipts || artifact.deletedAt !== null) return 'draft';
    const version = this.repository.getArtifactVersion(artifact.id, artifact.version);
    const parsed = version ? ArtifactManifestSchema.safeParse(version.manifest) : null;
    if (
      !version
      || !parsed?.success
      || parsed.data.id !== artifact.id
      || parsed.data.projectId !== artifact.projectId
      || parsed.data.version !== artifact.version
      || createHash('sha256').update(version.content, 'utf8').digest('hex') !== version.contentHash
    ) return 'draft';
    const authority = verifyArtifactForPersistence(
      this.repository,
      this.citationReceipts,
      parsed.data,
      version.content,
    );
    return effectiveArtifactReviewStatus(parsed.data, authority);
  }

  private getScopedEntity(
    kind: ResearchCrudRequest['entityKind'],
    id: string,
    projectId: string,
    includeDeleted: boolean,
  ): Project | Source | Evidence | NoteCode | Claim | ResearchArtifact | undefined {
    const value = kind === 'project'
      ? this.repository.getProject(id, includeDeleted)
      : kind === 'source'
        ? this.repository.getSource(id, includeDeleted)
        : kind === 'evidence'
          ? this.repository.getEvidence(id, includeDeleted)
          : kind === 'note_code'
            ? this.repository.getNoteCode(id, includeDeleted)
            : kind === 'claim'
              ? this.repository.getClaim(id, includeDeleted)
              : this.repository.getArtifact(id, includeDeleted);
    if (!value) return undefined;
    const valueProjectId = kind === 'project'
      ? (value as Project).id
      : (value as Source | Evidence | NoteCode | Claim | ResearchArtifact).projectId;
    return valueProjectId === projectId ? value : undefined;
  }

  private readDecisionTarget(
    projectId: string,
    kind: ResearchDecision['targetKind'],
    id: string,
  ): Record<string, unknown> | undefined {
    if (kind === 'plan') return {};
    const entity = this.getScopedEntity(kind, id, projectId, true);
    return entity as unknown as Record<string, unknown> | undefined;
  }
}

export const ResearchRuntimePresenters = Object.freeze({
  project: presentProject,
  source: presentSource,
  evidence: presentEvidence,
  noteCode: presentNoteCode,
  claim: presentClaim,
  artifact: presentArtifact,
  link: presentLink,
  artifactVersion: presentArtifactVersion,
  run: presentRun,
  checkpoint: presentCheckpoint,
  decision: presentDecision,
  snapshot: presentSnapshot,
});
