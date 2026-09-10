import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  PERSONALIZATION_CONTRACT_VERSION,
  MetisRulesDefinitionSchema,
  PersonalizationDeleteRequestSchema,
  PersonalizationForkRequestSchema,
  PersonalizationGetRequestSchema,
  PersonalizationListRequestSchema,
  PersonalizationIntegrityListRequestSchema,
  PersonalizationIntegrityRecoverRequestSchema,
  PersonalizationTrashListRequestSchema,
  PersonalizationResolveRequestSchema,
  PersonalizationRestoreRequestSchema,
  PersonalizationTrashRestoreRequestSchema,
  PersonalizationVersionsRequestSchema,
  PersonalizationSaveRequestSchema,
  type PersonalizationGetResponse,
  type PersonalizationListResponse,
  type PersonalizationIntegrityListResponse,
  type PersonalizationTrashListResponse,
  type PersonalizationMutationResult,
  type PersonalizationDefinition,
  type MetisRulesDefinition,
  type PersonalizationResolveResponse,
  type ResolvedRunManifest,
} from '../engine/runtime/PersonalizationRuntimeContract.js';
import { PersonalizationRepository } from '../engine/personalization/PersonalizationRepository.js';
import {
  PersonalizationResolver,
  composeManifestSystemPrompt,
} from '../engine/personalization/PersonalizationResolver.js';
import type { PersonalizationDefinitionReader } from '../engine/personalization/PersonalizationResolver.js';

const AGENT_MANIFEST_INTEGRITY_DOMAIN = 'metis:personalization-run-manifest:v2\0';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function hasValidManifestDigests(manifest: ResolvedRunManifest): boolean {
  for (const layer of manifest.promptStack) {
    const digest = createHash('sha256').update(layer.content, 'utf8').digest('hex');
    if (digest !== layer.contentDigest) return false;
  }
  // 与 resolver/coordinator 同规：createdAt（每次 resolve 的当前时间戳）与
  // manifestDigest（自引用）都不参与 digest 计算，否则冻结快照永远校验失败。
  const { manifestDigest, createdAt: _createdAt, ...withoutDigest } = manifest;
  void manifestDigest;
  void _createdAt;
  const expected = createHash('sha256').update(canonicalJson(withoutDigest), 'utf8').digest('hex');
  return expected === manifest.manifestDigest;
}

function manifestIntegrityTag(secret: Buffer, manifest: ResolvedRunManifest): string {
  return createHmac('sha256', secret)
    .update(AGENT_MANIFEST_INTEGRITY_DOMAIN)
    .update(canonicalJson(manifest), 'utf8')
    .digest('hex');
}

function verifiesManifestIntegrity(secret: Buffer | null, manifest: ResolvedRunManifest, tag: string | null): boolean {
  if (!secret || !tag || !/^[a-f0-9]{64}$/u.test(tag) || !hasValidManifestDigests(manifest)) return false;
  const expected = Buffer.from(manifestIntegrityTag(secret, manifest), 'hex');
  const actual = Buffer.from(tag, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Renderer-authored content cannot impersonate an installer or MCP Builder. */
function isRendererAuthoredDefinition(definition: PersonalizationDefinition): boolean {
  if (!definition.id.startsWith('user:') || definition.provenance.origin !== 'user') return false;
  if (definition.kind === 'mcp') {
    // Market MCP installs are user-confirmed stdio configurations (user: id,
    // origin user). sourceUrl/sourceRevision only record where the command
    // came from; installer-owned definitions keep the url:/generated: prefix
    // and are already excluded by the id check above.
    return definition.sourceMode === 'generated'
      && definition.exposedTools.length === 0
      && definition.workingDirectoryToken === null;
  }
  if (definition.provenance.sourceUrl !== null
    || definition.provenance.sourceRevision !== null
    || definition.provenance.installedDigest !== null) return false;
  return definition.kind !== 'skill'
    || (definition.sourceMode === 'markdown' && definition.packageEntry === null);
}

class ProjectRuleOverlayReader implements PersonalizationDefinitionReader {
  readonly #base: PersonalizationRepository;
  readonly #rule: MetisRulesDefinition;

  constructor(base: PersonalizationRepository, rule: MetisRulesDefinition) {
    this.#base = base;
    this.#rule = rule;
  }

  get(id: string, includeArchived = false): PersonalizationDefinition | undefined {
    if (id === this.#rule.id) return this.#rule;
    return this.#base.get(id, includeArchived);
  }

  list(kind?: PersonalizationDefinition['kind'], includeDisabled = false): PersonalizationDefinition[] {
    const base = this.#base.list(kind, includeDisabled).filter((definition) => definition.id !== this.#rule.id);
    if ((kind === undefined || kind === 'rules') && (includeDisabled || this.#rule.enabled)) base.push(this.#rule);
    return base;
  }
}

function activeManifestMatchesProjectRule(
  manifest: ResolvedRunManifest,
  projectRulesId: string | undefined,
  projectRule: MetisRulesDefinition | undefined,
): boolean {
  const projectLayers = manifest.promptStack.filter((layer) => layer.sourceKind === 'rules' && layer.precedence === 500);
  if (!projectRulesId) return projectLayers.length === 0;
  if (!projectRule || projectRule.id !== projectRulesId || projectLayers.length !== 1) return false;
  const layer = projectLayers[0];
  return layer?.sourceId === projectRulesId
    && layer.content === projectRule.markdown
    && manifest.definitionRevisions[projectRulesId] === projectRule.revision;
}

export interface PersonalizationRuntimeServiceOptions {
  /**
   * Invoked with the verified definitions that just expired out of the
   * seven-day trash so the desktop layer can release matching installed
   * assets (skill packages). Cleanup failures must never break listing.
   */
  onPurgeExpired?: (definitions: PersonalizationDefinition[]) => void;
}

export class PersonalizationRuntimeService {
  readonly #repository: PersonalizationRepository;
  readonly #resolver: PersonalizationResolver;
  readonly #integritySecret: Buffer | null;
  readonly #onPurgeExpired?: (definitions: PersonalizationDefinition[]) => void;

  constructor(
    repository: PersonalizationRepository,
    integritySecret?: Buffer,
    options?: PersonalizationRuntimeServiceOptions,
  ) {
    this.#repository = repository;
    this.#resolver = new PersonalizationResolver(repository);
    this.#integritySecret = integritySecret && integritySecret.length >= 32 ? Buffer.from(integritySecret) : null;
    this.#onPurgeExpired = options?.onPurgeExpired;
  }

  list(raw: unknown): PersonalizationListResponse {
    const request = PersonalizationListRequestSchema.safeParse(raw);
    if (!request.success) return { ok: false, code: 'invalid_request' };
    // Retention is enforced by the persisted service, not by a renderer timer.
    // A restart after day seven therefore still removes expired trash entries.
    this.#applyRetention();
    return {
      ok: true,
      definitions: this.#repository.list(request.data.kind, request.data.includeDisabled),
    };
  }

  listTrash(raw: unknown): PersonalizationTrashListResponse {
    const request = PersonalizationTrashListRequestSchema.safeParse(raw);
    if (!request.success) return { ok: false, code: 'invalid_request' };
    this.#applyRetention();
    return {
      ok: true,
      definitions: this.#repository.listArchived(request.data.kind),
    };
  }

  #applyRetention(): void {
    const expired = this.#repository.purgeExpiredArchivedDefinitions();
    if (expired.length === 0 || !this.#onPurgeExpired) return;
    try {
      this.#onPurgeExpired(expired);
    } catch (cleanupError) {
      console.warn('[personalization] expired-trash asset cleanup failed', cleanupError);
    }
  }

  get(raw: unknown): PersonalizationGetResponse {
    const request = PersonalizationGetRequestSchema.safeParse(raw);
    if (!request.success) return { ok: true, definition: null };
    return { ok: true, definition: this.#repository.get(request.data.id) ?? null };
  }

  listIntegrityIssues(raw: unknown): PersonalizationIntegrityListResponse {
    const request = PersonalizationIntegrityListRequestSchema.safeParse(raw);
    if (!request.success) return { ok: false, code: 'invalid_request' };
    return { ok: true, issues: this.#repository.listIntegrityIssues(request.data.kind) };
  }

  recoverIntegrityIssue(raw: unknown): PersonalizationMutationResult {
    const request = PersonalizationIntegrityRecoverRequestSchema.safeParse(raw);
    if (!request.success) return { ok: false, code: 'invalid_request' };
    return this.#repository.recoverIntegrityIssue(
      request.data.id,
      request.data.sourceRevision,
      request.data.expectedCurrentRevision,
    );
  }

  save(raw: unknown): PersonalizationMutationResult {
    const request = PersonalizationSaveRequestSchema.safeParse(raw);
    if (!request.success) return { ok: false, code: 'invalid_request' };
    if (!isRendererAuthoredDefinition(request.data.definition)) {
      return { ok: false, code: 'invalid_request' };
    }
    return this.#repository.save(request.data);
  }

  archive(raw: unknown): PersonalizationMutationResult {
    const request = PersonalizationDeleteRequestSchema.safeParse(raw);
    if (!request.success) return { ok: false, code: 'invalid_request' };
    return this.#repository.archive(request.data.id, request.data.expectedRevision);
  }

  /**
   * Permanently deletes a non-factory definition together with its version
   * history. When `uninstallAssets` is provided (desktop wiring) it runs after
   * a successful commit so installed package assets do not outlive their
   * definition; cleanup is best-effort and never rolls the delete back.
   */
  deletePermanent(
    raw: unknown,
    uninstallAssets?: (definition: PersonalizationDefinition) => void,
  ): PersonalizationMutationResult {
    const request = PersonalizationDeleteRequestSchema.safeParse(raw);
    if (!request.success) return { ok: false, code: 'invalid_request' };
    const existing = this.#repository.get(request.data.id, true);
    if (!existing) return { ok: false, code: 'not_found' };
    const result = this.#repository.deletePermanent(request.data.id, request.data.expectedRevision);
    if (result.ok && uninstallAssets) {
      try { uninstallAssets(existing); } catch { /* cleanup failures are logged by the caller's wiring */ }
    }
    return result;
  }

  fork(raw: unknown): PersonalizationMutationResult {
    const request = PersonalizationForkRequestSchema.safeParse(raw);
    if (!request.success) return { ok: false, code: 'invalid_request' };
    return this.#repository.forkBuiltin(
      request.data.sourceId,
      request.data.targetId,
      request.data.author,
    );
  }

  restore(raw: unknown): PersonalizationMutationResult {
    const request = PersonalizationRestoreRequestSchema.safeParse(raw);
    if (!request.success) return { ok: false, code: 'invalid_request' };
    const current = this.#repository.get(request.data.id, true);
    const source = this.#repository.listVersions(request.data.id)
      .find((version) => version.revision === request.data.sourceRevision)?.definition;
    if (!current || !source
      || !isRendererAuthoredDefinition(current)
      || !isRendererAuthoredDefinition(source)) {
      return { ok: false, code: 'invalid_request' };
    }
    return this.#repository.restoreVersion(
      request.data.id,
      request.data.sourceRevision,
      request.data.expectedRevision,
    );
  }

  restoreFromTrash(raw: unknown): PersonalizationMutationResult {
    const request = PersonalizationTrashRestoreRequestSchema.safeParse(raw);
    if (!request.success) return { ok: false, code: 'invalid_request' };
    const current = this.#repository.get(request.data.id, true);
    // The trash covers every user- or url-installed definition. Factory rows
    // stay protected and generated MCP pendings keep their dedicated rollback
    // flow; restore itself never rewrites the archived content.
    if (!current) return { ok: false, code: 'not_found' };
    if (current.provenance.origin === 'builtin') return { ok: false, code: 'factory_protected' };
    if (current.provenance.origin !== 'user' && current.provenance.origin !== 'url') {
      return { ok: false, code: 'invalid_request' };
    }
    return this.#repository.restoreArchived(request.data.id, request.data.expectedRevision);
  }

  versions(raw: unknown) {
    const request = PersonalizationVersionsRequestSchema.safeParse(raw);
    if (!request.success) return { ok: true as const, versions: [] };
    return { ok: true as const, versions: this.#repository.listVersions(request.data.id) };
  }

  resolve(raw: unknown): PersonalizationResolveResponse {
    const request = PersonalizationResolveRequestSchema.safeParse(raw);
    if (!request.success) {
      return { ok: false, code: 'definition_corrupt', issues: ['Invalid resolve request'] };
    }
    if (!this.#integritySecret) {
      return { ok: false, code: 'definition_corrupt', issues: ['Scenario run integrity key is unavailable'] };
    }
    const result = this.#resolver.resolve(request.data);
    // Renderer-facing resolve is a preview only. Persisting it would let a
    // renderer pre-warm the main Agent cache with authored global/project
    // rules and later hide those definitions while retaining a valid HMAC'd
    // run manifest. Only resolveForAgent may create an active trusted snapshot.
    return result.ok
      ? { ok: true, manifest: result.manifest }
      : result;
  }

  resolveForAgent(raw: unknown, projectRule?: MetisRulesDefinition) {
    const request = PersonalizationResolveRequestSchema.safeParse(raw);
    if (!request.success || !this.#integritySecret) return undefined;
    const parsedProjectRule = projectRule === undefined
      ? undefined
      : MetisRulesDefinitionSchema.safeParse(projectRule);
    if (parsedProjectRule && !parsedProjectRule.success) return undefined;
    const storedProjectRule = request.data.projectRulesId && projectRule === undefined
      ? this.#repository.get(request.data.projectRulesId)
      : undefined;
    const authoritativeProjectRule = parsedProjectRule?.data
      ?? (storedProjectRule?.kind === 'rules' ? storedProjectRule : undefined);
    if ((projectRule !== undefined && request.data.projectRulesId === undefined)
      || (request.data.projectRulesId !== undefined && authoritativeProjectRule === undefined)
      || (authoritativeProjectRule && request.data.projectRulesId !== authoritativeProjectRule.id)) return undefined;
    if (authoritativeProjectRule && (
      !authoritativeProjectRule.enabled
      || authoritativeProjectRule.scope !== 'project'
      || authoritativeProjectRule.scopeId !== `user:projects/${request.data.projectId}`
    )) return undefined;
    const activeRecord = this.#repository.getActiveRunManifestRecord(request.data.sessionId);
    const active = activeRecord?.manifest;
    if (
      active
      && active.sessionId === request.data.sessionId
      && active.projectId === request.data.projectId
      && active.scenarioId === request.data.scenarioId
      && !(active.output.plan && active.workflow.length === 0 && !active.implicitOutputStep)
      && activeManifestMatchesProjectRule(active, request.data.projectRulesId, authoritativeProjectRule)
      && verifiesManifestIntegrity(this.#integritySecret, active, activeRecord.integrityTag)
    ) {
      return {
        ok: true as const,
        manifest: active,
        systemPrompt: composeManifestSystemPrompt(active),
      };
    }
    const resolver = authoritativeProjectRule
      ? new PersonalizationResolver(new ProjectRuleOverlayReader(this.#repository, authoritativeProjectRule))
      : this.#resolver;
    // A rejected active manifest must be replaced by a distinct durable row.
    // Date.now() alone can equal the old createdAt within the same millisecond;
    // that would reproduce the old digest and hit the repository's digest
    // conflict path, which intentionally does not overwrite manifest_json.
    const resolutionRequest = active
      ? { ...request.data, createdAt: Math.max(Date.now(), active.createdAt + 1) }
      : request.data;
    const result = resolver.resolve(resolutionRequest);
    if (!result.ok) {
      // 静默 undefined 会让上层只看到 personalization_resolution_failed，
      // 无法区分场景本身的问题；这里输出解析失败的具体原因。
      console.warn(`[PersonalizationRuntime] resolve failed for scenario=${request.data.scenarioId ?? 'null'}: ${JSON.stringify(result).slice(0, 400)}`);
      return undefined;
    }
    this.#saveRunManifest(result.manifest);
    return result;
  }

  #saveRunManifest(manifest: ResolvedRunManifest): ResolvedRunManifest {
    const tag = this.#integritySecret ? manifestIntegrityTag(this.#integritySecret, manifest) : null;
    return this.#repository.saveRunManifest(manifest, tag);
  }

  static emptyListRequest() {
    return { contractVersion: PERSONALIZATION_CONTRACT_VERSION, includeDisabled: false } as const;
  }
}
