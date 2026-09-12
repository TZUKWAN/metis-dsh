import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export const METIS_DATABASE_SCHEMA_VERSION = 2
export const DEFAULT_METIS_DATABASE_PATH = 'metis-data/metis.db'

export function resolveMetisDatabasePath(configuredPath?: string): string {
  const value = configuredPath ?? DEFAULT_METIS_DATABASE_PATH
  return value === ':memory:' ? value : resolve(value)
}

export type ResearchProjectStage =
  | 'idea'
  | 'designing'
  | 'fieldwork'
  | 'analyzing'
  | 'writing'
  | 'submission'

export interface ResearchProjectMetadata {
  title?: string
  discipline?: string
  researchQuestion?: string
  researchObject?: string
  methodology?: string
  stage?: ResearchProjectStage
  keywords?: string[]
  publicationIntent?: string
  notes?: string
}

export interface ResearchProjectRecord extends ResearchProjectMetadata {
  id: string
  workspaceId: string | null
  createdAt: number
  updatedAt: number
}

export type EvidenceVerificationState =
  | 'unverified'
  | 'partially_verified'
  | 'verified'
  | 'conflicting'
  | 'invalid'
  | 'stale'

export type EvidenceSourceType =
  | 'literature'
  | 'web_page'
  | 'database_observation'
  | 'computation'
  | 'user_provided'
  | 'model_inference'
  | 'file'

export interface EvidenceSourceInput {
  provider: string
  sourceId?: string
  url?: string
  retrievedAt?: number
}

export interface EvidenceRecord {
  id: string
  projectId: string | null
  sourceType: EvidenceSourceType
  source: EvidenceSourceInput
  title: string
  observation?: string
  doi?: string
  url?: string
  observedAt: number
  verificationState: EvidenceVerificationState
  createdByTool: string
  createdAt: number
  updatedAt: number
  truncated?: boolean
}

export interface EvidenceExcerptRecord {
  id: string
  evidenceId: string
  content: string
  locator?: string
  createdAt: number
}

export const EVIDENCE_LOCATOR_TYPES = [
  'abstract', 'page', 'section', 'paragraph', 'table', 'figure', 'dataset_row', 'web_fragment', 'metadata',
] as const

export type EvidenceLocatorType = (typeof EVIDENCE_LOCATOR_TYPES)[number]

export const CLAIM_TYPES = [
  'factual', 'literature_finding', 'theoretical_proposition', 'statistical_result', 'web_fact', 'user_provided_fact',
] as const

export type ClaimType = (typeof CLAIM_TYPES)[number]

export const CLAIM_EVIDENCE_RELATIONS = ['supports', 'contradicts', 'context'] as const

export type ClaimEvidenceRelation = (typeof CLAIM_EVIDENCE_RELATIONS)[number]

export interface EvidenceClaimRecord {
  id: string
  projectId: string
  artifactId?: string
  claimType: ClaimType
  text: string
  verificationState: EvidenceVerificationState
  createdAt: number
  updatedAt: number
}

export interface ClaimEvidenceLink {
  claimId: string
  evidenceId: string
  relation: ClaimEvidenceRelation
  confidence: number | null
  createdAt: number
}

export interface LiteratureAuthor {
  name: string
  given?: string
  family?: string
}

export interface LiteratureRecord {
  id: string
  title: string
  authors: LiteratureAuthor[]
  year: number | null
  journal?: string
  abstract?: string
  doi?: string
  url?: string
  source: string
  sourceId?: string
  keywords?: string[]
  citationCount?: number
  coreStatus?: 'cssci' | 'pku-core' | 'chinese-core' | 'sci' | 'ssci' | 'unknown'
  verificationState?: EvidenceVerificationState
  evidenceId?: string
  projectId?: string | null
}

export type ArtifactType =
  | 'paper'
  | 'report'
  | 'proposal'
  | 'review'
  | 'dataset'
  | 'figure'
  | 'presentation'
  | 'spreadsheet'
  | 'other'

export type ArtifactStatus = 'draft' | 'review' | 'final'

export interface ArtifactVersionRecord {
  artifactId: string
  version: number
  workspacePath: string
  contentHash?: string
  createdBy?: string
  createdAt: number
  note?: string
}

export interface ArtifactRecord {
  id: string
  type: ArtifactType
  title: string
  workspacePath: string
  projectId: string | null
  version: number
  createdAt: number
  updatedAt: number
  source: string
  status: ArtifactStatus
  mimeType?: string
  finalizedAt?: number
  evidenceIds: string[]
  versions: ArtifactVersionRecord[]
}

export interface ScenarioActivationRecord {
  sessionId: string
  projectId: string | null
  scenarioId: string
  activatedAt: number
  updatedAt: number
}

export interface RegisterEvidenceInput {
  projectId?: string | null
  sourceType: EvidenceSourceType
  source: EvidenceSourceInput
  title: string
  observation?: string
  doi?: string
  url?: string
  createdByTool: string
}

export interface SaveLiteratureInput {
  record: LiteratureRecord
  projectId: string
  createdByTool: string
}

export interface FundingTemplateRecord {
  templateId: string
  projectId: string | null
  version: number
  template: JsonValue
  createdAt: number
  updatedAt: number
}

export interface FundingSectionDraftRecord {
  id: string
  projectId: string
  templateId: string
  sectionId: string
  draftText: string
  usedEvidenceIds: string[]
  createdAt: number
}

export interface SubmissionCaseRecord {
  id: string
  projectId: string | null
  artifactId: string | null
  journalId: string | null
  status: SubmissionCaseStatus
  notes: string | null
  createdAt: number
  updatedAt: number
}

export const SUBMISSION_CASE_STATUSES = [
  'researching', 'candidate', 'preparing', 'ready', 'submitted', 'revision', 'accepted', 'rejected', 'withdrawn',
] as const

export type SubmissionCaseStatus = (typeof SUBMISSION_CASE_STATUSES)[number]

export interface JournalRequirementRecord {
  id: string
  journalId: string
  requirements: JsonValue
  verificationState: EvidenceVerificationState
  updatedAt: number
}

export interface RegisterArtifactInput {
  type: ArtifactType
  title: string
  workspacePath: string
  projectId?: string | null
  source: string
  status?: ArtifactStatus
  mimeType?: string
  note?: string
  contentHash?: string
  createdBy?: string
  evidenceIds?: readonly string[]
}

const MAX_OBSERVATION_CHARS = 4_000

function normalizedDoi(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
    .toLowerCase()
  return normalized || null
}

function nullableText(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null
  const trimmed = value.trim()
  return trimmed || null
}

function parseJsonArray(value: unknown): unknown[] {
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    throw new Error('METIS database contains invalid JSON array data')
  }
}

function toJson(value: unknown): string {
  return JSON.stringify(value)
}

function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`METIS database row has invalid ${field}`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function safeSqliteBusyTimeout(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA busy_timeout = 5000')
}

async function ensureDatabaseFile(databasePath: string): Promise<void> {
  if (databasePath === ':memory:' || existsSync(databasePath)) return
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 })
  try {
    const file = await open(databasePath, 'wx', 0o600)
    await file.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

export class MetisDataStore {
  private readonly databasePath: string
  private db: DatabaseSync | undefined
  private transactionDepth = 0

  constructor(databasePath: string) {
    this.databasePath = databasePath === ':memory:' ? databasePath : resolve(databasePath)
  }

  static async open(databasePath: string): Promise<MetisDataStore> {
    const store = new MetisDataStore(databasePath)
    await store.initialize()
    return store
  }

  async initialize(): Promise<void> {
    if (this.db !== undefined) return
    await ensureDatabaseFile(this.databasePath)
    const db = new DatabaseSync(this.databasePath)
    try {
      safeSqliteBusyTimeout(db)
      this.migrate(db)
      this.db = db
    } catch (error) {
      db.close()
      throw error
    }
  }

  close(): void {
    if (this.db === undefined) return
    this.db.close()
    this.db = undefined
  }

  get path(): string {
    return this.databasePath
  }

  private requireDb(): DatabaseSync {
    if (this.db === undefined) throw new Error('METIS data store is not initialized')
    return this.db
  }

  /**
   * Versioned migration framework. Every schema change lands as a numbered
   * migration applied inside one transaction (migration body + version bump +
   * bookkeeping row). A failing migration rolls back completely and fails
   * loud — partial schema states can never be committed.
   */
  private migrate(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      ) STRICT;
    `)
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (row.user_version > METIS_DATABASE_SCHEMA_VERSION) {
      throw new Error(
        `METIS database schema ${row.user_version} is newer than this runtime (${METIS_DATABASE_SCHEMA_VERSION})`,
      )
    }
    for (const migration of SCHEMA_MIGRATIONS.filter((entry) => entry.version > row.user_version)) {
      db.exec('BEGIN IMMEDIATE')
      try {
        migration.up(db)
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, Date.now())
        db.prepare(`PRAGMA user_version = ${migration.version}`).run()
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* original error is reported instead */ }
        throw new Error(`METIS migration ${migration.version} (${migration.name}) failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
    }
  }

  transaction<T>(operation: () => T): T {
    const db = this.requireDb()
    if (this.transactionDepth > 0) return operation()

    db.exec('BEGIN IMMEDIATE')
    this.transactionDepth += 1
    try {
      const value = operation()
      db.exec('COMMIT')
      return value
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the original error; the database is no longer used by this operation.
      }
      throw error
    } finally {
      this.transactionDepth -= 1
    }
  }

  resolveProjectId(workspaceId?: string | null, sessionId?: string | null): string | null {
    const db = this.requireDb()
    if (sessionId) {
      const session = db.prepare(
        'SELECT project_id, workspace_id FROM session_project_bindings WHERE session_id = ?',
      ).get(sessionId) as { project_id: string; workspace_id: string | null } | undefined
      if (session) {
        if (workspaceId && session.workspace_id && session.workspace_id !== workspaceId) return null
        return session.project_id
      }
    }
    if (workspaceId) {
      const workspace = db.prepare(
        'SELECT project_id FROM workspace_project_bindings WHERE workspace_id = ?',
      ).get(workspaceId) as { project_id: string } | undefined
      if (workspace) return workspace.project_id
    }
    return null
  }

  bindSession(sessionId: string, workspaceId: string | null, projectId: string): void {
    const db = this.requireDb()
    const now = Date.now()
    db.prepare(`
      INSERT INTO session_project_bindings (session_id, workspace_id, project_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        project_id = excluded.project_id,
        updated_at = excluded.updated_at
    `).run(sessionId, workspaceId, projectId, now, now)
  }

  createProject(
    patch: ResearchProjectMetadata,
    workspaceId?: string | null,
    sessionId?: string | null,
  ): ResearchProjectRecord {
    const db = this.requireDb()
    const now = Date.now()
    const id = `rp-${randomUUID()}`
    this.transaction(() => {
      db.prepare(`
        INSERT INTO research_projects (
          id, title, discipline, research_question, research_object, methodology, stage,
          keywords_json, publication_intent, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        nullableText(patch.title),
        nullableText(patch.discipline),
        nullableText(patch.researchQuestion),
        nullableText(patch.researchObject),
        nullableText(patch.methodology),
        patch.stage ?? null,
        toJson(normalizeKeywords(patch.keywords)),
        nullableText(patch.publicationIntent),
        nullableText(patch.notes),
        now,
        now,
      )
      if (workspaceId) this.bindWorkspace(workspaceId, id)
      if (sessionId) this.bindSession(sessionId, workspaceId ?? null, id)
    })
    return this.getProject(id) ?? fail(`project ${id} was not readable after insert`)
  }

  updateProject(id: string, patch: ResearchProjectMetadata): ResearchProjectRecord | null {
    const current = this.getProject(id)
    if (!current) return null
    const next: ResearchProjectMetadata = { ...current, ...withoutUndefined(patch) }
    const now = Date.now()
    this.requireDb().prepare(`
      UPDATE research_projects SET
        title = ?, discipline = ?, research_question = ?, research_object = ?, methodology = ?, stage = ?,
        keywords_json = ?, publication_intent = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(
      nullableText(next.title),
      nullableText(next.discipline),
      nullableText(next.researchQuestion),
      nullableText(next.researchObject),
      nullableText(next.methodology),
      next.stage ?? null,
      toJson(normalizeKeywords(next.keywords)),
      nullableText(next.publicationIntent),
      nullableText(next.notes),
      now,
      id,
    )
    return this.getProject(id)
  }

  getProject(id: string): ResearchProjectRecord | null {
    const row = this.requireDb().prepare(`
      SELECT p.*, w.workspace_id
      FROM research_projects p
      LEFT JOIN workspace_project_bindings w ON w.project_id = p.id
      WHERE p.id = ?
      ORDER BY w.updated_at DESC
      LIMIT 1
    `).get(id)
    return row ? projectFromRow(row) : null
  }

  getCurrentProject(workspaceId?: string | null, sessionId?: string | null): ResearchProjectRecord | null {
    const id = this.resolveProjectId(workspaceId, sessionId)
    return id ? this.getProject(id) : null
  }

  listProjects(): ResearchProjectRecord[] {
    const rows = this.requireDb().prepare(`
      SELECT p.*, w.workspace_id
      FROM research_projects p
      LEFT JOIN workspace_project_bindings w ON w.project_id = p.id
      ORDER BY p.updated_at DESC, p.id ASC
    `).all()
    return rows.map(projectFromRow)
  }

  bindWorkspace(workspaceId: string, projectId: string): void {
    if (!this.getProject(projectId)) throw new Error(`cannot bind unknown research project: ${projectId}`)
    const now = Date.now()
    this.requireDb().prepare(`
      INSERT INTO workspace_project_bindings (workspace_id, project_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id) DO UPDATE SET project_id = excluded.project_id, updated_at = excluded.updated_at
    `).run(workspaceId, projectId, now, now)
  }

  saveLiteratureWithEvidence(input: SaveLiteratureInput): LiteratureRecord {
    if (!this.getProject(input.projectId)) {
      throw new Error(`cannot save literature to unknown research project: ${input.projectId}`)
    }
    return this.transaction(() => {
      const evidence = this.registerEvidence({
        projectId: input.projectId,
        sourceType: 'literature',
        source: {
          provider: input.record.source,
          ...(input.record.sourceId ? { sourceId: input.record.sourceId } : {}),
          ...(input.record.url ? { url: input.record.url } : {}),
        },
        title: input.record.title,
        ...(input.record.abstract ? { observation: input.record.abstract } : {}),
        ...(input.record.doi ? { doi: input.record.doi } : {}),
        ...(input.record.url ? { url: input.record.url } : {}),
        createdByTool: input.createdByTool,
      })
      return this.registerLiterature(input.record, input.projectId, evidence.record.id)
    })
  }

  registerLiterature(record: LiteratureRecord, projectId: string, evidenceId?: string): LiteratureRecord {
    if (!this.getProject(projectId)) throw new Error(`cannot save literature to unknown research project: ${projectId}`)
    const db = this.requireDb()
    const now = Date.now()
    const doi = normalizedDoi(record.doi)
    const sourceId = nullableText(record.sourceId)
    const dedupeKey = doi
      ? `doi:${doi}`
      : `source:${record.source}:${sourceId ?? record.id}`
    const existing = db.prepare('SELECT id FROM literature_records WHERE dedupe_key = ?').get(dedupeKey) as { id: string } | undefined
    const literatureId = existing?.id ?? `lit-${randomUUID()}`
    this.transaction(() => {
      db.prepare(`
        INSERT INTO literature_records (
          id, dedupe_key, title, authors_json, year, journal, abstract, doi, url, source, source_id,
          keywords_json, citation_count, core_status, verification_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dedupe_key) DO UPDATE SET
          title = excluded.title, authors_json = excluded.authors_json, year = excluded.year,
          journal = excluded.journal, abstract = excluded.abstract, doi = excluded.doi, url = excluded.url,
          source = excluded.source, source_id = excluded.source_id, keywords_json = excluded.keywords_json,
          citation_count = excluded.citation_count, core_status = excluded.core_status,
          verification_state = excluded.verification_state, updated_at = excluded.updated_at
      `).run(
        literatureId,
        dedupeKey,
        requiredString(record.title, 'literature title'),
        toJson(record.authors),
        record.year,
        nullableText(record.journal),
        nullableText(record.abstract),
        doi,
        nullableText(record.url),
        requiredString(record.source, 'literature source'),
        sourceId,
        toJson(normalizeKeywords(record.keywords)),
        integerOrNull(record.citationCount),
        record.coreStatus ?? null,
        record.verificationState ?? 'unverified',
        now,
        now,
      )
      db.prepare(`
        INSERT INTO project_literature (project_id, literature_id, evidence_id, saved_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id, literature_id) DO UPDATE SET evidence_id = excluded.evidence_id, saved_at = excluded.saved_at
      `).run(projectId, literatureId, evidenceId ?? null, now)
    })
    const saved = this.getLiterature(literatureId, projectId)
    if (!saved) throw new Error(`literature ${literatureId} was not readable after save`)
    return saved
  }

  listLiterature(projectId: string): LiteratureRecord[] {
    const rows = this.requireDb().prepare(`
      SELECT l.*, pl.project_id, pl.evidence_id
      FROM project_literature pl
      JOIN literature_records l ON l.id = pl.literature_id
      WHERE pl.project_id = ?
      ORDER BY pl.saved_at DESC, l.id ASC
    `).all(projectId)
    return rows.map(literatureFromRow)
  }

  getLiterature(id: string, projectId?: string): LiteratureRecord | null {
    const row = projectId
      ? this.requireDb().prepare(`
          SELECT l.*, pl.project_id, pl.evidence_id
          FROM project_literature pl JOIN literature_records l ON l.id = pl.literature_id
          WHERE l.id = ? AND pl.project_id = ?
        `).get(id, projectId)
      : this.requireDb().prepare('SELECT * FROM literature_records WHERE id = ?').get(id)
    return row ? literatureFromRow(row) : null
  }

  removeLiterature(projectId: string, literatureId: string): boolean {
    const changed = this.requireDb().prepare(
      'DELETE FROM project_literature WHERE project_id = ? AND literature_id = ?',
    ).run(projectId, literatureId)
    return changed.changes > 0
  }

  registerEvidence(input: RegisterEvidenceInput): { record: EvidenceRecord; duplicate: boolean } {
    const db = this.requireDb()
    const doi = normalizedDoi(input.doi)
    const url = nullableText(input.url)
    const sourceId = nullableText(input.source.sourceId)
    const sourceUrl = nullableText(input.source.url) ?? url
    const sourceKey = doi
      ? `doi:${doi}`
      : `source:${input.source.provider}:${sourceId ?? sourceUrl ?? input.title}`
    const now = Date.now()
    const observed = input.observation
    const truncated = observed !== undefined && observed.length > MAX_OBSERVATION_CHARS
    const observation = observed === undefined ? null : truncated ? observed.slice(0, MAX_OBSERVATION_CHARS) : observed
    // Evidence identity is the SOURCE identity within a project. Title drift
    // must not mint a second evidence record for the same underlying source.
    const evidenceKey = `${input.projectId ?? ''}|${sourceKey}`
    const duplicate = db.prepare('SELECT id FROM evidence_records WHERE dedupe_key = ?').get(evidenceKey) as { id: string } | undefined
    if (duplicate) {
      const record = this.getEvidence(duplicate.id)
      if (!record) throw new Error(`evidence ${duplicate.id} disappeared during duplicate lookup`)
      return { record, duplicate: true }
    }
    const source = db.prepare('SELECT id FROM evidence_sources WHERE dedupe_key = ?').get(sourceKey) as { id: string } | undefined
    const sourceRecordId = source?.id ?? `src-${randomUUID()}`
    const evidenceId = `ev-${randomUUID()}`
    this.transaction(() => {
      if (!source) {
        db.prepare(`
          INSERT INTO evidence_sources (id, provider, source_id, url, retrieved_at, doi, dedupe_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sourceRecordId,
          requiredString(input.source.provider, 'evidence source provider'),
          sourceId,
          sourceUrl,
          input.source.retrievedAt ?? null,
          doi,
          sourceKey,
          now,
        )
      }
      db.prepare(`
        INSERT INTO evidence_records (
          id, project_id, source_id, source_type, title, observation, observed_at, verification_state,
          created_by_tool, truncated, created_at, updated_at, dedupe_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        evidenceId,
        input.projectId ?? null,
        sourceRecordId,
        input.sourceType,
        requiredString(input.title, 'evidence title'),
        observation,
        now,
        'unverified',
        requiredString(input.createdByTool, 'createdByTool'),
        truncated ? 1 : 0,
        now,
        now,
        evidenceKey,
      )
    })
    const record = this.getEvidence(evidenceId)
    if (!record) throw new Error(`evidence ${evidenceId} was not readable after insert`)
    return { record, duplicate: false }
  }

  getEvidence(id: string): EvidenceRecord | null {
    const row = this.requireDb().prepare(`
      SELECT e.*, s.provider, s.source_id AS provider_source_id, s.url AS source_url, s.retrieved_at, s.doi
      FROM evidence_records e JOIN evidence_sources s ON s.id = e.source_id
      WHERE e.id = ?
    `).get(id)
    return row ? evidenceFromRow(row) : null
  }

  queryEvidence(filter: { projectId?: string; doi?: string; url?: string } = {}): EvidenceRecord[] {
    const db = this.requireDb()
    let sql = `
      SELECT e.*, s.provider, s.source_id AS provider_source_id, s.url AS source_url, s.retrieved_at, s.doi
      FROM evidence_records e JOIN evidence_sources s ON s.id = e.source_id
    `
    const params: string[] = []
    if (filter.doi) {
      sql += ' WHERE s.doi = ?'
      params.push(normalizedDoi(filter.doi) ?? '')
    } else if (filter.url) {
      sql += ' WHERE s.url = ?'
      params.push(filter.url)
    } else if (filter.projectId) {
      sql += ' WHERE e.project_id = ?'
      params.push(filter.projectId)
    }
    sql += ' ORDER BY e.observed_at DESC, e.id ASC'
    return db.prepare(sql).all(...params).map(evidenceFromRow)
  }

  setEvidenceVerification(id: string, state: EvidenceVerificationState): EvidenceRecord | null {
    const result = this.requireDb().prepare(
      'UPDATE evidence_records SET verification_state = ?, updated_at = ? WHERE id = ?',
    ).run(state, Date.now(), id)
    return result.changes === 0 ? null : this.getEvidence(id)
  }

  createClaim(
    projectId: string,
    text: string,
    options: { claimType?: ClaimType; artifactId?: string } = {},
  ): EvidenceClaimRecord {
    if (!this.getProject(projectId)) throw new Error(`cannot create claim for unknown research project: ${projectId}`)
    const claimType = options.claimType ?? 'factual'
    if (!(CLAIM_TYPES as readonly string[]).includes(claimType)) {
      throw new Error(`unknown claim type: ${claimType}`)
    }
    if (options.artifactId && !this.getArtifact(options.artifactId)) {
      throw new Error(`cannot attach claim to unknown artifact: ${options.artifactId}`)
    }
    const normalized = text.trim()
    if (!normalized) throw new Error('claim text cannot be empty')
    const now = Date.now()
    const id = `claim-${randomUUID()}`
    this.requireDb().prepare(`
      INSERT INTO evidence_claims (id, project_id, text, verification_state, created_at, updated_at, claim_type, artifact_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, normalized, 'unverified', now, now, claimType, options.artifactId ?? null)
    const record = this.getClaim(id)
    if (!record) throw new Error(`claim ${id} was not readable after insert`)
    return record
  }

  getClaim(id: string): EvidenceClaimRecord | null {
    const row = this.requireDb().prepare('SELECT * FROM evidence_claims WHERE id = ?').get(id)
    return row ? claimFromRow(row) : null
  }

  listClaims(filter: { projectId?: string; artifactId?: string } = {}): EvidenceClaimRecord[] {
    let sql = 'SELECT * FROM evidence_claims'
    const params: string[] = []
    if (filter.artifactId) {
      sql += ' WHERE artifact_id = ?'
      params.push(filter.artifactId)
    } else if (filter.projectId) {
      sql += ' WHERE project_id = ?'
      params.push(filter.projectId)
    }
    sql += ' ORDER BY created_at ASC, id ASC'
    return this.requireDb().prepare(sql).all(...params).map(claimFromRow)
  }

  setClaimStatus(id: string, state: EvidenceVerificationState): EvidenceClaimRecord | null {
    const result = this.requireDb().prepare(
      'UPDATE evidence_claims SET verification_state = ?, updated_at = ? WHERE id = ?',
    ).run(state, Date.now(), id)
    return result.changes === 0 ? null : this.getClaim(id)
  }

  addEvidenceExcerpt(input: {
    evidenceId: string
    content: string
    locatorType?: EvidenceLocatorType
    locatorValue?: string
  }): EvidenceExcerptRecord {
    if (!this.getEvidence(input.evidenceId)) throw new Error(`cannot attach excerpt to unknown evidence: ${input.evidenceId}`)
    const content = input.content.trim()
    if (!content) throw new Error('excerpt content cannot be empty')
    const locatorType = input.locatorType ?? 'metadata'
    if (!(EVIDENCE_LOCATOR_TYPES as readonly string[]).includes(locatorType)) {
      throw new Error(`unknown locator type: ${locatorType}`)
    }
    const locator = input.locatorValue === undefined ? null : `${locatorType}:${input.locatorValue}`
    const now = Date.now()
    const id = `exc-${randomUUID()}`
    this.requireDb().prepare(`
      INSERT INTO evidence_excerpts (id, evidence_id, content, locator, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, input.evidenceId, content, locator, now)
    return { id, evidenceId: input.evidenceId, content, locator: locator ?? undefined, createdAt: now }
  }

  listEvidenceExcerpts(evidenceId: string): EvidenceExcerptRecord[] {
    return this.requireDb().prepare(
      'SELECT id, evidence_id, content, locator, created_at FROM evidence_excerpts WHERE evidence_id = ? ORDER BY created_at ASC',
    ).all(evidenceId).map((row) => {
      const record = row as Record<string, unknown>
      const locator = typeof record['locator'] === 'string' && record['locator'].length > 0 ? record['locator'] : undefined
      return {
        id: requiredString(record['id'], 'excerpt id'),
        evidenceId: requiredString(record['evidence_id'], 'excerpt evidence_id'),
        content: requiredString(record['content'], 'excerpt content'),
        ...(locator ? { locator } : {}),
        createdAt: asTimestamp(record['created_at'], 'excerpt created_at'),
      }
    })
  }

  linkClaimEvidence(
    claimId: string,
    evidenceId: string,
    relation: ClaimEvidenceRelation = 'supports',
    confidence?: number,
  ): ClaimEvidenceLink {
    if (!(CLAIM_EVIDENCE_RELATIONS as readonly string[]).includes(relation)) {
      throw new Error(`unknown claim-evidence relation: ${relation}`)
    }
    if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      throw new Error('confidence must be a number between 0 and 1')
    }
    if (!this.getClaim(claimId)) throw new Error(`cannot link unknown claim: ${claimId}`)
    if (!this.getEvidence(evidenceId)) throw new Error(`cannot link unknown evidence: ${evidenceId}`)
    const now = Date.now()
    this.requireDb().prepare(`
      INSERT INTO claim_evidence_links (claim_id, evidence_id, relation, confidence, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(claim_id, evidence_id) DO UPDATE SET relation = excluded.relation, confidence = excluded.confidence
    `).run(claimId, evidenceId, relation, confidence ?? null, now)
    return { claimId, evidenceId, relation, confidence: confidence ?? null, createdAt: now }
  }

  listClaimEvidence(claimId: string): EvidenceRecord[] {
    const rows = this.requireDb().prepare(`
      SELECT e.*, s.provider, s.source_id AS provider_source_id, s.url AS source_url, s.retrieved_at, s.doi
      FROM claim_evidence_links c
      JOIN evidence_records e ON e.id = c.evidence_id
      JOIN evidence_sources s ON s.id = e.source_id
      WHERE c.claim_id = ?
      ORDER BY c.created_at ASC
    `).all(claimId)
    return rows.map(evidenceFromRow)
  }

  setScenarioActivation(sessionId: string, projectId: string | null, scenarioId: string): ScenarioActivationRecord {
    const now = Date.now()
    this.requireDb().prepare(`
      INSERT INTO scenario_activations (session_id, project_id, scenario_id, activated_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        project_id = excluded.project_id,
        scenario_id = excluded.scenario_id,
        updated_at = excluded.updated_at
    `).run(sessionId, projectId, scenarioId, now, now)
    return this.getScenarioActivation(sessionId) ?? fail(`scenario activation ${sessionId} was not readable after write`)
  }

  getScenarioActivation(sessionId: string): ScenarioActivationRecord | null {
    const row = this.requireDb().prepare(
      'SELECT session_id, project_id, scenario_id, activated_at, updated_at FROM scenario_activations WHERE session_id = ?',
    ).get(sessionId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      sessionId: requiredString(row['session_id'], 'scenario session_id'),
      projectId: typeof row['project_id'] === 'string' ? row['project_id'] : null,
      scenarioId: requiredString(row['scenario_id'], 'scenario id'),
      activatedAt: asTimestamp(row['activated_at'], 'scenario activated_at'),
      updatedAt: asTimestamp(row['updated_at'], 'scenario updated_at'),
    }
  }

  clearScenarioActivation(sessionId: string): boolean {
    const result = this.requireDb().prepare(
      'DELETE FROM scenario_activations WHERE session_id = ?',
    ).run(sessionId)
    return result.changes > 0
  }

  registerArtifact(input: RegisterArtifactInput): ArtifactRecord {
    if (input.projectId && !this.getProject(input.projectId)) {
      throw new Error(`cannot register artifact for unknown research project: ${input.projectId}`)
    }
    const now = Date.now()
    const id = `art-${randomUUID()}`
    this.transaction(() => {
      this.requireDb().prepare(`
        INSERT INTO artifacts (
          id, type, title, workspace_path, project_id, version, source, status, mime_type, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.type,
        requiredString(input.title, 'artifact title'),
        requiredString(input.workspacePath, 'artifact workspacePath'),
        input.projectId ?? null,
        1,
        requiredString(input.source, 'artifact source'),
        input.status ?? 'draft',
        nullableText(input.mimeType),
        now,
        now,
      )
      this.requireDb().prepare(`
        INSERT INTO artifact_versions (artifact_id, version, workspace_path, note, created_at, content_hash, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, 1, input.workspacePath, nullableText(input.note), now, nullableText(input.contentHash), nullableText(input.createdBy))
      this.replaceArtifactEvidence(id, input.evidenceIds ?? [])
    })
    return this.getArtifact(id) ?? fail(`artifact ${id} was not readable after insert`)
  }

  addArtifactVersion(
    id: string,
    workspacePath: string,
    note?: string,
    options: { contentHash?: string; createdBy?: string } = {},
  ): ArtifactRecord | null {
    const current = this.getArtifact(id)
    if (!current) return null
    const version = current.version + 1
    const now = Date.now()
    this.transaction(() => {
      this.requireDb().prepare(`
        INSERT INTO artifact_versions (artifact_id, version, workspace_path, note, created_at, content_hash, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, version, workspacePath, nullableText(note), now, nullableText(options.contentHash), nullableText(options.createdBy))
      this.requireDb().prepare(`
        UPDATE artifacts SET workspace_path = ?, version = ?, updated_at = ? WHERE id = ?
      `).run(workspacePath, version, now, id)
    })
    return this.getArtifact(id)
  }

  setArtifactFinalized(id: string): ArtifactRecord | null {
    const current = this.getArtifact(id)
    if (!current) return null
    this.requireDb().prepare(
      "UPDATE artifacts SET status = 'final', finalized_at = ?, updated_at = ? WHERE id = ?",
    ).run(Date.now(), Date.now(), id)
    return this.getArtifact(id)
  }

  /**
   * Evidence coverage for one artifact's claims (attached via
   * evidence_claims.artifact_id). First-version heuristic, honestly labeled.
   */
  artifactEvidenceCheck(artifactId: string): {
    artifactId: string
    totalClaims: number
    byState: Record<string, number>
    supportedClaims: number
    contradictedClaims: number
    claimsWithoutEvidence: number
    unverifiedClaims: number
    coverageRatio: number
    claims: Array<EvidenceClaimRecord & { evidenceCount: number }>
  } {
    const artifact = this.getArtifact(artifactId)
    if (!artifact) throw new Error(`unknown artifact: ${artifactId}`)
    const claims = this.listClaims({ artifactId })
    const counts = new Map<string, number>()
    for (const row of this.requireDb().prepare(
      'SELECT claim_id, COUNT(*) AS n FROM claim_evidence_links GROUP BY claim_id',
    ).all() as Array<Record<string, unknown>>) {
      counts.set(String(row['claim_id']), Number(row['n']))
    }
    const byState: Record<string, number> = {}
    let supported = 0
    let contradicted = 0
    let withoutEvidence = 0
    let unverified = 0
    const detailed = claims.map((claim) => {
      const evidenceCount = counts.get(claim.id) ?? 0
      byState[claim.verificationState] = (byState[claim.verificationState] ?? 0) + 1
      if (evidenceCount > 0) {
        const relations = this.requireDb().prepare(
          'SELECT relation FROM claim_evidence_links WHERE claim_id = ?',
        ).all(claim.id) as Array<Record<string, unknown>>
        if (relations.some((row) => row['relation'] === 'supports')) supported += 1
        if (relations.some((row) => row['relation'] === 'contradicts')) contradicted += 1
      } else {
        withoutEvidence += 1
      }
      if (claim.verificationState === 'unverified') unverified += 1
      return { ...claim, evidenceCount }
    })
    return {
      artifactId,
      totalClaims: claims.length,
      byState,
      supportedClaims: supported,
      contradictedClaims: contradicted,
      claimsWithoutEvidence: withoutEvidence,
      unverifiedClaims: unverified,
      coverageRatio: claims.length === 0 ? 0 : supported / claims.length,
      claims: detailed,
    }
  }

  // ── Funding persistence (v2) ────────────────────────────────────────────

  saveFundingTemplate(input: {
    templateId: string
    projectId?: string | null
    version: number
    template: JsonValue
  }): FundingTemplateRecord {
    if (!/^[A-Za-z0-9:_-]+$/.test(input.templateId)) throw new Error(`invalid templateId: ${input.templateId}`)
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error('template version must be a positive integer')
    const now = Date.now()
    const projectId = nullableText(input.projectId ?? undefined)
    if (projectId && !this.getProject(projectId)) throw new Error(`cannot attach template to unknown project: ${projectId}`)
    this.transaction(() => {
      this.requireDb().prepare(`
        INSERT INTO funding_templates (id, project_id, template_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id,
          template_json = excluded.template_json,
          updated_at = excluded.updated_at
      `).run(input.templateId, projectId, JSON.stringify(input.template), now, now)
      this.requireDb().prepare(`
        INSERT INTO funding_template_versions (template_id, version, template_json, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(template_id, version) DO UPDATE SET template_json = excluded.template_json
      `).run(input.templateId, input.version, JSON.stringify(input.template), now)
    })
    return this.getFundingTemplate(input.templateId) ?? fail('funding template was not readable after save')
  }

  getFundingTemplate(templateId: string): FundingTemplateRecord | null {
    const row = this.requireDb().prepare('SELECT * FROM funding_templates WHERE id = ?').get(templateId)
    if (!row) return null
    const record = row as Record<string, unknown>
    const versionRow = this.requireDb().prepare(
      'SELECT MAX(version) AS v FROM funding_template_versions WHERE template_id = ?',
    ).get(templateId) as Record<string, unknown>
    return {
      templateId: requiredString(record['id'], 'funding template id'),
      projectId: typeof record['project_id'] === 'string' ? record['project_id'] : null,
      version: typeof versionRow['v'] === 'number' ? versionRow['v'] : 0,
      template: JSON.parse(requiredString(record['template_json'], 'funding template_json')) as JsonValue,
      createdAt: asTimestamp(record['created_at'], 'funding template created_at'),
      updatedAt: asTimestamp(record['updated_at'], 'funding template updated_at'),
    }
  }

  listFundingTemplates(projectId?: string): FundingTemplateRecord[] {
    const rows = projectId
      ? this.requireDb().prepare('SELECT id FROM funding_templates WHERE project_id = ? ORDER BY updated_at DESC').all(projectId)
      : this.requireDb().prepare('SELECT id FROM funding_templates ORDER BY updated_at DESC').all()
    return rows
      .map((row) => this.getFundingTemplate(String((row as Record<string, unknown>)['id'])))
      .filter((value): value is FundingTemplateRecord => value !== null)
  }

  saveFundingSectionDraft(input: {
    projectId: string
    templateId: string
    sectionId: string
    draftText: string
    usedEvidenceIds: readonly string[]
  }): FundingSectionDraftRecord {
    if (!this.getProject(input.projectId)) throw new Error(`cannot attach draft to unknown project: ${input.projectId}`)
    const draftText = input.draftText.trim()
    if (!draftText) throw new Error('draft text cannot be empty')
    for (const evidenceId of input.usedEvidenceIds) {
      if (!this.getEvidence(evidenceId)) throw new Error(`draft references unknown evidence: ${evidenceId}`)
    }
    const now = Date.now()
    const id = `draft-${randomUUID()}`
    const usedEvidenceIds = [...new Set(input.usedEvidenceIds)]
    this.requireDb().prepare(`
      INSERT INTO funding_section_drafts (id, project_id, template_id, section_id, draft_text, used_evidence_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.projectId, input.templateId, input.sectionId, draftText, JSON.stringify(usedEvidenceIds), now)
    return {
      id,
      projectId: input.projectId,
      templateId: input.templateId,
      sectionId: input.sectionId,
      draftText,
      usedEvidenceIds,
      createdAt: now,
    }
  }

  listFundingSectionDrafts(projectId: string, templateId?: string): FundingSectionDraftRecord[] {
    const rows = templateId
      ? this.requireDb().prepare('SELECT * FROM funding_section_drafts WHERE project_id = ? AND template_id = ? ORDER BY created_at ASC').all(projectId, templateId)
      : this.requireDb().prepare('SELECT * FROM funding_section_drafts WHERE project_id = ? ORDER BY created_at ASC').all(projectId)
    return rows.map((row) => {
      const record = row as Record<string, unknown>
      return {
        id: requiredString(record['id'], 'draft id'),
        projectId: requiredString(record['project_id'], 'draft project_id'),
        templateId: requiredString(record['template_id'], 'draft template_id'),
        sectionId: requiredString(record['section_id'], 'draft section_id'),
        draftText: requiredString(record['draft_text'], 'draft text'),
        usedEvidenceIds: (JSON.parse(requiredString(record['used_evidence_json'], 'draft used_evidence_json')) as unknown[])
          .filter((value): value is string => typeof value === 'string'),
        createdAt: asTimestamp(record['created_at'], 'draft created_at'),
      }
    })
  }

  // ── Submission persistence (v2) ─────────────────────────────────────────

  upsertJournalRecord(input: {
    journalId?: string
    source: string
    sourceId?: string
    journal: JsonValue
    verificationState?: EvidenceVerificationState
  }): string {
    const now = Date.now()
    const id = input.journalId ?? `jr-${randomUUID()}`
    this.requireDb().prepare(`
      INSERT INTO journal_records (id, source, source_id, journal_json, verification_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        journal_json = excluded.journal_json,
        verification_state = excluded.verification_state,
        updated_at = excluded.updated_at
    `).run(
      id,
      requiredString(input.source, 'journal source'),
      nullableText(input.sourceId),
      JSON.stringify(input.journal),
      input.verificationState ?? 'unverified',
      now,
      now,
    )
    return id
  }

  getJournalRecord(id: string): {
    id: string
    source: string
    sourceId?: string
    journal: JsonValue
    verificationState: EvidenceVerificationState
    createdAt: number
    updatedAt: number
  } | null {
    const row = this.requireDb().prepare('SELECT * FROM journal_records WHERE id = ?').get(id)
    if (!row) return null
    const record = row as Record<string, unknown>
    const sourceId = optionalString(record['source_id'])
    return {
      id: requiredString(record['id'], 'journal id'),
      source: requiredString(record['source'], 'journal source'),
      ...(sourceId ? { sourceId } : {}),
      journal: JSON.parse(requiredString(record['journal_json'], 'journal_json')) as JsonValue,
      verificationState: requiredString(record['verification_state'], 'journal verification_state') as EvidenceVerificationState,
      createdAt: asTimestamp(record['created_at'], 'journal created_at'),
      updatedAt: asTimestamp(record['updated_at'], 'journal updated_at'),
    }
  }

  setJournalRequirements(journalId: string, requirements: JsonValue, verificationState: EvidenceVerificationState): string {
    if (!this.getJournalRecord(journalId)) throw new Error(`cannot set requirements for unknown journal: ${journalId}`)
    const now = Date.now()
    const id = `jreq-${randomUUID()}`
    this.requireDb().prepare(`
      INSERT INTO journal_requirements (id, journal_id, requirements_json, verification_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, journalId, JSON.stringify(requirements), verificationState, now, now)
    return id
  }

  getJournalRequirements(journalId: string): JournalRequirementRecord[] {
    return this.requireDb().prepare(
      'SELECT * FROM journal_requirements WHERE journal_id = ? ORDER BY created_at DESC',
    ).all(journalId).map((row) => {
      const record = row as Record<string, unknown>
      return {
        id: requiredString(record['id'], 'journal requirement id'),
        journalId: requiredString(record['journal_id'], 'journal requirement journal_id'),
        requirements: JSON.parse(requiredString(record['requirements_json'], 'requirements_json')) as JsonValue,
        verificationState: requiredString(record['verification_state'], 'requirements verification_state') as EvidenceVerificationState,
        updatedAt: asTimestamp(record['updated_at'], 'requirements updated_at'),
      }
    })
  }

  createSubmissionCase(input: {
    projectId?: string | null
    artifactId?: string | null
    journalId?: string | null
    notes?: string
  }): SubmissionCaseRecord {
    if (input.projectId && !this.getProject(input.projectId)) throw new Error(`unknown project: ${input.projectId}`)
    if (input.artifactId && !this.getArtifact(input.artifactId)) throw new Error(`unknown artifact: ${input.artifactId}`)
    if (input.journalId && !this.getJournalRecord(input.journalId)) throw new Error(`unknown journal: ${input.journalId}`)
    const now = Date.now()
    const id = `case-${randomUUID()}`
    this.requireDb().prepare(`
      INSERT INTO submission_cases (id, project_id, artifact_id, journal_id, state_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.projectId ?? null, input.artifactId ?? null, input.journalId ?? null,
      JSON.stringify({ status: 'researching', notes: input.notes ?? '' }), now, now)
    return this.getSubmissionCase(id) ?? fail('submission case was not readable after insert')
  }

  getSubmissionCase(id: string): SubmissionCaseRecord | null {
    const row = this.requireDb().prepare('SELECT * FROM submission_cases WHERE id = ?').get(id)
    if (!row) return null
    const record = row as Record<string, unknown>
    const state = JSON.parse(requiredString(record['state_json'], 'case state_json')) as { status?: string; notes?: string }
    return submissionCaseFromRow(record, state)
  }

  listSubmissionCases(projectId?: string): SubmissionCaseRecord[] {
    const rows = projectId
      ? this.requireDb().prepare('SELECT * FROM submission_cases WHERE project_id = ? ORDER BY updated_at DESC').all(projectId)
      : this.requireDb().prepare('SELECT * FROM submission_cases ORDER BY updated_at DESC').all()
    return rows.map((row) => {
      const record = row as Record<string, unknown>
      const state = JSON.parse(requiredString(record['state_json'], 'case state_json')) as { status?: string; notes?: string }
      return submissionCaseFromRow(record, state)
    })
  }

  updateSubmissionCase(id: string, patch: {
    status?: SubmissionCaseStatus
    notes?: string
    journalId?: string | null
    artifactId?: string | null
  }): SubmissionCaseRecord | null {
    const current = this.getSubmissionCase(id)
    if (!current) return null
    const status = patch.status ?? current.status
    if (!(SUBMISSION_CASE_STATUSES as readonly string[]).includes(status)) throw new Error(`unknown submission status: ${status}`)
    if (patch.journalId && !this.getJournalRecord(patch.journalId)) throw new Error(`unknown journal: ${patch.journalId}`)
    if (patch.artifactId && !this.getArtifact(patch.artifactId)) throw new Error(`unknown artifact: ${patch.artifactId}`)
    this.requireDb().prepare(`
      UPDATE submission_cases SET
        artifact_id = ?, journal_id = ?, state_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      patch.artifactId === undefined ? current.artifactId : patch.artifactId,
      patch.journalId === undefined ? current.journalId : patch.journalId,
      JSON.stringify({
        status,
        notes: patch.notes === undefined ? current.notes ?? '' : patch.notes,
      }),
      Date.now(),
      id,
    )
    return this.getSubmissionCase(id)
  }

  addSubmissionCheck(caseId: string, check: JsonValue): string {
    if (!this.getSubmissionCase(caseId)) throw new Error(`unknown submission case: ${caseId}`)
    const id = `chk-${randomUUID()}`
    this.requireDb().prepare(
      'INSERT INTO submission_checks (id, case_id, check_json, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, caseId, JSON.stringify(check), Date.now())
    return id
  }

  recordArtifactJournalMatch(input: { artifactId: string; journalId: string; score?: number }): void {
    if (!this.getArtifact(input.artifactId)) throw new Error(`unknown artifact: ${input.artifactId}`)
    if (!this.getJournalRecord(input.journalId)) throw new Error(`unknown journal: ${input.journalId}`)
    this.requireDb().prepare(`
      INSERT INTO artifact_journal_matches (artifact_id, journal_id, score, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(artifact_id, journal_id) DO UPDATE SET score = excluded.score, created_at = excluded.created_at
    `).run(input.artifactId, input.journalId, input.score ?? null, Date.now())
  }

  /**
   * First-version gap check: journal requirement sets' verification facts
   * versus the artifact record. Reports unverified/conflicting requirement
   * sets and absent artifact metadata keys; never invents conformance.
   */
  submissionGapCheck(caseId: string): {
    caseRecord: SubmissionCaseRecord
    requirementSets: Array<JournalRequirementRecord>
    artifact: ArtifactRecord | null
    unverifiedRequirementSets: number
    conflictingRequirementSets: number
    artifactMissingKeys: string[]
  } {
    const caseRecord = this.getSubmissionCase(caseId)
    if (!caseRecord) throw new Error(`unknown submission case: ${caseId}`)
    const requirementSets = caseRecord.journalId ? this.getJournalRequirements(caseRecord.journalId) : []
    const artifact = caseRecord.artifactId ? this.getArtifact(caseRecord.artifactId) : null
    const requirementKeys = new Set<string>()
    for (const set of requirementSets) {
      const value = set.requirements
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
            const key = (item as Record<string, JsonValue>)['key']
            if (typeof key === 'string') requirementKeys.add(key)
          }
        }
      }
    }
    const artifactMissingKeys: string[] = []
    if (artifact) {
      for (const key of requirementKeys) {
        if ((artifact as unknown as Record<string, unknown>)[key] === undefined) artifactMissingKeys.push(key)
      }
    }
    return {
      caseRecord,
      requirementSets,
      artifact,
      unverifiedRequirementSets: requirementSets.filter((set) => set.verificationState === 'unverified').length,
      conflictingRequirementSets: requirementSets.filter((set) => set.verificationState === 'conflicting').length,
      artifactMissingKeys,
    }
  }

  updateArtifact(
    id: string,
    patch: { title?: string; status?: ArtifactStatus; projectId?: string | null; evidenceIds?: readonly string[] },
  ): ArtifactRecord | null {
    const current = this.getArtifact(id)
    if (!current) return null
    this.transaction(() => {
      this.requireDb().prepare(`
        UPDATE artifacts SET title = ?, status = ?, project_id = ?, updated_at = ? WHERE id = ?
      `).run(
        patch.title === undefined ? current.title : patch.title,
        patch.status === undefined ? current.status : patch.status,
        patch.projectId === undefined ? current.projectId : patch.projectId,
        Date.now(),
        id,
      )
      if (patch.evidenceIds !== undefined) this.replaceArtifactEvidence(id, patch.evidenceIds)
    })
    return this.getArtifact(id)
  }

  getArtifact(id: string): ArtifactRecord | null {
    const row = this.requireDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(id)
    return row ? this.artifactFromRow(row) : null
  }

  listArtifacts(filter: { projectId?: string; type?: ArtifactType } = {}): ArtifactRecord[] {
    let sql = 'SELECT * FROM artifacts'
    const params: string[] = []
    if (filter.projectId) {
      sql += ' WHERE project_id = ?'
      params.push(filter.projectId)
    } else if (filter.type) {
      sql += ' WHERE type = ?'
      params.push(filter.type)
    }
    sql += ' ORDER BY updated_at DESC, id ASC'
    return this.requireDb().prepare(sql).all(...params).map((row) => this.artifactFromRow(row))
  }

  private replaceArtifactEvidence(artifactId: string, evidenceIds: readonly string[]): void {
    const db = this.requireDb()
    db.prepare('DELETE FROM artifact_evidence_links WHERE artifact_id = ?').run(artifactId)
    const insert = db.prepare(
      'INSERT INTO artifact_evidence_links (artifact_id, evidence_id, created_at) VALUES (?, ?, ?)',
    )
    const now = Date.now()
    for (const evidenceId of new Set(evidenceIds)) {
      if (!this.getEvidence(evidenceId)) throw new Error(`cannot link artifact to unknown evidence: ${evidenceId}`)
      insert.run(artifactId, evidenceId, now)
    }
  }

  private artifactFromRow(row: unknown): ArtifactRecord {
    const record = row as Record<string, unknown>
    const id = requiredString(record['id'], 'artifact id')
    const versions = this.requireDb().prepare(`
      SELECT artifact_id, version, workspace_path, note, created_at, content_hash, created_by FROM artifact_versions
      WHERE artifact_id = ? ORDER BY version ASC
    `).all(id).map((value) => artifactVersionFromRow(value))
    const evidenceIds = this.requireDb().prepare(`
      SELECT evidence_id FROM artifact_evidence_links WHERE artifact_id = ? ORDER BY evidence_id ASC
    `).all(id).map((value) => requiredString((value as Record<string, unknown>)['evidence_id'], 'artifact evidence id'))
    return {
      id,
      type: requiredString(record['type'], 'artifact type') as ArtifactType,
      title: requiredString(record['title'], 'artifact title'),
      workspacePath: requiredString(record['workspace_path'], 'artifact workspace_path'),
      projectId: typeof record['project_id'] === 'string' ? record['project_id'] : null,
      version: asTimestamp(record['version'], 'artifact version'),
      source: requiredString(record['source'], 'artifact source'),
      status: requiredString(record['status'], 'artifact status') as ArtifactStatus,
      ...(optionalString(record['mime_type']) ? { mimeType: optionalString(record['mime_type']) } : {}),
      ...(typeof record['finalized_at'] === 'number' ? { finalizedAt: record['finalized_at'] } : {}),
      createdAt: asTimestamp(record['created_at'], 'artifact created_at'),
      updatedAt: asTimestamp(record['updated_at'], 'artifact updated_at'),
      evidenceIds,
      versions,
    }
  }
}

const MIGRATION_V1_UP = (db: DatabaseSync): void => {
  db.exec(`
        CREATE TABLE research_projects (
          id TEXT PRIMARY KEY,
          title TEXT,
          discipline TEXT,
          research_question TEXT,
          research_object TEXT,
          methodology TEXT,
          stage TEXT,
          keywords_json TEXT NOT NULL,
          publication_intent TEXT,
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE workspace_project_bindings (
          workspace_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE session_project_bindings (
          session_id TEXT PRIMARY KEY,
          workspace_id TEXT,
          project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE literature_records (
          id TEXT PRIMARY KEY,
          dedupe_key TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          authors_json TEXT NOT NULL,
          year INTEGER,
          journal TEXT,
          abstract TEXT,
          doi TEXT,
          url TEXT,
          source TEXT NOT NULL,
          source_id TEXT,
          keywords_json TEXT NOT NULL,
          citation_count INTEGER,
          core_status TEXT,
          verification_state TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE project_literature (
          project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
          literature_id TEXT NOT NULL REFERENCES literature_records(id) ON DELETE CASCADE,
          evidence_id TEXT,
          saved_at INTEGER NOT NULL,
          PRIMARY KEY (project_id, literature_id)
        ) STRICT;
        CREATE TABLE evidence_sources (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          source_id TEXT,
          url TEXT,
          retrieved_at INTEGER,
          doi TEXT,
          dedupe_key TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE evidence_records (
          id TEXT PRIMARY KEY,
          project_id TEXT REFERENCES research_projects(id) ON DELETE SET NULL,
          source_id TEXT NOT NULL REFERENCES evidence_sources(id) ON DELETE RESTRICT,
          source_type TEXT NOT NULL,
          title TEXT NOT NULL,
          observation TEXT,
          observed_at INTEGER NOT NULL,
          verification_state TEXT NOT NULL,
          created_by_tool TEXT NOT NULL,
          truncated INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          dedupe_key TEXT NOT NULL UNIQUE
        ) STRICT;
        CREATE TABLE evidence_excerpts (
          id TEXT PRIMARY KEY,
          evidence_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          locator TEXT,
          created_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE evidence_claims (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
          text TEXT NOT NULL,
          verification_state TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE claim_evidence_links (
          claim_id TEXT NOT NULL REFERENCES evidence_claims(id) ON DELETE CASCADE,
          evidence_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE CASCADE,
          relation TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (claim_id, evidence_id)
        ) STRICT;
        CREATE TABLE scenario_activations (
          session_id TEXT PRIMARY KEY,
          project_id TEXT REFERENCES research_projects(id) ON DELETE SET NULL,
          scenario_id TEXT NOT NULL,
          activated_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          workspace_path TEXT NOT NULL,
          project_id TEXT REFERENCES research_projects(id) ON DELETE SET NULL,
          version INTEGER NOT NULL,
          source TEXT NOT NULL,
          status TEXT NOT NULL,
          mime_type TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE artifact_versions (
          artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          workspace_path TEXT NOT NULL,
          note TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (artifact_id, version)
        ) STRICT;
        CREATE TABLE artifact_evidence_links (
          artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
          evidence_id TEXT NOT NULL REFERENCES evidence_records(id) ON DELETE RESTRICT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (artifact_id, evidence_id)
        ) STRICT;
        CREATE TABLE funding_templates (
          id TEXT PRIMARY KEY,
          project_id TEXT REFERENCES research_projects(id) ON DELETE SET NULL,
          template_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE funding_projects (
          id TEXT PRIMARY KEY,
          project_id TEXT REFERENCES research_projects(id) ON DELETE CASCADE,
          template_id TEXT REFERENCES funding_templates(id) ON DELETE SET NULL,
          state_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE journal_records (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          source_id TEXT,
          journal_json TEXT NOT NULL,
          verification_state TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE journal_requirements (
          id TEXT PRIMARY KEY,
          journal_id TEXT NOT NULL REFERENCES journal_records(id) ON DELETE CASCADE,
          requirements_json TEXT NOT NULL,
          verification_state TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE submission_cases (
          id TEXT PRIMARY KEY,
          project_id TEXT REFERENCES research_projects(id) ON DELETE SET NULL,
          artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
          journal_id TEXT REFERENCES journal_records(id) ON DELETE SET NULL,
          state_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
      `)
}

const MIGRATION_V2_UP = (db: DatabaseSync): void => {
  db.exec(`
    ALTER TABLE evidence_claims ADD COLUMN claim_type TEXT NOT NULL DEFAULT 'factual';
    ALTER TABLE evidence_claims ADD COLUMN artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL;
    ALTER TABLE claim_evidence_links ADD COLUMN confidence REAL;
    ALTER TABLE artifact_versions ADD COLUMN content_hash TEXT;
    ALTER TABLE artifact_versions ADD COLUMN created_by TEXT;
    ALTER TABLE artifacts ADD COLUMN finalized_at INTEGER;
    CREATE TABLE funding_template_versions (
      template_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      template_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (template_id, version)
    ) STRICT;
    CREATE TABLE funding_section_drafts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
      template_id TEXT NOT NULL,
      section_id TEXT NOT NULL,
      draft_text TEXT NOT NULL,
      used_evidence_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE submission_checks (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL REFERENCES submission_cases(id) ON DELETE CASCADE,
      check_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE artifact_journal_matches (
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      journal_id TEXT NOT NULL REFERENCES journal_records(id) ON DELETE CASCADE,
      score REAL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (artifact_id, journal_id)
    ) STRICT;
  `)
}

const SCHEMA_MIGRATIONS: ReadonlyArray<{ version: number; name: string; up: (db: DatabaseSync) => void }> = [
  { version: 1, name: 'initial research domain schema', up: MIGRATION_V1_UP },
  { version: 2, name: 'claim-level evidence, artifact hardening, funding/submission persistence', up: MIGRATION_V2_UP },
]

function claimFromRow(row: unknown): EvidenceClaimRecord {
  const record = row as Record<string, unknown>
  const artifactId = optionalString(record['artifact_id'])
  return {
    id: requiredString(record['id'], 'claim id'),
    projectId: requiredString(record['project_id'], 'claim project_id'),
    ...(artifactId ? { artifactId } : {}),
    claimType: requiredString(record['claim_type'], 'claim claim_type') as ClaimType,
    text: requiredString(record['text'], 'claim text'),
    verificationState: requiredString(record['verification_state'], 'claim verification_state') as EvidenceVerificationState,
    createdAt: asTimestamp(record['created_at'], 'claim created_at'),
    updatedAt: asTimestamp(record['updated_at'], 'claim updated_at'),
  }
}

function projectFromRow(row: unknown): ResearchProjectRecord {
  const record = row as Record<string, unknown>
  const keywords = parseJsonArray(record['keywords_json']).filter((value): value is string => typeof value === 'string')
  const stage = optionalString(record['stage']) as ResearchProjectStage | undefined
  return {
    id: requiredString(record['id'], 'research project id'),
    workspaceId: typeof record['workspace_id'] === 'string' ? record['workspace_id'] : null,
    ...(optionalString(record['title']) ? { title: optionalString(record['title']) } : {}),
    ...(optionalString(record['discipline']) ? { discipline: optionalString(record['discipline']) } : {}),
    ...(optionalString(record['research_question']) ? { researchQuestion: optionalString(record['research_question']) } : {}),
    ...(optionalString(record['research_object']) ? { researchObject: optionalString(record['research_object']) } : {}),
    ...(optionalString(record['methodology']) ? { methodology: optionalString(record['methodology']) } : {}),
    ...(stage ? { stage } : {}),
    ...(keywords.length > 0 ? { keywords } : {}),
    ...(optionalString(record['publication_intent']) ? { publicationIntent: optionalString(record['publication_intent']) } : {}),
    ...(optionalString(record['notes']) ? { notes: optionalString(record['notes']) } : {}),
    createdAt: asTimestamp(record['created_at'], 'research project created_at'),
    updatedAt: asTimestamp(record['updated_at'], 'research project updated_at'),
  }
}

function literatureFromRow(row: unknown): LiteratureRecord {
  const record = row as Record<string, unknown>
  const authors = parseJsonArray(record['authors_json']).flatMap((value): LiteratureAuthor[] => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
    const author = value as Record<string, unknown>
    const name = optionalString(author['name'])
    if (!name) return []
    return [{
      name,
      ...(optionalString(author['given']) ? { given: optionalString(author['given']) } : {}),
      ...(optionalString(author['family']) ? { family: optionalString(author['family']) } : {}),
    }]
  })
  const projectId = optionalString(record['project_id'])
  const evidenceId = optionalString(record['evidence_id'])
  const verificationState = optionalString(record['verification_state']) as EvidenceVerificationState | undefined
  return {
    id: requiredString(record['id'], 'literature id'),
    title: requiredString(record['title'], 'literature title'),
    authors,
    year: integerOrNull(record['year']),
    source: requiredString(record['source'], 'literature source'),
    ...(optionalString(record['journal']) ? { journal: optionalString(record['journal']) } : {}),
    ...(optionalString(record['abstract']) ? { abstract: optionalString(record['abstract']) } : {}),
    ...(optionalString(record['doi']) ? { doi: optionalString(record['doi']) } : {}),
    ...(optionalString(record['url']) ? { url: optionalString(record['url']) } : {}),
    ...(optionalString(record['source_id']) ? { sourceId: optionalString(record['source_id']) } : {}),
    ...(parseJsonArray(record['keywords_json']).filter((value): value is string => typeof value === 'string').length > 0
      ? { keywords: parseJsonArray(record['keywords_json']).filter((value): value is string => typeof value === 'string') }
      : {}),
    ...(integerOrNull(record['citation_count']) !== null ? { citationCount: integerOrNull(record['citation_count']) ?? undefined } : {}),
    ...(optionalString(record['core_status']) ? { coreStatus: optionalString(record['core_status']) as LiteratureRecord['coreStatus'] } : {}),
    ...(verificationState ? { verificationState } : {}),
    ...(evidenceId ? { evidenceId } : {}),
    ...(projectId ? { projectId } : {}),
  }
}

function evidenceFromRow(row: unknown): EvidenceRecord {
  const record = row as Record<string, unknown>
  const source: EvidenceSourceInput = {
    provider: requiredString(record['provider'], 'evidence source provider'),
    ...(optionalString(record['provider_source_id']) ? { sourceId: optionalString(record['provider_source_id']) } : {}),
    ...(optionalString(record['source_url']) ? { url: optionalString(record['source_url']) } : {}),
    ...(integerOrNull(record['retrieved_at']) !== null ? { retrievedAt: integerOrNull(record['retrieved_at']) ?? undefined } : {}),
  }
  return {
    id: requiredString(record['id'], 'evidence id'),
    projectId: typeof record['project_id'] === 'string' ? record['project_id'] : null,
    sourceType: requiredString(record['source_type'], 'evidence source_type') as EvidenceSourceType,
    source,
    title: requiredString(record['title'], 'evidence title'),
    ...(optionalString(record['observation']) ? { observation: optionalString(record['observation']) } : {}),
    ...(optionalString(record['doi']) ? { doi: optionalString(record['doi']) } : {}),
    ...(optionalString(record['source_url']) ? { url: optionalString(record['source_url']) } : {}),
    observedAt: asTimestamp(record['observed_at'], 'evidence observed_at'),
    verificationState: requiredString(record['verification_state'], 'evidence verification_state') as EvidenceVerificationState,
    createdByTool: requiredString(record['created_by_tool'], 'evidence created_by_tool'),
    createdAt: asTimestamp(record['created_at'], 'evidence created_at'),
    updatedAt: asTimestamp(record['updated_at'], 'evidence updated_at'),
    ...(record['truncated'] === 1 ? { truncated: true } : {}),
  }
}

function artifactVersionFromRow(row: unknown): ArtifactVersionRecord {
  const record = row as Record<string, unknown>
  const contentHash = optionalString(record['content_hash'])
  const createdBy = optionalString(record['created_by'])
  return {
    artifactId: requiredString(record['artifact_id'], 'artifact version artifact_id'),
    version: asTimestamp(record['version'], 'artifact version number'),
    workspacePath: requiredString(record['workspace_path'], 'artifact version workspace_path'),
    ...(contentHash ? { contentHash } : {}),
    ...(createdBy ? { createdBy } : {}),
    createdAt: asTimestamp(record['created_at'], 'artifact version created_at'),
    ...(optionalString(record['note']) ? { note: optionalString(record['note']) } : {}),
  }
}

function submissionCaseFromRow(record: Record<string, unknown>, state: { status?: string; notes?: string }): SubmissionCaseRecord {
  return {
    id: requiredString(record['id'], 'case id'),
    projectId: typeof record['project_id'] === 'string' ? record['project_id'] : null,
    artifactId: typeof record['artifact_id'] === 'string' ? record['artifact_id'] : null,
    journalId: typeof record['journal_id'] === 'string' ? record['journal_id'] : null,
    status: requiredString(state.status ?? 'researching', 'case status') as SubmissionCaseStatus,
    notes: typeof state.notes === 'string' ? state.notes : null,
    createdAt: asTimestamp(record['created_at'], 'case created_at'),
    updatedAt: asTimestamp(record['updated_at'], 'case updated_at'),
  }
}

function normalizeKeywords(keywords: readonly string[] | undefined): string[] {
  return [...new Set((keywords ?? []).map((value) => value.trim()).filter(Boolean))]
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>
}

function asTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`METIS database row has invalid ${field}`)
  }
  return value
}

function fail(message: string): never {
  throw new Error(message)
}
