import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  PERSONALIZATION_CONTRACT_VERSION,
  McpDefinitionSchema,
  PersonalizationDefinitionSchema,
  parsePersonalizationDefinitionLenient,
  ResolvedRunManifestSchema,
  type PersonalizationDefinition,
  type McpDefinition,
  type PersonalizationIntegrityIssue,
  type PersonalizationMutationResult,
  type PersonalizationSaveRequest,
  type ResolvedRunManifest,
} from '../runtime/PersonalizationRuntimeContract.js';
import {
  ScenarioRunRecordSchema,
  digestResolvedManifestSnapshot,
  type ScenarioRunRecord,
} from './ScenarioRunCoordinator.js';
import {
  PersonalizationBundleAssetBindingSchema,
  type PersonalizationBundleAssetBinding,
} from '../runtime/PersonalizationBundleContract.js';
import {
  EvidenceEnvelopeSchema,
  type EvidenceEnvelope,
} from '../runtime/EvidenceEnvelopeContract.js';
import {
  McpActivationEvidencePayloadSchema,
  McpActivationPersistenceInputSchema,
  type McpActivationPersistenceInput,
} from '../runtime/McpActivationContract.js';

interface DefinitionRow {
  id: string;
  kind: PersonalizationDefinition['kind'];
  origin: PersonalizationDefinition['provenance']['origin'];
  current_revision: number;
  factory_json: string | null;
  current_json: string;
  archived: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PersonalizationVersionView {
  id: string;
  revision: number;
  contentDigest: string;
  definition: PersonalizationDefinition;
  createdAt: number;
}

export interface ArchivedPersonalizationDefinition {
  definition: PersonalizationDefinition;
  archivedAt: number;
  expiresAt: number;
}

type DefinitionIntegrityIssue = PersonalizationIntegrityIssue;

/** Soft-deleted scenarios remain recoverable for one full seven-day window. */
/** Fixed recovery window for every soft-deleted definition (scenario, skill, MCP, rules). */
export const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface ScenarioMemoryRecordQuery {
  sessionId?: string;
  projectId?: string;
  scenarioId?: string;
  limit?: number;
}

/** Shared with the unified migration pipeline (v116); the constructor re-runs it as an
 *  idempotent safety net for tests that build a repository on a bare database. */
export const PERSONALIZATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS personalization_definitions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  factory_json TEXT,
  current_json TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_personalization_kind
  ON personalization_definitions(kind, archived, updated_at DESC);

CREATE TABLE IF NOT EXISTS personalization_versions (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_digest TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id, revision),
  FOREIGN KEY (id) REFERENCES personalization_definitions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS personalization_run_manifests (
  manifest_digest TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  integrity_tag TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_personalization_run_session
  ON personalization_run_manifests(session_id, active, created_at DESC);

CREATE TABLE IF NOT EXISTS personalization_scenario_runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  status TEXT NOT NULL,
  record_json TEXT NOT NULL,
  integrity_tag TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_personalization_scenario_run_session
  ON personalization_scenario_runs(session_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_personalization_scenario_run_project
  ON personalization_scenario_runs(project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_personalization_scenario_run_scenario
  ON personalization_scenario_runs(scenario_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS personalization_asset_bindings (
  owner_id TEXT PRIMARY KEY,
  directory_token TEXT NOT NULL,
  relative_root TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES personalization_definitions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS personalization_evidence_envelopes (
  envelope_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  source_definition_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  observed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_personalization_evidence_session
  ON personalization_evidence_envelopes(session_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS personalization_definition_quarantine (
  id TEXT NOT NULL,
  quarantined_revision INTEGER NOT NULL,
  current_json TEXT NOT NULL,
  issue_code TEXT NOT NULL,
  quarantined_at INTEGER NOT NULL,
  PRIMARY KEY (id, quarantined_revision),
  FOREIGN KEY (id) REFERENCES personalization_definitions(id) ON DELETE CASCADE
);
`;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function digestDefinition(definition: PersonalizationDefinition): string {
  return createHash('sha256').update(canonicalJson(definition), 'utf8').digest('hex');
}

function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function stableEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validMcpActivationTransition(input: McpActivationPersistenceInput): boolean {
  const { previousDefinition: previous, activatedDefinition: activated, installation, envelope, owner } = input;
  const sourceMatches = (previous.sourceMode === 'url'
      && activated.sourceMode === 'url'
      && previous.id.startsWith('url:mcp/')
      && previous.provenance.origin === 'url'
      && activated.provenance.origin === 'url'
      && previous.sourceUrl !== null)
    || (previous.sourceMode === 'generated'
      && activated.sourceMode === 'generated'
      && previous.id.startsWith('generated:mcp/')
      && previous.provenance.origin === 'generated'
      && activated.provenance.origin === 'generated'
      && previous.sourceUrl === null)
    || (previous.sourceMode === 'package'
      && activated.sourceMode === 'package'
      && previous.id.startsWith('user:mcp/')
      && previous.provenance.origin === 'user'
      && activated.provenance.origin === 'user'
      && previous.sourceUrl === null);
  if (previous.id !== activated.id || !sourceMatches
    || previous.enabled || !activated.enabled || previous.revision + 1 !== activated.revision
    || previous.args.length !== 1 || previous.args[0] !== installation.installationId
    || previous.workingDirectoryToken !== installation.installationId
    || previous.provenance.sourceRevision !== installation.installationId
    || previous.provenance.installedDigest !== installation.packageSha256
    || previous.name !== installation.packageId || previous.provenance.version !== installation.packageVersion
    || installation.state !== 'enabled' || !installation.enabled || installation.probedAt === null
    || installation.failureCode !== null || installation.exposedTools.length === 0
    || !sameStringArray(activated.exposedTools, installation.exposedTools)
    || previous.exposedTools.length !== 0
    || !previous.tags.includes('pending-probe') || previous.tags.includes('probe-verified')
    || activated.tags.includes('pending-probe') || !activated.tags.includes('probe-verified')
    || Object.keys(previous.environment).length !== 0
    || Object.values(activated.environment).some((entry) => entry.secret !== true || entry.value !== null)) return false;
  const previousPreservedTags = previous.tags.filter((tag) => tag !== 'pending-probe' && tag !== 'probe-verified');
  const activatedPreservedTags = activated.tags.filter((tag) => tag !== 'pending-probe' && tag !== 'probe-verified');
  if (!sameStringArray(previousPreservedTags, activatedPreservedTags)) return false;

  const {
    enabled: _previousEnabled,
    tags: _previousTags,
    revision: _previousRevision,
    provenance: previousProvenance,
    environment: _previousEnvironment,
    exposedTools: _previousTools,
    ...previousIdentity
  } = previous;
  const {
    enabled: _activatedEnabled,
    tags: _activatedTags,
    revision: _activatedRevision,
    provenance: activatedProvenance,
    environment: _activatedEnvironment,
    exposedTools: _activatedTools,
    ...activatedIdentity
  } = activated;
  void _previousEnabled;
  void _previousTags;
  void _previousRevision;
  void _previousEnvironment;
  void _previousTools;
  void _activatedEnabled;
  void _activatedTags;
  void _activatedRevision;
  void _activatedEnvironment;
  void _activatedTools;
  const { updatedAt: _previousUpdatedAt, ...previousProvenanceIdentity } = previousProvenance;
  const { updatedAt: _activatedUpdatedAt, ...activatedProvenanceIdentity } = activatedProvenance;
  void _previousUpdatedAt;
  if (!stableEqual(previousIdentity, activatedIdentity)
    || !stableEqual(previousProvenanceIdentity, activatedProvenanceIdentity)
    || _activatedUpdatedAt < previous.provenance.updatedAt) return false;

  if (envelope.sourceDefinitionId !== activated.id
    || envelope.sourceDefinitionRevision !== activated.revision
    || envelope.sourceKind !== 'mcp' || envelope.sourceUrl !== activated.sourceUrl || envelope.locator !== null
    || envelope.payload.kind !== 'json' || envelope.payloadDigest !== sha256Canonical(envelope.payload)
    || envelope.truth.state !== 'unverified' || envelope.truth.reviewStatus !== 'pending'
    || envelope.truth.correctionState !== 'unknown' || envelope.truth.claimEligible !== false
    || envelope.truth.publishEligible !== false) return false;
  let payloadRaw: unknown;
  try { payloadRaw = JSON.parse(envelope.payload.canonicalJson) as unknown; } catch { return false; }
  const payload = McpActivationEvidencePayloadSchema.safeParse(payloadRaw);
  if (!payload.success || envelope.payload.canonicalJson !== canonicalJson(payload.data)) return false;
  return payload.data.definitionId === activated.id
    && payload.data.installationId === installation.installationId
    && payload.data.packageId === installation.packageId
    && payload.data.packageVersion === installation.packageVersion
    && payload.data.packageDigest === installation.packageSha256
    && payload.data.manifestDigest === installation.manifestSha256
    && payload.data.priorRevision === previous.revision
    && payload.data.activatedRevision === activated.revision
    && sameStringArray(payload.data.exposedTools, installation.exposedTools)
    && stableEqual(payload.data.owner, owner);
}

function scenarioRunIntegrityTag(secret: Buffer, record: ScenarioRunRecord): string {
  return createHmac('sha256', secret)
    .update('metis:personalization-scenario-run:v1\0')
    .update(canonicalJson(record), 'utf8')
    .digest('hex');
}

function verifiesScenarioRun(secret: Buffer | null, record: ScenarioRunRecord, tag: string | null): boolean {
  if (!secret || !tag || !/^[a-f0-9]{64}$/u.test(tag)) return false;
  const expected = Buffer.from(scenarioRunIntegrityTag(secret, record), 'hex');
  const actual = Buffer.from(tag, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function parseDefinition(raw: string): PersonalizationDefinition {
  const parsedJson: unknown = JSON.parse(raw);
  return PersonalizationDefinitionSchema.parse(parsedJson);
}

function referencedDefinitionIds(definition: PersonalizationDefinition): string[] {
  switch (definition.kind) {
    case 'scenario':
      return [
        ...definition.agentIds,
        ...definition.skillIds,
        ...definition.mcpIds,
        ...definition.rulesIds,
        ...definition.workflow.flatMap((step) => [step.agentId, ...step.skillIds, ...step.mcpIds]
          .filter((id): id is string => typeof id === 'string')),
      ];
    case 'agent':
      return [...definition.skillIds, ...definition.mcpIds];
    case 'skill':
      return [...definition.mcpIds];
    case 'mcp':
    case 'rules':
      return [];
  }
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function assertRunProgression(previous: ScenarioRunRecord, next: ScenarioRunRecord): void {
  if (next.startedAt !== previous.startedAt || next.updatedAt < previous.updatedAt) {
    throw new Error('Scenario run timestamps cannot move backwards');
  }
  // `cancelled`/`completed` are terminal: no late write may mutate them or
  // revive them into recoverable state. `failed` is deliberately NOT terminal
  // (2026-08-30 刘总报告：31 步跑到 30 步最后一步失败，「继续」必须能只重跑
  // 失败步骤)——失败记录允许复活为 running 并重置失败步骤，其余步骤仍不可变。
  const previousTerminal = ['completed', 'cancelled'].includes(previous.status);
  const failedRevived = previous.status === 'failed' && next.status === 'running';
  if (previousTerminal) {
    if (canonicalJson(previous) !== canonicalJson(next)) {
      throw new Error('Terminal scenario run records are immutable');
    }
    return;
  }
  // Harness state machine: loop counters (backtrack / workflow re-entry) are the only
  // run-level signal that legitimizes resetting a terminal-ish step back to pending.
  const loopAdvanced = next.backtrackCount > previous.backtrackCount
    || next.workflowIteration > previous.workflowIteration;
  const nextById = new Map(next.steps.map((step) => [step.stepId, step]));
  for (const previousStep of previous.steps) {
    const nextStep = nextById.get(previousStep.stepId);
    if (!nextStep) throw new Error('Scenario run steps cannot be removed');
    if (['completed', 'failed', 'blocked', 'skipped'].includes(previousStep.status)) {
      if (canonicalJson(previousStep) === canonicalJson(nextStep)) continue;
      // Backtrack / Workflow Loop re-entry deliberately resets downstream steps for
      // a fresh pass. Any other mutation of a terminal-ish step record is forgery.
      if (loopAdvanced && nextStep.status === 'pending') continue;
      // 步骤卡「跳过」（2026-09-01 刘总方案二期）：回退授权下允许把终态步骤
      // 置为 skipped（不产出、下游重跑）——与 pending 重置同一合法信号。
      if (loopAdvanced && nextStep.status === 'skipped') continue;
      if (failedRevived && previousStep.status === 'failed' && nextStep.status === 'pending') continue;
      throw new Error('Terminal scenario step records are immutable');
    }
    const stepLoopAdvanced = nextStep.errorCode !== null
      || nextStep.attempts !== previousStep.attempts
      || nextStep.loopIteration !== previousStep.loopIteration
      || nextStep.validationHistory.length !== previousStep.validationHistory.length;
    const allowed = previousStep.status === 'pending'
      ? ['pending', 'running', 'completed', 'failed', 'blocked', 'skipped']
      : ['running', 'completed', 'failed', 'skipped'];
    const retryOrLoopBack = previousStep.status === 'running'
      && nextStep.status === 'pending'
      && stepLoopAdvanced;
    // Backtrack / Workflow Loop re-entry also resets the currently running step itself
    // (its error/attempt markers were already cleared by the reset), authorized by the
    // run-level loop counters.
    const resetByLoop = loopAdvanced && nextStep.status === 'pending';
    // Resuming an uncertain step is legitimate from both `interrupted` and the
    // public `paused` checkpoint state: a running step had no observed outcome.
    const resumingUncertainStep = ['interrupted', 'paused'].includes(previous.status)
      && previousStep.status === 'running'
      && next.status === 'running'
      && nextStep.status === 'pending'
      && nextStep.executionKey === previousStep.executionKey;
    if (!allowed.includes(nextStep.status) && !retryOrLoopBack && !resumingUncertainStep && !resetByLoop) {
      throw new Error('Scenario step status cannot move backwards');
    }
  }
}

export class PersonalizationRepository {
  readonly #db: Database.Database;
  readonly #scenarioRunIntegritySecret: Buffer | null;

  constructor(db: Database.Database, scenarioRunIntegritySecret?: Buffer) {
    this.#db = db;
    this.#scenarioRunIntegritySecret = scenarioRunIntegritySecret && scenarioRunIntegritySecret.length >= 32
      ? Buffer.from(scenarioRunIntegritySecret)
      : null;
    this.#db.exec(PERSONALIZATION_SCHEMA_SQL);
    // Legacy column patches (archived_at / integrity_tag, the archived_at backfill and
    // the retention index) live in the unified migration pipeline as v116
    // (engine/persistence/migrations.ts). This constructor only re-applies the
    // idempotent DDL above so tests can build a repository on a bare database.
  }

  seedBuiltins(definitions: readonly PersonalizationDefinition[]): void {
    const transaction = this.#db.transaction(() => {
      for (const candidate of definitions) {
        const definition = PersonalizationDefinitionSchema.parse(candidate);
        if (definition.provenance.origin !== 'builtin' || !definition.id.startsWith('builtin:')) {
          throw new Error(`Factory definition must use builtin origin and namespace: ${definition.id}`);
        }
        const current = this.#selectRow(definition.id);
        const raw = canonicalJson(definition);
        const digest = digestDefinition(definition);
        if (!current) {
          this.#db.prepare(`
            INSERT INTO personalization_definitions
              (id, kind, origin, current_revision, factory_json, current_json, archived, created_at, updated_at)
            VALUES (?, ?, 'builtin', ?, ?, ?, 0, ?, ?)
          `).run(
            definition.id,
            definition.kind,
            definition.revision,
            raw,
            raw,
            definition.provenance.createdAt,
            definition.provenance.updatedAt,
          );
          this.#insertVersion(definition, digest);
          continue;
        }
        if (current.origin !== 'builtin') {
          throw new Error(`Factory ID is occupied by a non-factory definition: ${definition.id}`);
        }
        const existingFactory = current.factory_json ? parseDefinition(current.factory_json) : undefined;
        if (existingFactory && digestDefinition(existingFactory) === digest) continue;
        const nextRevision = current.current_revision + 1;
        const next = PersonalizationDefinitionSchema.parse({
          ...definition,
          revision: nextRevision,
        });
        const nextRaw = canonicalJson(next);
        this.#db.prepare(`
          UPDATE personalization_definitions
          SET kind = ?, current_revision = ?, factory_json = ?, current_json = ?, archived = 0, archived_at = NULL,
              updated_at = ?
          WHERE id = ? AND origin = 'builtin'
        `).run(next.kind, nextRevision, nextRaw, nextRaw, next.provenance.updatedAt, next.id);
        this.#insertVersion(next, digestDefinition(next));
      }
    });
    transaction();
  }

  list(kind?: PersonalizationDefinition['kind'], includeDisabled = false): PersonalizationDefinition[] {
    const rows = (kind
      ? this.#db.prepare(`
          SELECT * FROM personalization_definitions
          WHERE archived = 0 AND kind = ? ORDER BY updated_at DESC, id ASC
        `).all(kind)
      : this.#db.prepare(`
          SELECT * FROM personalization_definitions
          WHERE archived = 0 ORDER BY kind ASC, updated_at DESC, id ASC
        `).all()) as DefinitionRow[];
    return rows
      .flatMap((row) => {
        try { return [this.#parseVerifiedRow(row)]; } catch { return []; }
      })
      .filter((definition) => includeDisabled || definition.enabled);
  }

  /**
   * Reports quarantined rows without exposing their unverified JSON to the
   * renderer. They remain excluded from all execution and normal catalog APIs.
   */
  listIntegrityIssues(kind?: PersonalizationDefinition['kind']): DefinitionIntegrityIssue[] {
    const rows = (kind
      ? this.#db.prepare(`
          SELECT * FROM personalization_definitions WHERE kind = ? ORDER BY updated_at DESC, id ASC
        `).all(kind)
      : this.#db.prepare(`
          SELECT * FROM personalization_definitions ORDER BY kind ASC, updated_at DESC, id ASC
        `).all()) as DefinitionRow[];
    return rows.flatMap((row) => {
      const issue = this.#integrityIssueForRow(row);
      return issue ? [issue] : [];
    });
  }

  /** Lists soft-deleted definitions together with their fixed recovery window. */
  listArchived(kind?: PersonalizationDefinition['kind']): ArchivedPersonalizationDefinition[] {
    const rows = (kind
      ? this.#db.prepare(`
          SELECT * FROM personalization_definitions
          WHERE archived = 1 AND kind = ? ORDER BY archived_at DESC, id ASC
        `).all(kind)
      : this.#db.prepare(`
          SELECT * FROM personalization_definitions
          WHERE archived = 1 ORDER BY archived_at DESC, id ASC
        `).all()) as DefinitionRow[];
    return rows.flatMap((row) => {
      try {
        const archivedAt = row.archived_at ?? row.updated_at;
        return [{
          definition: this.#parseVerifiedRow(row),
          archivedAt,
          expiresAt: archivedAt + TRASH_RETENTION_MS,
        }];
      } catch {
        return [];
      }
    });
  }

  /**
   * Applies the promised retention policy.  We run this from the real list
   * service instead of relying on a renderer timer, so it still happens after
   * the app was closed through the expiry moment.  The retention window covers
   * every definition kind; expired rows are removed together with their
   * version history, and verified definitions are returned so the desktop
   * layer can release matching installed assets.
   */
  purgeExpiredArchivedDefinitions(now = Date.now()): PersonalizationDefinition[] {
    const cutoff = now - TRASH_RETENTION_MS;
    const expiredRows = this.#db.prepare(`
      SELECT * FROM personalization_definitions
      WHERE archived = 1 AND COALESCE(archived_at, updated_at) <= ?
    `).all(cutoff) as DefinitionRow[];
    if (expiredRows.length === 0) return [];
    const verified: PersonalizationDefinition[] = [];
    for (const row of expiredRows) {
      try { verified.push(this.#parseVerifiedRow(row)); } catch { /* corrupted rows still expire below */ }
    }
    this.#db.transaction(() => {
      for (const row of expiredRows) {
        this.#db.prepare('DELETE FROM personalization_versions WHERE id = ?').run(row.id);
      }
      this.#db.prepare(`
        DELETE FROM personalization_definitions
        WHERE archived = 1 AND COALESCE(archived_at, updated_at) <= ?
      `).run(cutoff);
    })();
    return verified;
  }

  get(id: string, includeArchived = false): PersonalizationDefinition | undefined {
    const row = this.#selectRow(id);
    if (!row || (!includeArchived && row.archived === 1)) return undefined;
    try {
      return this.#parseVerifiedRow(row);
    } catch {
      return undefined;
    }
  }

  getFactory(id: string): PersonalizationDefinition | undefined {
    const row = this.#selectRow(id);
    if (!row?.factory_json) return undefined;
    return parseDefinition(row.factory_json);
  }

  saveRunManifest(candidate: ResolvedRunManifest, integrityTag: string | null = null): ResolvedRunManifest {
    const manifest = ResolvedRunManifestSchema.parse(candidate);
    if (integrityTag !== null && !/^[a-f0-9]{64}$/u.test(integrityTag)) {
      throw new Error('Invalid run manifest integrity tag');
    }
    const raw = canonicalJson(manifest);
    this.#db.transaction(() => {
      this.#db.prepare(`
        UPDATE personalization_run_manifests SET active = 0
        WHERE session_id = ? AND active = 1
      `).run(manifest.sessionId);
      this.#db.prepare(`
        INSERT INTO personalization_run_manifests
          (manifest_digest, session_id, project_id, scenario_id, manifest_json, integrity_tag, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(manifest_digest) DO UPDATE SET
          -- Self-heal a tampered row: manifest_json must always match its own
          -- manifest_digest. Re-saving a re-resolved manifest with the same
          -- digest proves the stored JSON diverged (e.g. forged prompt with the
          -- original digest column untouched) -- rewriting the canonical JSON
          -- plus a fresh valid HMAC restores the row instead of laundering the
          -- tampered content under a new valid tag.
          manifest_json = excluded.manifest_json,
          active = 1,
          integrity_tag = excluded.integrity_tag
      `).run(
        manifest.manifestDigest,
        manifest.sessionId,
        manifest.projectId,
        manifest.scenarioId,
        raw,
        integrityTag,
        manifest.createdAt,
      );
    })();
    return manifest;
  }

  getActiveRunManifest(sessionId: string): ResolvedRunManifest | undefined {
    return this.getActiveRunManifestRecord(sessionId)?.manifest;
  }

  getActiveRunManifestRecord(sessionId: string): { manifest: ResolvedRunManifest; integrityTag: string | null } | undefined {
    const row = this.#db.prepare(`
      SELECT manifest_json, integrity_tag FROM personalization_run_manifests
      WHERE session_id = ? AND active = 1
      ORDER BY created_at DESC LIMIT 1
    `).get(sessionId) as { manifest_json: string; integrity_tag: string | null } | undefined;
    if (!row) return undefined;
    try {
      const manifest = ResolvedRunManifestSchema.parse(JSON.parse(row.manifest_json) as unknown);
      if (row.integrity_tag !== null && !/^[a-f0-9]{64}$/u.test(row.integrity_tag)) return undefined;
      return { manifest, integrityTag: row.integrity_tag };
    } catch {
      return undefined;
    }
  }

  listRunManifests(sessionId: string): ResolvedRunManifest[] {
    const rows = this.#db.prepare(`
      SELECT manifest_json FROM personalization_run_manifests
      WHERE session_id = ? ORDER BY created_at DESC, manifest_digest DESC
    `).all(sessionId) as Array<{ manifest_json: string }>;
    return rows.flatMap((row) => {
      try {
        const parsed = ResolvedRunManifestSchema.safeParse(JSON.parse(row.manifest_json) as unknown);
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  }

  /** 项目工作台进度条数据源：该项目最近一次场景运行的记录（任意状态）。 */
  latestScenarioRunForProject(projectId: string): ScenarioRunRecord | null {
    const row = this.#db.prepare(
      'SELECT record_json, integrity_tag FROM personalization_scenario_runs WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1',
    ).get(projectId) as { record_json: string; integrity_tag: string | null } | undefined;
    if (!row) return null;
    try {
      const record = ScenarioRunRecordSchema.parse(JSON.parse(row.record_json) as unknown);
      return verifiesScenarioRun(this.#scenarioRunIntegritySecret, record, row.integrity_tag) ? record : null;
    } catch {
      return null;
    }
  }

  saveScenarioRunRecord(candidate: ScenarioRunRecord): ScenarioRunRecord {
    if (!this.#scenarioRunIntegritySecret) throw new Error('Scenario run integrity key is unavailable');
    const record = ScenarioRunRecordSchema.parse(candidate);
    const raw = canonicalJson(record);
    const integrityTag = scenarioRunIntegrityTag(this.#scenarioRunIntegritySecret, record);
    this.#db.transaction(() => {
      const existing = this.#db.prepare(`
        SELECT manifest_digest, record_json, integrity_tag FROM personalization_scenario_runs WHERE run_id = ?
      `).get(record.runId) as { manifest_digest: string; record_json: string; integrity_tag: string | null } | undefined;
      if (existing && existing.manifest_digest !== record.manifestDigest) {
        throw new Error('Scenario run manifest binding cannot change');
      }
      if (existing) {
        const previous = ScenarioRunRecordSchema.parse(JSON.parse(existing.record_json) as unknown);
        if (!verifiesScenarioRun(this.#scenarioRunIntegritySecret, previous, existing.integrity_tag)) {
          throw new Error('Scenario run integrity verification failed');
        }
        assertRunProgression(previous, record);
      }
      this.#db.prepare(`
        INSERT INTO personalization_scenario_runs
          (run_id, session_id, project_id, scenario_id, manifest_digest, status, record_json, integrity_tag, started_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          status = excluded.status,
          record_json = excluded.record_json,
          integrity_tag = excluded.integrity_tag,
          updated_at = excluded.updated_at
      `).run(
        record.runId,
        record.manifestSnapshot.sessionId,
        record.manifestSnapshot.projectId,
        record.manifestSnapshot.scenarioId,
        record.manifestDigest,
        record.status,
        raw,
        integrityTag,
        record.startedAt,
        record.updatedAt,
      );
    })();
    return record;
  }

  getScenarioRunRecord(runId: string): ScenarioRunRecord | undefined {
    const row = this.#db.prepare(`
      SELECT record_json, integrity_tag FROM personalization_scenario_runs WHERE run_id = ?
    `).get(runId) as { record_json: string; integrity_tag: string | null } | undefined;
    if (!row) return undefined;
    try {
      const record = ScenarioRunRecordSchema.parse(JSON.parse(row.record_json) as unknown);
      return verifiesScenarioRun(this.#scenarioRunIntegritySecret, record, row.integrity_tag) ? record : undefined;
    } catch {
      return undefined;
    }
  }

  getRecoverableScenarioRun(sessionId: string): ScenarioRunRecord | undefined {
    // `paused` is part of the public recoverable surface: a paused run must be
    // resumable after restart, while `cancelled` stays terminal and excluded.
    // 同一会话可能堆积多条 non-terminal 记录（2026-08-30 刘总报告「继续后
    // 从头重跑」：digest 缺陷时期误开的新轮 0 步完成、updated_at 却更新，
    // 按"最新"挑选会 resume 一条空断点）。恢复必须选**进度最深**的记录
    //（完成步数最多；平局取最新）。
    const rows = this.#db.prepare(`
      SELECT record_json, integrity_tag FROM personalization_scenario_runs
      WHERE session_id = ? AND status IN ('running', 'interrupted', 'paused', 'failed')
      ORDER BY updated_at DESC
    `).all(sessionId) as Array<{ record_json: string; integrity_tag: string | null }>;
    let best: ScenarioRunRecord | undefined;
    let bestCompleted = -1;
    for (const row of rows) {
      try {
        const record = ScenarioRunRecordSchema.parse(JSON.parse(row.record_json) as unknown);
        if (!verifiesScenarioRun(this.#scenarioRunIntegritySecret, record, row.integrity_tag)) continue;
        const completed = record.steps.filter((step) => step.status === 'completed').length;
        if (completed > bestCompleted) {
          best = record;
          bestCompleted = completed;
        }
      } catch {
        continue;
      }
    }
    return bestCompleted >= 0 ? best : undefined;
  }

  /**
   * 同一会话只保留一条活跃 run（2026-08-30 刘总报告）：resume/start 时把
   * 其他 non-terminal 记录终止为 cancelled，防止多条断点竞争「继续」的
   * 恢复目标。被取代的记录保留历史可查，但不再作为恢复点。
   */
  supersedeOtherScenarioRuns(sessionId: string, keepRunId: string, scenarioId: string): number {
    const rows = this.#db.prepare(`
      SELECT run_id, record_json FROM personalization_scenario_runs
      WHERE session_id = ? AND status IN ('running', 'interrupted', 'paused', 'failed') AND run_id != ?
        AND scenario_id = ?
    `).all(sessionId, keepRunId, scenarioId) as Array<{ run_id: string; record_json: string }>;
    const update = this.#db.prepare(
      'UPDATE personalization_scenario_runs SET status = ?, record_json = ?, integrity_tag = ? WHERE run_id = ?',
    );
    let superseded = 0;
    for (const row of rows) {
      try {
        const record = ScenarioRunRecordSchema.parse(JSON.parse(row.record_json) as unknown);
        const terminated: ScenarioRunRecord = {
          ...record,
          status: 'cancelled',
          completedAt: record.completedAt ?? Date.now(),
        };
        update.run(
          'cancelled',
          canonicalJson(terminated),
          this.#scenarioRunIntegritySecret ? scenarioRunIntegrityTag(this.#scenarioRunIntegritySecret, terminated) : null,
          record.runId,
        );
        superseded += 1;
      } catch {
        // 单条取代失败不影响其余；该条最多作为无效断点被恢复选择忽略。
      }
    }
    return superseded;
  }

  /**
   * 一次性 digest 重签（2026-08-30 刘总报告「继续后从头重跑」）：旧算法把
   * 每次 resolve 的当前时间戳 createdAt 算进 manifestDigest，导致同一场景
   * 每次启动 digest 都不同、resume 判定永远失败。此方法用新算法（剔除
   * createdAt）重签所有非终态 run 记录并保持 integrity tag 一致，让历史
   * checkpoint 仍可恢复。幂等：digest 已是新值的记录原样跳过。
   */
  remintScenarioRunManifestDigests(): number {
    if (!this.#scenarioRunIntegritySecret) return 0;
    const rows = this.#db.prepare(`
      SELECT run_id, record_json, integrity_tag FROM personalization_scenario_runs
      WHERE status IN ('running', 'interrupted', 'paused')
    `).all() as Array<{ run_id: string; record_json: string; integrity_tag: string | null }>;
    const update = this.#db.prepare(
      'UPDATE personalization_scenario_runs SET manifest_digest = ?, record_json = ?, integrity_tag = ? WHERE run_id = ?',
    );
    let reminted = 0;
    for (const row of rows) {
      try {
        const record = ScenarioRunRecordSchema.parse(JSON.parse(row.record_json) as unknown);
        if (!verifiesScenarioRun(this.#scenarioRunIntegritySecret, record, row.integrity_tag)) continue;
        const newDigest = digestResolvedManifestSnapshot(record.manifestSnapshot);
        // 每个步骤的 executionKey = sha256(runId:manifestDigest:stepSnapshotDigest)，
        // 绑定的是记录级 manifestDigest——重签 digest 后必须同步重算，否则
        // 恢复校验「Step execution key mismatch」全部失配（2026-08-30 修复）。
        const executionKeysAligned = record.steps.every((step) => {
          const stepDigest = createHash('sha256').update(canonicalJson(step.stepSnapshot), 'utf8').digest('hex');
          return step.executionKey === createHash('sha256')
            .update(`${record.runId}:${newDigest}:${stepDigest}`, 'utf8')
            .digest('hex');
        });
        if (newDigest === record.manifestDigest && executionKeysAligned) continue;
        const remintedSteps = record.steps.map((step) => {
          const stepDigest = createHash('sha256').update(canonicalJson(step.stepSnapshot), 'utf8').digest('hex');
          return {
            ...step,
            executionKey: createHash('sha256')
              .update(`${record.runId}:${newDigest}:${stepDigest}`, 'utf8')
              .digest('hex'),
          };
        });
        const updated: ScenarioRunRecord = {
          ...record,
          manifestDigest: newDigest,
          manifestSnapshot: { ...record.manifestSnapshot, manifestDigest: newDigest },
          steps: remintedSteps,
        };
        update.run(newDigest, canonicalJson(updated), scenarioRunIntegrityTag(this.#scenarioRunIntegritySecret, updated), record.runId);
        reminted += 1;
      } catch {
        // 单条记录重签失败不影响其余记录；该条保持旧值（大不了重跑）。
      }
    }
    return reminted;
  }

  listScenarioRunRecords(sessionId: string): ScenarioRunRecord[] {
    const rows = this.#db.prepare(`
      SELECT record_json, integrity_tag FROM personalization_scenario_runs
      WHERE session_id = ? ORDER BY updated_at DESC
    `).all(sessionId) as Array<{ record_json: string; integrity_tag: string | null }>;
    return rows.flatMap((row) => {
      try {
        const parsed = ScenarioRunRecordSchema.safeParse(JSON.parse(row.record_json) as unknown);
        return parsed.success && verifiesScenarioRun(this.#scenarioRunIntegritySecret, parsed.data, row.integrity_tag)
          ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  }

  listCompletedScenarioRunRecords(query: ScenarioMemoryRecordQuery): ScenarioRunRecord[] {
    const clauses = ["status = 'completed'"];
    const parameters: Array<string | number> = [];
    if (query.sessionId) {
      clauses.push('session_id = ?');
      parameters.push(query.sessionId);
    }
    if (query.projectId) {
      clauses.push('project_id = ?');
      parameters.push(query.projectId);
    }
    if (query.scenarioId) {
      clauses.push('scenario_id = ?');
      parameters.push(query.scenarioId);
    }
    if (parameters.length === 0) return [];
    const limit = Math.max(1, Math.min(100, query.limit ?? 20));
    const rows = this.#db.prepare(`
      SELECT record_json, integrity_tag FROM personalization_scenario_runs
      WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ?
    `).all(...parameters, limit) as Array<{ record_json: string; integrity_tag: string | null }>;
    return rows.flatMap((row) => {
      try {
        const parsed = ScenarioRunRecordSchema.safeParse(JSON.parse(row.record_json) as unknown);
        return parsed.success && verifiesScenarioRun(this.#scenarioRunIntegritySecret, parsed.data, row.integrity_tag)
          ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
  }

  listVersions(id: string): PersonalizationVersionView[] {
    const rows = this.#db.prepare(`
      SELECT id, revision, content_digest, definition_json, created_at
      FROM personalization_versions WHERE id = ? ORDER BY revision DESC
    `).all(id) as Array<{
      id: string;
      revision: number;
      content_digest: string;
      definition_json: string;
      created_at: number;
    }>;
    return rows.flatMap((row) => {
      try {
        const definition = parseDefinition(row.definition_json);
        if (definition.id !== row.id || definition.revision !== row.revision
          || digestDefinition(definition) !== row.content_digest) return [];
        return [{
          id: row.id,
          revision: row.revision,
          contentDigest: row.content_digest,
          definition,
          createdAt: row.created_at,
        }];
      } catch { return []; }
    });
  }

  importDefinitionsAtomically(entries: ReadonlyArray<{
    definition: PersonalizationDefinition;
    assetBinding?: PersonalizationBundleAssetBinding;
  }>): void {
    if (entries.length === 0) throw new Error('Personalization import cannot be empty');
    const parsedEntries = entries.map((entry) => ({
      definition: PersonalizationDefinitionSchema.parse(entry.definition),
      assetBinding: entry.assetBinding === undefined
        ? undefined
        : PersonalizationBundleAssetBindingSchema.parse(entry.assetBinding),
    }));
    const ids = parsedEntries.map((entry) => entry.definition.id);
    if (new Set(ids).size !== ids.length) throw new Error('Personalization import contains duplicate IDs');
    if (parsedEntries.some((entry) => (
      entry.definition.id.startsWith('builtin:')
      || entry.definition.provenance.origin === 'builtin'
      || (entry.assetBinding && entry.assetBinding.ownerId !== entry.definition.id)
    ))) {
      throw new Error('Personalization import cannot overwrite factory definitions');
    }
    const incoming = new Set(ids);
    const dependencyLookup = this.#db.prepare(`
      SELECT archived FROM personalization_definitions WHERE id = ?
    `);

    this.#db.transaction(() => {
      for (const entry of parsedEntries) {
        if (this.#selectRow(entry.definition.id)) throw new Error('Personalization import target already exists');
        for (const dependencyId of dedupe(referencedDefinitionIds(entry.definition))) {
          if (incoming.has(dependencyId)) continue;
          const dependency = dependencyLookup.get(dependencyId) as { archived: number } | undefined;
          if (!dependency || dependency.archived === 1) {
            throw new Error(`Personalization import dependency is missing: ${dependencyId}`);
          }
        }
      }
      for (const entry of parsedEntries) {
        const definition = entry.definition;
        const raw = canonicalJson(definition);
        const digest = digestDefinition(definition);
        this.#db.prepare(`
          INSERT INTO personalization_definitions
            (id, kind, origin, current_revision, factory_json, current_json, archived, created_at, updated_at)
          VALUES (?, ?, ?, ?, NULL, ?, 0, ?, ?)
        `).run(
          definition.id,
          definition.kind,
          definition.provenance.origin,
          definition.revision,
          raw,
          definition.provenance.createdAt,
          definition.provenance.updatedAt,
        );
        this.#insertVersion(definition, digest);
        if (entry.assetBinding) {
          this.#db.prepare(`
            INSERT INTO personalization_asset_bindings
              (owner_id, directory_token, relative_root, created_at)
            VALUES (?, ?, ?, ?)
          `).run(
            definition.id,
            entry.assetBinding.directoryToken,
            entry.assetBinding.relativeRoot,
            Date.now(),
          );
        }
      }
    })();
  }

  getAssetBinding(ownerId: string): PersonalizationBundleAssetBinding | undefined {
    const row = this.#db.prepare(`
      SELECT owner_id, directory_token, relative_root
      FROM personalization_asset_bindings WHERE owner_id = ?
    `).get(ownerId) as { owner_id: string; directory_token: string; relative_root: string } | undefined;
    if (!row) return undefined;
    const parsed = PersonalizationBundleAssetBindingSchema.safeParse({
      ownerId: row.owner_id,
      directoryToken: row.directory_token,
      relativeRoot: row.relative_root,
    });
    return parsed.success ? parsed.data : undefined;
  }

  recordEvidenceEnvelope(candidate: EvidenceEnvelope): boolean {
    const envelope = EvidenceEnvelopeSchema.parse(candidate);
    const result = this.#db.prepare(`
      INSERT OR IGNORE INTO personalization_evidence_envelopes
        (envelope_id, session_id, project_id, manifest_digest, source_definition_id, envelope_json, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      envelope.envelopeId,
      envelope.sessionId,
      envelope.projectId,
      envelope.runManifestDigest,
      envelope.sourceDefinitionId,
      canonicalJson(envelope),
      envelope.observedAt,
    );
    return result.changes === 1;
  }

  /** Activation-only CAS: definition revision and signed evidence are one SQLite transaction. */
  commitMcpActivation(raw: unknown): boolean {
    const parsed = McpActivationPersistenceInputSchema.safeParse(raw);
    if (!parsed.success || !validMcpActivationTransition(parsed.data)) return false;
    const input = parsed.data;
    const previousRaw = canonicalJson(input.previousDefinition);
    const activatedRaw = canonicalJson(input.activatedDefinition);
    const envelopeRaw = canonicalJson(input.envelope);
    try {
      return this.#db.transaction(() => {
        const current = this.#selectRow(input.previousDefinition.id);
        if (!current || current.archived === 1 || current.origin !== input.previousDefinition.provenance.origin
          || current.current_revision !== input.previousDefinition.revision
          || current.current_json !== previousRaw
          || !stableEqual(this.#parseVerifiedRow(current), input.previousDefinition)) return false;
        const evidenceExists = this.#db.prepare(`
          SELECT 1 FROM personalization_evidence_envelopes WHERE envelope_id = ?
        `).get(input.envelope.envelopeId);
        if (evidenceExists) return false;
        const updated = this.#db.prepare(`
          UPDATE personalization_definitions
          SET current_revision = ?, current_json = ?, updated_at = ?
          WHERE id = ? AND current_revision = ? AND current_json = ? AND origin = ? AND archived = 0
        `).run(
          input.activatedDefinition.revision,
          activatedRaw,
          input.activatedDefinition.provenance.updatedAt,
          input.previousDefinition.id,
          input.previousDefinition.revision,
          previousRaw,
          input.previousDefinition.provenance.origin,
        );
        if (updated.changes !== 1) throw new Error('activation_cas_failed');
        this.#insertVersion(input.activatedDefinition, digestDefinition(input.activatedDefinition));
        this.#db.prepare(`
          INSERT INTO personalization_evidence_envelopes
            (envelope_id, session_id, project_id, manifest_digest, source_definition_id, envelope_json, observed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.envelope.envelopeId,
          input.envelope.sessionId,
          input.envelope.projectId,
          input.envelope.runManifestDigest,
          input.envelope.sourceDefinitionId,
          envelopeRaw,
          input.envelope.observedAt,
        );
        return true;
      })();
    } catch {
      return false;
    }
  }

  isMcpActivationCommitted(raw: unknown): boolean {
    const parsed = McpActivationPersistenceInputSchema.safeParse(raw);
    if (!parsed.success || !validMcpActivationTransition(parsed.data)) return false;
    try {
      const current = this.#selectRow(parsed.data.activatedDefinition.id);
      if (!current || current.archived === 1
        || !stableEqual(this.#parseVerifiedRow(current), parsed.data.activatedDefinition)) return false;
      const evidence = this.#db.prepare(`
        SELECT envelope_json FROM personalization_evidence_envelopes WHERE envelope_id = ?
      `).get(parsed.data.envelope.envelopeId) as { envelope_json: string } | undefined;
      return evidence?.envelope_json === canonicalJson(parsed.data.envelope);
    } catch {
      return false;
    }
  }

  /** Exact inverse used only when crash recovery finds DB committed but the file activation unavailable. */
  rollbackMcpActivation(raw: unknown): boolean {
    const parsed = McpActivationPersistenceInputSchema.safeParse(raw);
    if (!parsed.success || !validMcpActivationTransition(parsed.data)) return false;
    const input = parsed.data;
    const previousRaw = canonicalJson(input.previousDefinition);
    const activatedRaw = canonicalJson(input.activatedDefinition);
    const envelopeRaw = canonicalJson(input.envelope);
    try {
      return this.#db.transaction(() => {
        const current = this.#selectRow(input.activatedDefinition.id);
        const evidence = this.#db.prepare(`
          SELECT envelope_json FROM personalization_evidence_envelopes WHERE envelope_id = ?
        `).get(input.envelope.envelopeId) as { envelope_json: string } | undefined;
        if (!current || current.archived === 1 || current.current_revision !== input.activatedDefinition.revision
          || current.current_json !== activatedRaw
          || !stableEqual(this.#parseVerifiedRow(current), input.activatedDefinition)
          || evidence?.envelope_json !== envelopeRaw) return false;
        const restored = this.#db.prepare(`
          UPDATE personalization_definitions
          SET current_revision = ?, current_json = ?, updated_at = ?
          WHERE id = ? AND current_revision = ? AND current_json = ? AND origin = ? AND archived = 0
        `).run(
          input.previousDefinition.revision,
          previousRaw,
          input.previousDefinition.provenance.updatedAt,
          input.previousDefinition.id,
          input.activatedDefinition.revision,
          activatedRaw,
          input.previousDefinition.provenance.origin,
        );
        if (restored.changes !== 1) throw new Error('activation_rollback_cas_failed');
        const removedVersion = this.#db.prepare(`
          DELETE FROM personalization_versions WHERE id = ? AND revision = ? AND definition_json = ?
        `).run(input.activatedDefinition.id, input.activatedDefinition.revision, activatedRaw);
        const removedEvidence = this.#db.prepare(`
          DELETE FROM personalization_evidence_envelopes WHERE envelope_id = ? AND envelope_json = ?
        `).run(input.envelope.envelopeId, envelopeRaw);
        if (removedVersion.changes !== 1 || removedEvidence.changes !== 1) {
          throw new Error('activation_rollback_identity_mismatch');
        }
        return true;
      })();
    } catch {
      return false;
    }
  }

  listEvidenceEnvelopes(sessionId: string): EvidenceEnvelope[] {
    const rows = this.#db.prepare(`
      SELECT envelope_json FROM personalization_evidence_envelopes
      WHERE session_id = ? ORDER BY observed_at DESC, envelope_id ASC
    `).all(sessionId) as Array<{ envelope_json: string }>;
    return rows.flatMap((row) => {
      try {
        const parsed = EvidenceEnvelopeSchema.safeParse(JSON.parse(row.envelope_json) as unknown);
        return parsed.success ? [parsed.data] : [];
      } catch { return []; }
    });
  }

  save(request: PersonalizationSaveRequest): PersonalizationMutationResult {
    // 宽松净化写入（2026-08-29 刘总要求）：校验只用来净化、不用来拒绝。
    // 未知字段剔除后照常保存；只有运行必需字段出现真实类型错误才拒绝，
    // 并把具体字段带回给界面。
    const lenient = parsePersonalizationDefinitionLenient(request.definition as PersonalizationDefinition);
    if (!lenient.ok || request.contractVersion !== PERSONALIZATION_CONTRACT_VERSION) {
      return { ok: false, code: 'invalid_request', issues: lenient.ok ? undefined : lenient.issues };
    }
    const definition = lenient.definition;
    if (definition.provenance.origin === 'builtin' || definition.id.startsWith('builtin:')) {
      return { ok: false, code: 'factory_protected' };
    }

    const missing = this.#missingDependencies(definition);
    if (missing.length > 0) {
      return {
        ok: false,
        code: 'dependency_invalid',
        issues: missing.map((id) => `Missing personalization dependency: ${id}`),
      };
    }

    try {
      return this.#db.transaction((): PersonalizationMutationResult => {
        const current = this.#selectRow(definition.id);
        if (!current) {
          if (request.expectedRevision !== 0 || definition.revision !== 1) {
            return { ok: false, code: 'revision_conflict', currentRevision: 0 };
          }
          const raw = canonicalJson(definition);
          this.#db.prepare(`
            INSERT INTO personalization_definitions
              (id, kind, origin, current_revision, factory_json, current_json, archived, created_at, updated_at)
            VALUES (?, ?, ?, 1, NULL, ?, 0, ?, ?)
          `).run(
            definition.id,
            definition.kind,
            definition.provenance.origin,
            raw,
            definition.provenance.createdAt,
            definition.provenance.updatedAt,
          );
          this.#insertVersion(definition, digestDefinition(definition));
          return { ok: true, code: 'saved', definition };
        }
        if (current.origin === 'builtin') return { ok: false, code: 'factory_protected' };
        if (current.current_revision !== request.expectedRevision
          || definition.revision !== current.current_revision + 1) {
          return { ok: false, code: 'revision_conflict', currentRevision: current.current_revision };
        }
        const raw = canonicalJson(definition);
        const result = this.#db.prepare(`
          UPDATE personalization_definitions
          SET kind = ?, origin = ?, current_revision = ?, current_json = ?, archived = 0, archived_at = NULL,
              updated_at = ?
          WHERE id = ? AND current_revision = ? AND origin <> 'builtin'
        `).run(
          definition.kind,
          definition.provenance.origin,
          definition.revision,
          raw,
          definition.provenance.updatedAt,
          definition.id,
          request.expectedRevision,
        );
        if (result.changes !== 1) {
          const reread = this.#selectRow(definition.id);
          return { ok: false, code: 'revision_conflict', currentRevision: reread?.current_revision ?? 0 };
        }
        this.#insertVersion(definition, digestDefinition(definition));
        return { ok: true, code: 'saved', definition };
      })();
    } catch {
      return { ok: false, code: 'io_error' };
    }
  }

  /** Fail-closed reference query used before removing a managed MCP installation. */
  isMcpInstallationReferenced(installationId: string): boolean {
    if (!/^mcp_[a-f0-9]{32}$/u.test(installationId)) return true;
    const rows = this.#db.prepare(`
      SELECT * FROM personalization_definitions
    `).all() as DefinitionRow[];
    for (const row of rows) {
      let definition: PersonalizationDefinition;
      try { definition = this.#parseVerifiedRow(row); } catch { return true; }
      if (definition.kind === 'mcp'
        && (definition.args[0] === installationId
          || definition.workingDirectoryToken === installationId
          || definition.provenance.sourceRevision === installationId)) return true;
    }
    return false;
  }

  /** Exact inverse of the pending generated-MCP definition save. */
  rollbackGeneratedMcpPending(previousRaw: McpDefinition | null, pendingRaw: McpDefinition): boolean {
    const pending = McpDefinitionSchema.safeParse(pendingRaw);
    const previous = previousRaw === null ? null : McpDefinitionSchema.safeParse(previousRaw);
    if (!pending.success || (previous !== null && !previous.success)) return false;
    if (pending.data.sourceMode !== 'generated' || pending.data.provenance.origin !== 'generated'
      || pending.data.enabled || !pending.data.tags.includes('pending-probe')
      || pending.data.revision !== (previous?.data.revision ?? 0) + 1
      || (previous !== null && previous.data.id !== pending.data.id)) return false;
    const pendingJson = canonicalJson(pending.data);
    try {
      return this.#db.transaction(() => {
        const current = this.#selectRow(pending.data.id);
        if (!current || current.archived === 1 || current.origin !== 'generated'
          || current.current_revision !== pending.data.revision
          || current.current_json !== pendingJson
          || !stableEqual(this.#parseVerifiedRow(current), pending.data)) return false;
        if (previous === null) {
          const deletedVersion = this.#db.prepare(`
            DELETE FROM personalization_versions
            WHERE id = ? AND revision = ? AND definition_json = ?
          `).run(pending.data.id, pending.data.revision, pendingJson);
          const deletedDefinition = this.#db.prepare(`
            DELETE FROM personalization_definitions
            WHERE id = ? AND current_revision = ? AND current_json = ? AND origin = 'generated' AND archived = 0
          `).run(pending.data.id, pending.data.revision, pendingJson);
          if (deletedVersion.changes !== 1 || deletedDefinition.changes !== 1) {
            throw new Error('generated_pending_rollback_mismatch');
          }
          return true;
        }
        const previousJson = canonicalJson(previous.data);
        const restored = this.#db.prepare(`
          UPDATE personalization_definitions
          SET kind = ?, origin = ?, current_revision = ?, current_json = ?, updated_at = ?
          WHERE id = ? AND current_revision = ? AND current_json = ? AND origin = 'generated' AND archived = 0
        `).run(
          previous.data.kind,
          previous.data.provenance.origin,
          previous.data.revision,
          previousJson,
          previous.data.provenance.updatedAt,
          pending.data.id,
          pending.data.revision,
          pendingJson,
        );
        const deletedVersion = this.#db.prepare(`
          DELETE FROM personalization_versions
          WHERE id = ? AND revision = ? AND definition_json = ?
        `).run(pending.data.id, pending.data.revision, pendingJson);
        if (restored.changes !== 1 || deletedVersion.changes !== 1) {
          throw new Error('generated_pending_rollback_mismatch');
        }
        return true;
      })();
    } catch {
      return false;
    }
  }

  forkBuiltin(sourceId: string, targetId: string, author: string, now = Date.now()): PersonalizationMutationResult {
    const factory = this.getFactory(sourceId);
    if (!factory) return { ok: false, code: 'not_found' };
    const candidate = PersonalizationDefinitionSchema.safeParse({
      ...factory,
      id: targetId,
      revision: 1,
      provenance: {
        ...factory.provenance,
        origin: 'user',
        author,
        sourceUrl: null,
        sourceRevision: null,
        installedDigest: null,
        parentId: factory.id,
        parentVersion: factory.provenance.version,
        locallyModified: true,
        createdAt: now,
        updatedAt: now,
      },
    });
    if (!candidate.success) return { ok: false, code: 'invalid_request' };
    return this.save({
      contractVersion: PERSONALIZATION_CONTRACT_VERSION,
      definition: candidate.data,
      expectedRevision: 0,
    });
  }

  restoreVersion(id: string, sourceRevision: number, expectedRevision: number, now = Date.now()): PersonalizationMutationResult {
    const current = this.get(id, true);
    if (!current) return { ok: false, code: 'not_found' };
    if (current.provenance.origin === 'builtin') return { ok: false, code: 'factory_protected' };
    const source = this.listVersions(id).find((version) => version.revision === sourceRevision);
    if (!source) return { ok: false, code: 'not_found' };
    const candidate = PersonalizationDefinitionSchema.parse({
      ...source.definition,
      revision: expectedRevision + 1,
      provenance: {
        ...source.definition.provenance,
        locallyModified: true,
        updatedAt: now,
      },
    });
    return this.save({
      contractVersion: PERSONALIZATION_CONTRACT_VERSION,
      definition: candidate,
      expectedRevision,
    });
  }

  /**
   * Recovers a quarantined row only by publishing a new revision from an
   * already verified immutable version. The unverified current snapshot is
   * retained in a local quarantine table for forensic review; it is never
   * re-signed, parsed into the renderer, or made executable.
   */
  recoverIntegrityIssue(
    id: string,
    sourceRevision: number,
    expectedCurrentRevision: number,
    now = Date.now(),
  ): PersonalizationMutationResult {
    const current = this.#selectRow(id);
    if (!current || current.current_revision !== expectedCurrentRevision) {
      return { ok: false, code: 'revision_conflict', currentRevision: current?.current_revision ?? 1 };
    }
    const issue = this.#integrityIssueForRow(current);
    if (!issue) return { ok: false, code: 'invalid_request' };
    if (current.origin === 'builtin') return { ok: false, code: 'factory_protected' };
    const source = this.listVersions(id).find((version) => version.revision === sourceRevision);
    if (!source || source.definition.kind !== current.kind || source.definition.provenance.origin !== current.origin) {
      return { ok: false, code: 'not_found' };
    }
    const next = PersonalizationDefinitionSchema.parse({
      ...source.definition,
      revision: expectedCurrentRevision + 1,
      provenance: {
        ...source.definition.provenance,
        locallyModified: true,
        updatedAt: now,
      },
    });
    const raw = canonicalJson(next);
    try {
      return this.#db.transaction((): PersonalizationMutationResult => {
        const latest = this.#selectRow(id);
        if (!latest || latest.current_revision !== expectedCurrentRevision || !this.#integrityIssueForRow(latest)) {
          return { ok: false, code: 'revision_conflict', currentRevision: latest?.current_revision ?? 1 };
        }
        this.#db.prepare(`
          INSERT INTO personalization_definition_quarantine
            (id, quarantined_revision, current_json, issue_code, quarantined_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id, quarantined_revision) DO NOTHING
        `).run(id, latest.current_revision, latest.current_json, issue.code, now);
        const updated = this.#db.prepare(`
          UPDATE personalization_definitions
          SET kind = ?, origin = ?, current_revision = ?, current_json = ?, updated_at = ?
          WHERE id = ? AND current_revision = ? AND current_json = ? AND origin <> 'builtin'
        `).run(
          next.kind,
          next.provenance.origin,
          next.revision,
          raw,
          next.provenance.updatedAt,
          id,
          latest.current_revision,
          latest.current_json,
        );
        if (updated.changes !== 1) throw new Error('integrity_recovery_cas_failed');
        this.#insertVersion(next, digestDefinition(next));
        return { ok: true, code: 'saved', definition: next };
      })();
    } catch {
      return { ok: false, code: 'io_error' };
    }
  }

  archive(id: string, expectedRevision: number, now = Date.now()): PersonalizationMutationResult {
    const row = this.#selectRow(id);
    if (!row) return { ok: false, code: 'not_found' };
    if (row.origin === 'builtin') return { ok: false, code: 'factory_protected' };
    if (row.archived === 1) return { ok: false, code: 'not_found' };
    if (row.current_revision !== expectedRevision) {
      return { ok: false, code: 'revision_conflict', currentRevision: row.current_revision };
    }
    const result = this.#db.prepare(`
      UPDATE personalization_definitions SET archived = 1, archived_at = ?, updated_at = ?
      WHERE id = ? AND current_revision = ? AND origin <> 'builtin' AND archived = 0
    `).run(now, now, id, expectedRevision);
    return result.changes === 1
      ? { ok: true, code: 'deleted', id }
      : { ok: false, code: 'io_error' };
  }

  /**
   * Permanently removes a user- or url-installed definition together with its
   * full version history. Built-in rows stay factory-protected and generated
   * MCP pendings keep their dedicated rollback flow. Unlike {@link archive}
   * this is not recoverable, so it fails closed while any active definition
   * still references the target.
   */
  deletePermanent(id: string, expectedRevision: number): PersonalizationMutationResult {
    const row = this.#selectRow(id);
    if (!row) return { ok: false, code: 'not_found' };
    if (row.origin === 'builtin') return { ok: false, code: 'factory_protected' };
    if (row.origin === 'generated') return { ok: false, code: 'invalid_request' };
    if (row.current_revision !== expectedRevision) {
      return { ok: false, code: 'revision_conflict', currentRevision: row.current_revision };
    }
    const referencing: string[] = [];
    const activeRows = this.#db.prepare(
      'SELECT * FROM personalization_definitions WHERE archived = 0',
    ).all() as DefinitionRow[];
    for (const candidate of activeRows) {
      if (candidate.id === id) continue;
      let definition: PersonalizationDefinition;
      try { definition = this.#parseVerifiedRow(candidate); } catch {
        // A corrupted active row must never be silently bypassed by a delete.
        return { ok: false, code: 'io_error' };
      }
      if (referencedDefinitionIds(definition).includes(id)) referencing.push(`${definition.kind}:${definition.id}`);
    }
    if (referencing.length > 0) {
      return { ok: false, code: 'dependency_invalid', issues: referencing.slice(0, 128) };
    }
    try {
      return this.#db.transaction(() => {
        this.#db.prepare('DELETE FROM personalization_versions WHERE id = ?').run(id);
        const deleted = this.#db.prepare(`
          DELETE FROM personalization_definitions
          WHERE id = ? AND current_revision = ? AND origin NOT IN ('builtin', 'generated')
        `).run(id, expectedRevision);
        if (deleted.changes !== 1) throw new Error('permanent_delete_cas_mismatch');
        return { ok: true as const, code: 'deleted' as const, id };
      })();
    } catch {
      return { ok: false, code: 'io_error' };
    }
  }

  /** Restores a soft-deleted definition exactly as it was archived. */
  restoreArchived(id: string, expectedRevision: number, now = Date.now()): PersonalizationMutationResult {
    const row = this.#selectRow(id);
    if (!row || row.archived !== 1) return { ok: false, code: 'not_found' };
    if (row.origin === 'builtin') return { ok: false, code: 'factory_protected' };
    if (row.current_revision !== expectedRevision) {
      return { ok: false, code: 'revision_conflict', currentRevision: row.current_revision };
    }
    let definition: PersonalizationDefinition;
    try {
      definition = this.#parseVerifiedRow(row);
    } catch {
      return { ok: false, code: 'io_error' };
    }
    const result = this.#db.prepare(`
      UPDATE personalization_definitions SET archived = 0, archived_at = NULL, updated_at = ?
      WHERE id = ? AND current_revision = ? AND origin <> 'builtin' AND archived = 1
    `).run(now, id, expectedRevision);
    return result.changes === 1
      ? { ok: true, code: 'restored', definition }
      : { ok: false, code: 'io_error' };
  }

  #missingDependencies(definition: PersonalizationDefinition): string[] {
    const references = dedupe(referencedDefinitionIds(definition)).filter((id) => id !== definition.id);
    if (references.length === 0) return [];
    const lookup = this.#db.prepare('SELECT archived FROM personalization_definitions WHERE id = ?');
    return references.filter((id) => {
      const row = lookup.get(id) as { archived: number } | undefined;
      return !row || row.archived === 1;
    });
  }

  #selectRow(id: string): DefinitionRow | undefined {
    return this.#db.prepare('SELECT * FROM personalization_definitions WHERE id = ?').get(id) as DefinitionRow | undefined;
  }

  #integrityIssueForRow(row: DefinitionRow): DefinitionIntegrityIssue | undefined {
    let definition: PersonalizationDefinition;
    try {
      definition = parseDefinition(row.current_json);
    } catch {
      return {
        id: row.id,
        kind: row.kind,
        archived: row.archived === 1,
        currentRevision: row.current_revision,
        latestVerifiedRevision: this.#latestVerifiedRevision(row.id),
        code: 'current_definition_invalid',
      };
    }
    if (definition.id !== row.id
      || definition.kind !== row.kind
      || definition.provenance.origin !== row.origin
      || definition.revision !== row.current_revision) {
      return {
        id: row.id,
        kind: row.kind,
        archived: row.archived === 1,
        currentRevision: row.current_revision,
        latestVerifiedRevision: this.#latestVerifiedRevision(row.id),
        code: 'current_definition_identity_mismatch',
      };
    }
    const version = this.#db.prepare(`
      SELECT content_digest, definition_json FROM personalization_versions WHERE id = ? AND revision = ?
    `).get(row.id, row.current_revision) as { content_digest: string; definition_json: string } | undefined;
    if (!version) {
      return {
        id: row.id,
        kind: row.kind,
        archived: row.archived === 1,
        currentRevision: row.current_revision,
        latestVerifiedRevision: this.#latestVerifiedRevision(row.id),
        code: 'current_version_missing',
      };
    }
    let versionDefinition: PersonalizationDefinition;
    try {
      versionDefinition = parseDefinition(version.definition_json);
    } catch {
      return {
        id: row.id,
        kind: row.kind,
        archived: row.archived === 1,
        currentRevision: row.current_revision,
        latestVerifiedRevision: this.#latestVerifiedRevision(row.id),
        code: 'current_version_invalid',
      };
    }
    if (versionDefinition.id !== row.id
      || versionDefinition.revision !== row.current_revision
      || digestDefinition(versionDefinition) !== version.content_digest) {
      return {
        id: row.id,
        kind: row.kind,
        archived: row.archived === 1,
        currentRevision: row.current_revision,
        latestVerifiedRevision: this.#latestVerifiedRevision(row.id),
        code: 'current_version_content_mismatch',
      };
    }
    if (digestDefinition(definition) !== version.content_digest) {
      return {
        id: row.id,
        kind: row.kind,
        archived: row.archived === 1,
        currentRevision: row.current_revision,
        latestVerifiedRevision: this.#latestVerifiedRevision(row.id),
        code: 'current_digest_mismatch',
      };
    }
    return undefined;
  }

  #latestVerifiedRevision(id: string): number | null {
    const versions = this.listVersions(id);
    return versions[0]?.revision ?? null;
  }

  #parseVerifiedRow(row: DefinitionRow): PersonalizationDefinition {
    const issue = this.#integrityIssueForRow(row);
    if (issue) throw new Error(`Personalization definition integrity verification failed: ${issue.code}`);
    return parseDefinition(row.current_json);
  }

  #insertVersion(definition: PersonalizationDefinition, digest: string): void {
    this.#db.prepare(`
      INSERT INTO personalization_versions (id, revision, content_digest, definition_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      definition.id,
      definition.revision,
      digest,
      canonicalJson(definition),
      definition.provenance.updatedAt,
    );
  }
}
