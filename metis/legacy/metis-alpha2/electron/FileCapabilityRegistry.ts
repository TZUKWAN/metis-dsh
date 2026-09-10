import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  FileCapabilityDescriptorSchema,
  FileCapabilityIdSchema,
  FileCapabilityPurposeSchema,
  createFileCapabilityFailure,
  decodeFileCapabilityUseRequest,
  type FileCapabilityDescriptor,
  type FileCapabilityFailure,
  type FileCapabilityKind,
  type FileCapabilityOperation,
  type FileCapabilityPurpose,
  type FileCapabilityUseRequest,
} from '../engine/runtime/FileCapabilityContract.js';
import type { ExecutionOwnerIdentity } from './ExecutionCapabilityRegistry.js';

export const FILE_CAPABILITY_REGISTRY_LIMITS = Object.freeze({
  minTtlMs: 1_000,
  defaultTtlMs: 10 * 60 * 1_000,
  maxTtlMs: 60 * 60 * 1_000,
  defaultCapacity: 256,
  maxCapacity: 1_024,
  randomIdBytes: 32,
  randomIdAttempts: 4,
} as const);

export interface FileCapabilityRegistryOptions {
  defaultTtlMs?: number;
  maxTtlMs?: number;
  capacity?: number;
}

export interface IssueFileCapabilityInput {
  path: string;
  kind: FileCapabilityKind;
  mime?: string;
  displayName?: string;
  operations: readonly FileCapabilityOperation[];
  /** Main-process purpose binding. It is deliberately absent from the renderer descriptor. */
  purpose?: FileCapabilityPurpose;
  ttlMs?: number;
}

export type IssueFileCapabilityResult =
  | { success: true; capability: FileCapabilityDescriptor }
  | FileCapabilityFailure;

/** Main-process-only resolution. Never return this object across IPC. */
export type FileCapabilityResolution =
  | {
      ok: true;
      capability: FileCapabilityDescriptor;
      request: FileCapabilityUseRequest;
      resolvedPath: string;
    }
  | {
      ok: false;
      failure: FileCapabilityFailure;
    };

export interface BoundFileCapabilityRequirement {
  purpose: FileCapabilityPurpose;
  kind: FileCapabilityKind;
  operation: FileCapabilityOperation;
}

interface FileCapabilityEntry {
  capability: FileCapabilityDescriptor;
  resolvedPath: string;
  ownerKey: string;
  purpose: FileCapabilityPurpose | null;
}

function isBoundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function createOwnerKey(owner: ExecutionOwnerIdentity | undefined): string | null {
  const values = [
    owner?.webContentsId,
    owner?.mainFrameProcessId,
    owner?.mainFrameRoutingId,
  ];
  if (!values.every((value) => (
    typeof value === 'number'
    && isBoundedInteger(value, 0, Number.MAX_SAFE_INTEGER)
  ))) return null;
  return `${values[0]}:${values[1]}:${values[2]}`;
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function cloneCapability(capability: FileCapabilityDescriptor): FileCapabilityDescriptor {
  return {
    ...capability,
    operations: [...capability.operations],
  };
}

function operationMatchesKind(
  kind: FileCapabilityKind,
  operation: FileCapabilityOperation,
): boolean {
  if (kind === 'folder') return operation === 'folder';
  return true;
}

/**
 * Stores canonical local paths exclusively in the Electron main process and
 * exposes only bounded opaque descriptors to other layers.
 */
export class FileCapabilityRegistry {
  readonly #entries = new Map<string, FileCapabilityEntry>();
  readonly #defaultTtlMs: number;
  readonly #maxTtlMs: number;
  readonly #capacity: number;

  constructor(options: FileCapabilityRegistryOptions = {}) {
    const maxTtlMs = options.maxTtlMs ?? FILE_CAPABILITY_REGISTRY_LIMITS.maxTtlMs;
    const defaultTtlMs = options.defaultTtlMs ?? FILE_CAPABILITY_REGISTRY_LIMITS.defaultTtlMs;
    const capacity = options.capacity ?? FILE_CAPABILITY_REGISTRY_LIMITS.defaultCapacity;

    if (!isBoundedInteger(
      maxTtlMs,
      FILE_CAPABILITY_REGISTRY_LIMITS.minTtlMs,
      FILE_CAPABILITY_REGISTRY_LIMITS.maxTtlMs,
    )) {
      throw new RangeError('Invalid file capability maximum TTL');
    }
    if (!isBoundedInteger(
      defaultTtlMs,
      FILE_CAPABILITY_REGISTRY_LIMITS.minTtlMs,
      maxTtlMs,
    )) {
      throw new RangeError('Invalid file capability default TTL');
    }
    if (!isBoundedInteger(capacity, 1, FILE_CAPABILITY_REGISTRY_LIMITS.maxCapacity)) {
      throw new RangeError('Invalid file capability capacity');
    }

    this.#defaultTtlMs = defaultTtlMs;
    this.#maxTtlMs = maxTtlMs;
    this.#capacity = capacity;
  }

  issue(
    input: IssueFileCapabilityInput,
    owner: ExecutionOwnerIdentity,
  ): IssueFileCapabilityResult {
    const now = Date.now();
    this.#pruneExpired(now);
    if (this.#entries.size >= this.#capacity) return createFileCapabilityFailure();

    const ownerKey = createOwnerKey(owner);
    const ttlMs = input.ttlMs ?? this.#defaultTtlMs;
    if (!isBoundedInteger(
      ttlMs,
      FILE_CAPABILITY_REGISTRY_LIMITS.minTtlMs,
      this.#maxTtlMs,
    )) {
      return createFileCapabilityFailure();
    }

    if (
      !ownerKey
      || typeof input.path !== 'string'
      || input.path.length === 0
      || !path.isAbsolute(input.path)
      || !Array.isArray(input.operations)
      || (input.purpose !== undefined && !FileCapabilityPurposeSchema.safeParse(input.purpose).success)
    ) {
      return createFileCapabilityFailure();
    }

    let resolvedPath: string;
    let actualKind: FileCapabilityKind;
    try {
      resolvedPath = fs.realpathSync.native(path.resolve(input.path));
      const stat = fs.statSync(resolvedPath);
      actualKind = stat.isDirectory() ? 'folder' : stat.isFile() ? 'file' : input.kind;
      if (actualKind !== input.kind || (!stat.isDirectory() && !stat.isFile())) {
        return createFileCapabilityFailure();
      }
    } catch {
      return createFileCapabilityFailure();
    }

    const operations = [...new Set(input.operations)];
    if (
      operations.length === 0
      || operations.some((operation) => !operationMatchesKind(actualKind, operation))
    ) {
      return createFileCapabilityFailure();
    }

    const capabilityId = this.#createCapabilityId();
    if (!capabilityId) return createFileCapabilityFailure();

    const defaultDisplayName = path.basename(resolvedPath)
      || (actualKind === 'folder' ? 'Folder' : 'File');
    const candidate = {
      capabilityId,
      kind: actualKind,
      mime: input.mime ?? (actualKind === 'folder' ? 'inode/directory' : 'application/octet-stream'),
      displayName: input.displayName ?? defaultDisplayName,
      operations,
      issuedAt: now,
      expiresAt: now + ttlMs,
    };
    const parsed = FileCapabilityDescriptorSchema.safeParse(candidate);
    if (!parsed.success) return createFileCapabilityFailure();

    const entry: FileCapabilityEntry = {
      capability: cloneCapability(parsed.data),
      resolvedPath,
      ownerKey,
      purpose: input.purpose ?? null,
    };
    this.#entries.set(capabilityId, entry);
    return { success: true, capability: cloneCapability(entry.capability) };
  }

  resolve(
    input: unknown,
    owner: ExecutionOwnerIdentity,
    expectedPurpose?: FileCapabilityPurpose,
  ): FileCapabilityResolution {
    return this.#resolve(input, owner, false, expectedPurpose);
  }

  /** One-shot authorization used for ingestion. A successful consume cannot be replayed. */
  consume(
    input: unknown,
    owner: ExecutionOwnerIdentity,
    expectedPurpose?: FileCapabilityPurpose,
  ): FileCapabilityResolution {
    return this.#resolve(input, owner, true, expectedPurpose);
  }

  /**
   * Atomically consumes one capability against a trusted main-process mapping.
   * The renderer supplies only the opaque ID; purpose, kind, and operation are
   * selected from the stored grant in one lookup, never by sequential fallback.
   */
  consumeMatching(
    capabilityId: unknown,
    owner: ExecutionOwnerIdentity,
    requirements: readonly BoundFileCapabilityRequirement[],
  ): FileCapabilityResolution {
    const parsedId = FileCapabilityIdSchema.safeParse(capabilityId);
    const ownerKey = createOwnerKey(owner);
    if (!parsedId.success || !ownerKey || requirements.length === 0) {
      return { ok: false, failure: createFileCapabilityFailure() };
    }
    const entry = this.#entries.get(parsedId.data);
    if (!entry || entry.ownerKey !== ownerKey || entry.capability.expiresAt <= Date.now()) {
      return { ok: false, failure: createFileCapabilityFailure() };
    }
    const matches = requirements.filter((requirement) => (
      FileCapabilityPurposeSchema.safeParse(requirement.purpose).success
      && operationMatchesKind(requirement.kind, requirement.operation)
      && entry.purpose === requirement.purpose
      && entry.capability.kind === requirement.kind
      && entry.capability.operations.length === 1
      && entry.capability.operations[0] === requirement.operation
    ));
    if (matches.length !== 1) {
      return { ok: false, failure: createFileCapabilityFailure() };
    }
    const match = matches[0];
    if (!match) return { ok: false, failure: createFileCapabilityFailure() };
    return this.#resolve({
      capabilityId: parsedId.data,
      operation: match.operation,
    }, owner, true, match.purpose);
  }

  #resolve(
    input: unknown,
    owner: ExecutionOwnerIdentity,
    consume: boolean,
    expectedPurpose?: FileCapabilityPurpose,
  ): FileCapabilityResolution {
    const decoded = decodeFileCapabilityUseRequest(input);
    if (!decoded.ok) return { ok: false, failure: decoded.failure };

    const now = Date.now();
    this.#pruneExpired(now);
    const ownerKey = createOwnerKey(owner);
    const entry = this.#entries.get(decoded.value.capabilityId);
    if (
      !ownerKey
      || !entry
      || entry.ownerKey !== ownerKey
      || entry.capability.expiresAt <= now
      || !entry.capability.operations.includes(decoded.value.operation)
      || !operationMatchesKind(entry.capability.kind, decoded.value.operation)
      || (expectedPurpose !== undefined && entry.purpose !== expectedPurpose)
    ) {
      return { ok: false, failure: createFileCapabilityFailure() };
    }

    try {
      const currentPath = fs.realpathSync.native(entry.resolvedPath);
      const stat = fs.statSync(currentPath);
      const currentKind: FileCapabilityKind | null = stat.isDirectory()
        ? 'folder'
        : stat.isFile()
          ? 'file'
          : null;
      if (!samePath(currentPath, entry.resolvedPath) || currentKind !== entry.capability.kind) {
        this.#entries.delete(decoded.value.capabilityId);
        return { ok: false, failure: createFileCapabilityFailure() };
      }
    } catch {
      this.#entries.delete(decoded.value.capabilityId);
      return { ok: false, failure: createFileCapabilityFailure() };
    }

    const resolvedPath = decoded.value.operation === 'folder'
      && entry.capability.kind === 'file'
      ? path.dirname(entry.resolvedPath)
      : entry.resolvedPath;

    if (consume) this.#entries.delete(decoded.value.capabilityId);

    return {
      ok: true,
      capability: cloneCapability(entry.capability),
      request: decoded.value,
      resolvedPath,
    };
  }

  revoke(capabilityId: unknown, owner: ExecutionOwnerIdentity): void {
    const parsed = FileCapabilityIdSchema.safeParse(capabilityId);
    const ownerKey = createOwnerKey(owner);
    if (!parsed.success || !ownerKey) return;
    const entry = this.#entries.get(parsed.data);
    if (entry?.ownerKey === ownerKey) this.#entries.delete(parsed.data);
  }

  clearOwner(owner: ExecutionOwnerIdentity): void {
    const ownerKey = createOwnerKey(owner);
    if (!ownerKey) return;
    for (const [capabilityId, entry] of this.#entries) {
      if (entry.ownerKey === ownerKey) this.#entries.delete(capabilityId);
    }
  }

  clearWebContents(webContentsId: number): void {
    if (!isBoundedInteger(webContentsId, 0, Number.MAX_SAFE_INTEGER)) return;
    const prefix = `${webContentsId}:`;
    for (const [capabilityId, entry] of this.#entries) {
      if (entry.ownerKey.startsWith(prefix)) this.#entries.delete(capabilityId);
    }
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    this.#pruneExpired(Date.now());
    return this.#entries.size;
  }

  #createCapabilityId(): string | null {
    for (
      let attempt = 0;
      attempt < FILE_CAPABILITY_REGISTRY_LIMITS.randomIdAttempts;
      attempt += 1
    ) {
      const candidate = `fc_${randomBytes(
        FILE_CAPABILITY_REGISTRY_LIMITS.randomIdBytes,
      ).toString('base64url')}`;
      if (!this.#entries.has(candidate)) return candidate;
    }
    return null;
  }

  #pruneExpired(now: number): void {
    for (const [capabilityId, entry] of this.#entries) {
      if (entry.capability.expiresAt <= now) this.#entries.delete(capabilityId);
    }
  }
}
