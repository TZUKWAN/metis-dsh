import fs from 'node:fs';

import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { realTempRoot } from './helpers/realTempDir.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import {
  McpActivationResponseSchema,
  type McpActivationRequest,
} from '../../engine/runtime/McpActivationContract.js';
import {
  McpDefinitionSchema,
  PERSONALIZATION_CONTRACT_VERSION,
  type McpDefinition,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { EvidenceEnvelopeService } from '../../electron/EvidenceEnvelopeService.js';
import { generateMcpBundle } from '../../electron/McpBuilderService.js';
import {
  FilesystemMcpInstallationCompensator,
  PersonalizationExtensionService,
} from '../../electron/PersonalizationExtensionService.js';
import { PersonalizationMcpActivationService } from '../../electron/PersonalizationMcpActivationService.js';
import {
  McpActivationCrashSimulation,
  type McpActivationCrashPoint,
  type PersonalizationMcpActivationDependencies,
} from '../../electron/PersonalizationMcpActivationService.js';
import {
  PersonalizationMcpInstaller,
  type McpDownloadedResource,
  type McpNetworkClient,
} from '../../electron/PersonalizationMcpInstaller.js';
import { PersonalizationMcpProbeRunner } from '../../electron/PersonalizationMcpProbeRunner.js';
import type { McpInstalledRecord } from '../../engine/runtime/McpInstallationContract.js';

const roots: string[] = [];
const databases: Database.Database[] = [];
const OWNER = { webContentsId: 17, processId: 23, routingId: 0, generation: 1 };
const INPUT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

interface Harness {
  root: string;
  installer: PersonalizationMcpInstaller;
  repository: PersonalizationRepository;
  evidence: EvidenceEnvelopeService;
  runner: PersonalizationMcpProbeRunner;
  definition: McpDefinition;
  installationId: string;
  staticRecord: McpInstalledRecord;
  request: McpActivationRequest;
}

class MemoryMcpNetwork implements McpNetworkClient {
  readonly resources = new Map<string, McpDownloadedResource>();

  async download(url: string): Promise<McpDownloadedResource> {
    const resource = this.resources.get(url);
    if (!resource) throw new Error('download_failed');
    return resource;
  }

  set(url: string, body: Uint8Array | string): void {
    this.resources.set(url, {
      finalUrl: url,
      body: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
      contentType: 'application/octet-stream',
    });
  }
}

function createHarness(resolvedSecret?: string): Harness {
  const root = fs.mkdtempSync(path.join(realTempRoot(), 'metis-mcp-activation-'));
  roots.push(root);
  const mcpRoot = path.join(root, 'mcp');
  const installer = new PersonalizationMcpInstaller(mcpRoot, { now: () => 500 });
  const bundle = generateMcpBundle({
    contractVersion: 1,
    packageId: 'url-activation-fixture',
    version: '1.0.0',
    name: 'URL activation fixture',
    description: 'A deterministic package installed through the URL-definition lifecycle.',
    environment: resolvedSecret === undefined ? [] : [{
      name: 'PROBE_TOKEN',
      secretRef: '${secret:PROBE_TOKEN}',
      required: true,
      description: 'Probe-only secret binding.',
    }],
    tools: [{
      name: 'bounded_echo',
      description: 'Return a bounded string.',
      inputSchema: INPUT_SCHEMA,
      implementation: { kind: 'echo', argument: 'text' },
    }],
  });
  const installed = installer.installGeneratedPackage(bundle.manifest, bundle.files);
  const staticResult = installer.staticValidate(installed.installationId);
  if (!staticResult.ok || !staticResult.record) throw new Error('Static fixture validation failed');

  const db = new Database(':memory:');
  databases.push(db);
  const repository = new PersonalizationRepository(db, randomBytes(32));
  const definition = McpDefinitionSchema.parse({
    contractVersion: PERSONALIZATION_CONTRACT_VERSION,
    id: 'url:mcp/activation-fixture',
    kind: 'mcp',
    name: installed.packageId,
    description: `Managed MCP package ${installed.packageId} ${installed.packageVersion}`,
    enabled: false,
    tags: ['url', 'pending-probe'],
    revision: 1,
    provenance: {
      origin: 'url',
      author: 'External MCP package',
      version: installed.packageVersion,
      license: null,
      sourceUrl: 'https://packages.example.org/manifest.json',
      sourceRevision: installed.installationId,
      installedDigest: installed.packageSha256,
      parentId: null,
      parentVersion: null,
      locallyModified: false,
      createdAt: 600,
      updatedAt: 600,
    },
    sourceMode: 'url',
    transport: 'stdio',
    command: 'metis-managed-mcp',
    args: [installed.installationId],
    environment: {},
    sourceUrl: 'https://packages.example.org/manifest.json',
    exposedTools: [],
    workingDirectoryToken: installed.installationId,
  });
  expect(repository.save({ contractVersion: 1, definition, expectedRevision: 0 }).ok).toBe(true);
  const evidence = new EvidenceEnvelopeService(randomBytes(32));
  const runner = new PersonalizationMcpProbeRunner({ resolve: () => resolvedSecret });
  const request: McpActivationRequest = {
    contractVersion: 1,
    definitionId: definition.id,
    installationId: installed.installationId,
    expectedRevision: 1,
    evidenceContext: {
      sessionId: 'session-activation',
      projectId: 'project-activation',
      operationId: '00000000-0000-4000-8000-000000000222',
      runManifestDigest: 'b'.repeat(64),
      observedAt: 700,
      owner: OWNER,
    },
  };
  return {
    root,
    installer,
    repository,
    evidence,
    runner,
    definition,
    installationId: installed.installationId,
    staticRecord: staticResult.record,
    request,
  };
}

function service(harness: Harness, overrides: Partial<PersonalizationMcpActivationDependencies> = {}) {
  return new PersonalizationMcpActivationService(path.join(harness.root, 'mcp'), {
    installer: harness.installer,
    runner: harness.runner,
    store: harness.repository,
    evidence: harness.evidence,
    now: () => 800,
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('PersonalizationMcpActivationService', () => {
  it('runs the real URL install -> static validation -> list-only activation chain end to end', async () => {
    const root = fs.mkdtempSync(path.join(realTempRoot(), 'metis-mcp-url-activation-e2e-'));
    roots.push(root);
    const mcpRoot = path.join(root, 'mcp');
    const network = new MemoryMcpNetwork();
    const bundle = generateMcpBundle({
      contractVersion: 1,
      packageId: 'url-e2e-fixture',
      version: '1.0.0',
      name: 'URL E2E fixture',
      description: 'A real URL installation activated after static verification.',
      environment: [],
      tools: [{
        name: 'bounded_echo', description: 'Return a bounded string.', inputSchema: INPUT_SCHEMA,
        implementation: { kind: 'echo', argument: 'text' },
      }],
    });
    const fileUrl = 'https://packages.example.org/server.mjs';
    const manifestUrl = 'https://packages.example.org/manifest.json';
    const manifest = { ...bundle.manifest, files: bundle.manifest.files.map((file) => ({ ...file, url: fileUrl })) };
    network.set(manifestUrl, JSON.stringify(manifest));
    network.set(fileUrl, bundle.files[0]!.body);
    const installer = new PersonalizationMcpInstaller(mcpRoot, { network, now: () => 1_000 });
    const db = new Database(':memory:');
    databases.push(db);
    const repository = new PersonalizationRepository(db, randomBytes(32));
    const evidence = new EvidenceEnvelopeService(randomBytes(32));
    const extension = new PersonalizationExtensionService({
      definitions: repository,
      evidence,
      skills: {
        installFromPackage: () => ({ ok: false, code: 'invalid_request' }),
        installFromUrl: async () => ({ ok: false, code: 'invalid_request' }),
        uninstall: () => ({ ok: false }),
        resolveInstalledDirectory: () => undefined,
      },
      mcp: installer,
      mcpBuilder: { build: async () => { throw new Error('unused'); } },
      mcpCompensator: new FilesystemMcpInstallationCompensator(mcpRoot),
      now: () => 1_100,
    });
    const definitionId = 'url:mcp/url-e2e-fixture';
    const installed = await extension.apply({
      contractVersion: 1,
      mode: 'mcp_url',
      definitionId,
      manifestUrl,
      expectedManifestSha256: null,
      expectedRevision: 0,
      evidenceContext: {
        sessionId: 'session-url-e2e', projectId: 'project-url-e2e', operationId: randomUUID(),
        runManifestDigest: 'f'.repeat(64), observedAt: 1_100,
      },
    });
    expect(installed).toMatchObject({
      ok: true,
      definition: { enabled: false, revision: 1 },
      mcpInstallation: { state: 'static_verified', enabled: false },
    });
    if (!installed.ok || !installed.mcpInstallation) throw new Error('URL installation failed');

    const runner = new PersonalizationMcpProbeRunner({ resolve: () => undefined });
    const probe = vi.spyOn(runner, 'probe');
    const activated = await new PersonalizationMcpActivationService(mcpRoot, {
      installer, runner, store: repository, evidence, now: () => 1_200,
    }).activate({
      contractVersion: 1,
      definitionId,
      installationId: installed.mcpInstallation.installationId,
      expectedRevision: 1,
      evidenceContext: {
        sessionId: 'session-url-e2e', projectId: 'project-url-e2e', operationId: randomUUID(),
        runManifestDigest: 'f'.repeat(64), observedAt: 1_200, owner: OWNER,
      },
    });
    expect(activated).toMatchObject({ ok: true, definition: { enabled: true }, installation: { state: 'enabled' } });
    expect(probe).toHaveBeenCalledOnce();
    expect('sampleCall' in (probe.mock.calls[0]?.[0] ?? {})).toBe(false);
  });

  it('activates a static-verified URL MCP only after a real list-only probe and atomically records signed evidence', async () => {
    const harness = createHarness();
    const probe = vi.spyOn(harness.runner, 'probe');
    const result = await service(harness).activate(harness.request);

    expect(McpActivationResponseSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      definition: { enabled: true, revision: 2, exposedTools: ['bounded_echo'] },
      installation: { enabled: true, state: 'enabled', exposedTools: ['bounded_echo'] },
      evidence: { truth: { state: 'unverified', publishEligible: false } },
    });
    expect(probe).toHaveBeenCalledOnce();
    expect('sampleCall' in (probe.mock.calls[0]?.[0] ?? {})).toBe(false);
    if (!result.ok) throw new Error(result.code);
    expect(harness.evidence.verify(result.evidence)).toBe(true);
    expect(harness.repository.get(harness.definition.id, true)).toEqual(result.definition);
    expect(harness.repository.listEvidenceEnvelopes('session-activation')).toEqual([result.evidence]);
    expect(harness.installer.getLaunchDescriptor(harness.installationId)).not.toBeNull();
  });

  it('strictly rejects renderer-supplied sampleCall before probing or changing state', async () => {
    const harness = createHarness();
    const probe = vi.spyOn(harness.runner, 'probe');
    const result = await service(harness).activate({
      ...harness.request,
      sampleCall: { toolName: 'bounded_echo', arguments: { text: 'forbidden' } },
    });
    expect(result).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(probe).not.toHaveBeenCalled();
    expect(harness.repository.get(harness.definition.id, true)).toEqual(harness.definition);
    expect(harness.installer.getLaunchDescriptor(harness.installationId)).toBeNull();
  });

  it('keeps the definition and installation disabled when the runtime tool contract mismatches', async () => {
    const harness = createHarness();
    const result = await service(harness, {
      runner: { probe: async () => ({
        ok: true,
        protocolVersion: '2025-06-18',
        tools: [{ name: 'phantom_tool', description: 'Mismatch', inputSchema: INPUT_SCHEMA }],
      }) },
    }).activate(harness.request);
    expect(result).toMatchObject({ ok: false, code: 'probe_failed', recoveryPending: false });
    expect(harness.repository.get(harness.definition.id, true)).toEqual(harness.definition);
    expect(harness.repository.listEvidenceEnvelopes('session-activation')).toEqual([]);
    expect(harness.installer.getLaunchDescriptor(harness.installationId)).toBeNull();
  });

  it('rolls the enabled installation back when evidence verification or the DB CAS fails', async () => {
    const evidenceFailure = createHarness();
    const invalidEvidence = {
      issue: evidenceFailure.evidence.issue.bind(evidenceFailure.evidence),
      verify: () => false,
    };
    const first = await service(evidenceFailure, { evidence: invalidEvidence }).activate(evidenceFailure.request);
    expect(first).toMatchObject({ ok: false, code: 'evidence_unavailable', compensated: true, recoveryPending: false });
    expect(evidenceFailure.installer.readInstalledRecord(evidenceFailure.installationId)).toEqual(evidenceFailure.staticRecord);
    expect(evidenceFailure.repository.get(evidenceFailure.definition.id, true)).toEqual(evidenceFailure.definition);

    const casFailure = createHarness();
    const store = {
      get: casFailure.repository.get.bind(casFailure.repository),
      commitMcpActivation: () => false,
      isMcpActivationCommitted: () => false,
      rollbackMcpActivation: () => false,
    };
    const second = await service(casFailure, { store }).activate(casFailure.request);
    expect(second).toMatchObject({ ok: false, code: 'persistence_failed', compensated: true, recoveryPending: false });
    expect(casFailure.installer.readInstalledRecord(casFailure.installationId)).toEqual(casFailure.staticRecord);
    expect(casFailure.repository.get(casFailure.definition.id, true)).toEqual(casFailure.definition);
    expect(casFailure.repository.listEvidenceEnvelopes('session-activation')).toEqual([]);
  });

  it('recovers a crash after probe by rolling back the file record before any later activation', async () => {
    const harness = createHarness();
    const faultInjector = {
      shouldCrash: (point: McpActivationCrashPoint) => point === 'after_probe_before_journal',
    };
    await expect(service(harness, { faultInjector }).activate(harness.request))
      .rejects.toBeInstanceOf(McpActivationCrashSimulation);
    expect(harness.installer.readInstalledRecord(harness.installationId)).toMatchObject({ enabled: true, state: 'enabled' });
    expect(harness.repository.get(harness.definition.id, true)).toEqual(harness.definition);

    const recovery = await service(harness).recoverPending();
    expect(recovery).toEqual({ ok: true, recovered: 1, completed: 0 });
    expect(harness.installer.readInstalledRecord(harness.installationId)).toEqual(harness.staticRecord);
    expect(harness.repository.get(harness.definition.id, true)).toEqual(harness.definition);
    expect(fs.readdirSync(path.join(harness.root, 'mcp', '.activation-journal'))).toEqual([]);

    const resumed = await service(harness).activate(harness.request);
    expect(resumed).toMatchObject({ ok: true, definition: { enabled: true, revision: 2 } });
  });

  it('recognizes an atomic DB commit after restart and completes the durable journal without replaying', async () => {
    const harness = createHarness();
    const faultInjector = {
      shouldCrash: (point: McpActivationCrashPoint) => point === 'after_persistence_before_journal',
    };
    await expect(service(harness, { faultInjector }).activate(harness.request))
      .rejects.toBeInstanceOf(McpActivationCrashSimulation);
    expect(harness.repository.get(harness.definition.id, true)).toMatchObject({ enabled: true, revision: 2 });
    expect(harness.repository.listEvidenceEnvelopes('session-activation')).toHaveLength(1);

    const recovery = await service(harness).recoverPending();
    expect(recovery).toEqual({ ok: true, recovered: 0, completed: 1 });
    expect(harness.installer.getLaunchDescriptor(harness.installationId)).not.toBeNull();
    expect(harness.repository.get(harness.definition.id, true)).toMatchObject({ enabled: true, revision: 2 });
    expect(harness.repository.listEvidenceEnvelopes('session-activation')).toHaveLength(1);
    expect(fs.readdirSync(path.join(harness.root, 'mcp', '.activation-journal'))).toEqual([]);
  });

  it('atomically reverses the DB commit if restart finds the enabled file record was lost', async () => {
    const harness = createHarness();
    const snapshot = harness.installer.captureProbeRollback(harness.installationId);
    if (!snapshot) throw new Error('Missing pre-crash snapshot');
    const faultInjector = {
      shouldCrash: (point: McpActivationCrashPoint) => point === 'after_persistence_before_journal',
    };
    await expect(service(harness, { faultInjector }).activate(harness.request)).rejects.toThrow(McpActivationCrashSimulation);
    const enabled = harness.installer.readInstalledRecord(harness.installationId);
    if (!enabled) throw new Error('Missing enabled record');
    expect(harness.installer.rollbackEnabledProbe(snapshot, enabled)).toBe(true);

    const recovery = await service(harness).recoverPending();
    expect(recovery).toEqual({ ok: true, recovered: 1, completed: 0 });
    expect(harness.repository.get(harness.definition.id, true)).toEqual(harness.definition);
    expect(harness.repository.listEvidenceEnvelopes('session-activation')).toEqual([]);
    expect(harness.repository.listVersions(harness.definition.id).map((version) => version.revision)).toEqual([1]);
  });

  it.each([
    ['after_prepared_before_probe', { recovered: 0, completed: 1, enabledBeforeRecovery: false, dbCommitted: false }],
    ['after_installation_journal_before_persistence', { recovered: 1, completed: 0, enabledBeforeRecovery: true, dbCommitted: false }],
    ['after_persistence_journal_before_cleanup', { recovered: 0, completed: 1, enabledBeforeRecovery: true, dbCommitted: true }],
  ] as const)('recovers the durable stage crash point %s', async (point, expected) => {
    const harness = createHarness();
    const faultInjector = { shouldCrash: (candidate: McpActivationCrashPoint) => candidate === point };
    await expect(service(harness, { faultInjector }).activate(harness.request))
      .rejects.toBeInstanceOf(McpActivationCrashSimulation);
    expect(harness.installer.readInstalledRecord(harness.installationId)?.enabled).toBe(expected.enabledBeforeRecovery);
    expect(harness.repository.get(harness.definition.id, true)?.enabled).toBe(expected.dbCommitted);

    const recovery = await service(harness).recoverPending();
    expect(recovery).toEqual({ ok: true, recovered: expected.recovered, completed: expected.completed });
    expect(harness.installer.readInstalledRecord(harness.installationId)?.enabled).toBe(expected.dbCommitted);
    expect(harness.repository.get(harness.definition.id, true)?.enabled).toBe(expected.dbCommitted);
    expect(fs.readdirSync(path.join(harness.root, 'mcp', '.activation-journal'))).toEqual([]);
  });

  it('never persists resolved secret plaintext in the crash-recovery journal or response', async () => {
    const secret = 'activation-secret-8c4f2d9a';
    const harness = createHarness(secret);
    const faultInjector = {
      shouldCrash: (point: McpActivationCrashPoint) => point === 'after_installation_journal_before_persistence',
    };
    await expect(service(harness, { faultInjector }).activate(harness.request))
      .rejects.toBeInstanceOf(McpActivationCrashSimulation);
    const journalRoot = path.join(harness.root, 'mcp', '.activation-journal');
    const journalFiles = fs.readdirSync(journalRoot);
    expect(journalFiles).toHaveLength(1);
    const rawJournal = fs.readFileSync(path.join(journalRoot, journalFiles[0]!), 'utf8');
    expect(rawJournal).not.toContain(secret);
    expect(await service(harness).recoverPending()).toEqual({ ok: true, recovered: 1, completed: 0 });
  });

  it('blocks all new activation work when a restart journal is corrupt', async () => {
    const harness = createHarness();
    const activation = service(harness);
    const journalRoot = path.join(harness.root, 'mcp', '.activation-journal');
    fs.writeFileSync(
      path.join(journalRoot, 'activation-00000000-0000-4000-8000-000000000999.json'),
      '{"forged":true}',
      { encoding: 'utf8', mode: 0o600 },
    );
    const probe = vi.spyOn(harness.runner, 'probe');

    const result = await activation.activate(harness.request);
    expect(result).toMatchObject({ ok: false, code: 'recovery_failed', recoveryPending: true });
    expect(probe).not.toHaveBeenCalled();
    expect(harness.repository.get(harness.definition.id, true)).toEqual(harness.definition);
    expect(harness.installer.readInstalledRecord(harness.installationId)).toEqual(harness.staticRecord);
  });

  it('removes only recognized orphaned atomic-write temp files during restart recovery', async () => {
    const harness = createHarness();
    const activation = service(harness);
    const journalRoot = path.join(harness.root, 'mcp', '.activation-journal');
    const tempName = '.activation-00000000-0000-4000-8000-000000000555-00000000-0000-4000-8000-000000000556.tmp';
    fs.writeFileSync(path.join(journalRoot, tempName), 'incomplete', { encoding: 'utf8', mode: 0o600 });
    await expect(activation.recoverPending()).resolves.toEqual({ ok: true, recovered: 0, completed: 0 });
    expect(fs.readdirSync(journalRoot)).toEqual([]);
  });
});
