import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  PERSONALIZATION_SECRET_CONTRACT_VERSION,
  PERSONALIZATION_SECRET_MAX_ENTRIES,
  PersonalizationSecretListRequestSchema,
  PersonalizationSecretListResponseSchema,
  PersonalizationSecretMetadataSchema,
  PersonalizationSecretNameSchema,
  PersonalizationSecretRemoveRequestSchema,
  PersonalizationSecretRemoveResponseSchema,
  PersonalizationSecretSetRequestSchema,
  PersonalizationSecretSetResponseSchema,
  PersonalizationSecretValueSchema,
  secretNameFromRef,
  type PersonalizationSecretListResponse,
  type PersonalizationSecretMetadata,
  type PersonalizationSecretRemoveResponse,
  type PersonalizationSecretSetResponse,
} from '../engine/runtime/PersonalizationSecretContract.js';

const FILE_NAME = 'personalization-secrets.v1.json';
const LOCK_NAME = '.personalization-secrets.v1.lock';
const FILE_FORMAT = 'metis-personalization-secret-vault';
const FILE_SCHEMA_VERSION = 1 as const;
const FILE_MAX_BYTES = 4 * 1024 * 1024;
const LOCK_ATTEMPTS = 200;
const LOCK_RETRY_MS = 5;
const FILE_MAC_DOMAIN = 'metis:personalization-secret-vault:file:v1\0';
const VALUE_MAC_DOMAIN = 'metis:personalization-secret-vault:value:v1\0';
const FALLBACK_OPERATION_ID = '00000000-0000-4000-8000-000000000000';

const Base64Schema = z.string().min(4).max(1_000_000)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)
  .refine((value) => Buffer.from(value, 'base64').toString('base64') === value, 'Non-canonical base64');
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const StoredSecretSchema = z.strictObject({
  name: PersonalizationSecretNameSchema,
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ciphertext: Base64Schema,
  ciphertextSha256: DigestSchema,
  valueHmac: DigestSchema,
});

const VaultFileSchema = z.strictObject({
  format: z.literal(FILE_FORMAT),
  schemaVersion: z.literal(FILE_SCHEMA_VERSION),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  encryptedIntegrityKey: Base64Schema,
  entries: z.array(StoredSecretSchema).max(PERSONALIZATION_SECRET_MAX_ENTRIES),
  mac: DigestSchema,
}).superRefine((value, context) => {
  const names = value.entries.map((entry) => entry.name);
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: 'custom', path: ['entries'], message: 'Secret names must be unique' });
  }
  if (names.join('\0') !== [...names].sort().join('\0')) {
    context.addIssue({ code: 'custom', path: ['entries'], message: 'Secret entries must be canonically ordered' });
  }
  for (let index = 0; index < value.entries.length; index += 1) {
    const entry = value.entries[index]!;
    if (entry.updatedAt < entry.createdAt) {
      context.addIssue({ code: 'custom', path: ['entries', index, 'updatedAt'], message: 'updatedAt predates createdAt' });
    }
  }
});

type StoredSecret = z.infer<typeof StoredSecretSchema>;
type VaultFile = z.infer<typeof VaultFileSchema>;
type VaultFailureCode = 'storage_unavailable' | 'integrity_error' | 'io_error';

interface LoadedVault {
  revision: number;
  encryptedIntegrityKey: string | null;
  integrityKey: Buffer | null;
  entries: StoredSecret[];
}

export interface PersonalizationSafeStoragePort {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(plainText: string): Buffer;
  decryptString(encryptedValue: Buffer): string;
}

export interface PersonalizationSecretVaultIo {
  fsyncFile(fd: number): void;
  fsyncDirectory(directory: string): void;
  rename(source: string, destination: string): void;
}

const DEFAULT_IO: PersonalizationSecretVaultIo = {
  fsyncFile: (fd) => fs.fsyncSync(fd),
  fsyncDirectory: (directory) => {
    if (process.platform === 'win32') return;
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  },
  rename: (source, destination) => fs.renameSync(source, destination),
};

class VaultFailure extends Error {
  readonly code: VaultFailureCode;
  constructor(code: VaultFailureCode) {
    super(code);
    this.name = 'VaultFailure';
    this.code = code;
  }
}

export class PersonalizationSecretVault {
  readonly #root: string;
  readonly #filePath: string;
  readonly #lockPath: string;
  readonly #safeStorage: PersonalizationSafeStoragePort;
  readonly #io: PersonalizationSecretVaultIo;
  readonly #now: () => number;

  constructor(
    root: string,
    safeStorage: PersonalizationSafeStoragePort,
    options?: { io?: PersonalizationSecretVaultIo; now?: () => number },
  ) {
    this.#root = requireCanonicalDirectory(root);
    this.#filePath = path.join(this.#root, FILE_NAME);
    this.#lockPath = path.join(this.#root, LOCK_NAME);
    this.#safeStorage = safeStorage;
    this.#io = options?.io ?? DEFAULT_IO;
    this.#now = options?.now ?? Date.now;
  }

  list(raw: unknown): PersonalizationSecretListResponse {
    const operationId = extractOperationId(raw);
    const parsed = PersonalizationSecretListRequestSchema.safeParse(raw);
    if (!parsed.success) return listFailure(operationId, 'invalid_request');
    if (!this.#protectionAvailable()) return listFailure(parsed.data.operationId, 'storage_unavailable');
    try {
      const vault = this.#readVault();
      return PersonalizationSecretListResponseSchema.parse({
        ok: true,
        contractVersion: PERSONALIZATION_SECRET_CONTRACT_VERSION,
        operationId: parsed.data.operationId,
        revision: vault.revision,
        secrets: vault.entries.map(publicMetadata),
      });
    } catch (error) {
      return listFailure(parsed.data.operationId, failureCode(error));
    }
  }

  async set(raw: unknown): Promise<PersonalizationSecretSetResponse> {
    const operationId = extractOperationId(raw);
    const parsed = PersonalizationSecretSetRequestSchema.safeParse(raw);
    if (!parsed.success) return setFailure(operationId, 'invalid_request');
    if (!this.#protectionAvailable()) return setFailure(parsed.data.operationId, 'storage_unavailable');
    let lockFd: number | undefined;
    try {
      lockFd = await this.#acquireLock();
      const vault = this.#readVault();
      if (vault.revision !== parsed.data.expectedRevision) {
        return setConflict(parsed.data.operationId, vault.revision);
      }
      const existing = vault.entries.find((entry) => entry.name === parsed.data.name);
      if (!existing && vault.entries.length >= PERSONALIZATION_SECRET_MAX_ENTRIES) {
        return setFailure(parsed.data.operationId, 'capacity_exceeded');
      }
      if (vault.revision >= Number.MAX_SAFE_INTEGER) return setFailure(parsed.data.operationId, 'io_error');
      const keyMaterial = vault.integrityKey ?? randomBytes(32);
      const encryptedIntegrityKey = vault.encryptedIntegrityKey
        ?? this.#safeStorage.encryptString(keyMaterial.toString('base64url')).toString('base64');
      const ciphertext = this.#safeStorage.encryptString(parsed.data.value).toString('base64');
      const timestamp = monotonicTimestamp(this.#now(), existing?.updatedAt);
      const entry: StoredSecret = StoredSecretSchema.parse({
        name: parsed.data.name,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        ciphertext,
        ciphertextSha256: sha256(Buffer.from(ciphertext, 'base64')),
        valueHmac: valueHmac(keyMaterial, parsed.data.name, parsed.data.value),
      });
      const entries = [...vault.entries.filter((item) => item.name !== entry.name), entry]
        .sort((left, right) => left.name.localeCompare(right.name));
      const revision = vault.revision + 1;
      this.#writeVault({ revision, encryptedIntegrityKey, integrityKey: keyMaterial, entries });
      return PersonalizationSecretSetResponseSchema.parse({
        ok: true,
        contractVersion: PERSONALIZATION_SECRET_CONTRACT_VERSION,
        operationId: parsed.data.operationId,
        revision,
        secret: publicMetadata(entry),
      });
    } catch (error) {
      return setFailure(parsed.data.operationId, failureCode(error));
    } finally {
      if (lockFd !== undefined) this.#releaseLock(lockFd);
    }
  }

  async remove(raw: unknown): Promise<PersonalizationSecretRemoveResponse> {
    const operationId = extractOperationId(raw);
    const parsed = PersonalizationSecretRemoveRequestSchema.safeParse(raw);
    if (!parsed.success) return removeFailure(operationId, 'invalid_request');
    if (!this.#protectionAvailable()) return removeFailure(parsed.data.operationId, 'storage_unavailable');
    let lockFd: number | undefined;
    try {
      lockFd = await this.#acquireLock();
      const vault = this.#readVault();
      if (vault.revision !== parsed.data.expectedRevision) {
        return removeConflict(parsed.data.operationId, vault.revision);
      }
      if (!vault.entries.some((entry) => entry.name === parsed.data.name)) {
        return removeFailure(parsed.data.operationId, 'not_found');
      }
      if (!vault.integrityKey || !vault.encryptedIntegrityKey || vault.revision >= Number.MAX_SAFE_INTEGER) {
        return removeFailure(parsed.data.operationId, 'integrity_error');
      }
      const revision = vault.revision + 1;
      this.#writeVault({
        revision,
        encryptedIntegrityKey: vault.encryptedIntegrityKey,
        integrityKey: vault.integrityKey,
        entries: vault.entries.filter((entry) => entry.name !== parsed.data.name),
      });
      return PersonalizationSecretRemoveResponseSchema.parse({
        ok: true,
        contractVersion: PERSONALIZATION_SECRET_CONTRACT_VERSION,
        operationId: parsed.data.operationId,
        revision,
        removed: true,
        name: parsed.data.name,
      });
    } catch (error) {
      return removeFailure(parsed.data.operationId, failureCode(error));
    } finally {
      if (lockFd !== undefined) this.#releaseLock(lockFd);
    }
  }

  /** Main-process only. Never expose this method through preload or an IPC response. */
  resolve(reference: string, _context?: unknown): string | undefined {
    void _context;
    const name = secretNameFromRef(reference);
    if (!name || !this.#protectionAvailable()) return undefined;
    try {
      const vault = this.#readVault();
      const entry = vault.entries.find((candidate) => candidate.name === name);
      if (!entry || !vault.integrityKey) return undefined;
      const encrypted = Buffer.from(entry.ciphertext, 'base64');
      if (sha256(encrypted) !== entry.ciphertextSha256) return undefined;
      const plaintext = this.#safeStorage.decryptString(encrypted);
      if (!PersonalizationSecretValueSchema.safeParse(plaintext).success) return undefined;
      const actual = Buffer.from(entry.valueHmac, 'hex');
      const expected = Buffer.from(valueHmac(vault.integrityKey, entry.name, plaintext), 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
      return plaintext;
    } catch {
      return undefined;
    }
  }

  #protectionAvailable(): boolean {
    try {
      if (!this.#safeStorage.isEncryptionAvailable()) return false;
      if (process.platform !== 'linux') return true;
      const backend = this.#safeStorage.getSelectedStorageBackend?.();
      return backend !== undefined && backend !== 'basic_text' && backend !== 'unknown';
    } catch {
      return false;
    }
  }

  #readVault(): LoadedVault {
    this.#assertRoot();
    let fd: number | undefined;
    try {
      const pathStat = safeLstat(this.#filePath);
      if (!pathStat) return { revision: 0, encryptedIntegrityKey: null, integrityKey: null, entries: [] };
      if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new VaultFailure('integrity_error');
      fd = fs.openSync(this.#filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.size < 64 || before.size > FILE_MAX_BYTES) throw new VaultFailure('integrity_error');
      if (process.platform !== 'win32' && (before.mode & 0o077) !== 0) throw new VaultFailure('integrity_error');
      const raw = fs.readFileSync(fd, { encoding: 'utf8' });
      const after = fs.fstatSync(fd);
      const finalPathStat = fs.lstatSync(this.#filePath);
      if (!sameIdentity(before, after) || !sameIdentity(before, finalPathStat)
        || finalPathStat.isSymbolicLink() || !finalPathStat.isFile()) {
        throw new VaultFailure('integrity_error');
      }
      this.#assertRoot();
      const parsed = VaultFileSchema.safeParse(JSON.parse(raw) as unknown);
      if (!parsed.success) throw new VaultFailure('integrity_error');
      const file = parsed.data;
      const keyText = this.#safeStorage.decryptString(Buffer.from(file.encryptedIntegrityKey, 'base64'));
      const integrityKey = Buffer.from(keyText, 'base64url');
      if (integrityKey.length !== 32) throw new VaultFailure('integrity_error');
      const expectedMac = Buffer.from(fileMac(integrityKey, unsignedFile(file)), 'hex');
      const actualMac = Buffer.from(file.mac, 'hex');
      if (actualMac.length !== expectedMac.length || !timingSafeEqual(actualMac, expectedMac)) {
        throw new VaultFailure('integrity_error');
      }
      for (const entry of file.entries) {
        if (sha256(Buffer.from(entry.ciphertext, 'base64')) !== entry.ciphertextSha256) {
          throw new VaultFailure('integrity_error');
        }
      }
      return {
        revision: file.revision,
        encryptedIntegrityKey: file.encryptedIntegrityKey,
        integrityKey,
        entries: file.entries,
      };
    } catch (error) {
      if (error instanceof VaultFailure) throw error;
      throw new VaultFailure('integrity_error');
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* best-effort handle cleanup */ }
      }
    }
  }

  #writeVault(vault: { revision: number; encryptedIntegrityKey: string; integrityKey: Buffer; entries: StoredSecret[] }): void {
    this.#assertRoot();
    const unsigned: Omit<VaultFile, 'mac'> = {
      format: FILE_FORMAT,
      schemaVersion: FILE_SCHEMA_VERSION,
      revision: vault.revision,
      encryptedIntegrityKey: vault.encryptedIntegrityKey,
      entries: vault.entries,
    };
    const file: VaultFile = VaultFileSchema.parse({
      ...unsigned,
      mac: fileMac(vault.integrityKey, unsigned),
    });
    const bytes = Buffer.from(canonicalJson(file), 'utf8');
    if (bytes.length > FILE_MAX_BYTES) throw new VaultFailure('io_error');
    const temporary = path.join(this.#root, `.${FILE_NAME}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fchmodSync(fd, 0o600);
      this.#io.fsyncFile(fd);
      fs.closeSync(fd);
      fd = undefined;
      this.#assertRoot();
      const existing = safeLstat(this.#filePath);
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new VaultFailure('integrity_error');
      this.#io.rename(temporary, this.#filePath);
      this.#assertRoot();
      const committed = this.#readVault();
      if (committed.revision !== vault.revision
        || committed.entries.length !== vault.entries.length
        || committed.encryptedIntegrityKey !== vault.encryptedIntegrityKey) {
        throw new VaultFailure('integrity_error');
      }
      this.#io.fsyncDirectory(this.#root);
    } catch (error) {
      if (error instanceof VaultFailure) throw error;
      throw new VaultFailure('io_error');
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* best-effort handle cleanup */ }
      }
      try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort staging cleanup */ }
    }
  }

  async #acquireLock(): Promise<number> {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      this.#assertRoot();
      let fd: number | undefined;
      try {
        fd = fs.openSync(this.#lockPath, 'wx', 0o600);
        fs.fchmodSync(fd, 0o600);
        this.#io.fsyncFile(fd);
        return fd;
      } catch (error) {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch { /* best-effort handle cleanup */ }
          try {
            const current = safeLstat(this.#lockPath);
            if (current?.isFile() && !current.isSymbolicLink()) fs.unlinkSync(this.#lockPath);
          } catch { /* leave an anomalous lock in place */ }
        }
        if ((error as { code?: string }).code !== 'EEXIST') throw new VaultFailure('io_error');
        await delay(LOCK_RETRY_MS);
      }
    }
    throw new VaultFailure('io_error');
  }

  #releaseLock(fd: number): void {
    try {
      const held = fs.fstatSync(fd);
      const current = safeLstat(this.#lockPath);
      if (current && sameIdentity(held, current) && current.isFile() && !current.isSymbolicLink()) {
        fs.unlinkSync(this.#lockPath);
      }
    } catch {
      // A lock identity anomaly is left in place so the next mutation also fails closed.
    } finally {
      try { fs.closeSync(fd); } catch { /* best-effort handle cleanup */ }
    }
  }

  #assertRoot(): void {
    try {
      const stat = fs.lstatSync(this.#root);
      const real = fs.realpathSync.native(this.#root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(real, this.#root)) {
        throw new VaultFailure('integrity_error');
      }
    } catch (error) {
      if (error instanceof VaultFailure) throw error;
      throw new VaultFailure('integrity_error');
    }
  }
}

function requireCanonicalDirectory(input: string): string {
  const resolved = path.resolve(input);
  try {
    const root = path.parse(resolved).root;
    const relative = path.relative(root, resolved);
    let cursor = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !samePath(fs.realpathSync.native(cursor), cursor)) {
        throw new Error('Unsafe secret vault directory');
      }
    }
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe secret vault directory');
    return fs.realpathSync.native(resolved);
  } catch {
    throw new Error('Unsafe secret vault directory');
  }
}

function unsignedFile(file: VaultFile): Omit<VaultFile, 'mac'> {
  const { mac: _mac, ...unsigned } = file;
  void _mac;
  return unsigned;
}

function fileMac(key: Buffer, unsigned: Omit<VaultFile, 'mac'>): string {
  return createHmac('sha256', key).update(FILE_MAC_DOMAIN).update(canonicalJson(unsigned), 'utf8').digest('hex');
}

function valueHmac(key: Buffer, name: string, plaintext: string): string {
  return createHmac('sha256', key).update(VALUE_MAC_DOMAIN).update(name, 'utf8').update('\0').update(plaintext, 'utf8').digest('hex');
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function publicMetadata(entry: StoredSecret): PersonalizationSecretMetadata {
  return PersonalizationSecretMetadataSchema.parse({
    name: entry.name,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });
}

function monotonicTimestamp(now: number, previous?: number): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new VaultFailure('io_error');
  if (previous === undefined) return now;
  if (previous >= Number.MAX_SAFE_INTEGER) throw new VaultFailure('io_error');
  return Math.max(now, previous + 1);
}

function safeLstat(filePath: string): fs.Stats | undefined {
  try { return fs.lstatSync(filePath); } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined;
    throw new VaultFailure('integrity_error');
  }
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === 'win32'
    ? path.normalize(value).toLowerCase()
    : path.normalize(value);
  return normalize(left) === normalize(right);
}

function extractOperationId(raw: unknown): string {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const candidate = (raw as Record<string, unknown>).operationId;
    if (typeof candidate === 'string' && z.string().uuid().safeParse(candidate).success) return candidate;
  }
  return FALLBACK_OPERATION_ID;
}

function failureCode(error: unknown): VaultFailureCode {
  return error instanceof VaultFailure ? error.code : 'io_error';
}

function listFailure(operationId: string, code: Extract<PersonalizationSecretListResponse, { ok: false }>['code']): PersonalizationSecretListResponse {
  return PersonalizationSecretListResponseSchema.parse({
    ok: false, contractVersion: PERSONALIZATION_SECRET_CONTRACT_VERSION, operationId, code,
  });
}

function setFailure(operationId: string, code: Exclude<Extract<PersonalizationSecretSetResponse, { ok: false }>['code'], 'revision_conflict'>): PersonalizationSecretSetResponse {
  return PersonalizationSecretSetResponseSchema.parse({
    ok: false, contractVersion: PERSONALIZATION_SECRET_CONTRACT_VERSION, operationId, code,
  });
}

function setConflict(operationId: string, currentRevision: number): PersonalizationSecretSetResponse {
  return PersonalizationSecretSetResponseSchema.parse({
    ok: false, contractVersion: PERSONALIZATION_SECRET_CONTRACT_VERSION,
    operationId, code: 'revision_conflict', currentRevision,
  });
}

function removeFailure(operationId: string, code: Exclude<Extract<PersonalizationSecretRemoveResponse, { ok: false }>['code'], 'revision_conflict'>): PersonalizationSecretRemoveResponse {
  return PersonalizationSecretRemoveResponseSchema.parse({
    ok: false, contractVersion: PERSONALIZATION_SECRET_CONTRACT_VERSION, operationId, code,
  });
}

function removeConflict(operationId: string, currentRevision: number): PersonalizationSecretRemoveResponse {
  return PersonalizationSecretRemoveResponseSchema.parse({
    ok: false, contractVersion: PERSONALIZATION_SECRET_CONTRACT_VERSION,
    operationId, code: 'revision_conflict', currentRevision,
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
