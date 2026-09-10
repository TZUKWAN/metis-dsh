import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CurrentAffairsReceiptKeyStore,
  type ReceiptKeyStorageCipher,
} from '../CurrentAffairsReceiptKeyStore.js';

// ── Test cipher (in-memory, simulates safeStorage) ────────────

class TestCipher implements ReceiptKeyStorageCipher {
  private readonly store = new Map<string, string>();
  private counter = 0;
  private _available = true;

  encrypt(plainText: string): string {
    const id = `enc_${++this.counter}_${Date.now()}`;
    this.store.set(id, plainText);
    return id;
  }
  decrypt(cipherText: string): string {
    const v = this.store.get(cipherText);
    if (!v) throw new Error('Key not found');
    return v;
  }
  isAvailable(): boolean { return this._available; }
  setAvailable(v: boolean) { this._available = v; }
}

let tmpDir: string;
let keyPath: string;
let cipher: TestCipher;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-key-store-'));
  keyPath = path.join(tmpDir, '.receipt-key');
  cipher = new TestCipher();
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
});

function newStore(p = keyPath, c: ReceiptKeyStorageCipher = cipher) {
  return new CurrentAffairsReceiptKeyStore({ keyPath: p, cipher: c });
}

// ── Basic round-trip ──────────────────────────────────────────

describe('CurrentAffairsReceiptKeyStore — round-trip', () => {
  it('generates a new secret when no key file exists', () => {
    const store = newStore();
    const r = store.loadOrGenerate();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(64);
  });

  it('persists and loads the same secret', () => {
    const store = newStore();
    const r1 = store.loadOrGenerate();
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    const p = store.persist(r1.value);
    expect(p.ok).toBe(true);

    const store2 = newStore();
    const r2 = store2.loadOrGenerate();
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value).toEqual(r1.value);
  });

  it('generates different secrets for different stores', () => {
    const r1 = newStore().loadOrGenerate();
    const r2 = newStore(path.join(tmpDir, '.other-key')).loadOrGenerate();
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) expect(r1.value).not.toEqual(r2.value);
  });
});

// ── Cipher unavailable — fail-closed ──────────────────────────

describe('CurrentAffairsReceiptKeyStore — cipher unavailable', () => {
  it('loadOrGenerate fails when cipher is unavailable', () => {
    cipher.setAvailable(false);
    const r = newStore().loadOrGenerate();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('cipher_unavailable');
  });

  it('persist fails when cipher is unavailable', () => {
    const store = newStore();
    const r = store.loadOrGenerate();
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    cipher.setAvailable(false);
    const p = store.persist(r.value);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.code).toBe('cipher_unavailable');
  });
});

// ── Corruption / decrypt failure ──────────────────────────────

describe('CurrentAffairsReceiptKeyStore — corruption', () => {
  it('empty key file returns key_corrupt', () => {
    fs.writeFileSync(keyPath, '', 'utf-8');
    const r = newStore().loadOrGenerate();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('key_corrupt');
  });

  it('garbage key file returns key_decrypt_failed or key_corrupt', () => {
    fs.writeFileSync(keyPath, 'not-a-valid-encrypted-blob', 'utf-8');
    const r = newStore().loadOrGenerate();
    expect(r.ok).toBe(false);
    // Either decrypt fails or the decoded content is corrupt
    expect(['key_decrypt_failed', 'key_corrupt']).toContain(r.ok ? '' : r.code);
  });

  it('oversized key file returns key_corrupt', () => {
    fs.writeFileSync(keyPath, 'x'.repeat(20000), 'utf-8');
    const r = newStore().loadOrGenerate();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('key_corrupt');
  });

  it('key file with short decoded content returns key_corrupt', () => {
    // Encrypt a short string (< 32 bytes)
    const short = Buffer.from('short').toString('base64');
    fs.writeFileSync(keyPath, cipher.encrypt(short), 'utf-8');
    const r = newStore().loadOrGenerate();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('key_corrupt');
  });
});

// ── Symlink rejection ─────────────────────────────────────────

describe('CurrentAffairsReceiptKeyStore — symlink rejection', () => {
  function canSymlink(): boolean {
    try {
      const tgt = path.join(tmpDir, 'sym-test-target');
      const lnk = path.join(tmpDir, 'sym-test-link');
      fs.writeFileSync(tgt, '', 'utf-8');
      if (process.platform === 'win32') {
        fs.symlinkSync(tgt, lnk, 'junction');
      } else {
        fs.symlinkSync(tgt, lnk);
      }
      fs.unlinkSync(lnk);
      fs.unlinkSync(tgt);
      return true;
    } catch { return false; }
  }

  it('rejects key file that is a symlink', () => {
    if (!canSymlink()) return;
    const store = newStore();
    const r = store.loadOrGenerate();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(store.persist(r.value).ok).toBe(true);

    const target = path.join(tmpDir, 'real-key');
    fs.writeFileSync(target, 'real-content', 'utf-8');
    fs.unlinkSync(keyPath);
    if (process.platform === 'win32') {
      fs.symlinkSync(target, keyPath, 'junction');
    } else {
      fs.symlinkSync(target, keyPath);
    }

    const r2 = newStore().loadOrGenerate();
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('key_symlink_rejected');
  });

  it('rejects persist when key path is a symlink', () => {
    if (!canSymlink()) return;
    const target = path.join(tmpDir, 'real-key');
    fs.writeFileSync(target, '', 'utf-8');
    if (process.platform === 'win32') {
      fs.symlinkSync(target, keyPath, 'junction');
    } else {
      fs.symlinkSync(target, keyPath);
    }

    const store = newStore();
    const r = store.loadOrGenerate();
    if (!r.ok) return;
    const p = store.persist(r.value);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.code).toBe('key_symlink_rejected');
  });
});

// ── Write failure ─────────────────────────────────────────────

describe('CurrentAffairsReceiptKeyStore — write failure', () => {
  it('persist returns key_write_failed when rename throws', () => {
    const store = newStore();
    const r = store.loadOrGenerate();
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const orig = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      const np = String(newPath);
      // Only fail for the key file rename, not the lock
      if (np.includes('.receipt-key') && !np.includes('.lock')) {
        throw new Error('disk full');
      }
      return orig(oldPath, newPath);
    });

    const p = store.persist(r.value);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.code).toBe('key_write_failed');
  });

  it('persist returns key_write_failed when writeFileSync throws for key file', () => {
    const store = newStore();
    const r = store.loadOrGenerate();
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const orig = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((p: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      const fp = String(p);
      // Only throw for the actual key file write, not the lock file
      if (fp.includes('.receipt-key') && !fp.includes('.lock') && !fp.includes('.tmp')) {
        throw new Error('EACCES');
      }
      // The temp file write (which includes .receipt-key and .tmp) also needs to fail
      if (fp.includes('.receipt-key') && fp.includes('.tmp')) {
        throw new Error('EACCES');
      }
      return orig(p, data, options);
    });

    const p = store.persist(r.value);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.code).toBe('key_write_failed');
  });
});

// ─── Concurrent access / lock ──────────────────────────────────

describe('CurrentAffairsReceiptKeyStore — concurrent lock', () => {
  it('two stores cannot persist simultaneously', () => {
    const store1 = newStore();
    const r1 = store1.loadOrGenerate();
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;

    // First persist: acquire lock + write (lock held until persist returns)
    // Second persist from another store: lock acquisition fails
    const p1 = store1.persist(r1.value);
    expect(p1.ok).toBe(true);

    // Simulate concurrent by directly creating the lock file
    fs.writeFileSync(keyPath + '.lock', 'blocked', { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    const store2 = newStore();
    const r2 = store2.loadOrGenerate();
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;

    const p2 = store2.persist(r2.value);
    expect(p2.ok).toBe(false);
    if (!p2.ok) expect(p2.code).toBe('key_lock_failed');
  });
});

// ─── Restart / re-read ─────────────────────────────────────────

describe('CurrentAffairsReceiptKeyStore — restart durability', () => {
  it('persisted key survives store re-creation', () => {
    const store1 = newStore();
    const r1 = store1.loadOrGenerate();
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const original = r1.value;

    // Persist the secret
    expect(store1.persist(original).ok).toBe(true);

    // Verify file exists
    expect(fs.existsSync(keyPath)).toBe(true);

    // Create a new store and load — must get the same secret
    const store2 = newStore();
    const r2 = store2.loadOrGenerate();
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value).toEqual(original);
  });

  it('generates new secret after key file is deleted', () => {
    const store1 = newStore();
    const r1 = store1.loadOrGenerate();
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(store1.persist(r1.value).ok).toBe(true);

    // Delete and re-create
    fs.unlinkSync(keyPath);
    const store2 = newStore();
    const r2 = store2.loadOrGenerate();
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value).not.toEqual(r1.value);
  });
});

// ─── Encrypt failure ──────────────────────────────────────────

describe('CurrentAffairsReceiptKeyStore — encrypt failure', () => {
  it('persist returns key_encrypt_failed when encrypt throws', () => {
    const store = newStore();
    const r = store.loadOrGenerate();
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    cipher.encrypt = () => { throw new Error('encrypt error'); };
    const p = store.persist(r.value);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.code).toBe('key_encrypt_failed');
  });
});

// ─── Read failure ─────────────────────────────────────────────

describe('CurrentAffairsReceiptKeyStore — read failure', () => {
  it('lstat failure on key file returns key_read_failed', () => {
    const store = newStore();
    const r = store.loadOrGenerate();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(store.persist(r.value).ok).toBe(true);

    // Spy lstatSync to throw EIO only for the key file, not dataDir
    const orig = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((p: fs.PathLike, options?: Parameters<typeof fs.lstatSync>[1]) => {
      if (String(p) === keyPath) throw new Error('EIO');
      return orig(p, options);
    });

    const r2 = newStore().loadOrGenerate();
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('key_read_failed');
  });

  it('read failure via openSync throws returns key_read_failed', () => {
    const store = newStore();
    const r = store.loadOrGenerate();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(store.persist(r.value).ok).toBe(true);

    // Spy openSync to throw EIO only for the key file
    const orig = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((p: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode | null | undefined) => {
      if (String(p) === keyPath && String(flags) === 'r') throw new Error('EIO');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fs.openSync overloads
      return (orig as any)(p, flags, mode);
    });

    const r2 = newStore().loadOrGenerate();
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('key_read_failed');
  });
});

// ─── Non-file key path ────────────────────────────────────────

describe('CurrentAffairsReceiptKeyStore — non-file rejection', () => {
  it('rejects key path that is a directory', () => {
    fs.mkdirSync(keyPath); // make it a directory
    const r = newStore().loadOrGenerate();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('key_read_failed');
  });
});

// ─── Absolute path requirement ────────────────────────────────

describe('CurrentAffairsReceiptKeyStore — constructor', () => {
  it('rejects relative key path', () => {
    expect(() => new CurrentAffairsReceiptKeyStore({
      keyPath: 'relative/path',
      cipher,
    })).toThrow(/absolute/);
  });
});
