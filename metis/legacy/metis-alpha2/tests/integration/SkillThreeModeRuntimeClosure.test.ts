import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { LookupAddress, LookupAllOptions, LookupOneOptions, LookupOptions } from 'node:dns';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import type { PersonalizationDefinition, ScenarioDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import type { SkillPackageManifest } from '../../engine/runtime/SkillInstallationContract.js';
import { EvidenceEnvelopeService } from '../../electron/EvidenceEnvelopeService.js';
import type { ExecutionOwnerIdentity } from '../../electron/ExecutionCapabilityRegistry.js';
import { FileCapabilityRegistry } from '../../electron/FileCapabilityRegistry.js';
import {
  PersonalizationExtensionService,
  type PersonalizationExtensionServiceDependencies,
} from '../../electron/PersonalizationExtensionService.js';
import { PersonalizationRuntimeService } from '../../electron/PersonalizationRuntimeService.js';
import { PersonalizationSkillInstaller } from '../../electron/PersonalizationSkillInstaller.js';

const NOW = 1_900_000_000_000;
const MANIFEST_SECRET = Buffer.from('skill-closure-manifest-secret-at-least-32-bytes');
const EVIDENCE_SECRET = Buffer.from('skill-closure-evidence-secret-at-least-32-bytes');
const CAPABILITY_ID = `fc_${'a'.repeat(32)}`;
const CAPABILITY_OWNER: ExecutionOwnerIdentity = {
  webContentsId: 91,
  mainFrameProcessId: 92,
  mainFrameRoutingId: 93,
};
const SKILL_SOURCE_BINDINGS = [
  { purpose: 'personalization-skill-package', kind: 'file', operation: 'file' },
  { purpose: 'personalization-skill-directory', kind: 'folder', operation: 'folder' },
] as const;

const roots: string[] = [];
const databases: Database.Database[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-skill-three-mode-'));
  roots.push(root);
  return root;
}

function openRepository(databasePath: string): PersonalizationRepository {
  const database = new Database(databasePath);
  databases.push(database);
  return new PersonalizationRepository(database, MANIFEST_SECRET);
}

function closeDatabase(database: Database.Database): void {
  const index = databases.indexOf(database);
  if (index >= 0) databases.splice(index, 1);
  database.close();
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
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

function packageFixture(id: string, marker: string, prefix = ''): {
  archive: Buffer;
  manifest: SkillPackageManifest;
  markdown: Buffer;
} {
  const markdown = Buffer.from(`# ${marker}\n\n${marker}_SYSTEM_PROMPT`, 'utf8');
  const manifest: SkillPackageManifest = {
    schemaVersion: 1,
    id,
    name: marker,
    description: `Runtime fixture for ${marker}.`,
    version: '1.0.0',
    author: 'Metis integration test',
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
  return {
    archive: createStoredZip([
      { name: `${prefix}metis-skill.json`, data: Buffer.from(JSON.stringify(manifest), 'utf8') },
      { name: `${prefix}SKILL.md`, data: markdown },
    ]),
    manifest,
    markdown,
  };
}

function writeDirectoryPackage(directory: string, fixture: ReturnType<typeof packageFixture>): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'metis-skill.json'), JSON.stringify(fixture.manifest));
  fs.writeFileSync(path.join(directory, 'SKILL.md'), fixture.markdown);
}

function publicLookup(hostname: string, family: number): Promise<LookupAddress>;
function publicLookup(hostname: string, options: LookupOneOptions): Promise<LookupAddress>;
function publicLookup(hostname: string, options: LookupAllOptions): Promise<LookupAddress[]>;
function publicLookup(hostname: string, options: LookupOptions): Promise<LookupAddress | LookupAddress[]>;
function publicLookup(hostname: string): Promise<LookupAddress>;
function publicLookup(
  hostname: string,
  options?: number | LookupOptions,
): Promise<LookupAddress | LookupAddress[]> {
  void hostname;
  const address: LookupAddress = { address: '93.184.216.34', family: 4 };
  return Promise.resolve(typeof options === 'object' && options.all ? [address] : address);
}

function inertDependencies(): Pick<
  PersonalizationExtensionServiceDependencies,
  'mcp' | 'mcpBuilder' | 'mcpCompensator'
> {
  return {
    mcp: {
      installFromUrl: async () => { throw new Error('MCP is outside this Skill test'); },
      staticValidate: () => { throw new Error('MCP is outside this Skill test'); },
      getLaunchDescriptor: () => null,
    },
    mcpBuilder: {
      build: async () => { throw new Error('MCP is outside this Skill test'); },
    },
    mcpCompensator: { rollbackInstallation: () => false },
  };
}

function evidenceContext(manifestDigest: string) {
  return {
    sessionId: 'skill-install-bootstrap',
    projectId: 'project-skill-closure',
    operationId: randomUUID(),
    runManifestDigest: manifestDigest,
    observedAt: NOW,
  };
}

function expectSaved(
  result: ReturnType<PersonalizationRuntimeService['save']> | ReturnType<PersonalizationRuntimeService['fork']>,
): PersonalizationDefinition {
  expect(result).toMatchObject({ ok: true, code: 'saved' });
  if (!result.ok || result.code !== 'saved') throw new Error(`Definition save failed: ${result.code}`);
  return result.definition;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Skill three-mode persisted runtime closure', () => {
  it('persists Markdown, directory, ZIP, and GitHub skills and resolves their exact prompts after restart', async () => {
    const root = tempRoot();
    const databasePath = path.join(root, 'personalization.db');
    const database = new Database(databasePath);
    databases.push(database);
    const repository = new PersonalizationRepository(database, MANIFEST_SECRET);
    repository.seedBuiltins(buildBuiltinPersonalizationDefinitions());
    const runtime = new PersonalizationRuntimeService(repository, MANIFEST_SECRET);
    const bootstrap = runtime.resolve({
      contractVersion: 1,
      sessionId: 'skill-install-bootstrap',
      projectId: 'project-skill-closure',
      scenarioId: 'builtin:scenarios/general-research',
    });
    if (!bootstrap.ok) throw new Error('Unable to create the evidence-bound bootstrap manifest');

    const githubFixture = packageFixture('url:skills/closure-github', 'GITHUB_URL', 'repository-main/');
    const normalizedGithubUrl = 'https://api.github.com/repos/metis-test/closure-skill/zipball';
    const fetchCalls: string[] = [];
    const installer = new PersonalizationSkillInstaller(path.join(root, 'skill-store'), {
      lookup: publicLookup,
      fetch: async (input) => {
        fetchCalls.push(String(input));
        return String(input) === normalizedGithubUrl
          ? new Response(Uint8Array.from(githubFixture.archive), {
              status: 200,
              headers: { 'content-type': 'application/zip' },
            })
          : new Response(null, { status: 404 });
      },
      now: () => NOW,
    });
    const evidence = new EvidenceEnvelopeService(EVIDENCE_SECRET);
    const extension = new PersonalizationExtensionService({
      definitions: repository,
      evidence,
      skills: installer,
      ...inertDependencies(),
      now: () => NOW,
    });

    const markdown = await extension.apply({
      contractVersion: 1,
      mode: 'skill_markdown',
      id: 'user:skills/closure-markdown',
      name: 'Markdown closure',
      description: 'Direct Markdown closure fixture.',
      author: 'Metis integration test',
      version: '1.0.0',
      markdown: '# MARKDOWN_DIRECT\n\nMARKDOWN_DIRECT_SYSTEM_PROMPT',
      toolIds: [],
      mcpIds: [],
      tags: ['closure'],
      maxTurns: 8,
      inputSchema: null,
      outputSchema: null,
      expectedRevision: 0,
      evidenceContext: evidenceContext(bootstrap.manifest.manifestDigest),
    });
    expect(markdown.ok).toBe(true);

    const directoryFixture = packageFixture('user:skills/closure-directory', 'DIRECTORY_PACKAGE');
    const directorySource = path.join(root, 'directory-package');
    writeDirectoryPackage(directorySource, directoryFixture);
    const capabilities = new FileCapabilityRegistry();
    const directoryGrant = capabilities.issue({
      path: directorySource,
      kind: 'folder',
      mime: 'inode/directory',
      operations: ['folder'],
      purpose: 'personalization-skill-directory',
    }, CAPABILITY_OWNER);
    expect(directoryGrant.success).toBe(true);
    if (!directoryGrant.success) throw new Error('Directory capability issuance failed');
    const directory = await extension.apply({
      contractVersion: 1,
      mode: 'skill_package',
      sourceCapabilityId: directoryGrant.capability.capabilityId,
      expectedId: null,
      expectedRevision: 0,
      evidenceContext: evidenceContext(bootstrap.manifest.manifestDigest),
    }, {
      resolveLocalSkillSource: (capabilityId) => {
        const result = capabilities.consumeMatching(capabilityId, CAPABILITY_OWNER, SKILL_SOURCE_BINDINGS);
        return result.ok ? result.resolvedPath : undefined;
      },
    });
    expect(directory.ok).toBe(true);

    const zipFixture = packageFixture('user:skills/closure-zip', 'ZIP_PACKAGE');
    const zipSource = path.join(root, 'closure.zip');
    fs.writeFileSync(zipSource, zipFixture.archive);
    const zipGrant = capabilities.issue({
      path: zipSource,
      kind: 'file',
      mime: 'application/zip',
      operations: ['file'],
      purpose: 'personalization-skill-package',
    }, CAPABILITY_OWNER);
    expect(zipGrant.success).toBe(true);
    if (!zipGrant.success) throw new Error('ZIP capability issuance failed');
    const zip = await extension.apply({
      contractVersion: 1,
      mode: 'skill_package',
      sourceCapabilityId: zipGrant.capability.capabilityId,
      expectedId: null,
      expectedRevision: 0,
      evidenceContext: evidenceContext(bootstrap.manifest.manifestDigest),
    }, {
      resolveLocalSkillSource: (capabilityId) => {
        const result = capabilities.consumeMatching(capabilityId, CAPABILITY_OWNER, SKILL_SOURCE_BINDINGS);
        return result.ok ? result.resolvedPath : undefined;
      },
    });
    expect(zip.ok).toBe(true);

    const githubSourceUrl = 'https://github.com/metis-test/closure-skill';
    const github = await extension.apply({
      contractVersion: 1,
      mode: 'skill_url',
      url: githubSourceUrl,
      expectedArchiveSha256: sha256(githubFixture.archive),
      expectedId: null,
      expectedVersion: githubFixture.manifest.version,
      expectedRevision: 0,
      evidenceContext: evidenceContext(bootstrap.manifest.manifestDigest),
    });
    expect(github.ok).toBe(true);
    expect(fetchCalls).toEqual([normalizedGithubUrl]);

    for (const result of [markdown, directory, zip, github]) {
      if (!result.ok) throw new Error(`${result.mode ?? 'unknown'} unexpectedly failed`);
      expect(evidence.verify(result.evidence)).toBe(true);
      expect(result.evidence.truth).toMatchObject({
        state: 'unverified',
        authority: 'metis_automatic_truth_layer',
        claimEligible: false,
        publishEligible: false,
      });
    }

    const fork = expectSaved(runtime.fork({
      contractVersion: 1,
      sourceId: 'builtin:scenarios/general-research',
      targetId: 'user:scenarios/skill-three-mode-closure',
      author: 'Metis integration test',
    }));
    if (fork.kind !== 'scenario') throw new Error('Scenario fork returned the wrong definition kind');
    const skillIds = [
      'user:skills/closure-markdown',
      'user:skills/closure-directory',
      'user:skills/closure-zip',
      'url:skills/closure-github',
    ];
    const scenario = expectSaved(runtime.save({
      contractVersion: 1,
      expectedRevision: fork.revision,
      definition: {
        ...fork,
        revision: fork.revision + 1,
        skillIds: [...new Set([...fork.skillIds, ...skillIds])],
        provenance: { ...fork.provenance, updatedAt: NOW + 1 },
      } satisfies ScenarioDefinition,
    }));

    closeDatabase(database);
    const restartedRepository = openRepository(databasePath);
    const restartedRuntime = new PersonalizationRuntimeService(restartedRepository, MANIFEST_SECRET);
    const restartedInstaller = new PersonalizationSkillInstaller(path.join(root, 'skill-store'), {
      lookup: publicLookup,
      fetch: async () => new Response(null, { status: 500 }),
      now: () => NOW + 2,
    });
    expect(restartedInstaller.getInstalled('user:skills/closure-directory')).toBeDefined();
    expect(restartedInstaller.getInstalled('user:skills/closure-zip')).toBeDefined();
    expect(restartedInstaller.getInstalled('url:skills/closure-github')).toMatchObject({
      provenance: { sourceMode: 'url', sourceUrl: githubSourceUrl },
    });

    const resolved = restartedRuntime.resolveForAgent({
      contractVersion: 1,
      sessionId: 'after-real-process-restart',
      projectId: 'project-skill-closure',
      scenarioId: scenario.id,
    });
    expect(resolved?.ok).toBe(true);
    if (!resolved?.ok) throw new Error('Restarted scenario resolution failed');
    expect(resolved.manifest.skillIds).toEqual(expect.arrayContaining(skillIds));
    expect(resolved.systemPrompt).toContain('MARKDOWN_DIRECT_SYSTEM_PROMPT');
    expect(resolved.systemPrompt).toContain('DIRECTORY_PACKAGE_SYSTEM_PROMPT');
    expect(resolved.systemPrompt).toContain('ZIP_PACKAGE_SYSTEM_PROMPT');
    expect(resolved.systemPrompt).toContain('GITHUB_URL_SYSTEM_PROMPT');
    expect(resolved.manifest.fullAccess.perActionConfirmation).toBe(false);
    expect(resolved.manifest.truthPolicy).toBe('automatic_required');
  });

  it('rejects traversal, directory junctions, cleartext HTTP, and forged URL provenance', async () => {
    const root = tempRoot();
    let fetchCalls = 0;
    const installer = new PersonalizationSkillInstaller(path.join(root, 'skill-store'), {
      lookup: publicLookup,
      fetch: async () => {
        fetchCalls += 1;
        return new Response(null, { status: 500 });
      },
      now: () => NOW,
    });

    const traversalZip = path.join(root, 'traversal.zip');
    fs.writeFileSync(traversalZip, createStoredZip([
      { name: '../outside.txt', data: Buffer.from('escape', 'utf8') },
    ]));
    expect(installer.installFromPackage(traversalZip)).toMatchObject({ ok: false, code: 'path_invalid' });
    expect(fs.existsSync(path.join(root, 'outside.txt'))).toBe(false);

    const junctionFixture = packageFixture('user:skills/junction-rejected', 'JUNCTION_REJECTED');
    const junctionSource = path.join(root, 'junction-source');
    writeDirectoryPackage(junctionSource, junctionFixture);
    const outside = path.join(root, 'outside-directory');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.md'), 'OUTSIDE_SECRET');
    fs.symlinkSync(outside, path.join(junctionSource, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(installer.installFromPackage(junctionSource)).toMatchObject({ ok: false, code: 'symlink_rejected' });

    const database = new Database(':memory:');
    databases.push(database);
    const repository = new PersonalizationRepository(database, MANIFEST_SECRET);
    repository.seedBuiltins(buildBuiltinPersonalizationDefinitions());
    const runtime = new PersonalizationRuntimeService(repository, MANIFEST_SECRET);
    const bootstrap = runtime.resolve({
      contractVersion: 1,
      sessionId: 'http-rejection',
      projectId: 'project-skill-closure',
      scenarioId: 'builtin:scenarios/general-research',
    });
    if (!bootstrap.ok) throw new Error('Unable to resolve the HTTP rejection fixture');
    const extension = new PersonalizationExtensionService({
      definitions: repository,
      evidence: new EvidenceEnvelopeService(EVIDENCE_SECRET),
      skills: installer,
      ...inertDependencies(),
      now: () => NOW,
    });
    await expect(extension.apply({
      contractVersion: 1,
      mode: 'skill_url',
      url: 'http://skills.example.org/unsafe.zip',
      expectedArchiveSha256: null,
      expectedId: null,
      expectedVersion: null,
      expectedRevision: 0,
      evidenceContext: evidenceContext(bootstrap.manifest.manifestDigest),
    })).resolves.toMatchObject({
      ok: false,
      code: 'skill_install_failed',
      detailCode: 'url_invalid',
    });
    expect(fetchCalls).toBe(0);

    const forgedDefinition = {
      contractVersion: 1 as const,
      id: 'url:skills/forged-by-renderer',
      kind: 'skill' as const,
      name: 'Forged URL source',
      description: 'Must not persist through the renderer save boundary.',
      enabled: true,
      tags: ['url'],
      revision: 1,
      provenance: {
        origin: 'url' as const,
        author: 'Attacker',
        version: '1.0.0',
        license: null,
        sourceUrl: 'https://github.com/attacker/forged',
        sourceRevision: 'a'.repeat(64),
        installedDigest: 'b'.repeat(64),
        parentId: null,
        parentVersion: null,
        locallyModified: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
      sourceMode: 'url' as const,
      markdown: '# forged',
      systemPrompt: 'FORGED_RUNTIME_PROMPT',
      toolIds: [],
      mcpIds: [],
      maxTurns: 8,
      inputSchema: null,
      outputSchema: null,
      packageEntry: 'SKILL.md',
    };
    expect(runtime.save({
      contractVersion: 1,
      expectedRevision: 0,
      definition: forgedDefinition,
    })).toEqual({ ok: false, code: 'invalid_request' });
    expect(repository.get(forgedDefinition.id)).toBeUndefined();
  });

  it('detects post-install payload tampering while runtime remains bound to the persisted verified prompt', async () => {
    const root = tempRoot();
    const database = new Database(':memory:');
    databases.push(database);
    const repository = new PersonalizationRepository(database, MANIFEST_SECRET);
    repository.seedBuiltins(buildBuiltinPersonalizationDefinitions());
    const installer = new PersonalizationSkillInstaller(path.join(root, 'skill-store'), { now: () => NOW });
    const fixture = packageFixture('user:skills/tamper-boundary', 'ORIGINAL_VERIFIED');
    const source = path.join(root, 'tamper-source');
    writeDirectoryPackage(source, fixture);
    const extension = new PersonalizationExtensionService({
      definitions: repository,
      evidence: new EvidenceEnvelopeService(EVIDENCE_SECRET),
      skills: installer,
      ...inertDependencies(),
      now: () => NOW,
    });
    const runtime = new PersonalizationRuntimeService(repository, MANIFEST_SECRET);
    const bootstrap = runtime.resolve({
      contractVersion: 1,
      sessionId: 'tamper-bootstrap',
      projectId: 'project-skill-closure',
      scenarioId: 'builtin:scenarios/general-research',
    });
    if (!bootstrap.ok) throw new Error('Unable to resolve the tamper fixture');

    const persisted = await extension.apply({
      contractVersion: 1,
      mode: 'skill_package',
      sourceCapabilityId: CAPABILITY_ID,
      expectedId: null,
      expectedRevision: 0,
      evidenceContext: evidenceContext(bootstrap.manifest.manifestDigest),
    }, {
      resolveLocalSkillSource: () => source,
    });
    expect(persisted.ok).toBe(true);
    if (!persisted.ok || !persisted.skillInstallation) throw new Error('Tamper fixture persistence failed');

    const fork = expectSaved(runtime.fork({
      contractVersion: 1,
      sourceId: 'builtin:scenarios/general-research',
      targetId: 'user:scenarios/tamper-runtime-binding',
      author: 'Metis integration test',
    }));
    if (fork.kind !== 'scenario') throw new Error('Tamper scenario fork returned the wrong kind');
    const scenario = expectSaved(runtime.save({
      contractVersion: 1,
      expectedRevision: fork.revision,
      definition: {
        ...fork,
        revision: fork.revision + 1,
        skillIds: [...new Set([...fork.skillIds, persisted.definition.id])],
        provenance: { ...fork.provenance, updatedAt: NOW + 1 },
      } satisfies ScenarioDefinition,
    }));

    const installDirectory = installer.resolveInstalledDirectory(
      persisted.skillInstallation.id,
      persisted.skillInstallation.version,
    );
    expect(installDirectory).toBeDefined();
    fs.writeFileSync(path.join(installDirectory!, 'SKILL.md'), 'ATTACKER_REPLACEMENT');
    expect(installer.getInstalled(persisted.skillInstallation.id)).toBeUndefined();
    expect(installer.resolveInstalledDirectory(persisted.skillInstallation.id)).toBeUndefined();

    const resolved = runtime.resolveForAgent({
      contractVersion: 1,
      sessionId: 'tamper-after-install',
      projectId: 'project-skill-closure',
      scenarioId: scenario.id,
    });
    expect(resolved?.ok).toBe(true);
    if (!resolved?.ok) throw new Error('Tamper-bound runtime resolution failed');
    expect(resolved.systemPrompt).toContain('ORIGINAL_VERIFIED_SYSTEM_PROMPT');
    expect(resolved.systemPrompt).not.toContain('ATTACKER_REPLACEMENT');
  });
});
