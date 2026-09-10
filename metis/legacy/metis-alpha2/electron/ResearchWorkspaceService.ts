import { randomUUID } from 'node:crypto';
import type { ArtifactManifest } from '../engine/artifacts/ArtifactManifest.js';
import { buildEvidence, relocationFor, type AnchorSpec } from '../engine/sources/EvidenceAnchor.js';
import { normalizeSource, type SourceInput } from '../engine/sources/SourceService.js';
import { createProjectFromIntent } from '../engine/setup/QuickStart.js';
import { ResearchRepository } from '../engine/persistence/ResearchRepository.js';
import type {
  ArtifactVersionRecord,
  Claim,
  ClaimEvidenceLink,
  Evidence,
  NoteCode,
  Project,
  ProjectSnapshot,
  ResearchDecision,
  Source,
} from '../engine/persistence/researchModel.js';

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export interface ImportSourceOptions {
  sourceVersionHash?: string | null;
  provenance?: Record<string, unknown>;
}

export type ImportSourceResult =
  | { status: 'created'; source: Source }
  | { status: 'duplicate'; source: Source };

export interface CreateEvidenceRequest {
  projectId: string;
  sourceId: string;
  anchor: AnchorSpec;
  snippet: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface NoteCodeProposal {
  projectId: string;
  evidenceId?: string | null;
  code: string;
  content: string;
  tags?: string[];
  confidence?: number;
  origin: 'human' | 'ai';
}

export interface ClaimProposal {
  projectId: string;
  statement: string;
  claimType?: Claim['claimType'];
  confidence?: number;
  origin: 'human' | 'ai';
  metadata?: Record<string, unknown>;
}

/**
 * Production application service for the six research objects.
 *
 * Renderer code never talks to SQLite or the domain helpers directly. The main process
 * calls this service after sender authorization and runtime-schema validation, then a
 * presentation contract selects the fields that may cross preload.
 */
export class ResearchWorkspaceService {
  constructor(private readonly repository: ResearchRepository) {}

  createProjectFromNaturalLanguage(
    intent: string,
    options: { discipline?: string; methodology?: string; source?: string } = {},
  ): Project {
    const quickStart = createProjectFromIntent(intent, {
      generateId: () => id('project'),
    });
    const project: Project = {
      id: quickStart.id,
      title: quickStart.title,
      originalIntent: quickStart.originalIntent,
      researchQuestion: '',
      lifecycle: quickStart.lifecycle,
      methodology: options.methodology ?? '',
      discipline: options.discipline ?? '',
      metadata: {
        routing: {
          capabilityId: quickStart.routing.classification.primaryCapabilityId,
          confidence: quickStart.routing.classification.confidence,
        },
        nextAction: quickStart.nextAction.kind,
      },
      createdAt: quickStart.createdAt,
      updatedAt: quickStart.createdAt,
      archivedAt: null,
      version: 1,
      source: options.source ?? 'user',
      deletedAt: null,
    };
    return this.repository.createProject(project);
  }

  updateProject(
    projectId: string,
    patch: Parameters<ResearchRepository['updateProject']>[1],
  ): Project | undefined {
    return this.repository.updateProject(projectId, patch);
  }

  listProjects(): Project[] {
    return this.repository.listProjects();
  }

  recycleProject(projectId: string): boolean {
    return this.repository.softDeleteProject(projectId);
  }

  restoreProject(projectId: string): boolean {
    return this.repository.restoreProject(projectId);
  }

  importSource(
    projectId: string,
    input: SourceInput,
    options: ImportSourceOptions = {},
  ): ImportSourceResult {
    const project = this.repository.getProject(projectId);
    if (!project) throw new Error('Project is unavailable');
    const normalized = normalizeSource(projectId, input, {
      generateId: (kind) => id(kind),
    });
    const source: Source = {
      ...normalized,
      sourceVersionHash: options.sourceVersionHash ?? normalized.sourceVersionHash,
      provenance: { ...normalized.provenance, ...(options.provenance ?? {}) },
    };
    const duplicate = this.repository.findSourceDuplicate(
      projectId,
      source.identifier,
      source.sourceVersionHash,
    );
    if (duplicate) return { status: 'duplicate', source: duplicate };
    this.repository.saveSource(source);
    return { status: 'created', source };
  }

  updateSource(source: Source): Source {
    const existing = this.repository.getSource(source.id);
    if (!existing || existing.projectId !== source.projectId) {
      throw new Error('Source is unavailable');
    }
    return this.repository.saveSource({ ...source, updatedAt: Date.now() });
  }

  recycleSource(sourceId: string): boolean {
    return this.repository.softDeleteSource(sourceId);
  }

  restoreSource(sourceId: string): boolean {
    return this.repository.restoreSource(sourceId);
  }

  createEvidence(request: CreateEvidenceRequest): Evidence {
    const source = this.repository.getSource(request.sourceId);
    if (!source || source.projectId !== request.projectId) {
      throw new Error('Source is unavailable');
    }
    const evidence = buildEvidence({
      id: id('evidence'),
      projectId: request.projectId,
      sourceId: request.sourceId,
      anchor: request.anchor,
      snippet: request.snippet,
      sourceVersionHash: source.sourceVersionHash ?? '',
      confidence: request.confidence,
      metadata: request.metadata,
    });
    return this.repository.saveEvidence(evidence);
  }

  relocateEvidence(evidenceId: string): ReturnType<typeof relocationFor> | undefined {
    const evidence = this.repository.getEvidence(evidenceId);
    return evidence ? relocationFor(evidence) : undefined;
  }

  recycleEvidence(evidenceId: string): boolean {
    return this.repository.softDeleteEvidence(evidenceId);
  }

  restoreEvidence(evidenceId: string): boolean {
    return this.repository.restoreEvidence(evidenceId);
  }

  proposeNoteCode(proposal: NoteCodeProposal): NoteCode {
    if (proposal.evidenceId) {
      const evidence = this.repository.getEvidence(proposal.evidenceId);
      if (!evidence || evidence.projectId !== proposal.projectId) {
        throw new Error('Evidence is unavailable');
      }
    }
    const now = Date.now();
    const noteCode: NoteCode = {
      id: id('note'),
      projectId: proposal.projectId,
      evidenceId: proposal.evidenceId ?? null,
      code: proposal.code,
      content: proposal.content,
      author: proposal.origin,
      confidence: proposal.origin === 'ai' ? proposal.confidence ?? 0 : 1,
      accepted: proposal.origin === 'ai' ? 'pending' : 'accepted',
      tags: proposal.tags ?? [],
      metadata: {},
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    return this.repository.saveNoteCode(noteCode);
  }

  reviewNoteCode(
    noteCodeId: string,
    decision: 'accepted' | 'rejected',
    edits: Partial<Pick<NoteCode, 'code' | 'content' | 'tags'>> = {},
    runId?: string,
  ): NoteCode | undefined {
    const before = this.repository.getNoteCode(noteCodeId);
    if (!before) return undefined;
    const after = this.repository.reviewNoteCode(noteCodeId, decision, edits);
    if (!after) return undefined;
    this.repository.recordDecision({
      id: id('decision'),
      projectId: after.projectId,
      runId: runId ?? null,
      targetKind: 'note_code',
      targetId: after.id,
      decision: decision === 'accepted' && Object.keys(edits).length > 0 ? 'edit' : decision === 'accepted' ? 'accept' : 'reject',
      origin: 'human',
      beforeValue: before as unknown as Record<string, unknown>,
      afterValue: after as unknown as Record<string, unknown>,
      note: '',
      createdAt: Date.now(),
      undoneAt: null,
    });
    return after;
  }

  undoNoteCodeDecision(decisionId: string): NoteCode | undefined {
    const decision = this.repository.undoDecision(decisionId);
    if (!decision || decision.targetKind !== 'note_code') return undefined;
    const before = decision.beforeValue as unknown as NoteCode;
    if (!before.id || before.id !== decision.targetId) return undefined;
    return this.repository.saveNoteCode({ ...before, updatedAt: Date.now() });
  }

  recycleNoteCode(noteCodeId: string): boolean {
    return this.repository.softDeleteNoteCode(noteCodeId);
  }

  restoreNoteCode(noteCodeId: string): boolean {
    return this.repository.restoreNoteCode(noteCodeId);
  }

  proposeClaim(proposal: ClaimProposal): Claim {
    const now = Date.now();
    const claim: Claim = {
      id: id('claim'),
      projectId: proposal.projectId,
      statement: proposal.statement,
      claimType: proposal.claimType ?? 'assertion',
      confidence: proposal.origin === 'human' ? 1 : proposal.confidence ?? 0,
      status: 'unsupported',
      metadata: { ...(proposal.metadata ?? {}), origin: proposal.origin },
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    return this.repository.saveClaim(claim);
  }

  reviseClaim(
    claimId: string,
    statement: string,
    runId?: string,
  ): Claim | undefined {
    const before = this.repository.getClaim(claimId);
    if (!before) return undefined;
    const after = this.repository.saveClaim({ ...before, statement, updatedAt: Date.now() });
    this.repository.recordDecision({
      id: id('decision'),
      projectId: after.projectId,
      runId: runId ?? null,
      targetKind: 'claim',
      targetId: after.id,
      decision: 'edit',
      origin: 'human',
      beforeValue: before as unknown as Record<string, unknown>,
      afterValue: after as unknown as Record<string, unknown>,
      note: '',
      createdAt: Date.now(),
      undoneAt: null,
    });
    this.repository.markArtifactsStaleForInput('claim', claimId);
    return after;
  }

  linkClaimToEvidence(input: {
    claimId: string;
    evidenceId: string;
    relation: ClaimEvidenceLink['relation'];
    weight?: number;
    note?: string;
  }): ClaimEvidenceLink {
    const claim = this.repository.getClaim(input.claimId);
    const evidence = this.repository.getEvidence(input.evidenceId);
    if (!claim || !evidence || claim.projectId !== evidence.projectId) {
      throw new Error('Claim or evidence is unavailable');
    }
    const link: ClaimEvidenceLink = {
      id: id('link'),
      claimId: input.claimId,
      evidenceId: input.evidenceId,
      relation: input.relation,
      weight: input.weight ?? 1,
      note: input.note ?? '',
      createdAt: Date.now(),
    };
    return this.repository.linkClaimEvidence(link);
  }

  recycleClaim(claimId: string): boolean {
    return this.repository.softDeleteClaim(claimId);
  }

  restoreClaim(claimId: string): boolean {
    return this.repository.restoreClaim(claimId);
  }

  saveArtifact(
    manifest: ArtifactManifest,
    content: string,
    options: Parameters<ResearchRepository['saveArtifactVersion']>[2] = {},
  ): ArtifactVersionRecord {
    const project = this.repository.getProject(manifest.projectId);
    if (!project) throw new Error('Project is unavailable');
    return this.repository.saveArtifactVersion(manifest, content, options);
  }

  restoreArtifactVersion(artifactId: string, version: number): ArtifactVersionRecord | undefined {
    return this.repository.restoreArtifactVersion(artifactId, version, 'user');
  }

  recycleArtifact(artifactId: string): boolean {
    return this.repository.softDeleteArtifact(artifactId);
  }

  restoreArtifact(artifactId: string): boolean {
    return this.repository.restoreArtifact(artifactId);
  }

  workspaceSnapshot(projectId: string): ProjectSnapshot | undefined {
    return this.repository.snapshotProject(projectId);
  }

  recordResearcherDecision(
    decision: Omit<ResearchDecision, 'id' | 'createdAt' | 'origin' | 'undoneAt'>,
  ): ResearchDecision {
    return this.repository.recordDecision({
      ...decision,
      id: id('decision'),
      origin: 'human',
      createdAt: Date.now(),
      undoneAt: null,
    });
  }
}
