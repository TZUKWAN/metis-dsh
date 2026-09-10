import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  McpActivationEvidenceContextSchema,
  McpActivationRecoveryResultSchema,
  McpActivationRequestSchema,
  McpActivationResponseSchema,
  type McpActivationRecoveryResult,
  type McpActivationResponse,
} from '../engine/runtime/McpActivationContract.js';
import {
  McpInstalledRecordSchema,
  type McpInstalledRecord,
} from '../engine/runtime/McpInstallationContract.js';
import {
  McpDefinitionSchema,
  PERSONALIZATION_CONTRACT_VERSION,
  PERSONALIZATION_LIMITS,
  type McpDefinition,
  type PersonalizationMutationResult,
  type PersonalizationSaveRequest,
} from '../engine/runtime/PersonalizationRuntimeContract.js';
import type { PersonalizationMcpInstaller } from './PersonalizationMcpInstaller.js';

const JOURNAL_VERSION = 1 as const;
const JOURNAL_DIRECTORY = '.generated-activation-journal';
const JOURNAL_FILE = /^generated-([0-9a-fA-F-]{36})\.json$/u;
const TEMP_FILE = /^\.generated-[0-9a-fA-F-]{36}-[0-9a-fA-F-]{36}\.tmp$/u;
const JOURNAL_MAX_BYTES = 2 * 1024 * 1024;
const FALLBACK_OPERATION_ID = '00000000-0000-4000-8000-000000000000';

const GeneratedActivationInputSchema = z.strictObject({
  operationId: z.string().uuid(),
  expectedRevision: z.number().int().min(0).max(PERSONALIZATION_LIMITS.version),
  pendingDefinition: McpDefinitionSchema,
  installation: McpInstalledRecordSchema,
  evidenceContext: McpActivationEvidenceContextSchema,
}).superRefine((input, context) => {
  const definition = input.pendingDefinition;
  const installation = input.installation;
  if (input.operationId !== input.evidenceContext.operationId) {
    context.addIssue({ code: 'custom', path: ['operationId'], message: 'Operation identity mismatch' });
  }
  if (definition.sourceMode !== 'generated' || definition.provenance.origin !== 'generated'
    || !definition.id.startsWith('generated:mcp/') || definition.enabled
    || definition.revision !== input.expectedRevision + 1
    || !definition.tags.includes('pending-probe') || definition.tags.includes('probe-verified')
    || definition.exposedTools.length !== 0 || definition.sourceUrl !== null
    || definition.provenance.sourceUrl !== null
    || definition.args.length !== 1 || definition.args[0] !== installation.installationId
    || definition.workingDirectoryToken !== installation.installationId
    || definition.provenance.sourceRevision !== installation.installationId
    || definition.provenance.installedDigest !== installation.packageSha256
    || definition.name !== installation.packageId
    || definition.provenance.version !== installation.packageVersion) {
    context.addIssue({ code: 'custom', path: ['pendingDefinition'], message: 'Pending generated definition is not installation-bound' });
  }
  if (installation.enabled || installation.state !== 'static_verified'
    || installation.verifiedAt === null || installation.probedAt !== null
    || installation.exposedTools.length !== 0 || installation.failureCode !== null) {
    context.addIssue({ code: 'custom', path: ['installation'], message: 'Generated installation is not pending activation' });
  }
});

const GeneratedActivationJournalSchema = z.strictObject({
  journalVersion: z.literal(JOURNAL_VERSION),
  stage: z.enum(['prepared', 'definition_saved']),
  request: GeneratedActivationInputSchema,
  previousDefinition: McpDefinitionSchema.nullable(),
}).superRefine((journal, context) => {
  const previous = journal.previousDefinition;
  if (previous === null) {
    if (journal.request.expectedRevision !== 0) {
      context.addIssue({ code: 'custom', path: ['previousDefinition'], message: 'Missing prior revision' });
    }
    return;
  }
  if (previous.id !== journal.request.pendingDefinition.id
    || previous.revision !== journal.request.expectedRevision) {
    context.addIssue({ code: 'custom', path: ['previousDefinition'], message: 'Prior definition CAS mismatch' });
  }
});

type GeneratedActivationInput = z.infer<typeof GeneratedActivationInputSchema>;
type GeneratedActivationJournal = z.infer<typeof GeneratedActivationJournalSchema>;

export interface GeneratedMcpActivationStore {
  get(id: string, includeArchived?: boolean): unknown;
  save(request: PersonalizationSaveRequest): PersonalizationMutationResult;
  rollbackGeneratedMcpPending(previous: McpDefinition | null, pending: McpDefinition): boolean;
  isMcpInstallationReferenced(installationId: string): boolean;
}

export interface GeneratedMcpActivator {
  activate(raw: unknown): Promise<McpActivationResponse>;
  recoverPending(): Promise<McpActivationRecoveryResult>;
}

export type GeneratedMcpActivationCrashPoint =
  | 'after_prepared_before_definition'
  | 'after_definition_before_journal'
  | 'after_definition_journal_before_activation'
  | 'after_activation_before_cleanup';

export interface GeneratedMcpActivationFaultInjector {
  shouldCrash(point: GeneratedMcpActivationCrashPoint): boolean;
}

export class GeneratedMcpActivationCrashSimulation extends Error {
  readonly point: GeneratedMcpActivationCrashPoint;

  constructor(point: GeneratedMcpActivationCrashPoint) {
    super(`Simulated generated MCP activation crash at ${point}`);
    this.name = 'GeneratedMcpActivationCrashSimulation';
    this.point = point;
  }
}

export class GeneratedMcpActivationCoordinator {
  readonly #installer: PersonalizationMcpInstaller;
  readonly #store: GeneratedMcpActivationStore;
  readonly #activator: GeneratedMcpActivator;
  readonly #faultInjector: GeneratedMcpActivationFaultInjector | undefined;
  readonly #journalRoot: string;
  #exclusiveTail: Promise<void> = Promise.resolve();

  constructor(mcpRoot: string, dependencies: {
    installer: PersonalizationMcpInstaller;
    store: GeneratedMcpActivationStore;
    activator: GeneratedMcpActivator;
    faultInjector?: GeneratedMcpActivationFaultInjector;
  }) {
    this.#installer = dependencies.installer;
    this.#store = dependencies.store;
    this.#activator = dependencies.activator;
    this.#faultInjector = dependencies.faultInjector;
    this.#journalRoot = ensureJournalDirectory(mcpRoot);
  }

  activate(raw: unknown): Promise<McpActivationResponse> {
    return this.#exclusive(() => this.#activateUnlocked(raw));
  }

  recoverPending(): Promise<McpActivationRecoveryResult> {
    return this.#exclusive(() => this.#recoverPendingUnlocked());
  }

  async #activateUnlocked(raw: unknown): Promise<McpActivationResponse> {
    const operationId = extractOperationId(raw);
    const parsed = GeneratedActivationInputSchema.safeParse(raw);
    if (!parsed.success) return failure(operationId, 'invalid_request');
    const recovered = await this.#recoverPendingUnlocked();
    if (!recovered.ok) return failure(operationId, 'recovery_failed', false, true);
    const input = parsed.data;

    let previousRaw: unknown;
    try { previousRaw = this.#store.get(input.pendingDefinition.id, true); } catch {
      return failure(operationId, 'persistence_failed');
    }
    const previous = previousRaw === undefined ? null : McpDefinitionSchema.safeParse(previousRaw);
    if (input.expectedRevision === 0 ? previous !== null : previous === null || !previous.success
      || (previous !== null && previous.success && previous.data.revision !== input.expectedRevision)) {
      return failure(operationId, 'revision_conflict');
    }
    const journal = GeneratedActivationJournalSchema.parse({
      journalVersion: JOURNAL_VERSION,
      stage: 'prepared',
      request: input,
      previousDefinition: previous?.success ? previous.data : null,
    });
    try { this.#writeJournal(journal); } catch {
      return failure(operationId, 'persistence_failed');
    }
    this.#crashIfRequested('after_prepared_before_definition');

    let saved: PersonalizationMutationResult;
    try {
      saved = this.#store.save({
        contractVersion: PERSONALIZATION_CONTRACT_VERSION,
        definition: input.pendingDefinition,
        expectedRevision: input.expectedRevision,
      });
    } catch {
      return this.#compensatedFailure(journal, 'persistence_failed');
    }
    if (!saved.ok || saved.code !== 'saved' || !stableEqual(saved.definition, input.pendingDefinition)) {
      return this.#compensatedFailure(journal, 'persistence_failed');
    }
    this.#crashIfRequested('after_definition_before_journal');
    const savedJournal = GeneratedActivationJournalSchema.parse({ ...journal, stage: 'definition_saved' });
    try { this.#writeJournal(savedJournal); } catch {
      return failure(operationId, 'persistence_failed', false, true);
    }
    this.#crashIfRequested('after_definition_journal_before_activation');

    const activated = await this.#activator.activate(activationRequest(input));
    if (!activated.ok) return this.#compensatedFailure(savedJournal, activated.code);
    this.#crashIfRequested('after_activation_before_cleanup');
    if (!this.#deleteJournal(operationId)) {
      return failure(operationId, 'recovery_failed', false, true);
    }
    return activated;
  }

  async #recoverPendingUnlocked(): Promise<McpActivationRecoveryResult> {
    const inner = await this.#activator.recoverPending();
    if (!inner.ok) return inner;
    let journals: GeneratedActivationJournal[];
    try { journals = this.#readJournals(); } catch {
      return McpActivationRecoveryResultSchema.parse({
        ok: false, code: 'recovery_failed', recovered: inner.recovered, completed: inner.completed, pending: 1,
      });
    }
    let recovered = inner.recovered;
    let completed = inner.completed;
    let pending = 0;
    for (const journal of journals) {
      const outcome = await this.#recoverJournal(journal);
      if (outcome === 'recovered') recovered += 1;
      else if (outcome === 'completed') completed += 1;
      else pending += 1;
    }
    return pending === 0
      ? McpActivationRecoveryResultSchema.parse({ ok: true, recovered, completed })
      : McpActivationRecoveryResultSchema.parse({ ok: false, code: 'recovery_failed', recovered, completed, pending });
  }

  async #recoverJournal(journal: GeneratedActivationJournal): Promise<'recovered' | 'completed' | 'pending'> {
    let currentRaw: unknown;
    try { currentRaw = this.#store.get(journal.request.pendingDefinition.id, true); } catch { return 'pending'; }
    const current = currentRaw === undefined ? null : McpDefinitionSchema.safeParse(currentRaw);
    const record = this.#installer.readInstalledRecord(journal.request.installation.installationId);

    if (current?.success && completedBinding(current.data, record, journal.request)) {
      return this.#deleteJournal(journal.request.operationId) ? 'completed' : 'pending';
    }
    if (current?.success && stableEqual(current.data, journal.request.pendingDefinition)) {
      if (!record || record.enabled) return 'pending';
      const result = await this.#activator.activate(activationRequest(journal.request));
      if (result.ok) return this.#deleteJournal(journal.request.operationId) ? 'completed' : 'pending';
      return this.#compensate(journal) ? 'recovered' : 'pending';
    }
    const matchesPrevious = journal.previousDefinition === null
      ? current === null
      : current?.success === true && stableEqual(current.data, journal.previousDefinition);
    if (!matchesPrevious || record?.enabled) return 'pending';
    return this.#compensate(journal) ? 'recovered' : 'pending';
  }

  #compensatedFailure(
    journal: GeneratedActivationJournal,
    code: Extract<McpActivationResponse, { ok: false }>['code'],
  ): McpActivationResponse {
    return this.#compensate(journal)
      ? failure(journal.request.operationId, code, true, false)
      : failure(journal.request.operationId, 'compensation_failed', false, true);
  }

  #compensate(journal: GeneratedActivationJournal): boolean {
    let currentRaw: unknown;
    try { currentRaw = this.#store.get(journal.request.pendingDefinition.id, true); } catch { return false; }
    const current = currentRaw === undefined ? null : McpDefinitionSchema.safeParse(currentRaw);
    if (current?.success && stableEqual(current.data, journal.request.pendingDefinition)) {
      if (!this.#store.rollbackGeneratedMcpPending(journal.previousDefinition, journal.request.pendingDefinition)) return false;
    } else {
      const matchesPrevious = journal.previousDefinition === null
        ? current === null
        : current?.success === true && stableEqual(current.data, journal.previousDefinition);
      if (!matchesPrevious) return false;
    }
    const installationId = journal.request.installation.installationId;
    const record = this.#installer.readInstalledRecord(installationId);
    if (record?.enabled) return false;
    if (record && !this.#store.isMcpInstallationReferenced(installationId)
      && !this.#installer.removeUnactivatedInstallation(installationId)) return false;
    return this.#deleteJournal(journal.request.operationId);
  }

  #readJournals(): GeneratedActivationJournal[] {
    const journals: GeneratedActivationJournal[] = [];
    for (const entry of fs.readdirSync(this.#journalRoot, { withFileTypes: true })) {
      const target = containedJournalPath(this.#journalRoot, entry.name);
      if (entry.isSymbolicLink()) throw new Error('generated_journal_symlink');
      if (TEMP_FILE.test(entry.name)) {
        if (!entry.isFile()) throw new Error('generated_journal_temp_invalid');
        fs.unlinkSync(target);
        continue;
      }
      if (!JOURNAL_FILE.test(entry.name) || !entry.isFile()) throw new Error('generated_journal_entry_invalid');
      const parsed = GeneratedActivationJournalSchema.safeParse(JSON.parse(
        readStableFile(target, JOURNAL_MAX_BYTES).toString('utf8'),
      ) as unknown);
      if (!parsed.success || journalFileName(parsed.data.request.operationId) !== entry.name) {
        throw new Error('generated_journal_invalid');
      }
      journals.push(parsed.data);
    }
    fsyncDirectory(this.#journalRoot);
    return journals.sort((left, right) => left.request.operationId.localeCompare(right.request.operationId));
  }

  #writeJournal(journalRaw: unknown): void {
    const journal = GeneratedActivationJournalSchema.parse(journalRaw);
    const target = containedJournalPath(this.#journalRoot, journalFileName(journal.request.operationId));
    const temp = containedJournalPath(
      this.#journalRoot,
      `.generated-${journal.request.operationId}-${randomUUID()}.tmp`,
    );
    try {
      writeExclusiveAndSync(temp, Buffer.from(canonicalJson(journal), 'utf8'));
      fs.renameSync(temp, target);
      fsyncDirectory(this.#journalRoot);
    } finally {
      try { fs.unlinkSync(temp); } catch { /* atomically renamed or best-effort cleanup */ }
    }
  }

  #deleteJournal(operationId: string): boolean {
    try {
      const target = containedJournalPath(this.#journalRoot, journalFileName(operationId));
      if (fs.existsSync(target)) fs.unlinkSync(target);
      fsyncDirectory(this.#journalRoot);
      return !fs.existsSync(target);
    } catch {
      return false;
    }
  }

  #crashIfRequested(point: GeneratedMcpActivationCrashPoint): void {
    if (this.#faultInjector?.shouldCrash(point)) throw new GeneratedMcpActivationCrashSimulation(point);
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#exclusiveTail;
    let release = () => {};
    this.#exclusiveTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

function activationRequest(input: GeneratedActivationInput): unknown {
  return McpActivationRequestSchema.parse({
    contractVersion: 1,
    definitionId: input.pendingDefinition.id,
    installationId: input.installation.installationId,
    expectedRevision: input.pendingDefinition.revision,
    evidenceContext: input.evidenceContext,
  });
}

function completedBinding(
  definition: McpDefinition,
  record: McpInstalledRecord | null,
  request: GeneratedActivationInput,
): boolean {
  return Boolean(record?.enabled)
    && record?.state === 'enabled'
    && definition.id === request.pendingDefinition.id
    && definition.revision === request.pendingDefinition.revision + 1
    && definition.enabled
    && definition.sourceMode === 'generated'
    && definition.args[0] === record.installationId
    && definition.workingDirectoryToken === record.installationId
    && definition.provenance.sourceRevision === record.installationId
    && definition.provenance.installedDigest === record.packageSha256
    && stableEqual(definition.exposedTools, record.exposedTools)
    && definition.tags.includes('probe-verified')
    && !definition.tags.includes('pending-probe');
}

function extractOperationId(raw: unknown): string {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const operationId = (raw as Record<string, unknown>).operationId;
    if (typeof operationId === 'string' && z.string().uuid().safeParse(operationId).success) return operationId;
  }
  return FALLBACK_OPERATION_ID;
}

function failure(
  operationId: string,
  code: Extract<McpActivationResponse, { ok: false }>['code'],
  compensated = false,
  recoveryPending = false,
): McpActivationResponse {
  return McpActivationResponseSchema.parse({
    ok: false,
    contractVersion: 1,
    operationId,
    code,
    compensated,
    recoveryPending,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function stableEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function ensureJournalDirectory(mcpRoot: string): string {
  const root = fs.realpathSync.native(path.resolve(mcpRoot));
  const journalRoot = path.join(root, JOURNAL_DIRECTORY);
  if (!fs.existsSync(journalRoot)) fs.mkdirSync(journalRoot, { recursive: false, mode: 0o700 });
  const stat = fs.lstatSync(journalRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || !samePath(fs.realpathSync.native(journalRoot), journalRoot)) {
    throw new Error('Unsafe generated MCP activation journal');
  }
  return journalRoot;
}

function journalFileName(operationId: string): string {
  return `generated-${operationId}.json`;
}

function containedJournalPath(root: string, fileName: string): string {
  const target = path.resolve(root, fileName);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Generated activation journal path rejected');
  }
  return target;
}

function readStableFile(filePath: string, maxBytes: number): Buffer {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes
    || !samePath(fs.realpathSync.native(filePath), filePath)) {
    throw new Error('Generated activation journal identity mismatch');
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const before = fs.fstatSync(fd);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (!before.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || (process.platform !== 'win32' && (before.dev !== after.dev || before.ino !== after.ino))
      || bytes.length !== after.size) throw new Error('Generated activation journal changed while reading');
    return bytes;
  } finally { fs.closeSync(fd); }
}

function writeExclusiveAndSync(filePath: string, bytes: Uint8Array): void {
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function fsyncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLocaleLowerCase('en-US') === path.resolve(right).toLocaleLowerCase('en-US')
    : path.resolve(left) === path.resolve(right);
}
