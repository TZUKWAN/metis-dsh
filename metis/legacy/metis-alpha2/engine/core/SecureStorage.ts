/**
 * Secure storage abstraction for sensitive data (API keys, tokens).
 *
 * In Electron: uses safeStorage API for encryption at rest.
 * In Node.js / tests: falls back to base64 obfuscation with a warning.
 *
 * All encryption/decryption happens in the main process.
 * The renderer never handles raw keys — only encrypted blobs.
 */

import type { ProviderConfig } from './types.js';

// ─── Encrypted Config Types ─────────────────────────────────────

export interface EncryptedProviderConfig {
  baseUrl: string;
  /** Base64-encoded encrypted API key blob. */
  encryptedApiKey: string;
  model: string;
  timeout: number;
  maxRetries: number;
  retryBackoffSeconds: number;
}

// ─── Secure Storage Interface ────────────────────────────────────

export interface ISecureStorage {
  encrypt(plainText: string): string;
  decrypt(cipherText: string): string;
  isAvailable(): boolean;
}

// ─── In-Memory Secure Storage (for tests / non-Electron) ────────

class InMemorySecureStorage implements ISecureStorage {
  private readonly keys = new Map<string, string>();
  private counter = 0;

  encrypt(plainText: string): string {
    const id = `key_${++this.counter}_${Date.now()}`;
    this.keys.set(id, plainText);
    // Return a base64-encoded reference that looks like an encrypted blob
    return Buffer.from(`metis:v1:${id}`).toString('base64');
  }

  decrypt(cipherText: string): string {
    try {
      const decoded = Buffer.from(cipherText, 'base64').toString('utf-8');
      const prefix = 'metis:v1:';
      if (!decoded.startsWith(prefix)) {
        throw new Error('Invalid cipher text format');
      }
      const id = decoded.slice(prefix.length);
      const plain = this.keys.get(id);
      if (!plain) throw new Error(`Key not found: ${id}`);
      return plain;
    } catch {
      throw new Error('Failed to decrypt: invalid cipher text');
    }
  }

  isAvailable(): boolean {
    return true;
  }
}

// ─── Electron SafeStorage (lazy-loaded) ──────────────────────────

class ElectronSecureStorage implements ISecureStorage {
  private safeStorage: import('electron').SafeStorage | null = null;

  constructor() {
    try {
      // In ESM Electron, safeStorage is available as a top-level export.
      // Dynamic import for Electron's ESM module.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require('electron');
      if (electron?.safeStorage) {
        this.safeStorage = electron.safeStorage;
      }
    } catch {
      // Not running in Electron or safeStorage not available
      console.warn('[SecureStorage] Electron safeStorage not available — falling back to base64 encoding.');
    }
  }

  encrypt(plainText: string): string {
    if (!this.safeStorage) {
      throw new Error('safeStorage is not available');
    }
    const encrypted = this.safeStorage.encryptString(plainText);
    return encrypted.toString('base64');
  }

  decrypt(cipherText: string): string {
    if (!this.safeStorage) {
      throw new Error('safeStorage is not available');
    }
    const buffer = Buffer.from(cipherText, 'base64');
    return this.safeStorage.decryptString(buffer);
  }

  isAvailable(): boolean {
    return this.safeStorage?.isEncryptionAvailable() ?? false;
  }
}

// ─── Singleton Factory ───────────────────────────────────────────

let instance: ISecureStorage | null = null;

export function getSecureStorage(): ISecureStorage {
  if (!instance) {
    const electronStorage = new ElectronSecureStorage();
    if (electronStorage.isAvailable()) {
      instance = electronStorage;
    } else {
      // In non-Electron environments (tests, plain Node.js), use InMemorySecureStorage.
      // IMPORTANT: InMemorySecureStorage keys are lost on restart — do NOT use in production.
      console.warn('[SecureStorage] Electron safeStorage not available. Using in-memory fallback (keys will NOT survive restart).');
      instance = new InMemorySecureStorage();
    }
  }
  return instance;
}

/**
 * Initialize SecureStorage with Electron's safeStorage from the main process.
 * Call this early in app startup (before any config load/save) to ensure
 * Electron's native encryption is used instead of the in-memory fallback.
 */
export function initSecureStorage(safeStorage: { encryptString: (s: string) => Buffer; decryptString: (b: Buffer) => string; isEncryptionAvailable: () => boolean }): void {
  instance = {
    encrypt(plainText: string): string {
      const encrypted = safeStorage.encryptString(plainText);
      return encrypted.toString('base64');
    },
    decrypt(cipherText: string): string {
      const buffer = Buffer.from(cipherText, 'base64');
      return safeStorage.decryptString(buffer);
    },
    isAvailable(): boolean {
      return safeStorage.isEncryptionAvailable();
    },
  };
  console.log('[SecureStorage] Initialized with Electron safeStorage.');
}

/** Override for testing. */
export function setSecureStorage(storage: ISecureStorage): void {
  instance = storage;
}

// ─── Config Encryption Helpers ────────────────────────────────────

/**
 * Encrypt a ProviderConfig's API key for storage.
 * The returned object is safe to persist to disk or IPC.
 */
export function encryptProviderConfig(
  config: ProviderConfig,
  storage: ISecureStorage = getSecureStorage(),
): EncryptedProviderConfig {
  return {
    baseUrl: config.baseUrl,
    encryptedApiKey: storage.encrypt(config.apiKey),
    model: config.model,
    timeout: config.timeout,
    maxRetries: config.maxRetries,
    retryBackoffSeconds: config.retryBackoffSeconds,
  };
}

/**
 * Decrypt an EncryptedProviderConfig back to a ProviderConfig.
 */
export function decryptProviderConfig(
  encrypted: EncryptedProviderConfig,
  storage: ISecureStorage = getSecureStorage(),
): ProviderConfig {
  return {
    baseUrl: encrypted.baseUrl,
    apiKey: storage.decrypt(encrypted.encryptedApiKey),
    model: encrypted.model,
    timeout: encrypted.timeout,
    maxRetries: encrypted.maxRetries,
    retryBackoffSeconds: encrypted.retryBackoffSeconds,
  };
}
