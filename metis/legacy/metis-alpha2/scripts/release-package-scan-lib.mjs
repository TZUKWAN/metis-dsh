import asar from '@electron/asar';
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { sha256Buffer, stableJson } from './release-lib.mjs';

export const REQUIRED_ASAR_ENTRIES = Object.freeze(['LICENSE']);

function normalizedRelative(root, target) {
  const value = relative(root, target).split(sep).join('/');
  if (!value || value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe packaged tree path: ${value || target}`);
  }
  return value;
}

function sameFileIdentity(left, right) {
  return left.isFile()
    && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

/**
 * Read every physical file under an unpacked application exactly once while
 * producing a deterministic inventory digest.  The callbacks used for policy
 * and secret scanning therefore cover the exact same bytes whose digest is
 * later re-computed by the release verifier.
 */
export function scanPackagedTree(root, onFile = () => {}, onDirectory = () => {}) {
  const absoluteRoot = resolve(root);
  const rootStat = lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Unsafe unpacked application root: ${absoluteRoot}`);
  }
  const entries = [];
  let scannedFiles = 0;
  let directories = 0;

  const visit = (current) => {
    const children = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = resolve(current, child.name);
      const normalizedPath = normalizedRelative(absoluteRoot, absolute);
      const before = lstatSync(absolute);
      if (before.isSymbolicLink()) throw new Error(`Symbolic link in packaged tree: ${normalizedPath}`);
      if (before.isDirectory()) {
        entries.push({ path: normalizedPath, type: 'directory' });
        directories += 1;
        onDirectory({ normalizedPath });
        visit(absolute);
        continue;
      }
      if (!before.isFile()) throw new Error(`Unsupported packaged tree entry: ${normalizedPath}`);
      const fd = openSync(absolute, 'r');
      let bytes;
      try {
        const openedBefore = fstatSync(fd);
        const pathDuring = lstatSync(absolute);
        if (pathDuring.isSymbolicLink()
          || !sameFileIdentity(before, openedBefore)
          || !sameFileIdentity(openedBefore, pathDuring)) {
          throw new Error(`Packaged file identity changed while opening: ${normalizedPath}`);
        }
        bytes = readFileSync(fd);
        const openedAfter = fstatSync(fd);
        const pathAfter = lstatSync(absolute);
        if (pathAfter.isSymbolicLink()
          || !sameFileIdentity(openedBefore, openedAfter)
          || !sameFileIdentity(openedAfter, pathAfter)
          || bytes.length !== openedAfter.size) {
          throw new Error(`Packaged file changed while scanning: ${normalizedPath}`);
        }
      } finally {
        closeSync(fd);
      }
      const sha256 = sha256Buffer(bytes);
      entries.push({ path: normalizedPath, type: 'file', size: bytes.length, sha256 });
      scannedFiles += 1;
      onFile({ normalizedPath, size: bytes.length, sha256, read: () => bytes });
    }
  };
  visit(absoluteRoot);
  if (scannedFiles === 0) throw new Error('Unpacked application contains no scannable files');
  return {
    listedEntries: entries.length,
    scannedFiles,
    directories,
    treeSha256: sha256Buffer(Buffer.from(stableJson(entries), 'utf8')),
  };
}

export function normalizeAsarEntry(entry) {
  if (typeof entry !== 'string' || entry.length === 0) throw new Error('Invalid ASAR entry path');
  const normalized = entry.replace(/^[\\/]+/u, '').replaceAll('\\', '/');
  if (!normalized || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe ASAR entry path: ${entry}`);
  }
  return normalized;
}

export function asarApiPath(entry) {
  normalizeAsarEntry(entry);
  const apiPath = entry.replace(/^[\\/]+/u, '');
  if (!apiPath) throw new Error('Invalid ASAR API path');
  return apiPath;
}

export function missingRequiredAsarEntries(entries, required = REQUIRED_ASAR_ENTRIES) {
  const normalized = new Set(entries.map((entry) => normalizeAsarEntry(entry)));
  return required.filter((entry) => !normalized.has(normalizeAsarEntry(entry)));
}

/**
 * Enumerate every file in an ASAR archive while preserving the platform's
 * internal separators. listPackage prefixes entries with an archive-root
 * slash/backslash, while statFile/extractFile expect that single marker to be
 * removed. Converting the remaining Windows separators to `/` causes almost
 * the entire archive to be missed.
 */
export function scanAsarArchive(archivePath, onFile, onDirectory = () => {}) {
  const entries = asar.listPackage(archivePath, { isPack: false });
  let scannedFiles = 0;
  let directories = 0;
  for (const listedPath of entries) {
    const normalizedPath = normalizeAsarEntry(listedPath);
    const apiPath = asarApiPath(listedPath);
    const stat = asar.statFile(archivePath, apiPath, false);
    if ('files' in stat) {
      onDirectory({ normalizedPath });
      directories += 1;
      continue;
    }
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid ASAR file size: ${normalizedPath}`);
    onFile({
      normalizedPath,
      size,
      read: () => asar.extractFile(archivePath, apiPath, false),
    });
    scannedFiles += 1;
  }
  if (scannedFiles === 0) throw new Error('ASAR archive contains no scannable files');
  return { listedEntries: entries.length, scannedFiles, directories };
}
