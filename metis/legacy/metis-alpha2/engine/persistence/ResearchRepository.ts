import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  assertResearchLifecycleTransition,
  type ResearchLifecycle,
} from '../core/types.js';
import {
  ArtifactManifestSchema,
  canBeVerified,
  prepareArtifactManifestForRestore,
  type ArtifactManifest,
} from '../artifacts/ArtifactManifest.js';
import type {
  ArtifactInputRecord,
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
  SideEffectLedgerEntry,
  Source,
} from './researchModel.js';
import {
  decodeProjectProviderOverrideState,
  ProjectProviderOverrideSchema,
  type ProjectProviderOverrideDecode,
  type ProjectProviderOverride,
} from '../runtime/ProviderProfileContract.js';

/** O13: projects.metadata 中存放项目级 provider 覆盖的键名。 */
export const PROJECT_PROVIDER_OVERRIDE_METADATA_KEY = 'providerOverride' as const;

export interface LibraryPaperProjectLinkInput {
  paperId: string;
  projectId: string;
  title: string;
  authors: string[];
  year: number;
  venue: string;
  doi?: string;
  arxivId?: string;
}

type Row = Record<string, unknown>;

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function stringify(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function mapProject(row: Row): Project {
  return {
    id: String(row.id),
    title: String(row.title ?? ''),
    originalIntent: String(row.original_intent ?? ''),
    researchQuestion: String(row.research_question ?? ''),
    lifecycle: row.lifecycle as ResearchLifecycle,
    methodology: String(row.methodology ?? ''),
    discipline: String(row.discipline ?? ''),
    metadata: parseJson(row.metadata, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    archivedAt: row.archived_at === null ? null : Number(row.archived_at),
    version: Number(row.version),
    source: String(row.source ?? 'user'),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
  };
}

function mapSource(row: Row): Source {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    libraryPaperId: row.library_paper_id === null || row.library_paper_id === undefined
      ? null
      : String(row.library_paper_id),
    kind: row.kind as Source['kind'],
    title: String(row.title ?? ''),
    authors: parseJson(row.authors, []),
    year: row.year === null ? null : Number(row.year),
    venue: String(row.venue ?? ''),
    identifier: String(row.identifier ?? ''),
    identifierType: row.identifier_type as Source['identifierType'],
    filePath: row.file_path === null ? null : String(row.file_path),
    externalUrl: row.external_url === null ? null : String(row.external_url),
    tags: parseJson(row.tags, []),
    metadata: parseJson(row.metadata, {}),
    sourceVersionHash: row.source_version_hash === null ? null : String(row.source_version_hash),
    provenance: parseJson(row.provenance, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
  };
}

function mapEvidence(row: Row): Evidence {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    sourceId: String(row.source_id),
    anchorType: row.anchor_type as Evidence['anchorType'],
    anchorStart: row.anchor_start === null ? null : Number(row.anchor_start),
    anchorEnd: row.anchor_end === null ? null : Number(row.anchor_end),
    pageNumber: row.page_number === null ? null : Number(row.page_number),
    snippet: String(row.snippet ?? ''),
    snippetHash: String(row.snippet_hash ?? ''),
    sourceVersionHash: row.source_version_hash === null ? null : String(row.source_version_hash),
    confidence: Number(row.confidence),
    metadata: parseJson(row.metadata, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
  };
}

function mapNoteCode(row: Row): NoteCode {
  const accepted = Number(row.accepted);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    evidenceId: row.evidence_id === null ? null : String(row.evidence_id),
    code: String(row.code ?? ''),
    content: String(row.content ?? ''),
    author: row.author as NoteCode['author'],
    confidence: Number(row.confidence),
    accepted: accepted === 1 ? 'accepted' : accepted === -1 ? 'rejected' : 'pending',
    tags: parseJson(row.tags, []),
    metadata: parseJson(row.metadata, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
  };
}

function mapClaim(row: Row): Claim {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    statement: String(row.statement ?? ''),
    claimType: row.claim_type as Claim['claimType'],
    confidence: Number(row.confidence),
    status: row.status as Claim['status'],
    metadata: parseJson(row.metadata, {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
  };
}

function mapClaimEvidenceLink(row: Row): ClaimEvidenceLink {
  return {
    id: String(row.id),
    claimId: String(row.claim_id),
    evidenceId: String(row.evidence_id),
    relation: row.relation as ClaimEvidenceLink['relation'],
    weight: Number(row.weight),
    note: String(row.note ?? ''),
    createdAt: Number(row.created_at),
  };
}

function mapArtifact(row: Row): ResearchArtifact {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title ?? ''),
    artifactType: row.artifact_type as ResearchArtifact['artifactType'],
    reviewStatus: row.review_status as ResearchArtifact['reviewStatus'],
    contentRef: row.content_ref === null ? null : String(row.content_ref),
    inputHash: row.input_hash === null ? null : String(row.input_hash),
    provenance: parseJson(row.provenance, {}),
    metadata: parseJson(row.metadata, {}),
    version: Number(row.version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
  };
}

function mapArtifactVersion(row: Row): ArtifactVersionRecord {
  return {
    artifactId: String(row.artifact_id),
    version: Number(row.version),
    manifest: parseJson(row.manifest, {}),
    content: String(row.content ?? ''),
    contentHash: String(row.content_hash ?? ''),
    thumbnailRef: row.thumbnail_ref === null ? null : String(row.thumbnail_ref),
    createdAt: Number(row.created_at),
    createdBy: row.created_by as ArtifactVersionRecord['createdBy'],
    branchFromVersion: row.branch_from_version === null ? null : Number(row.branch_from_version),
  };
}

function mapArtifactInput(row: Row): ArtifactInputRecord {
  return {
    artifactId: String(row.artifact_id),
    version: Number(row.version),
    inputKind: row.input_kind as ArtifactInputRecord['inputKind'],
    inputId: String(row.input_id),
    inputHash: row.input_hash === null ? null : String(row.input_hash),
  };
}

function mapRun(row: Row): ResearchRun {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    status: row.status as ResearchRun['status'],
    plan: parseJson(row.plan, {}),
    providerProfile: parseJson(row.provider_profile, {}),
    currentStepId: row.current_step_id === null ? null : String(row.current_step_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
  };
}

function mapCheckpoint(row: Row): ResearchCheckpoint {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    runId: String(row.run_id),
    stepId: String(row.step_id),
    lifecycle: row.lifecycle as ResearchLifecycle,
    inputHash: String(row.input_hash ?? ''),
    outputHash: row.output_hash === null ? null : String(row.output_hash),
    completedSteps: parseJson(row.completed_steps, []),
    output: parseJson(row.output, {}),
    decisions: parseJson(row.decisions, []),
    sideEffectKeys: parseJson(row.side_effect_keys, []),
    pendingSteps: parseJson(row.pending_steps, []),
    runtimeProfileVersion: String(row.runtime_profile_version ?? ''),
    errorCategory: row.error_category === null ? null : String(row.error_category),
    recoveryStrategy: row.recovery_strategy === null ? null : String(row.recovery_strategy),
    createdAt: Number(row.created_at),
  };
}

function mapDecision(row: Row): ResearchDecision {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    runId: row.run_id === null ? null : String(row.run_id),
    targetKind: row.target_kind as ResearchDecision['targetKind'],
    targetId: String(row.target_id),
    decision: row.decision as ResearchDecision['decision'],
    origin: row.origin as ResearchDecision['origin'],
    beforeValue: parseJson(row.before_value, {}),
    afterValue: parseJson(row.after_value, {}),
    note: String(row.note ?? ''),
    createdAt: Number(row.created_at),
    undoneAt: row.undone_at === null ? null : Number(row.undone_at),
  };
}

export interface RecycleBinEntry {
  kind: 'project' | 'source' | 'evidence' | 'note_code' | 'claim' | 'artifact';
  id: string;
  projectId: string;
  label: string;
  deletedAt: number;
}

export interface ArtifactTrustVerification {
  receiptVerified: boolean;
  profileEnforced: boolean;
}

export type ArtifactTrustVerifier = (
  manifest: ArtifactManifest,
  content: string,
) => ArtifactTrustVerification;

export class ResearchRepository {
  private readonly db: Database.Database;
  private readonly artifactTrustVerifier?: ArtifactTrustVerifier;

  constructor(
    db: Database.Database,
    artifactTrustVerifier?: ArtifactTrustVerifier,
  ) {
    this.db = db;
    this.artifactTrustVerifier = artifactTrustVerifier;
  }

  /** Close the underlying database connection. Caller must not use the repository after close. */
  close(): void {
    this.db.close();
  }

  // ─── Project ───────────────────────────────────────────────

  createProject(project: Project): Project {
    this.db.prepare(`
      INSERT INTO projects (
        id, title, original_intent, research_question, lifecycle, methodology,
        discipline, metadata, created_at, updated_at, archived_at, version, source, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      project.id,
      project.title,
      project.originalIntent,
      project.researchQuestion,
      project.lifecycle,
      project.methodology,
      project.discipline,
      stringify(project.metadata),
      project.createdAt,
      project.updatedAt,
      project.archivedAt,
      project.version,
      project.source,
      project.deletedAt,
    );
    return project;
  }

  getProject(id: string, includeDeleted = false): Project | undefined {
    const row = this.db.prepare(
      `SELECT * FROM projects WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
    ).get(id) as Row | undefined;
    return row ? mapProject(row) : undefined;
  }

  listProjects(options: { includeDeleted?: boolean; limit?: number; offset?: number } = {}): Project[] {
    const rows = this.db.prepare(`
      SELECT * FROM projects
      ${options.includeDeleted ? '' : 'WHERE deleted_at IS NULL'}
      ORDER BY updated_at DESC
      LIMIT ? OFFSET ?
    `).all(options.limit ?? 100, options.offset ?? 0) as Row[];
    return rows.map(mapProject);
  }

  updateProject(
    id: string,
    patch: Partial<Pick<Project, 'title' | 'originalIntent' | 'researchQuestion' | 'lifecycle' | 'methodology' | 'discipline' | 'metadata'>>,
  ): Project | undefined {
    const current = this.getProject(id, true);
    if (!current) return undefined;
    if (patch.lifecycle) assertResearchLifecycleTransition(current.lifecycle, patch.lifecycle);
    const next: Project = {
      ...current,
      ...patch,
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      archivedAt: patch.lifecycle === 'archived' ? Date.now() : (patch.lifecycle ? null : current.archivedAt),
      updatedAt: Date.now(),
      version: current.version + 1,
    };
    this.db.prepare(`
      UPDATE projects SET
        title = ?, original_intent = ?, research_question = ?, lifecycle = ?,
        methodology = ?, discipline = ?, metadata = ?, updated_at = ?, archived_at = ?, version = ?
      WHERE id = ?
    `).run(
      next.title,
      next.originalIntent,
      next.researchQuestion,
      next.lifecycle,
      next.methodology,
      next.discipline,
      stringify(next.metadata),
      next.updatedAt,
      next.archivedAt,
      next.version,
      id,
    );
    return next;
  }

  softDeleteProject(id: string, at = Date.now()): boolean {
    return this.db.prepare('UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(at, at, id).changes > 0;
  }

  // ─── O13: Per-project provider/model override ──────────────
  //
  // 覆盖存于 projects.metadata.providerOverride（settings 存储，无需 schema
  // 迁移，既有数据不受影响）。读取经 zod 校验——损坏数据一律视为无覆盖。

  /** Read the project override state while preserving absent vs invalid metadata. */
  getProjectProviderOverrideState(projectId: string): ProjectProviderOverrideDecode {
    const project = this.getProject(projectId);
    // 项目不存在（或已软删）时不存在任何覆盖元数据——按 absent 处理，让
    // 孤儿 Goal 回退全局 Provider；「项目存在但元数据损坏」才 fail-closed
    // 为 invalid（见 ProviderProfileContract 的 fail-closed 规则）。
    if (!project) return { status: 'absent' };
    return decodeProjectProviderOverrideState(project.metadata[PROJECT_PROVIDER_OVERRIDE_METADATA_KEY]);
  }

  /** 读取项目级 provider 覆盖；无覆盖或数据损坏时返回 null。 */
  getProjectProviderOverride(projectId: string): ProjectProviderOverride | null {
    const state = this.getProjectProviderOverrideState(projectId);
    return state.status === 'valid' ? state.override : null;
  }

  /**
   * 设置/清除项目级 provider 覆盖。传 null 清除（metadata 中的键被移除）。
   * 返回是否成功（项目不存在或覆盖不合法时为 false）。
   */
  setProjectProviderOverride(projectId: string, override: ProjectProviderOverride | null): boolean {
    const project = this.getProject(projectId);
    if (!project) return false;
    if (override !== null && !ProjectProviderOverrideSchema.safeParse(override).success) {
      return false;
    }
    const metadata: Record<string, unknown> = { ...project.metadata };
    if (override === null) {
      delete metadata[PROJECT_PROVIDER_OVERRIDE_METADATA_KEY];
    } else {
      metadata[PROJECT_PROVIDER_OVERRIDE_METADATA_KEY] = override;
    }
    // 直接整体重写 metadata 列（updateProject 的浅合并无法删除键）。
    this.db.prepare('UPDATE projects SET metadata = ?, updated_at = ?, version = ? WHERE id = ?')
      .run(stringify(metadata), Date.now(), project.version + 1, projectId);
    return true;
  }

  restoreProject(id: string): boolean {
    return this.db.prepare('UPDATE projects SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL')
      .run(Date.now(), id).changes > 0;
  }

  // ─── Source ────────────────────────────────────────────────

  saveSource(source: Source): Source {
    const previous = this.getSource(source.id, true);
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO sources (
          id, project_id, library_paper_id, kind, title, authors, year, venue, identifier, identifier_type,
          file_path, external_url, tags, metadata, source_version_hash, provenance,
          created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id, library_paper_id = excluded.library_paper_id,
          kind = excluded.kind, title = excluded.title,
          authors = excluded.authors, year = excluded.year, venue = excluded.venue,
          identifier = excluded.identifier, identifier_type = excluded.identifier_type,
          file_path = excluded.file_path, external_url = excluded.external_url,
          tags = excluded.tags, metadata = excluded.metadata,
          source_version_hash = excluded.source_version_hash, provenance = excluded.provenance,
          updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
      `).run(
        source.id,
        source.projectId,
        source.libraryPaperId ?? null,
        source.kind,
        source.title,
        stringify(source.authors),
        source.year,
        source.venue,
        source.identifier,
        source.identifierType,
        source.filePath,
        source.externalUrl,
        stringify(source.tags),
        stringify(source.metadata),
        source.sourceVersionHash,
        stringify(source.provenance),
        source.createdAt,
        source.updatedAt,
        source.deletedAt,
      );
      if (
        previous?.sourceVersionHash
        && source.sourceVersionHash
        && previous.sourceVersionHash !== source.sourceVersionHash
      ) {
        this.markArtifactsStaleForInput('source', source.id);
      }
    });
    transaction();
    return source;
  }

  /** Main-only media ingestion path: never overwrite an existing source id. */
  insertSourceIfAbsent(source: Source): boolean {
    return this.db.prepare(`
      INSERT OR IGNORE INTO sources (
        id, project_id, library_paper_id, kind, title, authors, year, venue, identifier, identifier_type,
        file_path, external_url, tags, metadata, source_version_hash, provenance,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      source.id,
      source.projectId,
      source.libraryPaperId ?? null,
      source.kind,
      source.title,
      stringify(source.authors),
      source.year,
      source.venue,
      source.identifier,
      source.identifierType,
      source.filePath,
      source.externalUrl,
      stringify(source.tags),
      stringify(source.metadata),
      source.sourceVersionHash,
      stringify(source.provenance),
      source.createdAt,
      source.updatedAt,
      source.deletedAt,
    ).changes > 0;
  }

  /**
   * Link a canonical library paper into a project as a project-local Source.
   * The paper can be linked to any number of projects; every project gets a
   * distinct Source id so its evidence/codes/claims stay isolated, while
   * libraryPaperId preserves the shared canonical identity.
   */
  linkLibraryPaperToProject(input: LibraryPaperProjectLinkInput): Source | undefined {
    const transaction = this.db.transaction(() => {
      const paperExists = this.db.prepare('SELECT 1 FROM papers WHERE id = ?').get(input.paperId);
      const projectExists = this.db.prepare(
        'SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NULL',
      ).get(input.projectId);
      if (!paperExists || !projectExists) return undefined;

      const existingRow = this.db.prepare(`
        SELECT * FROM sources
        WHERE project_id = ?
          AND (library_paper_id = ? OR (library_paper_id IS NULL AND id = ?))
        LIMIT 1
      `).get(input.projectId, input.paperId, input.paperId) as Row | undefined;
      const existing = existingRow ? mapSource(existingRow) : undefined;
      const identifier = input.doi ?? input.arxivId ?? existing?.identifier ?? '';
      const identifierType: Source['identifierType'] = input.doi
        ? 'doi'
        : input.arxivId
          ? 'arxiv'
          : existing?.identifierType ?? 'other';
      const now = Date.now();
      const source: Source = {
        id: existing?.id ?? `source_library_${sha256(`${input.projectId}\0${input.paperId}`)}`,
        projectId: input.projectId,
        libraryPaperId: input.paperId,
        kind: 'paper',
        title: input.title || existing?.title || '',
        authors: input.authors.length > 0 ? input.authors : existing?.authors ?? [],
        year: input.year || existing?.year || null,
        venue: input.venue || existing?.venue || '',
        identifier,
        identifierType,
        filePath: existing?.filePath ?? null,
        externalUrl: existing?.externalUrl ?? null,
        tags: existing?.tags ?? [],
        metadata: { ...(existing?.metadata ?? {}), libraryPaperId: input.paperId },
        sourceVersionHash: existing?.sourceVersionHash ?? null,
        provenance: existing?.provenance ?? { origin: 'library', importedAt: now },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        deletedAt: null,
      };

      this.saveSource(source);
      this.db.prepare(`
        INSERT OR IGNORE INTO paper_project_links (paper_id, project_id, linked_at)
        VALUES (?, ?, ?)
      `).run(input.paperId, input.projectId, now);
      this.db.prepare(`
        UPDATE papers SET project_id = COALESCE(project_id, ?) WHERE id = ?
      `).run(input.projectId, input.paperId);
      return source;
    });
    return transaction();
  }

  /** Remove only one project membership; preserve the research row for undo/audit. */
  unlinkLibraryPaperFromProject(paperId: string, projectId: string): boolean {
    const transaction = this.db.transaction(() => {
      const removed = this.db.prepare(
        'DELETE FROM paper_project_links WHERE paper_id = ? AND project_id = ?',
      ).run(paperId, projectId).changes > 0;
      if (!removed) return false;

      const sourceRow = this.db.prepare(`
        SELECT id FROM sources
        WHERE project_id = ? AND library_paper_id = ? AND deleted_at IS NULL
        LIMIT 1
      `).get(projectId, paperId) as { id: string } | undefined;
      if (sourceRow) this.softDeleteSource(sourceRow.id);

      const next = this.db.prepare(`
        SELECT project_id FROM paper_project_links
        WHERE paper_id = ?
        ORDER BY linked_at ASC, project_id ASC
        LIMIT 1
      `).get(paperId) as { project_id: string } | undefined;
      this.db.prepare(`
        UPDATE papers SET project_id = ? WHERE id = ? AND project_id = ?
      `).run(next?.project_id ?? null, paperId, projectId);
      return true;
    });
    return transaction();
  }

  getSource(id: string, includeDeleted = false): Source | undefined {
    const row = this.db.prepare(
      `SELECT * FROM sources WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
    ).get(id) as Row | undefined;
    return row ? mapSource(row) : undefined;
  }

  /** Main-only managed-storage recovery lookup. Never expose file paths via IPC. */
  findSourceByFilePath(filePath: string): Source | undefined {
    const row = this.db.prepare('SELECT * FROM sources WHERE file_path = ? LIMIT 1')
      .get(filePath) as Row | undefined;
    return row ? mapSource(row) : undefined;
  }

  listSources(projectId: string, includeDeleted = false): Source[] {
    const rows = this.db.prepare(`
      SELECT * FROM sources WHERE project_id = ?
      ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
      ORDER BY updated_at DESC
    `).all(projectId) as Row[];
    return rows.map(mapSource);
  }

  findSourceDuplicate(projectId: string, identifier: string, versionHash?: string | null): Source | undefined {
    const row = this.db.prepare(`
      SELECT * FROM sources
      WHERE project_id = ? AND deleted_at IS NULL
        AND ((identifier <> '' AND identifier = ?) OR (? IS NOT NULL AND source_version_hash = ?))
      LIMIT 1
    `).get(projectId, identifier, versionHash ?? null, versionHash ?? null) as Row | undefined;
    return row ? mapSource(row) : undefined;
  }

  softDeleteSource(id: string, at = Date.now()): boolean {
    const transaction = this.db.transaction(() => {
      const changed = this.db.prepare('UPDATE sources SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
        .run(at, at, id).changes > 0;
      if (changed) this.markArtifactsStaleForInput('source', id);
      return changed;
    });
    return transaction();
  }

  restoreSource(id: string): boolean {
    return this.db.prepare('UPDATE sources SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL')
      .run(Date.now(), id).changes > 0;
  }

  countArtifactInputReferences(inputKind: string, inputId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM artifact_inputs
      WHERE input_kind = ? AND input_id = ?
    `).get(inputKind, inputId) as { count: number };
    return Number(row.count);
  }

  /** Hard purge is deliberately limited to soft-deleted, unreferenced sources. */
  purgeSourceIfUnreferenced(id: string): Source | undefined {
    const transaction = this.db.transaction(() => {
      const source = this.getSource(id, true);
      if (
        !source
        || source.deletedAt === null
        || this.countArtifactInputReferences('source', id) > 0
      ) return undefined;
      const deleted = this.db.prepare(
        'DELETE FROM sources WHERE id = ? AND deleted_at IS NOT NULL',
      ).run(id).changes > 0;
      return deleted ? source : undefined;
    });
    return transaction();
  }

  // ─── Evidence ──────────────────────────────────────────────

  saveEvidence(evidence: Evidence): Evidence {
    this.db.prepare(`
      INSERT INTO evidence (
        id, project_id, source_id, anchor_type, anchor_start, anchor_end, page_number,
        snippet, snippet_hash, source_version_hash, confidence, metadata,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_id = excluded.source_id, anchor_type = excluded.anchor_type,
        anchor_start = excluded.anchor_start, anchor_end = excluded.anchor_end,
        page_number = excluded.page_number, snippet = excluded.snippet,
        snippet_hash = excluded.snippet_hash, source_version_hash = excluded.source_version_hash,
        confidence = excluded.confidence, metadata = excluded.metadata,
        updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
    `).run(
      evidence.id,
      evidence.projectId,
      evidence.sourceId,
      evidence.anchorType,
      evidence.anchorStart,
      evidence.anchorEnd,
      evidence.pageNumber,
      evidence.snippet,
      evidence.snippetHash,
      evidence.sourceVersionHash,
      clamp01(evidence.confidence),
      stringify(evidence.metadata),
      evidence.createdAt,
      evidence.updatedAt,
      evidence.deletedAt,
    );
    return evidence;
  }

  getEvidence(id: string, includeDeleted = false): Evidence | undefined {
    const row = this.db.prepare(
      `SELECT * FROM evidence WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
    ).get(id) as Row | undefined;
    return row ? mapEvidence(row) : undefined;
  }

  listEvidence(projectId: string, sourceId?: string, includeDeleted = false): Evidence[] {
    const rows = sourceId
      ? this.db.prepare(`SELECT * FROM evidence WHERE project_id = ? AND source_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY created_at ASC`).all(projectId, sourceId) as Row[]
      : this.db.prepare(`SELECT * FROM evidence WHERE project_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY created_at ASC`).all(projectId) as Row[];
    return rows.map(mapEvidence);
  }

  softDeleteEvidence(id: string, at = Date.now()): boolean {
    const transaction = this.db.transaction(() => {
      const linkedClaims = this.db.prepare('SELECT DISTINCT claim_id FROM claim_evidence_links WHERE evidence_id = ?')
        .all(id) as Array<{ claim_id: string }>;
      const changed = this.db.prepare('UPDATE evidence SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
        .run(at, at, id).changes > 0;
      if (changed) {
        for (const link of linkedClaims) this.recomputeClaimStatus(link.claim_id);
        this.markArtifactsStaleForInput('evidence', id);
      }
      return changed;
    });
    return transaction();
  }

  restoreEvidence(id: string): boolean {
    const transaction = this.db.transaction(() => {
      const changed = this.db.prepare('UPDATE evidence SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL')
        .run(Date.now(), id).changes > 0;
      if (changed) {
        const linkedClaims = this.db.prepare('SELECT DISTINCT claim_id FROM claim_evidence_links WHERE evidence_id = ?')
          .all(id) as Array<{ claim_id: string }>;
        for (const link of linkedClaims) this.recomputeClaimStatus(link.claim_id);
      }
      return changed;
    });
    return transaction();
  }

  // ─── NoteCode ──────────────────────────────────────────────

  saveNoteCode(noteCode: NoteCode): NoteCode {
    const accepted = noteCode.accepted === 'accepted' ? 1 : noteCode.accepted === 'rejected' ? -1 : 0;
    this.db.prepare(`
      INSERT INTO note_codes (
        id, project_id, evidence_id, code, content, author, confidence, accepted,
        tags, metadata, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        evidence_id = excluded.evidence_id, code = excluded.code, content = excluded.content,
        author = excluded.author, confidence = excluded.confidence, accepted = excluded.accepted,
        tags = excluded.tags, metadata = excluded.metadata,
        updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
    `).run(
      noteCode.id,
      noteCode.projectId,
      noteCode.evidenceId,
      noteCode.code,
      noteCode.content,
      noteCode.author,
      clamp01(noteCode.confidence),
      accepted,
      stringify(noteCode.tags),
      stringify(noteCode.metadata),
      noteCode.createdAt,
      noteCode.updatedAt,
      noteCode.deletedAt,
    );
    return noteCode;
  }

  getNoteCode(id: string, includeDeleted = false): NoteCode | undefined {
    const row = this.db.prepare(
      `SELECT * FROM note_codes WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
    ).get(id) as Row | undefined;
    return row ? mapNoteCode(row) : undefined;
  }

  listNoteCodes(projectId: string, options: { includeDeleted?: boolean; acceptance?: NoteCode['accepted']; evidenceId?: string } = {}): NoteCode[] {
    const clauses = ['project_id = ?'];
    const args: unknown[] = [projectId];
    if (!options.includeDeleted) clauses.push('deleted_at IS NULL');
    if (options.acceptance) {
      clauses.push('accepted = ?');
      args.push(options.acceptance === 'accepted' ? 1 : options.acceptance === 'rejected' ? -1 : 0);
    }
    if (options.evidenceId) {
      clauses.push('evidence_id = ?');
      args.push(options.evidenceId);
    }
    const rows = this.db.prepare(`SELECT * FROM note_codes WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`).all(...args) as Row[];
    return rows.map(mapNoteCode);
  }

  reviewNoteCode(
    id: string,
    decision: 'accepted' | 'rejected' | 'pending',
    edits: Partial<Pick<NoteCode, 'code' | 'content' | 'tags'>> = {},
  ): NoteCode | undefined {
    const current = this.getNoteCode(id, true);
    if (!current) return undefined;
    const next: NoteCode = { ...current, ...edits, accepted: decision, updatedAt: Date.now() };
    return this.saveNoteCode(next);
  }

  softDeleteNoteCode(id: string, at = Date.now()): boolean {
    return this.db.prepare('UPDATE note_codes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(at, at, id).changes > 0;
  }

  restoreNoteCode(id: string): boolean {
    return this.db.prepare('UPDATE note_codes SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL')
      .run(Date.now(), id).changes > 0;
  }

  // ─── Claim graph ───────────────────────────────────────────

  saveClaim(claim: Claim): Claim {
    this.db.prepare(`
      INSERT INTO claims (
        id, project_id, statement, claim_type, confidence, status, metadata,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        statement = excluded.statement, claim_type = excluded.claim_type,
        confidence = excluded.confidence, status = excluded.status, metadata = excluded.metadata,
        updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
    `).run(
      claim.id,
      claim.projectId,
      claim.statement,
      claim.claimType,
      clamp01(claim.confidence),
      claim.status,
      stringify(claim.metadata),
      claim.createdAt,
      claim.updatedAt,
      claim.deletedAt,
    );
    return claim;
  }

  getClaim(id: string, includeDeleted = false): Claim | undefined {
    const row = this.db.prepare(
      `SELECT * FROM claims WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
    ).get(id) as Row | undefined;
    return row ? mapClaim(row) : undefined;
  }

  listClaims(projectId: string, includeDeleted = false): Claim[] {
    const rows = this.db.prepare(`SELECT * FROM claims WHERE project_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY updated_at DESC`).all(projectId) as Row[];
    return rows.map(mapClaim);
  }

  linkClaimEvidence(link: ClaimEvidenceLink): ClaimEvidenceLink {
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO claim_evidence_links (id, claim_id, evidence_id, relation, weight, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          claim_id = excluded.claim_id, evidence_id = excluded.evidence_id,
          relation = excluded.relation, weight = excluded.weight, note = excluded.note
      `).run(link.id, link.claimId, link.evidenceId, link.relation, clamp01(link.weight), link.note, link.createdAt);
      this.recomputeClaimStatus(link.claimId);
    });
    transaction();
    return link;
  }

  unlinkClaimEvidence(linkId: string): boolean {
    const existing = this.db.prepare('SELECT claim_id FROM claim_evidence_links WHERE id = ?').get(linkId) as { claim_id: string } | undefined;
    if (!existing) return false;
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM claim_evidence_links WHERE id = ?').run(linkId);
      this.recomputeClaimStatus(existing.claim_id);
    });
    transaction();
    return true;
  }

  listClaimEvidenceLinks(projectId: string): ClaimEvidenceLink[] {
    const rows = this.db.prepare(`
      SELECT l.* FROM claim_evidence_links l
      INNER JOIN claims c ON c.id = l.claim_id
      WHERE c.project_id = ? AND c.deleted_at IS NULL
      ORDER BY l.created_at ASC
    `).all(projectId) as Row[];
    return rows.map(mapClaimEvidenceLink);
  }

  recomputeClaimStatus(claimId: string): Claim | undefined {
    const claim = this.getClaim(claimId, true);
    if (!claim) return undefined;
    const links = this.db.prepare(`
      SELECT l.relation, l.weight
      FROM claim_evidence_links l
      INNER JOIN evidence e ON e.id = l.evidence_id
      WHERE l.claim_id = ? AND e.deleted_at IS NULL
    `).all(claimId) as Array<{ relation: ClaimEvidenceLink['relation']; weight: number }>;
    let supports = 0;
    let contradicts = 0;
    let qualifies = 0;
    for (const link of links) {
      if (link.relation === 'supports') supports += link.weight;
      else if (link.relation === 'contradicts') contradicts += link.weight;
      else qualifies += link.weight;
    }
    const total = supports + contradicts + qualifies;
    const status: Claim['status'] = total === 0
      ? 'unsupported'
      : supports > 0 && contradicts > 0
        ? 'contested'
        : contradicts > supports
          ? 'refuted'
          : supports > 0
            ? 'supported'
            : 'unsupported';
    const confidence = total === 0 ? 0 : clamp01((supports + 0.5 * qualifies) / total);
    const next = { ...claim, status, confidence, updatedAt: Date.now() };
    return this.saveClaim(next);
  }

  softDeleteClaim(id: string, at = Date.now()): boolean {
    const transaction = this.db.transaction(() => {
      const changed = this.db.prepare('UPDATE claims SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
        .run(at, at, id).changes > 0;
      if (changed) {
        this.markArtifactsStaleForInput('claim', id);
      }
      return changed;
    });
    return transaction();
  }

  restoreClaim(id: string): boolean {
    const changed = this.db.prepare('UPDATE claims SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL')
      .run(Date.now(), id).changes > 0;
    if (changed) this.recomputeClaimStatus(id);
    return changed;
  }

  // ─── Artifact + immutable versions ─────────────────────────

  /**
   * Persist the user-facing artifact record without inventing artifact content.
   *
   * A newly-created artifact can exist as a metadata shell before its first real
   * content version is saved. This deliberately does not insert an
   * `artifact_versions` row: callers must use `saveArtifactVersion` once real
   * content and provenance are available.
   */
  saveArtifact(artifact: ResearchArtifact): ResearchArtifact {
    this.db.prepare(`
      INSERT INTO research_artifacts (
        id, project_id, title, artifact_type, review_status, content_ref, input_hash,
        provenance, metadata, version, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        project_id = excluded.project_id, title = excluded.title,
        artifact_type = excluded.artifact_type, review_status = excluded.review_status,
        content_ref = excluded.content_ref, input_hash = excluded.input_hash,
        provenance = excluded.provenance, metadata = excluded.metadata,
        version = excluded.version, updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
    `).run(
      artifact.id,
      artifact.projectId,
      artifact.title,
      artifact.artifactType,
      artifact.reviewStatus,
      artifact.contentRef,
      artifact.inputHash,
      stringify(artifact.provenance),
      stringify(artifact.metadata),
      artifact.version,
      artifact.createdAt,
      artifact.updatedAt,
      artifact.deletedAt,
    );
    return artifact;
  }

  saveArtifactVersion(
    manifest: ArtifactManifest,
    content: string,
    options: { createdBy?: ArtifactVersionRecord['createdBy']; branchFromVersion?: number | null; thumbnailRef?: string | null } = {},
  ): ArtifactVersionRecord {
    const parsedManifest = ArtifactManifestSchema.safeParse(manifest);
    if (!parsedManifest.success) {
      throw new Error('Artifact manifest is invalid');
    }
    const trustedManifest = parsedManifest.data;
    const transaction = this.db.transaction(() => {
      const mediaHashes = new Map<string, string>();
      for (const media of trustedManifest.media ?? []) {
        const source = this.getSource(media.sourceId, true);
        const metadata = source?.metadata.managedMedia;
        const managed = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
          ? metadata as Record<string, unknown>
          : null;
        if (
          !source
          || source.deletedAt !== null
          || source.projectId !== trustedManifest.projectId
          || source.kind !== 'image'
          || source.filePath === null
          || source.sourceVersionHash !== media.sha256
          || source.provenance.origin !== 'metis-managed-research-media-v1'
          || !managed
          || managed.schemaVersion !== 1
          || managed.displayName !== media.displayName
          || managed.mediaType !== media.mediaType
          || managed.byteLength !== media.byteLength
          || managed.sha256 !== media.sha256
          || managed.widthPx !== media.widthPx
          || managed.heightPx !== media.heightPx
        ) {
          throw new Error('Artifact media source binding is invalid');
        }
        mediaHashes.set(media.sourceId, media.sha256);
      }

      const current = this.getArtifact(trustedManifest.id, true);
      const maxRow = this.db.prepare('SELECT MAX(version) AS version FROM artifact_versions WHERE artifact_id = ?').get(trustedManifest.id) as { version: number | null };
      const nextVersion = current ? (maxRow.version ?? current.version) + 1 : Math.max(1, trustedManifest.version);
      const now = Date.now();
      const versionedManifest: ArtifactManifest = {
        ...trustedManifest,
        version: nextVersion,
        createdAt: current?.createdAt ?? trustedManifest.createdAt,
        updatedAt: now,
      };
      if (versionedManifest.reviewStatus === 'verified') {
        const authority = this.artifactTrustVerifier?.(versionedManifest, content);
        const verification = canBeVerified(versionedManifest, authority);
        if (!verification.ok) throw new Error('Artifact verification requirements are not satisfied');
      }
      const contentHash = sha256(content);
      this.db.prepare(`
        INSERT INTO research_artifacts (
          id, project_id, title, artifact_type, review_status, content_ref, input_hash,
          provenance, metadata, version, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id, title = excluded.title,
          artifact_type = excluded.artifact_type, review_status = excluded.review_status,
          content_ref = excluded.content_ref, input_hash = excluded.input_hash,
          provenance = excluded.provenance, metadata = excluded.metadata,
          version = excluded.version, updated_at = excluded.updated_at, deleted_at = NULL
      `).run(
        versionedManifest.id,
        versionedManifest.projectId,
        versionedManifest.title,
        versionedManifest.artifactType,
        versionedManifest.reviewStatus,
        versionedManifest.renderer.contentRef ?? null,
        versionedManifest.inputHash ?? null,
        stringify({
          inputs: versionedManifest.inputs,
          generatedBy: versionedManifest.generatedBy,
          citedSourceIds: versionedManifest.citedSourceIds,
          reviewTrail: versionedManifest.reviewTrail,
        }),
        stringify({ renderer: versionedManifest.renderer }),
        nextVersion,
        current?.createdAt ?? versionedManifest.createdAt,
        now,
      );
      this.db.prepare(`
        INSERT INTO artifact_versions (
          artifact_id, version, manifest, content, content_hash, thumbnail_ref,
          created_at, created_by, branch_from_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        versionedManifest.id,
        nextVersion,
        stringify(versionedManifest),
        content,
        contentHash,
        options.thumbnailRef ?? null,
        now,
        options.createdBy ?? 'user',
        options.branchFromVersion ?? null,
      );
      const inputStatement = this.db.prepare(`
        INSERT INTO artifact_inputs (artifact_id, version, input_kind, input_id, input_hash)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const input of versionedManifest.inputs) {
        inputStatement.run(
          versionedManifest.id,
          nextVersion,
          input.kind,
          input.id,
          input.kind === 'source' ? (mediaHashes.get(input.id) ?? null) : null,
        );
      }
      const citationStatement = this.db.prepare(`
        INSERT INTO artifact_citations (artifact_id, version, source_id) VALUES (?, ?, ?)
      `);
      for (const sourceId of versionedManifest.citedSourceIds) {
        citationStatement.run(versionedManifest.id, nextVersion, sourceId);
      }
      return mapArtifactVersion({
        artifact_id: versionedManifest.id,
        version: nextVersion,
        manifest: stringify(versionedManifest),
        content,
        content_hash: contentHash,
        thumbnail_ref: options.thumbnailRef ?? null,
        created_at: now,
        created_by: options.createdBy ?? 'user',
        branch_from_version: options.branchFromVersion ?? null,
      });
    });
    return transaction();
  }

  listArtifactInputs(artifactId: string, version: number): ArtifactInputRecord[] {
    const rows = this.db.prepare(`
      SELECT artifact_id, version, input_kind, input_id, input_hash
      FROM artifact_inputs
      WHERE artifact_id = ? AND version = ?
      ORDER BY rowid ASC
    `).all(artifactId, version) as Row[];
    return rows.map(mapArtifactInput);
  }

  getArtifact(id: string, includeDeleted = false): ResearchArtifact | undefined {
    const row = this.db.prepare(
      `SELECT * FROM research_artifacts WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`,
    ).get(id) as Row | undefined;
    return row ? mapArtifact(row) : undefined;
  }

  listArtifacts(projectId: string, includeDeleted = false): ResearchArtifact[] {
    const rows = this.db.prepare(`SELECT * FROM research_artifacts WHERE project_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY updated_at DESC`).all(projectId) as Row[];
    return rows.map(mapArtifact);
  }

  getArtifactVersion(artifactId: string, version?: number): ArtifactVersionRecord | undefined {
    const row = version === undefined
      ? this.db.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC LIMIT 1').get(artifactId) as Row | undefined
      : this.db.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?').get(artifactId, version) as Row | undefined;
    return row ? mapArtifactVersion(row) : undefined;
  }

  listArtifactVersions(artifactId: string): ArtifactVersionRecord[] {
    const rows = this.db.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC').all(artifactId) as Row[];
    return rows.map(mapArtifactVersion);
  }

  restoreArtifactVersion(artifactId: string, version: number, createdBy: ArtifactVersionRecord['createdBy'] = 'user'): ArtifactVersionRecord | undefined {
    const record = this.getArtifactVersion(artifactId, version);
    if (!record) return undefined;
    const restoredManifest = prepareArtifactManifestForRestore(record.manifest);
    if (!restoredManifest) return undefined;
    return this.saveArtifactVersion(restoredManifest, record.content, {
      createdBy,
      branchFromVersion: version,
      thumbnailRef: record.thumbnailRef,
    });
  }

  markArtifactsStaleForInput(inputKind: string, inputId: string): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT artifact_id FROM artifact_inputs WHERE input_kind = ? AND input_id = ?
    `).all(inputKind, inputId) as Array<{ artifact_id: string }>;
    if (rows.length === 0) return [];
    const update = this.db.prepare(`
      UPDATE research_artifacts SET review_status = 'stale', updated_at = ? WHERE id = ?
    `);
    const now = Date.now();
    for (const row of rows) update.run(now, row.artifact_id);
    return rows.map((row) => row.artifact_id);
  }

  softDeleteArtifact(id: string, at = Date.now()): boolean {
    return this.db.prepare('UPDATE research_artifacts SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(at, at, id).changes > 0;
  }

  restoreArtifact(id: string): boolean {
    return this.db.prepare('UPDATE research_artifacts SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL')
      .run(Date.now(), id).changes > 0;
  }

  /**
   * Transition an artifact's review status and record the move in the current
   * version's manifest reviewTrail (the audit trail is review metadata, not
   * content — the content hash and version number are untouched).
   */
  updateArtifactReviewStatus(id: string, toStatus: string, reason: string): boolean {
    const artifact = this.getArtifact(id);
    if (!artifact) return false;
    const from = artifact.reviewStatus;
    const now = Date.now();
    this.db.prepare('UPDATE research_artifacts SET review_status = ?, updated_at = ? WHERE id = ?')
      .run(toStatus, now, id);
    const current = this.getArtifactVersion(id);
    if (current) {
      const manifest = current.manifest as Record<string, unknown>;
      const trail = Array.isArray(manifest.reviewTrail) ? manifest.reviewTrail : [];
      const updated = {
        ...manifest,
        reviewStatus: toStatus,
        reviewTrail: [...trail, { at: now, from, to: toStatus, reason }],
      };
      this.db.prepare('UPDATE artifact_versions SET manifest = ? WHERE artifact_id = ? AND version = ?')
        .run(JSON.stringify(updated), id, current.version);
    }
    return true;
  }

  // ─── Durable run/checkpoint/decision state ─────────────────

  saveRun(run: ResearchRun): ResearchRun {
    this.db.prepare(`
      INSERT INTO research_runs (
        id, project_id, status, plan, provider_profile, current_step_id,
        created_at, updated_at, completed_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status, plan = excluded.plan,
        provider_profile = excluded.provider_profile, current_step_id = excluded.current_step_id,
        updated_at = excluded.updated_at, completed_at = excluded.completed_at,
        deleted_at = excluded.deleted_at
    `).run(
      run.id,
      run.projectId,
      run.status,
      stringify(run.plan),
      stringify(run.providerProfile),
      run.currentStepId,
      run.createdAt,
      run.updatedAt,
      run.completedAt,
      run.deletedAt,
    );
    return run;
  }

  getRun(id: string, includeDeleted = false): ResearchRun | undefined {
    const row = this.db.prepare(`SELECT * FROM research_runs WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`).get(id) as Row | undefined;
    return row ? mapRun(row) : undefined;
  }

  listRuns(projectId: string, includeDeleted = false): ResearchRun[] {
    const rows = this.db.prepare(`SELECT * FROM research_runs WHERE project_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY updated_at DESC`).all(projectId) as Row[];
    return rows.map(mapRun);
  }

  recordCheckpoint(checkpoint: ResearchCheckpoint): ResearchCheckpoint {
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO research_checkpoints (
          id, project_id, run_id, step_id, lifecycle, input_hash, output_hash,
          completed_steps, output, decisions, side_effect_keys, pending_steps,
          runtime_profile_version, error_category, recovery_strategy, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        checkpoint.id,
        checkpoint.projectId,
        checkpoint.runId,
        checkpoint.stepId,
        checkpoint.lifecycle,
        checkpoint.inputHash,
        checkpoint.outputHash,
        stringify(checkpoint.completedSteps),
        stringify(checkpoint.output),
        stringify(checkpoint.decisions),
        stringify(checkpoint.sideEffectKeys),
        stringify(checkpoint.pendingSteps),
        checkpoint.runtimeProfileVersion,
        checkpoint.errorCategory,
        checkpoint.recoveryStrategy,
        checkpoint.createdAt,
      );
      this.db.prepare('UPDATE research_runs SET current_step_id = ?, updated_at = ? WHERE id = ?')
        .run(checkpoint.stepId, checkpoint.createdAt, checkpoint.runId);
    });
    transaction();
    return checkpoint;
  }

  latestCheckpoint(runId: string): ResearchCheckpoint | undefined {
    const row = this.db.prepare('SELECT * FROM research_checkpoints WHERE run_id = ? ORDER BY created_at DESC LIMIT 1').get(runId) as Row | undefined;
    return row ? mapCheckpoint(row) : undefined;
  }

  listCheckpoints(runId: string): ResearchCheckpoint[] {
    const rows = this.db.prepare('SELECT * FROM research_checkpoints WHERE run_id = ? ORDER BY created_at ASC').all(runId) as Row[];
    return rows.map(mapCheckpoint);
  }

  recordDecision(decision: ResearchDecision): ResearchDecision {
    this.db.prepare(`
      INSERT INTO research_decisions (
        id, project_id, run_id, target_kind, target_id, decision, origin,
        before_value, after_value, note, created_at, undone_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.id,
      decision.projectId,
      decision.runId,
      decision.targetKind,
      decision.targetId,
      decision.decision,
      decision.origin,
      stringify(decision.beforeValue),
      stringify(decision.afterValue),
      decision.note,
      decision.createdAt,
      decision.undoneAt,
    );
    return decision;
  }

  undoDecision(id: string, at = Date.now()): ResearchDecision | undefined {
    this.db.prepare('UPDATE research_decisions SET undone_at = ? WHERE id = ? AND undone_at IS NULL').run(at, id);
    const row = this.db.prepare('SELECT * FROM research_decisions WHERE id = ?').get(id) as Row | undefined;
    return row ? mapDecision(row) : undefined;
  }

  listDecisions(projectId: string, runId?: string): ResearchDecision[] {
    const rows = runId
      ? this.db.prepare('SELECT * FROM research_decisions WHERE project_id = ? AND run_id = ? ORDER BY created_at ASC').all(projectId, runId) as Row[]
      : this.db.prepare('SELECT * FROM research_decisions WHERE project_id = ? ORDER BY created_at ASC').all(projectId) as Row[];
    return rows.map(mapDecision);
  }

  hasSideEffect(idempotencyKey: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM side_effect_ledger WHERE idempotency_key = ?').get(idempotencyKey));
  }

  commitSideEffect(entry: SideEffectLedgerEntry): boolean {
    return this.db.prepare(`
      INSERT OR IGNORE INTO side_effect_ledger (
        idempotency_key, project_id, run_id, operation, target_id, result_hash, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.idempotencyKey,
      entry.projectId,
      entry.runId,
      entry.operation,
      entry.targetId,
      entry.resultHash,
      entry.committedAt,
    ).changes > 0;
  }

  // ─── CA source review (FIX-METIS-498) ──────────────────────

  /** Valid correction states for CurrentAffairs source review. */
  static readonly CA_CORRECTION_STATES = ['clean', 'correction_pending', 'corrected', 'retracted'] as const;

  /** Valid CA source kinds. */
  static readonly CA_KINDS = [
    'policy_document', 'official_statistics', 'authoritative_news',
    'legislative_record', 'regulatory_filing', 'expert_testimony', 'institutional_report',
  ] as const;

  /**
   * Fail-closed CA correction state transition rules.
   *
   *   retracted        → retracted only (cannot be reclassified clean without
   *                      a separate source update changing sourceVersionHash)
   *   correction_pending → correction_pending, corrected, retracted (NOT clean)
   *   clean / corrected → clean, corrected, retracted
   *   unreviewed        → any state
   */
  private static readonly CA_TRANSITIONS: Record<string, readonly string[]> = {
    clean: ['clean', 'corrected', 'retracted'],
    correction_pending: ['corrected', 'retracted'],
    corrected: ['corrected', 'retracted'],
    retracted: ['retracted'],
  };

  static isAllowedCATransition(from: string, to: string): boolean {
    const allowed = ResearchRepository.CA_TRANSITIONS[from];
    return allowed !== undefined && allowed.includes(to);
  }

  /**
   * CAS (Compare-And-Swap) review for CurrentAffairs sources.
   *
   * Atomically:
   *  1. Verifies expected source state (project, hash, updatedAt, deleted_at IS NULL)
   *  2. Parses existing tags JSON array, removes all `current-affairs:*` entries,
   *     appends exactly the selected canonical `caKind` tag
   *  3. Writes audit metadata (caCorrectionState, caReviewedAt, caReviewedBy,
   *     caNote, caReviewDigest) with strictly monotonic updatedAt
   *
   * On success, re-reads and verifies the persisted record.
   */
  reviewCurrentAffairsSource(
    sourceId: string,
    expected: {
      projectId: string;
      sourceVersionHash: string | null;
      updatedAt: number;
    },
    review: {
      caKind: string;
      correctionState: string;
      reviewedBy: string;
      note: string;
    },
  ): { ok: true; source: Source } | { ok: false; code: string } {
    // ── Validate review inputs ───────────────────────────────
    if (!ResearchRepository.CA_KINDS.includes(review.caKind as typeof ResearchRepository.CA_KINDS[number])) {
      return { ok: false, code: 'invalid_ca_kind' };
    }
    if (!ResearchRepository.CA_CORRECTION_STATES.includes(review.correctionState as typeof ResearchRepository.CA_CORRECTION_STATES[number])) {
      return { ok: false, code: 'invalid_correction_state' };
    }
    if (
      typeof review.reviewedBy !== 'string'
      || review.reviewedBy.length < 1
      || review.reviewedBy.length > 256
      // eslint-disable-next-line no-control-regex
      || /[\x00-\x1F\x7F-\x9F]/.test(review.reviewedBy)
    ) {
      return { ok: false, code: 'invalid_reviewed_by' };
    }
    if (typeof review.note !== 'string' || review.note.length > 2000) {
      return { ok: false, code: 'invalid_note' };
    }

    const reviewedAt = Date.now();

    // ── Validate expected fields ────────────────────────────
    if (
      typeof sourceId !== 'string'
      || sourceId.length < 1
      || sourceId.length > 256
      || /[\x00-\x1F\x7F-\x9F]/.test(sourceId)  // eslint-disable-line no-control-regex
    ) {
      return { ok: false, code: 'invalid_source_id' };
    }
    if (
      typeof expected.projectId !== 'string'
      || expected.projectId.length < 1
      || expected.projectId.length > 256
      || /[\x00-\x1F\x7F-\x9F]/.test(expected.projectId)  // eslint-disable-line no-control-regex
    ) {
      return { ok: false, code: 'invalid_project_id' };
    }
    if (
      expected.sourceVersionHash !== null
      && (typeof expected.sourceVersionHash !== 'string' || !/^[a-f0-9]{64}$/i.test(expected.sourceVersionHash))
    ) {
      return { ok: false, code: 'invalid_expected_hash' };
    }
    if (
      typeof expected.updatedAt !== 'number'
      || !Number.isSafeInteger(expected.updatedAt)
      || expected.updatedAt < 0
    ) {
      return { ok: false, code: 'invalid_expected_updated_at' };
    }

    const result = this.db.transaction(() => {
      // Step 1: SELECT existing source, verify pre-conditions
      const existing = this.db.prepare(`
        SELECT * FROM sources WHERE id = ?
      `).get(sourceId) as Row | undefined;

      if (!existing) return { ok: false as const, code: 'not_found' as const };

      // deleted_at IS NULL is a hard requirement
      if (existing.deleted_at !== null) {
        return { ok: false as const, code: 'source_deleted' as const };
      }

      // projectId exact match
      if (String(existing.project_id) !== expected.projectId) {
        return { ok: false as const, code: 'project_mismatch' as const };
      }

      // sourceVersionHash IS NOT DISTINCT FROM
      const actualHash: string | null = existing.source_version_hash === null ? null : String(existing.source_version_hash);
      if (actualHash !== expected.sourceVersionHash) {
        return { ok: false as const, code: 'hash_mismatch' as const };
      }

      // updatedAt exact match (stale detection)
      const existingUpdatedAt = Number(existing.updated_at);
      if (existingUpdatedAt !== expected.updatedAt) {
        return { ok: false as const, code: 'stale' as const };
      }

      // Step 2: state transition enforcement (hash-aware — retraction laundering prevention)
      // Legacy (no stored hash) → enforce restrictions (fail-closed).
      // Same hash → enforce restrictions.
      // Explicit hash changed → treat as first review (any state allowed).
      const existingMeta = parseJson<Record<string, unknown>>(existing.metadata, {});
      const prevState = typeof existingMeta.caCorrectionState === 'string'
        && ResearchRepository.CA_CORRECTION_STATES.includes(existingMeta.caCorrectionState as typeof ResearchRepository.CA_CORRECTION_STATES[number])
        ? existingMeta.caCorrectionState
        : null;
      // hasOwnProperty distinguishes "reviewed before hash-tracking existed" (legacy)
      // from "reviewed when hash was null" (stored as '' sentinel).
      const hasStoredHash = Object.hasOwn(existingMeta, 'caReviewedSourceVersionHash');
      let hashChanged = false;
      if (hasStoredHash) {
        const raw = existingMeta.caReviewedSourceVersionHash;
        const stored = typeof raw === 'string' && raw.length > 0 ? raw : null;
        hashChanged = stored !== actualHash;
      }
      // hashChanged is false for legacy (no stored hash) — fail-closed

      if (prevState !== null && !hashChanged) {
        const ok = ResearchRepository.isAllowedCATransition(prevState, review.correctionState);
        if (!ok) return { ok: false as const, code: 'invalid_transition' as const };
      }
      // Only when hash explicitly changed: first review → any state allowed.

      // Step 3: parse tags as JSON array, normalize
      const existingTags: string[] = parseJson(existing.tags, []);
      // Remove ALL current-affairs:* tags (exact prefix match)
      const normalizedTags = existingTags.filter(
        (t: string) => !t.startsWith('current-affairs:'),
      );
      // Append the selected canonical tag
      const caTag = `current-affairs:${review.caKind}`;
      normalizedTags.push(caTag);
      const newTagsJson = stringify(normalizedTags);

      // Step 4: compute reviewDigest via canonical JSON (includes source identity fields)
      const storedHash = actualHash ?? ''; // '' sentinel for null hash
      const reviewDigest = createHash('sha256')
        .update(JSON.stringify([
          sourceId, expected.projectId, actualHash, existingUpdatedAt,
          review.caKind, review.correctionState, review.reviewedBy, review.note, reviewedAt,
        ]))
        .digest('hex');

      // Step 5: strictly monotonic updatedAt
      const newUpdatedAt = reviewedAt > existingUpdatedAt ? reviewedAt : existingUpdatedAt + 1;

      // Step 6: atomic CAS UPDATE
      const updateResult = this.db.prepare(`
        UPDATE sources
        SET tags = ?,
            metadata = json_set(
              json_set(
                json_set(
                  json_set(
                    json_set(
                      json_set(
                        json_set(metadata,
                          '$.caCorrectionState', ?),
                        '$.caReviewedAt', ?),
                      '$.caReviewedBy', ?),
                    '$.caNote', ?),
                  '$.caReviewDigest', ?),
                '$.caReviewedSourceVersionHash', ?)
            ),
            updated_at = ?
        WHERE id = ?
          AND project_id = ?
          AND (source_version_hash IS NULL AND ? IS NULL OR source_version_hash = ?)
          AND updated_at = ?
          AND deleted_at IS NULL
      `).run(
        newTagsJson,
        review.correctionState,
        reviewedAt,
        review.reviewedBy,
        review.note,
        reviewDigest,
        storedHash,
        newUpdatedAt,
        sourceId,
        expected.projectId,
        expected.sourceVersionHash, expected.sourceVersionHash,
        expected.updatedAt,
      );

      if (updateResult.changes !== 1) {
        return { ok: false as const, code: 'cas_update_failed' as const };
      }

      // Step 7: reread and verify
      const reread = this.db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as Row | undefined;
      if (!reread) return { ok: false as const, code: 'reread_failed' as const };

      const metadata = parseJson<Record<string, unknown>>(reread.metadata, {});
      const rereadReviewedHash = typeof metadata.caReviewedSourceVersionHash === 'string'
        && metadata.caReviewedSourceVersionHash.length > 0
        ? metadata.caReviewedSourceVersionHash
        : null;
      if (
        metadata.caCorrectionState !== review.correctionState
        || metadata.caReviewedAt !== reviewedAt
        || metadata.caReviewedBy !== review.reviewedBy
        || metadata.caNote !== review.note
        || metadata.caReviewDigest !== reviewDigest
        || rereadReviewedHash !== actualHash
        || String(reread.project_id) !== expected.projectId
        || (reread.source_version_hash === null ? null : String(reread.source_version_hash)) !== expected.sourceVersionHash
        || reread.deleted_at !== null
        || Number(reread.updated_at) !== newUpdatedAt
      ) {
        return { ok: false as const, code: 'reread_mismatch' as const };
      }

      // Verify tags: exactly one current-affairs:* tag with the correct kind
      const rereadTags: string[] = parseJson(reread.tags, []);
      const caCount = rereadTags.filter((t: string) => t.startsWith('current-affairs:')).length;
      if (caCount !== 1 || !rereadTags.includes(caTag)) {
        return { ok: false as const, code: 'reread_mismatch' as const };
      }

      return { ok: true as const, source: mapSource(reread) };
    })();

    return result;
  }

  // ─── Snapshot and recycle bin ──────────────────────────────

  snapshotProject(projectId: string): ProjectSnapshot | undefined {
    const project = this.getProject(projectId, true);
    if (!project) return undefined;
    const artifacts = this.listArtifacts(projectId, true);
    const runs = this.listRuns(projectId, true);
    return {
      project,
      sources: this.listSources(projectId, true),
      evidence: this.listEvidence(projectId, undefined, true),
      noteCodes: this.listNoteCodes(projectId, { includeDeleted: true }),
      claims: this.listClaims(projectId, true),
      claimEvidenceLinks: this.listClaimEvidenceLinks(projectId),
      artifacts,
      artifactVersions: artifacts.flatMap((artifact) => this.listArtifactVersions(artifact.id)),
      runs,
      checkpoints: runs.flatMap((run) => this.listCheckpoints(run.id)),
      decisions: this.listDecisions(projectId),
      capturedAt: Date.now(),
    };
  }

  listRecycleBin(projectId?: string): RecycleBinEntry[] {
    const entries: RecycleBinEntry[] = [];
    const addRows = (
      kind: RecycleBinEntry['kind'],
      sql: string,
      labelColumn: string,
      projectColumn: string,
      args: unknown[],
    ) => {
      const rows = this.db.prepare(sql).all(...args) as Row[];
      for (const row of rows) {
        entries.push({
          kind,
          id: String(row.id),
          projectId: String(row[projectColumn]),
          label: String(row[labelColumn] ?? ''),
          deletedAt: Number(row.deleted_at),
        });
      }
    };
    const scoped = projectId ? 'AND project_id = ?' : '';
    const args = projectId ? [projectId] : [];
    addRows('project', `SELECT id, id AS project_id, title, deleted_at FROM projects WHERE deleted_at IS NOT NULL ${projectId ? 'AND id = ?' : ''}`, 'title', 'project_id', args);
    addRows('source', `SELECT id, project_id, title, deleted_at FROM sources WHERE deleted_at IS NOT NULL ${scoped}`, 'title', 'project_id', args);
    addRows('evidence', `SELECT id, project_id, snippet, deleted_at FROM evidence WHERE deleted_at IS NOT NULL ${scoped}`, 'snippet', 'project_id', args);
    addRows('note_code', `SELECT id, project_id, code, deleted_at FROM note_codes WHERE deleted_at IS NOT NULL ${scoped}`, 'code', 'project_id', args);
    addRows('claim', `SELECT id, project_id, statement, deleted_at FROM claims WHERE deleted_at IS NOT NULL ${scoped}`, 'statement', 'project_id', args);
    addRows('artifact', `SELECT id, project_id, title, deleted_at FROM research_artifacts WHERE deleted_at IS NOT NULL ${scoped}`, 'title', 'project_id', args);
    return entries.sort((a, b) => b.deletedAt - a.deletedAt);
  }
}
