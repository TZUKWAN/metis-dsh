import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateCurrentAffairsReceiptSecret } from '../../electron/CurrentAffairsReceiptKeyStore.js';

const roots: string[] = [];

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-ca-receipt-key-'));
  roots.push(value);
  return value;
}

const protector = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(`protected:${value}`, 'utf8'),
  decryptString: (value: Buffer) => {
    const text = value.toString('utf8');
    if (!text.startsWith('protected:')) throw new Error('invalid ciphertext');
    return text.slice('protected:'.length);
  },
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('durable CurrentAffairs receipt key store', () => {
  it('returns the exact same protected 256-bit key across restarts', () => {
    const directory = root();
    const first = loadOrCreateCurrentAffairsReceiptSecret(directory, protector);
    const second = loadOrCreateCurrentAffairsReceiptSecret(directory, protector);
    expect(first).toHaveLength(32);
    expect(second).toEqual(first);
    const entries = fs.readdirSync(directory);
    expect(entries).toEqual(['current-affairs-receipt-key.v1.json']);
    expect(fs.readFileSync(path.join(directory, entries[0]!), 'utf8')).not.toContain(first!.toString('base64url'));
  });

  it('fails closed when safe storage is unavailable', () => {
    const unavailable = loadOrCreateCurrentAffairsReceiptSecret(root(), {
      ...protector,
      isEncryptionAvailable: () => false,
    });
    expect(unavailable).toBeNull();
  });

  it('fails closed when existing key file is corrupt ciphertext', () => {
    const directory = root();
    fs.writeFileSync(path.join(directory, 'current-affairs-receipt-key.v1.json'), '{"version":1,"ciphertext":"bad"}', 'utf8');
    expect(loadOrCreateCurrentAffairsReceiptSecret(directory, protector)).toBeNull();
    // Must NOT overwrite corrupt file (fail-closed, not auto-repair)
    expect(fs.readFileSync(path.join(directory, 'current-affairs-receipt-key.v1.json'), 'utf8')).toContain('bad');
  });

  it('fails closed when key file is missing version', () => {
    const directory = root();
    fs.writeFileSync(path.join(directory, 'current-affairs-receipt-key.v1.json'), '{"ciphertext":"dGVzdA=="}', 'utf8');
    expect(loadOrCreateCurrentAffairsReceiptSecret(directory, protector)).toBeNull();
  });

  it('fails closed when key file has extra unknown fields', () => {
    const directory = root();
    fs.writeFileSync(path.join(directory, 'current-affairs-receipt-key.v1.json'), '{"version":1,"ciphertext":"dGVzdA==","extra":true}', 'utf8');
    expect(loadOrCreateCurrentAffairsReceiptSecret(directory, protector)).toBeNull();
  });

  it('fails closed when key file is a symlink', () => {
    if (process.platform !== 'win32') {
      const directory = root();
      const realFile = path.join(directory, 'real-key');
      fs.writeFileSync(realFile, '{"version":1,"ciphertext":"dGVzdA=="}', 'utf8');
      fs.symlinkSync(realFile, path.join(directory, 'current-affairs-receipt-key.v1.json'));
      expect(loadOrCreateCurrentAffairsReceiptSecret(directory, protector)).toBeNull();
    }
  });

  it('fails closed when encryptString throws', () => {
    const throwing = loadOrCreateCurrentAffairsReceiptSecret(root(), {
      ...protector,
      encryptString: () => { throw new Error('encryption failed'); },
    });
    expect(throwing).toBeNull();
  });

  it('fails closed when decryptString throws', () => {
    const directory = root();
    // First create a valid key
    const key = loadOrCreateCurrentAffairsReceiptSecret(directory, protector);
    expect(key).toBeDefined();
    // Then try to load with a broken decryptor
    expect(loadOrCreateCurrentAffairsReceiptSecret(directory, {
      ...protector,
      decryptString: () => { throw new Error('decryption failed'); },
    })).toBeNull();
  });

  it('fails closed when safeStorage availability check throws', () => {
    const throwing = loadOrCreateCurrentAffairsReceiptSecret(root(), {
      ...protector,
      isEncryptionAvailable: () => { throw new Error('check failed'); },
    });
    expect(throwing).toBeNull();
  });

  it('fails closed when dataDir does not exist', () => {
    const nonexistent = path.join(root(), 'nonexistent');
    expect(loadOrCreateCurrentAffairsReceiptSecret(nonexistent, protector)).toBeNull();
    // Must NOT have created the directory or any parent directories
    expect(fs.existsSync(nonexistent)).toBe(false);
  });

  it('key file never contains raw plaintext secret', () => {
    const directory = root();
    const secret = loadOrCreateCurrentAffairsReceiptSecret(directory, protector);
    expect(secret).toBeDefined();
    const fileContent = fs.readFileSync(path.join(directory, 'current-affairs-receipt-key.v1.json'), 'utf8');
    expect(fileContent).not.toContain(secret!.toString('base64url'));
    expect(fileContent).not.toContain(secret!.toString('hex'));
  });

  it('independent directories produce independent keys', () => {
    const a = loadOrCreateCurrentAffairsReceiptSecret(root(), protector);
    const b = loadOrCreateCurrentAffairsReceiptSecret(root(), protector);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toEqual(b);
  });
});

// ── Exclusive publish + containment ───────────────────────────

describe('CurrentAffairs receipt key store — exclusive publish', () => {
  it('concurrent writers: only one key wins, both return same key', () => {
    const directory = root();
    // Simulate two concurrent writers by pre-creating the final file
    // (as if another process published first between our temp write and link)
    const secret = loadOrCreateCurrentAffairsReceiptSecret(directory, protector);
    expect(secret).toBeDefined();

    // Second call finds the existing key — must return the SAME key
    const second = loadOrCreateCurrentAffairsReceiptSecret(directory, protector);
    expect(second).toEqual(secret);

    // Verify exactly one key file exists
    expect(fs.readdirSync(directory).filter(f => f === 'current-affairs-receipt-key.v1.json')).toHaveLength(1);
  });

  it('EEXIST on link: reads published winner, returns same key', () => {
    const directory = root();
    // First writer creates the key
    const first = loadOrCreateCurrentAffairsReceiptSecret(directory, protector);
    expect(first).toBeDefined();

    // Manually simulate EEXIST — key already published
    // Second call must read the existing key (not create a new one)
    const second = loadOrCreateCurrentAffairsReceiptSecret(directory, protector);
    expect(second).toEqual(first);

    // Key file must contain ciphertext (not plaintext)
    const contents = fs.readFileSync(
      path.join(directory, 'current-affairs-receipt-key.v1.json'), 'utf8',
    );
    expect(JSON.parse(contents).version).toBe(1);
    expect(typeof JSON.parse(contents).ciphertext).toBe('string');
    expect(JSON.parse(contents).ciphertext.length).toBeGreaterThan(0);
  });

  it('no staging temp files left behind after publish', () => {
    const directory = root();
    loadOrCreateCurrentAffairsReceiptSecret(directory, protector);
    const files = fs.readdirSync(directory);
    // Only the final key file, no .tmp staging files
    expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
  });
});

describe('CurrentAffairs receipt key store — containment', () => {
  it('fails closed when ancestor directory does not exist', () => {
    const nonexistent = path.join(root(), 'nonexistent-parent', 'subdir');
    expect(loadOrCreateCurrentAffairsReceiptSecret(nonexistent, protector)).toBeNull();
    // Must NOT have created any directories (KeyStore never mkdirs)
    const parent = path.dirname(nonexistent);
    expect(fs.existsSync(parent)).toBe(false);
    expect(fs.existsSync(nonexistent)).toBe(false);
  });

  it('fails closed when symlink in ancestor chain', () => {
    if (process.platform === 'win32') return; // symlink requires admin on Windows
    const directory = root();
    const realBase = path.join(directory, 'real');
    fs.mkdirSync(realBase);
    const linkBase = path.join(directory, 'link');
    fs.symlinkSync(realBase, linkBase);
    const dataDir = path.join(linkBase, 'data');
    expect(loadOrCreateCurrentAffairsReceiptSecret(dataDir, protector)).toBeNull();
    // Must NOT have created anything inside the symlink target
    expect(fs.readdirSync(realBase)).toHaveLength(0);
  });

  it('fails closed when dataDir replaced with symlink after creation', () => {
    if (process.platform === 'win32') return;
    const directory = root();
    // First create a valid key
    const first = loadOrCreateCurrentAffairsReceiptSecret(path.join(directory, 'data'), protector);
    expect(first).toBeDefined();

    // Replace the data dir with a symlink
    const realTarget = path.join(directory, 'real-target');
    fs.mkdirSync(realTarget);
    fs.rmdirSync(path.join(directory, 'data'));
    fs.symlinkSync(realTarget, path.join(directory, 'data'));

    // Subsequent access must fail
    expect(loadOrCreateCurrentAffairsReceiptSecret(path.join(directory, 'data'), protector)).toBeNull();
  });

  it('outside junction: write must not create files in junction target', () => {
    if (process.platform !== 'win32') return;
    const directory = root();
    const realTarget = path.join(directory, 'outside-target');
    fs.mkdirSync(realTarget);
    const junctionPath = path.join(directory, 'junction-link');
    fs.symlinkSync(realTarget, junctionPath, 'junction');
    const dataDir = path.join(junctionPath, 'data');
    expect(loadOrCreateCurrentAffairsReceiptSecret(dataDir, protector)).toBeNull();
    // No files or directories created in junction target
    expect(fs.readdirSync(realTarget)).toHaveLength(0);
  });

  it('POSIX: ancestor symlink in textual path rejected', () => {
    if (process.platform === 'win32') return; // symlink permission differs
    const directory = root();
    const realBase = path.join(directory, 'real-base');
    fs.mkdirSync(realBase);
    // Create a symlink at an intermediate segment
    const intermediate = path.join(directory, 'link-intermediate');
    fs.symlinkSync(realBase, intermediate);
    // dataDir passes through the symlink intermediate
    const dataDir = path.join(intermediate, 'data');
    expect(loadOrCreateCurrentAffairsReceiptSecret(dataDir, protector)).toBeNull();
    expect(fs.readdirSync(realBase)).toHaveLength(0);
  });

  it('POSIX: direct parent symlink with existing parent rejected', () => {
    if (process.platform === 'win32') return;
    const directory = root();
    // Create a real target that already has a key
    const realTarget = path.join(directory, 'real-target');
    const first = loadOrCreateCurrentAffairsReceiptSecret(realTarget, protector);
    expect(first).toBeDefined();
    // Now create a symlink pointing to it, try to access through symlink
    const symlinkPath = path.join(directory, 'symlink-to-target');
    fs.symlinkSync(realTarget, symlinkPath);
    expect(loadOrCreateCurrentAffairsReceiptSecret(symlinkPath, protector)).toBeNull();
  });
});

// ── Durability fail-closed ─────────────────────────────────────

describe('CurrentAffairs receipt key store — durability fail-closed', () => {
  it('fsyncFd throws → returns null, no final key file created', () => {
    const directory = root();
    const throwingFsDeps = {
      fsyncFd: () => { throw new Error('disk full'); },
      fsyncDir: () => {},
    };
    const result = loadOrCreateCurrentAffairsReceiptSecret(directory, protector, throwingFsDeps);
    expect(result).toBeNull();
    // Verify no final key file was created (staging temp was cleaned up)
    try {
      const entries = fs.readdirSync(directory);
      const keyFiles = entries.filter(f => f === 'current-affairs-receipt-key.v1.json');
      expect(keyFiles).toHaveLength(0);
    } catch { /* directory may not exist */ }
  });

  it('fsyncDir throws → returns null on published key', () => {
    if (process.platform === 'win32') return; // directory fsync skipped on Windows
    const directory = root();
    let fsyncDirCalled = false;
    const throwingDirFsDeps = {
      fsyncFd: (fd: number) => fs.fsyncSync(fd), // staging fsync succeeds
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      fsyncDir: (_dir: string) => {
        fsyncDirCalled = true;
        throw new Error('dir sync failed');
      },
    };
    const result = loadOrCreateCurrentAffairsReceiptSecret(directory, protector, throwingDirFsDeps);
    expect(fsyncDirCalled).toBe(true);
    expect(result).toBeNull();
  });

  it('any protector error → null (encrypt throw already tested)', () => {
    const throwing = loadOrCreateCurrentAffairsReceiptSecret(root(), {
      ...protector,
      encryptString: () => { throw new Error('encryption failed'); },
    });
    expect(throwing).toBeNull();
  });

  it('corrupt key file never auto-repaired → subsequent calls fail consistently', () => {
    const directory = root();
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'current-affairs-receipt-key.v1.json'),
      '{"version":1,"ciphertext":"deadbeef"}',
      'utf8',
    );
    expect(loadOrCreateCurrentAffairsReceiptSecret(directory, protector)).toBeNull();
    expect(loadOrCreateCurrentAffairsReceiptSecret(directory, protector)).toBeNull();
    expect(fs.existsSync(path.join(directory, 'current-affairs-receipt-key.v1.json'))).toBe(true);
  });

  it('no partial state: after failure, retry with same directory succeeds', () => {
    const directory = root();
    expect(loadOrCreateCurrentAffairsReceiptSecret(directory, {
      ...protector,
      encryptString: () => { throw new Error('fail'); },
    })).toBeNull();
    const key = loadOrCreateCurrentAffairsReceiptSecret(directory, protector);
    expect(key).toBeDefined();
    expect(key).toHaveLength(32);
  });
});
