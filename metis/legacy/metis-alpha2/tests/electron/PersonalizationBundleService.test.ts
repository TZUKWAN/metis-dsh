import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PersonalizationBundleService,
  computePersonalizationBundleDigest,
  type PersonalizationBundleDefinitionSink,
  type PersonalizationBundleDefinitionTransaction,
} from '../../electron/PersonalizationBundleService.js';
import type {
  PersonalizationBundle,
} from '../../engine/runtime/PersonalizationBundleContract.js';
import type {
  AgentDefinition,
  McpDefinition,
  MetisRulesDefinition,
  PersonalizationDefinition,
  ScenarioDefinition,
  SkillDefinitionV2,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';

const NOW = 1_785_394_400_000;
const roots: string[] = [];

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function provenance(origin: 'user' | 'builtin' = 'user') {
  return {
    origin,
    author: origin === 'builtin' ? 'Metis' : 'Bundle test',
    version: '1.0.0',
    license: 'Apache-2.0',
    sourceUrl: null,
    sourceRevision: null,
    installedDigest: null,
    parentId: null,
    parentVersion: null,
    locallyModified: origin !== 'builtin',
    createdAt: NOW,
    updatedAt: NOW,
  } as const;
}

const memory = { scope: 'scenario' as const, retainDecisions: true, retainArtifacts: true, maxSummaryChars: 20_000 };
const output = { format: 'markdown' as const, schema: null, requireEvidenceEnvelope: true, includeIntegrityReport: true };

function graph(): PersonalizationDefinition[] {
  const mcp: McpDefinition = {
    contractVersion: 1,
    id: 'user:mcp/search',
    kind: 'mcp',
    name: 'Search MCP',
    description: 'Searches a service.',
    enabled: true,
    tags: [],
    revision: 1,
    provenance: provenance(),
    sourceMode: 'generated',
    transport: 'stdio',
    command: 'node',
    args: ['server.mjs'],
    environment: {
      SEARCH_TOKEN: { secret: true, value: 'TOP-SECRET-MUST-NOT-EXPORT' },
      SEARCH_REGION: { secret: false, value: 'cn' },
    },
    sourceUrl: null,
    exposedTools: ['search'],
    workingDirectoryToken: 'mcp-search',
  };
  const skill: SkillDefinitionV2 = {
    contractVersion: 1,
    id: 'user:skills/review',
    kind: 'skill',
    name: 'Review',
    description: 'Reviews evidence.',
    enabled: true,
    tags: [],
    revision: 1,
    provenance: provenance(),
    sourceMode: 'package',
    markdown: '# Review',
    systemPrompt: 'Review with evidence.',
    toolIds: ['read_pdf'],
    mcpIds: [mcp.id],
    maxTurns: 8,
    inputSchema: null,
    outputSchema: null,
    packageEntry: 'skill.md',
  };
  const agent: AgentDefinition = {
    contractVersion: 1,
    id: 'user:agents/reviewer',
    kind: 'agent',
    name: 'Reviewer',
    description: 'Evidence reviewer.',
    enabled: true,
    tags: [],
    revision: 1,
    provenance: provenance(),
    role: 'Reviewer',
    systemPrompt: 'Review evidence.',
    modelPreference: null,
    skillIds: [skill.id],
    toolIds: ['read_pdf'],
    mcpIds: [mcp.id],
    memory,
    output,
    maxTurns: 8,
    retryLimit: 1,
  };
  const rules: MetisRulesDefinition = {
    contractVersion: 1,
    id: 'user:rules/global',
    kind: 'rules',
    name: 'Metis rules',
    description: 'Portable project rules.',
    enabled: true,
    tags: [],
    revision: 1,
    provenance: provenance(),
    scope: 'global',
    scopeId: null,
    markdown: '# Metis.md\n\nWork autonomously.',
  };
  const scenario: ScenarioDefinition = {
    contractVersion: 1,
    id: 'user:scenarios/research',
    kind: 'scenario',
    name: 'Research',
    description: 'Portable research scenario.',
    enabled: true,
    tags: [],
    revision: 1,
    provenance: provenance(),
    agentIds: [agent.id],
    skillIds: [skill.id],
    mcpIds: [mcp.id],
    rulesIds: [rules.id],
    workflow: [{
      id: 'review',
      name: 'Review',
      description: 'Review evidence.',
      agentId: agent.id,
      skillIds: [skill.id],
      toolIds: ['read_pdf'],
      mcpIds: [mcp.id],
      dependsOn: [],
      maxTurns: 8,
    }],
    fullAccess: {
      mode: 'full_access',
      perActionConfirmation: false,
      liveSteering: true,
      silentCheckpoints: true,
      rollbackOnFailure: false,
      persistAcrossRestart: true,
    },
    memory,
    output,
    triggerPhrases: ['review'],
    capability: 'research',
  };
  return [scenario, agent, skill, mcp, rules];
}

class MemorySink implements PersonalizationBundleDefinitionSink {
  readonly values = new Map<string, PersonalizationDefinition>();
  readonly saveOrder: string[] = [];
  failSaveAt: number | null = null;
  failCommit = false;
  rollbackCount = 0;
  readonly assetBindings = new Map<string, { directoryToken: string; relativeRoot: string }>();

  get(id: string): PersonalizationDefinition | undefined {
    return this.values.get(id);
  }

  begin(): PersonalizationBundleDefinitionTransaction {
    const staged = new Map<string, PersonalizationDefinition>();
    let saveCount = 0;
    let committed = false;
    return {
      save: (definition, assetBinding) => {
        saveCount += 1;
        if (this.failSaveAt === saveCount) throw new Error('injected save failure');
        staged.set(definition.id, definition);
        this.saveOrder.push(definition.id);
        if (assetBinding) this.assetBindings.set(definition.id, assetBinding);
      },
      commit: () => {
        if (this.failCommit) throw new Error('injected commit failure');
        for (const [id, definition] of staged) this.values.set(id, definition);
        committed = true;
      },
      rollback: () => {
        this.rollbackCount += 1;
        if (committed) for (const id of staged.keys()) this.values.delete(id);
        staged.clear();
      },
    };
  }
}

function source(definitions = graph()) {
  const values = new Map(definitions.map((definition) => [definition.id, definition]));
  return { get: (id: string) => values.get(id) };
}

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function bytesFor(bundle: PersonalizationBundle): Buffer {
  return Buffer.from(JSON.stringify(bundle), 'utf8');
}

function recompute(bundle: PersonalizationBundle): void {
  const { bundleDigest, ...manifest } = bundle.manifest;
  void bundleDigest;
  bundle.manifest.bundleDigest = computePersonalizationBundleDigest({ manifest, payloads: bundle.payloads });
}

function assetFixture() {
  const root = tempRoot('metis-bundle-assets-');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'skill.md'), '# Portable skill', 'utf8');
  fs.writeFileSync(
    path.join(root, 'scripts', 'never-execute.mjs'),
    "import fs from 'node:fs'; fs.writeFileSync(new URL('../EXECUTED', import.meta.url), 'bad');",
    'utf8',
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('PersonalizationBundleService round trip', () => {
  it('exports the complete dependency graph, redacts secrets, imports topologically, and never executes assets', async () => {
    const importRoot = tempRoot('metis-bundle-import-');
    const assetRoot = assetFixture();
    const service = new PersonalizationBundleService(importRoot, { now: () => NOW });
    const exported = await service.exportBundle({
      rootDefinitionIds: ['user:scenarios/research'],
      assetMode: 'include_files',
      createdBy: 'Bundle test',
    }, source(), {
      list: (ownerId) => ownerId === 'user:skills/review'
        ? { rootDirectory: assetRoot, relativePaths: ['skill.md', 'scripts/never-execute.mjs'] }
        : undefined,
    });
    expect(exported.bundle.manifest.definitions).toHaveLength(5);
    expect(Buffer.from(exported.bytes).toString('utf8')).not.toContain('TOP-SECRET-MUST-NOT-EXPORT');
    const mcpEntry = exported.bundle.manifest.definitions.find((entry) => entry.id === 'user:mcp/search')!;
    expect(mcpEntry.secretRefs).toEqual(['${secret:SEARCH_TOKEN}']);

    const sink = new MemorySink();
    const dryRun = await service.dryRunImport(exported.bytes, sink);
    expect(dryRun).toMatchObject({ ok: true, plan: { definitionCount: 5, includedAssetCount: 2 } });
    expect(sink.values.size).toBe(0);
    const result = await service.importBundle(exported.bytes, sink);
    expect(result).toMatchObject({ ok: true, plan: { definitionCount: 5, includedAssetCount: 2 } });
    expect(sink.values.size).toBe(5);
    expect(sink.saveOrder.indexOf('user:mcp/search')).toBeLessThan(sink.saveOrder.indexOf('user:skills/review'));
    expect(sink.saveOrder.indexOf('user:skills/review')).toBeLessThan(sink.saveOrder.indexOf('user:agents/reviewer'));
    expect(sink.saveOrder.indexOf('user:agents/reviewer')).toBeLessThan(sink.saveOrder.indexOf('user:scenarios/research'));
    const importedMcp = sink.values.get('user:mcp/search');
    expect(importedMcp?.kind === 'mcp' && importedMcp.environment.SEARCH_TOKEN?.value).toBeNull();
    expect(sink.assetBindings.get('user:skills/review')).toMatchObject({
      directoryToken: result.ok ? result.assetDirectoryToken : null,
      relativeRoot: expect.stringMatching(/^[a-f0-9]{24}$/u),
    });
    expect(fs.existsSync(path.join(importRoot, 'EXECUTED'))).toBe(false);
    expect(fs.existsSync(path.join(assetRoot, 'EXECUTED'))).toBe(false);
    expect(fs.readdirSync(importRoot).some((entry) => entry.startsWith('.staging-'))).toBe(false);
  });

  it('supports manifest-only asset inventory without importing opaque files', async () => {
    const service = new PersonalizationBundleService(tempRoot('metis-bundle-manifest-'));
    const assetRoot = assetFixture();
    const exported = await service.exportBundle({
      rootDefinitionIds: ['user:skills/review'], assetMode: 'manifest_only', createdBy: 'Bundle test',
    }, source(), {
      list: (ownerId) => ownerId === 'user:skills/review'
        ? { rootDirectory: assetRoot, relativePaths: ['skill.md'] } : undefined,
    });
    expect(exported.bundle.manifest.assets).toMatchObject([{ included: false, payloadPath: null, executable: false }]);
    const result = await service.importBundle(exported.bytes, new MemorySink());
    expect(result).toMatchObject({ ok: true, assetDirectoryToken: null });
  });
});

describe('PersonalizationBundleService import attacks', () => {
  async function exportedFixture() {
    const service = new PersonalizationBundleService(tempRoot('metis-bundle-attack-'));
    const exported = await service.exportBundle({
      rootDefinitionIds: ['user:scenarios/research'], assetMode: 'none', createdBy: 'Bundle test',
    }, source());
    return { service, bundle: structuredClone(exported.bundle), bytes: exported.bytes };
  }

  it('detects top-level and per-payload tampering', async () => {
    const { service, bundle } = await exportedFixture();
    bundle.payloads[0]!.content = Buffer.from('tampered', 'utf8').toString('base64');
    await expect(service.importBundle(bytesFor(bundle), new MemorySink()))
      .resolves.toMatchObject({ ok: false, code: 'digest_mismatch' });

    recompute(bundle);
    await expect(service.importBundle(bytesFor(bundle), new MemorySink()))
      .resolves.toMatchObject({ ok: false, code: 'payload_mismatch' });
  });

  it('rejects a correctly rehashed truth-authority field injection', async () => {
    const { service, bundle } = await exportedFixture();
    const entry = bundle.manifest.definitions.find((item) => item.kind === 'skill')!;
    const payload = bundle.payloads.find((item) => item.path === entry.payloadPath)!;
    const definition = JSON.parse(Buffer.from(payload.content, 'base64').toString('utf8')) as Record<string, unknown>;
    definition.verified = true;
    const content = Buffer.from(JSON.stringify(definition), 'utf8');
    payload.content = content.toString('base64');
    payload.size = content.length;
    payload.sha256 = sha256(content);
    entry.size = content.length;
    entry.sha256 = payload.sha256;
    recompute(bundle);
    await expect(service.importBundle(bytesFor(bundle), new MemorySink()))
      .resolves.toMatchObject({ ok: false, code: 'truth_field_rejected' });
  });

  it('rejects a correctly rehashed literal secret and an existing user-definition overwrite', async () => {
    const { service, bundle } = await exportedFixture();
    const entry = bundle.manifest.definitions.find((item) => item.kind === 'mcp')!;
    const payload = bundle.payloads.find((item) => item.path === entry.payloadPath)!;
    const definition = JSON.parse(Buffer.from(payload.content, 'base64').toString('utf8')) as {
      environment: Record<string, { secret: boolean; value: string | null }>;
    };
    definition.environment.SEARCH_TOKEN!.value = 'smuggled-secret';
    const content = Buffer.from(JSON.stringify(definition), 'utf8');
    payload.content = content.toString('base64');
    payload.size = content.length;
    payload.sha256 = sha256(content);
    entry.size = content.length;
    entry.sha256 = payload.sha256;
    recompute(bundle);
    await expect(service.importBundle(bytesFor(bundle), new MemorySink()))
      .resolves.toMatchObject({ ok: false, code: 'definition_invalid' });

    const clean = await exportedFixture();
    const sink = new MemorySink();
    sink.values.set('user:rules/global', graph().find((item) => item.id === 'user:rules/global')!);
    await expect(clean.service.importBundle(clean.bytes, sink))
      .resolves.toMatchObject({ ok: false, code: 'existing_conflict' });
  });

  it('rejects traversal, duplicate IDs, and missing dependencies before staging', async () => {
    const first = await exportedFixture();
    first.bundle.payloads[0]!.path = 'definitions/../escape.json';
    await expect(first.service.importBundle(bytesFor(first.bundle), new MemorySink()))
      .resolves.toMatchObject({ ok: false, code: 'invalid_bundle' });

    const second = await exportedFixture();
    second.bundle.manifest.definitions[1]!.id = second.bundle.manifest.definitions[0]!.id;
    await expect(second.service.importBundle(bytesFor(second.bundle), new MemorySink()))
      .resolves.toMatchObject({ ok: false, code: 'invalid_bundle' });

    const third = await exportedFixture();
    const skillEntry = third.bundle.manifest.definitions.find((entry) => entry.kind === 'skill')!;
    third.bundle.manifest.definitions = third.bundle.manifest.definitions.filter((entry) => entry !== skillEntry);
    third.bundle.payloads = third.bundle.payloads.filter((payload) => payload.path !== skillEntry.payloadPath);
    recompute(third.bundle);
    await expect(third.service.importBundle(bytesFor(third.bundle), new MemorySink()))
      .resolves.toMatchObject({ ok: false, code: 'dependency_missing' });
  });

  it('rejects a dependency whose ID exists under the wrong definition kind', async () => {
    const { service, bundle } = await exportedFixture();
    const scenarioEntry = bundle.manifest.definitions.find((entry) => entry.kind === 'scenario')!;
    const skillEntry = bundle.manifest.definitions.find((entry) => entry.kind === 'skill')!;
    const payload = bundle.payloads.find((item) => item.path === scenarioEntry.payloadPath)!;
    const scenario = JSON.parse(Buffer.from(payload.content, 'base64').toString('utf8')) as {
      agentIds: string[];
      workflow: Array<{ agentId: string }>;
    };
    scenario.agentIds = [skillEntry.id];
    scenario.workflow[0]!.agentId = skillEntry.id;
    const content = Buffer.from(JSON.stringify(scenario), 'utf8');
    payload.content = content.toString('base64');
    payload.size = content.length;
    payload.sha256 = sha256(content);
    scenarioEntry.size = content.length;
    scenarioEntry.sha256 = payload.sha256;
    recompute(bundle);
    await expect(service.importBundle(bytesFor(bundle), new MemorySink()))
      .resolves.toMatchObject({ ok: false, code: 'dependency_missing' });
  });

  it('protects factory IDs from absence, substitution, and overwrite', async () => {
    const factory = graph()[2]! as SkillDefinitionV2;
    const builtin: SkillDefinitionV2 = {
      ...factory,
      id: 'builtin:skills/review',
      provenance: provenance('builtin'),
      sourceMode: 'markdown',
      mcpIds: [],
      packageEntry: null,
    };
    const service = new PersonalizationBundleService(tempRoot('metis-bundle-factory-'));
    const exported = await service.exportBundle({
      rootDefinitionIds: [builtin.id], assetMode: 'none', createdBy: 'Metis',
    }, source([builtin]));
    await expect(service.importBundle(exported.bytes, new MemorySink()))
      .resolves.toMatchObject({ ok: false, code: 'factory_protected' });

    const sink = new MemorySink();
    sink.values.set(builtin.id, { ...builtin, description: 'Different factory content' });
    await expect(service.importBundle(exported.bytes, sink))
      .resolves.toMatchObject({ ok: false, code: 'factory_protected' });

    const identicalSink = new MemorySink();
    identicalSink.values.set(builtin.id, builtin);
    await expect(service.importBundle(exported.bytes, identicalSink))
      .resolves.toMatchObject({ ok: true, plan: { definitionCount: 1 } });
    expect(identicalSink.values.get(builtin.id)).toEqual(builtin);
  });

  it('rejects path escape and symbolic-link assets at export', async () => {
    const service = new PersonalizationBundleService(tempRoot('metis-bundle-assets-reject-'));
    const assetRoot = assetFixture();
    await expect(service.exportBundle({
      rootDefinitionIds: ['user:skills/review'], assetMode: 'include_files', createdBy: 'Bundle test',
    }, source(), {
      list: () => ({ rootDirectory: assetRoot, relativePaths: ['../outside'] }),
    })).rejects.toThrow();

    const link = path.join(assetRoot, 'linked.mjs');
    try {
      fs.symlinkSync(path.join(assetRoot, 'skill.md'), link, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    await expect(service.exportBundle({
      rootDefinitionIds: ['user:skills/review'], assetMode: 'include_files', createdBy: 'Bundle test',
    }, source(), {
      list: () => ({ rootDirectory: assetRoot, relativePaths: ['linked.mjs'] }),
    })).rejects.toThrow(/Unsafe asset/u);
  });

  it('refuses explicit credential and private-key assets', async () => {
    const service = new PersonalizationBundleService(tempRoot('metis-bundle-secret-assets-'));
    const assetRoot = assetFixture();
    fs.mkdirSync(path.join(assetRoot, 'config'));
    fs.writeFileSync(path.join(assetRoot, 'config', '.env'), 'API_KEY=must-not-export', 'utf8');
    await expect(service.exportBundle({
      rootDefinitionIds: ['user:skills/review'], assetMode: 'include_files', createdBy: 'Bundle test',
    }, source(), {
      list: () => ({ rootDirectory: assetRoot, relativePaths: ['config/.env'] }),
    })).rejects.toThrow(/Sensitive asset/u);
  });
});

describe('PersonalizationBundleService rollback', () => {
  it('rolls back every staged definition and asset after a partial sink failure', async () => {
    const importRoot = tempRoot('metis-bundle-rollback-');
    const assetRoot = assetFixture();
    const service = new PersonalizationBundleService(importRoot);
    const exported = await service.exportBundle({
      rootDefinitionIds: ['user:scenarios/research'], assetMode: 'include_files', createdBy: 'Bundle test',
    }, source(), {
      list: (ownerId) => ownerId === 'user:skills/review'
        ? { rootDirectory: assetRoot, relativePaths: ['skill.md'] } : undefined,
    });
    const sink = new MemorySink();
    sink.failSaveAt = 2;
    const result = await service.importBundle(exported.bytes, sink);
    expect(result).toMatchObject({ ok: false, code: 'sink_failed' });
    expect(sink.values.size).toBe(0);
    expect(sink.rollbackCount).toBe(1);
    expect(fs.readdirSync(importRoot)).toEqual([]);
  });

  it('removes published assets and rolls back definitions when commit fails', async () => {
    const importRoot = tempRoot('metis-bundle-commit-');
    const assetRoot = assetFixture();
    const service = new PersonalizationBundleService(importRoot);
    const exported = await service.exportBundle({
      rootDefinitionIds: ['user:skills/review'], assetMode: 'include_files', createdBy: 'Bundle test',
    }, source(), {
      list: () => ({ rootDirectory: assetRoot, relativePaths: ['skill.md'] }),
    });
    const sink = new MemorySink();
    sink.failCommit = true;
    const result = await service.importBundle(exported.bytes, sink);
    expect(result).toMatchObject({ ok: false, code: 'commit_failed' });
    expect(sink.values.size).toBe(0);
    expect(sink.rollbackCount).toBe(1);
    expect(fs.readdirSync(importRoot)).toEqual([]);
  });

  it('reports rollback failure instead of claiming a clean rollback', async () => {
    const service = new PersonalizationBundleService(tempRoot('metis-bundle-rollback-fail-'));
    const exported = await service.exportBundle({
      rootDefinitionIds: ['user:rules/global'], assetMode: 'none', createdBy: 'Bundle test',
    }, source());
    const sink: PersonalizationBundleDefinitionSink = {
      get: () => undefined,
      begin: () => ({
        save: () => { throw new Error('injected save failure'); },
        commit: () => undefined,
        rollback: () => { throw new Error('injected rollback failure'); },
      }),
    };
    await expect(service.importBundle(exported.bytes, sink))
      .resolves.toMatchObject({ ok: false, code: 'rollback_failed' });
  });
});
