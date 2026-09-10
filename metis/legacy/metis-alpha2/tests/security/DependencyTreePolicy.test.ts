import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
}

interface LockPackage {
  version?: string;
}

interface PackageLock {
  packages: Record<string, LockPackage>;
}

const root = process.cwd();
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as PackageManifest;
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')) as PackageLock;

function installedVersions(packageName: string): string[] {
  const suffix = `node_modules/${packageName}`;
  return Object.entries(lock.packages)
    .filter(([path]) => path === suffix || path.endsWith(`/${suffix}`))
    .map(([, entry]) => entry.version)
    .filter((version): version is string => typeof version === 'string')
    .sort();
}

function installedEntries(packageName: string): Array<{ path: string; version: string }> {
  const suffix = `node_modules/${packageName}`;
  return Object.entries(lock.packages)
    .filter(([path]) => path === suffix || path.endsWith(`/${suffix}`))
    .flatMap(([path, entry]) => typeof entry.version === 'string'
      ? [{ path, version: entry.version }]
      : []);
}

function versionAtLeast(version: string, minimum: readonly [number, number, number]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index]! > minimum[index]!) return true;
    if (actual[index]! < minimum[index]!) return false;
  }
  return true;
}

function isPatchedBraceExpansion(version: string): boolean {
  const major = Number(version.split('.')[0]);
  if (major === 1) return versionAtLeast(version, [1, 1, 18]);
  if (major === 2) return versionAtLeast(version, [2, 1, 4]);
  if (major === 3) return versionAtLeast(version, [3, 0, 6]);
  if (major >= 5) return versionAtLeast(version, [5, 0, 8]);
  return false;
}

describe('dependency-tree security policy', () => {
  it('keeps every brace-expansion line above the GHSA-mh99-v99m-4gvg patch floor', () => {
    const installed = installedVersions('brace-expansion');
    expect(installed.length).toBeGreaterThan(0);
    expect(installed.filter((version) => !isPatchedBraceExpansion(version))).toEqual([]);
    expect(manifest.overrides).toMatchObject({
      'brace-expansion@^1.0.0': '1.1.18',
      'brace-expansion@^2.0.0': '2.1.4',
    });
  });

  it('executes the maintenance-line maxLength bound instead of trusting version labels alone', () => {
    const legacyLines = installedEntries('brace-expansion')
      .filter(({ version }) => Number(version.split('.')[0]) < 5);
    expect(legacyLines.length).toBeGreaterThan(0);

    for (const entry of legacyLines) {
      const packageRoot = resolve(root, entry.path);
      const source = readFileSync(resolve(packageRoot, 'index.js'), 'utf8');
      expect(source).toContain('CVE-2026-14257');
      expect(source).toContain('EXPANSION_MAX_LENGTH');

      const expand = require(packageRoot) as (
        pattern: string,
        options: { max: number; maxLength: number },
      ) => string[];
      const output = expand('{a,b}'.repeat(20), { max: 100_000, maxLength: 1_000 });
      expect(output.reduce((total, value) => total + value.length, 0)).toBeLessThanOrEqual(1_000);
    }
  });

  it('does not restore deprecated or unused legacy terminal packages', () => {
    const declared = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
    };
    for (const packageName of ['xterm', 'xterm-addon-fit', '@xterm/addon-web-links']) {
      expect(declared).not.toHaveProperty(packageName);
      expect(installedVersions(packageName)).toEqual([]);
    }
  });
});
