import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SkillDefinitionV2 } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { PersonalizationBundleSkillAssetSource } from '../../electron/PersonalizationBundleSkillAssetSource.js';
import { PersonalizationSkillInstaller } from '../../electron/PersonalizationSkillInstaller.js';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-bundle-asset-source-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function packageFixture() {
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  const skill = Buffer.from('# Portable Skill\n\nUse traceable evidence.\n', 'utf8');
  const script = Buffer.from('export const normalize = (value) => value;\n', 'utf8');
  const manifest = {
    schemaVersion: 1,
    id: 'user:skills/portable',
    name: 'Portable Skill',
    description: 'Portable package fixture',
    version: '1.2.3',
    author: 'Metis test',
    license: 'MIT',
    entry: 'SKILL.md',
    systemPromptFile: 'SKILL.md',
    files: [
      { path: 'SKILL.md', size: skill.length, sha256: sha256(skill), role: 'documentation', executable: false },
      { path: 'scripts/normalize.mjs', size: script.length, sha256: sha256(script), role: 'script', executable: false },
    ],
  };
  fs.writeFileSync(path.join(source, 'SKILL.md'), skill);
  fs.writeFileSync(path.join(source, 'scripts', 'normalize.mjs'), script);
  fs.writeFileSync(path.join(source, 'metis-skill.json'), JSON.stringify(manifest));
  return { source, skill: skill.toString('utf8') };
}

function definition(installed: NonNullable<ReturnType<PersonalizationSkillInstaller['getInstalled']>>, markdown: string): SkillDefinitionV2 {
  return {
    contractVersion: 1,
    id: installed.id,
    kind: 'skill',
    name: installed.manifest.name,
    description: installed.manifest.description,
    enabled: true,
    tags: ['package', 'installed'],
    revision: 1,
    provenance: {
      origin: 'user',
      author: installed.manifest.author,
      version: installed.version,
      license: installed.manifest.license,
      sourceUrl: null,
      sourceRevision: installed.provenance.manifestSha256,
      installedDigest: installed.packageDigest,
      parentId: null,
      parentVersion: null,
      locallyModified: false,
      createdAt: 1_785_398_400_000,
      updatedAt: 1_785_398_400_000,
    },
    sourceMode: 'package',
    markdown,
    systemPrompt: markdown,
    toolIds: [],
    mcpIds: [],
    maxTurns: 20,
    inputSchema: null,
    outputSchema: null,
    packageEntry: installed.manifest.entry,
  };
}

describe('PersonalizationBundleSkillAssetSource', () => {
  it('lists exactly the verified portable package manifest and declared files', () => {
    const fixture = packageFixture();
    const installer = new PersonalizationSkillInstaller(path.join(root, 'installed'));
    const installedResult = installer.installFromPackage(fixture.source);
    expect(installedResult.ok).toBe(true);
    if (!installedResult.ok) return;
    const portable = definition(installedResult.installed, fixture.skill);
    const source = new PersonalizationBundleSkillAssetSource({
      get: (id) => id === portable.id ? portable : undefined,
    }, installer);

    const assets = source.list(portable.id);
    expect(assets?.relativePaths).toEqual([
      'metis-skill.json',
      'SKILL.md',
      'scripts/normalize.mjs',
    ]);
    expect(assets?.relativePaths).not.toContain('metis-install.json');
    expect(assets?.rootDirectory).toBe(installer.resolveInstalledDirectory(portable.id, portable.provenance.version));
  });

  it('fails closed when an edited definition no longer matches the installed package text', () => {
    const fixture = packageFixture();
    const installer = new PersonalizationSkillInstaller(path.join(root, 'installed'));
    const installedResult = installer.installFromPackage(fixture.source);
    expect(installedResult.ok).toBe(true);
    if (!installedResult.ok) return;
    const portable = definition(installedResult.installed, '# Locally changed prompt');
    const source = new PersonalizationBundleSkillAssetSource({ get: () => portable }, installer);
    expect(() => source.list(portable.id)).toThrow(/differs from its installed package/u);
  });

  it('fails closed after installed bytes are tampered and never exports a local path for Markdown skills', () => {
    const fixture = packageFixture();
    const installer = new PersonalizationSkillInstaller(path.join(root, 'installed'));
    const installedResult = installer.installFromPackage(fixture.source);
    expect(installedResult.ok).toBe(true);
    if (!installedResult.ok) return;
    const portable = definition(installedResult.installed, fixture.skill);
    const source = new PersonalizationBundleSkillAssetSource({ get: () => portable }, installer);
    const installedDirectory = installer.resolveInstalledDirectory(portable.id, portable.provenance.version);
    expect(installedDirectory).toBeTruthy();
    fs.writeFileSync(path.join(installedDirectory!, 'SKILL.md'), 'tampered');
    expect(() => source.list(portable.id)).toThrow(/unavailable or inconsistent/u);

    expect(new PersonalizationBundleSkillAssetSource({
      get: () => ({ ...portable, sourceMode: 'markdown', packageEntry: null }),
    }, installer).list(portable.id)).toBeUndefined();
  });
});
