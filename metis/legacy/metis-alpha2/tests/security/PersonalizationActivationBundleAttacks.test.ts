import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  McpActivationIpcRequestSchema,
  McpActivationRequestSchema,
} from '../../engine/runtime/McpActivationContract.js';
import type {
  McpDefinition,
  PersonalizationDefinition,
  SkillDefinitionV2,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import type { SkillPackageManifest } from '../../engine/runtime/SkillInstallationContract.js';
import {
  PersonalizationBundleImportCoordinator,
  type CoordinatedBundleImportService,
  type CoordinatedSkillCompensator,
  type CoordinatedSkillRehydrator,
} from '../../electron/PersonalizationBundleImportCoordinator.js';
import {
  PersonalizationBundleService,
  type PersonalizationBundleAssetSource,
  type PersonalizationBundleDefinitionSink,
  type PersonalizationBundleDefinitionTransaction,
} from '../../electron/PersonalizationBundleService.js';
import { PersonalizationBundleSkillAssetSource } from '../../electron/PersonalizationBundleSkillAssetSource.js';
import { PersonalizationBundleSkillRehydrationService } from '../../electron/PersonalizationBundleSkillRehydrationService.js';
import { PersonalizationMcpActivationService } from '../../electron/PersonalizationMcpActivationService.js';
import { PersonalizationMcpInstaller } from '../../electron/PersonalizationMcpInstaller.js';
import { PersonalizationSkillInstaller } from '../../electron/PersonalizationSkillInstaller.js';

const NOW = 1_901_000_000_000;
const OPERATION = '00000000-0000-4000-8000-000000009901';
const MAIN_SOURCE = fs.readFileSync(path.resolve('electron/main.ts'), 'utf8');
const PRELOAD_SOURCE = fs.readFileSync(path.resolve('electron/preload.ts'), 'utf8');
const PANEL_SOURCE = fs.readFileSync(path.resolve('src/personalization/McpActivationPanel.tsx'), 'utf8');
const RUNTIME_SOURCE = fs.readFileSync(path.resolve('electron/PersonalizationRuntimeService.ts'), 'utf8');

let root = '';
let sourceSequence = 0;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-activation-bundle-attacks-'));
  sourceSequence = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function provenance(installedDigest: string | null = null) {
  return {
    origin: 'user' as const,
    author: 'Metis security test',
    version: '1.0.0',
    license: 'Apache-2.0',
    sourceUrl: null,
    sourceRevision: null,
    installedDigest,
    parentId: null,
    parentVersion: null,
    locallyModified: true,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function packageSource() {
  const source = path.join(root, 'package-source');
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  const markdown = Buffer.from('# Portable package\n\nUse verified sources only.\n', 'utf8');
  const script = Buffer.from('export const normalize = (value) => value;\n', 'utf8');
  const manifest: SkillPackageManifest = {
    schemaVersion: 1,
    id: 'user:skills/activation-bundle-package',
    name: 'Activation bundle package',
    description: 'A real multi-file portable Skill.',
    version: '1.0.0',
    author: 'Metis security test',
    license: 'Apache-2.0',
    entry: 'SKILL.md',
    systemPromptFile: 'SKILL.md',
    files: [
      { path: 'SKILL.md', size: markdown.length, sha256: sha256(markdown), role: 'documentation', executable: false },
      { path: 'scripts/normalize.mjs', size: script.length, sha256: sha256(script), role: 'script', executable: false },
    ],
  };
  fs.writeFileSync(path.join(source, 'SKILL.md'), markdown);
  fs.writeFileSync(path.join(source, 'scripts', 'normalize.mjs'), script);
  fs.writeFileSync(path.join(source, 'metis-skill.json'), JSON.stringify(manifest));
  return { source, markdown: markdown.toString('utf8'), manifest };
}

function installedSkillDefinition(
  installed: NonNullable<ReturnType<PersonalizationSkillInstaller['getInstalled']>>,
  markdown: string,
): SkillDefinitionV2 {
  return {
    contractVersion: 1,
    id: installed.id,
    kind: 'skill',
    name: installed.manifest.name,
    description: installed.manifest.description,
    enabled: true,
    tags: ['portable', 'security-tested'],
    revision: 1,
    provenance: {
      ...provenance(installed.packageDigest),
      author: installed.manifest.author,
      version: installed.version,
      license: installed.manifest.license,
      sourceRevision: installed.provenance.manifestSha256,
      locallyModified: false,
    },
    sourceMode: 'package',
    markdown,
    systemPrompt: markdown,
    toolIds: [],
    mcpIds: [],
    maxTurns: 16,
    inputSchema: null,
    outputSchema: null,
    packageEntry: installed.manifest.entry,
  };
}

interface Fixture {
  definition: PersonalizationDefinition;
  files: ReadonlyArray<{ path: string; bytes: Buffer }>;
}

function markdownFixture(id = 'user:skills/01-valid-markdown'): Fixture & { definition: SkillDefinitionV2 } {
  const markdown = '# Valid portable Markdown\n\nKeep the evidence chain intact.\n';
  return {
    definition: {
      contractVersion: 1,
      id,
      kind: 'skill',
      name: 'Valid Markdown Skill',
      description: 'A valid first Skill for compensation attacks.',
      enabled: true,
      tags: ['portable'],
      revision: 1,
      provenance: provenance(),
      sourceMode: 'markdown',
      markdown,
      systemPrompt: markdown,
      toolIds: [],
      mcpIds: [],
      maxTurns: 8,
      inputSchema: null,
      outputSchema: null,
      packageEntry: null,
    },
    files: [{ path: 'SKILL.md', bytes: Buffer.from(markdown, 'utf8') }],
  };
}

function invalidPackageFixture(): Fixture & { definition: SkillDefinitionV2 } {
  const bytes = Buffer.from('not a ZIP package', 'utf8');
  const markdown = '# Invalid package\n';
  return {
    definition: {
      contractVersion: 1,
      id: 'user:skills/02-invalid-package',
      kind: 'skill',
      name: 'Invalid package Skill',
      description: 'A deliberately invalid second Skill.',
      enabled: true,
      tags: ['portable'],
      revision: 1,
      provenance: provenance(sha256(bytes)),
      sourceMode: 'package',
      markdown,
      systemPrompt: markdown,
      toolIds: [],
      mcpIds: [],
      maxTurns: 8,
      inputSchema: null,
      outputSchema: null,
      packageEntry: 'SKILL.md',
    },
    files: [{ path: 'package.zip', bytes }],
  };
}

function mcpFixture(): Fixture & { definition: McpDefinition } {
  const server = Buffer.from('process.stdin.resume();\n', 'utf8');
  return {
    definition: {
      contractVersion: 1,
      id: 'user:mcp/portable-attack-server',
      kind: 'mcp',
      name: 'Portable attack MCP',
      description: 'Must remain inert until local activation.',
      enabled: true,
      tags: ['portable'],
      revision: 1,
      provenance: provenance(sha256(server)),
      sourceMode: 'generated',
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
      environment: {
        SERVICE_REGION: { secret: false, value: 'test' },
        SERVICE_TOKEN: { secret: true, value: 'raw-secret-must-not-leave-machine' },
      },
      sourceUrl: null,
      exposedTools: ['dangerous_remote_tool'],
      workingDirectoryToken: 'original-local-installation',
    },
    files: [{ path: 'server.mjs', bytes: server }],
  };
}

class MemorySink implements PersonalizationBundleDefinitionSink {
  readonly values = new Map<string, PersonalizationDefinition>();
  rollbackCount = 0;
  commitCount = 0;

  get(id: string): PersonalizationDefinition | undefined {
    return this.values.get(id);
  }

  begin(): PersonalizationBundleDefinitionTransaction {
    const staged = new Map<string, PersonalizationDefinition>();
    let committed = false;
    return {
      save: (definition) => { staged.set(definition.id, definition); },
      commit: () => {
        for (const [id, definition] of staged) this.values.set(id, definition);
        committed = true;
        this.commitCount += 1;
      },
      rollback: () => {
        this.rollbackCount += 1;
        if (committed) for (const id of staged.keys()) this.values.delete(id);
        staged.clear();
      },
    };
  }
}

async function exportFixtures(fixtures: readonly Fixture[], createdBy = 'Portable security test') {
  const definitions = new Map(fixtures.map((fixture) => [fixture.definition.id, fixture.definition]));
  const assets = new Map<string, { rootDirectory: string; relativePaths: string[] }>();
  for (const fixture of fixtures) {
    const directory = path.join(root, `fixture-assets-${sourceSequence++}`);
    fs.mkdirSync(directory);
    for (const file of fixture.files) {
      const destination = path.join(directory, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.bytes);
    }
    assets.set(fixture.definition.id, {
      rootDirectory: directory,
      relativePaths: fixture.files.map((file) => file.path),
    });
  }
  const exporter = new PersonalizationBundleService(path.join(root, `export-root-${sourceSequence}`), { now: () => NOW });
  return exporter.exportBundle({
    rootDefinitionIds: fixtures.map((fixture) => fixture.definition.id),
    assetMode: 'include_files',
    createdBy,
  }, { get: (id) => definitions.get(id) }, { list: (id) => assets.get(id) });
}

function coordinatorHarness(input?: {
  sink?: MemorySink;
  service?: CoordinatedBundleImportService;
  rehydrator?: CoordinatedSkillRehydrator;
  compensator?: CoordinatedSkillCompensator;
}) {
  const assetRoot = path.join(root, 'coordinator-assets');
  const receiptRoot = path.join(root, 'coordinator-receipts');
  fs.mkdirSync(assetRoot, { recursive: true });
  const importer = new PersonalizationBundleService(assetRoot, { now: () => NOW });
  const installer = new PersonalizationSkillInstaller(path.join(root, 'coordinator-skills'), { now: () => NOW });
  const realRehydrator = new PersonalizationBundleSkillRehydrationService(
    assetRoot,
    path.join(root, 'coordinator-skill-staging'),
    installer,
  );
  const sink = input?.sink ?? new MemorySink();
  const coordinator = new PersonalizationBundleImportCoordinator({
    bundleService: input?.service ?? importer,
    definitionSink: sink,
    skillRehydrator: input?.rehydrator ?? realRehydrator,
    skillCompensator: input?.compensator ?? installer,
    bundleAssetRoot: assetRoot,
    receiptRoot,
    now: () => NOW,
  });
  return { coordinator, importer, installer, sink, assetRoot, receiptRoot };
}

describe('MCP activation IPC, owner, operation, and recovery attacks', () => {
  it('strictly rejects renderer owner, evidence, sampleCall, and operation-shape injection', () => {
    const publicRequest = {
      contractVersion: 1,
      operationId: OPERATION,
      definitionId: 'url:mcp/attack-server',
      installationId: `mcp_${'a'.repeat(32)}`,
      expectedRevision: 1,
    };
    expect(McpActivationIpcRequestSchema.safeParse(publicRequest).success).toBe(true);
    for (const injected of [
      { owner: { webContentsId: 1, processId: 2, routingId: 0, generation: 99 } },
      { evidenceContext: { operationId: OPERATION } },
      { sampleCall: { toolName: 'shell', arguments: { command: 'whoami' } } },
      { operationId: `${OPERATION}-replayed` },
    ]) {
      expect(McpActivationIpcRequestSchema.safeParse({ ...publicRequest, ...injected }).success).toBe(false);
    }
    expect(McpActivationRequestSchema.safeParse({
      ...publicRequest,
      evidenceContext: {
        sessionId: 'forged', projectId: 'global', operationId: OPERATION,
        runManifestDigest: 'b'.repeat(64), observedAt: NOW,
        owner: { webContentsId: 1, processId: 2, routingId: 0, generation: 1 },
      },
      sampleCall: { toolName: 'shell', arguments: {} },
    }).success).toBe(false);
  });

  it('attests main-frame authorization, main-derived owner generation, strict preload, and UI replay bindings', () => {
    const handler = MAIN_SOURCE.slice(
      MAIN_SOURCE.indexOf("ipcMain.handle('personalization:mcp:activate'"),
      MAIN_SOURCE.indexOf("ipcMain.handle('personalization:bundle:export'"),
    );
    const binder = MAIN_SOURCE.slice(
      MAIN_SOURCE.indexOf('function bindMcpActivationRequest'),
      MAIN_SOURCE.indexOf('function writePersonalizationBundleFile'),
    );
    expect(handler).toContain('requireRendererMainFrame(event)');
    expect(handler).toContain('McpActivationIpcRequestSchema.safeParse(rawRequest)');
    expect(handler).toContain('bindMcpActivationRequest(publicRequest.data, event)');
    expect(binder).toContain('const owner = managedMcpOwnerFor(event)');
    expect(binder).toContain('owner.generation');
    expect(binder).toContain('canonicalPersonalizationJson({ owner, request })');
    expect(PRELOAD_SOURCE).toMatch(/activatePersonalizationMcp:[\s\S]*McpActivationIpcRequestSchema\.safeParse[\s\S]*decodeMcpActivationResponse/u);
    expect(PANEL_SOURCE).toContain('response.operationId === request.operationId');
    expect(PANEL_SOURCE).toContain('response.definition.id === request.definitionId');
    expect(PANEL_SOURCE).toContain('response.definition.revision === request.expectedRevision + 1');
    expect(PANEL_SOURCE).toContain('response.installation.installationId === request.installationId');
    expect(PANEL_SOURCE).toContain('if (inFlightBinding.current !== null) return');
  });

  it('fails closed before probing when the durable activation journal is corrupt', async () => {
    const mcpRoot = path.join(root, 'mcp-journal-attack');
    const installer = new PersonalizationMcpInstaller(mcpRoot, { now: () => NOW });
    const probe = vi.fn(async () => ({ ok: false as const, code: 'timeout' as const }));
    const activation = new PersonalizationMcpActivationService(mcpRoot, {
      installer,
      runner: { probe },
      store: {
        get: () => undefined,
        commitMcpActivation: () => false,
        isMcpActivationCommitted: () => false,
        rollbackMcpActivation: () => false,
      },
      evidence: { issue: () => { throw new Error('must not issue'); }, verify: () => false },
      now: () => NOW,
    });
    fs.writeFileSync(
      path.join(mcpRoot, '.activation-journal', 'activation-00000000-0000-4000-8000-000000009999.json'),
      '{"forged":true}',
    );
    const result = await activation.activate({
      contractVersion: 1,
      definitionId: 'url:mcp/journal-attack',
      installationId: `mcp_${'b'.repeat(32)}`,
      expectedRevision: 1,
      evidenceContext: {
        sessionId: 'session-journal', projectId: 'global', operationId: OPERATION,
        runManifestDigest: 'c'.repeat(64), observedAt: NOW,
        owner: { webContentsId: 17, processId: 23, routingId: 0, generation: 4 },
      },
    });
    expect(result).toMatchObject({ ok: false, code: 'recovery_failed', recoveryPending: true });
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('portable Skill asset and bundle import attacks', () => {
  it('exports every verified package asset while excluding local paths, install metadata, and MCP secret values', async () => {
    const fixture = packageSource();
    const installer = new PersonalizationSkillInstaller(path.join(root, 'installed-package'), { now: () => NOW });
    const installedResult = installer.installFromPackage(fixture.source);
    expect(installedResult.ok).toBe(true);
    if (!installedResult.ok) return;
    const skill = installedSkillDefinition(installedResult.installed, fixture.markdown);
    const mcp = mcpFixture();
    const definitions = new Map<string, PersonalizationDefinition>([[skill.id, skill], [mcp.definition.id, mcp.definition]]);
    const mcpAssets = path.join(root, 'mcp-assets');
    fs.mkdirSync(mcpAssets);
    fs.writeFileSync(path.join(mcpAssets, 'server.mjs'), mcp.files[0]!.bytes);
    const realSkillSource = new PersonalizationBundleSkillAssetSource({ get: (id) => definitions.get(id) }, installer);
    const assetSource: PersonalizationBundleAssetSource = {
      list: (id) => id === skill.id ? realSkillSource.list(id) : {
        rootDirectory: mcpAssets,
        relativePaths: ['server.mjs'],
      },
    };
    const exported = await new PersonalizationBundleService(path.join(root, 'package-export')).exportBundle({
      rootDefinitionIds: [skill.id, mcp.definition.id],
      assetMode: 'include_files',
      createdBy: 'Security export',
    }, { get: (id) => definitions.get(id) }, assetSource);

    expect(exported.bundle.manifest.assets.filter((entry) => entry.ownerId === skill.id)
      .map((entry) => entry.assetPath).sort())
      .toEqual(['metis-skill.json', 'scripts/normalize.mjs', 'SKILL.md'].sort());
    const raw = Buffer.from(exported.bytes).toString('utf8');
    expect(raw).not.toContain(root);
    expect(raw).not.toContain('metis-install.json');
    expect(raw).not.toContain('raw-secret-must-not-leave-machine');
    const mcpPayload = exported.bundle.payloads.find((payload) => payload.path.startsWith('definitions/')
      && Buffer.from(payload.content, 'base64').toString('utf8').includes(mcp.definition.id));
    const portableMcp = JSON.parse(Buffer.from(mcpPayload!.content, 'base64').toString('utf8')) as {
      environment: Record<string, { secret: boolean; value: string | null }>;
    };
    expect(portableMcp.environment.SERVICE_TOKEN).toEqual({ secret: true, value: null });
    expect(exported.bundle.manifest.definitions.find((entry) => entry.id === mcp.definition.id)?.secretRefs)
      .toEqual(['${secret:SERVICE_TOKEN}']);
  });

  it('fails closed when an auxiliary Skill file is replaced after trusted installation attestation', async () => {
    const fixture = packageSource();
    const installer = new PersonalizationSkillInstaller(path.join(root, 'tamper-installed'), { now: () => NOW });
    const installedResult = installer.installFromPackage(fixture.source);
    expect(installedResult.ok).toBe(true);
    if (!installedResult.ok) return;
    const skill = installedSkillDefinition(installedResult.installed, fixture.markdown);
    const realSource = new PersonalizationBundleSkillAssetSource({ get: () => skill }, installer);
    const installedDirectory = installer.resolveInstalledDirectory(skill.id, skill.provenance.version)!;
    const attackSource: PersonalizationBundleAssetSource = {
      list: (id) => {
        const assets = realSource.list(id);
        fs.writeFileSync(
          path.join(installedDirectory, 'scripts', 'normalize.mjs'),
          'export const stolen = "C:/Users/Alice/.ssh/id_rsa";\n',
        );
        return assets;
      },
    };
    await expect(new PersonalizationBundleService(path.join(root, 'tamper-export')).exportBundle({
      rootDefinitionIds: [skill.id],
      assetMode: 'include_files',
      createdBy: 'Tamper attacker',
    }, { get: () => skill }, attackSource)).rejects.toThrow();
  });

  it('rejects an asset-root symlink or junction instead of following it outside the trusted root', async () => {
    const fixture = markdownFixture();
    const outsideRoot = path.join(root, 'outside-assets');
    const assetRoot = path.join(root, 'symlink-assets');
    fs.mkdirSync(outsideRoot);
    fs.writeFileSync(path.join(outsideRoot, 'SKILL.md'), 'outside secret');
    fs.symlinkSync(outsideRoot, assetRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const exporter = new PersonalizationBundleService(path.join(root, 'symlink-export'));
    await expect(exporter.exportBundle({
      rootDefinitionIds: [fixture.definition.id], assetMode: 'include_files', createdBy: 'Symlink attacker',
    }, { get: () => fixture.definition }, {
      list: () => ({ rootDirectory: assetRoot, relativePaths: ['SKILL.md'] }),
    })).rejects.toThrow(/Unsafe asset root/u);
  });

  it('compensates the first installed Skill, staged definitions, assets, and receipt when a later Skill fails', async () => {
    const valid = markdownFixture();
    const invalid = invalidPackageFixture();
    const exported = await exportFixtures([valid, invalid]);
    const setup = coordinatorHarness();
    const result = await setup.coordinator.importBundle(exported.bytes);
    expect(result).toMatchObject({ ok: false, code: 'skill_rehydration_failed', compensated: true });
    if (result.ok) throw new Error('Expected the invalid second Skill to fail');
    expect(result.rehydrated.map((entry) => entry.definitionId)).toEqual([valid.definition.id]);
    expect(setup.sink.values.size).toBe(0);
    expect(setup.sink.rollbackCount).toBe(1);
    expect(setup.installer.listInstalled()).toEqual([]);
    expect(fs.readdirSync(setup.receiptRoot)).toEqual([]);
    expect(fs.readdirSync(setup.assetRoot)).toEqual([]);
  });

  it('imports MCP definitions only as deferred inert records with no local runtime identity', async () => {
    const fixture = mcpFixture();
    const exported = await exportFixtures([fixture]);
    const setup = coordinatorHarness();
    const result = await setup.coordinator.importBundle(exported.bytes);
    expect(result).toMatchObject({
      ok: true,
      deferred: [{ definitionId: fixture.definition.id, status: 'deferred_requires_local_activation' }],
    });
    const imported = setup.sink.values.get(fixture.definition.id);
    expect(imported).toMatchObject({
      kind: 'mcp', enabled: false, args: [], exposedTools: [], workingDirectoryToken: null,
    });
    expect(imported?.tags).toContain('deferred_requires_local_activation');
    if (!imported || imported.kind !== 'mcp') throw new Error('Expected imported MCP');
    expect(imported.environment.SERVICE_TOKEN).toEqual({ secret: true, value: null });
  });

  it('serializes concurrent imports, then replays only from a verified receipt without re-importing', async () => {
    const fixture = mcpFixture();
    const exported = await exportFixtures([fixture]);
    const assetRoot = path.join(root, 'shared-assets');
    const receiptRoot = path.join(root, 'shared-receipts');
    fs.mkdirSync(assetRoot);
    const importer = new PersonalizationBundleService(assetRoot, { now: () => NOW });
    const sink = new MemorySink();
    const noopRehydrator: CoordinatedSkillRehydrator = { rehydrate: () => { throw new Error('No Skill expected'); } };
    const noopCompensator: CoordinatedSkillCompensator = { getInstalled: () => undefined, uninstall: () => ({ ok: false }) };
    let enteredResolve: (() => void) | undefined;
    let releaseResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const delayed: CoordinatedBundleImportService = {
      importBundle: async (bytes, target) => {
        enteredResolve?.();
        await release;
        return importer.importBundle(bytes, target);
      },
    };
    const make = (service: CoordinatedBundleImportService) => new PersonalizationBundleImportCoordinator({
      bundleService: service,
      definitionSink: sink,
      skillRehydrator: noopRehydrator,
      skillCompensator: noopCompensator,
      bundleAssetRoot: assetRoot,
      receiptRoot,
      now: () => NOW,
    });
    const first = make(delayed);
    const second = make(importer);
    const pending = first.importBundle(exported.bytes);
    await entered;
    expect(await second.importBundle(exported.bytes)).toMatchObject({
      ok: false, code: 'replay_conflict', detail: 'import_already_in_progress',
    });
    releaseResolve?.();
    expect(await pending).toMatchObject({ ok: true, replayed: false });

    let calls = 0;
    const replay = make({ importBundle: async () => { calls += 1; throw new Error('must not import'); } });
    expect(await replay.importBundle(exported.bytes)).toMatchObject({ ok: true, replayed: true });
    expect(calls).toBe(0);
    expect(sink.commitCount).toBe(1);
    expect(fs.readdirSync(receiptRoot).filter((name) => name.endsWith('.json'))).toHaveLength(1);
  });

  it('rejects a tampered coordinator receipt rather than treating it as replay authority', async () => {
    const fixture = mcpFixture();
    const exported = await exportFixtures([fixture]);
    const setup = coordinatorHarness();
    expect(await setup.coordinator.importBundle(exported.bytes)).toMatchObject({ ok: true, replayed: false });
    const receiptName = fs.readdirSync(setup.receiptRoot).find((name) => name.endsWith('.json'))!;
    const receiptPath = path.join(setup.receiptRoot, receiptName);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as {
      imported: Array<{ id: string; digest: string }>;
    };
    receipt.imported[0]!.digest = '0'.repeat(64);
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    expect(await setup.coordinator.importBundle(exported.bytes)).toMatchObject({
      ok: false, code: 'replay_conflict', detail: 'receipt_definition_mismatch',
    });
    expect(setup.sink.commitCount).toBe(1);
  });

  it('keeps main on include_files + coordinator-only import and blocks generic provenance re-entry', () => {
    const exportHandler = MAIN_SOURCE.slice(
      MAIN_SOURCE.indexOf("ipcMain.handle('personalization:bundle:export'"),
      MAIN_SOURCE.indexOf("ipcMain.handle('personalization:bundle:import'"),
    );
    const importHandler = MAIN_SOURCE.slice(
      MAIN_SOURCE.indexOf("ipcMain.handle('personalization:bundle:import'"),
      MAIN_SOURCE.indexOf("ipcMain.handle('personalization:secrets:list'"),
    );
    expect(exportHandler).toContain("assetMode: 'include_files'");
    expect(exportHandler).not.toContain("assetMode: 'none'");
    expect(importHandler).toContain('personalizationBundleCoordinator.importBundle(bytes)');
    expect(importHandler).not.toContain('personalizationBundles.importBundle(bytes');
    expect(RUNTIME_SOURCE).toContain("if (definition.kind === 'mcp') {");
    expect(RUNTIME_SOURCE).toContain("definition.sourceMode === 'generated'");
    expect(RUNTIME_SOURCE).toContain("definition.sourceMode === 'markdown' && definition.packageEntry === null");
    expect(RUNTIME_SOURCE).toContain('!isRendererAuthoredDefinition(source)');
  });
});
