import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  FundingTemplateDiffSchema,
  FundingTemplatePackageSchema,
  type FundingTemplateDiff,
  type FundingTemplatePackage,
} from '../engine/runtime/FundingTemplateContract.js';
import {
  canonicalizeFundingTemplateValue,
  computeFundingTemplatePackageDigest,
  diffFundingTemplatePackages,
  verifyFundingTemplatePackage,
} from '../engine/personalization/FundingTemplateAnalyzer.js';

const REPOSITORY_SCHEMA_VERSION = 1 as const;
const REPOSITORY_FORMAT = 'metis-funding-template-repository' as const;
const MAX_REPOSITORY_BYTES = 64 * 1024 * 1024;
const MAX_TEMPLATES = 2_000;
const MAX_VERSIONS_PER_TEMPLATE = 1_000;
const MAX_SAFE_REVISION = Number.MAX_SAFE_INTEGER - 1;
const SAFE_SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
// eslint-disable-next-line no-control-regex -- repository scopes reject every C0/C1 code point
const UNSAFE_SCOPE_TEXT = new RegExp('[\\x00-\\x1f\\x7f-\\x9f]', 'u');

const ScopeIdSchema = z.string().regex(SAFE_SCOPE_ID).refine((value) => !UNSAFE_SCOPE_TEXT.test(value));
const TimestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const DigestSchema = z.string().regex(DIGEST);

const FundingTemplateVersionRecordSchema = z.strictObject({
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  packageDigest: DigestSchema,
  sourceDigest: DigestSchema,
  observationDigest: DigestSchema,
  savedAt: TimestampSchema,
  template: FundingTemplatePackageSchema,
  diffFromPrevious: FundingTemplateDiffSchema.nullable(),
});

const FundingTemplateStoredRecordSchema = z.strictObject({
  ownerId: ScopeIdSchema,
  projectId: ScopeIdSchema,
  templateId: ScopeIdSchema,
  revision: z.number().int().positive().max(MAX_SAFE_REVISION),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  archivedAt: TimestampSchema.nullable(),
  activeVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  versions: z.array(FundingTemplateVersionRecordSchema).min(1).max(MAX_VERSIONS_PER_TEMPLATE),
}).superRefine((record, context) => {
  if (record.updatedAt < record.createdAt || (record.archivedAt !== null && record.archivedAt < record.createdAt)) {
    context.addIssue({ code: 'custom', message: 'Template timestamps are not monotonic' });
  }
  if (!record.versions.some((version) => version.version === record.activeVersion)) {
    context.addIssue({ code: 'custom', path: ['activeVersion'], message: 'Active version is not stored' });
  }
  for (let index = 0; index < record.versions.length; index += 1) {
    if (record.versions[index]?.version !== index + 1) {
      context.addIssue({ code: 'custom', path: ['versions', index, 'version'], message: 'Template versions must be contiguous' });
    }
  }
});

const FundingTemplateRepositoryStateSchema = z.strictObject({
  format: z.literal(REPOSITORY_FORMAT),
  schemaVersion: z.literal(REPOSITORY_SCHEMA_VERSION),
  revision: z.number().int().min(0).max(MAX_SAFE_REVISION),
  updatedAt: TimestampSchema,
  templates: z.array(FundingTemplateStoredRecordSchema).max(MAX_TEMPLATES),
  stateDigest: DigestSchema,
}).superRefine((state, context) => {
  const identities = state.templates.map((record) => `${record.ownerId}\0${record.projectId}\0${record.templateId}`);
  if (new Set(identities).size !== identities.length) {
    context.addIssue({ code: 'custom', path: ['templates'], message: 'Template identity must be unique within an owner and project' });
  }
});

const PointerSchema = z.strictObject({ slot: z.union([z.literal(0), z.literal(1)]) });

type RepositoryState = z.infer<typeof FundingTemplateRepositoryStateSchema>;
export type FundingTemplateStoredRecord = z.infer<typeof FundingTemplateStoredRecordSchema>;
export type FundingTemplateVersionRecord = z.infer<typeof FundingTemplateVersionRecordSchema>;

export interface FundingTemplateSaveVersionRequest {
  ownerId: string;
  projectId: string;
  template: FundingTemplatePackage;
  expectedTemplateRevision: number;
  expectedActiveVersion: number | null;
  expectedActiveDigest: string | null;
}

export interface FundingTemplateCASRequest {
  ownerId: string;
  projectId: string;
  templateId: string;
  expectedTemplateRevision: number;
  expectedActiveVersion: number;
  expectedActiveDigest: string;
}

export interface FundingTemplateActivateRequest extends FundingTemplateCASRequest {
  targetVersion: number;
}

export interface FundingTemplateListItem {
  ownerId: string;
  projectId: string;
  templateId: string;
  revision: number;
  activeVersion: number;
  activeDigest: string;
  latestVersion: number;
  archivedAt: number | null;
  updatedAt: number;
}

export type FundingTemplateRepositoryFailureCode =
  | 'invalid_request'
  | 'not_found'
  | 'already_exists'
  | 'archived'
  | 'cas_conflict'
  | 'version_conflict'
  | 'source_unchanged'
  | 'invalid_package'
  | 'sensitive_content'
  | 'repository_corrupt'
  | 'repository_busy'
  | 'io_error';

export type FundingTemplateRepositoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: FundingTemplateRepositoryFailureCode };

interface LoadedState {
  state: RepositoryState;
  slot: 0 | 1 | null;
}

interface SlotResult {
  status: 'absent' | 'valid' | 'invalid';
  state: RepositoryState | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function emptyState(): RepositoryState {
  const withoutDigest: Omit<RepositoryState, 'stateDigest'> = {
    format: REPOSITORY_FORMAT,
    schemaVersion: REPOSITORY_SCHEMA_VERSION,
    revision: 0,
    updatedAt: 0,
    templates: [],
  };
  return { ...withoutDigest, stateDigest: sha256(canonicalizeFundingTemplateValue(withoutDigest)) };
}

function computeStateDigest(state: RepositoryState): string {
  const { stateDigest: _stateDigest, ...withoutDigest } = state;
  void _stateDigest;
  return sha256(canonicalizeFundingTemplateValue(withoutDigest));
}

function verifyDiff(diff: FundingTemplateDiff): boolean {
  const { diffDigest, ...withoutDigest } = diff;
  return sha256(canonicalizeFundingTemplateValue(withoutDigest)) === diffDigest;
}

function hasSensitivePackageText(template: FundingTemplatePackage): boolean {
  const strings = [
    ...template.sections.map((section) => section.normalizedTitle),
    ...template.instructions.map((instruction) => instruction.normalizedText),
    ...template.tables.flatMap((table) => table.headers.map((header) => header.normalizedLabel)),
    ...template.contentSlots.map((slot) => slot.normalizedLabel),
    ...template.fieldMappings.map((mapping) => mapping.sourceLabel),
  ];
  return strings.some((value) => /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/iu.test(value)
    || /(?:^|\D)1[3-9]\d{9}(?:\D|$)/u.test(value)
    || /(?:^|\D)\d{17}[\dXx](?:\D|$)/u.test(value)
    || /(?:api[_ -]?key|secret|token)\s*[=:：]\s*[A-Za-z0-9_\-.]{12,}/iu.test(value));
}

function validateStoredRecord(record: FundingTemplateStoredRecord): boolean {
  for (let index = 0; index < record.versions.length; index += 1) {
    const version = record.versions[index];
    if (!version) return false;
    const verified = verifyFundingTemplatePackage(version.template);
    if (!verified.ok
      || version.template.templateId !== record.templateId
      || version.template.templateVersion !== version.version
      || version.packageDigest !== version.template.canonicalDigest
      || version.packageDigest !== computeFundingTemplatePackageDigest(version.template)
      || version.sourceDigest !== version.template.source.sourceDigest
      || version.observationDigest !== version.template.source.observationDigest
      || hasSensitivePackageText(version.template)) return false;
    if (index === 0) {
      if (version.diffFromPrevious !== null) return false;
    } else {
      const previous = record.versions[index - 1];
      if (!previous || version.diffFromPrevious === null || !verifyDiff(version.diffFromPrevious)) return false;
      if (version.diffFromPrevious.templateId !== record.templateId
        || version.diffFromPrevious.fromVersion !== previous.version
        || version.diffFromPrevious.toVersion !== version.version
        || version.diffFromPrevious.fromDigest !== previous.packageDigest
        || version.diffFromPrevious.toDigest !== version.packageDigest) return false;
    }
  }
  return true;
}

function validScope(value: string): boolean {
  return ScopeIdSchema.safeParse(value).success;
}

function activeVersion(record: FundingTemplateStoredRecord): FundingTemplateVersionRecord {
  const version = record.versions.find((candidate) => candidate.version === record.activeVersion);
  if (!version) throw new Error('Active version is missing');
  return version;
}

function requestMatchesRecord(
  record: FundingTemplateStoredRecord,
  expectedRevision: number,
  expectedVersion: number,
  expectedDigest: string,
): boolean {
  const active = activeVersion(record);
  return record.revision === expectedRevision
    && record.activeVersion === expectedVersion
    && active.packageDigest === expectedDigest;
}

export class FundingTemplateRepository {
  readonly repositoryRoot: string;
  private readonly trustedBase: string;
  private readonly slotPaths: [string, string];
  private readonly pointerPath: string;
  private readonly lockPath: string;
  private readonly now: () => number;

  constructor(trustedBase: string, options: { now?: () => number } = {}) {
    const baseStat = fs.lstatSync(trustedBase);
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error('Trusted base must be a real directory');
    this.trustedBase = fs.realpathSync(trustedBase);
    this.repositoryRoot = path.join(this.trustedBase, 'funding-templates');
    if (!fs.existsSync(this.repositoryRoot)) fs.mkdirSync(this.repositoryRoot, { mode: 0o700 });
    if (!this.verifyRoot()) throw new Error('Funding template repository root is unsafe');
    this.slotPaths = [
      path.join(this.repositoryRoot, 'repository.0.json'),
      path.join(this.repositoryRoot, 'repository.1.json'),
    ];
    this.pointerPath = path.join(this.repositoryRoot, '.repository.ptr.json');
    this.lockPath = path.join(this.repositoryRoot, '.repository.lock');
    this.now = options.now ?? Date.now;
  }

  private verifyRoot(): boolean {
    try {
      const stat = fs.lstatSync(this.repositoryRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      const real = fs.realpathSync(this.repositoryRoot);
      const relative = path.relative(this.trustedBase, real);
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    } catch {
      return false;
    }
  }

  private scanSlot(slot: 0 | 1): SlotResult {
    const filePath = this.slotPaths[slot];
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_REPOSITORY_BYTES) {
        return { status: 'invalid', state: null };
      }
      const raw = fs.readFileSync(filePath, 'utf8');
      const decoded = FundingTemplateRepositoryStateSchema.safeParse(JSON.parse(raw));
      if (!decoded.success || computeStateDigest(decoded.data) !== decoded.data.stateDigest) {
        return { status: 'invalid', state: null };
      }
      if (decoded.data.templates.some((record) => !validateStoredRecord(record))) {
        return { status: 'invalid', state: null };
      }
      return { status: 'valid', state: decoded.data };
    } catch (error) {
      const code = (error as { code?: string }).code;
      return code === 'ENOENT' ? { status: 'absent', state: null } : { status: 'invalid', state: null };
    }
  }

  private readPointer(): 0 | 1 | null | 'invalid' {
    try {
      const stat = fs.lstatSync(this.pointerPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128) return 'invalid';
      const parsed = PointerSchema.safeParse(JSON.parse(fs.readFileSync(this.pointerPath, 'utf8')));
      return parsed.success ? parsed.data.slot : 'invalid';
    } catch (error) {
      return (error as { code?: string }).code === 'ENOENT' ? null : 'invalid';
    }
  }

  private loadState(): FundingTemplateRepositoryResult<LoadedState> {
    if (!this.verifyRoot()) return { ok: false, code: 'repository_corrupt' };
    const pointer = this.readPointer();
    const slots: [SlotResult, SlotResult] = [this.scanSlot(0), this.scanSlot(1)];
    if (pointer === null) {
      if (slots.every((slot) => slot.status === 'absent')) return { ok: true, value: { state: emptyState(), slot: null } };
      return { ok: false, code: 'repository_corrupt' };
    }
    if (pointer === 'invalid') return { ok: false, code: 'repository_corrupt' };
    const selected = slots[pointer];
    if (selected.status !== 'valid' || selected.state === null) return { ok: false, code: 'repository_corrupt' };
    return { ok: true, value: { state: selected.state, slot: pointer } };
  }

  private acquireLock(): boolean {
    try {
      if (!this.verifyRoot()) return false;
      fs.writeFileSync(this.lockPath, String(process.pid), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  private releaseLock(): void {
    try { fs.unlinkSync(this.lockPath); } catch { /* best-effort lock cleanup */ }
  }

  private commit(previous: LoadedState, nextState: RepositoryState): FundingTemplateRepositoryResult<RepositoryState> {
    const inactive: 0 | 1 = previous.slot === 0 ? 1 : 0;
    const targetPath = this.slotPaths[inactive];
    const slotTemp = `${targetPath}.${randomUUID()}.tmp`;
    const pointerTemp = `${this.pointerPath}.${randomUUID()}.tmp`;
    try {
      if (!this.verifyRoot()) return { ok: false, code: 'repository_corrupt' };
      const serialized = `${canonicalizeFundingTemplateValue(nextState)}\n`;
      if (Buffer.byteLength(serialized, 'utf8') > MAX_REPOSITORY_BYTES) return { ok: false, code: 'io_error' };
      fs.writeFileSync(slotTemp, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      const slotFd = fs.openSync(slotTemp, 'r+');
      try { fs.fsyncSync(slotFd); } finally { fs.closeSync(slotFd); }
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
      fs.renameSync(slotTemp, targetPath);

      fs.writeFileSync(pointerTemp, canonicalizeFundingTemplateValue({ slot: inactive }), {
        encoding: 'utf8', flag: 'wx', mode: 0o600,
      });
      const pointerFd = fs.openSync(pointerTemp, 'r+');
      try { fs.fsyncSync(pointerFd); } finally { fs.closeSync(pointerFd); }
      fs.renameSync(pointerTemp, this.pointerPath);
      if (process.platform !== 'win32') {
        const directoryFd = fs.openSync(this.repositoryRoot, 'r');
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      }
      const reread = this.loadState();
      if (!reread.ok
        || reread.value.state.revision !== nextState.revision
        || reread.value.state.stateDigest !== nextState.stateDigest) {
        return { ok: false, code: 'repository_corrupt' };
      }
      return { ok: true, value: reread.value.state };
    } catch {
      try { if (fs.existsSync(slotTemp)) fs.unlinkSync(slotTemp); } catch { /* cleanup only */ }
      try { if (fs.existsSync(pointerTemp)) fs.unlinkSync(pointerTemp); } catch { /* cleanup only */ }
      return { ok: false, code: 'io_error' };
    }
  }

  private mutate(
    operation: (state: RepositoryState) => FundingTemplateRepositoryResult<RepositoryState>,
  ): FundingTemplateRepositoryResult<RepositoryState> {
    if (!this.acquireLock()) return { ok: false, code: 'repository_busy' };
    try {
      const loaded = this.loadState();
      if (!loaded.ok) return loaded;
      if (loaded.value.state.revision >= MAX_SAFE_REVISION) return { ok: false, code: 'io_error' };
      const changed = operation(clone(loaded.value.state));
      if (!changed.ok) return changed;
      const timestamp = this.now();
      const withoutDigest = {
        ...changed.value,
        revision: loaded.value.state.revision + 1,
        updatedAt: timestamp,
      };
      const nextState: RepositoryState = {
        ...withoutDigest,
        stateDigest: sha256(canonicalizeFundingTemplateValue({
          format: withoutDigest.format,
          schemaVersion: withoutDigest.schemaVersion,
          revision: withoutDigest.revision,
          updatedAt: withoutDigest.updatedAt,
          templates: withoutDigest.templates,
        })),
      };
      const parsed = FundingTemplateRepositoryStateSchema.safeParse(nextState);
      if (!parsed.success || parsed.data.templates.some((record) => !validateStoredRecord(record))) {
        return { ok: false, code: 'repository_corrupt' };
      }
      return this.commit(loaded.value, parsed.data);
    } finally {
      this.releaseLock();
    }
  }

  getTemplate(
    ownerId: string,
    projectId: string,
    templateId: string,
    includeArchived = false,
  ): FundingTemplateRepositoryResult<FundingTemplateStoredRecord> {
    if (![ownerId, projectId, templateId].every(validScope)) return { ok: false, code: 'invalid_request' };
    const loaded = this.loadState();
    if (!loaded.ok) return loaded;
    const record = loaded.value.state.templates.find((candidate) => candidate.ownerId === ownerId
      && candidate.projectId === projectId && candidate.templateId === templateId);
    if (!record || (!includeArchived && record.archivedAt !== null)) return { ok: false, code: 'not_found' };
    return { ok: true, value: clone(record) };
  }

  getActivePackage(
    ownerId: string,
    projectId: string,
    templateId: string,
  ): FundingTemplateRepositoryResult<FundingTemplatePackage> {
    const record = this.getTemplate(ownerId, projectId, templateId);
    return record.ok ? { ok: true, value: clone(activeVersion(record.value).template) } : record;
  }

  listTemplates(ownerId: string, projectId: string, includeArchived = false): FundingTemplateRepositoryResult<FundingTemplateListItem[]> {
    if (![ownerId, projectId].every(validScope)) return { ok: false, code: 'invalid_request' };
    const loaded = this.loadState();
    if (!loaded.ok) return loaded;
    const items = loaded.value.state.templates
      .filter((record) => record.ownerId === ownerId && record.projectId === projectId
        && (includeArchived || record.archivedAt === null))
      .map((record) => ({
        ownerId: record.ownerId,
        projectId: record.projectId,
        templateId: record.templateId,
        revision: record.revision,
        activeVersion: record.activeVersion,
        activeDigest: activeVersion(record).packageDigest,
        latestVersion: record.versions.length,
        archivedAt: record.archivedAt,
        updatedAt: record.updatedAt,
      }))
      .sort((left, right) => left.templateId.localeCompare(right.templateId));
    return { ok: true, value: items };
  }

  saveVersion(request: FundingTemplateSaveVersionRequest): FundingTemplateRepositoryResult<FundingTemplateStoredRecord> {
    if (![request.ownerId, request.projectId, request.template.templateId].every(validScope)
      || !Number.isSafeInteger(request.expectedTemplateRevision) || request.expectedTemplateRevision < 0
      || (request.expectedActiveVersion !== null && (!Number.isSafeInteger(request.expectedActiveVersion) || request.expectedActiveVersion <= 0))
      || (request.expectedActiveDigest !== null && !DIGEST.test(request.expectedActiveDigest))) {
      return { ok: false, code: 'invalid_request' };
    }
    const verified = verifyFundingTemplatePackage(request.template);
    if (!verified.ok || hasSensitivePackageText(request.template)) {
      return { ok: false, code: verified.ok ? 'sensitive_content' : 'invalid_package' };
    }
    let saved: FundingTemplateStoredRecord | null = null;
    const result = this.mutate((state) => {
      const index = state.templates.findIndex((record) => record.ownerId === request.ownerId
        && record.projectId === request.projectId && record.templateId === request.template.templateId);
      const timestamp = this.now();
      if (index < 0) {
        if (request.expectedTemplateRevision !== 0
          || request.expectedActiveVersion !== null
          || request.expectedActiveDigest !== null
          || request.template.templateVersion !== 1) return { ok: false, code: 'cas_conflict' };
        saved = {
          ownerId: request.ownerId,
          projectId: request.projectId,
          templateId: request.template.templateId,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          archivedAt: null,
          activeVersion: 1,
          versions: [{
            version: 1,
            packageDigest: request.template.canonicalDigest,
            sourceDigest: request.template.source.sourceDigest,
            observationDigest: request.template.source.observationDigest,
            savedAt: timestamp,
            template: clone(request.template),
            diffFromPrevious: null,
          }],
        };
        state.templates.push(saved);
        return { ok: true, value: state };
      }
      const current = state.templates[index];
      if (!current) return { ok: false, code: 'repository_corrupt' };
      if (current.archivedAt !== null) return { ok: false, code: 'archived' };
      if (request.expectedActiveVersion === null || request.expectedActiveDigest === null
        || !requestMatchesRecord(current, request.expectedTemplateRevision, request.expectedActiveVersion, request.expectedActiveDigest)) {
        return { ok: false, code: 'cas_conflict' };
      }
      const latest = current.versions[current.versions.length - 1];
      if (!latest) return { ok: false, code: 'repository_corrupt' };
      if (request.template.templateVersion !== latest.version + 1) return { ok: false, code: 'version_conflict' };
      if (request.template.source.sourceDigest === latest.sourceDigest) return { ok: false, code: 'source_unchanged' };
      let diff: FundingTemplateDiff;
      try { diff = diffFundingTemplatePackages(latest.template, request.template); }
      catch { return { ok: false, code: 'invalid_package' }; }
      const next: FundingTemplateStoredRecord = {
        ...current,
        revision: current.revision + 1,
        updatedAt: timestamp,
        activeVersion: request.template.templateVersion,
        versions: [...current.versions, {
          version: request.template.templateVersion,
          packageDigest: request.template.canonicalDigest,
          sourceDigest: request.template.source.sourceDigest,
          observationDigest: request.template.source.observationDigest,
          savedAt: timestamp,
          template: clone(request.template),
          diffFromPrevious: diff,
        }],
      };
      state.templates[index] = next;
      saved = next;
      return { ok: true, value: state };
    });
    if (!result.ok) return result;
    return saved ? { ok: true, value: clone(saved) } : { ok: false, code: 'repository_corrupt' };
  }

  activateVersion(request: FundingTemplateActivateRequest): FundingTemplateRepositoryResult<FundingTemplateStoredRecord> {
    return this.updateRecord(request, (record, timestamp) => {
      if (!record.versions.some((version) => version.version === request.targetVersion)) return { ok: false, code: 'version_conflict' };
      return { ok: true, value: { ...record, revision: record.revision + 1, updatedAt: timestamp, activeVersion: request.targetVersion } };
    });
  }

  archive(request: FundingTemplateCASRequest): FundingTemplateRepositoryResult<FundingTemplateStoredRecord> {
    return this.updateRecord(request, (record, timestamp) => {
      if (record.archivedAt !== null) return { ok: false, code: 'archived' };
      return { ok: true, value: { ...record, revision: record.revision + 1, updatedAt: timestamp, archivedAt: timestamp } };
    });
  }

  restore(request: FundingTemplateCASRequest): FundingTemplateRepositoryResult<FundingTemplateStoredRecord> {
    return this.updateRecord(request, (record, timestamp) => {
      if (record.archivedAt === null) return { ok: false, code: 'version_conflict' };
      return { ok: true, value: { ...record, revision: record.revision + 1, updatedAt: timestamp, archivedAt: null } };
    }, true);
  }

  private updateRecord(
    request: FundingTemplateCASRequest,
    update: (
      record: FundingTemplateStoredRecord,
      timestamp: number,
    ) => FundingTemplateRepositoryResult<FundingTemplateStoredRecord>,
    includeArchived = false,
  ): FundingTemplateRepositoryResult<FundingTemplateStoredRecord> {
    if (![request.ownerId, request.projectId, request.templateId].every(validScope)
      || !Number.isSafeInteger(request.expectedTemplateRevision) || request.expectedTemplateRevision <= 0
      || !Number.isSafeInteger(request.expectedActiveVersion) || request.expectedActiveVersion <= 0
      || !DIGEST.test(request.expectedActiveDigest)) return { ok: false, code: 'invalid_request' };
    let changed: FundingTemplateStoredRecord | null = null;
    const result = this.mutate((state) => {
      const index = state.templates.findIndex((record) => record.ownerId === request.ownerId
        && record.projectId === request.projectId && record.templateId === request.templateId);
      const current = state.templates[index];
      if (index < 0 || !current || (!includeArchived && current.archivedAt !== null)) return { ok: false, code: 'not_found' };
      if (!requestMatchesRecord(current, request.expectedTemplateRevision, request.expectedActiveVersion, request.expectedActiveDigest)) {
        return { ok: false, code: 'cas_conflict' };
      }
      const next = update(current, this.now());
      if (!next.ok) return next;
      state.templates[index] = next.value;
      changed = next.value;
      return { ok: true, value: state };
    });
    if (!result.ok) return result;
    return changed ? { ok: true, value: clone(changed) } : { ok: false, code: 'repository_corrupt' };
  }
}
