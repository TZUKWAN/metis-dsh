/**
 * @vitest-environment node
 *
 * METIS storage location — pointer file, target validation, relocation
 * migration and startup resolution (all real filesystem operations).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import {
  LOCATION_POINTER_FILE,
  readLocationPointer,
  writeLocationPointer,
  validateTargetLocation,
  migrateDataDirSync,
  resolveDataDir,
} from '../../electron/StorageLocation.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-location-test-'));
}

/** Create a real Metis-shaped SQLite database (projects/papers/sources tables). */
function makeMetisDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE sources (id TEXT PRIMARY KEY, project_id TEXT);
  `);
  db.prepare('INSERT INTO projects (id, title) VALUES (?, ?)').run('p1', 'migration target');
  db.close();
}

function makeSymlink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

describe('location pointer file', () => {
  let dir: string;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns null when the pointer file is absent or malformed', () => {
    expect(readLocationPointer(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, LOCATION_POINTER_FILE), 'not json{{', 'utf-8');
    expect(readLocationPointer(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, LOCATION_POINTER_FILE), '{}', 'utf-8');
    expect(readLocationPointer(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, LOCATION_POINTER_FILE), '{"dataDir": "   "}', 'utf-8');
    expect(readLocationPointer(dir)).toBeNull();
  });

  it('round-trips a pointer and leaves no temp file behind', () => {
    expect(writeLocationPointer(dir, { version: 1, dataDir: 'D:\\Data', pendingMigrateFrom: null })).toBe(true);
    expect(readLocationPointer(dir)).toEqual({ version: 1, dataDir: 'D:\\Data', pendingMigrateFrom: null });
    expect(fs.readdirSync(dir)).toEqual([LOCATION_POINTER_FILE]);

    expect(writeLocationPointer(dir, { version: 1, dataDir: 'D:\\Data2', pendingMigrateFrom: 'D:\\Data' })).toBe(true);
    expect(readLocationPointer(dir)).toEqual({ version: 1, dataDir: 'D:\\Data2', pendingMigrateFrom: 'D:\\Data' });
  });
});

describe('validateTargetLocation', () => {
  let dir: string;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('rejects relative paths and the userData dir itself', () => {
    expect(validateTargetLocation('relative/path', dir)).toEqual({ ok: false, reason: 'invalid_path' });
    expect(validateTargetLocation(dir, dir)).toEqual({ ok: false, reason: 'invalid_path' });
  });

  it('rejects a target that is a file', () => {
    const file = path.join(dir, 'somefile');
    fs.writeFileSync(file, 'x');
    expect(validateTargetLocation(file, path.join(dir, 'user-data'))).toEqual({ ok: false, reason: 'not_a_directory' });
  });

  it('rejects a symlink target', () => {
    const real = path.join(dir, 'real-dir');
    fs.mkdirSync(real);
    const link = path.join(dir, 'link-dir');
    if (!makeSymlink(real, link)) return; // no privilege to create a link — skip
    expect(validateTargetLocation(link, path.join(dir, 'user-data'))).toEqual({ ok: false, reason: 'symlink_rejected' });
  });

  it('creates a missing target and accepts an empty one', () => {
    const target = path.join(dir, 'new', 'data-dir');
    expect(validateTargetLocation(target, path.join(dir, 'user-data'))).toEqual({ ok: true });
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  it('rejects a non-empty target without a metis database', () => {
    const target = path.join(dir, 'occupied');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'user-file.txt'), 'mine');
    expect(validateTargetLocation(target, path.join(dir, 'user-data'))).toEqual({ ok: false, reason: 'not_empty' });
  });

  it('accepts a target holding a valid metis database and rejects a fake one', () => {
    const good = path.join(dir, 'good');
    fs.mkdirSync(good);
    makeMetisDb(path.join(good, 'metis.db'));
    expect(validateTargetLocation(good, path.join(dir, 'user-data'))).toEqual({ ok: true });

    const fake = path.join(dir, 'fake');
    fs.mkdirSync(fake);
    fs.writeFileSync(path.join(fake, 'metis.db'), 'this is not sqlite');
    expect(validateTargetLocation(fake, path.join(dir, 'user-data'))).toEqual({ ok: false, reason: 'invalid_metis_db' });
  });
});

describe('migrateDataDirSync', () => {
  let dir: string;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function seedSource(source: string): void {
    fs.mkdirSync(path.join(source, 'papers'), { recursive: true });
    makeMetisDb(path.join(source, 'metis.db'));
    fs.writeFileSync(path.join(source, 'settings.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(source, 'papers', 'a.pdf'), 'pdf-bytes', 'utf-8');
  }

  it('moves a full data directory, verifies it, then deletes the source', () => {
    const source = path.join(dir, 'old-data');
    const target = path.join(dir, 'new-data');
    seedSource(source);
    fs.mkdirSync(target);

    expect(migrateDataDirSync(source, target, { requireCompleteTarget: true })).toEqual({ ok: true });
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.existsSync(path.join(target, 'metis.db'))).toBe(true);
    expect(fs.readFileSync(path.join(target, 'papers', 'a.pdf'), 'utf-8')).toBe('pdf-bytes');
    expect(fs.readFileSync(path.join(target, 'settings.json'), 'utf-8')).toBe('{}');
  });

  it('adopts an existing complete target database', () => {
    const source = path.join(dir, 'old-data');
    const target = path.join(dir, 'new-data');
    seedSource(source);
    fs.mkdirSync(target);
    makeMetisDb(path.join(target, 'metis.db'));

    expect(migrateDataDirSync(source, target, { requireCompleteTarget: true })).toEqual({ ok: true });
    expect(fs.existsSync(source)).toBe(false);
  });

  it('finishes an incomplete previous copy instead of adopting it', () => {
    const source = path.join(dir, 'old-data');
    const target = path.join(dir, 'new-data');
    seedSource(source);
    fs.mkdirSync(target);
    // A partial attempt: only the database landed, papers/ never made it.
    makeMetisDb(path.join(target, 'metis.db'));

    expect(migrateDataDirSync(source, target, { requireCompleteTarget: true })).toEqual({ ok: true });
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(path.join(target, 'papers', 'a.pdf'), 'utf-8')).toBe('pdf-bytes');
  });

  it('fails cleanly on nesting and leaves the source untouched', () => {
    const source = path.join(dir, 'old-data');
    seedSource(source);
    const nested = path.join(source, 'nested-target');
    const result = migrateDataDirSync(source, nested, { requireCompleteTarget: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('nested');
    expect(fs.existsSync(source)).toBe(true);
  });

  it('fails when the source is not a directory and keeps it intact', () => {
    const source = path.join(dir, 'not-a-dir');
    const target = path.join(dir, 'new-data');
    fs.writeFileSync(source, 'file');
    fs.mkdirSync(target);
    const result = migrateDataDirSync(source, target, { requireCompleteTarget: true });
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(source, 'utf-8')).toBe('file');
  });

  it('fails when the copied database fails integrity verification', () => {
    const source = path.join(dir, 'old-data');
    const target = path.join(dir, 'new-data');
    fs.mkdirSync(path.join(source, 'papers'), { recursive: true });
    fs.writeFileSync(path.join(source, 'metis.db'), 'garbage-not-sqlite');
    fs.mkdirSync(target);
    const result = migrateDataDirSync(source, target, { requireCompleteTarget: true });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.existsSync(path.join(target, 'metis.db'))).toBe(true); // copy happened
  });

  it('treats a missing source as already-migrated', () => {
    const target = path.join(dir, 'new-data');
    fs.mkdirSync(target);
    expect(migrateDataDirSync(path.join(dir, 'gone'), target, { requireCompleteTarget: true })).toEqual({ ok: true });
  });
});

describe('resolveDataDir', () => {
  let userDataDir: string;

  beforeEach(() => { userDataDir = tempDir(); });
  afterEach(() => { fs.rmSync(userDataDir, { recursive: true, force: true }); });

  const logs: string[] = [];
  const log = (m: string) => { logs.push(m); };
  beforeEach(() => { logs.length = 0; });

  it('uses the default when no pointer exists', () => {
    const resolved = resolveDataDir(userDataDir, log);
    expect(resolved.dataDir).toBe(path.join(userDataDir, 'metis-data'));
    expect(resolved.migrated).toBe(false);
    expect(resolved.migrationError).toBeUndefined();
  });

  it('uses a valid pointer target without migrating', () => {
    const target = path.join(userDataDir, 'elsewhere');
    writeLocationPointer(userDataDir, { version: 1, dataDir: target, pendingMigrateFrom: null });
    const resolved = resolveDataDir(userDataDir, log);
    expect(resolved.dataDir).toBe(target);
    expect(resolved.migrated).toBe(false);
  });

  it('falls back to the default when the pointer target is invalid', () => {
    const bogus = path.join(userDataDir, 'bogus-file');
    fs.writeFileSync(bogus, 'x');
    writeLocationPointer(userDataDir, { version: 1, dataDir: bogus, pendingMigrateFrom: null });
    const resolved = resolveDataDir(userDataDir, log);
    expect(resolved.dataDir).toBe(path.join(userDataDir, 'metis-data'));
  });

  it('completes a pending relocation and updates the pointer', () => {
    const source = path.join(userDataDir, 'metis-data');
    seedSourceForResolve(source);
    const target = path.join(userDataDir, 'relocated');
    writeLocationPointer(userDataDir, { version: 1, dataDir: target, pendingMigrateFrom: source });

    const resolved = resolveDataDir(userDataDir, log);
    expect(resolved.dataDir).toBe(target);
    expect(resolved.migrated).toBe(true);
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.existsSync(path.join(target, 'metis.db'))).toBe(true);
    const pointer = readLocationPointer(userDataDir);
    expect(pointer?.dataDir).toBe(target);
    expect(pointer?.pendingMigrateFrom).toBeNull();
  });

  it('reverts to the source location when the relocation fails', () => {
    const source = path.join(userDataDir, 'metis-data');
    fs.writeFileSync(source, 'i am a file, not a dir');
    const target = path.join(userDataDir, 'relocated');
    writeLocationPointer(userDataDir, { version: 1, dataDir: target, pendingMigrateFrom: source });

    const resolved = resolveDataDir(userDataDir, log);
    expect(resolved.dataDir).toBe(source);
    expect(resolved.migrated).toBe(false);
    expect(resolved.migrationError).toBeTruthy();
    expect(fs.readFileSync(source, 'utf-8')).toBe('i am a file, not a dir');
    const pointer = readLocationPointer(userDataDir);
    expect(pointer?.dataDir).toBe(source);
    expect(pointer?.pendingMigrateFrom).toBeNull();
  });

  it('clears a stale pending flag when source and target are identical', () => {
    const target = path.join(userDataDir, 'metis-data');
    writeLocationPointer(userDataDir, { version: 1, dataDir: target, pendingMigrateFrom: target });
    const resolved = resolveDataDir(userDataDir, log);
    expect(resolved.dataDir).toBe(target);
    expect(readLocationPointer(userDataDir)?.pendingMigrateFrom).toBeNull();
  });

  function seedSourceForResolve(source: string): void {
    fs.mkdirSync(path.join(source, 'papers'), { recursive: true });
    makeMetisDb(path.join(source, 'metis.db'));
    fs.writeFileSync(path.join(source, 'papers', 'a.pdf'), 'pdf-bytes', 'utf-8');
  }
});
