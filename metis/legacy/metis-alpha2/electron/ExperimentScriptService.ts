import { createHash, randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import {
  ExecutionCapabilityRegistry,
  type ExecutionOwnerIdentity,
  type MainOnlyExecutionPlan,
} from './ExecutionCapabilityRegistry.js';
import {
  EXPERIMENT_RUNTIME_LIMITS,
  ExperimentExecutionGrantDescriptorSchema,
  ExperimentExecutionGrantResultSchema,
  ExperimentIdSchema,
  ExperimentMetricsSchema,
  ExperimentRunResultSchema,
  ExperimentScriptAttachResultSchema,
  ExperimentScriptAttachmentSchema,
  createExperimentRunFailure,
  decodeExperimentExecutionGrantRequest,
  decodeExperimentRunRequest,
  decodeExperimentScriptAttachRequest,
  type AttachmentAccessBinding,
  type ExperimentExecutionGrantDescriptor,
  type ExperimentExecutionGrantResult,
  type ExperimentMetrics,
  type ExperimentRunResult,
  type ExperimentScriptAttachResult,
  type ExperimentScriptFailureCode,
  type ExperimentScriptPersistence,
  type ExperimentScriptRuntime,
  type MainOnlyExperimentScriptAttachmentRecord,
  type MainOnlyExperimentRunRecord,
} from '../engine/runtime/ExperimentRuntimeContract.js';

export const EXPERIMENT_SCRIPT_SERVICE_LIMITS = Object.freeze({
  pathChars: 32_767,
  outputBytesPerStream: 16 * 1024 * 1024,
  metricLineChars: 8_192,
  defaultTimeoutMs: 10 * 60 * 1_000,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 60 * 60 * 1_000,
  killGraceMs: 2_000,
  grantTtlMs: 5 * 60 * 1_000,
  attachmentIdBytes: 24,
  runIdBytes: 18,
} as const);

const SCRIPT_EXTENSIONS: Readonly<Record<string, ExperimentScriptRuntime>> = Object.freeze({
  '.py': 'python',
  '.js': 'node',
  '.mjs': 'node',
  '.cjs': 'node',
});

const PYTHON_RUNTIME_CANDIDATES = process.platform === 'win32'
  ? ['python/python.exe', 'python.exe'] as const
  : ['python/bin/python3', 'python/bin/python', 'bin/python3'] as const;

// eslint-disable-next-line no-control-regex -- executable text must reject raw C0/C1 controls.
const UNSAFE_SCRIPT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const BIDI_CONTROL_CHARACTERS = /[\u202a-\u202e\u2066-\u2069]/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const METRIC_LINE = /^METRIC:([A-Za-z][A-Za-z0-9_.:-]{0,63})=([^\s]+)$/u;
const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

export { type ExperimentScriptPersistence } from '../engine/runtime/ExperimentRuntimeContract.js';

export interface ExperimentScriptServiceOptions {
  managedRoot: string;
  logRoot: string;
  runtimeRoot: string;
  selectScriptPath(
    experimentId: string,
    owner: ExecutionOwnerIdentity,
  ): Promise<string | null>;
  persistence: ExperimentScriptPersistence;
  resolveBinding(owner: ExecutionOwnerIdentity): AttachmentAccessBinding;
  /** Exact original process executable. In Electron it runs as Node only with ELECTRON_RUN_AS_NODE=1. */
  trustedNodeExecutable?: string;
  timeoutMs?: number;
}

interface GrantBinding {
  experimentId: string;
  attachmentId: string;
  contentSha256: string;
  accessBinding: AttachmentAccessBinding;
  grant: ExperimentExecutionGrantDescriptor;
  expiryTimer: ReturnType<typeof setTimeout>;
}

interface RunControl {
  accessBinding: AttachmentAccessBinding;
  child?: ChildProcessWithoutNullStreams;
  cancelRequested: boolean;
  timedOut: boolean;
  outputExceeded: boolean;
  logFailed: boolean;
  escalationTimer?: ReturnType<typeof setTimeout>;
}

interface LogSink {
  handle: FileHandle;
  bytes: number;
  queue: Promise<void>;
}

interface ProcessOutcome {
  exitCode: number | null;
  launchError: unknown;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeRandomId(prefix: string, bytes: number): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

function experimentDirectoryName(experimentId: string): string {
  return createHash('sha256').update(experimentId, 'utf8').digest('hex');
}

function hashBytes(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function safeMainLogError(error: unknown): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return value
    // eslint-disable-next-line no-control-regex -- logs must not preserve terminal control bytes.
    .replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .slice(0, 4_000);
}

function unrefTimerBestEffort(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer !== 'object' || timer === null) return;
  const unref = Reflect.get(timer, 'unref');
  if (typeof unref === 'function') Reflect.apply(unref, timer, []);
}

function runtimeForExtension(extension: string): ExperimentScriptRuntime | undefined {
  return SCRIPT_EXTENSIONS[extension.toLowerCase()];
}

function fixedRuntimeArgs(runtime: ExperimentScriptRuntime, scriptPath: string): string[] {
  return runtime === 'python'
    ? ['-I', scriptPath]
    : ['--unhandled-rejections=strict', '--disable-proto=throw', scriptPath];
}

function grantsEqual(
  left: ExperimentExecutionGrantDescriptor,
  right: ExperimentExecutionGrantDescriptor,
): boolean {
  return left.grantId === right.grantId
    && left.operation === right.operation
    && left.lifetime === right.lifetime
    && left.consentedAt === right.consentedAt
    && left.issuedAt === right.issuedAt
    && left.expiresAt === right.expiresAt;
}

function isAccessBinding(value: AttachmentAccessBinding): boolean {
  return SHA256_HEX.test(value?.sessionBinding ?? '')
    && SHA256_HEX.test(value?.ownerBinding ?? '')
    && value.sessionBinding !== '0'.repeat(64)
    && value.ownerBinding !== '0'.repeat(64);
}

function accessBindingsEqual(
  left: AttachmentAccessBinding,
  right: AttachmentAccessBinding,
): boolean {
  return left.sessionBinding === right.sessionBinding
    && left.ownerBinding === right.ownerBinding;
}

function runControlKey(experimentId: string, binding: AttachmentAccessBinding): string {
  return `${experimentId}:${binding.ownerBinding}`;
}

class ControlledRuntimeLocator {
  readonly #runtimeRoot: string;
  readonly #trustedNodeExecutable?: string;

  constructor(runtimeRoot: string, trustedNodeExecutable?: string) {
    this.#runtimeRoot = runtimeRoot;
    this.#trustedNodeExecutable = trustedNodeExecutable;
  }

  async locate(runtime: ExperimentScriptRuntime): Promise<string | null> {
    if (runtime === 'node') {
      if (!this.#trustedNodeExecutable) return null;
      try {
        const candidate = await realpath(this.#trustedNodeExecutable);
        const originalProcessExecutable = await realpath(process.execPath);
        if (candidate !== originalProcessExecutable || !(await stat(candidate)).isFile()) return null;
        return candidate;
      } catch {
        return null;
      }
    }

    let root: string;
    try {
      root = await realpath(this.#runtimeRoot);
      if (!(await stat(root)).isDirectory()) return null;
    } catch {
      return null;
    }

    for (const relativeCandidate of PYTHON_RUNTIME_CANDIDATES) {
      try {
        const candidate = await realpath(path.resolve(root, relativeCandidate));
        if (!isWithinRoot(candidate, root) || !(await stat(candidate)).isFile()) continue;
        return candidate;
      } catch {
        // Continue through the fixed, controlled candidate list.
      }
    }
    return null;
  }
}

class MetricStreamParser {
  readonly #decoder = new TextDecoder('utf-8');
  readonly #metrics: Record<string, number> = Object.create(null) as Record<string, number>;
  #pending = '';
  #droppingLongLine = false;

  push(chunk: Uint8Array): void {
    this.#acceptText(this.#decoder.decode(chunk, { stream: true }));
  }

  finish(): ExperimentMetrics {
    this.#acceptText(this.#decoder.decode());
    if (!this.#droppingLongLine && this.#pending.length > 0) this.#parseLine(this.#pending);
    const parsed = ExperimentMetricsSchema.safeParse({ ...this.#metrics });
    return parsed.success ? parsed.data : {};
  }

  #acceptText(text: string): void {
    for (const character of text) {
      if (character === '\n') {
        if (!this.#droppingLongLine) this.#parseLine(this.#pending.replace(/\r$/u, ''));
        this.#pending = '';
        this.#droppingLongLine = false;
        continue;
      }
      if (this.#droppingLongLine) continue;
      if (this.#pending.length >= EXPERIMENT_SCRIPT_SERVICE_LIMITS.metricLineChars) {
        this.#pending = '';
        this.#droppingLongLine = true;
        continue;
      }
      this.#pending += character;
    }
  }

  #parseLine(line: string): void {
    if (Object.keys(this.#metrics).length >= EXPERIMENT_RUNTIME_LIMITS.metrics) return;
    const match = METRIC_LINE.exec(line);
    const key = match?.[1];
    const rawValue = match?.[2];
    if (!key || !rawValue || !DECIMAL_NUMBER.test(rawValue)) return;
    const value = Number(rawValue);
    const candidate = ExperimentMetricsSchema.safeParse({ [key]: value });
    if (!candidate.success) return;
    this.#metrics[key] = value;
  }
}

/**
 * Main-process-only experiment script boundary. Local paths, execution plans,
 * runtimes and log locations never appear in its renderer-safe return values.
 */
export class ExperimentScriptService {
  readonly #managedRoot: string;
  readonly #logRoot: string;
  readonly #selectScriptPath: ExperimentScriptServiceOptions['selectScriptPath'];
  readonly #persistence: ExperimentScriptPersistence;
  readonly #resolveBinding: ExperimentScriptServiceOptions['resolveBinding'];
  readonly #runtimeLocator: ControlledRuntimeLocator;
  readonly #executionRegistry: ExecutionCapabilityRegistry;
  readonly #timeoutMs: number;
  readonly #grantBindings = new Map<string, GrantBinding>();
  readonly #runControls = new Map<string, RunControl>();
  readonly #busyExperiments = new Set<string>();
  readonly #controlOperations = new Set<string>();

  constructor(options: ExperimentScriptServiceOptions) {
    for (const [label, value] of [
      ['managedRoot', options.managedRoot],
      ['logRoot', options.logRoot],
      ['runtimeRoot', options.runtimeRoot],
    ] as const) {
      if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
        throw new RangeError(`Experiment ${label} must be an absolute path`);
      }
    }
    if (typeof options.selectScriptPath !== 'function') {
      throw new TypeError('Experiment script selector is required');
    }
    if (
      !options.persistence
      || typeof options.persistence.loadAttachment !== 'function'
      || typeof options.persistence.saveAttachment !== 'function'
      || typeof options.persistence.recordRun !== 'function'
      || typeof options.resolveBinding !== 'function'
    ) {
      throw new TypeError('Experiment script persistence adapter is required');
    }

    fs.mkdirSync(options.managedRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(options.logRoot, { recursive: true, mode: 0o700 });
    this.#managedRoot = fs.realpathSync.native(options.managedRoot);
    this.#logRoot = fs.realpathSync.native(options.logRoot);
    this.#selectScriptPath = options.selectScriptPath;
    this.#persistence = options.persistence;
    this.#resolveBinding = options.resolveBinding;
    this.#runtimeLocator = new ControlledRuntimeLocator(
      path.resolve(options.runtimeRoot),
      options.trustedNodeExecutable,
    );
    this.#executionRegistry = new ExecutionCapabilityRegistry({
      allowedCwdRoots: [this.#managedRoot],
      allowedEnvironmentKeys: ['ELECTRON_RUN_AS_NODE'],
      defaultTtlMs: EXPERIMENT_SCRIPT_SERVICE_LIMITS.grantTtlMs,
      maxTtlMs: EXPERIMENT_SCRIPT_SERVICE_LIMITS.grantTtlMs,
    });

    const requestedTimeout = options.timeoutMs
      ?? EXPERIMENT_SCRIPT_SERVICE_LIMITS.defaultTimeoutMs;
    this.#timeoutMs = Number.isInteger(requestedTimeout)
      && requestedTimeout >= EXPERIMENT_SCRIPT_SERVICE_LIMITS.minTimeoutMs
      && requestedTimeout <= EXPERIMENT_SCRIPT_SERVICE_LIMITS.maxTimeoutMs
      ? requestedTimeout
      : EXPERIMENT_SCRIPT_SERVICE_LIMITS.defaultTimeoutMs;
  }

  async attach(
    input: unknown,
    owner: ExecutionOwnerIdentity,
  ): Promise<ExperimentScriptAttachResult> {
    const request = decodeExperimentScriptAttachRequest(input);
    const accessBinding = request ? this.#bindingFor(owner) : null;
    if (
      !request
      || !accessBinding
      || this.#busyExperiments.has(request.experimentId)
      || this.#controlOperations.has(request.experimentId)
    ) {
      return this.#attachFailure('experiment_script_unavailable');
    }
    this.#controlOperations.add(request.experimentId);
    try {

    let selectedPath: string | null;
    try {
      selectedPath = await this.#selectScriptPath(request.experimentId, owner);
    } catch {
      return this.#attachFailure('experiment_script_unavailable');
    }
    if (selectedPath === null) return { status: 'cancelled' };
    if (
      typeof selectedPath !== 'string'
      || selectedPath.length === 0
      || selectedPath.length > EXPERIMENT_SCRIPT_SERVICE_LIMITS.pathChars
      || !path.isAbsolute(selectedPath)
    ) {
      return this.#attachFailure('experiment_script_unavailable');
    }

    const extension = path.extname(selectedPath).toLowerCase();
    const runtime = runtimeForExtension(extension);
    if (!runtime) return this.#attachFailure('experiment_script_type_unsupported');

    let sourcePath: string;
    let data: Buffer;
    try {
      sourcePath = await realpath(selectedPath);
      const handle = await open(sourcePath, 'r');
      try {
        const sourceStat = await handle.stat();
        if (!sourceStat.isFile()) return this.#attachFailure('experiment_script_unavailable');
        if (
          sourceStat.size <= 0
          || sourceStat.size > EXPERIMENT_RUNTIME_LIMITS.scriptBytes
        ) {
          return this.#attachFailure('experiment_script_too_large');
        }
        data = await handle.readFile();
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch {
      return this.#attachFailure('experiment_script_unavailable');
    }
    const canonicalExtension = path.extname(sourcePath).toLowerCase();
    if (canonicalExtension !== extension || runtimeForExtension(canonicalExtension) !== runtime) {
      return this.#attachFailure('experiment_script_type_unsupported');
    }
    if (data.byteLength <= 0 || data.byteLength > EXPERIMENT_RUNTIME_LIMITS.scriptBytes) {
      return this.#attachFailure('experiment_script_too_large');
    }
    if (data.includes(0)) return this.#attachFailure('experiment_script_not_text');

    let scriptText: string;
    try {
      scriptText = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch {
      return this.#attachFailure('experiment_script_not_text');
    }
    if (
      UNSAFE_SCRIPT_CONTROLS.test(scriptText)
      || BIDI_CONTROL_CHARACTERS.test(scriptText)
    ) {
      return this.#attachFailure('experiment_script_not_text');
    }

    const attachmentId = safeRandomId(
      'esa_',
      EXPERIMENT_SCRIPT_SERVICE_LIMITS.attachmentIdBytes,
    );
    const attachmentCandidate = ExperimentScriptAttachmentSchema.safeParse({
      attachmentId,
      displayName: path.basename(sourcePath),
      runtime,
      sizeBytes: data.byteLength,
      attachedAt: Date.now(),
    });
    if (!attachmentCandidate.success) {
      return this.#attachFailure('experiment_script_unavailable');
    }

    const experimentDirectory = path.join(
      this.#managedRoot,
      experimentDirectoryName(request.experimentId),
    );
    let managedPath = path.join(experimentDirectory, `${attachmentId}${extension}`);
    try {
      managedPath = await this.#writeManagedAttachment(
        experimentDirectory,
        managedPath,
        data,
      );
    } catch {
      return this.#attachFailure('experiment_script_copy_failed');
    }

    const previous = await this.#safeLoadAttachment(request.experimentId, accessBinding);
    const record: MainOnlyExperimentScriptAttachmentRecord = {
      experimentId: request.experimentId,
      attachment: attachmentCandidate.data,
      managedPath,
      contentSha256: hashBytes(data),
    };
    try {
      await this.#persistence.saveAttachment(record, accessBinding);
    } catch {
      await unlink(managedPath).catch(() => undefined);
      return this.#attachFailure('experiment_script_copy_failed');
    }

    this.#revokeExperimentGrants(request.experimentId, accessBinding);
    if (
      previous
      && previous.managedPath !== managedPath
      && isWithinRoot(previous.managedPath, this.#managedRoot)
    ) {
      await unlink(previous.managedPath).catch(() => undefined);
    }

    return this.#validateAttachResult({
      status: 'attached',
      attachment: attachmentCandidate.data,
    });
    } finally {
      this.#controlOperations.delete(request.experimentId);
    }
  }

  async requestRunGrant(
    input: unknown,
    owner: ExecutionOwnerIdentity,
  ): Promise<ExperimentExecutionGrantResult> {
    const request = decodeExperimentExecutionGrantRequest(input);
    const accessBinding = request ? this.#bindingFor(owner) : null;
    if (
      !request
      || !accessBinding
      || this.#busyExperiments.has(request.experimentId)
      || this.#controlOperations.has(request.experimentId)
    ) {
      return this.#grantFailure('experiment_grant_unavailable');
    }
    this.#controlOperations.add(request.experimentId);
    try {
    const record = await this.#loadValidatedAttachment(request.experimentId, accessBinding);
    if (!record) return this.#grantFailure('experiment_script_not_attached');

    const executablePath = await this.#runtimeLocator.locate(record.attachment.runtime);
    if (!executablePath) return this.#grantFailure('experiment_runtime_unavailable');

    this.#revokeExperimentGrants(request.experimentId, accessBinding);
    const issued = this.#executionRegistry.issue({
      operation: 'experiment-script',
      lifetime: 'once',
      owner,
      userConsentAt: Date.now(),
      executablePath,
      fixedArgs: fixedRuntimeArgs(record.attachment.runtime, record.managedPath),
      cwd: path.dirname(record.managedPath),
      ...(record.attachment.runtime === 'node'
        ? { environment: { ELECTRON_RUN_AS_NODE: '1' } }
        : {}),
      ttlMs: EXPERIMENT_SCRIPT_SERVICE_LIMITS.grantTtlMs,
    });
    if (!issued.success) return this.#grantFailure('experiment_grant_unavailable');

    const grant = ExperimentExecutionGrantDescriptorSchema.safeParse(issued.grant);
    if (!grant.success) {
      this.#executionRegistry.revoke(issued.grant.grantId);
      return this.#grantFailure('experiment_grant_unavailable');
    }
    this.#deleteGrantBinding(grant.data.grantId);
    const expiryTimer = setTimeout(() => {
      this.#deleteGrantBinding(grant.data.grantId);
    }, Math.max(1, grant.data.expiresAt - Date.now()));
    unrefTimerBestEffort(expiryTimer);
    this.#grantBindings.set(grant.data.grantId, {
      experimentId: request.experimentId,
      attachmentId: record.attachment.attachmentId,
      contentSha256: record.contentSha256,
      accessBinding,
      grant: grant.data,
      expiryTimer,
    });

    const result = ExperimentExecutionGrantResultSchema.safeParse({
      status: 'granted',
      grant: grant.data,
    });
    if (result.success) return result.data;
    this.#executionRegistry.revoke(grant.data.grantId);
    this.#deleteGrantBinding(grant.data.grantId);
    return this.#grantFailure('experiment_grant_unavailable');
    } finally {
      this.#controlOperations.delete(request.experimentId);
    }
  }

  async run(
    input: unknown,
    owner: ExecutionOwnerIdentity,
  ): Promise<ExperimentRunResult> {
    const request = decodeExperimentRunRequest(input);
    const accessBinding = request ? this.#bindingFor(owner) : null;
    if (
      !request
      || !accessBinding
      || this.#busyExperiments.has(request.experimentId)
      || this.#controlOperations.has(request.experimentId)
    ) {
      return createExperimentRunFailure('rejected');
    }
    const controlKey = runControlKey(request.experimentId, accessBinding);
    if (this.#runControls.has(controlKey)) return createExperimentRunFailure('rejected');
    const control: RunControl = {
      accessBinding,
      cancelRequested: false,
      timedOut: false,
      outputExceeded: false,
      logFailed: false,
    };
    // Installed before the first await so same-owner cancellation cannot be lost.
    this.#runControls.set(controlKey, control);
    this.#busyExperiments.add(request.experimentId);
    this.#controlOperations.add(request.experimentId);
    try {
      if (control.cancelRequested) return createExperimentRunFailure('cancelled');
      const grantBinding = this.#grantBindings.get(request.grant.grantId);
      if (
        !grantBinding
        || grantBinding.experimentId !== request.experimentId
        || !accessBindingsEqual(grantBinding.accessBinding, accessBinding)
        || !grantsEqual(grantBinding.grant, request.grant)
      ) {
        // A different renderer owner must not be able to invalidate the
        // legitimate owner's outstanding once-grant as a denial-of-service.
        if (grantBinding && accessBindingsEqual(grantBinding.accessBinding, accessBinding)) {
          this.#deleteGrantBinding(request.grant.grantId);
          this.#executionRegistry.revoke(request.grant.grantId);
        }
        return createExperimentRunFailure('rejected');
      }

      const record = await this.#loadValidatedAttachment(request.experimentId, accessBinding);
      if (control.cancelRequested) {
        this.#deleteGrantBinding(request.grant.grantId);
        this.#executionRegistry.revoke(request.grant.grantId);
        return createExperimentRunFailure('cancelled');
      }
      if (
        !record
        || record.attachment.attachmentId !== grantBinding.attachmentId
        || record.contentSha256 !== grantBinding.contentSha256
      ) {
        this.#deleteGrantBinding(request.grant.grantId);
        this.#executionRegistry.revoke(request.grant.grantId);
        return createExperimentRunFailure('rejected');
      }

      const resolution = this.#executionRegistry.authorize({
        grantId: request.grant.grantId,
        operation: 'experiment-script',
        action: 'execute',
      }, owner);
      this.#deleteGrantBinding(request.grant.grantId);
      if (
        !resolution.ok
        || resolution.action !== 'execute'
        || !grantsEqual(resolution.grant, request.grant)
      ) {
        return createExperimentRunFailure('rejected');
      }
      if (control.cancelRequested) return createExperimentRunFailure('cancelled');
      return await this.#execute(
        request.experimentId,
        record,
        resolution.plan,
        control,
      );
    } finally {
      this.#runControls.delete(controlKey);
      this.#busyExperiments.delete(request.experimentId);
      this.#controlOperations.delete(request.experimentId);
    }
  }

  cancel(input: unknown, owner: ExecutionOwnerIdentity): boolean {
    const parsed = ExperimentIdSchema.safeParse(input);
    const accessBinding = parsed.success ? this.#bindingFor(owner) : null;
    if (!parsed.success || !accessBinding) return false;
    const control = this.#runControls.get(runControlKey(parsed.data, accessBinding));
    if (!control) return false;
    control.cancelRequested = true;
    this.#terminate(control);
    return true;
  }

  dispose(): void {
    for (const control of this.#runControls.values()) {
      control.cancelRequested = true;
      this.#terminate(control);
    }
    for (const grantId of [...this.#grantBindings.keys()]) this.#deleteGrantBinding(grantId);
    this.#executionRegistry.clear();
    this.#busyExperiments.clear();
    this.#controlOperations.clear();
    this.#runControls.clear();
  }

  async #execute(
    experimentId: string,
    record: MainOnlyExperimentScriptAttachmentRecord,
    plan: MainOnlyExecutionPlan,
    control: RunControl,
  ): Promise<ExperimentRunResult> {
    const startedAt = Date.now();
    if (control.cancelRequested) return createExperimentRunFailure('cancelled');
    const runId = safeRandomId('exr_', EXPERIMENT_SCRIPT_SERVICE_LIMITS.runIdBytes);
    const logDirectory = path.join(
      this.#logRoot,
      experimentDirectoryName(experimentId),
      runId,
    );

    let canonicalLogDirectory: string;
    try {
      await mkdir(logDirectory, { recursive: true, mode: 0o700 });
      canonicalLogDirectory = await realpath(logDirectory);
      if (!isWithinRoot(canonicalLogDirectory, this.#logRoot)) {
        return createExperimentRunFailure('failed');
      }
    } catch {
      return createExperimentRunFailure('failed');
    }
    if (control.cancelRequested) return createExperimentRunFailure('cancelled');
    const stdoutLogPath = path.join(canonicalLogDirectory, 'stdout.log');
    const stderrLogPath = path.join(canonicalLogDirectory, 'stderr.log');

    let stdout: LogSink;
    let stderr: LogSink;
    try {
      stdout = { handle: await open(stdoutLogPath, 'wx', 0o600), bytes: 0, queue: Promise.resolve() };
      try {
        stderr = { handle: await open(stderrLogPath, 'wx', 0o600), bytes: 0, queue: Promise.resolve() };
      } catch (error) {
        await stdout.handle.close().catch(() => undefined);
        throw error;
      }
    } catch {
      return createExperimentRunFailure('failed');
    }

    if (control.cancelRequested) {
      await this.#closeLogs(stdout, stderr);
      return this.#recordAndReturn({
        runId,
        experimentId,
        attachmentId: record.attachment.attachmentId,
        status: 'cancelled',
        exitCode: null,
        metrics: {},
        startedAt,
        stdoutLogPath,
        stderrLogPath,
      });
    }

    const metricParser = new MetricStreamParser();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(plan.executablePath, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        shell: false,
        windowsHide: true,
        stdio: 'pipe',
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end();
    } catch (error) {
      this.#queueLog(stderr, Buffer.from(`[launch-error] ${safeMainLogError(error)}\n`, 'utf8'));
      await this.#closeLogs(stdout, stderr);
      return this.#recordAndReturn({
        runId,
        experimentId,
        attachmentId: record.attachment.attachmentId,
        status: 'failed',
        exitCode: null,
        metrics: {},
        startedAt,
        stdoutLogPath,
        stderrLogPath,
      });
    }

    control.child = child;
    if (control.cancelRequested) this.#terminate(control);
    this.#pipeOutput(child.stdout, stdout, control, metricParser);
    this.#pipeOutput(child.stderr, stderr, control);

    const timeout = setTimeout(() => {
      control.timedOut = true;
      this.#terminate(control);
    }, this.#timeoutMs);
    unrefTimerBestEffort(timeout);

    const outcome = await new Promise<ProcessOutcome>((resolve) => {
      let launchError: unknown = null;
      child.once('error', (error) => {
        launchError = error;
        this.#queueLog(stderr, Buffer.from(`[process-error] ${safeMainLogError(error)}\n`, 'utf8'));
      });
      child.once('close', (exitCode) => resolve({ exitCode, launchError }));
    });

    clearTimeout(timeout);
    if (control.escalationTimer) clearTimeout(control.escalationTimer);
    const metrics = metricParser.finish();
    const logsClosed = await this.#closeLogs(stdout, stderr);

    let result: ExperimentRunResult;
    if (control.cancelRequested) {
      result = createExperimentRunFailure('cancelled', metrics);
    } else if (control.timedOut) {
      result = createExperimentRunFailure('timed_out', metrics);
    } else if (control.outputExceeded || control.logFailed || outcome.launchError) {
      result = createExperimentRunFailure('failed', metrics);
    } else if (outcome.exitCode === 0 && logsClosed) {
      result = { status: 'completed', exitCode: 0, metrics };
    } else {
      const boundedExitCode = typeof outcome.exitCode === 'number'
        && Number.isInteger(outcome.exitCode)
        && outcome.exitCode !== 0
        && outcome.exitCode >= -2_147_483_648
        && outcome.exitCode <= 2_147_483_647
        ? outcome.exitCode
        : null;
      result = createExperimentRunFailure('failed', metrics, boundedExitCode);
    }

    return this.#recordAndReturn({
      runId,
      experimentId,
      attachmentId: record.attachment.attachmentId,
      status: result.status,
      exitCode: result.exitCode,
      metrics: result.metrics,
      startedAt,
      stdoutLogPath,
      stderrLogPath,
    });
  }

  #pipeOutput(
    source: NodeJS.ReadableStream,
    sink: LogSink,
    control: RunControl,
    metricParser?: MetricStreamParser,
  ): void {
    source.on('error', () => {
      control.logFailed = true;
      this.#terminate(control);
    });
    source.on('data', (value: unknown) => {
      if (control.logFailed || control.outputExceeded) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
      const remaining = EXPERIMENT_SCRIPT_SERVICE_LIMITS.outputBytesPerStream - sink.bytes;
      if (remaining <= 0) {
        control.outputExceeded = true;
        this.#terminate(control);
        return;
      }
      const bounded = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
      sink.bytes += bounded.byteLength;
      metricParser?.push(bounded);
      source.pause();
      sink.queue = sink.queue
        .then(async () => {
          await sink.handle.write(bounded);
        })
        .then(() => { source.resume(); })
        .catch(() => {
          control.logFailed = true;
          this.#terminate(control);
        });
      if (bounded.byteLength !== chunk.byteLength) {
        control.outputExceeded = true;
        this.#terminate(control);
      }
    });
  }

  #queueLog(sink: LogSink, data: Buffer): void {
    const remaining = EXPERIMENT_SCRIPT_SERVICE_LIMITS.outputBytesPerStream - sink.bytes;
    if (remaining <= 0) return;
    const bounded = data.byteLength <= remaining ? data : data.subarray(0, remaining);
    sink.bytes += bounded.byteLength;
    sink.queue = sink.queue.then(async () => {
      await sink.handle.write(bounded);
    }).catch(() => undefined);
  }

  #terminate(control: RunControl): void {
    const child = control.child;
    if (!child) return;
    try {
      child.kill();
    } catch {
      // The close/error path remains authoritative.
    }
    if (control.escalationTimer) return;
    control.escalationTimer = setTimeout(() => {
      try {
        if (child.exitCode === null) child.kill('SIGKILL');
      } catch {
        // The process may already have exited.
      }
    }, EXPERIMENT_SCRIPT_SERVICE_LIMITS.killGraceMs);
    unrefTimerBestEffort(control.escalationTimer);
  }

  async #closeLogs(stdout: LogSink, stderr: LogSink): Promise<boolean> {
    try {
      await Promise.all([stdout.queue, stderr.queue]);
      await Promise.all([stdout.handle.sync(), stderr.handle.sync()]);
      await Promise.all([stdout.handle.close(), stderr.handle.close()]);
      return true;
    } catch {
      await stdout.handle.close().catch(() => undefined);
      await stderr.handle.close().catch(() => undefined);
      return false;
    }
  }

  async #recordAndReturn(
    input: Omit<MainOnlyExperimentRunRecord, 'finishedAt'>,
  ): Promise<ExperimentRunResult> {
    const candidate = ExperimentRunResultSchema.safeParse({
      status: input.status,
      exitCode: input.exitCode,
      metrics: input.metrics,
    });
    const safeResult = candidate.success
      ? candidate.data
      : createExperimentRunFailure('failed');
    try {
      await this.#persistence.recordRun({
        ...input,
        status: safeResult.status,
        exitCode: safeResult.exitCode,
        metrics: safeResult.metrics,
        finishedAt: Date.now(),
      });
      return safeResult;
    } catch {
      return createExperimentRunFailure('failed', safeResult.metrics);
    }
  }

  async #writeManagedAttachment(
    directory: string,
    managedPath: string,
    data: Buffer,
  ): Promise<string> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const canonicalDirectory = await realpath(directory);
    if (!isWithinRoot(canonicalDirectory, this.#managedRoot)) {
      throw new Error('Managed experiment directory is unavailable');
    }
    const canonicalManagedPath = path.join(
      canonicalDirectory,
      path.basename(managedPath),
    );
    if (!isWithinRoot(canonicalManagedPath, this.#managedRoot)) {
      throw new Error('Managed experiment attachment is unavailable');
    }
    const temporaryPath = path.join(
      canonicalDirectory,
      `.attach-${safeRandomId('', 12)}.tmp`,
    );
    let handle: FileHandle | undefined;
    let published = false;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(temporaryPath, canonicalManagedPath);
      published = true;
      await unlink(temporaryPath);
      await this.#syncDirectoryBestEffort(canonicalDirectory);
      return canonicalManagedPath;
    } catch (error) {
      if (published) await unlink(canonicalManagedPath).catch(() => undefined);
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async #syncDirectoryBestEffort(directory: string): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(directory, 'r');
      await handle.sync();
    } catch {
      // Directory fsync is not available on every supported Windows filesystem.
    } finally {
      if (handle) await handle.close().catch(() => undefined);
    }
  }

  async #safeLoadAttachment(
    experimentId: string,
    binding: AttachmentAccessBinding,
  ): Promise<MainOnlyExperimentScriptAttachmentRecord | null> {
    try {
      return await this.#persistence.loadAttachment(experimentId, binding);
    } catch {
      return null;
    }
  }

  async #loadValidatedAttachment(
    experimentId: string,
    binding: AttachmentAccessBinding,
  ): Promise<MainOnlyExperimentScriptAttachmentRecord | null> {
    const record = await this.#safeLoadAttachment(experimentId, binding);
    if (
      !record
      || record.experimentId !== experimentId
      || typeof record.managedPath !== 'string'
      || record.managedPath.length === 0
      || record.managedPath.length > EXPERIMENT_SCRIPT_SERVICE_LIMITS.pathChars
      || !path.isAbsolute(record.managedPath)
      || typeof record.contentSha256 !== 'string'
      || !SHA256_HEX.test(record.contentSha256)
    ) {
      return null;
    }
    const attachment = ExperimentScriptAttachmentSchema.safeParse(record.attachment);
    if (!attachment.success) return null;

    try {
      const storedStat = await lstat(record.managedPath);
      if (!storedStat.isFile() || storedStat.isSymbolicLink()) return null;
      const managedPath = await realpath(record.managedPath);
      if (!isWithinRoot(managedPath, this.#managedRoot)) return null;
      const managedStat = await stat(managedPath);
      if (
        !managedStat.isFile()
        || managedStat.size !== attachment.data.sizeBytes
        || runtimeForExtension(path.extname(managedPath)) !== attachment.data.runtime
      ) {
        return null;
      }
      const handle = await open(managedPath, 'r');
      let data: Buffer;
      try {
        data = await handle.readFile();
      } finally {
        await handle.close().catch(() => undefined);
      }
      if (hashBytes(data) !== record.contentSha256) return null;
      return {
        experimentId,
        attachment: attachment.data,
        managedPath,
        contentSha256: record.contentSha256,
      };
    } catch {
      return null;
    }
  }

  #bindingFor(owner: ExecutionOwnerIdentity): AttachmentAccessBinding | null {
    try {
      const binding = this.#resolveBinding(owner);
      return isAccessBinding(binding) ? binding : null;
    } catch {
      return null;
    }
  }

  #revokeExperimentGrants(
    experimentId: string,
    accessBinding: AttachmentAccessBinding,
  ): void {
    for (const [grantId, binding] of this.#grantBindings) {
      if (
        binding.experimentId !== experimentId
        || !accessBindingsEqual(binding.accessBinding, accessBinding)
      ) continue;
      this.#executionRegistry.revoke(grantId);
      this.#deleteGrantBinding(grantId);
    }
  }

  #deleteGrantBinding(grantId: string): void {
    const binding = this.#grantBindings.get(grantId);
    if (!binding) return;
    clearTimeout(binding.expiryTimer);
    this.#grantBindings.delete(grantId);
  }

  #attachFailure(code: ExperimentScriptFailureCode): ExperimentScriptAttachResult {
    return this.#validateAttachResult({ status: 'rejected', code });
  }

  #grantFailure(code: ExperimentScriptFailureCode): ExperimentExecutionGrantResult {
    const candidate = ExperimentExecutionGrantResultSchema.safeParse({
      status: 'rejected',
      code,
    });
    return candidate.success
      ? candidate.data
      : { status: 'rejected', code: 'experiment_grant_unavailable' };
  }

  #validateAttachResult(candidate: unknown): ExperimentScriptAttachResult {
    const parsed = ExperimentScriptAttachResultSchema.safeParse(candidate);
    return parsed.success
      ? parsed.data
      : { status: 'rejected', code: 'experiment_script_unavailable' };
  }
}
