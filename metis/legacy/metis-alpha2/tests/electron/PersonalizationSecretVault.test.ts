import fs from 'node:fs';

import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { realTempRoot } from './helpers/realTempDir.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PersonalizationSecretVault,
  type PersonalizationSafeStoragePort,
  type PersonalizationSecretVaultIo,
} from '../../electron/PersonalizationSecretVault.js';

const roots: string[] = [];
const FILE_NAME = 'personalization-secrets.v1.json';
let operationSequence = 1;

function operationId(): string {
  const suffix = operationSequence.toString().padStart(12, '0');
  operationSequence += 1;
  return `00000000-0000-4000-8000-${suffix}`;
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(realTempRoot(), 'metis-personalization-secret-vault-'));
  roots.push(root);
  return root;
}

class AesSafeStorage implements PersonalizationSafeStoragePort {
  readonly #key: Buffer;
  available = true;
  decryptFails = false;
  encryptFails = false;

  constructor(key: Buffer = randomBytes(32)) {
    this.#key = Buffer.from(key);
  }

  isEncryptionAvailable(): boolean { return this.available; }
  getSelectedStorageBackend(): string { return 'secret-service'; }

  encryptString(plainText: string): Buffer {
    if (this.encryptFails) throw new Error('encrypt failed');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  }

  decryptString(encryptedValue: Buffer): string {
    if (this.decryptFails) throw new Error('decrypt failed');
    const nonce = encryptedValue.subarray(0, 12);
    const tag = encryptedValue.subarray(12, 28);
    const ciphertext = encryptedValue.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.#key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}

function setRequest(name: string, value: string, expectedRevision: number) {
  return { contractVersion: 1, operationId: operationId(), expectedRevision, name, value };
}

function listRequest() {
  return { contractVersion: 1, operationId: operationId() };
}

function removeRequest(name: string, expectedRevision: number) {
  return { contractVersion: 1, operationId: operationId(), expectedRevision, name };
}

function realIo(overrides: Partial<PersonalizationSecretVaultIo> = {}): PersonalizationSecretVaultIo {
  return {
    fsyncFile: (fd) => fs.fsyncSync(fd),
    fsyncDirectory: (directory) => {
      if (process.platform === 'win32') return;
      const fd = fs.openSync(directory, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    },
    rename: (source, destination) => fs.renameSync(source, destination),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('PersonalizationSecretVault', () => {
  it('encrypts at rest, exposes metadata only, and resolves plaintext only through the main-only API', async () => {
    const root = temporaryRoot();
    const storage = new AesSafeStorage();
    const vault = new PersonalizationSecretVault(root, storage, { now: () => 100 });
    const plaintext = 'zotero-secret-8cb07d0e';
    const saved = await vault.set(setRequest('ZOTERO_API_KEY', plaintext, 0));
    expect(saved).toMatchObject({
      ok: true,
      revision: 1,
      secret: { name: 'ZOTERO_API_KEY', createdAt: 100, updatedAt: 100 },
    });
    expect(JSON.stringify(saved)).not.toContain(plaintext);
    const listed = vault.list(listRequest());
    expect(listed).toMatchObject({
      ok: true,
      revision: 1,
      secrets: [{ name: 'ZOTERO_API_KEY', createdAt: 100, updatedAt: 100 }],
    });
    expect(Object.keys(listed.ok ? listed.secrets[0]! : {}).sort()).toEqual(['createdAt', 'name', 'updatedAt']);
    expect(vault.resolve('${secret:ZOTERO_API_KEY}')).toBe(plaintext);
    expect(vault.resolve('${secret:PATH}')).toBeUndefined();

    const raw = fs.readFileSync(path.join(root, FILE_NAME), 'utf8');
    expect(raw).not.toContain(plaintext);
    expect(raw).not.toContain('${secret:ZOTERO_API_KEY}');
    expect(raw).toContain('ciphertextSha256');
    expect(raw).toContain('valueHmac');
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(root, FILE_NAME)).mode & 0o777).toBe(0o600);
    }
  });

  it('updates with monotonic timestamps and recovers after a fresh vault restart', async () => {
    const root = temporaryRoot();
    const storage = new AesSafeStorage();
    let now = 200;
    const first = new PersonalizationSecretVault(root, storage, { now: () => now });
    expect((await first.set(setRequest('OPENALEX_API_KEY', 'first-value', 0))).ok).toBe(true);
    now = 150;
    const updated = await first.set(setRequest('OPENALEX_API_KEY', 'second-value', 1));
    expect(updated).toMatchObject({
      ok: true,
      revision: 2,
      secret: { name: 'OPENALEX_API_KEY', createdAt: 200, updatedAt: 201 },
    });
    const restarted = new PersonalizationSecretVault(root, storage, { now: () => 300 });
    expect(restarted.resolve('${secret:OPENALEX_API_KEY}')).toBe('second-value');
    expect(restarted.list(listRequest())).toMatchObject({ ok: true, revision: 2 });
  });

  it('serializes concurrent CAS writers so exactly one stale revision wins', async () => {
    const root = temporaryRoot();
    const storage = new AesSafeStorage();
    const left = new PersonalizationSecretVault(root, storage, { now: () => 300 });
    const right = new PersonalizationSecretVault(root, storage, { now: () => 301 });
    const [leftResult, rightResult] = await Promise.all([
      left.set(setRequest('ZOTERO_API_KEY', 'left-value', 0)),
      right.set(setRequest('OPENALEX_API_KEY', 'right-value', 0)),
    ]);
    const results = [leftResult, rightResult];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)[0]).toMatchObject({
      ok: false, code: 'revision_conflict', currentRevision: 1,
    });
    const listed = left.list(listRequest());
    expect(listed.ok && listed.secrets).toHaveLength(1);
  });

  it('rejects stale set/remove revisions without changing disk state', async () => {
    const root = temporaryRoot();
    const storage = new AesSafeStorage();
    const vault = new PersonalizationSecretVault(root, storage, { now: () => 400 });
    await vault.set(setRequest('ZOTERO_API_KEY', 'original-value', 0));
    const before = fs.readFileSync(path.join(root, FILE_NAME));
    expect(await vault.set(setRequest('ZOTERO_API_KEY', 'forged-value', 0))).toMatchObject({
      ok: false, code: 'revision_conflict', currentRevision: 1,
    });
    expect(await vault.remove(removeRequest('ZOTERO_API_KEY', 0))).toMatchObject({
      ok: false, code: 'revision_conflict', currentRevision: 1,
    });
    expect(fs.readFileSync(path.join(root, FILE_NAME))).toEqual(before);
    expect(vault.resolve('${secret:ZOTERO_API_KEY}')).toBe('original-value');
  });

  it('removes atomically and never returns the removed value', async () => {
    const root = temporaryRoot();
    const storage = new AesSafeStorage();
    const vault = new PersonalizationSecretVault(root, storage, { now: () => 500 });
    await vault.set(setRequest('ZOTERO_API_KEY', 'remove-me-secret', 0));
    const removed = await vault.remove(removeRequest('ZOTERO_API_KEY', 1));
    expect(removed).toMatchObject({ ok: true, removed: true, name: 'ZOTERO_API_KEY', revision: 2 });
    expect(JSON.stringify(removed)).not.toContain('remove-me-secret');
    expect(vault.resolve('${secret:ZOTERO_API_KEY}')).toBeUndefined();
    expect(vault.list(listRequest())).toMatchObject({ ok: true, revision: 2, secrets: [] });
  });

  it('returns fixed failures for unavailable storage, encryption, and decryption without echoing secrets', async () => {
    const root = temporaryRoot();
    const storage = new AesSafeStorage();
    storage.available = false;
    const unavailable = new PersonalizationSecretVault(root, storage);
    const secret = 'must-never-appear-in-error';
    const result = await unavailable.set(setRequest('ZOTERO_API_KEY', secret, 0));
    expect(result).toMatchObject({ ok: false, code: 'storage_unavailable' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(unavailable.list(listRequest())).toMatchObject({ ok: false, code: 'storage_unavailable' });

    storage.available = true;
    storage.encryptFails = true;
    const encryptFailure = await unavailable.set(setRequest('ZOTERO_API_KEY', secret, 0));
    expect(encryptFailure).toMatchObject({ ok: false, code: 'io_error' });
    expect(JSON.stringify(encryptFailure)).not.toContain(secret);
    storage.encryptFails = false;
    expect((await unavailable.set(setRequest('ZOTERO_API_KEY', secret, 0))).ok).toBe(true);
    storage.decryptFails = true;
    expect(unavailable.list(listRequest())).toMatchObject({ ok: false, code: 'integrity_error' });
    expect(unavailable.resolve('${secret:ZOTERO_API_KEY}')).toBeUndefined();
  });

  it('detects ciphertext hash, file HMAC, extra-field and reordered-entry tampering', async () => {
    const mutations: Array<(record: Record<string, unknown>) => void> = [
      (record) => {
        const mac = String(record.mac);
        record.mac = `${mac.slice(0, -1)}${mac.endsWith('0') ? '1' : '0'}`;
      },
      (record) => {
        const entries = record.entries as Array<Record<string, unknown>>;
        entries[0]!.ciphertextSha256 = '0'.repeat(64);
      },
      (record) => { record.extra = true; },
    ];
    for (const mutate of mutations) {
      const root = temporaryRoot();
      const storage = new AesSafeStorage();
      const vault = new PersonalizationSecretVault(root, storage, { now: () => 600 });
      await vault.set(setRequest('ZOTERO_API_KEY', 'tamper-target', 0));
      const filePath = path.join(root, FILE_NAME);
      const record = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      mutate(record);
      fs.writeFileSync(filePath, JSON.stringify(record), { mode: 0o600 });
      if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
      expect(vault.list(listRequest())).toMatchObject({ ok: false, code: 'integrity_error' });
      expect(vault.resolve('${secret:ZOTERO_API_KEY}')).toBeUndefined();
    }

    const root = temporaryRoot();
    const storage = new AesSafeStorage();
    const vault = new PersonalizationSecretVault(root, storage, { now: () => 610 });
    await vault.set(setRequest('ZOTERO_API_KEY', 'one', 0));
    await vault.set(setRequest('OPENALEX_API_KEY', 'two', 1));
    const filePath = path.join(root, FILE_NAME);
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { entries: unknown[] };
    record.entries.reverse();
    fs.writeFileSync(filePath, JSON.stringify(record));
    if (process.platform !== 'win32') fs.chmodSync(filePath, 0o600);
    expect(vault.list(listRequest())).toMatchObject({ ok: false, code: 'integrity_error' });
  });

  it('rejects a symlink/junction root and a symlink final vault file', async () => {
    const realRoot = temporaryRoot();
    const linkedRoot = path.join(path.dirname(realRoot), `${path.basename(realRoot)}-link`);
    try {
      fs.symlinkSync(realRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
      roots.push(linkedRoot);
      expect(() => new PersonalizationSecretVault(linkedRoot, new AesSafeStorage())).toThrow('Unsafe secret vault directory');
    } catch (error) {
      if (process.platform !== 'win32' || (error as { code?: string }).code !== 'EPERM') throw error;
    }

    const root = temporaryRoot();
    const outside = path.join(temporaryRoot(), 'outside.json');
    fs.writeFileSync(outside, '{}');
    const filePath = path.join(root, FILE_NAME);
    try {
      fs.symlinkSync(outside, filePath, 'file');
      const vault = new PersonalizationSecretVault(root, new AesSafeStorage());
      expect(vault.list(listRequest())).toMatchObject({ ok: false, code: 'integrity_error' });
      expect(await vault.set(setRequest('ZOTERO_API_KEY', 'never-written', 0)))
        .toMatchObject({ ok: false, code: 'integrity_error' });
    } catch (error) {
      if (process.platform !== 'win32' || (error as { code?: string }).code !== 'EPERM') throw error;
    }
  });

  it('detects a path swap after opening the original file descriptor', async () => {
    const root = temporaryRoot();
    const storage = new AesSafeStorage();
    const vault = new PersonalizationSecretVault(root, storage, { now: () => 700 });
    await vault.set(setRequest('ZOTERO_API_KEY', 'stable-secret', 0));
    const filePath = path.join(root, FILE_NAME);
    const moved = path.join(root, 'moved.json');
    const originalRead = fs.readFileSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, options?: unknown) => {
      if (!swapped && typeof target === 'number') {
        swapped = true;
        fs.renameSync(filePath, moved);
        fs.writeFileSync(filePath, '{}', { mode: 0o600 });
      }
      return originalRead(target, options as never);
    }) as typeof fs.readFileSync);
    expect(vault.list(listRequest())).toMatchObject({ ok: false, code: 'integrity_error' });
    expect(vault.resolve('${secret:ZOTERO_API_KEY}')).toBeUndefined();
  });

  it('preserves the old committed vault when atomic rename fails', async () => {
    const root = temporaryRoot();
    const storage = new AesSafeStorage();
    const initial = new PersonalizationSecretVault(root, storage, { now: () => 800 });
    await initial.set(setRequest('ZOTERO_API_KEY', 'durable-old-secret', 0));
    const failing = new PersonalizationSecretVault(root, storage, {
      now: () => 801,
      io: realIo({ rename: () => { throw new Error('rename failed'); } }),
    });
    const result = await failing.set(setRequest('ZOTERO_API_KEY', 'new-secret-never-committed', 1));
    expect(result).toMatchObject({ ok: false, code: 'io_error' });
    const restarted = new PersonalizationSecretVault(root, storage);
    expect(restarted.resolve('${secret:ZOTERO_API_KEY}')).toBe('durable-old-secret');
    expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('fails closed on unsafe file permissions where POSIX mode enforcement is available', async () => {
    if (process.platform === 'win32') return;
    const root = temporaryRoot();
    const storage = new AesSafeStorage();
    const vault = new PersonalizationSecretVault(root, storage, { now: () => 900 });
    await vault.set(setRequest('ZOTERO_API_KEY', 'permission-secret', 0));
    fs.chmodSync(path.join(root, FILE_NAME), 0o644);
    expect(vault.list(listRequest())).toMatchObject({ ok: false, code: 'integrity_error' });
    expect(vault.resolve('${secret:ZOTERO_API_KEY}')).toBeUndefined();
  });
});
