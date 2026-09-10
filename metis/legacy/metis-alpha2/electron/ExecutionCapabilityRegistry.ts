import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ExecutionGrantDescriptorSchema,
  ExecutionGrantIdSchema,
  createExecutionCapabilityFailure,
  decodeExecutionCapabilityUseRequest,
  type ExecutionCapabilityFailure,
  type ExecutionCapabilityUseRequest,
  type ExecutionGrantDescriptor,
  type ExecutionGrantLifetime,
  type ExecutionOperationKind,
} from '../engine/runtime/ExecutionCapabilityContract.js';

export const EXECUTION_CAPABILITY_REGISTRY_LIMITS = Object.freeze({
  minTtlMs: 1_000,
  defaultTtlMs: 5 * 60 * 1_000,
  maxTtlMs: 60 * 60 * 1_000,
  maxConsentAgeMs: 5 * 60 * 1_000,
  defaultCapacity: 128,
  maxCapacity: 1_024,
  randomIdBytes: 32,
  randomIdAttempts: 4,
  arguments: 32,
  argumentChars: 4_096,
  totalArgumentChars: 16_384,
  cwdRoots: 32,
  pathChars: 32_767,
  environmentAllowlistEntries: 32,
  environmentEntries: 32,
  environmentKeyChars: 64,
  environmentValueChars: 8_192,
  totalEnvironmentChars: 32_768,
} as const);

const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
// eslint-disable-next-line no-control-regex -- process arguments/environment must reject C0/C1 control-byte injection.
const UNSAFE_PROCESS_TEXT = /[\u0000-\u001f\u007f-\u009f]/u;

const ESSENTIAL_ENVIRONMENT_KEYS = process.platform === 'win32'
  ? ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP'] as const
  : ['PATH', 'LANG', 'LC_ALL', 'TMPDIR'] as const;

export interface ExecutionOwnerIdentity {
  webContentsId: number;
  mainFrameProcessId: number;
  mainFrameRoutingId: number;
}

export interface ExecutionCapabilityRegistryOptions {
  allowedCwdRoots?: readonly string[];
  allowedEnvironmentKeys?: readonly string[];
  defaultTtlMs?: number;
  maxTtlMs?: number;
  maxConsentAgeMs?: number;
  capacity?: number;
}

export interface IssueExecutionGrantInput {
  operation: ExecutionOperationKind;
  lifetime: ExecutionGrantLifetime;
  owner: ExecutionOwnerIdentity;
  userConsentAt: number;
  executablePath: string;
  fixedArgs?: readonly string[];
  cwd: string;
  environment?: Readonly<Record<string, string>>;
  ttlMs?: number;
}

export interface MainOnlyExecutionPlan {
  /** Canonical executable path. Never return across IPC. */
  executablePath: string;
  /** Fixed at grant issuance. Renderer requests never supply arguments. */
  args: string[];
  /** Canonical, allowlisted working directory. Never return across IPC. */
  cwd: string;
  /** Minimal allowlisted environment. Never return across IPC. */
  env: Record<string, string>;
  shell: false;
}

export type IssueExecutionGrantResult =
  | { success: true; grant: ExecutionGrantDescriptor }
  | ExecutionCapabilityFailure;

export type ExecutionCapabilityResolution =
  | {
      ok: true;
      action: 'execute';
      grant: ExecutionGrantDescriptor;
      plan: MainOnlyExecutionPlan;
    }
  | {
      ok: true;
      action: 'session-access';
      grant: ExecutionGrantDescriptor;
    }
  | {
      ok: false;
      failure: ExecutionCapabilityFailure;
    };

interface ExecutionGrantEntry {
  grant: ExecutionGrantDescriptor;
  ownerKey: string;
  plan: MainOnlyExecutionPlan;
  activatedAt: number | null;
}

function isBoundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function normalizeEnvironmentKey(key: string): string {
  return process.platform === 'win32' ? key.toUpperCase() : key;
}

function createOwnerKey(owner: ExecutionOwnerIdentity): string | null {
  const values = [
    owner?.webContentsId,
    owner?.mainFrameProcessId,
    owner?.mainFrameRoutingId,
  ];
  if (!values.every((value) => isBoundedInteger(value, 0, Number.MAX_SAFE_INTEGER))) {
    return null;
  }
  return `${values[0]}:${values[1]}:${values[2]}`;
}

function cloneGrant(grant: ExecutionGrantDescriptor): ExecutionGrantDescriptor {
  return { ...grant };
}

function clonePlan(plan: MainOnlyExecutionPlan): MainOnlyExecutionPlan {
  return {
    executablePath: plan.executablePath,
    args: [...plan.args],
    cwd: plan.cwd,
    env: { ...plan.env },
    shell: false,
  };
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isSafeArgument(value: string): boolean {
  return value.length <= EXECUTION_CAPABILITY_REGISTRY_LIMITS.argumentChars
    && !UNSAFE_PROCESS_TEXT.test(value);
}

function isSafeEnvironmentEntry(key: string, value: string): boolean {
  return key.length <= EXECUTION_CAPABILITY_REGISTRY_LIMITS.environmentKeyChars
    && ENVIRONMENT_KEY.test(key)
    && value.length <= EXECUTION_CAPABILITY_REGISTRY_LIMITS.environmentValueChars
    && !UNSAFE_PROCESS_TEXT.test(value);
}

/**
 * Main-process-only registry for execution plans approved by explicit user
 * consent. Renderer requests contain only an opaque grant ID and cannot alter
 * executable, arguments, cwd, environment, or owner identity.
 */
export class ExecutionCapabilityRegistry {
  readonly #entries = new Map<string, ExecutionGrantEntry>();
  readonly #allowedCwdRoots: string[];
  readonly #allowedEnvironmentKeys: Set<string>;
  readonly #defaultTtlMs: number;
  readonly #maxTtlMs: number;
  readonly #maxConsentAgeMs: number;
  readonly #capacity: number;

  constructor(options: ExecutionCapabilityRegistryOptions = {}) {
    const maxTtlMs = options.maxTtlMs ?? EXECUTION_CAPABILITY_REGISTRY_LIMITS.maxTtlMs;
    const defaultTtlMs = options.defaultTtlMs
      ?? EXECUTION_CAPABILITY_REGISTRY_LIMITS.defaultTtlMs;
    const maxConsentAgeMs = options.maxConsentAgeMs
      ?? EXECUTION_CAPABILITY_REGISTRY_LIMITS.maxConsentAgeMs;
    const capacity = options.capacity ?? EXECUTION_CAPABILITY_REGISTRY_LIMITS.defaultCapacity;

    if (!isBoundedInteger(
      maxTtlMs,
      EXECUTION_CAPABILITY_REGISTRY_LIMITS.minTtlMs,
      EXECUTION_CAPABILITY_REGISTRY_LIMITS.maxTtlMs,
    )) {
      throw new RangeError('Invalid execution capability maximum TTL');
    }
    if (!isBoundedInteger(
      defaultTtlMs,
      EXECUTION_CAPABILITY_REGISTRY_LIMITS.minTtlMs,
      maxTtlMs,
    )) {
      throw new RangeError('Invalid execution capability default TTL');
    }
    if (!isBoundedInteger(
      maxConsentAgeMs,
      EXECUTION_CAPABILITY_REGISTRY_LIMITS.minTtlMs,
      EXECUTION_CAPABILITY_REGISTRY_LIMITS.maxConsentAgeMs,
    )) {
      throw new RangeError('Invalid execution consent age');
    }
    if (!isBoundedInteger(
      capacity,
      1,
      EXECUTION_CAPABILITY_REGISTRY_LIMITS.maxCapacity,
    )) {
      throw new RangeError('Invalid execution capability capacity');
    }

    const configuredCwdRoots = options.allowedCwdRoots ?? [];
    if (configuredCwdRoots.length > EXECUTION_CAPABILITY_REGISTRY_LIMITS.cwdRoots) {
      throw new RangeError('Invalid execution cwd root allowlist');
    }
    this.#allowedCwdRoots = configuredCwdRoots.map((root) => {
      if (
        typeof root !== 'string'
        || root.length > EXECUTION_CAPABILITY_REGISTRY_LIMITS.pathChars
        || !path.isAbsolute(root)
      ) {
        throw new RangeError('Invalid execution cwd root');
      }
      const resolved = fs.realpathSync.native(root);
      if (!fs.statSync(resolved).isDirectory()) {
        throw new RangeError('Invalid execution cwd root');
      }
      return resolved;
    });

    const configuredEnvironmentKeys = options.allowedEnvironmentKeys ?? [];
    if (
      configuredEnvironmentKeys.length
      > EXECUTION_CAPABILITY_REGISTRY_LIMITS.environmentAllowlistEntries
    ) {
      throw new RangeError('Invalid execution environment allowlist');
    }
    this.#allowedEnvironmentKeys = new Set(
      configuredEnvironmentKeys.map((key) => {
        if (
          typeof key !== 'string'
          || key.length > EXECUTION_CAPABILITY_REGISTRY_LIMITS.environmentKeyChars
          || !ENVIRONMENT_KEY.test(key)
        ) {
          throw new RangeError('Invalid execution environment allowlist');
        }
        return normalizeEnvironmentKey(key);
      }),
    );
    this.#defaultTtlMs = defaultTtlMs;
    this.#maxTtlMs = maxTtlMs;
    this.#maxConsentAgeMs = maxConsentAgeMs;
    this.#capacity = capacity;
  }

  issue(input: IssueExecutionGrantInput): IssueExecutionGrantResult {
    const now = Date.now();
    this.#pruneExpired(now);
    if (this.#entries.size >= this.#capacity) return createExecutionCapabilityFailure();

    const ownerKey = createOwnerKey(input?.owner);
    const ttlMs = input?.ttlMs ?? this.#defaultTtlMs;
    if (
      !ownerKey
      || !isBoundedInteger(
        ttlMs,
        EXECUTION_CAPABILITY_REGISTRY_LIMITS.minTtlMs,
        this.#maxTtlMs,
      )
      || !isBoundedInteger(input?.userConsentAt, 0, Number.MAX_SAFE_INTEGER)
      || input.userConsentAt < now - this.#maxConsentAgeMs
      || input.userConsentAt > now
      || typeof input.executablePath !== 'string'
      || input.executablePath.length > EXECUTION_CAPABILITY_REGISTRY_LIMITS.pathChars
      || !path.isAbsolute(input.executablePath)
      || typeof input.cwd !== 'string'
      || input.cwd.length > EXECUTION_CAPABILITY_REGISTRY_LIMITS.pathChars
      || !path.isAbsolute(input.cwd)
    ) {
      return createExecutionCapabilityFailure();
    }

    let executablePath: string;
    let cwd: string;
    try {
      executablePath = fs.realpathSync.native(input.executablePath);
      cwd = fs.realpathSync.native(input.cwd);
      if (!fs.statSync(executablePath).isFile() || !fs.statSync(cwd).isDirectory()) {
        return createExecutionCapabilityFailure();
      }
    } catch {
      return createExecutionCapabilityFailure();
    }

    if (
      this.#allowedCwdRoots.length === 0
      || !this.#allowedCwdRoots.some((root) => isWithinRoot(cwd, root))
    ) {
      return createExecutionCapabilityFailure();
    }

    if (input.fixedArgs !== undefined && !Array.isArray(input.fixedArgs)) {
      return createExecutionCapabilityFailure();
    }
    const args = input.fixedArgs === undefined ? [] : [...input.fixedArgs];
    if (
      args.length > EXECUTION_CAPABILITY_REGISTRY_LIMITS.arguments
      || args.some((argument) => typeof argument !== 'string' || !isSafeArgument(argument))
      || args.reduce((total, argument) => total + argument.length, 0)
        > EXECUTION_CAPABILITY_REGISTRY_LIMITS.totalArgumentChars
    ) {
      return createExecutionCapabilityFailure();
    }

    let environment: Record<string, string> | null;
    try {
      environment = this.#createEnvironment(input.environment);
    } catch {
      return createExecutionCapabilityFailure();
    }
    if (!environment) return createExecutionCapabilityFailure();

    const grantId = this.#createGrantId();
    if (!grantId) return createExecutionCapabilityFailure();
    const parsed = ExecutionGrantDescriptorSchema.safeParse({
      grantId,
      operation: input.operation,
      lifetime: input.lifetime,
      consentedAt: input.userConsentAt,
      issuedAt: now,
      expiresAt: now + ttlMs,
    });
    if (!parsed.success) return createExecutionCapabilityFailure();

    const plan: MainOnlyExecutionPlan = {
      executablePath,
      args,
      cwd,
      env: environment,
      shell: false,
    };
    this.#entries.set(grantId, {
      grant: cloneGrant(parsed.data),
      ownerKey,
      plan: clonePlan(plan),
      activatedAt: null,
    });
    return { success: true, grant: cloneGrant(parsed.data) };
  }

  authorize(input: unknown, owner: ExecutionOwnerIdentity): ExecutionCapabilityResolution {
    const decoded = decodeExecutionCapabilityUseRequest(input);
    if (!decoded.ok) return { ok: false, failure: decoded.failure };

    const now = Date.now();
    this.#pruneExpired(now);
    const ownerKey = createOwnerKey(owner);
    const entry = this.#entries.get(decoded.value.grantId);
    if (
      !ownerKey
      || !entry
      || entry.ownerKey !== ownerKey
      || entry.grant.operation !== decoded.value.operation
      || entry.grant.expiresAt <= now
    ) {
      return { ok: false, failure: createExecutionCapabilityFailure() };
    }

    return decoded.value.action === 'execute'
      ? this.#authorizeExecution(decoded.value, entry, now)
      : this.#authorizeSessionAccess(decoded.value, entry);
  }

  revoke(grantId: unknown): void {
    const parsed = ExecutionGrantIdSchema.safeParse(grantId);
    if (parsed.success) this.#entries.delete(parsed.data);
  }

  clearOwner(owner: ExecutionOwnerIdentity): void {
    const ownerKey = createOwnerKey(owner);
    if (!ownerKey) return;
    for (const [grantId, entry] of this.#entries) {
      if (entry.ownerKey === ownerKey) this.#entries.delete(grantId);
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    this.#pruneExpired(Date.now());
    return this.#entries.size;
  }

  #authorizeExecution(
    request: ExecutionCapabilityUseRequest,
    entry: ExecutionGrantEntry,
    now: number,
  ): ExecutionCapabilityResolution {
    if (entry.activatedAt !== null) {
      return { ok: false, failure: createExecutionCapabilityFailure() };
    }

    const grant = cloneGrant(entry.grant);
    const plan = clonePlan(entry.plan);
    if (entry.grant.lifetime === 'once') {
      this.#entries.delete(request.grantId);
    } else {
      entry.activatedAt = now;
    }
    return { ok: true, action: 'execute', grant, plan };
  }

  #authorizeSessionAccess(
    _request: ExecutionCapabilityUseRequest,
    entry: ExecutionGrantEntry,
  ): ExecutionCapabilityResolution {
    if (entry.grant.lifetime !== 'session' || entry.activatedAt === null) {
      return { ok: false, failure: createExecutionCapabilityFailure() };
    }
    return {
      ok: true,
      action: 'session-access',
      grant: cloneGrant(entry.grant),
    };
  }

  #createEnvironment(
    requested: Readonly<Record<string, string>> | undefined,
  ): Record<string, string> | null {
    const environment: Record<string, string> = {};
    for (const key of ESSENTIAL_ENVIRONMENT_KEYS) {
      const value = process.env[key];
      if (typeof value === 'string' && isSafeEnvironmentEntry(key, value)) {
        environment[key] = value;
      }
    }

    if (requested !== undefined) {
      if (requested === null || typeof requested !== 'object' || Array.isArray(requested)) {
        return null;
      }
      for (const [key, value] of Object.entries(requested)) {
        if (
          typeof value !== 'string'
          || !this.#allowedEnvironmentKeys.has(normalizeEnvironmentKey(key))
          || !isSafeEnvironmentEntry(key, value)
        ) {
          return null;
        }
        environment[key] = value;
      }
    }

    const entries = Object.entries(environment);
    if (
      entries.length > EXECUTION_CAPABILITY_REGISTRY_LIMITS.environmentEntries
      || entries.reduce((total, [key, value]) => total + key.length + value.length, 0)
        > EXECUTION_CAPABILITY_REGISTRY_LIMITS.totalEnvironmentChars
    ) {
      return null;
    }
    return environment;
  }

  #createGrantId(): string | null {
    for (
      let attempt = 0;
      attempt < EXECUTION_CAPABILITY_REGISTRY_LIMITS.randomIdAttempts;
      attempt += 1
    ) {
      const grantId = `eg_${randomBytes(
        EXECUTION_CAPABILITY_REGISTRY_LIMITS.randomIdBytes,
      ).toString('base64url')}`;
      if (!this.#entries.has(grantId)) return grantId;
    }
    return null;
  }

  #pruneExpired(now: number): void {
    for (const [grantId, entry] of this.#entries) {
      if (entry.grant.expiresAt <= now) this.#entries.delete(grantId);
    }
  }
}
