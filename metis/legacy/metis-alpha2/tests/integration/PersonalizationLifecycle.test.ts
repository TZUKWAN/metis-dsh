import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { LookupAddress, LookupAllOptions, LookupOneOptions, LookupOptions } from 'node:dns';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import type {
  AgentRunRequest,
  NormalizedResponse,
  StreamChunk,
  ToolSpec,
} from '../../engine/core/types.js';
import { ApprovalStore, WRITE_APPROVAL_RULE } from '../../engine/hitl/HITLCore.js';
import { MCPClient } from '../../engine/mcp/MCPClient.js';
import { ExactEnvironmentStdioTransport } from '../../engine/mcp/ExactEnvironmentStdioTransport.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import { BaseProvider } from '../../engine/providers/BaseProvider.js';
import type { McpPackageManifest } from '../../engine/runtime/McpInstallationContract.js';
import type {
  MetisRulesDefinition,
  PersonalizationDefinition,
  ScenarioDefinition,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import type { SkillPackageManifest } from '../../engine/runtime/SkillInstallationContract.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { EvidenceEnvelopeService } from '../../electron/EvidenceEnvelopeService.js';
import { GeneratedMcpActivationCoordinator } from '../../electron/GeneratedMcpActivationCoordinator.js';
import { McpBuilderService } from '../../electron/McpBuilderService.js';
import { PersonalizationMcpActivationService } from '../../electron/PersonalizationMcpActivationService.js';
import { PersonalizationBundleRepositorySink } from '../../electron/PersonalizationBundleRepositorySink.js';
import {
  PersonalizationBundleService,
  type PersonalizationBundleAssetSource,
} from '../../electron/PersonalizationBundleService.js';
import {
  FilesystemMcpInstallationCompensator,
  PersonalizationExtensionService,
} from '../../electron/PersonalizationExtensionService.js';
import {
  PersonalizationMcpInstaller,
  type McpControlledProbeRequest,
  type McpControlledProbeRunner,
  type McpDownloadedResource,
  type McpNetworkClient,
} from '../../electron/PersonalizationMcpInstaller.js';
import { PersonalizationRuntimeService } from '../../electron/PersonalizationRuntimeService.js';
import { PersonalizationSkillInstaller } from '../../electron/PersonalizationSkillInstaller.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/personalization/', import.meta.url));
const FIXED_TIME = 1_800_000_000_000;
const INTEGRITY_SECRET = Buffer.from('integration-manifest-secret-32-bytes-minimum');
const EVIDENCE_SECRET = Buffer.from('integration-evidence-secret-32-bytes-minimum');
const FILE_CAPABILITY_ID = `fc_${'a'.repeat(32)}`;
const ECHO_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

const roots: string[] = [];
const databases: Database.Database[] = [];

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createRepositoryHarness(prefix: string) {
  const root = temporaryRoot(prefix);
  const db = new Database(':memory:');
  databases.push(db);
  const repository = new PersonalizationRepository(db, INTEGRITY_SECRET);
  repository.seedBuiltins(buildBuiltinPersonalizationDefinitions());
  const runtime = new PersonalizationRuntimeService(repository, INTEGRITY_SECRET);
  return { root, repository, runtime };
}

function expectSaved(result: ReturnType<PersonalizationRuntimeService['save']>): PersonalizationDefinition {
  expect(result).toMatchObject({ ok: true, code: 'saved' });
  if (!result.ok || result.code !== 'saved') throw new Error(`Definition save failed: ${result.code}`);
  return result.definition;
}

function forkGeneralScenario(runtime: PersonalizationRuntimeService, targetId: string): ScenarioDefinition {
  const result = runtime.fork({
    contractVersion: 1,
    sourceId: 'builtin:scenarios/general-research',
    targetId,
    author: 'Integration test',
  });
  const definition = expectSaved(result);
  if (definition.kind !== 'scenario') throw new Error('Forked fixture is not a scenario');
  return definition;
}

function userProvenance() {
  return {
    origin: 'user' as const,
    author: 'Integration test',
    version: '1.0.0',
    license: 'Apache-2.0',
    sourceUrl: null,
    sourceRevision: null,
    installedDigest: null,
    parentId: null,
    parentVersion: null,
    locallyModified: true,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  };
}

function ruleDefinition(input: {
  id: string;
  scope: 'scenario' | 'project';
  scopeId: string;
  markdown: string;
}): MetisRulesDefinition {
  return {
    contractVersion: 1,
    id: input.id,
    kind: 'rules',
    name: `${input.scope} Metis.md`,
    description: `Integration ${input.scope} rule fixture.`,
    enabled: true,
    tags: ['integration', 'metis-md'],
    revision: 1,
    provenance: userProvenance(),
    scope: input.scope,
    scopeId: input.scopeId,
    markdown: input.markdown,
  };
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

function buildSkillArchive(input: {
  id: string;
  sourceDirectory: string;
  relativePaths: string[];
}): { archive: Buffer; manifest: SkillPackageManifest; files: Map<string, Buffer> } {
  const files = new Map(input.relativePaths.map((relativePath) => [
    relativePath,
    fs.readFileSync(path.join(input.sourceDirectory, ...relativePath.split('/'))),
  ]));
  const manifest: SkillPackageManifest = {
    schemaVersion: 1,
    id: input.id,
    name: input.id.includes('url:') ? 'URL triangulation' : 'Packaged evidence synthesis',
    description: 'A deterministic on-disk integration fixture.',
    version: '1.0.0',
    author: 'Integration fixture',
    license: 'Apache-2.0',
    entry: 'SKILL.md',
    systemPromptFile: 'SKILL.md',
    files: [...files.entries()].map(([relativePath, bytes]) => ({
      path: relativePath,
      size: bytes.length,
      sha256: sha256(bytes),
      role: relativePath.endsWith('.json') ? 'schema' as const : 'documentation' as const,
      executable: false,
    })),
  };
  return {
    archive: createStoredZip([
      { name: 'metis-skill.json', data: Buffer.from(JSON.stringify(manifest), 'utf8') },
      ...[...files.entries()].map(([name, data]) => ({ name, data })),
    ]),
    manifest,
    files,
  };
}

function publicFixtureLookup(hostname: string, family: number): Promise<LookupAddress>;
function publicFixtureLookup(hostname: string, options: LookupOneOptions): Promise<LookupAddress>;
function publicFixtureLookup(hostname: string, options: LookupAllOptions): Promise<LookupAddress[]>;
function publicFixtureLookup(
  hostname: string,
  options: LookupOptions,
): Promise<LookupAddress | LookupAddress[]>;
function publicFixtureLookup(hostname: string): Promise<LookupAddress>;
function publicFixtureLookup(
  hostname: string,
  options?: number | LookupOptions,
): Promise<LookupAddress | LookupAddress[]> {
  void hostname;
  const address: LookupAddress = { address: '93.184.216.34', family: 4 };
  return Promise.resolve(typeof options === 'object' && options.all ? [address] : address);
}

class FixtureMcpNetwork implements McpNetworkClient {
  readonly #resources = new Map<string, McpDownloadedResource>();
  readonly calls: string[] = [];

  set(url: string, body: Uint8Array | string, contentType = 'application/octet-stream'): void {
    this.#resources.set(url, {
      finalUrl: url,
      body: typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body),
      contentType,
    });
  }

  async download(url: string, maxBytes: number): Promise<McpDownloadedResource> {
    this.calls.push(url);
    const resource = this.#resources.get(url);
    if (!resource || resource.body.byteLength > maxBytes) throw new Error('download_failed');
    return { ...resource, body: Buffer.from(resource.body) };
  }
}

class RealGeneratedServerProbe implements McpControlledProbeRunner {
  calls = 0;

  async probe(request: McpControlledProbeRequest): Promise<unknown> {
    this.calls += 1;
    expect(request.shell).toBe(false);
    expect(request.inheritParentEnvironment).toBe(false);
    const client = new MCPClient(
      {
        name: 'personalization-integration-probe',
        command: [request.command, ...request.args],
        env: { ...request.fixedEnvironment },
      },
      new ExactEnvironmentStdioTransport(request.workingDirectory),
    );
    try {
      await client.connect(request.timeoutMs);
      const tools = await client.listTools();
      expect(await client.callTool('echo_text', { text: 'real-stdio-probe' })).toBe('"real-stdio-probe"');
      return { ok: true, protocolVersion: '2025-06-18', tools };
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

interface ExtensionHarness {
  evidence: EvidenceEnvelopeService;
  extension: PersonalizationExtensionService;
  generatedActivation: GeneratedMcpActivationCoordinator;
  skillInstaller: PersonalizationSkillInstaller;
  skillDownloads: Map<string, Buffer>;
  mcpInstaller: PersonalizationMcpInstaller;
  mcpNetwork: FixtureMcpNetwork;
  mcpRoot: string;
  probe: RealGeneratedServerProbe;
  builderRequests: Array<{ requirement: string; requestedPackageId: string }>;
}

function createExtensionHarness(
  root: string,
  repository: PersonalizationRepository,
): ExtensionHarness {
  const skillDownloads = new Map<string, Buffer>();
  const fixtureFetch: typeof fetch = async (input) => {
    const archive = skillDownloads.get(String(input));
    if (!archive) return new Response(null, { status: 404 });
    return new Response(Uint8Array.from(archive), {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-length': String(archive.length),
      },
    });
  };
  const skillInstaller = new PersonalizationSkillInstaller(path.join(root, 'skill-store'), {
    fetch: fixtureFetch,
    lookup: publicFixtureLookup,
    now: () => FIXED_TIME,
  });
  const mcpNetwork = new FixtureMcpNetwork();
  const mcpRoot = path.join(root, 'mcp-store');
  const mcpInstaller = new PersonalizationMcpInstaller(mcpRoot, {
    network: mcpNetwork,
    now: () => FIXED_TIME,
    runtimeExecutable: process.execPath,
  });
  const probe = new RealGeneratedServerProbe();
  const builderRequests: Array<{ requirement: string; requestedPackageId: string }> = [];
  const builder = new McpBuilderService(mcpInstaller, {
    createSpecification: async ({ requirement, requestedPackageId }) => {
      builderRequests.push({ requirement, requestedPackageId });
      return {
        contractVersion: 1,
        packageId: requestedPackageId,
        version: '1.0.0',
        name: 'Generated integration echo',
        description: 'A bounded generated MCP exercised through a real stdio probe.',
        environment: [{
          name: 'SERVICE_TOKEN',
          secretRef: '${secret:SERVICE_TOKEN}',
          required: true,
          description: 'Resolved only from the local secret vault at launch time.',
        }],
        tools: [{
          name: 'echo_text',
          description: 'Echo a validated text argument.',
          inputSchema: ECHO_SCHEMA,
          implementation: { kind: 'echo', argument: 'text' },
        }],
      };
    },
  });
  const evidence = new EvidenceEnvelopeService(EVIDENCE_SECRET);
  const extension = new PersonalizationExtensionService({
    definitions: repository,
    evidence,
    skills: skillInstaller,
    mcp: mcpInstaller,
    mcpBuilder: builder,
    mcpCompensator: new FilesystemMcpInstallationCompensator(mcpRoot),
    mcpProbeRunner: probe,
    now: () => FIXED_TIME,
  });
  const activation = new PersonalizationMcpActivationService(mcpRoot, {
    installer: mcpInstaller,
    runner: probe,
    store: repository,
    evidence,
    now: () => FIXED_TIME,
  });
  const generatedActivation = new GeneratedMcpActivationCoordinator(mcpRoot, {
    installer: mcpInstaller,
    store: repository,
    activator: activation,
  });
  return {
    evidence,
    extension,
    generatedActivation,
    skillInstaller,
    skillDownloads,
    mcpInstaller,
    mcpNetwork,
    mcpRoot,
    probe,
    builderRequests,
  };
}

function evidenceContext(runManifestDigest: string, operationId = randomUUID()) {
  return {
    sessionId: 'extension-session',
    projectId: 'project-alpha',
    operationId,
    runManifestDigest,
    observedAt: FIXED_TIME,
  };
}

function configureUrlMcp(network: FixtureMcpNetwork): {
  manifestUrl: string;
  manifestBytes: Buffer;
  serverBytes: Buffer;
} {
  const manifestUrl = 'https://packages.example.org/personalization/manifest.json';
  const serverUrl = 'https://packages.example.org/personalization/server.mjs';
  const serverBytes = fs.readFileSync(path.join(FIXTURE_ROOT, 'url-mcp', 'server.mjs'));
  const manifest: McpPackageManifest = {
    format: 'metis-mcp-package',
    contractVersion: 1,
    packageId: 'fixture-url-mcp',
    version: '1.0.0',
    name: 'Fixture URL MCP',
    description: 'A deterministic URL package transported from local fixture bytes.',
    transport: 'stdio',
    runtime: 'node',
    entry: 'server.mjs',
    args: [],
    environment: [],
    tools: [{
      name: 'fixture_lookup',
      description: 'Return a deterministic fixture value.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
        additionalProperties: false,
      },
    }],
    files: [{
      path: 'server.mjs',
      url: serverUrl,
      sha256: sha256(serverBytes),
      size: serverBytes.length,
    }],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  network.set(manifestUrl, manifestBytes, 'application/json');
  network.set(serverUrl, serverBytes, 'application/javascript');
  return { manifestUrl, manifestBytes, serverBytes };
}

interface ProvisionedModes {
  markdown: Extract<Awaited<ReturnType<PersonalizationExtensionService['apply']>>, { ok: true }>;
  packaged: Extract<Awaited<ReturnType<PersonalizationExtensionService['apply']>>, { ok: true }>;
  urlSkill: Extract<Awaited<ReturnType<PersonalizationExtensionService['apply']>>, { ok: true }>;
  generatedMcp: Extract<Awaited<ReturnType<PersonalizationExtensionService['apply']>>, { ok: true }>;
  urlMcp: Extract<Awaited<ReturnType<PersonalizationExtensionService['apply']>>, { ok: true }>;
  zipPath: string;
  urlMcpServerBytes: Buffer;
}

async function provisionAllModes(
  harness: ReturnType<typeof createRepositoryHarness>,
  extensions: ExtensionHarness,
  manifestDigest: string,
): Promise<ProvisionedModes> {
  const markdownRaw = await extensions.extension.apply({
    contractVersion: 1,
    mode: 'skill_markdown',
    id: 'user:skills/integration-markdown',
    name: 'Integration Markdown skill',
    description: 'Authored directly as Markdown.',
    author: 'Integration test',
    version: '1.0.0',
    markdown: '# Direct Markdown\n\nKeep every claim traceable.',
    toolIds: [],
    mcpIds: [],
    tags: ['integration'],
    maxTurns: 8,
    inputSchema: null,
    outputSchema: null,
    expectedRevision: 0,
    evidenceContext: evidenceContext(manifestDigest),
  });
  if (!markdownRaw.ok) throw new Error(`Markdown mode failed: ${markdownRaw.code}/${markdownRaw.detailCode}`);

  const packagedFixture = buildSkillArchive({
    id: 'user:skills/integration-package',
    sourceDirectory: path.join(FIXTURE_ROOT, 'package-skill'),
    relativePaths: ['SKILL.md', 'references/input.schema.json'],
  });
  const zipPath = path.join(harness.root, 'selected-skill.zip');
  fs.writeFileSync(zipPath, packagedFixture.archive);
  const packagedRaw = await extensions.extension.apply({
    contractVersion: 1,
    mode: 'skill_package',
    sourceCapabilityId: FILE_CAPABILITY_ID,
    expectedId: null,
    expectedRevision: 0,
    evidenceContext: evidenceContext(manifestDigest),
  }, {
    resolveLocalSkillSource: (capabilityId) => capabilityId === FILE_CAPABILITY_ID ? zipPath : undefined,
  });
  if (!packagedRaw.ok) throw new Error(`Package mode failed: ${packagedRaw.code}/${packagedRaw.detailCode}`);

  const urlFixture = buildSkillArchive({
    id: 'url:skills/integration-url',
    sourceDirectory: path.join(FIXTURE_ROOT, 'url-skill'),
    relativePaths: ['SKILL.md'],
  });
  const skillUrl = 'https://skills.example.org/integration-skill.zip';
  extensions.skillDownloads.set(skillUrl, urlFixture.archive);
  const urlSkillRaw = await extensions.extension.apply({
    contractVersion: 1,
    mode: 'skill_url',
    url: skillUrl,
    expectedArchiveSha256: sha256(urlFixture.archive),
    expectedId: null,
    expectedVersion: urlFixture.manifest.version,
    expectedRevision: 0,
    evidenceContext: evidenceContext(manifestDigest),
  });
  if (!urlSkillRaw.ok) throw new Error(`URL skill mode failed: ${urlSkillRaw.code}/${urlSkillRaw.detailCode}`);

  const builderOperationId = randomUUID();
  const generatedRequest = {
    contractVersion: 1,
    mode: 'mcp_requirements',
    operationId: builderOperationId,
    requirement: 'Build a bounded echo tool and verify it through the controlled stdio probe.',
    requestedPackageId: 'integration-generated-echo',
    definitionId: 'generated:mcp/integration-generated-echo',
    expectedRevision: 0,
    evidenceContext: evidenceContext(manifestDigest, builderOperationId),
    runProbe: true,
  } as const;
  const preparedGenerated = await extensions.extension.prepareGeneratedMcp(generatedRequest);
  if (!preparedGenerated.ok) {
    throw new Error(
      `Requirements MCP preparation failed: ${preparedGenerated.response.code}/${preparedGenerated.response.detailCode}`,
    );
  }
  const activatedGenerated = await extensions.generatedActivation.activate({
    operationId: builderOperationId,
    expectedRevision: 0,
    pendingDefinition: preparedGenerated.definition,
    installation: preparedGenerated.installation,
    evidenceContext: {
      ...generatedRequest.evidenceContext,
      owner: { webContentsId: 71, processId: 73, routingId: 0, generation: 1 },
    },
  });
  if (!activatedGenerated.ok) {
    throw new Error(`Requirements MCP activation failed: ${activatedGenerated.code}`);
  }
  const generatedMcpRaw = {
    ok: true as const,
    mode: 'mcp_requirements' as const,
    definition: activatedGenerated.definition,
    evidence: activatedGenerated.evidence,
    skillInstallation: null,
    mcpInstallation: activatedGenerated.installation,
  };

  const urlMcpFixture = configureUrlMcp(extensions.mcpNetwork);
  const urlMcpRaw = await extensions.extension.apply({
    contractVersion: 1,
    mode: 'mcp_url',
    definitionId: 'url:mcp/integration-fixture',
    manifestUrl: urlMcpFixture.manifestUrl,
    expectedManifestSha256: sha256(urlMcpFixture.manifestBytes),
    expectedRevision: 0,
    evidenceContext: evidenceContext(manifestDigest),
  });
  if (!urlMcpRaw.ok) throw new Error(`URL MCP mode failed: ${urlMcpRaw.code}/${urlMcpRaw.detailCode}`);

  return {
    markdown: markdownRaw,
    packaged: packagedRaw,
    urlSkill: urlSkillRaw,
    generatedMcp: generatedMcpRaw,
    urlMcp: urlMcpRaw,
    zipPath,
    urlMcpServerBytes: urlMcpFixture.serverBytes,
  };
}

class SequenceProvider extends BaseProvider {
  #index = 0;

  constructor(readonly responses: readonly NormalizedResponse[]) {
    super();
  }

  capabilities() {
    return {
      providerType: 'personalization-integration',
      model: 'deterministic-sequence',
      nativeToolCalling: true,
      jsonSchemaOutput: false,
      streaming: false,
      thinking: false,
      maxContextTokens: 32_000,
      maxOutputTokens: 2_000,
      retryableStatusCodes: [],
    };
  }

  async complete(): Promise<NormalizedResponse> {
    const response = this.responses[Math.min(this.#index, this.responses.length - 1)];
    this.#index += 1;
    if (!response) throw new Error('Deterministic provider response is missing');
    return response;
  }

  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> {}
}

function response(content: string, toolCalls: NormalizedResponse['toolCalls'] = []): NormalizedResponse {
  return {
    content,
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('personalization cross-layer lifecycle', () => {
  it('forks and edits a factory scenario, orders Metis.md layers, and freezes the active run snapshot', () => {
    const { repository, runtime } = createRepositoryHarness('metis-personalization-authoring-');
    const scenarioId = 'user:scenarios/editable-general-research';
    const scenarioRule = ruleDefinition({
      id: 'user:rules/scenario-general-research',
      scope: 'scenario',
      scopeId: scenarioId,
      markdown: '# Scenario Metis.md\n\nSCENARIO_RULE_V1',
    });
    const projectRule = ruleDefinition({
      id: 'user:rules/project-alpha',
      scope: 'project',
      scopeId: 'user:projects/project-alpha',
      markdown: '# Project Metis.md\n\nPROJECT_RULE_V1',
    });
    expectSaved(runtime.save({ contractVersion: 1, definition: scenarioRule, expectedRevision: 0 }));
    expectSaved(runtime.save({ contractVersion: 1, definition: projectRule, expectedRevision: 0 }));

    const fork = forkGeneralScenario(runtime, scenarioId);
    const edited = expectSaved(runtime.save({
      contractVersion: 1,
      expectedRevision: fork.revision,
      definition: {
        ...fork,
        name: 'Editable integration research',
        description: 'A copied preset whose workflow and scenario rules are user editable.',
        rulesIds: [...new Set([...fork.rulesIds, scenarioRule.id])],
        workflow: fork.workflow.map((step, index) => index === 0
          ? { ...step, name: 'Edited research step', toolIds: [...new Set([...step.toolIds, 'write_file'])] }
          : step),
        revision: fork.revision + 1,
        provenance: { ...fork.provenance, updatedAt: FIXED_TIME + 1 },
      },
    }));
    if (edited.kind !== 'scenario') throw new Error('Edited definition is not a scenario');

    const factory = repository.get('builtin:scenarios/general-research');
    expect(factory).toMatchObject({
      id: 'builtin:scenarios/general-research',
      name: 'General research',
      revision: 1,
      provenance: { origin: 'builtin', locallyModified: false },
    });
    expect(edited).toMatchObject({
      id: scenarioId,
      name: 'Editable integration research',
      revision: 2,
      provenance: {
        origin: 'user',
        parentId: 'builtin:scenarios/general-research',
        locallyModified: true,
      },
    });

    const request = {
      contractVersion: 1,
      sessionId: 'frozen-session',
      projectId: 'project-alpha',
      scenarioId,
      projectRulesId: projectRule.id,
    } as const;
    const initial = runtime.resolveForAgent(request);
    expect(initial?.ok).toBe(true);
    if (!initial?.ok) throw new Error('Initial scenario resolution failed');
    const ruleLayers = initial.manifest.promptStack.filter((layer) => layer.sourceKind === 'rules');
    expect(ruleLayers.map(({ sourceId, precedence }) => ({ sourceId, precedence }))).toEqual([
      { sourceId: 'builtin:rules/global', precedence: 300 },
      { sourceId: scenarioRule.id, precedence: 400 },
      { sourceId: projectRule.id, precedence: 500 },
    ]);
    expect(initial.systemPrompt.indexOf('builtin:rules/global'))
      .toBeLessThan(initial.systemPrompt.indexOf(scenarioRule.id));
    expect(initial.systemPrompt.indexOf(scenarioRule.id))
      .toBeLessThan(initial.systemPrompt.indexOf(projectRule.id));
    expect(initial.manifest).toMatchObject({
      scenarioRevision: 2,
      truthPolicy: 'automatic_required',
      fullAccess: { perActionConfirmation: false },
    });

    const updatedScenarioRule: MetisRulesDefinition = {
      ...scenarioRule,
      markdown: '# Scenario Metis.md\n\nSCENARIO_RULE_V2',
      revision: 2,
      provenance: { ...scenarioRule.provenance, updatedAt: FIXED_TIME + 2 },
    };
    expectSaved(runtime.save({
      contractVersion: 1,
      definition: updatedScenarioRule,
      expectedRevision: 1,
    }));
    const updatedScenario: ScenarioDefinition = {
      ...edited,
      name: 'Edited after run start',
      revision: 3,
      provenance: { ...edited.provenance, updatedAt: FIXED_TIME + 3 },
    };
    expectSaved(runtime.save({
      contractVersion: 1,
      definition: updatedScenario,
      expectedRevision: 2,
    }));

    const frozen = runtime.resolveForAgent(request);
    expect(frozen?.ok).toBe(true);
    if (!frozen?.ok) throw new Error('Frozen scenario resolution failed');
    expect(frozen.manifest.manifestDigest).toBe(initial.manifest.manifestDigest);
    expect(frozen.manifest.scenarioRevision).toBe(2);
    expect(frozen.systemPrompt).toContain('SCENARIO_RULE_V1');
    expect(frozen.systemPrompt).not.toContain('SCENARIO_RULE_V2');

    const fresh = runtime.resolveForAgent({ ...request, sessionId: 'fresh-session' });
    expect(fresh?.ok).toBe(true);
    if (!fresh?.ok) throw new Error('Fresh scenario resolution failed');
    expect(fresh.manifest.manifestDigest).not.toBe(initial.manifest.manifestDigest);
    expect(fresh.manifest.scenarioRevision).toBe(3);
    expect(fresh.systemPrompt).toContain('SCENARIO_RULE_V2');
  });

  it('runs all five extension modes on real files and round-trips a credential-free bundle', async () => {
    const harness = createRepositoryHarness('metis-personalization-modes-');
    const baseResolution = harness.runtime.resolve({
      contractVersion: 1,
      sessionId: 'extension-session',
      projectId: 'project-alpha',
      scenarioId: 'builtin:scenarios/general-research',
    });
    if (!baseResolution.ok) throw new Error('Built-in manifest fixture failed to resolve');
    const extensions = createExtensionHarness(harness.root, harness.repository);
    const provisioned = await provisionAllModes(harness, extensions, baseResolution.manifest.manifestDigest);

    expect(provisioned.markdown.definition).toMatchObject({ kind: 'skill', sourceMode: 'markdown' });
    expect(provisioned.packaged.definition).toMatchObject({ kind: 'skill', sourceMode: 'package' });
    expect(provisioned.urlSkill.definition).toMatchObject({ kind: 'skill', sourceMode: 'url' });
    expect(fs.statSync(provisioned.zipPath).isFile()).toBe(true);
    for (const skillResult of [provisioned.packaged, provisioned.urlSkill]) {
      if (!skillResult.skillInstallation) throw new Error('Installed skill provenance is missing');
      const directory = extensions.skillInstaller.resolveInstalledDirectory(
        skillResult.skillInstallation.id,
        skillResult.skillInstallation.version,
      );
      expect(directory).toBeDefined();
      expect(fs.readFileSync(path.join(directory!, 'SKILL.md'), 'utf8')).toBe(skillResult.definition.kind === 'skill'
        ? skillResult.definition.markdown
        : '');
    }

    expect(extensions.probe.calls).toBe(1);
    expect(extensions.builderRequests).toEqual([{
      requirement: 'Build a bounded echo tool and verify it through the controlled stdio probe.',
      requestedPackageId: 'integration-generated-echo',
    }]);
    expect(provisioned.generatedMcp).toMatchObject({
      definition: {
        kind: 'mcp',
        sourceMode: 'generated',
        enabled: true,
        exposedTools: ['echo_text'],
        environment: { SERVICE_TOKEN: { secret: true, value: null } },
      },
      mcpInstallation: { state: 'enabled', enabled: true },
    });
    expect(provisioned.urlMcp).toMatchObject({
      definition: { kind: 'mcp', sourceMode: 'url', enabled: false, exposedTools: [] },
      mcpInstallation: { state: 'static_verified', enabled: false },
    });
    if (!provisioned.urlMcp.mcpInstallation) throw new Error('URL MCP installation record is missing');
    const urlMcpDirectory = path.join(extensions.mcpRoot, provisioned.urlMcp.mcpInstallation.installationId);
    expect(fs.readFileSync(path.join(urlMcpDirectory, 'server.mjs'))).toEqual(provisioned.urlMcpServerBytes);
    expect(extensions.mcpInstaller.staticValidate(provisioned.urlMcp.mcpInstallation.installationId))
      .toMatchObject({ ok: true, record: { state: 'static_verified', enabled: false } });
    expect(extensions.mcpNetwork.calls).toEqual([
      'https://packages.example.org/personalization/manifest.json',
      'https://packages.example.org/personalization/server.mjs',
    ]);

    for (const result of [
      provisioned.markdown,
      provisioned.packaged,
      provisioned.urlSkill,
      provisioned.generatedMcp,
      provisioned.urlMcp,
    ]) {
      expect(extensions.evidence.verify(result.evidence)).toBe(true);
      expect(result.evidence.truth).toEqual({
        state: 'unverified',
        authority: 'metis_automatic_truth_layer',
        reviewStatus: 'pending',
        correctionState: 'unknown',
        claimEligible: false,
        publishEligible: false,
      });
    }

    if (provisioned.generatedMcp.definition.kind !== 'mcp') throw new Error('Generated MCP definition is unavailable');
    const credential = 'INTEGRATION-CREDENTIAL-MUST-NOT-EXPORT';
    const credentialInjection = harness.runtime.save({
      contractVersion: 1,
      expectedRevision: provisioned.generatedMcp.definition.revision,
      definition: {
        ...provisioned.generatedMcp.definition,
        revision: provisioned.generatedMcp.definition.revision + 1,
        environment: { SERVICE_TOKEN: { secret: true, value: credential } },
        provenance: {
          ...provisioned.generatedMcp.definition.provenance,
          locallyModified: true,
          updatedAt: FIXED_TIME + 10,
        },
      },
    });
    expect(credentialInjection).toEqual({ ok: false, code: 'invalid_request' });
    const credentialBearingMcp = provisioned.generatedMcp.definition;

    const scenario = forkGeneralScenario(harness.runtime, 'user:scenarios/portable-integration');
    const extensionDefinitions = [
      provisioned.markdown.definition,
      provisioned.packaged.definition,
      provisioned.urlSkill.definition,
    ];
    const portableScenario = expectSaved(harness.runtime.save({
      contractVersion: 1,
      expectedRevision: scenario.revision,
      definition: {
        ...scenario,
        revision: scenario.revision + 1,
        skillIds: [...new Set([...scenario.skillIds, ...extensionDefinitions.map((item) => item.id)])],
        mcpIds: [...new Set([...scenario.mcpIds, credentialBearingMcp.id, provisioned.urlMcp.definition.id])],
        workflow: scenario.workflow.map((step, index) => index === 0 ? {
          ...step,
          skillIds: [...new Set([...step.skillIds, ...extensionDefinitions.map((item) => item.id)])],
          mcpIds: [...new Set([...step.mcpIds, credentialBearingMcp.id, provisioned.urlMcp.definition.id])],
        } : step),
        provenance: { ...scenario.provenance, updatedAt: FIXED_TIME + 11 },
      },
    }));

    const assetLocations = new Map<string, { rootDirectory: string; relativePaths: string[] }>();
    for (const result of [provisioned.packaged, provisioned.urlSkill]) {
      if (!result.skillInstallation) throw new Error('Skill asset provenance is unavailable');
      const rootDirectory = extensions.skillInstaller.resolveInstalledDirectory(
        result.skillInstallation.id,
        result.skillInstallation.version,
      );
      if (!rootDirectory) throw new Error('Skill asset directory is unavailable');
      assetLocations.set(result.definition.id, { rootDirectory, relativePaths: ['SKILL.md'] });
    }
    for (const result of [provisioned.generatedMcp, provisioned.urlMcp]) {
      if (!result.mcpInstallation) throw new Error('MCP asset provenance is unavailable');
      assetLocations.set(result.definition.id, {
        rootDirectory: path.join(extensions.mcpRoot, result.mcpInstallation.installationId),
        relativePaths: ['server.mjs'],
      });
    }
    const assetSource: PersonalizationBundleAssetSource = {
      list: (ownerId) => assetLocations.get(ownerId),
    };
    const importRoot = path.join(harness.root, 'bundle-import');
    const bundles = new PersonalizationBundleService(importRoot, { now: () => FIXED_TIME + 12 });
    const exported = await bundles.exportBundle({
      rootDefinitionIds: [portableScenario.id],
      assetMode: 'include_files',
      createdBy: 'Personalization integration test',
    }, harness.repository, assetSource);
    const rawBundle = Buffer.from(exported.bytes).toString('utf8');
    expect(rawBundle).not.toContain(credential);
    const generatedBundleEntry = exported.bundle.manifest.definitions
      .find((entry) => entry.id === credentialBearingMcp.id);
    expect(generatedBundleEntry?.secretRefs).toEqual(['${secret:SERVICE_TOKEN}']);

    const targetDb = new Database(':memory:');
    databases.push(targetDb);
    const targetRepository = new PersonalizationRepository(targetDb, INTEGRITY_SECRET);
    targetRepository.seedBuiltins(buildBuiltinPersonalizationDefinitions());
    const sink = new PersonalizationBundleRepositorySink(targetRepository);
    const dryRun = await bundles.dryRunImport(exported.bytes, sink);
    expect(dryRun).toMatchObject({
      ok: true,
      plan: {
        orderedDefinitionIds: expect.arrayContaining([
          portableScenario.id,
          provisioned.markdown.definition.id,
          provisioned.packaged.definition.id,
          provisioned.urlSkill.definition.id,
          credentialBearingMcp.id,
          provisioned.urlMcp.definition.id,
        ]),
        includedAssetCount: 4,
      },
    });
    expect(targetRepository.get(portableScenario.id)).toBeUndefined();
    const imported = await bundles.importBundle(exported.bytes, sink);
    expect(imported).toMatchObject({ ok: true, plan: { includedAssetCount: 4 } });
    const importedMcp = targetRepository.get(credentialBearingMcp.id);
    expect(importedMcp?.kind === 'mcp' && importedMcp.environment.SERVICE_TOKEN?.value).toBeNull();
    expect(targetRepository.get(portableScenario.id)).toMatchObject({ kind: 'scenario', revision: 2 });
    const skillBinding = targetRepository.getAssetBinding(provisioned.packaged.definition.id);
    expect(skillBinding).toBeDefined();
    expect(fs.readFileSync(path.join(
      importRoot,
      skillBinding!.directoryToken,
      skillBinding!.relativeRoot,
      'SKILL.md',
    ), 'utf8')).toBe(provisioned.packaged.definition.kind === 'skill'
      ? provisioned.packaged.definition.markdown
      : '');
    expect(fs.readdirSync(importRoot).some((name) => name.startsWith('.staging-'))).toBe(false);
  });

  it('uses a frozen Full Access policy without per-step approval while truth authority stays automatic', async () => {
    const harness = createRepositoryHarness('metis-personalization-full-access-');
    const initial = harness.runtime.resolve({
      contractVersion: 1,
      sessionId: 'full-access-bootstrap',
      projectId: 'project-alpha',
      scenarioId: 'builtin:scenarios/general-research',
    });
    if (!initial.ok) throw new Error('Initial Full Access fixture failed to resolve');
    const extensions = createExtensionHarness(harness.root, harness.repository);
    const authored = await extensions.extension.apply({
      contractVersion: 1,
      mode: 'skill_markdown',
      id: 'user:skills/full-access-write',
      name: 'Full Access write fixture',
      description: 'Binds one validated write_file tool.',
      author: 'Integration test',
      version: '1.0.0',
      markdown: '# Full Access write\n\nWrite only the requested deterministic file.',
      toolIds: ['write_file'],
      mcpIds: [],
      tags: ['integration'],
      maxTurns: 4,
      inputSchema: null,
      outputSchema: null,
      expectedRevision: 0,
      evidenceContext: evidenceContext(initial.manifest.manifestDigest),
    });
    if (!authored.ok) throw new Error(`Full Access skill setup failed: ${authored.code}/${authored.detailCode}`);
    if (authored.definition.kind !== 'skill') throw new Error('Full Access skill setup returned a non-skill');

    const fork = forkGeneralScenario(harness.runtime, 'user:scenarios/full-access-real-write');
    const edited = expectSaved(harness.runtime.save({
      contractVersion: 1,
      expectedRevision: fork.revision,
      definition: {
        ...fork,
        revision: fork.revision + 1,
        skillIds: [...new Set([...fork.skillIds, authored.definition.id])],
        workflow: fork.workflow.map((step, index) => index === 0 ? {
          ...step,
          skillIds: [...new Set([...step.skillIds, authored.definition.id])],
          toolIds: [...new Set([...step.toolIds, 'write_file'])],
        } : step),
        provenance: { ...fork.provenance, updatedAt: FIXED_TIME + 1 },
      },
    }));
    if (edited.kind !== 'scenario') throw new Error('Full Access scenario setup failed');
    const resolved = harness.runtime.resolveForAgent({
      contractVersion: 1,
      sessionId: 'full-access-run',
      projectId: 'project-alpha',
      scenarioId: edited.id,
    });
    if (!resolved?.ok) throw new Error('Full Access scenario resolution failed');
    expect(resolved.manifest.fullAccess).toMatchObject({
      mode: 'full_access',
      perActionConfirmation: false,
      liveSteering: true,
    });
    expect(resolved.manifest.allowedTools).toContain('write_file');
    expect(resolved.manifest.truthPolicy).toBe('automatic_required');

    let approvals = 0;
    const approvalStore = new ApprovalStore();
    approvalStore.addRule(WRITE_APPROVAL_RULE);
    approvalStore.setHandler(async () => {
      approvals += 1;
      return false;
    });
    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);
    const writeSpec: ToolSpec = {
      name: 'write_file',
      description: 'Write a bounded integration file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    };
    registry.register(writeSpec);
    const outputPath = path.join(harness.root, 'full-access-result.txt');
    dispatcher.registerHandler('write_file', async (args) => {
      if (args.path !== 'full-access-result.txt' || typeof args.content !== 'string') {
        throw new Error('Unexpected integration write request');
      }
      fs.writeFileSync(outputPath, args.content, { encoding: 'utf8', flag: 'wx' });
      return 'Wrote full-access-result.txt';
    });
    const provider = new SequenceProvider([
      response('', [{
        id: 'integration-write-1',
        name: 'write_file',
        arguments: { path: 'full-access-result.txt', content: 'real local effect' },
      }]),
      response('The requested write completed; evidence remains governed by the truth layer.'),
    ]);
    const loop = new AgentLoop({ provider, registry, dispatcher, approvalStore });
    const request: AgentRunRequest = {
      messages: [
        { role: 'system', content: resolved.systemPrompt },
        { role: 'user', content: 'Write the deterministic integration result.' },
      ],
      maxTurns: resolved.manifest.maxTurns,
      sessionId: resolved.manifest.sessionId,
      allowedTools: resolved.manifest.allowedTools,
      taskContractHash: sha256('full-access-integration-task'),
      promptStackHash: resolved.manifest.manifestDigest,
      resumeFromCheckpoint: false,
      requestId: 'full-access-request',
      fullAccess: resolved.manifest.fullAccess,
    };
    const result = await loop.run(request);
    expect(result.status).toBe('completed');
    expect(approvals).toBe(0);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('real local effect');
    expect(result.traceEvents.some((event) => event.event === 'hitl.skipped_full_access')).toBe(true);
    expect(extensions.evidence.verify(authored.evidence)).toBe(true);
    expect(authored.evidence.truth).toMatchObject({
      state: 'unverified',
      authority: 'metis_automatic_truth_layer',
      publishEligible: false,
    });

    const forgedSave = harness.runtime.save({
      contractVersion: 1,
      expectedRevision: edited.revision,
      definition: {
        ...edited,
        revision: edited.revision + 1,
        verified: true,
        truthPolicy: 'user_override',
      },
    });
    expect(forgedSave).toEqual({ ok: false, code: 'invalid_request' });
    expect(harness.repository.get(edited.id)?.revision).toBe(edited.revision);
    expect(extensions.evidence.issue({
      contractVersion: 1,
      sessionId: resolved.manifest.sessionId,
      projectId: resolved.manifest.projectId,
      operationId: randomUUID(),
      runManifestDigest: resolved.manifest.manifestDigest,
      sourceDefinitionId: authored.definition.id,
      sourceDefinitionRevision: authored.definition.revision,
      sourceKind: 'skill',
      observedAt: FIXED_TIME,
      sourceUrl: null,
      locator: null,
      payload: { kind: 'text', content: 'Provider claims this is verified.' },
      truth: { state: 'verified' },
    })).toBeUndefined();
  });
});
