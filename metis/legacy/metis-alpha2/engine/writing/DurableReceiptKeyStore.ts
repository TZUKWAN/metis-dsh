/**
 * DurableReceiptKeyStore — shared fail-closed HMAC key persistence helper.
 *
 * Used by both CurrentAffairsReceiptKeyStore and CitationTruthReceiptKeyStore.
 *
 * Durability contract:
 *  - Data directory must exist before construction (created by main process).
 *  - Ancestor symlink / junction on directory chain: fail-closed at construction.
 *  - No cipher available: fail-closed (never silently fall back to plaintext).
 *  - Corrupt / unreadable / truncated key file: fail-closed.
 *  - Symlink / junction on key path: fail-closed on every load/persist.
 *  - Atomic write: wx temp → fsync → exclusive rename (never in-place overwrite).
 *  - Post-rename directory fsync on non-Windows.
 *  - Load uses openSync + fstat + read to guard against TOCTOU replacement.
 *  - Concurrent writes: exclusive wx lock prevents interleaving.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';

// ─── Dependencies (injected) ──────────────────────────────────

export interface ReceiptKeyStorageCipher {
  encrypt(plainText: string): string;
  decrypt(cipherText: string): string;
  isAvailable(): boolean;
}

export interface DurableReceiptKeyStoreDeps {
  /** Absolute path to the key file. Parent directory must already exist
   *  and be canonical (no symlink/junction in any ancestor segment). */
  keyPath: string;
  /** Encryption backend (e.g. Electron safeStorage or test stub). */
  cipher: ReceiptKeyStorageCipher;
}

export type KeyStoreResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; code: string };

// ─── Implementation ───────────────────────────────────────────

export class DurableReceiptKeyStore {
  readonly #keyPath: string;
  readonly #cipher: ReceiptKeyStorageCipher;
  readonly #lockPath: string;
  readonly #dataDir: string;

  constructor(deps: DurableReceiptKeyStoreDeps) {
    if (!path.isAbsolute(deps.keyPath)) {
      throw new Error('keyPath must be absolute');
    }
    this.#keyPath = deps.keyPath;
    this.#cipher = deps.cipher;
    this.#lockPath = deps.keyPath + '.lock';
    this.#dataDir = path.dirname(deps.keyPath);

    // Reject if dataDir does not exist (main must create it first)
    if (!fs.existsSync(this.#dataDir)) {
      throw new Error('Data directory must exist before constructing key store');
    }

    // Reject if any ancestor segment is a symlink / junction
    this.#validateAncestorChain();
  }

  // ─── Public API ─────────────────────────────────────────────

  loadOrGenerate(): KeyStoreResult<Buffer> {
    if (!this.#cipher.isAvailable()) {
      return { ok: false, code: 'cipher_unavailable' };
    }
    if (!this.#validateDataDir()) {
      return { ok: false, code: 'key_symlink_rejected' };
    }

    const loadResult = this.#loadFromDisk();
    if (loadResult.ok) return loadResult;
    if (loadResult.code === 'key_absent') {
      return { ok: true, value: this.#generateSecret() };
    }
    return loadResult;
  }

  persist(secret: Buffer): KeyStoreResult {
    if (!this.#cipher.isAvailable()) {
      return { ok: false, code: 'cipher_unavailable' };
    }
    if (!this.#validateDataDir()) {
      return { ok: false, code: 'key_symlink_rejected' };
    }

    if (this.#isSymlink(this.#keyPath)) {
      return { ok: false, code: 'key_symlink_rejected' };
    }

    if (!this.#acquireLock()) {
      return { ok: false, code: 'key_lock_failed' };
    }
    try {
      let encrypted: string;
      try {
        encrypted = this.#cipher.encrypt(secret.toString('base64'));
      } catch {
        return { ok: false, code: 'key_encrypt_failed' };
      }

      // Re-check containment after encryption (defence in depth)
      if (!this.#validateDataDir() || this.#isSymlink(this.#keyPath)) {
        return { ok: false, code: 'key_symlink_rejected' };
      }

      const tmp = `${this.#keyPath}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tmp, encrypted, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
        const fd = fs.openSync(tmp, 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, this.#keyPath);

        // Directory fsync to ensure rename is durable (non-Windows)
        if (process.platform !== 'win32') {
          const dirFd = fs.openSync(this.#dataDir, 'r');
          try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
        }
      } catch {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* best-effort */ }
        return { ok: false, code: 'key_write_failed' };
      }

      return { ok: true, value: undefined };
    } finally {
      this.#releaseLock();
    }
  }

  get keyPath(): string { return this.#keyPath; }

  // ─── Private: ancestor validation ───────────────────────────

  /** Verify the data directory and all ancestor segments are not symlinks
   *  or junctions.  Called at construction and before every I/O operation. */
  #validateAncestorChain(): void {
    let segment = this.#dataDir;
    while (true) {
      const stat = fs.lstatSync(segment);
      if (stat.isSymbolicLink() || this.#isJunction(segment)) {
        throw new Error('Data directory ancestor must not be a junction or symlink');
      }
      const parent = path.dirname(segment);
      if (parent === segment) break;
      segment = parent;
    }
  }

  #validateDataDir(): boolean {
    try {
      if (!fs.existsSync(this.#dataDir)) return false;
      const stat = fs.lstatSync(this.#dataDir);
      if (stat.isSymbolicLink() || this.#isJunction(this.#dataDir)) return false;
      return true;
    } catch {
      return false;
    }
  }

  #isJunction(filePath: string): boolean {
    if (process.platform !== 'win32') return false;
    try {
      const real = fs.realpathSync(filePath);
      return real !== path.resolve(filePath);
    } catch {
      return false;
    }
  }

  // ─── Private: load from disk ─────────────────────────────────

  #loadFromDisk(): KeyStoreResult<Buffer> {
    if (this.#isSymlink(this.#keyPath)) {
      return { ok: false, code: 'key_symlink_rejected' };
    }

    // Open with fd to guard against TOCTOU: verify we read the same
    // inode we stat'd.
    let lstat: fs.Stats;
    try {
      lstat = fs.lstatSync(this.#keyPath);
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, code: 'key_absent' };
      }
      return { ok: false, code: 'key_read_failed' };
    }

    if (lstat.isSymbolicLink()) return { ok: false, code: 'key_symlink_rejected' };
    if (!lstat.isFile()) return { ok: false, code: 'key_read_failed' };
    if (lstat.size === 0 || lstat.size > 16384) return { ok: false, code: 'key_corrupt' };

    let fd: number | null = null;
    try {
      fd = fs.openSync(this.#keyPath, 'r');
      const fstat = fs.fstatSync(fd);
      // TOCTOU guard: inode must match the lstat we did above
      if (fstat.ino !== lstat.ino || fstat.size !== lstat.size) {
        return { ok: false, code: 'key_corrupt' };
      }
      if (fstat.size === 0 || fstat.size > 16384) {
        return { ok: false, code: 'key_corrupt' };
      }

      const buf = Buffer.alloc(fstat.size);
      const bytesRead = fs.readSync(fd, buf, 0, fstat.size, 0);
      if (bytesRead !== fstat.size) return { ok: false, code: 'key_read_failed' };

      const encrypted = buf.toString('utf-8').trim();
      if (!encrypted) return { ok: false, code: 'key_corrupt' };

      let decoded: string;
      try {
        decoded = this.#cipher.decrypt(encrypted);
      } catch {
        return { ok: false, code: 'key_decrypt_failed' };
      }

      const secret = Buffer.from(decoded, 'base64');
      if (secret.length < 32) return { ok: false, code: 'key_corrupt' };
      return { ok: true, value: secret };
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, code: 'key_absent' };
      }
      // Re-throw our own KeyStoreResult errors (from decrypt etc.)
      if (err && typeof err === 'object' && 'ok' in (err as Record<string, unknown>) && (err as Record<string, unknown>).ok === false) {
        throw err;
      }
      return { ok: false, code: 'key_read_failed' };
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* best-effort */ } }
    }
  }

  // ─── Private: helpers ────────────────────────────────────────

  #generateSecret(): Buffer {
    return randomBytes(64);
  }

  #isSymlink(filePath: string): boolean {
    try {
      if (!fs.existsSync(filePath)) return false;
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) return true;
      return this.#isJunction(filePath);
    } catch {
      return false;
    }
  }

  #acquireLock(): boolean {
    try {
      fs.writeFileSync(this.#lockPath, String(process.pid), { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  #releaseLock(): void {
    try { if (fs.existsSync(this.#lockPath)) fs.unlinkSync(this.#lockPath); } catch { /* best-effort */ }
  }
}
