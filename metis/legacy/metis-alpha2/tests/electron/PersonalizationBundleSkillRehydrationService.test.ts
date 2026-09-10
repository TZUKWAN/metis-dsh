import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PersonalizationBundleSkillRehydrationService,
  type BundleSkillRehydrationInstaller,
} from '../../electron/PersonalizationBundleSkillRehydrationService.js';
import { PersonalizationSkillInstaller } from '../../electron/PersonalizationSkillInstaller.js';
import {
  PersonalizationBundleManifestSchema,
  type PersonalizationBundleAssetBinding,
} from '../../engine/runtime/PersonalizationBundleContract.js';
import type { SkillDefinitionV2 } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import type {
  InstalledSkillVersion,
  SkillInstallationResult,
  SkillPackageManifest,
} from '../../engine/runtime/SkillInstallationContract.js';

let root: string;
let bundleRoot: string;
let stagingRoot: string;
let skillStore: string;
let installer: PersonalizationSkillInstaller;
let bundleSequence = 0;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-bundle-skill-rehydrate-'));
  bundleRoot = path.join(root, 'bundle-assets');
  stagingRoot = path.join(root, 'rehydration-staging');
  skillStore = path.join(root, 'managed-skills');
  fs.mkdirSync(bundleRoot);
  installer = new PersonalizationSkillInstaller(skillStore, { now: () => 1_800_001_000_000 });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function provenance(input?: { origin?: 'user' | 'url'; installedDigest?: string | null }) {
  return {
    origin: input?.origin ?? 'user' as const,
    author: 'Portable Skill author',
    version: '1.0.0',
    license: 'Apache-2.0',
    sourceUrl: input?.origin === 'url' ? 'https://skills.example.org/portable.zip' : null,
    sourceRevision: null,
    installedDigest: input?.installedDigest ?? null,
    parentId: null,
    parentVersion: null,
    locallyModified: false,
    createdAt: 1_800_001_000_000,
    updatedAt: 1_800_001_000_000,
  };
}

function markdownDefinition(content = '# Portable Markdown\n\nKeep claims traceable.\n'): SkillDefinitionV2 {
  return {
    contractVersion: 1,
    id: 'user:skills/portable-markdown',
    kind: 'skill',
    name: 'Portable Markdown',
    description: 'A directly authored Markdown Skill.',
    enabled: true,
    tags: ['portable'],
    revision: 1,
    provenance: provenance(),
    sourceMode: 'markdown',
    markdown: content,
    systemPrompt: content,
    toolIds: [],
    mcpIds: [],
    maxTurns: 8,
    inputSchema: null,
    outputSchema: null,
    packageEntry: null,
  };
}

function packagedFixture(options?: {
  id?: string;
  origin?: 'user' | 'url';
  extraZipEntries?: Array<{ name: string; data: Buffer }>;
}) {
  const id = options?.id ?? 'user:skills/portable-package';
  const markdown = Buffer.from('# Portable ZIP\n\nRun only declared, verified behavior.\n', 'utf8');
  const manifest: SkillPackageManifest = {
    schemaVersion: 1,
    id,
    name: 'Portable ZIP',
    description: 'A strict portable ZIP Skill fixture.',
    version: '1.0.0',
    author: 'Portable Skill author',
    license: 'Apache-2.0',
    entry: 'SKILL.md',
    systemPromptFile: 'SKILL.md',
    files: [{
      path: 'SKILL.md',
      size: markdown.length,
      sha256: sha256(markdown),
      role: 'documentation',
      executable: false,
    }],
  };
  const archive = createStoredZip([
    { name: 'metis-skill.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    { name: 'SKILL.md', data: markdown },
    ...(options?.extraZipEntries ?? []),
  ]);
  const definition: SkillDefinitionV2 = {
    contractVersion: 1,
    id,
    kind: 'skill',
    name: manifest.name,
    description: manifest.description,
    enabled: true,
    tags: ['portable', 'package'],
    revision: 1,
    provenance: provenance({ origin: options?.origin, installedDigest: sha256(archive) }),
    sourceMode: options?.origin === 'url' ? 'url' : 'package',
    markdown: markdown.toString('utf8'),
    systemPrompt: markdown.toString('utf8'),
    toolIds: [],
    mcpIds: [],
    maxTurns: 20,
    inputSchema: null,
    outputSchema: null,
    packageEntry: manifest.entry,
  };
  return { archive, definition, manifest, markdown };
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries: ReadonlyArray<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc32(entry.data), 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc32(entry.data), 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function createBinding(
  definition: SkillDefinitionV2,
  assets: ReadonlyArray<{ path: string; bytes: Buffer }>,
) {
  bundleSequence += 1;
  const bundleDigest = sha256(`bundle-${bundleSequence}-${definition.id}-${assets.map((asset) => sha256(asset.bytes)).join('-')}`);
  const directoryToken = `bundle_${bundleDigest.slice(0, 32)}`;
  const relativeRoot = sha256(definition.id).slice(0, 24);
  const bundleDirectory = path.join(bundleRoot, directoryToken);
  const assetRoot = path.join(bundleDirectory, relativeRoot);
  fs.mkdirSync(assetRoot, { recursive: true });
  const manifest = PersonalizationBundleManifestSchema.parse({
    format: 'metis-personalization-bundle',
    version: 1,
    bundleId: '00000000-0000-4000-8000-000000000001',
    createdAt: 1_800_001_000_000,
    createdBy: 'Bundle Skill rehydration test',
    rootDefinitionIds: [definition.id],
    definitions: [{
      id: definition.id,
      kind: 'skill',
      payloadPath: 'definitions/skill.json',
      size: 1,
      sha256: '0'.repeat(64),
      secretRefs: [],
    }],
    assets: assets.map((asset, index) => ({
      ownerId: definition.id,
      assetPath: asset.path,
      payloadPath: `assets/${relativeRoot}/${index}-${path.posix.basename(asset.path)}`,
      included: true,
      executable: false,
      size: asset.bytes.length,
      sha256: sha256(asset.bytes),
    })),
    bundleDigest,
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  fs.writeFileSync(path.join(bundleDirectory, 'bundle-manifest.json'), manifestBytes);
  for (const asset of assets) {
    const destination = path.join(assetRoot, ...asset.path.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, asset.bytes);
  }
  const binding: PersonalizationBundleAssetBinding = {
    ownerId: definition.id,
    directoryToken,
    relativeRoot,
  };
  return {
    binding,
    bundleDirectory,
    assetRoot,
    manifestPath: path.join(bundleDirectory, 'bundle-manifest.json'),
    bundleManifestSha256: sha256(manifestBytes),
  };
}

function service(port: BundleSkillRehydrationInstaller = installer) {
  return new PersonalizationBundleSkillRehydrationService(
    bundleRoot,
    stagingRoot,
    port,
  );
}

function expectNoStaging(): void {
  expect(fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot) : []).toEqual([]);
}

describe('PersonalizationBundleSkillRehydrationService', () => {
  it('rehydrates a bound Markdown asset through the real installer and is idempotent', () => {
    const definition = markdownDefinition();
    const fixture = createBinding(definition, [{
      path: 'SKILL.md',
      bytes: Buffer.from(definition.markdown, 'utf8'),
    }]);
    const request = {
      definition,
      assetBinding: fixture.binding,
      bundleManifestSha256: fixture.bundleManifestSha256,
    };

    const first = service().rehydrate(request);
    expect(first).toMatchObject({
      ok: true,
      code: 'rehydrated',
      reused: false,
      localInstallationId: expect.stringMatching(/^skill_install_[a-f0-9]{32}$/u),
      installed: { id: definition.id, version: '1.0.0' },
    });
    if (!first.ok) throw new Error(first.detail);
    const installedDirectory = installer.resolveInstalledDirectory(definition.id, '1.0.0');
    expect(installedDirectory).toBeDefined();
    expect(fs.readFileSync(path.join(installedDirectory!, 'SKILL.md'), 'utf8')).toBe(definition.markdown);
    expect(path.relative(skillStore, installedDirectory!).startsWith('..')).toBe(false);
    expect(path.relative(bundleRoot, installedDirectory!).startsWith('..')).toBe(true);

    const second = service().rehydrate(request);
    expect(second).toMatchObject({
      ok: true,
      reused: true,
      localInstallationId: first.localInstallationId,
    });
    expect(installer.listInstalled(definition.id)).toHaveLength(1);
    expectNoStaging();
  });

  it('rehydrates a hash-bound ZIP into a new local installation identity', () => {
    const packaged = packagedFixture();
    const fixture = createBinding(packaged.definition, [{ path: 'portable-skill.zip', bytes: packaged.archive }]);
    const result = service().rehydrate({
      definition: packaged.definition,
      assetBinding: fixture.binding,
      bundleManifestSha256: fixture.bundleManifestSha256,
    });

    expect(result).toMatchObject({
      ok: true,
      reused: false,
      installed: {
        id: packaged.definition.id,
        version: '1.0.0',
        packageDigest: sha256(packaged.archive),
      },
    });
    if (!result.ok) throw new Error(result.detail);
    const directory = installer.resolveInstalledDirectory(packaged.definition.id, '1.0.0');
    expect(fs.readFileSync(path.join(directory!, 'SKILL.md'))).toEqual(packaged.markdown);
    expect(result.localInstallationId).not.toContain(fixture.binding.directoryToken);
    expectNoStaging();
  });

  it('rehydrates a verified extracted package inventory without trusting its old install record', () => {
    const packaged = packagedFixture({ id: 'url:skills/portable-extracted', origin: 'url' });
    const manifestBytes = Buffer.from(JSON.stringify(packaged.manifest), 'utf8');
    const fixture = createBinding(packaged.definition, [
      { path: 'metis-skill.json', bytes: manifestBytes },
      { path: 'SKILL.md', bytes: packaged.markdown },
    ]);
    const result = service().rehydrate({
      definition: packaged.definition,
      assetBinding: fixture.binding,
      bundleManifestSha256: fixture.bundleManifestSha256,
    });

    expect(result).toMatchObject({
      ok: true,
      installed: {
        id: 'url:skills/portable-extracted',
        provenance: { sourceMode: 'package', sourceUrl: null },
      },
    });
    expect(installer.resolveInstalledDirectory(packaged.definition.id, '1.0.0')).toBeDefined();
    expectNoStaging();
  });

  it('rejects binding substitution, manifest tamper, asset tamper, and undeclared files without installation pollution', () => {
    const cases: Array<{
      label: string;
      arrange: () => {
        definition: SkillDefinitionV2;
        assetBinding: PersonalizationBundleAssetBinding;
        bundleManifestSha256: string;
      };
      expectedCode: string;
    }> = [
      {
        label: 'binding substitution',
        arrange: () => {
          const definition = markdownDefinition();
          const fixture = createBinding(definition, [{ path: 'SKILL.md', bytes: Buffer.from(definition.markdown) }]);
          return {
            definition,
            assetBinding: { ...fixture.binding, relativeRoot: 'f'.repeat(24) },
            bundleManifestSha256: fixture.bundleManifestSha256,
          };
        },
        expectedCode: 'binding_rejected',
      },
      {
        label: 'manifest tamper',
        arrange: () => {
          const definition = markdownDefinition();
          const fixture = createBinding(definition, [{ path: 'SKILL.md', bytes: Buffer.from(definition.markdown) }]);
          fs.appendFileSync(fixture.manifestPath, '\n');
          return { definition, assetBinding: fixture.binding, bundleManifestSha256: fixture.bundleManifestSha256 };
        },
        expectedCode: 'asset_tampered',
      },
      {
        label: 'asset tamper',
        arrange: () => {
          const definition = markdownDefinition();
          const fixture = createBinding(definition, [{ path: 'SKILL.md', bytes: Buffer.from(definition.markdown) }]);
          fs.writeFileSync(path.join(fixture.assetRoot, 'SKILL.md'), '# altered bytes');
          return { definition, assetBinding: fixture.binding, bundleManifestSha256: fixture.bundleManifestSha256 };
        },
        expectedCode: 'asset_tampered',
      },
      {
        label: 'undeclared file',
        arrange: () => {
          const definition = markdownDefinition();
          const fixture = createBinding(definition, [{ path: 'SKILL.md', bytes: Buffer.from(definition.markdown) }]);
          fs.writeFileSync(path.join(fixture.assetRoot, 'undeclared.txt'), 'not in bundle manifest');
          return { definition, assetBinding: fixture.binding, bundleManifestSha256: fixture.bundleManifestSha256 };
        },
        expectedCode: 'asset_tampered',
      },
    ];

    for (const attack of cases) {
      const request = attack.arrange();
      expect(service().rehydrate(request), attack.label).toMatchObject({
        ok: false,
        code: attack.expectedCode,
      });
      expect(installer.listInstalled()).toEqual([]);
      expectNoStaging();
    }
  });

  it('lets the real ZIP parser reject traversal and leaves no escaped or installed file', () => {
    const packaged = packagedFixture({
      id: 'user:skills/traversal-package',
      extraZipEntries: [{ name: '../escape.txt', data: Buffer.from('escape') }],
    });
    const fixture = createBinding(packaged.definition, [{ path: 'hostile.zip', bytes: packaged.archive }]);
    const result = service().rehydrate({
      definition: packaged.definition,
      assetBinding: fixture.binding,
      bundleManifestSha256: fixture.bundleManifestSha256,
    });

    expect(result).toMatchObject({ ok: false, code: 'install_failed', detail: 'path_invalid' });
    expect(installer.listInstalled()).toEqual([]);
    expect(fs.existsSync(path.join(root, 'escape.txt'))).toBe(false);
    expectNoStaging();
  });

  it('requires the original ZIP digest and rejects malformed or throwing installer ports', () => {
    const packaged = packagedFixture();
    const fixture = createBinding(packaged.definition, [{ path: 'portable.zip', bytes: packaged.archive }]);
    const missingDigest: SkillDefinitionV2 = {
      ...packaged.definition,
      provenance: { ...packaged.definition.provenance, installedDigest: null },
    };
    expect(service().rehydrate({
      definition: missingDigest,
      assetBinding: fixture.binding,
      bundleManifestSha256: fixture.bundleManifestSha256,
    })).toMatchObject({ ok: false, code: 'asset_tampered', detail: 'archive_digest_differs_from_definition' });

    const malformedPort: BundleSkillRehydrationInstaller = {
      getInstalled: () => undefined,
      installFromPackage: () => ({ ok: true, installed: {} }) as unknown as SkillInstallationResult,
      resolveInstalledDirectory: () => undefined,
      uninstall: () => ({ ok: true }),
    };
    expect(service(malformedPort).rehydrate({
      definition: markdownDefinition(),
      assetBinding: null,
      bundleManifestSha256: null,
    })).toMatchObject({ ok: false, code: 'install_failed', detail: 'invalid_installer_response' });

    const throwingLookup: BundleSkillRehydrationInstaller = {
      getInstalled: () => { throw new Error('lookup unavailable'); },
      installFromPackage: () => { throw new Error('must not install'); },
      resolveInstalledDirectory: () => undefined,
      uninstall: () => ({ ok: true }),
    };
    expect(service(throwingLookup).rehydrate({
      definition: markdownDefinition(),
      assetBinding: null,
      bundleManifestSha256: null,
    })).toMatchObject({ ok: false, code: 'install_failed', detail: 'installer_lookup_failed' });
    expect(installer.listInstalled()).toEqual([]);
    expectNoStaging();
  });

  it('rejects a same-version local collision instead of overwriting it', () => {
    const original = markdownDefinition();
    expect(service().rehydrate({
      definition: original,
      assetBinding: null,
      bundleManifestSha256: null,
    }).ok).toBe(true);
    const changed = markdownDefinition('# Changed content at the same version\n');
    const result = service().rehydrate({
      definition: changed,
      assetBinding: null,
      bundleManifestSha256: null,
    });

    expect(result).toMatchObject({ ok: false, code: 'install_conflict' });
    const directory = installer.resolveInstalledDirectory(original.id, '1.0.0');
    expect(fs.readFileSync(path.join(directory!, 'SKILL.md'), 'utf8')).toBe(original.markdown);
    expectNoStaging();
  });

  it('compensates a newly installed version when post-install verification fails', () => {
    const definition = markdownDefinition();
    let uninstallCalls = 0;
    const postVerificationFailure: BundleSkillRehydrationInstaller = {
      installFromPackage: (sourcePath): SkillInstallationResult => installer.installFromPackage(sourcePath),
      getInstalled: (id, version): InstalledSkillVersion | undefined => installer.getInstalled(id, version),
      resolveInstalledDirectory: () => undefined,
      uninstall: (id, version) => {
        uninstallCalls += 1;
        return installer.uninstall(id, version);
      },
    };
    const result = service(postVerificationFailure).rehydrate({
      definition,
      assetBinding: null,
      bundleManifestSha256: null,
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'verification_failed',
      compensated: true,
    });
    expect(uninstallCalls).toBe(1);
    expect(installer.getInstalled(definition.id, '1.0.0')).toBeUndefined();
    expectNoStaging();
  });

  it('reports compensation failure instead of claiming cleanup', () => {
    const definition = markdownDefinition();
    const uncompensated: BundleSkillRehydrationInstaller = {
      installFromPackage: (sourcePath): SkillInstallationResult => installer.installFromPackage(sourcePath),
      getInstalled: (id, version): InstalledSkillVersion | undefined => installer.getInstalled(id, version),
      resolveInstalledDirectory: () => undefined,
      uninstall: () => ({ ok: false }),
    };
    const result = service(uncompensated).rehydrate({
      definition,
      assetBinding: null,
      bundleManifestSha256: null,
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'compensation_failed',
      compensated: false,
    });
    expect(installer.getInstalled(definition.id, '1.0.0')).toBeDefined();
    expectNoStaging();
  });

  it('rejects missing trusted manifest digest and overlapping trusted roots', () => {
    const packaged = packagedFixture();
    const fixture = createBinding(packaged.definition, [{ path: 'portable.zip', bytes: packaged.archive }]);
    expect(service().rehydrate({
      definition: packaged.definition,
      assetBinding: fixture.binding,
      bundleManifestSha256: null,
    })).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(() => new PersonalizationBundleSkillRehydrationService(
      bundleRoot,
      path.join(bundleRoot, 'nested-staging'),
      installer,
    )).toThrow(/isolated/u);
    expect(installer.listInstalled()).toEqual([]);
  });

  it('rejects a symlink ancestor before creating staging outside its declared path', () => {
    const outside = path.join(root, 'outside-staging-target');
    const link = path.join(root, 'staging-link');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => new PersonalizationBundleSkillRehydrationService(
      bundleRoot,
      path.join(link, 'must-not-be-created'),
      installer,
    )).toThrow(/ancestor|escapes|unsafe/iu);
    expect(fs.existsSync(path.join(outside, 'must-not-be-created'))).toBe(false);
  });
});
