import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import asar from '@electron/asar';
import { FileMatcher } from 'app-builder-lib/out/fileMatcher.js';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- release tooling is intentionally executable ESM rather than compiled application TypeScript.
import {
  asarApiPath,
  missingRequiredAsarEntries,
  normalizeAsarEntry,
  scanAsarArchive,
  scanPackagedTree,
} from '../../scripts/release-package-scan-lib.mjs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('release ASAR scanner', () => {
  it('uses native ASAR API paths while reporting normalized paths and scans every file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-release-scan-'));
    roots.push(root);
    const source = path.join(root, 'source');
    const archive = path.join(root, 'app.asar');
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(source, 'index.js'), 'export const ready = true;\n');
    fs.writeFileSync(path.join(source, 'nested', 'data.json'), '{"ok":true}\n');
    await asar.createPackage(source, archive);

    const observed: Array<{ normalizedPath: string; size: number; bytes: string }> = [];
    const directories: string[] = [];
    const result = scanAsarArchive(archive, ({ normalizedPath, read, size }: {
      normalizedPath: string;
      read: () => Buffer;
      size: number;
    }) => {
      const bytes = read();
      observed.push({ normalizedPath, size, bytes: bytes.toString('utf8') });
    }, ({ normalizedPath }: { normalizedPath: string }) => directories.push(normalizedPath)) as {
      scannedFiles: number;
      directories: number;
    };

    expect(result.scannedFiles).toBe(2);
    expect(observed.map((item) => item.normalizedPath).sort()).toEqual(['index.js', 'nested/data.json']);
    expect(observed.every((item) => item.size === Buffer.byteLength(item.bytes))).toBe(true);
    expect(result.directories).toBe(1);
    expect(directories).toEqual(['nested']);
  });

  it('rejects traversal-like or empty report paths', () => {
    expect(() => normalizeAsarEntry('\\..\\secret.txt')).toThrow(/Unsafe ASAR entry path/u);
    expect(() => normalizeAsarEntry('')).toThrow(/Invalid ASAR entry path/u);
    expect(asarApiPath('\\node_modules\\pkg\\index.js')).toBe('node_modules\\pkg\\index.js');
  });

  it('requires the application license inside the distributable ASAR', () => {
    expect(missingRequiredAsarEntries(['LICENSE', 'dist/index.html'])).toEqual([]);
    expect(missingRequiredAsarEntries(['dist/index.html'])).toEqual(['LICENSE']);
  });

  it('binds every physical unpacked file and directory to a deterministic tree digest', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-unpacked-tree-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'resources', 'app.asar.unpacked'), { recursive: true });
    fs.writeFileSync(path.join(root, 'app.exe'), Buffer.from('binary-one'));
    fs.writeFileSync(path.join(root, 'resources', 'app.asar'), Buffer.from('archive-one'));
    fs.writeFileSync(path.join(root, 'resources', 'app.asar.unpacked', 'native.node'), Buffer.from('native-one'));
    const observed: string[] = [];
    const first = scanPackagedTree(root, ({ normalizedPath }: { normalizedPath: string }) => {
      observed.push(normalizedPath);
    }) as { listedEntries: number; scannedFiles: number; directories: number; treeSha256: string };
    const repeated = scanPackagedTree(root) as typeof first;

    expect(first).toEqual(repeated);
    expect(first.scannedFiles).toBe(3);
    expect(first.directories).toBe(2);
    expect(first.listedEntries).toBe(5);
    expect(first.treeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(observed.sort()).toEqual([
      'app.exe',
      'resources/app.asar',
      'resources/app.asar.unpacked/native.node',
    ]);

    fs.writeFileSync(path.join(root, 'resources', 'app.asar.unpacked', 'native.node'), Buffer.from('native-two'));
    const changed = scanPackagedTree(root) as typeof first;
    expect(changed.treeSha256).not.toBe(first.treeSha256);

    fs.writeFileSync(path.join(root, 'resources', '.env'), 'SECRET=not-a-real-secret\n');
    const added = scanPackagedTree(root) as typeof first;
    expect(added.scannedFiles).toBe(4);
    expect(added.treeSha256).not.toBe(changed.treeSha256);
  });

  it('uses the real electron-builder matcher to exclude development files without removing native runtime files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-builder-files-'));
    roots.push(root);
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as {
      build: { files: string[] };
    };
    const matcher = new FileMatcher(root, path.join(root, 'out'), (value) => value, pkg.build.files);
    const filter = matcher.createFilter();
    const included = (relativePath: string) => {
      const absolute = path.join(root, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, 'fixture');
      return filter(absolute, fs.statSync(absolute));
    };
    const excluded = [
      'dist/assets/app.js.map',
      'dist/rogue.ts',
      'dist/rogue.tsx',
      'dist/rogue.mts',
      'dist/rogue.cts',
      'dist/test/x.js',
      'dist/tests/x.js',
      'dist/example/x.js',
      'dist/examples/x.js',
      'dist-electron/electron/rogue.ts',
      'node_modules/pkg/index.ts',
      'node_modules/pkg/test/x.js',
      'node_modules/expand-template/test.js',
      'node_modules/pkg/spec.cjs',
    ];
    const retained = [
      'LICENSE',
      'dist/index.html',
      'dist/assets/app.js',
      'dist-electron/electron/main.js',
      'node_modules/better-sqlite3/package.json',
      'node_modules/better-sqlite3/lib/index.js',
      'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
      'node_modules/node-pty/package.json',
      'node_modules/node-pty/lib/index.js',
      'node_modules/node-pty/prebuilds/win32-x64/pty.node',
    ];
    expect(excluded.filter(included)).toEqual([]);
    expect(retained.filter((file) => !included(file))).toEqual([]);
  });
});
