import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  decryptProviderConfig,
  encryptProviderConfig,
  type ISecureStorage,
} from '../engine/core/SecureStorage.js';
import type { ProviderConfig } from '../engine/core/types.js';
import {
  probeCapabilities,
  type ProbeTransport,
  type ProbedCapabilities,
} from '../engine/setup/CapabilityProbe.js';
import {
  deriveAdaptiveStrategy,
  type AdaptiveStrategy,
} from '../engine/setup/AdaptiveStrategy.js';
import { recoverError } from '../engine/setup/ErrorRecovery.js';
import {
  SETUP_RUNTIME_CONTRACT_VERSION,
  SetupAdaptiveStrategySchema,
  SetupBaseUrlSchema,
  SetupCapabilitiesSchema,
  SetupCapabilityWarningSchema,
  SetupConfigVersionSchema,
  SetupInputSchema,
  SetupModelSchema,
  SetupProgressEventSchema,
  SetupRestoreResponseSchema,
  SetupSaveResponseSchema,
  SetupProbeResponseSchema,
  createSetupRecovery,
  decodeSetupAbortRequest,
  decodeSetupProbeRequest,
  decodeSetupRestoreRequest,
  decodeSetupSaveRequest,
  type SetupAbortResponse,
  type SetupAdaptiveStrategy,
  type SetupCapabilities,
  type SetupCapabilityWarning,
  type SetupErrorCode,
  type SetupInput,
  type SetupProbeResponse,
  type SetupProgressEvent,
  type SetupProgressPhase,
  type SetupRestoreResponse,
  type SetupSaveResponse,
} from '../engine/runtime/SetupRuntimeContract.js';
export interface SetupOwner {
  webContentsId: number;
  processId: number;
  routingId: number;
  generation: number;
}


const STORED_SETUP_SCHEMA_VERSION = 1 as const;
const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_BACKOFF_SECONDS = 1;
const DEFAULT_PROBE_TTL_MS = 5 * 60_000;
const MAX_PROBE_TTL_MS = 30 * 60_000;
const MAX_ENCRYPTED_KEY_CHARS = 65_536;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export interface ElectronSafeStoragePort {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(plainText: string): Buffer;
  decryptString(encryptedValue: Buffer): string;
}

/**
 * Persistent secret storage accepted by the first-run service. The marker is
 * intentionally narrower than ISecureStorage so the engine's in-memory test
 * fallback cannot accidentally be used for an on-disk provider configuration.
 */
export interface FirstRunSecureStorage extends ISecureStorage {
  readonly protection: 'os-protected';
}

export function createFirstRunSecureStorage(
  safeStorage: ElectronSafeStoragePort,
): FirstRunSecureStorage {
  const protectionAvailable = (): boolean => {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform !== 'linux') return true;
    const backend = safeStorage.getSelectedStorageBackend?.();
    return backend !== undefined && backend !== 'basic_text' && backend !== 'unknown';
  };
  return {
    protection: 'os-protected',
    isAvailable(): boolean {
      try {
        return protectionAvailable();
      } catch {
        return false;
      }
    },
    encrypt(plainText: string): string {
      if (!protectionAvailable()) {
        throw new Error('OS-protected storage is unavailable');
      }
      return safeStorage.encryptString(plainText).toString('base64');
    },
    decrypt(cipherText: string): string {
      if (!protectionAvailable()) {
        throw new Error('OS-protected storage is unavailable');
      }
      return safeStorage.decryptString(Buffer.from(cipherText, 'base64'));
    },
  };
}

export interface AbortableSetupProbeTransport extends ProbeTransport {
  abort?(operationId: string): void | Promise<void>;
}

export interface SetupRuntimeBuildContext {
  config: Readonly<ProviderConfig>;
  capabilities: Readonly<SetupCapabilities>;
  strategy: Readonly<SetupAdaptiveStrategy>;
  previousConfigVersion: number;
  nextConfigVersion: number;
  reason: 'save' | 'restore';
  signal: AbortSignal;
}

/**
 * A candidate runtime is isolated until commit. commitAndAbortPrevious must
 * atomically install the candidate generation, reject output tagged with an
 * older config version, and abort/drain requests and streams from that older
 * generation before it resolves. It must honor the build context AbortSignal
 * until the atomic commit boundary. If commit rejects, the previous generation
 * must remain selected. discard must release candidate-only resources.
 */
export interface PreparedSetupRuntime {
  commitAndAbortPrevious(): Promise<void>;
  discard(): Promise<void>;
}

export interface SetupRuntimeRebuildProtocol {
  prepare(context: SetupRuntimeBuildContext): Promise<PreparedSetupRuntime>;
}

export interface FirstRunSetupServiceOptions {
  configPath: string;
  secureStorage: FirstRunSecureStorage;
  probeTransport: AbortableSetupProbeTransport;
  runtimeRebuilder: SetupRuntimeRebuildProtocol;
  probeTtlMs?: number;
}

export type SetupProgressListener = (event: SetupProgressEvent) => void;

const EncryptedProviderConfigSchema = z.strictObject({
  baseUrl: SetupBaseUrlSchema,
  encryptedApiKey: z.string()
    .min(1)
    .max(MAX_ENCRYPTED_KEY_CHARS)
    .regex(BASE64_PATTERN),
  model: SetupModelSchema,
  timeout: z.number().int().min(1_000).max(600_000),
  maxRetries: z.number().int().min(0).max(16),
  retryBackoffSeconds: z.number().min(0).max(300),
});

const StoredConfiguredSetupSchema = z.strictObject({
  schemaVersion: z.literal(STORED_SETUP_SCHEMA_VERSION),
  state: z.literal('configured'),
  configVersion: SetupConfigVersionSchema.refine((value) => value > 0),
  provider: EncryptedProviderConfigSchema,
  capabilities: SetupCapabilitiesSchema,
  strategy: SetupAdaptiveStrategySchema,
  warnings: z.array(SetupCapabilityWarningSchema).max(8)
    .refine((value) => new Set(value).size === value.length),
  savedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const StoredNotConfiguredSetupSchema = z.strictObject({
  schemaVersion: z.literal(STORED_SETUP_SCHEMA_VERSION),
  state: z.literal('not_configured'),
  configVersion: z.literal(0),
});

const StoredSetupEnvelopeSchema = z.discriminatedUnion('state', [
  StoredConfiguredSetupSchema,
  StoredNotConfiguredSetupSchema,
]);

type StoredConfiguredSetup = z.infer<typeof StoredConfiguredSetupSchema>;
type StoredSetupEnvelope = z.infer<typeof StoredSetupEnvelopeSchema>;

interface ProbeReceipt {
  input: SetupInput;
  configVersion: number;
  capabilities: SetupCapabilities;
  strategy: SetupAdaptiveStrategy;
  warnings: SetupCapabilityWarning[];
  expiresAt: number;
  expirationTimer: ReturnType<typeof setTimeout>;
  /** IPC sender WebContents ID — binds receipt to originating renderer */
  owner: { webContentsId: number; processId: number; routingId: number; generation: number };
}

interface ActiveOperation {
  controller: AbortController;
  kind: 'probe' | 'save' | 'restore';
}

interface ProbeObservation {
  primaryStatus?: number;
  error?: unknown;
}

class SetupOperationAbortedError extends Error {
  constructor() {
    super('Setup operation aborted');
    this.name = 'SetupOperationAbortedError';
  }
}

class AtomicSetupConfigStore {
  constructor(private readonly configPath: string) {}

  async read(): Promise<string | null> {
    try {
      return await readFile(this.configPath, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async replace(serialized: string): Promise<void> {
    const directory = path.dirname(this.configPath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.configPath)}.${randomUUID()}.tmp`,
    );

    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(serialized, { encoding: 'utf8' });
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.configPath);
      await syncDirectoryBestEffort(directory);
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function unrefTimerBestEffort(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer !== 'object' || timer === null) return;
  const unref = Reflect.get(timer, 'unref');
  if (typeof unref === 'function') Reflect.apply(unref, timer, []);
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is not available on every supported Windows filesystem.
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

function parseStoredEnvelope(raw: string | null): StoredSetupEnvelope | undefined {
  if (raw === null) {
    return {
      schemaVersion: STORED_SETUP_SCHEMA_VERSION,
      state: 'not_configured',
      configVersion: 0,
    };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = StoredSetupEnvelopeSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function notConfiguredEnvelope(): StoredSetupEnvelope {
  return {
    schemaVersion: STORED_SETUP_SCHEMA_VERSION,
    state: 'not_configured',
    configVersion: 0,
  };
}

function serializeEnvelope(envelope: StoredSetupEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function storageAvailable(storage: FirstRunSecureStorage): boolean {
  try {
    return storage.protection === 'os-protected' && storage.isAvailable();
  } catch {
    return false;
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new SetupOperationAbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SetupOperationAbortedError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === 'string' ? error : 'unknown setup error';
}

function isTimeoutError(error: unknown): boolean {
  const text = safeErrorMessage(error);
  return /timeout|timed out|etimedout|aborterror|timeouterror/iu.test(text);
}

function isTlsError(error: unknown): boolean {
  const text = safeErrorMessage(error);
  return /tls|ssl|certificate|cert_|unable_to_verify|self.signed|hostname.*mismatch/iu.test(text);
}

function mapProbeFailure(
  observation: ProbeObservation,
  probed: ProbedCapabilities,
  signal: AbortSignal,
): SetupErrorCode {
  if (signal.aborted || observation.error instanceof SetupOperationAbortedError) {
    return 'setup_operation_aborted';
  }
  if (observation.primaryStatus === 401) return 'setup_probe_unauthorized';
  if (observation.primaryStatus === 403) return 'setup_probe_forbidden';
  if (observation.primaryStatus === 404) return 'setup_probe_model_not_found';
  if (observation.primaryStatus === 429) return 'setup_probe_rate_limited';
  if (observation.primaryStatus !== undefined && observation.primaryStatus >= 500) {
    return 'setup_probe_server_unavailable';
  }
  if (isTlsError(observation.error)) return 'setup_probe_tls_failed';
  if (isTimeoutError(observation.error)) return 'setup_probe_timeout';

  const recovered = recoverError(
    safeErrorMessage(observation.error ?? probed.failureReason),
    'provider_probe',
    observation.primaryStatus,
  );
  if (recovered.category === 'auth') return 'setup_probe_unauthorized';
  if (recovered.category === 'quota') return 'setup_probe_rate_limited';
  if (recovered.category === 'network') return 'setup_probe_network_unavailable';
  if (recovered.category === 'transient') return 'setup_probe_server_unavailable';
  if (recovered.category === 'not_supported' || probed.failureCode === 'model_not_found') {
    return 'setup_probe_model_not_found';
  }
  if (probed.failureCode === 'network') return 'setup_probe_network_unavailable';
  return 'setup_probe_response_unavailable';
}

function toSetupCapabilities(probed: ProbedCapabilities): SetupCapabilities | undefined {
  const maxContextTokens = Number.isInteger(probed.maxContextTokens)
    && (probed.maxContextTokens ?? 0) > 0
    ? probed.maxContextTokens
    : null;
  const candidate = {
    streaming: probed.streaming === true,
    nativeToolCalling: probed.nativeToolCalling === true,
    structuredOutput: probed.jsonOutput === true,
    maxContextTokens,
    multimodal: probed.multimodal === true,
  };
  const result = SetupCapabilitiesSchema.safeParse(candidate);
  return result.success ? result.data : undefined;
}

function toSetupStrategy(strategy: AdaptiveStrategy): SetupAdaptiveStrategy | undefined {
  if (strategy.tier === 'unusable') return undefined;
  const candidate = {
    tier: strategy.tier,
    maxTurnsPerStep: strategy.maxTurnsPerStep,
    maxToolsPerTurn: strategy.maxToolsPerTurn,
    maxRetries: strategy.maxRetries,
    reviewEveryNTurns: strategy.reviewEveryNTurns,
    forceStructuredOutput: strategy.forceStructuredOutput,
    contextBudgetTokens: strategy.contextBudgetTokens,
    maxOutputTokens: strategy.maxOutputTokens,
    nativeToolCalling: strategy.nativeToolCalling,
  };
  const result = SetupAdaptiveStrategySchema.safeParse(candidate);
  return result.success ? result.data : undefined;
}

function capabilityWarnings(capabilities: SetupCapabilities): SetupCapabilityWarning[] {
  const warnings: SetupCapabilityWarning[] = [];
  if (!capabilities.nativeToolCalling) warnings.push('setup_native_tools_unavailable');
  if (!capabilities.streaming) warnings.push('setup_streaming_unavailable');
  if (!capabilities.structuredOutput) warnings.push('setup_structured_output_unavailable');
  if (capabilities.maxContextTokens === null) warnings.push('setup_context_length_unknown');
  return warnings;
}

function publicConfig(input: SetupInput) {
  return {
    baseUrl: input.baseUrl,
    model: input.model,
    apiKeyStored: true as const,
  };
}

function responseOperationId(operationId: string): string {
  return operationId;
}

export class FirstRunSetupService {
  private readonly store: AtomicSetupConfigStore;
  private readonly secureStorage: FirstRunSecureStorage;
  private readonly probeTransport: AbortableSetupProbeTransport;
  private readonly runtimeRebuilder: SetupRuntimeRebuildProtocol;
  private readonly probeTtlMs: number;
  private readonly probeReceipts = new Map<string, ProbeReceipt>();
  private readonly activeOperations = new Map<string, ActiveOperation>();

  revokeWebContents(webContentsId: number): void {
    for (const [operationId, receipt] of this.probeReceipts) {
      if (receipt.owner.webContentsId === webContentsId) {
        clearTimeout(receipt.expirationTimer);
        this.probeReceipts.delete(operationId);
      }
    }
  }

  private mutationTail: Promise<void> = Promise.resolve();
  private currentConfigVersion: number | undefined;
  private activeRuntimeConfigVersion = 0;

  constructor(options: FirstRunSetupServiceOptions) {
    if (!path.isAbsolute(options.configPath)) {
      throw new Error('First-run configuration path must be absolute');
    }
    if (options.secureStorage.protection !== 'os-protected') {
      throw new Error('First-run setup requires OS-protected secure storage');
    }
    this.store = new AtomicSetupConfigStore(options.configPath);
    this.secureStorage = options.secureStorage;
    this.probeTransport = options.probeTransport;
    this.runtimeRebuilder = options.runtimeRebuilder;
    const requestedProbeTtl = options.probeTtlMs ?? DEFAULT_PROBE_TTL_MS;
    this.probeTtlMs = Number.isFinite(requestedProbeTtl)
      ? Math.min(MAX_PROBE_TTL_MS, Math.max(30_000, requestedProbeTtl))
      : DEFAULT_PROBE_TTL_MS;
  }

  async probe(
    input: unknown,
    options: { owner: SetupOwner },
    onProgress?: SetupProgressListener,
  ): Promise<SetupProbeResponse> {
    const decoded = decodeSetupProbeRequest(input);
    if (!decoded.ok) {
      return this.probeFailure('setup-recovery', decoded.recovery.code);
    }
    const request = decoded.value;
    const operation = this.beginOperation(request.operationId, 'probe');
    const observation: ProbeObservation = {};

    try {
      this.emitProgress(onProgress, request.operationId, 'validating_input', 5);
      const configVersion = await this.readCurrentConfigVersion();
      this.assertNotAborted(operation.controller.signal);

      const transport = this.progressTransport(
        request.operationId,
        operation.controller.signal,
        observation,
        onProgress,
      );
      const probed = await probeCapabilities(
        request.input.baseUrl,
        request.input.apiKey,
        request.input.model,
        transport,
      );
      if (!probed.reachable) {
        return this.probeFailure(
          request.operationId,
          mapProbeFailure(observation, probed, operation.controller.signal),
        );
      }
      this.assertNotAborted(operation.controller.signal);

      const capabilities = toSetupCapabilities(probed);
      const strategy = toSetupStrategy(deriveAdaptiveStrategy(probed));
      if (!capabilities || !strategy) {
        return this.probeFailure(request.operationId, 'setup_probe_response_unavailable');
      }

      const warnings = capabilityWarnings(capabilities);
      const probeId = randomUUID();
      this.pruneProbeReceipts();
      const expirationTimer = setTimeout(() => {
        this.deleteProbeReceipt(probeId);
      }, this.probeTtlMs);
      unrefTimerBestEffort(expirationTimer);
      this.probeReceipts.set(probeId, {
        input: request.input,
        configVersion,
        capabilities,
        strategy,
        warnings,
        expiresAt: Date.now() + this.probeTtlMs,
        expirationTimer,
        owner: options.owner,
      });

      return this.validateProbeResponse({
        version: SETUP_RUNTIME_CONTRACT_VERSION,
        operationId: responseOperationId(request.operationId),
        success: true,
        probeId,
        configVersion,
        capabilities,
        strategy,
        warnings,
      });
    } catch (error) {
      observation.error = error;
      const emptyProbe: ProbedCapabilities = {
        reachable: false,
        streaming: false,
        nativeToolCalling: false,
        jsonOutput: false,
        maxContextTokens: null,
        multimodal: false,
      };
      return this.probeFailure(
        request.operationId,
        mapProbeFailure(observation, emptyProbe, operation.controller.signal),
      );
    } finally {
      this.finishOperation(request.operationId, operation);
    }
  }

  async save(
    input: unknown,
    options: { owner: SetupOwner },
    onProgress?: SetupProgressListener,
  ): Promise<SetupSaveResponse> {
    const decoded = decodeSetupSaveRequest(input);
    if (!decoded.ok) {
      return this.saveFailure('setup-recovery', decoded.recovery.code);
    }
    const request = decoded.value;
    const operation = this.beginOperation(request.operationId, 'save');
    return this.runMutation(async () => {
      let candidate: PreparedSetupRuntime | undefined;
      let previousRaw: string | null = null;
      let candidatePersisted = false;
      let failureCode: SetupErrorCode = 'setup_save_failed';

      try {
        this.assertNotAborted(operation.controller.signal);
        this.emitProgress(onProgress, request.operationId, 'preparing_runtime', 52);
        if (!storageAvailable(this.secureStorage)) {
          this.deleteProbeReceipt(request.probeId);
          return this.saveFailure(request.operationId, 'setup_secure_storage_unavailable');
        }

        previousRaw = await this.store.read();
        const previousEnvelope = parseStoredEnvelope(previousRaw);
        const currentVersion = previousEnvelope?.configVersion ?? 0;
        this.currentConfigVersion = currentVersion;
        if (request.expectedConfigVersion !== currentVersion) {
          this.deleteProbeReceipt(request.probeId);
          return this.saveFailure(request.operationId, 'setup_save_conflict');
        }

        this.pruneProbeReceipts();
        const receipt = this.probeReceipts.get(request.probeId);
        if (
          !receipt
          || receipt.expiresAt <= Date.now()
          || receipt.configVersion !== request.expectedConfigVersion
          || receipt.owner.webContentsId !== options.owner.webContentsId
          || receipt.owner.processId !== options.owner.processId
          || receipt.owner.routingId !== options.owner.routingId
          || receipt.owner.generation !== options.owner.generation
        ) {
          this.deleteProbeReceipt(request.probeId);
          return this.saveFailure(request.operationId, 'setup_probe_expired');
        }
        this.deleteProbeReceipt(request.probeId);

        if (currentVersion >= Number.MAX_SAFE_INTEGER) {
          return this.saveFailure(request.operationId, 'setup_save_failed');
        }
        const nextVersion = currentVersion + 1;
        const providerConfig: ProviderConfig = {
          baseUrl: receipt.input.baseUrl,
          apiKey: receipt.input.apiKey,
          model: receipt.input.model,
          timeout: DEFAULT_PROVIDER_TIMEOUT_MS,
          maxRetries: receipt.strategy.maxRetries,
          retryBackoffSeconds: DEFAULT_RETRY_BACKOFF_SECONDS,
        };

        this.assertNotAborted(operation.controller.signal);
        this.emitProgress(onProgress, request.operationId, 'preparing_runtime', 60);
        failureCode = 'setup_runtime_rebuild_failed';
        candidate = await this.runtimeRebuilder.prepare({
          config: { ...providerConfig },
          capabilities: { ...receipt.capabilities },
          strategy: { ...receipt.strategy },
          previousConfigVersion: this.activeRuntimeConfigVersion,
          nextConfigVersion: nextVersion,
          reason: 'save',
          signal: operation.controller.signal,
        });
        this.assertNotAborted(operation.controller.signal);

        this.emitProgress(onProgress, request.operationId, 'protecting_api_key', 70);
        failureCode = 'setup_save_failed';
        if (!storageAvailable(this.secureStorage)) {
          return this.rollbackCandidateAndFail(
            candidate,
            request.operationId,
            'setup_secure_storage_unavailable',
          );
        }
        const encryptedProvider = encryptProviderConfig(providerConfig, this.secureStorage);
        const storedCandidate: StoredConfiguredSetup = {
          schemaVersion: STORED_SETUP_SCHEMA_VERSION,
          state: 'configured',
          configVersion: nextVersion,
          provider: encryptedProvider,
          capabilities: receipt.capabilities,
          strategy: receipt.strategy,
          warnings: receipt.warnings,
          savedAt: Date.now(),
        };
        const validatedStored = StoredConfiguredSetupSchema.safeParse(storedCandidate);
        if (!validatedStored.success) {
          return this.rollbackCandidateAndFail(
            candidate,
            request.operationId,
            'setup_save_failed',
          );
        }
        const serialized = serializeEnvelope(validatedStored.data);
        if (serialized.includes(receipt.input.apiKey)) {
          return this.rollbackCandidateAndFail(
            candidate,
            request.operationId,
            'setup_save_failed',
          );
        }

        this.assertNotAborted(operation.controller.signal);
        this.emitProgress(onProgress, request.operationId, 'saving_configuration', 82);
        await this.store.replace(serialized);
        candidatePersisted = true;
        this.assertNotAborted(operation.controller.signal);

        this.emitProgress(onProgress, request.operationId, 'activating_runtime', 92);
        failureCode = 'setup_runtime_rebuild_failed';
        await candidate.commitAndAbortPrevious();
        candidate = undefined;
        this.currentConfigVersion = nextVersion;
        this.activeRuntimeConfigVersion = nextVersion;
        this.abortStaleProbeOperations(request.operationId);
        this.emitProgress(onProgress, request.operationId, 'complete', 100);

        return this.validateSaveResponse({
          version: SETUP_RUNTIME_CONTRACT_VERSION,
          operationId: request.operationId,
          success: true,
          configVersion: nextVersion,
          config: publicConfig(receipt.input),
          capabilities: receipt.capabilities,
          strategy: receipt.strategy,
          warnings: receipt.warnings,
        });
      } catch (error) {
        this.deleteProbeReceipt(request.probeId);
        const aborted = error instanceof SetupOperationAbortedError
          || operation.controller.signal.aborted;
        if (candidatePersisted) {
          const restored = await this.restorePreviousEnvelope(previousRaw);
          if (!restored) {
            this.currentConfigVersion = undefined;
            failureCode = 'setup_save_rollback_failed';
          }
        }
        if (candidate) await candidate.discard().catch(() => undefined);
        return this.saveFailure(
          request.operationId,
          failureCode === 'setup_save_rollback_failed'
            ? failureCode
            : aborted
              ? 'setup_operation_aborted'
              : failureCode,
        );
      } finally {
        this.finishOperation(request.operationId, operation);
      }
    });
  }

  async restore(input: unknown): Promise<SetupRestoreResponse> {
    const decoded = decodeSetupRestoreRequest(input);
    if (!decoded.ok) {
      return this.restoreFailure('setup-recovery', decoded.recovery.code);
    }
    const request = decoded.value;
    const operation = this.beginOperation(request.operationId, 'restore');
    return this.runMutation(async () => {
      let candidate: PreparedSetupRuntime | undefined;
      let failureCode: SetupErrorCode = 'setup_restore_failed';
      try {
        this.assertNotAborted(operation.controller.signal);
        const raw = await this.store.read();
        const envelope = parseStoredEnvelope(raw);
        if (!envelope) return this.restoreFailure(request.operationId, 'setup_config_invalid');
        this.currentConfigVersion = envelope.configVersion;
        if (envelope.state === 'not_configured') {
          return this.validateRestoreResponse({
            version: SETUP_RUNTIME_CONTRACT_VERSION,
            operationId: request.operationId,
            state: 'not_configured',
            configVersion: 0,
          });
        }
        if (!storageAvailable(this.secureStorage)) {
          return this.restoreFailure(request.operationId, 'setup_secure_storage_unavailable');
        }

        let providerConfig: ProviderConfig;
        try {
          providerConfig = decryptProviderConfig(envelope.provider, this.secureStorage);
        } catch {
          return this.restoreFailure(request.operationId, 'setup_config_decrypt_failed');
        }
        const setupInputResult = SetupInputSchema.safeParse({
          baseUrl: providerConfig.baseUrl,
          apiKey: providerConfig.apiKey,
          model: providerConfig.model,
        });
        if (!setupInputResult.success) {
          return this.restoreFailure(request.operationId, 'setup_config_invalid');
        }
        providerConfig = {
          ...providerConfig,
          ...setupInputResult.data,
        };

        this.assertNotAborted(operation.controller.signal);
        failureCode = 'setup_runtime_rebuild_failed';
        candidate = await this.runtimeRebuilder.prepare({
          config: { ...providerConfig },
          capabilities: { ...envelope.capabilities },
          strategy: { ...envelope.strategy },
          previousConfigVersion: this.activeRuntimeConfigVersion,
          nextConfigVersion: envelope.configVersion,
          reason: 'restore',
          signal: operation.controller.signal,
        });
        this.assertNotAborted(operation.controller.signal);
        await candidate.commitAndAbortPrevious();
        candidate = undefined;
        this.activeRuntimeConfigVersion = envelope.configVersion;

        return this.validateRestoreResponse({
          version: SETUP_RUNTIME_CONTRACT_VERSION,
          operationId: request.operationId,
          state: 'ready',
          configVersion: envelope.configVersion,
          config: {
            baseUrl: envelope.provider.baseUrl,
            model: envelope.provider.model,
            apiKeyStored: true,
          },
          capabilities: envelope.capabilities,
          strategy: envelope.strategy,
          warnings: envelope.warnings,
        });
      } catch (error) {
        if (candidate) await candidate.discard().catch(() => undefined);
        return this.restoreFailure(
          request.operationId,
          error instanceof SetupOperationAbortedError || operation.controller.signal.aborted
            ? 'setup_operation_aborted'
            : failureCode,
        );
      } finally {
        this.finishOperation(request.operationId, operation);
      }
    });
  }

  abort(input: unknown): SetupAbortResponse {
    const decoded = decodeSetupAbortRequest(input);
    if (!decoded.ok) {
      return {
        version: SETUP_RUNTIME_CONTRACT_VERSION,
        operationId: 'setup-recovery',
        success: false,
        code: 'setup_operation_not_found',
      };
    }
    const request = decoded.value;
    const operation = this.activeOperations.get(request.operationId);
    if (!operation) {
      return {
        version: SETUP_RUNTIME_CONTRACT_VERSION,
        operationId: request.operationId,
        success: false,
        code: 'setup_operation_not_found',
      };
    }
    operation.controller.abort();
    if (operation.kind === 'probe') {
      this.abortProbeTransport(request.operationId);
    }
    return {
      version: SETUP_RUNTIME_CONTRACT_VERSION,
      operationId: request.operationId,
      success: true,
      code: 'setup_operation_aborted',
    };
  }

  dispose(): void {
    for (const [operationId, operation] of this.activeOperations) {
      operation.controller.abort();
      if (operation.kind === 'probe') this.abortProbeTransport(operationId);
    }
    this.activeOperations.clear();
    for (const probeId of [...this.probeReceipts.keys()]) {
      this.deleteProbeReceipt(probeId);
    }
  }

  private progressTransport(
    operationId: string,
    signal: AbortSignal,
    observation: ProbeObservation,
    onProgress?: SetupProgressListener,
  ): ProbeTransport {
    return {
      chatProbe: async (baseUrl, apiKey, model, options) => {
        if (options.tools) {
          this.emitProgress(onProgress, operationId, 'checking_connection', 12);
        } else {
          this.emitProgress(onProgress, operationId, 'checking_structured_output', 32);
        }
        try {
          let response = await raceWithAbort(
            this.probeTransport.chatProbe(baseUrl, apiKey, model, options),
            signal,
          );
          if (options.tools) {
            if (response.status === 400 || response.status === 422) {
              const plainResponse = await raceWithAbort(
                this.probeTransport.chatProbe(baseUrl, apiKey, model, {}),
                signal,
              );
              response = {
                ...plainResponse,
                hasToolCalls: false,
              };
            }
            observation.primaryStatus = response.status;
            this.emitProgress(onProgress, operationId, 'checking_tool_use', 24);
          }
          return response;
        } catch (error) {
          if (options.tools) observation.error = error;
          throw error;
        }
      },
      streamProbe: async (baseUrl, apiKey, model) => {
        this.emitProgress(onProgress, operationId, 'checking_streaming', 40);
        return raceWithAbort(
          this.probeTransport.streamProbe(baseUrl, apiKey, model),
          signal,
        );
      },
      modelsProbe: async (baseUrl, apiKey, model) => {
        this.emitProgress(onProgress, operationId, 'checking_model_details', 48);
        return raceWithAbort(
          this.probeTransport.modelsProbe(baseUrl, apiKey, model),
          signal,
        );
      },
    };
  }

  private beginOperation(operationId: string, kind: ActiveOperation['kind']): ActiveOperation {
    const existing = this.activeOperations.get(operationId);
    if (existing) {
      existing.controller.abort();
      if (existing.kind === 'probe') this.abortProbeTransport(operationId);
    }
    const operation = { controller: new AbortController(), kind };
    this.activeOperations.set(operationId, operation);
    return operation;
  }

  private finishOperation(operationId: string, operation: ActiveOperation): void {
    if (this.activeOperations.get(operationId) === operation) {
      this.activeOperations.delete(operationId);
    }
  }

  private abortStaleProbeOperations(exceptOperationId: string): void {
    for (const [operationId, operation] of this.activeOperations) {
      if (operationId !== exceptOperationId && operation.kind === 'probe') {
        operation.controller.abort();
        this.abortProbeTransport(operationId);
      }
    }
  }

  private assertNotAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new SetupOperationAbortedError();
  }

  private abortProbeTransport(operationId: string): void {
    try {
      Promise.resolve(this.probeTransport.abort?.(operationId)).catch(() => undefined);
    } catch {
      // The operation's AbortSignal remains authoritative even if transport cleanup fails.
    }
  }

  private emitProgress(
    listener: SetupProgressListener | undefined,
    operationId: string,
    phase: SetupProgressPhase,
    percent: number,
  ): void {
    if (!listener) return;
    const parsed = SetupProgressEventSchema.safeParse({
      version: SETUP_RUNTIME_CONTRACT_VERSION,
      operationId,
      phase,
      percent,
    });
    if (!parsed.success) return;
    try {
      listener(parsed.data);
    } catch {
      // UI progress reporting cannot change setup transaction semantics.
    }
  }

  private pruneProbeReceipts(): void {
    const now = Date.now();
    for (const [probeId, receipt] of this.probeReceipts) {
      if (receipt.expiresAt <= now) this.deleteProbeReceipt(probeId);
    }
  }

  private deleteProbeReceipt(probeId: string): void {
    const receipt = this.probeReceipts.get(probeId);
    if (!receipt) return;
    clearTimeout(receipt.expirationTimer);
    this.probeReceipts.delete(probeId);
  }

  private async readCurrentConfigVersion(): Promise<number> {
    if (this.currentConfigVersion !== undefined) return this.currentConfigVersion;
    const envelope = parseStoredEnvelope(await this.store.read());
    this.currentConfigVersion = envelope?.configVersion ?? 0;
    return this.currentConfigVersion;
  }

  private async restorePreviousEnvelope(previousRaw: string | null): Promise<boolean> {
    try {
      await this.store.replace(
        previousRaw ?? serializeEnvelope(notConfiguredEnvelope()),
      );
      const previousEnvelope = parseStoredEnvelope(previousRaw);
      this.currentConfigVersion = previousEnvelope?.configVersion ?? 0;
      return true;
    } catch {
      return false;
    }
  }

  private async rollbackCandidateAndFail(
    candidate: PreparedSetupRuntime,
    operationId: string,
    code: SetupErrorCode,
  ): Promise<SetupSaveResponse> {
    await candidate.discard().catch(() => undefined);
    return this.saveFailure(operationId, code);
  }

  private runMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private probeFailure(operationId: string, code: SetupErrorCode): SetupProbeResponse {
    const stage = code === 'setup_request_unavailable' || code === 'setup_input_invalid'
      ? 'input'
      : 'probe';
    return this.validateProbeResponse({
      version: SETUP_RUNTIME_CONTRACT_VERSION,
      operationId,
      success: false,
      recovery: createSetupRecovery(code, { stage }),
    });
  }

  private saveFailure(operationId: string, code: SetupErrorCode): SetupSaveResponse {
    const stage = code === 'setup_runtime_rebuild_failed' ? 'runtime' : 'save';
    return this.validateSaveResponse({
      version: SETUP_RUNTIME_CONTRACT_VERSION,
      operationId,
      success: false,
      recovery: createSetupRecovery(code, { stage }),
    });
  }

  private restoreFailure(operationId: string, code: SetupErrorCode): SetupRestoreResponse {
    const stage = code === 'setup_runtime_rebuild_failed' ? 'runtime' : 'restore';
    return this.validateRestoreResponse({
      version: SETUP_RUNTIME_CONTRACT_VERSION,
      operationId,
      state: 'recovery',
      recovery: createSetupRecovery(code, { stage }),
    });
  }

  private validateProbeResponse(candidate: unknown): SetupProbeResponse {
    const result = SetupProbeResponseSchema.safeParse(candidate);
    if (result.success) return result.data;
    return {
      version: SETUP_RUNTIME_CONTRACT_VERSION,
      operationId: 'setup-recovery',
      success: false,
      recovery: createSetupRecovery('setup_probe_response_unavailable'),
    };
  }

  private validateSaveResponse(candidate: unknown): SetupSaveResponse {
    const result = SetupSaveResponseSchema.safeParse(candidate);
    if (result.success) return result.data;
    return {
      version: SETUP_RUNTIME_CONTRACT_VERSION,
      operationId: 'setup-recovery',
      success: false,
      recovery: createSetupRecovery('setup_save_failed'),
    };
  }

  private validateRestoreResponse(candidate: unknown): SetupRestoreResponse {
    const result = SetupRestoreResponseSchema.safeParse(candidate);
    if (result.success) return result.data;
    return {
      version: SETUP_RUNTIME_CONTRACT_VERSION,
      operationId: 'setup-recovery',
      state: 'recovery',
      recovery: createSetupRecovery('setup_restore_failed'),
    };
  }
}
