import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

export interface CitationTruthSecretProtector {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

/** Minimal filesystem dependency injection for testability.
 *  Production uses the real `fs` module. */
export interface CitationTruthFsDeps {
  fsyncFd(fd: number): void;
  fsyncDir(dataDir: string): void;
}

const defaultFsDeps: CitationTruthFsDeps = {
  fsyncFd: (fd) => fs.fsyncSync(fd),
  fsyncDir: (dataDir) => {
    const dirFd = fs.openSync(dataDir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  },
};

const KEY_FILE = 'citation-truth-receipt-key.v1.json';

// ── Ancestor containment — cross-platform ─────────────────────

/**
 * Walk the TEXTUAL path segment by segment, verifying no component is a
 * symlink or junction.  Returns the fully-resolved canonical realpath on
 * success, null if any segment is a symlink/junction.
 *
 * All platforms: lstat every segment.  symlink → reject.  Windows also
 * verifies junction (realpath !== nominal).  ENOENT on a segment means
 * that part of the path doesn't exist yet — we stop walking (the path
 * will be created by the caller after this check passes).
 */
function resolveTextualPathNoSymlink(textual: string): string | null {
  try {
    const resolved = path.resolve(textual);
    const parts = resolved.split(path.sep).filter(p => p !== '');

    // Determine the filesystem root as the starting walk point
    let walk: string;
    let startIdx: number;
    if (process.platform === 'win32') {
      // Windows: "C:\Users\..." → parts = ["C:","Users",...]
      if (parts.length === 0) return null;
      walk = (parts[0] ?? '') + path.sep; // e.g. "C:\"
      startIdx = 1;
    } else {
      // POSIX: "/home/user/..." → parts = ["home","user",...]
      walk = path.sep; // "/"
      startIdx = 0;
    }

    for (let i = startIdx; i < parts.length; i++) {
      walk = path.join(walk, parts[i]!);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(walk);
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === 'ENOENT') break; // remaining segments don't exist yet → ok
        return null; // IO error (EACCES, EIO, etc.) → fail closed
      }
      // Symlink at any segment → reject
      if (stat.isSymbolicLink()) return null;
      // Windows: junction/reparse point via realpath divergence
      if (process.platform === 'win32') {
        try {
          const real = fs.realpathSync(walk);
          if (real.toLowerCase() !== walk.toLowerCase()) return null;
        } catch {
          return null;
        }
      }
    }
    // All existing segments verified — resolve the canonical path
    return fs.realpathSync(resolved);
  } catch {
    return null;
  }
}

// ── Data directory verification ───────────────────────────────

/** Verify dataDir exists, is not a symlink/junction, and its realpath
 *  is contained within canonicalTrustedBase. */
function verifyDataDir(dataDir: string, canonicalTrustedBase: string): boolean {
  try {
    const stat = fs.lstatSync(dataDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (process.platform === 'win32') {
      const real = fs.realpathSync(dataDir);
      if (real.toLowerCase() !== path.resolve(dataDir).toLowerCase()) return false;
    }
    const real = fs.realpathSync(dataDir);
    const sep = path.sep;
    if (!real.startsWith(canonicalTrustedBase + sep) && real !== canonicalTrustedBase) return false;
    return true;
  } catch {
    return false;
  }
}

// ── TOCTOU-safe key file decode ───────────────────────────────

/**
 * Read and decode the key file using an open file descriptor to prevent
 * TOCTOU swap between stat and read.  Verifies the file identity (dev/ino
 * on POSIX, or size+mtime on all platforms) is stable across the read.
 */
function decodeKeyFileSafe(filePath: string, protector: CitationTruthSecretProtector): Buffer | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const statBefore = fs.fstatSync(fd);
    if (!statBefore.isFile() || statBefore.size < 20 || statBefore.size > 16_384) return null;
    // Read through the fd — not the path — to avoid path→fd swap
    const raw = fs.readFileSync(fd, { encoding: 'utf8' });
    const statAfter = fs.fstatSync(fd);
    // Verify file identity didn't change during read
    if (!isSameFileIdentity(statBefore, statAfter)) return null;

    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(',') !== 'ciphertext,version'
    ) return null;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || typeof record.ciphertext !== 'string') return null;
    const encrypted = Buffer.from(record.ciphertext, 'base64');
    if (encrypted.length < 1) return null;
    const plaintext = protector.decryptString(encrypted);
    const secret = Buffer.from(plaintext, 'base64url');
    return secret.length === 32 ? secret : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

function isSameFileIdentity(a: fs.Stats, b: fs.Stats): boolean {
  if (process.platform !== 'win32') {
    // POSIX: dev + ino uniquely identify a file
    return a.dev === b.dev && a.ino === b.ino;
  }
  // Windows: size + mtime as best available proxy
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

// ─── Main entry point ─────────────────────────────────────────

/**
 * Loads the durable HMAC key for CitationTruth receipt signing, protected
 * by Electron safeStorage.
 *
 * Security properties:
 *  - Textual path walk: every segment lstat'd — symlink/junction in any
 *    path component is rejected on ALL platforms (not just Windows)
 *  - dataDir MUST already exist and be canonical — KeyStore never creates
 *    directories (main process owns mkdir); this eliminates TOCTOU mkdir risk
 *  - Staging file fsynced before publish
 *  - Atomic EXCLUSIVE publish via linkSync(temp, final) — EEXIST → read winner
 *  - Directory fsync fail-closed (except Windows which doesn't support it)
 *  - TOCTOU-safe read via open fd + fstat before/after identity check
 *  - Final file containment verified before decoding
 *  - Missing keys created atomically; corrupt keys fail closed
 */
export function loadOrCreateCitationTruthSecret(
  dataDir: string,
  protector: CitationTruthSecretProtector,
  fsDeps: CitationTruthFsDeps = defaultFsDeps,
): Buffer | null {
  // ── Step 0: safeStorage gate ───────────────────────────────
  try {
    if (!protector.isEncryptionAvailable()) return null;
  } catch {
    return null;
  }

  // ── Step 1: resolve canonical trusted base ─────────────────
  // Walk the textual path to verify no segment is a symlink/junction.
  // parentDir MUST exist — its realpath becomes the containment anchor.
  const parentDir = path.resolve(path.dirname(dataDir));
  let trustedBase: string;
  try {
    const parentResolved = resolveTextualPathNoSymlink(parentDir);
    if (!parentResolved) return null;
    trustedBase = parentResolved;
  } catch {
    return null;
  }

  // ── Step 2: dataDir must already exist ─────────────────────
  // KeyStore does NOT create directories — main process owns mkdir.
  // This eliminates TOCTOU risk from mkdir inside a junction target.
  if (!fs.existsSync(dataDir)) return null;
  if (!verifyDataDir(dataDir, trustedBase)) return null;

  const filePath = path.join(dataDir, KEY_FILE);

  // ── Step 3: try to load existing key (TOCTOU-safe) ─────────
  try {
    // Verify final path containment before attempting read
    const finalResolved = resolveTextualPathNoSymlink(filePath);
    if (finalResolved) {
      if (!finalResolved.startsWith(trustedBase + path.sep) && finalResolved !== trustedBase) return null;
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) return null;
      return decodeKeyFileSafe(filePath, protector);
    }
  } catch {
    return null;
  }

  // ── Step 4: create new key ─────────────────────────────────
  const secret = randomBytes(32);
  let payload: string;
  try {
    payload = JSON.stringify({
      version: 1,
      ciphertext: protector.encryptString(secret.toString('base64url')).toString('base64'),
    });
  } catch {
    return null;
  }

  const tempPath = path.join(dataDir, `.${KEY_FILE}.${randomUUID()}.tmp`);
  try {
    if (!verifyDataDir(dataDir, trustedBase)) return null;

    // Write + fsync staging file
    const fd = fs.openSync(tempPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, payload, { encoding: 'utf8' });
      fsDeps.fsyncFd(fd);
    } finally {
      fs.closeSync(fd);
    }

    // ── Atomic EXCLUSIVE publish via hard link ────────────────
    let published = false;
    try {
      fs.linkSync(tempPath, filePath);
      published = true;
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'EEXIST') {
        published = false;
      } else {
        return null;
      }
    }

    // ── Fsync directory — fail-closed ────────────────────────
    if (published && process.platform !== 'win32') {
      // Windows does not support fsync on directory handles.
      // On all other platforms, directory fsync failure means durability
      // is not guaranteed — fail closed.
      try {
        fsDeps.fsyncDir(dataDir);
      } catch {
        return null; // directory fsync failed → key may not be durable
      }
    }

    // ── Final containment + TOCTOU-safe decode ───────────────
    const finalResolved = resolveTextualPathNoSymlink(filePath);
    if (!finalResolved) return null;
    if (!finalResolved.startsWith(trustedBase + path.sep) && finalResolved !== trustedBase) return null;
    const finalStat = fs.lstatSync(filePath);
    if (finalStat.isSymbolicLink() || !finalStat.isFile()) return null;

    return decodeKeyFileSafe(filePath, protector);
  } catch {
    return null;
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* best-effort */ }
  }
}
