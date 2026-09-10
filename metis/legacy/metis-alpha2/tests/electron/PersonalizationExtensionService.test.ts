import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { EvidenceEnvelopeService } from '../../electron/EvidenceEnvelopeService.js';
import { McpBuilderService, type McpBuilderProvider } from '../../electron/McpBuilderService.js';
import {
  FilesystemMcpInstallationCompensator,
  PersonalizationExtensionService,
} from '../../electron/PersonalizationExtensionService.js';
import type {
  McpBuilderPort,
  McpInstallationCompensator,
  McpInstallationPort,
  PersonalizationDefinitionSink,
  PersonalizationEvidenceSigner,
  SkillInstallationPort,
} from '../../electron/PersonalizationExtensionService.js';
import { PersonalizationSkillInstaller } from '../../electron/PersonalizationSkillInstaller.js';
import {
  McpBuilderResponseSchema,
  McpInstalledRecordSchema,
  type McpPackageManifest,
  McpUrlInstallResponseSchema,
  type McpBuilderResponse,
  type McpInstalledRecord,
  type McpUrlInstallResponse,
} from '../../engine/runtime/McpInstallationContract.js';
import {
  PERSONALIZATION_CONTRACT_VERSION,
  PersonalizationDefinitionSchema,
  type PersonalizationDefinition,
  type PersonalizationMutationResult,
  type PersonalizationSaveRequest,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import type { InstalledSkillVersion, SkillPackageManifest } from '../../engine/runtime/SkillInstallationContract.js';
import type { McpControlledProbeRunner } from '../../electron/PersonalizationMcpInstaller.js';
import { PersonalizationMcpInstaller } from '../../electron/PersonalizationMcpInstaller.js';

const roots: string[] = [];
const evidenceContext = {
  sessionId: 'session-one',
  projectId: 'project-one',
  operationId: '00000000-0000-4000-8000-000000000001',
  runManifestDigest: 'a'.repeat(64),
  observedAt: 1_000,
};

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

class MemoryDefinitionSink implements PersonalizationDefinitionSink {
  readonly definitions = new Map<string, PersonalizationDefinition>();
  fail = false;
  lie = false;

  get(id: string): PersonalizationDefinition | undefined {
    return this.definitions.get(id);
  }

  save(request: PersonalizationSaveRequest): PersonalizationMutationResult {
    if (this.fail) return { ok: false, code: 'io_error' };
    const definition = PersonalizationDefinitionSchema.parse(request.definition);
    const current = this.definitions.get(definition.id);
    if ((current?.revision ?? 0) !== request.expectedRevision || definition.revision !== request.expectedRevision + 1) {
      return { ok: false, code: 'revision_conflict', currentRevision: current?.revision ?? 0 };
    }
    this.definitions.set(definition.id, definition);
    if (this.lie) {
      return {
        ok: true,
        code: 'saved',
        definition: PersonalizationDefinitionSchema.parse({ ...definition, description: `${definition.description} forged` }),
      };
    }
    return { ok: true, code: 'saved', definition };
  }
}

class StaticSkillPort implements SkillInstallationPort {
  readonly installed: InstalledSkillVersion;
  readonly directory: string;
  rollback = true;
  uninstallCalls: Array<[string, string | undefined]> = [];

  constructor(installed: InstalledSkillVersion, directory: string) {
    this.installed = installed;
    this.directory = directory;
  }

  installFromPackage() { return { ok: true as const, installed: this.installed }; }
  async installFromUrl() { return { ok: true as const, installed: this.installed }; }
  uninstall(id: string, version?: string) {
    this.uninstallCalls.push([id, version]);
    return { ok: this.rollback };
  }
  resolveInstalledDirectory() { return this.directory; }
}

class StaticMcpPort implements McpInstallationPort {
  record: McpInstalledRecord;
  secretRefs: Readonly<Record<string, string>> = {};
  operationIdOverride: string | undefined;
  staticValidationFails = false;

  constructor(record: McpInstalledRecord) {
    this.record = record;
  }

  async installFromUrl(raw: unknown): Promise<McpUrlInstallResponse> {
    const operationId = this.operationIdOverride ?? (raw as { operationId: string }).operationId;
    return McpUrlInstallResponseSchema.parse({ ok: true, operationId, record: this.record });
  }

  installFromDirectory(): McpInstalledRecord {
    return this.record;
  }

  staticValidate() {
    if (this.staticValidationFails || this.record.enabled) {
      return { ok: false, code: 'static_validation_failed', record: this.record };
    }
    this.record = McpInstalledRecordSchema.parse({
      ...this.record,
      state: 'static_verified',
      enabled: false,
      verifiedAt: this.record.verifiedAt ?? 110,
      failureCode: null,
    });
    return { ok: true, record: this.record };
  }

  getLaunchDescriptor() {
    return this.record.enabled ? { secretRefs: this.secretRefs } : null;
  }
}

class StaticMcpBuilder implements McpBuilderPort {
  response: McpBuilderResponse;
  receivedRunner = false;

  constructor(response: McpBuilderResponse) {
    this.response = response;
  }

  async build(_raw: unknown, runner?: McpControlledProbeRunner): Promise<McpBuilderResponse> {
    this.receivedRunner = runner !== undefined;
    return this.response;
  }
}

class TrackingCompensator implements McpInstallationCompensator {
  rollback = true;
  calls: string[] = [];
  rollbackInstallation(installationId: string): boolean {
    this.calls.push(installationId);
    return this.rollback;
  }
}

function mcpRecord(state: 'downloaded' | 'static_verified' | 'enabled' = 'downloaded'): McpInstalledRecord {
  return McpInstalledRecordSchema.parse({
    installationId: `mcp_${'b'.repeat(32)}`,
    packageId: 'bounded-echo',
    packageVersion: '1.0.0',
    manifestSha256: 'c'.repeat(64),
    packageSha256: 'd'.repeat(64),
    state,
    enabled: state === 'enabled',
    installedAt: 100,
    verifiedAt: state === 'downloaded' ? null : 110,
    probedAt: state === 'enabled' ? 120 : null,
    exposedTools: state === 'enabled' ? ['bounded_echo'] : [],
    failureCode: null,
  });
}

function builderResponse(state: 'static_verified' | 'enabled'): McpBuilderResponse {
  const record = mcpRecord(state);
  return McpBuilderResponseSchema.parse({
    ok: true,
    operationId: evidenceContext.operationId,
    record,
    outcome: state === 'enabled' ? 'enabled' : 'pending_probe',
  });
}

function packageSource(root: string, id = 'user:skills/package-skill'): { source: string; manifest: SkillPackageManifest; marker: string } {
  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  const marker = path.join(root, 'script-executed.txt');
  const markdown = Buffer.from('# Package skill\n\nRetain evidence references.\n', 'utf8');
  const script = Buffer.from(`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed');\n`, 'utf8');
  fs.writeFileSync(path.join(source, 'SKILL.md'), markdown);
  fs.writeFileSync(path.join(source, 'scripts', 'unsafe-if-executed.mjs'), script);
  const manifest: SkillPackageManifest = {
    schemaVersion: 1,
    id,
    name: 'Package skill',
    description: 'A package-backed skill.',
    version: '1.0.0',
    author: 'Package author',
    license: 'Apache-2.0',
    entry: 'SKILL.md',
    systemPromptFile: 'SKILL.md',
    files: [
      { path: 'SKILL.md', size: markdown.length, sha256: sha256(markdown), role: 'documentation', executable: false },
      { path: 'scripts/unsafe-if-executed.mjs', size: script.length, sha256: sha256(script), role: 'script', executable: true },
    ],
  };
  fs.writeFileSync(path.join(source, 'metis-skill.json'), JSON.stringify(manifest));
  return { source, manifest, marker };
}

function installedUrlSkill(root: string): { installed: InstalledSkillVersion; directory: string } {
  const directory = path.join(root, 'installed-url-skill');
  fs.mkdirSync(directory, { recursive: true });
  const markdown = Buffer.from('# URL skill\n\nTreat results as unverified.\n');
  fs.writeFileSync(path.join(directory, 'SKILL.md'), markdown);
  const manifest: SkillPackageManifest = {
    schemaVersion: 1,
    id: 'url:skills/linked-skill',
    name: 'Linked skill',
    description: 'Installed through an HTTPS link.',
    version: '1.2.0',
    author: 'Remote author',
    license: null,
    entry: 'SKILL.md',
    systemPromptFile: null,
    files: [{ path: 'SKILL.md', size: markdown.length, sha256: sha256(markdown), role: 'documentation', executable: false }],
  };
  const installed: InstalledSkillVersion = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    active: true,
    packageDigest: 'e'.repeat(64),
    manifest,
    provenance: {
      sourceMode: 'url',
      sourceUrl: 'https://example.com/skill.zip',
      resolvedUrl: 'https://example.com/skill.zip',
      redirectChain: [],
      archiveSha256: 'e'.repeat(64),
      manifestSha256: 'f'.repeat(64),
      installedAt: 100,
    },
    storageKey: sha256(manifest.id),
  };
  return { installed, directory };
}

function localMcpPackageSource(root: string, packageId = 'local-bounded-echo'): { source: string; manifest: McpPackageManifest } {
  const source = path.join(root, 'local-mcp-source');
  fs.mkdirSync(source, { recursive: true });
  const entry = Buffer.from("import readline from 'node:readline';\nvoid readline;\n", 'utf8');
  const manifest: McpPackageManifest = {
    format: 'metis-mcp-package',
    contractVersion: 1,
    packageId,
    version: '1.0.0',
    name: 'Local bounded echo',
    description: 'A locally imported bounded MCP package.',
    transport: 'stdio',
    runtime: 'node',
    entry: 'server.mjs',
    args: [],
    environment: [],
    tools: [{
      name: 'echo_text',
      description: 'Return a validated text argument.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    }],
    files: [{
      path: 'server.mjs',
      url: 'https://packages.example.org/server.mjs',
      sha256: sha256(entry),
      size: entry.length,
    }],
  };
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(source, 'server.mjs'), entry);
  return { source, manifest };
}

function unusedMcpDependencies() {
  const record = mcpRecord();
  return {
    mcp: new StaticMcpPort(record),
    mcpBuilder: new StaticMcpBuilder(builderResponse('static_verified')),
    mcpCompensator: new TrackingCompensator(),
  };
}

function markdownRequest() {
  return {
    contractVersion: 1,
    mode: 'skill_markdown',
    id: 'user:skills/direct-skill',
    name: 'Direct skill',
    description: 'Written directly in the personalization center.',
    author: 'Researcher',
    version: '1.0.0',
    markdown: '# Direct skill\n\nNever invent evidence.',
    toolIds: [],
    mcpIds: [],
    tags: ['direct'],
    maxTurns: 20,
    inputSchema: null,
    outputSchema: null,
    expectedRevision: 0,
    evidenceContext,
  } as const;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('PersonalizationExtensionService Skill modes', () => {
  it('persists a directly authored Markdown skill with a signed pending/unverified envelope', async () => {
    const root = temporaryRoot('metis-extension-markdown-');
    const sink = new MemoryDefinitionSink();
    const evidence = new EvidenceEnvelopeService(randomBytes(32));
    const urlFixture = installedUrlSkill(root);
    const service = new PersonalizationExtensionService({
      definitions: sink,
      evidence,
      skills: new StaticSkillPort(urlFixture.installed, urlFixture.directory),
      ...unusedMcpDependencies(),
      now: () => 2_000,
    });
    const result = await service.apply(markdownRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition).toMatchObject({ kind: 'skill', sourceMode: 'markdown', revision: 1 });
    expect(result.evidence.truth).toEqual({
      state: 'unverified',
      authority: 'metis_automatic_truth_layer',
      reviewStatus: 'pending',
      correctionState: 'unknown',
      claimEligible: false,
      publishEligible: false,
    });
    expect(evidence.verify(result.evidence)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('verified":true');
    expect(sink.get('user:skills/direct-skill')).toEqual(result.definition);
  });

  it('uses the real package installer, preserves scripts without executing them, and does not expose an absolute path', async () => {
    const root = temporaryRoot('metis-extension-package-');
    const fixture = packageSource(root);
    const skillInstaller = new PersonalizationSkillInstaller(path.join(root, 'skill-store'));
    const sink = new MemoryDefinitionSink();
    const service = new PersonalizationExtensionService({
      definitions: sink,
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills: skillInstaller,
      ...unusedMcpDependencies(),
      now: () => 2_000,
    });
    const capabilityId = 'fc_0123456789abcdef0123456789abcdef';
    const result = await service.apply({
      contractVersion: 1,
      mode: 'skill_package',
      sourceCapabilityId: capabilityId,
      expectedId: null,
      expectedRevision: 0,
      evidenceContext,
    }, { resolveLocalSkillSource: (candidate) => candidate === capabilityId ? fixture.source : undefined });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition).toMatchObject({ id: fixture.manifest.id, kind: 'skill', sourceMode: 'package' });
    expect(result.skillInstallation?.manifest.files.some((file) => file.role === 'script')).toBe(true);
    expect(fs.existsSync(fixture.marker)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain('installDirectory');
  });

  it('never accepts a renderer-supplied path in place of a scoped FileCapability', async () => {
    const root = temporaryRoot('metis-extension-file-capability-');
    const fixture = packageSource(root, 'user:skills/capability-test');
    const installer = new PersonalizationSkillInstaller(path.join(root, 'store'));
    const service = new PersonalizationExtensionService({
      definitions: new MemoryDefinitionSink(),
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills: installer,
      ...unusedMcpDependencies(),
    });
    const request = {
      contractVersion: 1,
      mode: 'skill_package',
      sourceCapabilityId: 'fc_22222222222222222222222222222222',
      expectedId: null,
      expectedRevision: 0,
      evidenceContext,
    } as const;
    expect(await service.apply(request)).toMatchObject({ ok: false, code: 'skill_install_failed', detailCode: 'invalid_file_capability' });
    expect(await service.apply({ ...request, sourcePath: fixture.source })).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(installer.listInstalled()).toEqual([]);
  });

  it('creates and then updates a URL-installed skill with revision-bound identity', async () => {
    const root = temporaryRoot('metis-extension-url-skill-');
    const fixture = installedUrlSkill(root);
    const service = new PersonalizationExtensionService({
      definitions: new MemoryDefinitionSink(),
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills: new StaticSkillPort(fixture.installed, fixture.directory),
      ...unusedMcpDependencies(),
    });
    const result = await service.apply({
      contractVersion: PERSONALIZATION_CONTRACT_VERSION,
      mode: 'skill_url',
      url: 'https://example.com/skill.zip',
      expectedArchiveSha256: null,
      expectedId: null,
      expectedVersion: fixture.installed.version,
      expectedRevision: 0,
      evidenceContext,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition.provenance).toMatchObject({ origin: 'url', sourceUrl: 'https://example.com/skill.zip' });
      expect(result.evidence.truth.claimEligible).toBe(false);
    }
    const updated = await service.apply({
      contractVersion: PERSONALIZATION_CONTRACT_VERSION,
      mode: 'skill_url',
      url: 'https://example.com/skill.zip',
      expectedArchiveSha256: null,
      expectedId: fixture.installed.id,
      expectedVersion: fixture.installed.version,
      expectedRevision: 1,
      evidenceContext,
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.definition).toMatchObject({ id: fixture.installed.id, revision: 2 });
  });

  it('rolls a package version back when evidence or CAS persistence fails', async () => {
    const root = temporaryRoot('metis-extension-compensate-');
    const first = packageSource(root, 'user:skills/cas-failure');
    const installer = new PersonalizationSkillInstaller(path.join(root, 'store'));
    const failingSink = new MemoryDefinitionSink();
    failingSink.fail = true;
    const service = new PersonalizationExtensionService({
      definitions: failingSink,
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills: installer,
      ...unusedMcpDependencies(),
    });
    const capabilityId = 'fc_1123456789abcdef0123456789abcdef';
    const result = await service.apply({
      contractVersion: 1,
      mode: 'skill_package',
      sourceCapabilityId: capabilityId,
      expectedId: null,
      expectedRevision: 0,
      evidenceContext,
    }, { resolveLocalSkillSource: (candidate) => candidate === capabilityId ? first.source : undefined });
    expect(result).toMatchObject({ ok: false, code: 'definition_rejected', compensated: true });
    expect(installer.listInstalled()).toEqual([]);
  });

  it('rejects and compensates a package whose manifest identity differs from the selected update target', async () => {
    const root = temporaryRoot('metis-extension-package-identity-');
    const fixture = packageSource(root, 'user:skills/manifest-identity');
    const installer = new PersonalizationSkillInstaller(path.join(root, 'store'));
    const service = new PersonalizationExtensionService({
      definitions: new MemoryDefinitionSink(),
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills: installer,
      ...unusedMcpDependencies(),
    });
    const capabilityId = 'fc_3123456789abcdef0123456789abcdef';
    const result = await service.apply({
      contractVersion: 1,
      mode: 'skill_package',
      sourceCapabilityId: capabilityId,
      expectedId: 'user:skills/selected-update-target',
      expectedRevision: 4,
      evidenceContext,
    }, { resolveLocalSkillSource: (candidate) => candidate === capabilityId ? fixture.source : undefined });
    expect(result).toMatchObject({
      ok: false,
      mode: 'skill_package',
      code: 'package_identity_rejected',
      detailCode: 'local_package_identity_mismatch',
      compensated: true,
    });
    expect(installer.listInstalled()).toEqual([]);
  });

  it('reports compensation failure instead of hiding a partially installed package', async () => {
    const root = temporaryRoot('metis-extension-compensation-fail-');
    const fixture = installedUrlSkill(root);
    const skills = new StaticSkillPort(fixture.installed, fixture.directory);
    skills.rollback = false;
    const sink = new MemoryDefinitionSink();
    sink.fail = true;
    const service = new PersonalizationExtensionService({
      definitions: sink,
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills,
      ...unusedMcpDependencies(),
    });
    const result = await service.apply({
      contractVersion: 1,
      mode: 'skill_url',
      url: 'https://example.com/skill.zip',
      expectedArchiveSha256: null,
      expectedId: null,
      expectedVersion: fixture.installed.version,
      expectedRevision: 0,
      evidenceContext,
    });
    expect(result).toMatchObject({ ok: false, code: 'compensation_failed', compensated: false });
  });

  it('rejects a forged installer identity and compensates the external package', async () => {
    const root = temporaryRoot('metis-extension-identity-');
    const fixture = installedUrlSkill(root);
    const forged = { ...fixture.installed, storageKey: '9'.repeat(64) };
    const skills = new StaticSkillPort(forged, fixture.directory);
    const service = new PersonalizationExtensionService({
      definitions: new MemoryDefinitionSink(),
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills,
      ...unusedMcpDependencies(),
    });
    const result = await service.apply({
      contractVersion: 1,
      mode: 'skill_url',
      url: 'https://example.com/skill.zip',
      expectedArchiveSha256: null,
      expectedId: null,
      expectedVersion: fixture.installed.version,
      expectedRevision: 0,
      evidenceContext,
    });
    expect(result).toMatchObject({ ok: false, code: 'package_identity_rejected', compensated: true });
    expect(skills.uninstallCalls).toHaveLength(1);
  });

  it('re-hashes the selected Markdown entry before definition persistence', async () => {
    const root = temporaryRoot('metis-extension-entry-tamper-');
    const fixture = installedUrlSkill(root);
    fs.writeFileSync(path.join(fixture.directory, 'SKILL.md'), '# tampered but same trust claim');
    const skills = new StaticSkillPort(fixture.installed, fixture.directory);
    const service = new PersonalizationExtensionService({
      definitions: new MemoryDefinitionSink(),
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills,
      ...unusedMcpDependencies(),
    });
    const result = await service.apply({
      contractVersion: 1,
      mode: 'skill_url',
      url: 'https://example.com/skill.zip',
      expectedArchiveSha256: null,
      expectedId: null,
      expectedVersion: fixture.installed.version,
      expectedRevision: 0,
      evidenceContext,
    });
    expect(result).toMatchObject({ ok: false, code: 'package_content_rejected', compensated: true });
    expect(skills.uninstallCalls).toHaveLength(1);
  });
});

describe('PersonalizationExtensionService MCP modes', () => {
  it('imports a real local MCP package through a scoped capability and persists it pending activation', async () => {
    const root = temporaryRoot('metis-extension-local-mcp-');
    const local = localMcpPackageSource(root);
    const urlSkill = installedUrlSkill(root);
    const mcpStore = path.join(root, 'mcp-store');
    fs.mkdirSync(mcpStore, { recursive: true });
    const installer = new PersonalizationMcpInstaller(mcpStore, { now: () => 450 });
    const definitions = new MemoryDefinitionSink();
    const service = new PersonalizationExtensionService({
      definitions,
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills: new StaticSkillPort(urlSkill.installed, urlSkill.directory),
      mcp: installer,
      mcpBuilder: new StaticMcpBuilder(builderResponse('static_verified')),
      mcpCompensator: new FilesystemMcpInstallationCompensator(mcpStore),
      now: () => 451,
    });
    const capabilityId = 'fc_4123456789abcdef0123456789abcdef';
    const result = await service.apply({
      contractVersion: 1,
      mode: 'mcp_package',
      definitionId: 'user:mcp/local-bounded-echo',
      sourceCapabilityId: capabilityId,
      expectedRevision: 0,
      evidenceContext,
    }, { resolveLocalSkillSource: () => undefined, resolveLocalMcpSource: (candidate) => candidate === capabilityId ? local.source : undefined });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition).toMatchObject({
      id: 'user:mcp/local-bounded-echo', kind: 'mcp', sourceMode: 'package', enabled: false,
      provenance: { origin: 'user', author: 'Local MCP package', sourceUrl: null },
    });
    expect(result.mcpInstallation).toMatchObject({ packageId: local.manifest.packageId, state: 'static_verified', enabled: false });
    expect(definitions.get('user:mcp/local-bounded-echo')).toEqual(result.definition);
    expect(JSON.stringify(result)).not.toContain(local.source);
  });

  it('always persists URL-installed MCP definitions disabled', async () => {
    const root = temporaryRoot('metis-extension-mcp-url-');
    const urlSkill = installedUrlSkill(root);
    const mcp = new StaticMcpPort(mcpRecord('downloaded'));
    const service = new PersonalizationExtensionService({
      definitions: new MemoryDefinitionSink(),
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills: new StaticSkillPort(urlSkill.installed, urlSkill.directory),
      mcp,
      mcpBuilder: new StaticMcpBuilder(builderResponse('static_verified')),
      mcpCompensator: new TrackingCompensator(),
    });
    const result = await service.apply({
      contractVersion: 1,
      mode: 'mcp_url',
      definitionId: 'url:mcp/bounded-echo',
      manifestUrl: 'https://example.com/mcp/manifest.json',
      expectedManifestSha256: null,
      expectedRevision: 0,
      evidenceContext,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.definition).toMatchObject({ kind: 'mcp', enabled: false, exposedTools: [] });
      expect(result.mcpInstallation).toMatchObject({ enabled: false, state: 'static_verified', verifiedAt: 110 });
      expect(result.evidence.truth.publishEligible).toBe(false);
    }
  });

  it('rolls the URL installation back when static validation fails instead of persisting downloaded state', async () => {
    const root = temporaryRoot('metis-extension-mcp-url-static-failure-');
    const urlSkill = installedUrlSkill(root);
    const mcp = new StaticMcpPort(mcpRecord('downloaded'));
    mcp.staticValidationFails = true;
    const definitions = new MemoryDefinitionSink();
    const compensator = new TrackingCompensator();
    const service = new PersonalizationExtensionService({
      definitions,
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills: new StaticSkillPort(urlSkill.installed, urlSkill.directory),
      mcp,
      mcpBuilder: new StaticMcpBuilder(builderResponse('static_verified')),
      mcpCompensator: compensator,
    });
    const result = await service.apply({
      contractVersion: 1,
      mode: 'mcp_url',
      definitionId: 'url:mcp/static-failure',
      manifestUrl: 'https://example.com/mcp/manifest.json',
      expectedManifestSha256: null,
      expectedRevision: 0,
      evidenceContext,
    });
    expect(result).toMatchObject({ ok: false, code: 'package_content_rejected', compensated: true });
    expect(compensator.calls).toEqual([mcp.record.installationId]);
    expect(definitions.get('url:mcp/static-failure')).toBeUndefined();
  });

  it('keeps generated MCP disabled and rejects direct probing outside the transaction coordinator', async () => {
    const root = temporaryRoot('metis-extension-mcp-builder-');
    const urlSkill = installedUrlSkill(root);
    const pendingBuilder = new StaticMcpBuilder(builderResponse('static_verified'));
    const pendingService = new PersonalizationExtensionService({
      definitions: new MemoryDefinitionSink(),
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills: new StaticSkillPort(urlSkill.installed, urlSkill.directory),
      mcp: new StaticMcpPort(mcpRecord('static_verified')),
      mcpBuilder: pendingBuilder,
      mcpCompensator: new TrackingCompensator(),
    });
    const baseRequest = {
      contractVersion: 1,
      mode: 'mcp_requirements',
      operationId: evidenceContext.operationId,
      requirement: 'Build a bounded echo tool.',
      requestedPackageId: 'bounded-echo',
      definitionId: 'generated:mcp/bounded-echo',
      expectedRevision: 0,
      evidenceContext,
    } as const;
    const pending = await pendingService.apply({ ...baseRequest, runProbe: false });
    expect(pending.ok).toBe(true);
    if (pending.ok) expect(pending.definition).toMatchObject({ kind: 'mcp', enabled: false, exposedTools: [] });
    expect(pendingBuilder.receivedRunner).toBe(false);

    const enabledRecord = mcpRecord('enabled');
    const enabledMcp = new StaticMcpPort(enabledRecord);
    enabledMcp.secretRefs = { API_TOKEN: '${secret:API_TOKEN}' };
    const enabledBuilder = new StaticMcpBuilder(builderResponse('enabled'));
    const probeRunner: McpControlledProbeRunner = { probe: async () => ({ ok: false, code: 'unused-by-static-builder' }) };
    const enabledService = new PersonalizationExtensionService({
      definitions: new MemoryDefinitionSink(),
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills: new StaticSkillPort(urlSkill.installed, urlSkill.directory),
      mcp: enabledMcp,
      mcpBuilder: enabledBuilder,
      mcpCompensator: new TrackingCompensator(),
      mcpProbeRunner: probeRunner,
    });
    const enabled = await enabledService.apply({ ...baseRequest, runProbe: true });
    expect(enabled).toMatchObject({ ok: false, code: 'probe_required', compensated: false });
    expect(enabledBuilder.receivedRunner).toBe(false);
  });

  it('integrates the real MCP Builder and installer in pending-probe mode', async () => {
    const root = temporaryRoot('metis-extension-real-builder-');
    const urlSkill = installedUrlSkill(root);
    const installer = new PersonalizationMcpInstaller(path.join(root, 'mcp-store'), {
      runtimeExecutable: process.execPath,
      now: () => 500,
    });
    const provider: McpBuilderProvider = {
      createSpecification: async () => ({
        contractVersion: 1,
        packageId: 'real-bounded-echo',
        version: '1.0.0',
        name: 'Real bounded echo',
        description: 'Generated through the real bounded Builder DSL.',
        tools: [{
          name: 'echo_text',
          description: 'Return a validated text argument.',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
          implementation: { kind: 'echo', argument: 'text' },
        }],
        environment: [],
      }),
    };
    const service = new PersonalizationExtensionService({
      definitions: new MemoryDefinitionSink(),
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills: new StaticSkillPort(urlSkill.installed, urlSkill.directory),
      mcp: installer,
      mcpBuilder: new McpBuilderService(installer, provider),
      mcpCompensator: new TrackingCompensator(),
      now: () => 600,
    });
    const result = await service.apply({
      contractVersion: 1,
      mode: 'mcp_requirements',
      operationId: evidenceContext.operationId,
      requirement: 'Build a bounded echo tool.',
      requestedPackageId: 'real-bounded-echo',
      definitionId: 'generated:mcp/real-bounded-echo',
      expectedRevision: 0,
      evidenceContext,
      runProbe: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mcpInstallation).toMatchObject({ packageId: 'real-bounded-echo', state: 'static_verified', enabled: false });
      expect(result.definition).toMatchObject({ kind: 'mcp', enabled: false });
    }
  });

  it('prepares a real Builder installation without probing or persistence before the transaction journal', async () => {
    const root = temporaryRoot('metis-extension-real-probe-');
    const urlSkill = installedUrlSkill(root);
    const installer = new PersonalizationMcpInstaller(path.join(root, 'mcp-store'), { now: () => 700 });
    const inputSchema = {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    };
    const provider: McpBuilderProvider = {
      createSpecification: async ({ requestedPackageId }) => ({
        contractVersion: 1,
        packageId: requestedPackageId,
        version: '1.0.0',
        name: 'Probe verified echo',
        description: 'Enabled only after an exact controlled probe.',
        tools: [{
          name: 'echo_text',
          description: 'Return a validated text argument.',
          inputSchema,
          implementation: { kind: 'echo', argument: 'text' },
        }],
        environment: [],
      }),
    };
    let probes = 0;
    const runner: McpControlledProbeRunner = {
      probe: async (request) => {
        probes += 1;
        expect(request.shell).toBe(false);
        expect(request.inheritParentEnvironment).toBe(false);
        return {
          ok: true,
          protocolVersion: '2025-06-18',
          tools: [{ name: 'echo_text', description: 'Return a validated text argument.', inputSchema }],
        };
      },
    };
    const service = new PersonalizationExtensionService({
      definitions: new MemoryDefinitionSink(),
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills: new StaticSkillPort(urlSkill.installed, urlSkill.directory),
      mcp: installer,
      mcpBuilder: new McpBuilderService(installer, provider),
      mcpCompensator: new TrackingCompensator(),
      mcpProbeRunner: runner,
      now: () => 800,
    });
    const result = await service.prepareGeneratedMcp({
      contractVersion: 1,
      mode: 'mcp_requirements',
      operationId: evidenceContext.operationId,
      requirement: 'Build and probe a bounded echo tool.',
      requestedPackageId: 'probe-verified-echo',
      definitionId: 'generated:mcp/probe-verified-echo',
      expectedRevision: 0,
      evidenceContext,
      runProbe: true,
    });
    expect(probes).toBe(0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.installation).toMatchObject({ state: 'static_verified', enabled: false, exposedTools: [] });
      expect(result.definition).toMatchObject({ kind: 'mcp', enabled: false, exposedTools: [] });
    }
  });

  it('rolls a real Builder installation back from disk when the definition CAS fails', async () => {
    const root = temporaryRoot('metis-extension-real-rollback-');
    const urlSkill = installedUrlSkill(root);
    const mcpRoot = path.join(root, 'mcp-store');
    const installer = new PersonalizationMcpInstaller(mcpRoot, { now: () => 900 });
    const provider: McpBuilderProvider = {
      createSpecification: async ({ requestedPackageId }) => ({
        contractVersion: 1,
        packageId: requestedPackageId,
        version: '1.0.0',
        name: 'Rollback echo',
        description: 'A generated package rolled back after CAS failure.',
        tools: [{
          name: 'echo_text',
          description: 'Echo text.',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
          implementation: { kind: 'echo', argument: 'text' },
        }],
        environment: [],
      }),
    };
    const sink = new MemoryDefinitionSink();
    sink.fail = true;
    const service = new PersonalizationExtensionService({
      definitions: sink,
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills: new StaticSkillPort(urlSkill.installed, urlSkill.directory),
      mcp: installer,
      mcpBuilder: new McpBuilderService(installer, provider),
      mcpCompensator: new FilesystemMcpInstallationCompensator(mcpRoot),
    });
    const result = await service.apply({
      contractVersion: 1,
      mode: 'mcp_requirements',
      operationId: evidenceContext.operationId,
      requirement: 'Build a rollback-tested echo tool.',
      requestedPackageId: 'rollback-echo',
      definitionId: 'generated:mcp/rollback-echo',
      expectedRevision: 0,
      evidenceContext,
      runProbe: false,
    });
    expect(result).toMatchObject({ ok: false, code: 'definition_rejected', compensated: true });
    expect(fs.readdirSync(mcpRoot).filter((name) => name.startsWith('mcp_'))).toEqual([]);
  });

  it('rejects inconsistent enabled state and raw secrets, then compensates the generated installation', async () => {
    const root = temporaryRoot('metis-extension-mcp-attacks-');
    const urlSkill = installedUrlSkill(root);
    const compensator = new TrackingCompensator();
    const enabledBuilder = new StaticMcpBuilder(builderResponse('enabled'));
    const service = new PersonalizationExtensionService({
      definitions: new MemoryDefinitionSink(),
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills: new StaticSkillPort(urlSkill.installed, urlSkill.directory),
      mcp: new StaticMcpPort(mcpRecord('enabled')),
      mcpBuilder: enabledBuilder,
      mcpCompensator: compensator,
    });
    const result = await service.apply({
      contractVersion: 1,
      mode: 'mcp_requirements',
      operationId: evidenceContext.operationId,
      requirement: 'Build a bounded echo tool.',
      requestedPackageId: 'bounded-echo',
      definitionId: 'generated:mcp/bounded-echo',
      expectedRevision: 0,
      evidenceContext,
      runProbe: false,
    });
    expect(result).toMatchObject({ ok: false, code: 'mcp_builder_failed', compensated: true });
    expect(compensator.calls).toEqual([mcpRecord('enabled').installationId]);

    const secretCompensator = new TrackingCompensator();
    const secretMcp = new StaticMcpPort(mcpRecord('enabled'));
    secretMcp.secretRefs = { API_TOKEN: 'plaintext-secret' };
    const secretService = new PersonalizationExtensionService({
      definitions: new MemoryDefinitionSink(),
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills: new StaticSkillPort(urlSkill.installed, urlSkill.directory),
      mcp: secretMcp,
      mcpBuilder: new StaticMcpBuilder(builderResponse('enabled')),
      mcpCompensator: secretCompensator,
      mcpProbeRunner: { probe: async () => ({ ok: false, code: 'unused' }) },
    });
    const secretResult = await secretService.apply({
      contractVersion: 1,
      mode: 'mcp_requirements',
      operationId: evidenceContext.operationId,
      requirement: 'Build a bounded echo tool.',
      requestedPackageId: 'bounded-echo',
      definitionId: 'generated:mcp/bounded-echo',
      expectedRevision: 0,
      evidenceContext,
      runProbe: true,
    });
    expect(secretResult).toMatchObject({ ok: false, code: 'probe_required', compensated: false });
  });

  it('compensates an MCP installation when the definition sink rejects the CAS write', async () => {
    const root = temporaryRoot('metis-extension-mcp-cas-');
    const urlSkill = installedUrlSkill(root);
    const sink = new MemoryDefinitionSink();
    sink.fail = true;
    const compensator = new TrackingCompensator();
    const service = new PersonalizationExtensionService({
      definitions: sink,
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills: new StaticSkillPort(urlSkill.installed, urlSkill.directory),
      mcp: new StaticMcpPort(mcpRecord('downloaded')),
      mcpBuilder: new StaticMcpBuilder(builderResponse('static_verified')),
      mcpCompensator: compensator,
    });
    const result = await service.apply({
      contractVersion: 1,
      mode: 'mcp_url',
      definitionId: 'url:mcp/bounded-echo',
      manifestUrl: 'https://example.com/mcp/manifest.json',
      expectedManifestSha256: null,
      expectedRevision: 0,
      evidenceContext,
    });
    expect(result).toMatchObject({ ok: false, code: 'definition_rejected', compensated: true });
    expect(compensator.calls).toHaveLength(1);
  });

  it('rejects enabled URL packages and mismatched MCP operation identities', async () => {
    const root = temporaryRoot('metis-extension-mcp-identity-');
    const urlSkill = installedUrlSkill(root);
    const compensator = new TrackingCompensator();
    const enabledMcp = new StaticMcpPort(mcpRecord('enabled'));
    const enabledService = new PersonalizationExtensionService({
      definitions: new MemoryDefinitionSink(),
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills: new StaticSkillPort(urlSkill.installed, urlSkill.directory),
      mcp: enabledMcp,
      mcpBuilder: new StaticMcpBuilder(builderResponse('static_verified')),
      mcpCompensator: compensator,
    });
    const request = {
      contractVersion: 1,
      mode: 'mcp_url',
      definitionId: 'url:mcp/bounded-echo',
      manifestUrl: 'https://example.com/mcp/manifest.json',
      expectedManifestSha256: null,
      expectedRevision: 0,
      evidenceContext,
    } as const;
    expect(await enabledService.apply(request)).toMatchObject({ ok: false, code: 'mcp_install_failed', compensated: true });

    const mismatchCompensator = new TrackingCompensator();
    const mismatchMcp = new StaticMcpPort(mcpRecord('downloaded'));
    mismatchMcp.operationIdOverride = '00000000-0000-4000-8000-000000000099';
    const mismatchService = new PersonalizationExtensionService({
      definitions: new MemoryDefinitionSink(),
      evidence: new EvidenceEnvelopeService(randomBytes(32)),
      skills: new StaticSkillPort(urlSkill.installed, urlSkill.directory),
      mcp: mismatchMcp,
      mcpBuilder: new StaticMcpBuilder(builderResponse('static_verified')),
      mcpCompensator: mismatchCompensator,
    });
    expect(await mismatchService.apply(request)).toMatchObject({ ok: false, code: 'mcp_install_failed', compensated: true });
    expect(mismatchCompensator.calls).toHaveLength(1);
  });

  it('rejects unverifiable evidence signer output and rolls back the external resource', async () => {
    const root = temporaryRoot('metis-extension-evidence-fail-');
    const fixture = installedUrlSkill(root);
    const skills = new StaticSkillPort(fixture.installed, fixture.directory);
    const badSigner: PersonalizationEvidenceSigner = { issue: () => ({ truth: { state: 'verified' } }), verify: () => false };
    const service = new PersonalizationExtensionService({
      definitions: new MemoryDefinitionSink(),
      evidence: badSigner,
      skills,
      ...unusedMcpDependencies(),
    });
    const result = await service.apply({
      contractVersion: 1,
      mode: 'skill_url',
      url: 'https://example.com/skill.zip',
      expectedArchiveSha256: null,
      expectedId: null,
      expectedVersion: fixture.installed.version,
      expectedRevision: 0,
      evidenceContext,
    });
    expect(result).toMatchObject({ ok: false, code: 'evidence_unavailable', compensated: true });
    expect(skills.uninstallCalls).toEqual([[fixture.installed.id, fixture.installed.version]]);
  });
});
