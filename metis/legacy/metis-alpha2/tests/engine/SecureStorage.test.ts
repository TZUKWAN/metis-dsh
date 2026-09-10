/**
 * Tests for SecureStorage — encryption/decryption of sensitive data.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSecureStorage,
  setSecureStorage,
  encryptProviderConfig,
  decryptProviderConfig,
  type ISecureStorage,
} from '../../engine/core/SecureStorage.js';
import type { ProviderConfig } from '../../engine/core/types.js';

// ─── Mock Storage for Testing ────────────────────────────────────

class MockSecureStorage implements ISecureStorage {
  private readonly keys = new Map<string, string>();
  private counter = 0;

  encrypt(plainText: string): string {
    const id = `mock_${++this.counter}`;
    this.keys.set(id, plainText);
    return `ENC:${id}`;
  }

  decrypt(cipherText: string): string {
    if (!cipherText.startsWith('ENC:')) {
      throw new Error('Invalid cipher text format');
    }
    const id = cipherText.slice(4);
    const plain = this.keys.get(id);
    if (!plain) throw new Error(`Key not found: ${id}`);
    return plain;
  }

  isAvailable(): boolean {
    return true;
  }
}

// ─── Tests ───────────────────────────────────────────────────────

describe('SecureStorage', () => {
  let storage: MockSecureStorage;

  beforeEach(() => {
    storage = new MockSecureStorage();
    setSecureStorage(storage);
  });

  it('should get a secure storage instance', () => {
    const instance = getSecureStorage();
    expect(instance).toBeDefined();
    expect(instance.isAvailable()).toBe(true);
  });

  it('should encrypt and decrypt round-trip correctly', () => {
    const plainText = 'sk-test-api-key-12345';
    const encrypted = storage.encrypt(plainText);
    const decrypted = storage.decrypt(encrypted);

    expect(encrypted).not.toBe(plainText);
    expect(decrypted).toBe(plainText);
  });

  it('should encrypt different inputs to different outputs', () => {
    const encrypted1 = storage.encrypt('key1');
    const encrypted2 = storage.encrypt('key2');

    expect(encrypted1).not.toBe(encrypted2);
  });

  it('should throw on invalid cipher text', () => {
    expect(() => storage.decrypt('invalid')).toThrow();
  });

  it('should throw on unknown key reference', () => {
    expect(() => storage.decrypt('ENC:nonexistent')).toThrow();
  });
});

describe('encryptProviderConfig / decryptProviderConfig', () => {
  let storage: MockSecureStorage;

  beforeEach(() => {
    storage = new MockSecureStorage();
    setSecureStorage(storage);
  });

  it('should encrypt a ProviderConfig and produce EncryptedProviderConfig', () => {
    const config: ProviderConfig = {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-secret-key',
      model: 'gpt-4o',
      timeout: 30000,
      maxRetries: 3,
      retryBackoffSeconds: 1,
    };

    const encrypted = encryptProviderConfig(config, storage);

    expect(encrypted.baseUrl).toBe(config.baseUrl);
    expect(encrypted.encryptedApiKey).not.toBe(config.apiKey);
    expect(encrypted.model).toBe(config.model);
    expect(encrypted.timeout).toBe(config.timeout);
    expect(encrypted.maxRetries).toBe(config.maxRetries);
    expect(encrypted.retryBackoffSeconds).toBe(config.retryBackoffSeconds);
  });

  it('should decrypt back to original ProviderConfig', () => {
    const original: ProviderConfig = {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-secret-key-xyz',
      model: 'gpt-4o-mini',
      timeout: 60000,
      maxRetries: 5,
      retryBackoffSeconds: 2,
    };

    const encrypted = encryptProviderConfig(original, storage);
    const decrypted = decryptProviderConfig(encrypted, storage);

    expect(decrypted.baseUrl).toBe(original.baseUrl);
    expect(decrypted.apiKey).toBe(original.apiKey);
    expect(decrypted.model).toBe(original.model);
    expect(decrypted.timeout).toBe(original.timeout);
    expect(decrypted.maxRetries).toBe(original.maxRetries);
    expect(decrypted.retryBackoffSeconds).toBe(original.retryBackoffSeconds);
  });

  it('should handle multiple configs independently', () => {
    const config1: ProviderConfig = {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-key-1',
      model: 'gpt-4o',
      timeout: 30000,
      maxRetries: 3,
      retryBackoffSeconds: 1,
    };

    const config2: ProviderConfig = {
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-key-2',
      model: 'claude-3',
      timeout: 60000,
      maxRetries: 5,
      retryBackoffSeconds: 2,
    };

    const enc1 = encryptProviderConfig(config1, storage);
    const enc2 = encryptProviderConfig(config2, storage);

    // Encrypted keys should differ
    expect(enc1.encryptedApiKey).not.toBe(enc2.encryptedApiKey);

    // Each should decrypt to its original
    const dec1 = decryptProviderConfig(enc1, storage);
    const dec2 = decryptProviderConfig(enc2, storage);

    expect(dec1.apiKey).toBe('sk-key-1');
    expect(dec2.apiKey).toBe('sk-ant-key-2');
  });

  it('should preserve non-sensitive fields unmodified', () => {
    const config: ProviderConfig = {
      baseUrl: 'https://custom.api.com/v2',
      apiKey: 'secret',
      model: 'custom-model',
      timeout: 99999,
      maxRetries: 10,
      retryBackoffSeconds: 5,
    };

    const encrypted = encryptProviderConfig(config, storage);

    expect(encrypted.baseUrl).toBe('https://custom.api.com/v2');
    expect(encrypted.model).toBe('custom-model');
    expect(encrypted.timeout).toBe(99999);
    expect(encrypted.maxRetries).toBe(10);
    expect(encrypted.retryBackoffSeconds).toBe(5);
  });
});
