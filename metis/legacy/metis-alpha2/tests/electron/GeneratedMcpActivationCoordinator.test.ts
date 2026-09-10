import fs from 'node:fs';

import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { realTempRoot } from './helpers/realTempDir.mjs';
import { afterEach, describe, expect, it } from 'vitest';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import {
  McpDefinitionSchema,
  PERSONALIZATION_CONTRACT_VERSION,
  type McpDefinition,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { EvidenceEnvelopeService } from '../../electron/EvidenceEnvelopeService.js';
import {
  GeneratedMcpActivationCoordinator,
  GeneratedMcpActivationCrashSimulation,
  type GeneratedMcpActivationCrashPoint,
} from '../../electron/GeneratedMcpActivationCoordinator.js';
import { generateMcpBundle } from '../../electron/McpBuilderService.js';
import { PersonalizationMcpActivationService } from '../../electron/PersonalizationMcpActivationService.js';
import { PersonalizationMcpInstaller } from '../../electron/PersonalizationMcpInstaller.js';
import { PersonalizationMcpProbeRunner } from '../../electron/PersonalizationMcpProbeRunner.js';

const roots: string[] = [];
const databases: Database.Database[] = [];
const OWNER = { webContentsId: 41, processId: 43, routingId: 0, generation: 2 };
const INPUT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

function bundle() {
  return generateMcpBundle({
    contractVersion: 1,
    packageId: 'generated-transaction-fixture',
    version: '1.0.0',
    name: 'Generated transaction fixture',
    description: 'Crash recovery fixture for generated MCP activation.',
    environment: [],
    tools: [{
      name: 'bounded_echo',
      description: 'Return a bounded string.',
      inputSchema: INPUT_SCHEMA,
      implementation: { kind: 'echo', argument: 'text' },
    }],
  });
}

interface Harness {
  root: string;
  mcpRoot: string;
  dbPath: string;
  db: Database.Database;
  installer: PersonalizationMcpInstaller;
  repository: PersonalizationRepository;
  evidence: EvidenceEnvelopeService;
  runner: PersonalizationMcpProbeRunner;
  pendingDefinition: McpDefinition;
  input: Record<string, unknown>;
}

function createHarness(): Harness {
  const root = fs.mkdtempSync(path.join(realTempRoot(), 'metis-generated-mcp-transaction-'));
  roots.push(root);
  const mcpRoot = path.join(root, 'mcp');
  const installer = new PersonalizationMcpInstaller(mcpRoot, { now: () => 500 });
  const generated = bundle();
  const installed = installer.installGeneratedPackage(generated.manifest, generated.files);
  const validated = installer.staticValidate(installed.installationId);
  if (!validated.ok || !validated.record) throw new Error('Fixture static validation failed');

  const dbPath = path.join(root, 'personalization.db');
  const db = new Database(dbPath);
  databases.push(db);
  const repository = new PersonalizationRepository(db, randomBytes(32));
  const evidence = new EvidenceEnvelopeService(randomBytes(32));
  const runner = new PersonalizationMcpProbeRunner({ resolve: () => undefined });
  const definitionId = 'generated:mcp/transaction-fixture';
  const pendingDefinition = McpDefinitionSchema.parse({
    contractVersion: PERSONALIZATION_CONTRACT_VERSION,
    id: definitionId,
    kind: 'mcp',
    name: validated.record.packageId,
    description: `Managed MCP package ${validated.record.packageId} ${validated.record.packageVersion}`,
    enabled: false,
    tags: ['generated', 'pending-probe'],
    revision: 1,
    provenance: {
      origin: 'generated',
      author: 'Metis MCP Builder',
      version: validated.record.packageVersion,
      license: null,
      sourceUrl: null,
      sourceRevision: validated.record.installationId,
      installedDigest: validated.record.packageSha256,
      parentId: null,
      parentVersion: null,
      locallyModified: false,
      createdAt: 600,
      updatedAt: 600,
    },
    sourceMode: 'generated',
    transport: 'stdio',
    command: 'metis-managed-mcp',
    args: [validated.record.installationId],
    environment: {},
    sourceUrl: null,
    exposedTools: [],
    workingDirectoryToken: validated.record.installationId,
  });
  const operationId = randomUUID();
  return {
    root,
    mcpRoot,
    dbPath,
    db,
    installer,
    repository,
    evidence,
    runner,
    pendingDefinition,
    input: {
      operationId,
      expectedRevision: 0,
      pendingDefinition,
      installation: validated.record,
      evidenceContext: {
        sessionId: 'session-generated',
        projectId: 'project-generated',
        operationId,
        runManifestDigest: 'a'.repeat(64),
        observedAt: 700,
        owner: OWNER,
      },
    },
  };
}

function restartHarness(harness: Harness): Harness {
  harness.db.close();
  const index = databases.indexOf(harness.db);
  if (index >= 0) databases.splice(index, 1);
  const db = new Database(harness.dbPath);
  databases.push(db);
  return {
    ...harness,
    db,
    installer: new PersonalizationMcpInstaller(harness.mcpRoot, { now: () => 500 }),
    repository: new PersonalizationRepository(db, randomBytes(32)),
  };
}

function services(
  harness: Harness,
  crashPoint?: GeneratedMcpActivationCrashPoint,
): { activation: PersonalizationMcpActivationService; coordinator: GeneratedMcpActivationCoordinator } {
  const activation = new PersonalizationMcpActivationService(harness.mcpRoot, {
    installer: harness.installer,
    runner: harness.runner,
    store: harness.repository,
    evidence: harness.evidence,
    now: () => 800,
  });
  let crashed = false;
  const coordinator = new GeneratedMcpActivationCoordinator(harness.mcpRoot, {
    installer: harness.installer,
    store: harness.repository,
    activator: activation,
    ...(crashPoint ? {
      faultInjector: {
        shouldCrash: (point: GeneratedMcpActivationCrashPoint) => {
          if (crashed || point !== crashPoint) return false;
          crashed = true;
          return true;
        },
      },
    } : {}),
  });
  return { activation, coordinator };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('GeneratedMcpActivationCoordinator', () => {
  it('persists the intent before enabling and completes a real generated MCP activation', async () => {
    const harness = createHarness();
    const { coordinator } = services(harness);
    const result = await coordinator.activate(harness.input);
    expect(result).toMatchObject({
      ok: true,
      definition: { enabled: true, sourceMode: 'generated', revision: 2, exposedTools: ['bounded_echo'] },
      installation: { enabled: true, state: 'enabled', exposedTools: ['bounded_echo'] },
    });
    if (!result.ok) throw new Error(result.code);
    const evidencePayload = JSON.parse(result.evidence.payload.canonicalJson) as Record<string, unknown>;
    expect(evidencePayload).toMatchObject({ event: 'mcp_generated_activated', owner: OWNER });
    expect(harness.repository.isMcpInstallationReferenced(result.installation.installationId)).toBe(true);
    expect(harness.installer.removeUnactivatedInstallation(result.installation.installationId)).toBe(false);
    expect(await coordinator.recoverPending()).toEqual({ ok: true, recovered: 0, completed: 0 });
  });

  it.each<GeneratedMcpActivationCrashPoint>([
    'after_prepared_before_definition',
    'after_definition_before_journal',
    'after_definition_journal_before_activation',
    'after_activation_before_cleanup',
  ])('recovers deterministic state after abrupt termination at %s', async (point) => {
    const harness = createHarness();
    const first = services(harness, point).coordinator;
    await expect(first.activate(harness.input)).rejects.toBeInstanceOf(GeneratedMcpActivationCrashSimulation);

    const restartedHarness = restartHarness(harness);
    const restarted = services(restartedHarness).coordinator;
    const recovered = await restarted.recoverPending();
    expect(recovered.ok).toBe(true);
    const current = restartedHarness.repository.get(restartedHarness.pendingDefinition.id, true);
    const record = restartedHarness.installer.readInstalledRecord(
      restartedHarness.pendingDefinition.args[0]!,
    );
    if (point === 'after_prepared_before_definition') {
      expect(current).toBeUndefined();
      expect(record).toBeNull();
      const regenerated = bundle();
      expect(() => restartedHarness.installer.installGeneratedPackage(regenerated.manifest, regenerated.files)).not.toThrow();
      return;
    }
    expect(current).toMatchObject({ enabled: true, revision: 2, exposedTools: ['bounded_echo'] });
    expect(record).toMatchObject({ enabled: true, state: 'enabled', exposedTools: ['bounded_echo'] });
  });

  it('never deletes an enabled installation referenced by another definition', async () => {
    const harness = createHarness();
    const first = services(harness, 'after_prepared_before_definition').coordinator;
    await expect(first.activate(harness.input)).rejects.toBeInstanceOf(GeneratedMcpActivationCrashSimulation);
    const installationId = harness.pendingDefinition.args[0]!;
    const enabled = await harness.installer.probeAndEnable(installationId, harness.runner);
    expect(enabled.ok).toBe(true);
    if (!enabled.ok || !enabled.record) throw new Error('Fixture activation failed');
    const other = McpDefinitionSchema.parse({
      ...harness.pendingDefinition,
      id: 'generated:mcp/other-reference',
      enabled: true,
      tags: ['generated', 'probe-verified'],
      exposedTools: enabled.record.exposedTools,
    });
    expect(harness.repository.save({ contractVersion: 1, definition: other, expectedRevision: 0 }).ok).toBe(true);
    expect(harness.repository.archive(other.id, other.revision).ok).toBe(true);
    expect(harness.repository.isMcpInstallationReferenced(installationId)).toBe(true);

    const restartedHarness = restartHarness(harness);
    const restarted = services(restartedHarness).coordinator;
    expect(await restarted.recoverPending()).toMatchObject({ ok: false, code: 'recovery_failed', pending: 1 });
    expect(restartedHarness.installer.readInstalledRecord(installationId)).toMatchObject({ enabled: true, state: 'enabled' });
    expect(restartedHarness.repository.get(other.id, true)).toEqual(other);
  });

  it('rolls a failed controlled probe back completely so the same package can be retried', async () => {
    const harness = createHarness();
    const activation = new PersonalizationMcpActivationService(harness.mcpRoot, {
      installer: harness.installer,
      runner: {
        probe: async () => ({
          ok: true,
          protocolVersion: '2025-06-18',
          tools: [{ name: 'phantom_tool', description: 'Contract drift.', inputSchema: INPUT_SCHEMA }],
        }),
      },
      store: harness.repository,
      evidence: harness.evidence,
    });
    const coordinator = new GeneratedMcpActivationCoordinator(harness.mcpRoot, {
      installer: harness.installer,
      store: harness.repository,
      activator: activation,
    });
    await expect(coordinator.activate(harness.input)).resolves.toMatchObject({
      ok: false,
      code: 'probe_failed',
      compensated: true,
      recoveryPending: false,
    });
    expect(harness.repository.get(harness.pendingDefinition.id, true)).toBeUndefined();
    expect(harness.installer.readInstalledRecord(harness.pendingDefinition.args[0]!)).toBeNull();
    const regenerated = bundle();
    expect(() => harness.installer.installGeneratedPackage(regenerated.manifest, regenerated.files)).not.toThrow();
  });

  it('treats a corrupt definition row as a reference and refuses unsafe cleanup decisions', () => {
    const harness = createHarness();
    expect(harness.repository.save({
      contractVersion: 1,
      definition: harness.pendingDefinition,
      expectedRevision: 0,
    }).ok).toBe(true);
    harness.db.prepare(`
      UPDATE personalization_definitions SET current_json = '{}' WHERE id = ?
    `).run(harness.pendingDefinition.id);
    expect(harness.repository.isMcpInstallationReferenced(harness.pendingDefinition.args[0]!)).toBe(true);
  });

  it('fails closed on a tampered journal and rejects cross-definition input', async () => {
    const harness = createHarness();
    const first = services(harness, 'after_prepared_before_definition').coordinator;
    await expect(first.activate(harness.input)).rejects.toBeInstanceOf(GeneratedMcpActivationCrashSimulation);
    const journalRoot = path.join(harness.mcpRoot, '.generated-activation-journal');
    const journalPath = path.join(journalRoot, fs.readdirSync(journalRoot)[0]!);
    const raw = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(journalPath, JSON.stringify({ ...raw, attackerPath: '../outside' }));
    const restartedHarness = restartHarness(harness);
    expect(await services(restartedHarness).coordinator.recoverPending()).toMatchObject({
      ok: false, code: 'recovery_failed', pending: 1,
    });
    expect(restartedHarness.installer.readInstalledRecord(restartedHarness.pendingDefinition.args[0]!)).not.toBeNull();

    const isolated = createHarness();
    const invalid = {
      ...isolated.input,
      pendingDefinition: { ...isolated.pendingDefinition, args: ['mcp_00000000000000000000000000000000'] },
    };
    await expect(services(isolated).coordinator.activate(invalid)).resolves.toMatchObject({
      ok: false, code: 'invalid_request', compensated: false,
    });
    const pathInjection = {
      ...isolated.input,
      operationId: '../outside',
      evidenceContext: {
        ...(isolated.input.evidenceContext as Record<string, unknown>),
        operationId: '../outside',
      },
    };
    await expect(services(isolated).coordinator.activate(pathInjection)).resolves.toMatchObject({
      ok: false, code: 'invalid_request', compensated: false,
    });
  });
});
