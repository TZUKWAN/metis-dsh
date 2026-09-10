import fs from 'node:fs';

import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { realTempRoot } from './helpers/realTempDir.mjs';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderProfileStore } from '../../electron/ProviderProfileStore.js';
import type { FirstRunSecureStorage } from '../../electron/FirstRunSetupService.js';

const roots: string[] = [];
let sequence = 0;

function root(): string {
  const value = fs.mkdtempSync(path.join(realTempRoot(), 'metis-provider-profiles-'));
  roots.push(value);
  return value;
}

function operationId(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`;
}

class AesStorage implements FirstRunSecureStorage {
  readonly protection = 'os-protected' as const;
  readonly #key = randomBytes(32);
  available = true;

  isAvailable(): boolean { return this.available; }

  encrypt(plainText: string): string {
    if (!this.available) throw new Error('storage unavailable');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
  }

  decrypt(cipherText: string): string {
    if (!this.available) throw new Error('storage unavailable');
    const input = Buffer.from(cipherText, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, input.subarray(0, 12));
    decipher.setAuthTag(input.subarray(12, 28));
    return Buffer.concat([decipher.update(input.subarray(28)), decipher.final()]).toString('utf8');
  }
}

function saveRequest(overrides: Partial<{
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  vision: boolean;
  maxContextTokens: number;
  keyMode: 'replace' | 'saved';
  newApiKey: string;
  expectedRevision: number;
}> = {}) {
  return {
    contractVersion: 1 as const,
    operationId: operationId(),
    expectedRevision: 1,
    name: 'Qwen research',
    baseUrl: 'https://example.test/v1',
    model: 'qwen3.5-122b-a10b',
    vision: false,
    maxContextTokens: 131072,
    keyMode: 'replace' as const,
    newApiKey: 'profile-secret-12345',
    ...overrides,
  };
}

afterEach(() => {
  for (const item of roots.splice(0)) fs.rmSync(item, { recursive: true, force: true });
});

describe('ProviderProfileStore', () => {
  it('encrypts a profile at rest and returns metadata-only summaries', async () => {
    const storage = new AesStorage();
    const store = new ProviderProfileStore(root(), storage);
    expect((await store.initialize()).ok).toBe(true);
    const saved = await store.save(saveRequest());
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    expect(JSON.stringify(saved)).not.toContain('profile-secret-12345');
    expect(JSON.stringify(saved)).not.toContain('encryptedApiKey');
    const listed = store.list();
    expect(listed.ok && listed.value.profiles).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('profile-secret-12345');
    expect(JSON.stringify(listed)).not.toContain('encryptedApiKey');

    const raw = fs.readFileSync(path.join(roots[0]!, 'provider-profiles.v1.json'), 'utf8');
    expect(raw).not.toContain('profile-secret-12345');
    expect(raw).toContain('encryptedApiKey');
    expect(raw).toContain('encryptedIntegrityKey');
  });

  it('rejects a tampered base URL without decrypting it into a usable config', async () => {
    const dataRoot = root();
    const store = new ProviderProfileStore(dataRoot, new AesStorage());
    await store.initialize();
    const saved = await store.save(saveRequest());
    expect(saved.ok).toBe(true);
    const file = path.join(dataRoot, 'provider-profiles.v1.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { profiles: Array<{ baseUrl: string }> };
    raw.profiles[0]!.baseUrl = 'https://attacker.example/v1';
    fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
    expect(store.list()).toMatchObject({ ok: false, code: 'integrity_error' });
  });

  it('requires a valid CAS revision and never accepts an old save', async () => {
    const store = new ProviderProfileStore(root(), new AesStorage());
    await store.initialize();
    const initial = await store.save(saveRequest());
    expect(initial.ok).toBe(true);
    const stale = await store.save(saveRequest({ expectedRevision: 1, name: 'Stale profile' }));
    expect(stale).toMatchObject({ ok: false, code: 'revision_conflict', currentRevision: 2 });
  });

  it('does not migrate or delete legacy plaintext when OS storage is unavailable', async () => {
    const dataRoot = root();
    const legacyPath = path.join(dataRoot, 'providers.json');
    const secret = 'legacy-provider-secret-12345';
    fs.writeFileSync(legacyPath, JSON.stringify({ providers: [{ id: 'legacy', name: 'Legacy', baseUrl: 'https://example.test/v1', model: 'qwen3.5-122b-a10b', apiKey: secret }] }));
    const storage = new AesStorage();
    storage.available = false;
    const store = new ProviderProfileStore(dataRoot, storage);
    await expect(store.initialize()).resolves.toMatchObject({ ok: false, code: 'storage_unavailable' });
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(fs.readFileSync(legacyPath, 'utf8')).toContain(secret);
    expect(fs.existsSync(path.join(dataRoot, 'provider-profiles.v1.json'))).toBe(false);
  });

  it('migrates legacy plaintext only after encrypted validation and removes the old executable source', async () => {
    const dataRoot = root();
    const legacyPath = path.join(dataRoot, 'providers.json');
    const secret = 'legacy-provider-secret-67890';
    fs.writeFileSync(legacyPath, JSON.stringify({ providers: [{ id: 'not-a-uuid', name: 'Legacy', baseUrl: 'https://example.test/v1', model: 'qwen3.5-122b-a10b', apiKey: secret }] }));
    const store = new ProviderProfileStore(dataRoot, new AesStorage());
    expect(await store.initialize()).toMatchObject({ ok: true });
    expect(fs.existsSync(legacyPath)).toBe(false);
    const raw = fs.readFileSync(path.join(dataRoot, 'provider-profiles.v1.json'), 'utf8');
    expect(raw).not.toContain(secret);
    expect(store.list()).toMatchObject({ ok: true });
  });

  it('requires an explicit replacement before deleting the active profile', async () => {
    const store = new ProviderProfileStore(root(), new AesStorage());
    await store.initialize();
    const first = await store.save(saveRequest());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await store.save(saveRequest({ expectedRevision: first.value.revision, name: 'Second profile' }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const rejected = await store.delete({
      contractVersion: 1,
      operationId: operationId(),
      expectedRevision: second.value.revision,
      id: first.value.profile.id,
    });
    expect(rejected).toMatchObject({ ok: false, code: 'active_profile_requires_replacement' });
    const accepted = await store.delete({
      contractVersion: 1,
      operationId: operationId(),
      expectedRevision: second.value.revision,
      id: first.value.profile.id,
      replacementActiveId: second.value.profile.id,
    });
    expect(accepted).toMatchObject({ ok: true, value: { activeId: second.value.profile.id } });
  });

  it('seeds the active profile from a first-run configuration exactly once', async () => {
    const dataRoot = root();
    const store = new ProviderProfileStore(dataRoot, new AesStorage());
    await store.initialize();
    const config = {
      baseUrl: 'https://example.test/v1',
      apiKey: 'first-run-secret-12345',
      model: 'qwen3.5-122b-a10b',
      timeout: 60_000,
      maxRetries: 3,
      retryBackoffSeconds: 1,
      vision: true,
      maxContextTokens: 131_072,
    };
    const seeded = await store.ensureActiveFromConfig(config);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    expect(seeded.value.profile.isActive).toBe(true);
    const listed = store.list();
    expect(listed.ok && listed.value.profiles).toHaveLength(1);
    // A second call must not duplicate the profile.
    const again = await store.ensureActiveFromConfig(config);
    expect(again.ok && again.value.revision).toBe(seeded.value.revision);
    expect(store.list().ok && store.list().value!.profiles).toHaveLength(1);
    const raw = fs.readFileSync(path.join(dataRoot, 'provider-profiles.v1.json'), 'utf8');
    expect(raw).not.toContain('first-run-secret-12345');
  });

  it('restores the previous profile record when a runtime commit fails', async () => {
    const dataRoot = root();
    const store = new ProviderProfileStore(dataRoot, new AesStorage());
    await store.initialize();
    const initial = await store.save(saveRequest());
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const previousConfig = store.configFor(initial.value.profile.id);
    expect(previousConfig.ok).toBe(true);
    if (!previousConfig.ok) return;

    const updated = await store.save(saveRequest({
      expectedRevision: initial.value.revision,
      id: initial.value.profile.id,
      name: 'Edited profile',
      model: 'qwen3.5-122b-a10b',
      newApiKey: 'replacement-secret-99999',
    }));
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;

    const rolledBack = await store.restoreAfterFailedSave({
      id: initial.value.profile.id,
      name: initial.value.profile.name,
      config: previousConfig.value,
      activeId: initial.value.profile.id,
    }, updated.value.revision);
    expect(rolledBack.ok).toBe(true);

    const restored = store.configFor(initial.value.profile.id);
    expect(restored.ok && restored.value.apiKey).toBe(previousConfig.value.apiKey);
    expect(restored.ok && restored.value.model).toBe(previousConfig.value.model);
    const raw = fs.readFileSync(path.join(dataRoot, 'provider-profiles.v1.json'), 'utf8');
    expect(raw).not.toContain('replacement-secret-99999');
  });

  it('rejects a stale rollback instead of overwriting a newer edit', async () => {
    const store = new ProviderProfileStore(root(), new AesStorage());
    await store.initialize();
    const first = await store.save(saveRequest());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await store.save(saveRequest({ expectedRevision: first.value.revision, name: 'Second profile' }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const staleRollback = await store.restoreAfterFailedSave({
      id: first.value.profile.id,
      name: 'stale',
      config: null,
      activeId: null,
    }, first.value.revision);
    expect(staleRollback).toMatchObject({ ok: false, code: 'revision_conflict' });
  });
});
