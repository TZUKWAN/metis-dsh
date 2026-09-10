import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EvidenceEnvelopeSchema, type EvidenceEnvelope } from '../engine/runtime/EvidenceEnvelopeContract.js';
import {
  McpActivationEvidencePayloadSchema,
  McpActivationPersistenceInputSchema,
  McpActivationRecoveryResultSchema,
  McpActivationRequestSchema,
  McpActivationResponseSchema,
  type McpActivationPersistenceInput,
  type McpActivationRecoveryResult,
  type McpActivationRequest,
  type McpActivationResponse,
} from '../engine/runtime/McpActivationContract.js';
import { McpInstalledRecordSchema, type McpInstalledRecord } from '../engine/runtime/McpInstallationContract.js';
import { MANAGED_MCP_COMMAND } from '../engine/runtime/ManagedMcpRuntimeContract.js';
import {
  McpDefinitionSchema,
  PERSONALIZATION_CONTRACT_VERSION,
  type McpDefinition,
} from '../engine/runtime/PersonalizationRuntimeContract.js';
import type { PersonalizationEvidenceSigner } from './PersonalizationExtensionService.js';
import {
  PersonalizationMcpInstaller,
  mcpInstalledRecordDigest,
  type McpControlledProbeRequest,
  type McpControlledProbeRunner,
  type McpLaunchDescriptor,
} from './PersonalizationMcpInstaller.js';

const FALLBACK_OPERATION_ID = '00000000-0000-4000-8000-000000000000';
const JOURNAL_DIRECTORY = '.activation-journal';
const JOURNAL_VERSION = 1 as const;
const JOURNAL_MAX_BYTES = 2 * 1024 * 1024;
const SECRET_REF = /^\$\{secret:[A-Z_][A-Z0-9_]{0,127}\}$/u;
const JOURNAL_FILE = /^activation-([0-9a-fA-F-]{36})\.json$/u;
const TEMP_FILE = /^\.activation-[0-9a-fA-F-]{36}-[0-9a-fA-F-]{36}\.tmp$/u;

const ProbeRollbackSnapshotSchema = z.strictObject({
  installationId: z.string().regex(/^mcp_[a-f0-9]{32}$/u),
  record: McpInstalledRecordSchema,
  recordDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});

const ActivationJournalSchema = z.strictObject({
  journalVersion: z.literal(JOURNAL_VERSION),
  operationId: z.string().uuid(),
  stage: z.enum(['prepared', 'installation_enabled', 'persistence_committed']),
  request: McpActivationRequestSchema,
  snapshot: ProbeRollbackSnapshotSchema,
  previousDefinition: McpDefinitionSchema,
  installation: McpInstalledRecordSchema.nullable(),
  activatedDefinition: McpDefinitionSchema.nullable(),
  envelope: EvidenceEnvelopeSchema.nullable(),
}).superRefine((journal, context) => {
  const hasPersistence = journal.installation !== null
    && journal.activatedDefinition !== null && journal.envelope !== null;
  if ((journal.stage === 'prepared') === hasPersistence) {
    context.addIssue({ code: 'custom', message: 'Journal stage payload is inconsistent' });
  }
});

type ActivationJournal = z.infer<typeof ActivationJournalSchema>;

export interface PersonalizationMcpActivationStore {
  get(id: string, includeArchived?: boolean): unknown;
  commitMcpActivation(input: McpActivationPersistenceInput): boolean;
  isMcpActivationCommitted(input: McpActivationPersistenceInput): boolean;
  rollbackMcpActivation(input: McpActivationPersistenceInput): boolean;
}

export type McpActivationCrashPoint =
  | 'after_prepared_before_probe'
  | 'after_probe_before_journal'
  | 'after_installation_journal_before_persistence'
  | 'after_persistence_before_journal'
  | 'after_persistence_journal_before_cleanup';

/** Test-only abrupt-crash seam. Production must omit this dependency. */
export interface McpActivationFaultInjector {
  shouldCrash(point: McpActivationCrashPoint): boolean;
}

export class McpActivationCrashSimulation extends Error {
  readonly point: McpActivationCrashPoint;

  constructor(point: McpActivationCrashPoint) {
    super(`Simulated MCP activation crash at ${point}`);
    this.name = 'McpActivationCrashSimulation';
    this.point = point;
  }
}

export interface PersonalizationMcpActivationDependencies {
  installer: PersonalizationMcpInstaller;
  runner: McpControlledProbeRunner;
  store: PersonalizationMcpActivationStore;
  evidence: PersonalizationEvidenceSigner;
  now?: () => number;
  faultInjector?: McpActivationFaultInjector;
}

/**
 * Activates an already installed URL MCP across the file-backed installation
 * record and the SQLite definition/evidence transaction with crash recovery.
 */
export class PersonalizationMcpActivationService {
  readonly #installer: PersonalizationMcpInstaller;
  readonly #runner: McpControlledProbeRunner;
  readonly #store: PersonalizationMcpActivationStore;
  readonly #evidence: PersonalizationEvidenceSigner;
  readonly #now: () => number;
  readonly #faultInjector: McpActivationFaultInjector | undefined;
  readonly #journalRoot: string;
  #exclusiveTail: Promise<void> = Promise.resolve();

  constructor(mcpRoot: string, dependencies: PersonalizationMcpActivationDependencies) {
    this.#installer = dependencies.installer;
    this.#runner = dependencies.runner;
    this.#store = dependencies.store;
    this.#evidence = dependencies.evidence;
    this.#now = dependencies.now ?? Date.now;
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
    const parsed = McpActivationRequestSchema.safeParse(raw);
    if (!parsed.success) return activationFailure(operationId, 'invalid_request');
    const request = parsed.data;

    const recovery = await this.#recoverPendingUnlocked();
    if (!recovery.ok) return activationFailure(request.evidenceContext.operationId, 'recovery_failed', false, true);

    let currentRaw: unknown;
    try { currentRaw = this.#store.get(request.definitionId); } catch {
      return activationFailure(request.evidenceContext.operationId, 'definition_not_found');
    }
    if (currentRaw === undefined) return activationFailure(request.evidenceContext.operationId, 'definition_not_found');
    const current = McpDefinitionSchema.safeParse(currentRaw);
    if (!current.success) return activationFailure(request.evidenceContext.operationId, 'definition_rejected');
    if (current.data.revision !== request.expectedRevision) {
      return activationFailure(request.evidenceContext.operationId, 'revision_conflict');
    }

    const snapshot = this.#installer.captureProbeRollback(request.installationId);
    if (!snapshot || !validPendingBinding(current.data, request, snapshot.record)) {
      return activationFailure(request.evidenceContext.operationId, 'installation_unavailable');
    }
    const prepared: ActivationJournal = {
      journalVersion: JOURNAL_VERSION,
      operationId: request.evidenceContext.operationId,
      stage: 'prepared',
      request,
      snapshot,
      previousDefinition: current.data,
      installation: null,
      activatedDefinition: null,
      envelope: null,
    };
    try { this.#writeJournal(prepared); } catch {
      return activationFailure(request.evidenceContext.operationId, 'persistence_failed');
    }
    this.#crashIfRequested('after_prepared_before_probe');

    let probeResult;
    try {
      probeResult = await this.#installer.probeAndEnable(request.installationId, this.#listOnlyRunner());
    } catch {
      return this.#compensateFailure(prepared, 'probe_failed');
    }
    if (!probeResult.ok || !probeResult.record || !validEnabledTransition(snapshot.record, probeResult.record)) {
      const diskRecord = this.#installer.readInstalledRecord(request.installationId);
      if (diskRecord?.enabled) return this.#compensateFailure(prepared, 'probe_failed', diskRecord);
      const removed = this.#deleteJournal(prepared.operationId);
      return activationFailure(request.evidenceContext.operationId, 'probe_failed', false, !removed);
    }
    const installation = probeResult.record;
    this.#crashIfRequested('after_probe_before_journal');

    let descriptor: McpLaunchDescriptor | null;
    try { descriptor = this.#installer.getLaunchDescriptor(request.installationId); } catch { descriptor = null; }
    if (!descriptor || !validLaunchDescriptor(descriptor, installation)) {
      return this.#compensateFailure(prepared, 'launch_descriptor_unavailable', installation);
    }
    const activatedDefinition = buildActivatedDefinition(current.data, installation, descriptor, this.#now());
    if (!activatedDefinition) {
      return this.#compensateFailure(prepared, 'definition_rejected', installation);
    }
    const envelope = this.#issueEvidence(request, current.data, activatedDefinition, installation);
    if (!envelope) return this.#compensateFailure(prepared, 'evidence_unavailable', installation);

    const persistence = McpActivationPersistenceInputSchema.safeParse({
      previousDefinition: current.data,
      activatedDefinition,
      installation,
      envelope,
      owner: request.evidenceContext.owner,
    });
    if (!persistence.success) return this.#compensateFailure(prepared, 'persistence_failed', installation);

    const installationEnabled = ActivationJournalSchema.parse({
      ...prepared,
      stage: 'installation_enabled',
      installation,
      activatedDefinition,
      envelope,
    });
    try { this.#writeJournal(installationEnabled); } catch {
      return this.#compensateFailure(prepared, 'persistence_failed', installation);
    }
    this.#crashIfRequested('after_installation_journal_before_persistence');

    let committed = safeBoolean(() => this.#store.commitMcpActivation(persistence.data));
    if (!committed) {
      committed = safeBoolean(() => this.#store.isMcpActivationCommitted(persistence.data));
    }
    if (!committed) return this.#compensateFailure(installationEnabled, 'persistence_failed', installation);

    this.#crashIfRequested('after_persistence_before_journal');
    const committedJournal = ActivationJournalSchema.parse({ ...installationEnabled, stage: 'persistence_committed' });
    let committedJournalWritten = false;
    try { this.#writeJournal(committedJournal); committedJournalWritten = true; } catch { /* recovery proves the already atomic commit */ }
    if (committedJournalWritten) this.#crashIfRequested('after_persistence_journal_before_cleanup');
    try { this.#deleteJournal(request.evidenceContext.operationId); } catch { /* recovered on next startup/call */ }
    return McpActivationResponseSchema.parse({
      ok: true,
      contractVersion: 1,
      operationId: request.evidenceContext.operationId,
      definition: activatedDefinition,
      installation,
      evidence: envelope,
    });
  }

  async #recoverPendingUnlocked(): Promise<McpActivationRecoveryResult> {
    let journals: ActivationJournal[];
    try { journals = this.#readJournals(); } catch {
      return McpActivationRecoveryResultSchema.parse({ ok: false, code: 'recovery_failed', recovered: 0, completed: 0, pending: 1 });
    }
    let recovered = 0;
    let completed = 0;
    let pending = 0;
    for (const journal of journals) {
      const result = this.#recoverJournal(journal);
      if (result === 'recovered') recovered += 1;
      else if (result === 'completed') completed += 1;
      else pending += 1;
    }
    return pending === 0
      ? McpActivationRecoveryResultSchema.parse({ ok: true, recovered, completed })
      : McpActivationRecoveryResultSchema.parse({ ok: false, code: 'recovery_failed', recovered, completed, pending });
  }

  #recoverJournal(journal: ActivationJournal): 'recovered' | 'completed' | 'pending' {
    if (journal.snapshot.recordDigest !== mcpInstalledRecordDigest(journal.snapshot.record)) return 'pending';
    let definitionRaw: unknown;
    try { definitionRaw = this.#store.get(journal.previousDefinition.id, true); } catch { return 'pending'; }
    const definition = McpDefinitionSchema.safeParse(definitionRaw);
    if (!definition.success) return 'pending';
    const currentRecord = this.#installer.readInstalledRecord(journal.snapshot.installationId);

    if (journal.stage === 'prepared') {
      if (!currentRecord) return 'pending';
      if (!stableEqual(definition.data, journal.previousDefinition)) return 'pending';
      if (stableEqual(currentRecord, journal.snapshot.record) || !currentRecord.enabled) {
        return this.#deleteJournal(journal.operationId) ? 'completed' : 'pending';
      }
      if (!this.#installer.rollbackEnabledProbe(journal.snapshot, currentRecord)) return 'pending';
      return this.#deleteJournal(journal.operationId) ? 'recovered' : 'pending';
    }

    const persistence = persistenceFromJournal(journal);
    if (!persistence || !this.#verifyEnvelope(persistence.envelope)) return 'pending';
    const committed = safeBoolean(() => this.#store.isMcpActivationCommitted(persistence));
    if (committed) {
      if (currentRecord && stableEqual(currentRecord, persistence.installation)) {
        return this.#deleteJournal(journal.operationId) ? 'completed' : 'pending';
      }
      const rolledBack = safeBoolean(() => this.#store.rollbackMcpActivation(persistence));
      if (!rolledBack) return 'pending';
      if (!currentRecord) return 'pending';
      if (currentRecord.enabled && !this.#installer.rollbackEnabledProbe(journal.snapshot, currentRecord)) return 'pending';
      return this.#deleteJournal(journal.operationId) ? 'recovered' : 'pending';
    }

    if (!stableEqual(definition.data, journal.previousDefinition)) return 'pending';
    if (!currentRecord) return 'pending';
    if (stableEqual(currentRecord, journal.snapshot.record) || !currentRecord.enabled) {
      return this.#deleteJournal(journal.operationId) ? 'completed' : 'pending';
    }
    if (!this.#installer.rollbackEnabledProbe(journal.snapshot, currentRecord)) return 'pending';
    return this.#deleteJournal(journal.operationId) ? 'recovered' : 'pending';
  }

  #issueEvidence(
    request: McpActivationRequest,
    previous: McpDefinition,
    activated: McpDefinition,
    installation: McpInstalledRecord,
  ): EvidenceEnvelope | undefined {
    const payload = McpActivationEvidencePayloadSchema.parse({
      event: previous.sourceMode === 'generated'
        ? 'mcp_generated_activated'
        : previous.sourceMode === 'package' ? 'mcp_package_activated' : 'mcp_url_activated',
      definitionId: activated.id,
      installationId: installation.installationId,
      packageId: installation.packageId,
      packageVersion: installation.packageVersion,
      packageDigest: installation.packageSha256,
      manifestDigest: installation.manifestSha256,
      priorRevision: previous.revision,
      activatedRevision: activated.revision,
      exposedTools: installation.exposedTools,
      probeState: 'probe_verified',
      owner: request.evidenceContext.owner,
    });
    let issued: unknown;
    try {
      issued = this.#evidence.issue({
        contractVersion: PERSONALIZATION_CONTRACT_VERSION,
        sessionId: request.evidenceContext.sessionId,
        projectId: request.evidenceContext.projectId,
        operationId: request.evidenceContext.operationId,
        runManifestDigest: request.evidenceContext.runManifestDigest,
        sourceDefinitionId: activated.id,
        sourceDefinitionRevision: activated.revision,
        sourceKind: 'mcp',
        observedAt: request.evidenceContext.observedAt,
        sourceUrl: activated.sourceUrl,
        locator: null,
        payload: { kind: 'json', canonicalJson: canonicalJson(payload) },
      });
    } catch {
      return undefined;
    }
    const envelope = EvidenceEnvelopeSchema.safeParse(issued);
    return envelope.success && this.#verifyEnvelope(envelope.data) ? envelope.data : undefined;
  }

  #verifyEnvelope(envelope: EvidenceEnvelope): boolean {
    try { return this.#evidence.verify(envelope); } catch { return false; }
  }

  #listOnlyRunner(): McpControlledProbeRunner {
    return {
      probe: (request: McpControlledProbeRequest) => {
        if (Object.hasOwn(request as object, 'sampleCall')) {
          return Promise.resolve({ ok: false, code: 'probe_sample_forbidden' });
        }
        return this.#runner.probe(request);
      },
    };
  }

  #compensateFailure(
    journal: ActivationJournal,
    code: Extract<McpActivationResponse, { ok: false }>['code'],
    expectedEnabled?: McpInstalledRecord,
  ): McpActivationResponse {
    const current = this.#installer.readInstalledRecord(journal.snapshot.installationId);
    let compensated = Boolean(current && !current.enabled);
    if (current?.enabled) {
      compensated = this.#installer.rollbackEnabledProbe(journal.snapshot, expectedEnabled ?? current);
    }
    const deleted = compensated && this.#deleteJournal(journal.operationId);
    if (!compensated) return activationFailure(journal.operationId, 'compensation_failed', false, true);
    return activationFailure(journal.operationId, code, true, !deleted);
  }

  #readJournals(): ActivationJournal[] {
    const journals: ActivationJournal[] = [];
    for (const entry of fs.readdirSync(this.#journalRoot, { withFileTypes: true })) {
      const target = containedJournalPath(this.#journalRoot, entry.name);
      if (entry.isSymbolicLink()) throw new Error('activation_journal_symlink');
      if (TEMP_FILE.test(entry.name)) {
        if (!entry.isFile()) throw new Error('activation_journal_temp_invalid');
        fs.unlinkSync(target);
        continue;
      }
      if (!JOURNAL_FILE.test(entry.name) || !entry.isFile()) throw new Error('activation_journal_entry_invalid');
      const parsed = ActivationJournalSchema.safeParse(JSON.parse(readStableFile(target, JOURNAL_MAX_BYTES).toString('utf8')));
      if (!parsed.success || journalFileName(parsed.data.operationId) !== entry.name) {
        throw new Error('activation_journal_invalid');
      }
      journals.push(parsed.data);
    }
    fsyncDirectory(this.#journalRoot);
    return journals.sort((left, right) => left.operationId.localeCompare(right.operationId));
  }

  #writeJournal(journalRaw: unknown): void {
    const journal = ActivationJournalSchema.parse(journalRaw);
    const target = containedJournalPath(this.#journalRoot, journalFileName(journal.operationId));
    const temp = containedJournalPath(this.#journalRoot, `.activation-${journal.operationId}-${randomUUID()}.tmp`);
    try {
      writeExclusiveAndSync(temp, Buffer.from(canonicalJson(journal), 'utf8'));
      fs.renameSync(temp, target);
      fsyncDirectory(this.#journalRoot);
    } finally {
      try { fs.unlinkSync(temp); } catch { /* already renamed or cleaned during recovery */ }
    }
  }

  #deleteJournal(operationId: string): boolean {
    try {
      const target = containedJournalPath(this.#journalRoot, journalFileName(operationId));
      if (!fs.existsSync(target)) return true;
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      fs.unlinkSync(target);
      fsyncDirectory(this.#journalRoot);
      return !fs.existsSync(target);
    } catch {
      return false;
    }
  }

  #crashIfRequested(point: McpActivationCrashPoint): void {
    if (this.#faultInjector?.shouldCrash(point)) throw new McpActivationCrashSimulation(point);
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#exclusiveTail;
    let release = () => {};
    this.#exclusiveTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

function validPendingBinding(
  definition: McpDefinition,
  request: McpActivationRequest,
  record: McpInstalledRecord,
): boolean {
  const sourceMatches = (definition.sourceMode === 'url'
      && definition.provenance.origin === 'url'
      && definition.id.startsWith('url:mcp/')
      && definition.sourceUrl !== null
      && definition.sourceUrl === definition.provenance.sourceUrl)
    || (definition.sourceMode === 'generated'
      && definition.provenance.origin === 'generated'
      && definition.id.startsWith('generated:mcp/')
      && definition.sourceUrl === null
      && definition.provenance.sourceUrl === null)
    || (definition.sourceMode === 'package'
      && definition.provenance.origin === 'user'
      && definition.id.startsWith('user:mcp/')
      && definition.sourceUrl === null
      && definition.provenance.sourceUrl === null);
  return definition.id === request.definitionId
    && sourceMatches
    && !definition.enabled && definition.exposedTools.length === 0
    && definition.tags.includes('pending-probe') && !definition.tags.includes('probe-verified')
    && definition.command === MANAGED_MCP_COMMAND
    && definition.args.length === 1 && definition.args[0] === request.installationId
    && definition.workingDirectoryToken === request.installationId
    && definition.provenance.sourceRevision === request.installationId
    && definition.name === record.packageId
    && definition.provenance.version === record.packageVersion
    && definition.provenance.installedDigest === record.packageSha256
    && Object.keys(definition.environment).length === 0
    && !record.enabled && (record.state === 'static_verified' || record.state === 'probe_failed')
    && record.verifiedAt !== null && record.exposedTools.length === 0;
}

function validEnabledTransition(previous: McpInstalledRecord, enabled: McpInstalledRecord): boolean {
  return !previous.enabled && enabled.enabled && enabled.state === 'enabled'
    && enabled.probedAt !== null && enabled.failureCode === null && enabled.exposedTools.length > 0
    && previous.installationId === enabled.installationId
    && previous.packageId === enabled.packageId
    && previous.packageVersion === enabled.packageVersion
    && previous.manifestSha256 === enabled.manifestSha256
    && previous.packageSha256 === enabled.packageSha256
    && previous.installedAt === enabled.installedAt
    && previous.verifiedAt === enabled.verifiedAt;
}

function validLaunchDescriptor(descriptor: McpLaunchDescriptor, installation: McpInstalledRecord): boolean {
  if (descriptor.installationId !== installation.installationId
    || descriptor.shell !== false || descriptor.inheritParentEnvironment !== false
    || descriptor.tools.length !== installation.exposedTools.length
    || !descriptor.tools.every((tool, index) => tool.name === installation.exposedTools[index])) return false;
  return Object.entries(descriptor.secretRefs).every(([name, reference]) => (
    /^[A-Z_][A-Z0-9_]{0,127}$/u.test(name) && SECRET_REF.test(reference)
  ));
}

function buildActivatedDefinition(
  previous: McpDefinition,
  installation: McpInstalledRecord,
  descriptor: McpLaunchDescriptor,
  now: number,
): McpDefinition | undefined {
  const environment: McpDefinition['environment'] = {};
  for (const name of Object.keys(descriptor.secretRefs).sort()) environment[name] = { secret: true, value: null };
  const preservedTags = previous.tags.filter((tag) => tag !== 'pending-probe' && tag !== 'probe-verified');
  const parsed = McpDefinitionSchema.safeParse({
    ...previous,
    enabled: true,
    tags: [...preservedTags, 'probe-verified'],
    revision: previous.revision + 1,
    provenance: {
      ...previous.provenance,
      updatedAt: Math.max(previous.provenance.updatedAt + 1, now),
    },
    environment,
    exposedTools: [...installation.exposedTools],
  });
  return parsed.success ? parsed.data : undefined;
}

function persistenceFromJournal(journal: ActivationJournal): McpActivationPersistenceInput | undefined {
  const parsed = McpActivationPersistenceInputSchema.safeParse({
    previousDefinition: journal.previousDefinition,
    activatedDefinition: journal.activatedDefinition,
    installation: journal.installation,
    envelope: journal.envelope,
    owner: journal.request.evidenceContext.owner,
  });
  return parsed.success ? parsed.data : undefined;
}

function activationFailure(
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

function extractOperationId(raw: unknown): string {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const evidenceContext = (raw as Record<string, unknown>).evidenceContext;
    if (evidenceContext && typeof evidenceContext === 'object' && !Array.isArray(evidenceContext)) {
      const operationId = (evidenceContext as Record<string, unknown>).operationId;
      if (typeof operationId === 'string' && z.string().uuid().safeParse(operationId).success) return operationId;
    }
  }
  return FALLBACK_OPERATION_ID;
}

function ensureJournalDirectory(mcpRootInput: string): string {
  const mcpRoot = path.resolve(mcpRootInput);
  const rootStat = fs.lstatSync(mcpRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !samePath(fs.realpathSync.native(mcpRoot), mcpRoot)) {
    throw new Error('Unsafe MCP activation root');
  }
  const journalRoot = path.join(mcpRoot, JOURNAL_DIRECTORY);
  if (!fs.existsSync(journalRoot)) fs.mkdirSync(journalRoot, { recursive: false, mode: 0o700 });
  const stat = fs.lstatSync(journalRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync.native(journalRoot), journalRoot)) {
    throw new Error('Unsafe MCP activation journal');
  }
  return journalRoot;
}

function journalFileName(operationId: string): string {
  if (!z.string().uuid().safeParse(operationId).success) throw new Error('Invalid activation operation ID');
  return `activation-${operationId}.json`;
}

function containedJournalPath(root: string, name: string): string {
  const target = path.resolve(root, name);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Activation journal path rejected');
  return target;
}

function readStableFile(filePath: string, maxBytes: number): Buffer {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes || !samePath(fs.realpathSync.native(filePath), filePath)) {
    throw new Error('Activation journal identity mismatch');
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const before = fs.fstatSync(fd);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (!before.isFile() || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || (process.platform !== 'win32' && (before.dev !== after.dev || before.ino !== after.ino))
      || bytes.length !== after.size) throw new Error('Activation journal changed while reading');
    return bytes;
  } finally { fs.closeSync(fd); }
}

function writeExclusiveAndSync(filePath: string, bytes: Uint8Array): void {
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function fsyncDirectory(directory: string): void {
  try {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
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

function safeBoolean(operation: () => boolean): boolean {
  try { return operation(); } catch { return false; }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}
