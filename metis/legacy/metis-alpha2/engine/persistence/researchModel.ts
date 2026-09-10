/**
 * Unified Research Data Model — six core objects (METIS-401).
 *
 * TypeScript types mirroring the SQL schema (engine/persistence/schema.ts). These are the
 * single user-cognitive model: Project, Source, Evidence, NoteCode, Claim, Artifact. The
 * runtime-layer objects (Task/Run/Workflow/Skill/ToolCall/Eval) are NOT here — they are
 * implementation, not user-facing entities.
 *
 * Every object carries: id, timestamps (created/updated), soft-delete (deleted_at),
 * version, and provenance/source. Relations are foreign-keyed in SQL and typed here.
 */

// ─── Project ──────────────────────────────────────────────────

import type { ResearchLifecycle } from '../core/types.js';

export interface Project {
  id: string;
  title: string;
  originalIntent: string;
  researchQuestion: string;
  lifecycle: ResearchLifecycle;
  methodology: string;
  discipline: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
  version: number;
  source: string; // provenance
  deletedAt: number | null;
}

// ─── Source ───────────────────────────────────────────────────

export type SourceKind = 'paper' | 'book' | 'pdf' | 'web' | 'archive' | 'image' | 'audio' | 'data' | 'other';
export type IdentifierType = 'doi' | 'arxiv' | 'isbn' | 'url' | 'other';

export interface Source {
  id: string;
  projectId: string;
  /** Canonical library paper mirrored by this project-local source, when any. */
  libraryPaperId?: string | null;
  kind: SourceKind;
  title: string;
  authors: string[];
  year: number | null;
  venue: string;
  identifier: string;
  identifierType: IdentifierType;
  filePath: string | null;
  externalUrl: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  sourceVersionHash: string | null;
  provenance: { origin?: string; importedAt?: number; license?: string };
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

// ─── Evidence (with anchor, METIS-404) ────────────────────────

export type AnchorType = 'page' | 'char_range' | 'timestamp' | 'region' | 'row' | 'none';

export interface Evidence {
  id: string;
  projectId: string;
  sourceId: string;
  anchorType: AnchorType;
  anchorStart: number | null;
  anchorEnd: number | null;
  pageNumber: number | null;
  snippet: string;
  snippetHash: string;
  sourceVersionHash: string | null;
  confidence: number;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

// ─── NoteCode ─────────────────────────────────────────────────

export type NoteCodeAuthor = 'human' | 'ai';
export type NoteCodeAcceptance = 'pending' | 'accepted' | 'rejected';

export interface NoteCode {
  id: string;
  projectId: string;
  evidenceId: string | null;
  code: string;
  content: string;
  author: NoteCodeAuthor;
  confidence: number;
  accepted: NoteCodeAcceptance;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

// ─── Claim ────────────────────────────────────────────────────

export type ClaimType = 'assertion' | 'hypothesis' | 'finding' | 'limitation';
export type ClaimStatus = 'unsupported' | 'supported' | 'contested' | 'refuted';

export interface Claim {
  id: string;
  projectId: string;
  statement: string;
  claimType: ClaimType;
  confidence: number;
  status: ClaimStatus;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

// ─── Claim-Evidence link (METIS-405 graph) ────────────────────

export type ClaimEvidenceRelation = 'supports' | 'contradicts' | 'qualifies';

export interface ClaimEvidenceLink {
  id: string;
  claimId: string;
  evidenceId: string;
  relation: ClaimEvidenceRelation;
  weight: number;
  note: string;
  createdAt: number;
}

// ─── Artifact (unified, project-scoped — METIS-401/601) ───────

export type ArtifactType = 'manuscript' | 'chart' | 'table' | 'report' | 'network' | 'other';
export type ArtifactReviewStatus = 'draft' | 'pending' | 'partial' | 'verified' | 'stale';

export interface ResearchArtifact {
  id: string;
  projectId: string;
  title: string;
  artifactType: ArtifactType;
  reviewStatus: ArtifactReviewStatus;
  contentRef: string | null;
  inputHash: string | null;
  provenance: Record<string, unknown>;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface ArtifactVersionRecord {
  artifactId: string;
  version: number;
  manifest: Record<string, unknown>;
  content: string;
  contentHash: string;
  thumbnailRef: string | null;
  createdAt: number;
  createdBy: 'user' | 'ai' | 'system';
  branchFromVersion: number | null;
}

export interface ArtifactInputRecord {
  artifactId: string;
  version: number;
  inputKind: 'claim' | 'evidence' | 'source' | 'dataset' | 'previous_artifact';
  inputId: string;
  inputHash: string | null;
}

// ─── Durable research execution ──────────────────────────────

export type ResearchRunStatus =
  | 'draft'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'failed'
  | 'cancelled'
  | 'reviewing'
  | 'completed';

export interface ResearchRun {
  id: string;
  projectId: string;
  status: ResearchRunStatus;
  plan: Record<string, unknown>;
  providerProfile: Record<string, unknown>;
  currentStepId: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  deletedAt: number | null;
}

export interface ResearchCheckpoint {
  id: string;
  projectId: string;
  runId: string;
  stepId: string;
  lifecycle: ResearchLifecycle;
  inputHash: string;
  outputHash: string | null;
  completedSteps: string[];
  output: Record<string, unknown>;
  decisions: string[];
  sideEffectKeys: string[];
  pendingSteps: string[];
  runtimeProfileVersion: string;
  errorCategory: string | null;
  recoveryStrategy: string | null;
  createdAt: number;
}

export type ResearchDecisionKind = 'accept' | 'edit' | 'reject' | 'undo';
export type ResearchDecisionOrigin = 'human' | 'ai' | 'system';

export interface ResearchDecision {
  id: string;
  projectId: string;
  runId: string | null;
  targetKind: 'project' | 'source' | 'evidence' | 'note_code' | 'claim' | 'artifact' | 'plan';
  targetId: string;
  decision: ResearchDecisionKind;
  origin: ResearchDecisionOrigin;
  beforeValue: Record<string, unknown>;
  afterValue: Record<string, unknown>;
  note: string;
  createdAt: number;
  undoneAt: number | null;
}

export interface SideEffectLedgerEntry {
  idempotencyKey: string;
  projectId: string;
  runId: string | null;
  operation: string;
  targetId: string | null;
  resultHash: string | null;
  committedAt: number;
}

export interface ProjectSnapshot {
  project: Project;
  sources: Source[];
  evidence: Evidence[];
  noteCodes: NoteCode[];
  claims: Claim[];
  claimEvidenceLinks: ClaimEvidenceLink[];
  artifacts: ResearchArtifact[];
  artifactVersions: ArtifactVersionRecord[];
  runs: ResearchRun[];
  checkpoints: ResearchCheckpoint[];
  decisions: ResearchDecision[];
  capturedAt: number;
}

// ─── Helpers ──────────────────────────────────────────────────

/** All six core object types, for runtime enumeration / audits. */
export const SIX_CORE_ENTITIES = ['Project', 'Source', 'Evidence', 'NoteCode', 'Claim', 'ResearchArtifact'] as const;
export type SixCoreEntity = (typeof SIX_CORE_ENTITIES)[number];
