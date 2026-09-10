import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { PersonalizationBundleSkillRehydrationService } from '../../electron/PersonalizationBundleSkillRehydrationService.js';
import { PersonalizationBundleRepositorySink } from '../../electron/PersonalizationBundleRepositorySink.js';
import { PersonalizationSkillInstaller } from '../../electron/PersonalizationSkillInstaller.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import type {
  McpDefinition,
  PersonalizationDefinition,
  SkillDefinitionV2,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import type { SkillPackageManifest } from '../../engine/runtime/SkillInstallationContract.js';

const NOW = 1_800_101_000_000;

let root: string;
let bundleAssetRoot: string;
let receiptRoot: string;
let sourceAssetRoot: string;
let skillStagingRoot: string;
let installer: PersonalizationSkillInstaller;
let importer: PersonalizationBundleService;
let rehydrator: PersonalizationBundleSkillRehydrationService;
let sourceSequence: number;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-bundle-import-coordinator-'));
  bundleAssetRoot = path.join(root, 'bundle-assets');
  receiptRoot = path.join(root, 'receipts');
  sourceAssetRoot = path.join(root, 'source-assets');
  skillStagingRoot = path.join(root, 'skill-staging');
  fs.mkdirSync(bundleAssetRoot);
  fs.mkdirSync(sourceAssetRoot);
  installer = new PersonalizationSkillInstaller(path.join(root, 'skill-store'), { now: () => NOW });
  importer = new PersonalizationBundleService(bundleAssetRoot, { now: () => NOW });
  rehydrator = new PersonalizationBundleSkillRehydrationService(
    bundleAssetRoot,
    skillStagingRoot,
    installer,
  );
  sourceSequence = 0;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function provenance(installedDigest: string | null = null) {
  return {
    origin: 'user' as const,
    author: 'Coordinator test author',
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

interface DefinitionFixture {
  definition: PersonalizationDefinition;
  files: ReadonlyArray<{ path: string; bytes: Buffer }>;
}

function markdownFixture(
  id = 'user:skills/coordinator-markdown',
  markdown = '# Coordinated Markdown\n\nKeep evidence traceable.\n',
): DefinitionFixture & { definition: SkillDefinitionV2 } {
  return {
    definition: {
      contractVersion: 1,
      id,
      kind: 'skill',
      name: `Markdown ${id.split('/').at(-1)}`,
      description: 'A portable Markdown Skill.',
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

function packageFixture(id = 'user:skills/coordinator-package'): DefinitionFixture & { definition: SkillDefinitionV2 } {
  const markdown = Buffer.from('# Coordinated ZIP\n\nUse only declared package files.\n', 'utf8');
  const manifest: SkillPackageManifest = {
    schemaVersion: 1,
    id,
    name: `Package ${id.split('/').at(-1)}`,
    description: 'A strict portable ZIP Skill.',
    version: '1.0.0',
    author: 'Coordinator test author',
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
  ]);
  return {
    definition: {
      contractVersion: 1,
      id,
      kind: 'skill',
      name: manifest.name,
      description: manifest.description,
      enabled: true,
      tags: ['portable', 'package'],
      revision: 1,
      provenance: provenance(sha256(archive)),
      sourceMode: 'package',
      markdown: markdown.toString('utf8'),
      systemPrompt: markdown.toString('utf8'),
      toolIds: [],
      mcpIds: [],
      maxTurns: 12,
      inputSchema: null,
      outputSchema: null,
      packageEntry: manifest.entry,
    },
    files: [{ path: 'package.zip', bytes: archive }],
  };
}

function invalidPackageFixture(id = 'user:skills/02-invalid-package'): DefinitionFixture & { definition: SkillDefinitionV2 } {
  const archive = Buffer.from('this is not a ZIP package', 'utf8');
  const markdown = '# Invalid package\n';
  return {
    definition: {
      contractVersion: 1,
      id,
      kind: 'skill',
      name: 'Invalid package',
      description: 'A deliberately invalid archive fixture.',
      enabled: true,
      tags: ['portable', 'invalid'],
      revision: 1,
      provenance: provenance(sha256(archive)),
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
    files: [{ path: 'package.zip', bytes: archive }],
  };
}

function mcpFixture(): DefinitionFixture & { definition: McpDefinition } {
  const server = Buffer.from("process.stdin.resume();\n", 'utf8');
  return {
    definition: {
      contractVersion: 1,
      id: 'user:mcp/coordinator-server',
      kind: 'mcp',
      name: 'Coordinator MCP',
      description: 'An MCP that must remain inert after portable import.',
      enabled: true,
      tags: Array.from({ length: 128 }, (_, index) => `portable-${index}`),
      revision: 1,
      provenance: provenance(sha256(server)),
      sourceMode: 'generated',
      transport: 'stdio',
      command: 'node',
      args: ['server.mjs'],
      environment: {
        SERVICE_REGION: { secret: false, value: 'test' },
        SERVICE_TOKEN: { secret: true, value: 'must-be-redacted' },
      },
      sourceUrl: null,
      exposedTools: ['echo_text'],
      workingDirectoryToken: 'original_mcp_installation',
    },
    files: [{ path: 'server.mjs', bytes: server }],
  };
}

class AtomicMemorySink implements PersonalizationBundleDefinitionSink {
  readonly values = new Map<string, PersonalizationDefinition>();
  readonly bindings = new Map<string, { directoryToken: string; relativeRoot: string }>();
  beginCount = 0;
  commitCount = 0;
  rollbackCount = 0;
  failSaveAt: number | null = null;
  failCommit = false;
  failRollback = false;
  onCommit: (() => void) | undefined;

  get(id: string): PersonalizationDefinition | undefined {
    return this.values.get(id);
  }

  begin(): PersonalizationBundleDefinitionTransaction {
    this.beginCount += 1;
    const staged = new Map<string, PersonalizationDefinition>();
    const stagedBindings = new Map<string, { directoryToken: string; relativeRoot: string }>();
    const previous = new Map<string, PersonalizationDefinition | undefined>();
    let saves = 0;
    let committed = false;
    return {
      save: (definition, binding) => {
        saves += 1;
        if (this.failSaveAt === saves) throw new Error('injected definition stage failure');
        previous.set(definition.id, this.values.get(definition.id));
        staged.set(definition.id, definition);
        if (binding) stagedBindings.set(definition.id, binding);
      },
      commit: () => {
        this.onCommit?.();
        if (this.failCommit) throw new Error('injected definition commit failure');
        for (const [id, definition] of staged) this.values.set(id, definition);
        for (const [id, binding] of stagedBindings) this.bindings.set(id, binding);
        committed = true;
        this.commitCount += 1;
      },
      rollback: () => {
        this.rollbackCount += 1;
        if (this.failRollback) throw new Error('injected definition rollback failure');
        if (committed) {
          for (const [id, definition] of previous) {
            if (definition) this.values.set(id, definition);
            else this.values.delete(id);
            this.bindings.delete(id);
          }
        }
        staged.clear();
        stagedBindings.clear();
      },
    };
  }
}

async function exportFixtures(fixtures: readonly DefinitionFixture[]) {
  const definitions = new Map(fixtures.map((fixture) => [fixture.definition.id, fixture.definition]));
  const assetSets = new Map<string, { rootDirectory: string; relativePaths: string[] }>();
  for (const fixture of fixtures) {
    sourceSequence += 1;
    const directory = path.join(sourceAssetRoot, `source-${sourceSequence}`);
    fs.mkdirSync(directory);
    for (const file of fixture.files) {
      const destination = path.join(directory, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.bytes);
    }
    assetSets.set(fixture.definition.id, {
      rootDirectory: directory,
      relativePaths: fixture.files.map((file) => file.path),
    });
  }
  const assetSource: PersonalizationBundleAssetSource = {
    list: (ownerId) => assetSets.get(ownerId),
  };
  const exporter = new PersonalizationBundleService(path.join(root, `export-${sourceSequence}`), { now: () => NOW });
  return exporter.exportBundle({
    rootDefinitionIds: fixtures.map((fixture) => fixture.definition.id),
    assetMode: 'include_files',
    createdBy: 'Coordinator integration test',
  }, {
    get: (id) => definitions.get(id),
  }, assetSource);
}

function createCoordinator(input?: {
  sink?: AtomicMemorySink;
  bundleService?: CoordinatedBundleImportService;
  skillRehydrator?: CoordinatedSkillRehydrator;
  skillCompensator?: CoordinatedSkillCompensator;
}) {
  const sink = input?.sink ?? new AtomicMemorySink();
  const coordinator = new PersonalizationBundleImportCoordinator({
    bundleService: input?.bundleService ?? importer,
    definitionSink: sink,
    skillRehydrator: input?.skillRehydrator ?? rehydrator,
    skillCompensator: input?.skillCompensator ?? installer,
    bundleAssetRoot,
    receiptRoot,
    now: () => NOW,
  });
  return { coordinator, sink };
}

function assetDirectory(bundleDigest: string): string {
  return path.join(bundleAssetRoot, `bundle_${bundleDigest.slice(0, 32)}`);
}

function receiptFiles(): string[] {
  return fs.existsSync(receiptRoot) ? fs.readdirSync(receiptRoot) : [];
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

describe('PersonalizationBundleImportCoordinator', () => {
  it('publishes through the real SQLite-backed repository sink only after local rehydration succeeds', async () => {
    const fixture = markdownFixture();
    const exported = await exportFixtures([fixture]);
    const database = new Database(':memory:');
    try {
      const repository = new PersonalizationRepository(database);
      const coordinator = new PersonalizationBundleImportCoordinator({
        bundleService: importer,
        definitionSink: new PersonalizationBundleRepositorySink(repository),
        skillRehydrator: rehydrator,
        skillCompensator: installer,
        bundleAssetRoot,
        receiptRoot,
        now: () => NOW,
      });

      const result = await coordinator.importBundle(exported.bytes);

      expect(result).toMatchObject({ ok: true, replayed: false });
      expect(repository.get(fixture.definition.id, true)).toEqual(fixture.definition);
      expect(installer.getInstalled(fixture.definition.id, '1.0.0')).toBeDefined();
    } finally {
      database.close();
    }
  });

  it('lands verified assets, rehydrates Markdown and real ZIP Skills, then atomically publishes definitions', async () => {
    const markdown = markdownFixture();
    const packaged = packageFixture();
    const exported = await exportFixtures([markdown, packaged]);
    const sink = new AtomicMemorySink();
    sink.onCommit = () => {
      expect(installer.listInstalled()).toHaveLength(2);
      expect(sink.values).toHaveLength(0);
    };
    const { coordinator } = createCoordinator({ sink });

    const result = await coordinator.importBundle(exported.bytes);

    expect(result).toMatchObject({
      ok: true,
      code: 'imported',
      bundleDigest: exported.bundle.manifest.bundleDigest,
      replayed: false,
      compensated: false,
    });
    if (!result.ok) throw new Error(result.detail);
    expect(result.imported).toEqual(expect.arrayContaining([markdown.definition.id, packaged.definition.id]));
    expect(result.rehydrated).toHaveLength(2);
    expect(result.rehydrated.every((skill) => !skill.reused)).toBe(true);
    expect(result.deferred).toEqual([]);
    expect(sink.values).toHaveLength(2);
    expect(sink.commitCount).toBe(1);
    expect(installer.listInstalled()).toHaveLength(2);
    const manifestBytes = fs.readFileSync(path.join(
      assetDirectory(exported.bundle.manifest.bundleDigest),
      'bundle-manifest.json',
    ));
    expect(result.bundleManifestSha256).toBe(sha256(manifestBytes));
    expect(receiptFiles()).toHaveLength(1);
  });

  it('compensates the first Skill, assets, and staged definitions when a later Skill fails', async () => {
    const valid = markdownFixture('user:skills/01-valid-markdown');
    const invalid = invalidPackageFixture();
    const exported = await exportFixtures([valid, invalid]);
    const { coordinator, sink } = createCoordinator();

    const result = await coordinator.importBundle(exported.bytes);

    expect(result).toMatchObject({
      ok: false,
      code: 'skill_rehydration_failed',
      compensated: true,
    });
    if (result.ok) throw new Error('Expected the invalid ZIP to fail');
    expect(result.rehydrated.map((skill) => skill.definitionId)).toEqual([valid.definition.id]);
    expect(sink.values).toHaveLength(0);
    expect(sink.rollbackCount).toBe(1);
    expect(installer.listInstalled()).toHaveLength(0);
    expect(fs.existsSync(assetDirectory(exported.bundle.manifest.bundleDigest))).toBe(false);
    expect(receiptFiles()).toEqual([]);
  });

  it('replays idempotently after restart without invoking BundleService or duplicating the installation', async () => {
    const fixture = packageFixture();
    const exported = await exportFixtures([fixture]);
    const sink = new AtomicMemorySink();
    const first = createCoordinator({ sink });
    const firstResult = await first.coordinator.importBundle(exported.bytes);
    expect(firstResult).toMatchObject({ ok: true, replayed: false });

    let bundleServiceCalls = 0;
    const rejectingBundleService: CoordinatedBundleImportService = {
      importBundle: async () => {
        bundleServiceCalls += 1;
        throw new Error('BundleService must not run for a verified replay');
      },
    };
    const restarted = createCoordinator({ sink, bundleService: rejectingBundleService });
    const replay = await restarted.coordinator.importBundle(exported.bytes);

    expect(replay).toMatchObject({ ok: true, replayed: true, compensated: false });
    if (!replay.ok) throw new Error(replay.detail);
    expect(replay.rehydrated).toHaveLength(1);
    expect(replay.rehydrated[0]?.reused).toBe(true);
    expect(bundleServiceCalls).toBe(0);
    expect(sink.commitCount).toBe(1);
    expect(installer.listInstalled(fixture.definition.id)).toHaveLength(1);
    expect(receiptFiles()).toHaveLength(1);
  });

  it('serializes the same bundle across coordinator instances before any assets or definitions are published', async () => {
    const fixture = packageFixture();
    const exported = await exportFixtures([fixture]);
    const sink = new AtomicMemorySink();
    let markEntered: (() => void) | undefined;
    let releaseImport: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseImport = resolve; });
    const delayedService: CoordinatedBundleImportService = {
      importBundle: async (bytes, definitionSink) => {
        markEntered?.();
        await release;
        return importer.importBundle(bytes, definitionSink);
      },
    };
    const first = createCoordinator({ sink, bundleService: delayedService });
    const second = createCoordinator({ sink });

    const firstPending = first.coordinator.importBundle(exported.bytes);
    await entered;
    const concurrent = await second.coordinator.importBundle(exported.bytes);
    releaseImport?.();
    const completed = await firstPending;

    expect(concurrent).toMatchObject({
      ok: false,
      code: 'replay_conflict',
      detail: 'import_already_in_progress',
    });
    expect(completed).toMatchObject({ ok: true, replayed: false });
    expect(sink.values).toHaveLength(1);
    expect(installer.listInstalled(fixture.definition.id)).toHaveLength(1);
    expect(receiptFiles()).toHaveLength(1);
  });

  it('recovers an exact dead-process coordinator lock and completes the import after restart', async () => {
    const fixture = markdownFixture();
    const exported = await exportFixtures([fixture]);
    fs.mkdirSync(receiptRoot, { recursive: true });
    fs.writeFileSync(
      path.join(receiptRoot, `.import-${exported.bundle.manifest.bundleDigest}.lock`),
      JSON.stringify({
        format: 'metis-personalization-import-lock',
        version: 1,
        bundleDigest: exported.bundle.manifest.bundleDigest,
        pid: 2_147_483_647,
        createdAt: 1,
        nonce: '00000000-0000-4000-8000-000000000002',
      }),
      { flag: 'wx' },
    );
    const { coordinator, sink } = createCoordinator();

    const result = await coordinator.importBundle(exported.bytes);

    expect(result).toMatchObject({ ok: true, replayed: false });
    expect(sink.values.get(fixture.definition.id)).toBeDefined();
    expect(receiptFiles()).toHaveLength(1);
  });

  it('removes an asset inventory orphaned before receipt publication and retries cleanly', async () => {
    const fixture = markdownFixture();
    const exported = await exportFixtures([fixture]);
    const landThenFail: CoordinatedBundleImportService = {
      importBundle: async (bytes, sink) => {
        const result = await importer.importBundle(bytes, sink);
        expect(result.ok).toBe(true);
        throw new Error('injected process boundary after asset publication');
      },
    };
    const failed = createCoordinator({ bundleService: landThenFail });

    const failure = await failed.coordinator.importBundle(exported.bytes);

    expect(failure).toMatchObject({ ok: false, code: 'bundle_import_failed', compensated: true });
    expect(fs.existsSync(assetDirectory(exported.bundle.manifest.bundleDigest))).toBe(false);
    expect(receiptFiles()).toEqual([]);

    const retry = createCoordinator({ sink: failed.sink });
    await expect(retry.coordinator.importBundle(exported.bytes))
      .resolves.toMatchObject({ ok: true, replayed: false });
  });

  it('recovers a prepared receipt with no published definitions after abrupt restart', async () => {
    const fixture = markdownFixture();
    const exported = await exportFixtures([fixture]);
    const sink = new AtomicMemorySink();
    const first = createCoordinator({ sink });
    await expect(first.coordinator.importBundle(exported.bytes))
      .resolves.toMatchObject({ ok: true, replayed: false });
    expect(installer.listInstalled(fixture.definition.id)).toHaveLength(1);

    // This is the durable state left when the process exits after receipt
    // publication but before the atomic repository transaction commits.
    sink.values.clear();
    sink.bindings.clear();
    const restarted = createCoordinator({ sink });

    const recovered = await restarted.coordinator.importBundle(exported.bytes);

    expect(recovered).toMatchObject({ ok: true, replayed: false });
    expect(sink.values.get(fixture.definition.id)).toBeDefined();
    expect(installer.listInstalled(fixture.definition.id)).toHaveLength(1);
    expect(receiptFiles()).toHaveLength(1);
  });

  it('rolls back a definition commit failure and removes the receipt, installed Skill, and assets', async () => {
    const fixture = markdownFixture();
    const exported = await exportFixtures([fixture]);
    const sink = new AtomicMemorySink();
    sink.failCommit = true;
    const { coordinator } = createCoordinator({ sink });

    const result = await coordinator.importBundle(exported.bytes);

    expect(result).toMatchObject({
      ok: false,
      code: 'definition_publish_failed',
      compensated: true,
    });
    expect(sink.values).toHaveLength(0);
    expect(sink.rollbackCount).toBe(1);
    expect(installer.listInstalled()).toHaveLength(0);
    expect(fs.existsSync(assetDirectory(exported.bundle.manifest.bundleDigest))).toBe(false);
    expect(receiptFiles()).toEqual([]);
  });

  it('removes landed assets when definition staging fails before any Skill can run', async () => {
    const fixture = markdownFixture();
    const exported = await exportFixtures([fixture]);
    const sink = new AtomicMemorySink();
    sink.failSaveAt = 1;
    const { coordinator } = createCoordinator({ sink });

    const result = await coordinator.importBundle(exported.bytes);

    expect(result).toMatchObject({ ok: false, code: 'definition_stage_failed', compensated: true });
    expect(sink.values).toHaveLength(0);
    expect(sink.rollbackCount).toBe(1);
    expect(installer.listInstalled()).toHaveLength(0);
    expect(fs.existsSync(assetDirectory(exported.bundle.manifest.bundleDigest))).toBe(false);
    expect(receiptFiles()).toEqual([]);
  });

  it('reports compensation_failed without publishing a runnable definition when uninstall fails', async () => {
    const fixture = markdownFixture();
    const exported = await exportFixtures([fixture]);
    const sink = new AtomicMemorySink();
    sink.failCommit = true;
    const refusingCompensator: CoordinatedSkillCompensator = {
      getInstalled: (id, version) => installer.getInstalled(id, version),
      uninstall: () => ({ ok: false }),
    };
    const { coordinator } = createCoordinator({ sink, skillCompensator: refusingCompensator });

    const result = await coordinator.importBundle(exported.bytes);

    expect(result).toMatchObject({ ok: false, code: 'compensation_failed', compensated: false });
    expect(sink.values).toHaveLength(0);
    expect(installer.listInstalled(fixture.definition.id)).toHaveLength(1);
    expect(fs.existsSync(assetDirectory(exported.bundle.manifest.bundleDigest))).toBe(false);
    expect(receiptFiles()).toEqual([]);
  });

  it('detects an on-disk manifest mutation before rehydration and removes the imported inventory', async () => {
    const fixture = packageFixture();
    const exported = await exportFixtures([fixture]);
    const mutatingService: CoordinatedBundleImportService = {
      importBundle: async (bytes, sink) => {
        const result = await importer.importBundle(bytes, sink);
        if (result.ok && result.assetDirectoryToken) {
          fs.appendFileSync(path.join(bundleAssetRoot, result.assetDirectoryToken, 'bundle-manifest.json'), ' ');
        }
        return result;
      },
    };
    const { coordinator, sink } = createCoordinator({ bundleService: mutatingService });

    const result = await coordinator.importBundle(exported.bytes);

    expect(result).toMatchObject({ ok: false, code: 'manifest_tampered', compensated: true });
    expect(sink.values).toHaveLength(0);
    expect(installer.listInstalled()).toHaveLength(0);
    expect(fs.existsSync(assetDirectory(exported.bundle.manifest.bundleDigest))).toBe(false);
  });

  it('treats a missing on-disk manifest as tampering rather than a valid empty inventory', async () => {
    const fixture = packageFixture();
    const exported = await exportFixtures([fixture]);
    const deletingService: CoordinatedBundleImportService = {
      importBundle: async (bytes, sink) => {
        const result = await importer.importBundle(bytes, sink);
        if (result.ok && result.assetDirectoryToken) {
          fs.unlinkSync(path.join(bundleAssetRoot, result.assetDirectoryToken, 'bundle-manifest.json'));
        }
        return result;
      },
    };
    const { coordinator, sink } = createCoordinator({ bundleService: deletingService });

    const result = await coordinator.importBundle(exported.bytes);

    expect(result).toMatchObject({ ok: false, code: 'manifest_tampered', compensated: true });
    expect(sink.values).toHaveLength(0);
    expect(installer.listInstalled()).toHaveLength(0);
    expect(fs.existsSync(assetDirectory(exported.bundle.manifest.bundleDigest))).toBe(false);
  });

  it('independently rejects a tampered asset binding returned through BundleService', async () => {
    const fixture = markdownFixture();
    const exported = await exportFixtures([fixture]);
    const bindingMutator: CoordinatedBundleImportService = {
      importBundle: (bytes, sink) => importer.importBundle(bytes, {
        get: (id) => sink.get(id),
        begin: async () => {
          const transaction = await sink.begin();
          return {
            save: (definition, binding) => transaction.save(definition, binding ? {
              ...binding,
              relativeRoot: '0'.repeat(24),
            } : undefined),
            commit: () => transaction.commit(),
            rollback: () => transaction.rollback(),
          };
        },
      }),
    };
    const { coordinator, sink } = createCoordinator({ bundleService: bindingMutator });

    const result = await coordinator.importBundle(exported.bytes);

    expect(result).toMatchObject({
      ok: false,
      code: 'manifest_tampered',
      detail: 'bundle_service_output_mismatch',
      compensated: true,
    });
    expect(sink.beginCount).toBe(0);
    expect(sink.values).toHaveLength(0);
    expect(installer.listInstalled()).toHaveLength(0);
    expect(fs.existsSync(assetDirectory(exported.bundle.manifest.bundleDigest))).toBe(false);
  });

  it('detects and removes an installation left behind when a rehydrator throws after installing', async () => {
    const fixture = markdownFixture();
    const exported = await exportFixtures([fixture]);
    const installThenThrow: CoordinatedSkillRehydrator = {
      rehydrate: (request) => {
        const installed = rehydrator.rehydrate(request);
        if (!installed.ok) throw new Error(installed.detail);
        throw new Error('injected post-install exception');
      },
    };
    const { coordinator, sink } = createCoordinator({ skillRehydrator: installThenThrow });

    const result = await coordinator.importBundle(exported.bytes);

    expect(result).toMatchObject({ ok: false, code: 'skill_rehydration_failed', compensated: true });
    expect(sink.values).toHaveLength(0);
    expect(installer.listInstalled()).toHaveLength(0);
    expect(fs.existsSync(assetDirectory(exported.bundle.manifest.bundleDigest))).toBe(false);
  });

  it('publishes imported MCP assets only as deferred_requires_local_activation and never auto-enables them', async () => {
    const fixture = mcpFixture();
    const exported = await exportFixtures([fixture]);
    const { coordinator, sink } = createCoordinator();

    const result = await coordinator.importBundle(exported.bytes);

    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      deferred: [{
        definitionId: fixture.definition.id,
        status: 'deferred_requires_local_activation',
      }],
    });
    const imported = sink.values.get(fixture.definition.id);
    expect(imported).toMatchObject({
      kind: 'mcp',
      enabled: false,
      tags: expect.arrayContaining(['deferred_requires_local_activation']),
      args: [],
      exposedTools: [],
      workingDirectoryToken: null,
      environment: {
        SERVICE_REGION: { secret: false, value: 'test' },
        SERVICE_TOKEN: { secret: true, value: null },
      },
    });
    if (!imported || imported.kind !== 'mcp') throw new Error('Expected a deferred MCP definition');
    expect(imported.tags).toHaveLength(128);
    expect(installer.listInstalled()).toHaveLength(0);
    expect(fs.existsSync(assetDirectory(exported.bundle.manifest.bundleDigest))).toBe(true);
  });
});
