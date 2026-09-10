import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FirstRunSecureStorage } from './FirstRunSetupService.js';
import type { ProviderConfig } from '../engine/core/types.js';
import {
  PROVIDER_PROFILE_CONTRACT_VERSION,
  PROVIDER_PROFILE_LIMITS,
  ProviderProfileIdSchema,
  ProviderProfileMaxContextTokensSchema,
  ProviderProfileNameSchema,
  ProviderProfileSaveRequestSchema,
  ProviderProfileSummarySchema,
  type ProviderProfileDeleteRequest,
  type ProviderProfileErrorCode,
  type ProviderProfileSaveRequest,
  type ProviderProfileSummary,
  type ProviderProfileSwitchRequest,
} from '../engine/runtime/ProviderProfileContract.js';
import { SETUP_RUNTIME_LIMITS, SetupBaseUrlSchema, SetupModelSchema } from '../engine/runtime/SetupRuntimeContract.js';

const FILE_NAME = 'provider-profiles.v1.json';
const FILE_FORMAT = 'metis-provider-profiles';
const FILE_SCHEMA_VERSION = 1 as const;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const FILE_MAC_DOMAIN = 'metis:provider-profiles:file:v1\0';
const LOCK_ATTEMPTS = 200;
const LOCK_RETRY_MS = 5;

const StoredProfileSchema = z.strictObject({
  id: ProviderProfileIdSchema,
  name: ProviderProfileNameSchema,
  baseUrl: SetupBaseUrlSchema,
  model: SetupModelSchema,
  encryptedApiKey: z.string().min(4).max(65_536).regex(BASE64_PATTERN),
  timeout: z.number().int().min(1_000).max(1_800_000),
  maxRetries: z.number().int().min(0).max(SETUP_RUNTIME_LIMITS.strategyRetries),
  retryBackoffSeconds: z.number().min(0).max(300),
  vision: z.boolean(),
  maxContextTokens: ProviderProfileMaxContextTokensSchema,
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

const StoredEnvelopeSchema = z.strictObject({
  format: z.literal(FILE_FORMAT),
  schemaVersion: z.literal(FILE_SCHEMA_VERSION),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  activeId: ProviderProfileIdSchema.nullable(),
  encryptedIntegrityKey: z.string().min(4).max(65_536).regex(BASE64_PATTERN),
  profiles: z.array(StoredProfileSchema).max(PROVIDER_PROFILE_LIMITS.profiles),
  mac: z.string().regex(/^[a-f0-9]{64}$/u),
}).superRefine((value, context) => {
  const ids = value.profiles.map((profile) => profile.id);
  const names = value.profiles.map((profile) => profile.name.toLocaleLowerCase());
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['profiles'], message: 'Provider IDs must be unique' });
  if (new Set(names).size !== names.length) context.addIssue({ code: 'custom', path: ['profiles'], message: 'Provider names must be unique' });
  if (value.activeId !== null && !ids.includes(value.activeId)) {
    context.addIssue({ code: 'custom', path: ['activeId'], message: 'Active provider must exist' });
  }
  for (let index = 0; index < value.profiles.length; index += 1) {
    if (value.profiles[index]!.updatedAt < value.profiles[index]!.createdAt) {
      context.addIssue({ code: 'custom', path: ['profiles', index, 'updatedAt'], message: 'Provider timestamps are invalid' });
    }
  }
});

type StoredProfile = z.infer<typeof StoredProfileSchema>;
type StoredEnvelope = z.infer<typeof StoredEnvelopeSchema>;
type UnsignedEnvelope = Omit<StoredEnvelope, 'mac'>;

export interface ProviderProfileStoreIo {
  fsyncFile(fd: number): void;
  fsyncDirectory(directory: string): void;
  rename(source: string, destination: string): void;
}

const DEFAULT_IO: ProviderProfileStoreIo = {
  fsyncFile: (fd) => fs.fsyncSync(fd),
  fsyncDirectory: (directory) => {
    if (process.platform === 'win32') return;
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  },
  rename: (source, destination) => fs.renameSync(source, destination),
};

type StoreResult<T> = { ok: true; value: T } | { ok: false; code: ProviderProfileErrorCode; currentRevision?: number };

/**
 * Main-process-only encrypted repository for named model connections.
 *
 * The file MAC binds every piece of routing metadata (including baseUrl and
 * model) to an OS-protected integrity key. Therefore a local file modification
 * cannot redirect a decrypted API key to an attacker-controlled endpoint.
 */
export class ProviderProfileStore {
  readonly #root: string;
  readonly #filePath: string;
  readonly #lockPath: string;
  readonly #legacyPath: string;
  readonly #storage: FirstRunSecureStorage;
  readonly #io: ProviderProfileStoreIo;
  readonly #now: () => number;

  constructor(
    dataDir: string,
    secureStorage: FirstRunSecureStorage,
    options?: { io?: ProviderProfileStoreIo; now?: () => number },
  ) {
    this.#root = requireCanonicalDirectory(dataDir);
    this.#filePath = path.join(this.#root, FILE_NAME);
    this.#lockPath = path.join(this.#root, `.${FILE_NAME}.lock`);
    this.#legacyPath = path.join(this.#root, 'providers.json');
    this.#storage = secureStorage;
    this.#io = options?.io ?? DEFAULT_IO;
    this.#now = options?.now ?? Date.now;
  }

  /**
   * Creates the safe envelope or migrates the old plaintext file exactly once.
   * Legacy plaintext remains untouched if any validation/encryption/write step
   * fails, and it is never used as a runtime fallback after this method returns.
   */
  async initialize(fallback?: ProviderConfig | null): Promise<StoreResult<{ revision: number }>> {
    if (!this.#storageAvailable()) return { ok: false, code: 'storage_unavailable' };
    let lockFd: number | undefined;
    try {
      lockFd = await this.#acquireLock();
      const existing = this.#readEnvelope();
      if (existing) return { ok: true, value: { revision: existing.revision } };

      const legacy = this.#readLegacy();
      const migrated = this.#migrateLegacyProfiles(legacy.profiles);
      if (migrated.length === 0 && fallback?.apiKey) migrated.push(this.#profileFromConfig('Default', fallback));
      const activeId = migrated.some((profile) => profile.id === legacy.activeId)
        ? legacy.activeId
        : migrated[0]?.id ?? null;
      const envelope = this.#signEnvelope({
        format: FILE_FORMAT,
        schemaVersion: FILE_SCHEMA_VERSION,
        revision: 1,
        activeId,
        encryptedIntegrityKey: this.#storage.encrypt(randomBytes(32).toString('base64url')),
        profiles: migrated,
      });
      this.#writeEnvelope(envelope);
      if (fs.existsSync(this.#legacyPath)) fs.rmSync(this.#legacyPath, { force: true });
      return { ok: true, value: { revision: envelope.revision } };
    } catch (error) {
      return { ok: false, code: failureCode(error) };
    } finally {
      if (lockFd !== undefined) this.#releaseLock(lockFd);
    }
  }

  /** Seeds the first active profile after a successful first-run setup. */
  async ensureActiveFromConfig(config: ProviderConfig, name = 'Default'): Promise<StoreResult<{ revision: number; profile: ProviderProfileSummary }>> {
    if (!this.#storageAvailable()) return { ok: false, code: 'storage_unavailable' };
    let lockFd: number | undefined;
    try {
      lockFd = await this.#acquireLock();
      const envelope = this.#requireEnvelope();
      const active = envelope.activeId ? envelope.profiles.find((profile) => profile.id === envelope.activeId) : undefined;
      if (active) return { ok: true, value: { revision: envelope.revision, profile: this.#summary(active, envelope.activeId) } };
      if (envelope.profiles.length >= PROVIDER_PROFILE_LIMITS.profiles) return { ok: false, code: 'profile_limit_reached' };
      const profile = this.#profileFromConfig(name, config);
      const next = this.#signEnvelope({
        ...unsignedEnvelope(envelope),
        revision: envelope.revision + 1,
        activeId: profile.id,
        profiles: [...envelope.profiles, profile],
      });
      this.#writeEnvelope(next);
      return { ok: true, value: { revision: next.revision, profile: this.#summary(profile, next.activeId) } };
    } catch (error) {
      return { ok: false, code: failureCode(error) };
    } finally {
      if (lockFd !== undefined) this.#releaseLock(lockFd);
    }
  }

  list(): StoreResult<{ revision: number; profiles: ProviderProfileSummary[] }> {
    if (!this.#storageAvailable()) return { ok: false, code: 'storage_unavailable' };
    try {
      const envelope = this.#requireEnvelope();
      return { ok: true, value: { revision: envelope.revision, profiles: this.#summaries(envelope) } };
    } catch (error) {
      return { ok: false, code: failureCode(error) };
    }
  }

  configFor(id: string): StoreResult<ProviderConfig> {
    if (!this.#storageAvailable()) return { ok: false, code: 'storage_unavailable' };
    try {
      const envelope = this.#requireEnvelope();
      const profile = envelope.profiles.find((candidate) => candidate.id === id);
      if (!profile) return { ok: false, code: 'not_found' };
      return { ok: true, value: this.#decryptProfile(profile) };
    } catch (error) {
      return { ok: false, code: failureCode(error) };
    }
  }

  configForSave(request: ProviderProfileSaveRequest): StoreResult<ProviderConfig> {
    if (!this.#storageAvailable()) return { ok: false, code: 'storage_unavailable' };
    try {
      const envelope = this.#requireEnvelope();
      if (envelope.revision !== request.expectedRevision) return conflict(envelope.revision);
      const existing = request.id ? envelope.profiles.find((profile) => profile.id === request.id) : undefined;
      if (request.id && !existing) return { ok: false, code: 'not_found' };
      const apiKey = request.keyMode === 'saved'
        ? existing && this.#decryptProfile(existing).apiKey
        : request.newApiKey;
      if (!apiKey) return { ok: false, code: 'saved_key_unavailable' };
      return {
        ok: true,
        value: {
          baseUrl: request.baseUrl,
          apiKey,
          model: request.model,
          timeout: request.timeout ?? existing?.timeout ?? 30_000,
          maxRetries: request.maxRetries ?? existing?.maxRetries ?? 2,
          retryBackoffSeconds: request.retryBackoffSeconds ?? existing?.retryBackoffSeconds ?? 1,
          vision: request.vision,
          maxContextTokens: request.maxContextTokens || undefined,
        },
      };
    } catch (error) {
      return { ok: false, code: failureCode(error) };
    }
  }

  async save(request: ProviderProfileSaveRequest): Promise<StoreResult<{ revision: number; profile: ProviderProfileSummary; activeId: string | null }>> {
    if (!ProviderProfileSaveRequestSchema.safeParse(request).success) return { ok: false, code: 'invalid_request' };
    if (!this.#storageAvailable()) return { ok: false, code: 'storage_unavailable' };
    let lockFd: number | undefined;
    try {
      lockFd = await this.#acquireLock();
      const envelope = this.#requireEnvelope();
      if (envelope.revision !== request.expectedRevision) return conflict(envelope.revision);
      const existingIndex = request.id ? envelope.profiles.findIndex((profile) => profile.id === request.id) : -1;
      if (request.id && existingIndex < 0) return { ok: false, code: 'not_found' };
      if (existingIndex < 0 && envelope.profiles.length >= PROVIDER_PROFILE_LIMITS.profiles) return { ok: false, code: 'profile_limit_reached' };
      const nameTaken = envelope.profiles.some((profile) => profile.id !== request.id && profile.name.localeCompare(request.name, undefined, { sensitivity: 'accent' }) === 0);
      if (nameTaken) return { ok: false, code: 'integrity_error' };

      const existing = existingIndex >= 0 ? envelope.profiles[existingIndex]! : undefined;
      const apiKey = request.keyMode === 'saved'
        ? existing && this.#decryptProfile(existing).apiKey
        : request.newApiKey;
      if (!apiKey) return { ok: false, code: 'saved_key_unavailable' };
      const timestamp = monotonicTimestamp(this.#now(), existing?.updatedAt);
      const profile = StoredProfileSchema.parse({
        id: existing?.id ?? randomUUID(),
        name: request.name,
        baseUrl: request.baseUrl,
        model: request.model,
        encryptedApiKey: this.#storage.encrypt(apiKey),
        timeout: request.timeout ?? existing?.timeout ?? 30_000,
        maxRetries: request.maxRetries ?? existing?.maxRetries ?? 2,
        retryBackoffSeconds: request.retryBackoffSeconds ?? existing?.retryBackoffSeconds ?? 1,
        vision: request.vision,
        maxContextTokens: request.maxContextTokens,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
      const profiles = existingIndex >= 0
        ? envelope.profiles.map((item, index) => index === existingIndex ? profile : item)
        : [...envelope.profiles, profile];
      const next = this.#signEnvelope({
        ...unsignedEnvelope(envelope),
        revision: envelope.revision + 1,
        activeId: envelope.activeId ?? profile.id,
        profiles,
      });
      this.#writeEnvelope(next);
      return { ok: true, value: { revision: next.revision, profile: this.#summary(profile, next.activeId), activeId: next.activeId } };
    } catch (error) {
      return { ok: false, code: failureCode(error) };
    } finally {
      if (lockFd !== undefined) this.#releaseLock(lockFd);
    }
  }

  async activate(request: ProviderProfileSwitchRequest): Promise<StoreResult<{ revision: number; profile: ProviderProfileSummary }>> {
    if (!this.#storageAvailable()) return { ok: false, code: 'storage_unavailable' };
    let lockFd: number | undefined;
    try {
      lockFd = await this.#acquireLock();
      const envelope = this.#requireEnvelope();
      if (envelope.revision !== request.expectedRevision) return conflict(envelope.revision);
      const profile = envelope.profiles.find((candidate) => candidate.id === request.id);
      if (!profile) return { ok: false, code: 'not_found' };
      const next = this.#signEnvelope({ ...unsignedEnvelope(envelope), revision: envelope.revision + 1, activeId: profile.id });
      this.#writeEnvelope(next);
      return { ok: true, value: { revision: next.revision, profile: this.#summary(profile, next.activeId) } };
    } catch (error) {
      return { ok: false, code: failureCode(error) };
    } finally {
      if (lockFd !== undefined) this.#releaseLock(lockFd);
    }
  }

  async delete(request: ProviderProfileDeleteRequest): Promise<StoreResult<{ revision: number; activeId: string | null }>> {
    if (!this.#storageAvailable()) return { ok: false, code: 'storage_unavailable' };
    let lockFd: number | undefined;
    try {
      lockFd = await this.#acquireLock();
      const envelope = this.#requireEnvelope();
      if (envelope.revision !== request.expectedRevision) return conflict(envelope.revision);
      const target = envelope.profiles.find((candidate) => candidate.id === request.id);
      if (!target) return { ok: false, code: 'not_found' };
      const profiles = envelope.profiles.filter((candidate) => candidate.id !== request.id);
      let activeId = envelope.activeId;
      if (activeId === request.id) {
        if (!request.replacementActiveId || !profiles.some((profile) => profile.id === request.replacementActiveId)) {
          return { ok: false, code: 'active_profile_requires_replacement' };
        }
        activeId = request.replacementActiveId;
      }
      const next = this.#signEnvelope({ ...unsignedEnvelope(envelope), revision: envelope.revision + 1, activeId, profiles });
      this.#writeEnvelope(next);
      return { ok: true, value: { revision: next.revision, activeId: next.activeId } };
    } catch (error) {
      return { ok: false, code: failureCode(error) };
    } finally {
      if (lockFd !== undefined) this.#releaseLock(lockFd);
    }
  }

  /**
   * Restores the exact pre-mutation encrypted profile record when a prepared
   * runtime cannot commit. The caller must supply the revision it just wrote;
   * stale rollback attempts fail closed rather than overwriting a newer edit.
   */
  async restoreAfterFailedSave(
    previous: { id: string | null; name: string; config: ProviderConfig | null; activeId: string | null },
    expectedRevision: number,
  ): Promise<StoreResult<{ revision: number }>> {
    if (!this.#storageAvailable()) return { ok: false, code: 'storage_unavailable' };
    let lockFd: number | undefined;
    try {
      lockFd = await this.#acquireLock();
      const envelope = this.#requireEnvelope();
      if (envelope.revision !== expectedRevision) return conflict(envelope.revision);
      const without = previous.id ? envelope.profiles.filter((profile) => profile.id !== previous.id) : envelope.profiles;
      let profiles = without;
      if (previous.config && previous.id) {
        const timestamp = this.#now();
        const restored = StoredProfileSchema.parse({
          id: previous.id,
          name: previous.name,
          baseUrl: previous.config.baseUrl,
          model: previous.config.model,
          encryptedApiKey: this.#storage.encrypt(previous.config.apiKey),
          timeout: previous.config.timeout,
          maxRetries: previous.config.maxRetries,
          retryBackoffSeconds: previous.config.retryBackoffSeconds,
          vision: previous.config.vision === true,
          maxContextTokens: previous.config.maxContextTokens ?? 0,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        profiles = [...profiles, restored];
      }
      const activeId = previous.activeId && profiles.some((profile) => profile.id === previous.activeId)
        ? previous.activeId
        : profiles[0]?.id ?? null;
      const next = this.#signEnvelope({
        ...unsignedEnvelope(envelope),
        revision: envelope.revision + 1,
        activeId,
        profiles,
      });
      this.#writeEnvelope(next);
      return { ok: true, value: { revision: next.revision } };
    } catch (error) {
      return { ok: false, code: failureCode(error) };
    } finally {
      if (lockFd !== undefined) this.#releaseLock(lockFd);
    }
  }

  async reset(expectedRevision: number): Promise<StoreResult<{ revision: number }>> {
    if (!this.#storageAvailable()) return { ok: false, code: 'storage_unavailable' };
    let lockFd: number | undefined;
    try {
      lockFd = await this.#acquireLock();
      const envelope = this.#requireEnvelope();
      if (envelope.revision !== expectedRevision) return conflict(envelope.revision);
      const next = this.#signEnvelope({ ...unsignedEnvelope(envelope), revision: envelope.revision + 1, activeId: null, profiles: [] });
      this.#writeEnvelope(next);
      return { ok: true, value: { revision: next.revision } };
    } catch (error) {
      return { ok: false, code: failureCode(error) };
    } finally {
      if (lockFd !== undefined) this.#releaseLock(lockFd);
    }
  }

  #storageAvailable(): boolean {
    try { return this.#storage.protection === 'os-protected' && this.#storage.isAvailable(); } catch { return false; }
  }

  #readEnvelope(): StoredEnvelope | null {
    this.#assertRoot();
    const stat = safeLstat(this.#filePath);
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES || stat.size < 128) throw new Error('integrity');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('integrity');
    const parsed = StoredEnvelopeSchema.safeParse(JSON.parse(fs.readFileSync(this.#filePath, 'utf8')) as unknown);
    if (!parsed.success) throw new Error('integrity');
    const envelope = parsed.data;
    const integrityText = this.#storage.decrypt(envelope.encryptedIntegrityKey);
    const integrityKey = Buffer.from(integrityText, 'base64url');
    if (integrityKey.length !== 32 || !timingSafeHex(envelope.mac, fileMac(integrityKey, unsignedEnvelope(envelope)))) throw new Error('integrity');
    return envelope;
  }

  #requireEnvelope(): StoredEnvelope {
    const envelope = this.#readEnvelope();
    if (!envelope) throw new Error('io');
    return envelope;
  }

  #signEnvelope(unsigned: UnsignedEnvelope): StoredEnvelope {
    const integrityText = this.#storage.decrypt(unsigned.encryptedIntegrityKey);
    const integrityKey = Buffer.from(integrityText, 'base64url');
    if (integrityKey.length !== 32) throw new Error('integrity');
    return StoredEnvelopeSchema.parse({ ...unsigned, mac: fileMac(integrityKey, unsigned) });
  }

  #writeEnvelope(envelope: StoredEnvelope): void {
    const checked = StoredEnvelopeSchema.parse(envelope);
    const serialized = canonicalJson(checked);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) throw new Error('io');
    this.#assertRoot();
    const temporary = path.join(this.#root, `.${FILE_NAME}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, serialized, 'utf8');
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      this.#io.fsyncFile(fd);
      fs.closeSync(fd);
      fd = undefined;
      this.#io.rename(temporary, this.#filePath);
      const committed = this.#readEnvelope();
      if (!committed || committed.revision !== checked.revision || committed.mac !== checked.mac) throw new Error('integrity');
      this.#io.fsyncDirectory(this.#root);
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* best effort */ }
      try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    }
  }

  #decryptProfile(profile: StoredProfile): ProviderConfig {
    return {
      baseUrl: profile.baseUrl,
      apiKey: this.#storage.decrypt(profile.encryptedApiKey),
      model: profile.model,
      timeout: profile.timeout,
      maxRetries: profile.maxRetries,
      retryBackoffSeconds: profile.retryBackoffSeconds,
      vision: profile.vision,
      maxContextTokens: profile.maxContextTokens || undefined,
    };
  }

  #summary(profile: StoredProfile, activeId: string | null): ProviderProfileSummary {
    return ProviderProfileSummarySchema.parse({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      vision: profile.vision,
      maxContextTokens: profile.maxContextTokens,
      timeout: profile.timeout,
      maxRetries: profile.maxRetries,
      apiKeyStored: true,
      isActive: profile.id === activeId,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    });
  }

  #summaries(envelope: StoredEnvelope): ProviderProfileSummary[] {
    return envelope.profiles.map((profile) => this.#summary(profile, envelope.activeId));
  }

  #profileFromConfig(name: string, config: ProviderConfig): StoredProfile {
    const timestamp = this.#now();
    return StoredProfileSchema.parse({
      id: randomUUID(),
      name,
      baseUrl: config.baseUrl,
      model: config.model,
      encryptedApiKey: this.#storage.encrypt(config.apiKey),
      timeout: config.timeout,
      maxRetries: config.maxRetries,
      retryBackoffSeconds: config.retryBackoffSeconds,
      vision: config.vision === true,
      maxContextTokens: config.maxContextTokens ?? 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  #migrateLegacyProfiles(raw: Array<Record<string, unknown>>): StoredProfile[] {
    const profiles: StoredProfile[] = [];
    const names = new Set<string>();
    for (const candidate of raw) {
      if (profiles.length >= PROVIDER_PROFILE_LIMITS.profiles) break;
      const baseUrl = SetupBaseUrlSchema.safeParse(candidate.baseUrl);
      const model = SetupModelSchema.safeParse(candidate.model);
      const name = ProviderProfileNameSchema.safeParse(candidate.name);
      const apiKey = typeof candidate.apiKey === 'string' && candidate.apiKey.length >= 8 ? candidate.apiKey : undefined;
      if (!baseUrl.success || !model.success || !name.success || !apiKey || names.has(name.data.toLocaleLowerCase())) continue;
      names.add(name.data.toLocaleLowerCase());
      const timestamp = this.#now();
      profiles.push(StoredProfileSchema.parse({
        id: ProviderProfileIdSchema.safeParse(candidate.id).success ? candidate.id : randomUUID(),
        name: name.data,
        baseUrl: baseUrl.data,
        model: model.data,
        encryptedApiKey: this.#storage.encrypt(apiKey),
        timeout: 30_000,
        maxRetries: 2,
        retryBackoffSeconds: 1,
        vision: candidate.vision === true,
        maxContextTokens: ProviderProfileMaxContextTokensSchema.safeParse(candidate.maxContextTokens).success ? candidate.maxContextTokens : 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }));
    }
    return profiles;
  }

  #readLegacy(): { profiles: Array<Record<string, unknown>>; activeId: string | null } {
    try {
      const stat = safeLstat(this.#legacyPath);
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return { profiles: [], activeId: null };
      const raw = JSON.parse(fs.readFileSync(this.#legacyPath, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object') return { profiles: [], activeId: null };
      const profiles = Reflect.get(raw, 'providers');
      const activeId = Reflect.get(raw, 'activeId');
      return {
        profiles: Array.isArray(profiles) ? profiles.filter((profile): profile is Record<string, unknown> => Boolean(profile) && typeof profile === 'object') : [],
        activeId: ProviderProfileIdSchema.safeParse(activeId).success ? activeId as string : null,
      };
    } catch {
      return { profiles: [], activeId: null };
    }
  }

  async #acquireLock(): Promise<number> {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      this.#assertRoot();
      try {
        const fd = fs.openSync(this.#lockPath, 'wx', 0o600);
        if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
        this.#io.fsyncFile(fd);
        return fd;
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error;
        await delay(LOCK_RETRY_MS);
      }
    }
    throw new Error('io');
  }

  #releaseLock(fd: number): void {
    try { fs.closeSync(fd); } catch { /* best effort */ }
    try {
      const stat = safeLstat(this.#lockPath);
      if (stat?.isFile() && !stat.isSymbolicLink()) fs.rmSync(this.#lockPath, { force: true });
    } catch { /* leave anomalous lock in place to fail closed */ }
  }

  #assertRoot(): void {
    const stat = fs.lstatSync(this.#root);
    const real = fs.realpathSync.native(this.#root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(this.#root, real)) throw new Error('integrity');
  }
}

function requireCanonicalDirectory(input: string): string {
  const resolved = path.resolve(input);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe provider profile directory');
  const real = fs.realpathSync.native(resolved);
  if (!samePath(resolved, real)) throw new Error('Unsafe provider profile directory');
  return real;
}

function unsignedEnvelope(envelope: StoredEnvelope): UnsignedEnvelope {
  const { mac: _mac, ...unsigned } = envelope;
  void _mac;
  return unsigned;
}

function fileMac(key: Buffer, envelope: UnsignedEnvelope): string {
  return createHmac('sha256', key).update(FILE_MAC_DOMAIN).update(canonicalJson(envelope), 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function timingSafeHex(left: string, right: string): boolean {
  const first = Buffer.from(left, 'hex');
  const second = Buffer.from(right, 'hex');
  return first.length === second.length && timingSafeEqual(first, second);
}

function safeLstat(filePath: string): fs.Stats | null {
  try { return fs.lstatSync(filePath); } catch { return null; }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLocaleLowerCase() === right.toLocaleLowerCase() : left === right;
}

function monotonicTimestamp(now: number, previous?: number): number {
  return Math.max(now, (previous ?? -1) + 1);
}

function conflict(currentRevision: number): StoreResult<never> {
  return { ok: false, code: 'revision_conflict', currentRevision };
}

function failureCode(error: unknown): ProviderProfileErrorCode {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('integrity') || message.includes('decrypt') || message.includes('Unsafe')) return 'integrity_error';
  return 'io_error';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function profileMutationFailure(
  operationId: string,
  result: Extract<StoreResult<unknown>, { ok: false }>,
) {
  return {
    ok: false as const,
    contractVersion: PROVIDER_PROFILE_CONTRACT_VERSION,
    operationId,
    code: result.code,
    ...(result.currentRevision === undefined ? {} : { currentRevision: result.currentRevision }),
  };
}
