import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  EvidenceEnvelopeSchema,
  type EvidenceEnvelope,
} from '../engine/runtime/EvidenceEnvelopeContract.js';
import {
  McpBuilderResponseSchema,
  McpUrlInstallResponseSchema,
  type McpBuilderResponse,
  type McpInstalledRecord,
  type McpUrlInstallResponse,
} from '../engine/runtime/McpInstallationContract.js';
import {
  PERSONALIZATION_CONTRACT_VERSION,
  McpDefinitionSchema,
  PersonalizationDefinitionSchema,
  PersonalizationMutationResultSchema,
  SkillDefinitionV2Schema,
  type McpDefinition,
  type PersonalizationDefinition,
  type PersonalizationMutationResult,
  type PersonalizationSaveRequest,
} from '../engine/runtime/PersonalizationRuntimeContract.js';
import {
  PersonalizationExtensionApplyRequestSchema,
  PersonalizationExtensionApplyResponseSchema,
  RequirementsMcpApplyRequestSchema,
  type ExtensionEvidenceContext,
  type MarkdownSkillApplyRequest,
  type PackageMcpApplyRequest,
  type PackageSkillApplyRequest,
  type PersonalizationExtensionApplyRequest,
  type PersonalizationExtensionApplyResponse,
  type RequirementsMcpApplyRequest,
  type UrlMcpApplyRequest,
  type UrlSkillApplyRequest,
} from '../engine/runtime/PersonalizationExtensionContract.js';
import type {
  InstalledSkillVersion,
  SkillInstallationResult,
} from '../engine/runtime/SkillInstallationContract.js';
import { SkillInstallationResultSchema } from '../engine/runtime/SkillInstallationContract.js';
import type { McpControlledProbeRunner } from './PersonalizationMcpInstaller.js';
import type { McpStaticValidationResult } from './PersonalizationMcpInstaller.js';

export interface PersonalizationDefinitionSink {
  get(id: string): PersonalizationDefinition | undefined;
  save(request: PersonalizationSaveRequest): PersonalizationMutationResult;
}

export interface PersonalizationEvidenceSigner {
  issue(raw: unknown): unknown;
  verify(raw: unknown): boolean;
}

export interface SkillInstallationPort {
  installFromPackage(sourcePath: string): SkillInstallationResult;
  installFromUrl(rawUrl: string, constraints?: Readonly<{
    expectedArchiveSha256?: string | null;
    expectedId?: string | null;
    expectedVersion?: string | null;
  }>): Promise<SkillInstallationResult>;
  uninstall(id: string, version?: string): { ok: boolean };
  resolveInstalledDirectory(id: string, version?: string): string | undefined;
}

export interface McpInstallationPort {
  installFromUrl(raw: unknown): Promise<McpUrlInstallResponse>;
  installFromDirectory(sourcePath: string): McpInstalledRecord;
  staticValidate(installationId: string): McpStaticValidationResult;
  getLaunchDescriptor(installationId: string): {
    secretRefs: Readonly<Record<string, string>>;
  } | null;
}

export interface McpBuilderPort {
  build(raw: unknown, runner?: McpControlledProbeRunner): Promise<McpBuilderResponse>;
}

export interface McpInstallationCompensator {
  rollbackInstallation(installationId: string): boolean;
}

/**
 * Removes only a freshly installed MCP directory after a higher-level
 * transaction fails. It never follows links and never removes the store root.
 */
export class FilesystemMcpInstallationCompensator implements McpInstallationCompensator {
  readonly #root: string;

  constructor(root: string) {
    const resolved = path.resolve(root);
    const stat = fs.lstatSync(resolved);
    const real = fs.realpathSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFilesystemPath(real, resolved)) {
      throw new Error('Unsafe MCP compensation root');
    }
    this.#root = real;
  }

  rollbackInstallation(installationId: string): boolean {
    if (!/^mcp_[a-f0-9]{32}$/u.test(installationId)) return false;
    try {
      const rootStat = fs.lstatSync(this.#root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !sameFilesystemPath(fs.realpathSync(this.#root), this.#root)) return false;
      const target = path.join(this.#root, installationId);
      if (!containedBy(this.#root, target)) return false;
      const targetStat = fs.lstatSync(target);
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink() || !sameFilesystemPath(fs.realpathSync(target), target)) return false;
      if (!treeContainsOnlyRegularFilesAndDirectories(target)) return false;
      fs.rmSync(target, { recursive: true, force: false });
      if (process.platform !== 'win32') {
        const fd = fs.openSync(this.#root, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      return !fs.existsSync(target);
    } catch {
      return false;
    }
  }
}

export interface PersonalizationExtensionServiceDependencies {
  definitions: PersonalizationDefinitionSink;
  evidence: PersonalizationEvidenceSigner;
  skills: SkillInstallationPort;
  mcp: McpInstallationPort;
  mcpBuilder: McpBuilderPort;
  mcpCompensator: McpInstallationCompensator;
  mcpProbeRunner?: McpControlledProbeRunner;
  now?: () => number;
}

export interface PersonalizationExtensionInvocation {
  /** Resolves a renderer-owned, single-use FileCapability in the invoking main-frame scope. */
  resolveLocalSkillSource(capabilityId: string): string | undefined;
  resolveLocalMcpSource(capabilityId: string): string | undefined;
}

export type PreparedGeneratedMcp =
  | { ok: true; request: RequirementsMcpApplyRequest; definition: McpDefinition; installation: McpInstalledRecord }
  | { ok: false; response: PersonalizationExtensionApplyResponse };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function stableEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function safeDetail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const safe = [...value].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
  }).join('').slice(0, 512);
  return safe.length > 0 ? safe : null;
}

function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLocaleLowerCase('en-US') === path.resolve(right).toLocaleLowerCase('en-US')
    : path.resolve(left) === path.resolve(right);
}

function containedBy(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sameRemoteUrl(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  try { return new URL(left).toString() === new URL(right).toString(); } catch { return false; }
}

function treeContainsOnlyRegularFilesAndDirectories(root: string): boolean {
  const visit = (directory: string): boolean => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        if (!sameFilesystemPath(fs.realpathSync(candidate), candidate) || !visit(candidate)) return false;
      } else if (!entry.isFile()) {
        return false;
      }
    }
    return true;
  };
  return visit(root);
}

function readVerifiedUtf8File(filePath: string, expectedSize: number, expectedSha256: string): string {
  let fd: number | undefined;
  try {
    const pathStat = fs.lstatSync(filePath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.size !== expectedSize || pathStat.size > 500_000) {
      throw new Error('package_entry_invalid');
    }
    fd = fs.openSync(filePath, 'r');
    const before = fs.fstatSync(fd);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const stable = process.platform === 'win32'
      ? before.size === after.size && before.mtimeMs === after.mtimeMs
      : before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs;
    if (!stable || bytes.length !== expectedSize || createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
      throw new Error('package_entry_integrity_mismatch');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export class PersonalizationExtensionService {
  readonly #definitions: PersonalizationDefinitionSink;
  readonly #evidence: PersonalizationEvidenceSigner;
  readonly #skills: SkillInstallationPort;
  readonly #mcp: McpInstallationPort;
  readonly #mcpBuilder: McpBuilderPort;
  readonly #mcpCompensator: McpInstallationCompensator;
  readonly #now: () => number;

  constructor(dependencies: PersonalizationExtensionServiceDependencies) {
    this.#definitions = dependencies.definitions;
    this.#evidence = dependencies.evidence;
    this.#skills = dependencies.skills;
    this.#mcp = dependencies.mcp;
    this.#mcpBuilder = dependencies.mcpBuilder;
    this.#mcpCompensator = dependencies.mcpCompensator;
    this.#now = dependencies.now ?? Date.now;
  }

  async apply(raw: unknown, invocation?: PersonalizationExtensionInvocation): Promise<PersonalizationExtensionApplyResponse> {
    const request = PersonalizationExtensionApplyRequestSchema.safeParse(raw);
    if (!request.success) return this.#failure(null, 'invalid_request', 'schema_rejected', false);
    try {
      switch (request.data.mode) {
        case 'skill_markdown': return this.#applyMarkdown(request.data);
        case 'skill_package': return this.#applyPackage(request.data, invocation);
        case 'skill_url': return this.#applySkillUrl(request.data);
        case 'mcp_requirements': return this.#applyMcpRequirements(request.data);
        case 'mcp_url': return this.#applyMcpUrl(request.data);
        case 'mcp_package': return this.#applyMcpPackage(request.data, invocation);
      }
    } catch {
      return this.#failure(request.data.mode, 'definition_rejected', 'service_exception', false);
    }
  }

  /** Main-process transaction seam: prepare a generated MCP without persisting or enabling it. */
  async prepareGeneratedMcp(raw: unknown): Promise<PreparedGeneratedMcp> {
    const parsed = RequirementsMcpApplyRequestSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.runProbe) {
      return { ok: false, response: this.#failure('mcp_requirements', 'invalid_request', 'schema_rejected', false) };
    }
    const request = parsed.data;
    let rawResult: McpBuilderResponse;
    try {
      rawResult = await this.#mcpBuilder.build({
        operationId: request.evidenceContext.operationId,
        requirement: request.requirement,
        requestedPackageId: request.requestedPackageId,
      });
    } catch {
      return { ok: false, response: this.#failure(request.mode, 'mcp_builder_failed', 'builder_exception', false) };
    }
    const result = McpBuilderResponseSchema.safeParse(rawResult);
    if (!result.success || !result.data.ok) {
      const detail = result.success && !result.data.ok ? result.data.code : 'invalid_builder_response';
      return { ok: false, response: this.#failure(request.mode, 'mcp_builder_failed', detail, false) };
    }
    if (result.data.operationId !== request.evidenceContext.operationId
      || result.data.record.packageId !== request.requestedPackageId) {
      return {
        ok: false,
        response: this.#afterMcpCompensation(
          request.mode, result.data.record, 'mcp_builder_failed', 'builder_identity_mismatch',
        ),
      };
    }
    if (result.data.outcome !== 'pending_probe' || result.data.record.enabled
      || result.data.record.state !== 'static_verified' || result.data.record.probedAt !== null
      || result.data.record.exposedTools.length !== 0) {
      return {
        ok: false,
        response: this.#afterMcpCompensation(
          request.mode, result.data.record, 'mcp_builder_failed', 'probe_state_inconsistent',
        ),
      };
    }
    const definition = this.#buildMcpDefinitionCandidate(request, result.data.record, false, 'generated');
    if (!definition) {
      return {
        ok: false,
        response: this.#afterMcpCompensation(
          request.mode, result.data.record, 'definition_rejected', 'mcp_definition_invalid',
        ),
      };
    }
    return { ok: true, request, definition, installation: result.data.record };
  }

  #applyMarkdown(request: MarkdownSkillApplyRequest): PersonalizationExtensionApplyResponse {
    const now = this.#now();
    const current = this.#definitions.get(request.id);
    const definition = SkillDefinitionV2Schema.safeParse({
      contractVersion: PERSONALIZATION_CONTRACT_VERSION,
      id: request.id,
      kind: 'skill',
      name: request.name,
      description: request.description,
      enabled: true,
      tags: request.tags,
      revision: request.expectedRevision + 1,
      provenance: {
        origin: 'user',
        author: request.author,
        version: request.version,
        license: null,
        sourceUrl: null,
        sourceRevision: null,
        installedDigest: null,
        parentId: current?.provenance.parentId ?? null,
        parentVersion: current?.provenance.parentVersion ?? null,
        locallyModified: true,
        createdAt: current?.provenance.createdAt ?? now,
        updatedAt: now,
      },
      sourceMode: 'markdown',
      markdown: request.markdown,
      systemPrompt: request.markdown,
      toolIds: request.toolIds,
      mcpIds: request.mcpIds,
      maxTurns: request.maxTurns,
      inputSchema: request.inputSchema,
      outputSchema: request.outputSchema,
      packageEntry: null,
    });
    if (!definition.success) return this.#failure(request.mode, 'definition_rejected', 'skill_definition_invalid', false);
    const envelope = this.#issueEnvelope(request.evidenceContext, definition.data, 'skill', null, {
      kind: 'json',
      canonicalJson: canonicalJson({
        sourceMode: 'markdown',
        definitionId: definition.data.id,
        definitionRevision: definition.data.revision,
        authoredContent: request.markdown,
      }),
    });
    if (!envelope) return this.#failure(request.mode, 'evidence_unavailable', 'signing_failed', false);
    const saved = this.#saveDefinition(definition.data, request.expectedRevision);
    if (!saved) return this.#failure(request.mode, 'definition_rejected', 'definition_cas_failed', false);
    return this.#success(request.mode, saved, envelope, null, null);
  }

  #applyPackage(
    request: PackageSkillApplyRequest,
    invocation: PersonalizationExtensionInvocation | undefined,
  ): PersonalizationExtensionApplyResponse {
    const sourcePath = invocation?.resolveLocalSkillSource(request.sourceCapabilityId);
    if (!sourcePath) return this.#failure(request.mode, 'skill_install_failed', 'invalid_file_capability', false);
    let raw: SkillInstallationResult;
    try { raw = this.#skills.installFromPackage(sourcePath); } catch { return this.#failure(request.mode, 'skill_install_failed', 'installer_exception', false); }
    const installation = SkillInstallationResultSchema.safeParse(raw);
    if (!installation.success) return this.#failure(request.mode, 'skill_install_failed', 'invalid_installer_response', false);
    if (!installation.data.ok) return this.#failure(request.mode, 'skill_install_failed', installation.data.code, false);
    if (!this.#coherentSkillInstallation(
      installation.data.installed,
      'package',
      null,
      request.expectedId,
      null,
    )) {
      return this.#afterSkillCompensation(request.mode, installation.data.installed, 'package_identity_rejected', 'local_package_identity_mismatch');
    }
    return this.#persistInstalledSkill(request, installation.data.installed, 'package');
  }

  async #applySkillUrl(request: UrlSkillApplyRequest): Promise<PersonalizationExtensionApplyResponse> {
    let raw: SkillInstallationResult;
    try {
      raw = await this.#skills.installFromUrl(request.url, {
        expectedArchiveSha256: request.expectedArchiveSha256,
        expectedId: request.expectedId,
        expectedVersion: request.expectedVersion,
      });
    } catch {
      return this.#failure(request.mode, 'skill_install_failed', 'installer_exception', false);
    }
    const installation = SkillInstallationResultSchema.safeParse(raw);
    if (!installation.success) return this.#failure(request.mode, 'skill_install_failed', 'invalid_installer_response', false);
    if (!installation.data.ok) return this.#failure(request.mode, 'skill_install_failed', installation.data.code, false);
    if (!this.#coherentSkillInstallation(
      installation.data.installed,
      'url',
      request.url,
      request.expectedId,
      request.expectedVersion,
    ) || (request.expectedArchiveSha256 !== null && installation.data.installed.packageDigest !== request.expectedArchiveSha256)) {
      return this.#afterSkillCompensation(request.mode, installation.data.installed, 'package_identity_rejected', 'url_package_identity_mismatch');
    }
    return this.#persistInstalledSkill(request, installation.data.installed, 'url');
  }

  #persistInstalledSkill(
    request: PackageSkillApplyRequest | UrlSkillApplyRequest,
    installed: InstalledSkillVersion,
    sourceMode: 'package' | 'url',
  ): PersonalizationExtensionApplyResponse {
    try {
      return this.#persistInstalledSkillChecked(request, installed, sourceMode);
    } catch {
      return this.#afterSkillCompensation(request.mode, installed, 'package_content_rejected', 'service_exception');
    }
  }

  #persistInstalledSkillChecked(
    request: PackageSkillApplyRequest | UrlSkillApplyRequest,
    installed: InstalledSkillVersion,
    sourceMode: 'package' | 'url',
  ): PersonalizationExtensionApplyResponse {
    const directory = this.#skills.resolveInstalledDirectory(installed.id, installed.version);
    if (!directory) return this.#afterSkillCompensation(request.mode, installed, 'package_content_rejected', 'installation_directory_unavailable');
    const entryDeclaration = installed.manifest.files.find((file) => file.path === installed.manifest.entry);
    const promptDeclaration = installed.manifest.systemPromptFile === null
      ? entryDeclaration
      : installed.manifest.files.find((file) => file.path === installed.manifest.systemPromptFile);
    if (!entryDeclaration || entryDeclaration.role !== 'documentation' || !promptDeclaration || promptDeclaration.role !== 'documentation') {
      return this.#afterSkillCompensation(request.mode, installed, 'package_content_rejected', 'prompt_must_be_documentation');
    }
    let markdown: string;
    let systemPrompt: string;
    try {
      markdown = readVerifiedUtf8File(
        path.resolve(directory, ...installed.manifest.entry.split('/')),
        entryDeclaration.size,
        entryDeclaration.sha256,
      );
      systemPrompt = readVerifiedUtf8File(
        path.resolve(directory, ...(installed.manifest.systemPromptFile ?? installed.manifest.entry).split('/')),
        promptDeclaration.size,
        promptDeclaration.sha256,
      );
    } catch {
      return this.#afterSkillCompensation(request.mode, installed, 'package_content_rejected', 'package_entry_invalid');
    }
    const now = this.#now();
    const current = this.#definitions.get(installed.id);
    const definition = SkillDefinitionV2Schema.safeParse({
      contractVersion: PERSONALIZATION_CONTRACT_VERSION,
      id: installed.id,
      kind: 'skill',
      name: installed.manifest.name,
      description: installed.manifest.description,
      enabled: true,
      tags: [sourceMode, 'installed'],
      revision: request.expectedRevision + 1,
      provenance: {
        origin: sourceMode === 'url' ? 'url' : 'user',
        author: installed.manifest.author,
        version: installed.manifest.version,
        license: installed.manifest.license,
        sourceUrl: installed.provenance.sourceUrl,
        sourceRevision: installed.provenance.manifestSha256,
        installedDigest: installed.packageDigest,
        parentId: current?.provenance.parentId ?? null,
        parentVersion: current?.provenance.parentVersion ?? null,
        locallyModified: false,
        createdAt: current?.provenance.createdAt ?? now,
        updatedAt: now,
      },
      sourceMode,
      markdown,
      systemPrompt,
      toolIds: [],
      mcpIds: [],
      maxTurns: 20,
      inputSchema: null,
      outputSchema: null,
      packageEntry: installed.manifest.entry,
    });
    if (!definition.success) return this.#afterSkillCompensation(request.mode, installed, 'definition_rejected', 'skill_definition_invalid');
    const envelope = this.#issueEnvelope(request.evidenceContext, definition.data, 'skill', installed.provenance.sourceUrl, {
      kind: 'json',
      canonicalJson: canonicalJson({
        sourceMode,
        definitionId: definition.data.id,
        version: installed.version,
        packageDigest: installed.packageDigest,
        manifestDigest: installed.provenance.manifestSha256,
      }),
    });
    if (!envelope) return this.#afterSkillCompensation(request.mode, installed, 'evidence_unavailable', 'signing_failed');
    const saved = this.#saveDefinition(definition.data, request.expectedRevision);
    if (!saved) return this.#afterSkillCompensation(request.mode, installed, 'definition_rejected', 'definition_cas_failed');
    return this.#success(request.mode, saved, envelope, installed, null);
  }

  async #applyMcpUrl(request: UrlMcpApplyRequest): Promise<PersonalizationExtensionApplyResponse> {
    let rawResult: McpUrlInstallResponse;
    try {
      rawResult = await this.#mcp.installFromUrl({
        operationId: request.evidenceContext.operationId,
        manifestUrl: request.manifestUrl,
        expectedManifestSha256: request.expectedManifestSha256,
      });
    } catch {
      return this.#failure(request.mode, 'mcp_install_failed', 'installer_exception', false);
    }
    const installed = McpUrlInstallResponseSchema.safeParse(rawResult);
    if (!installed.success || !installed.data.ok) {
      const detail = installed.success && !installed.data.ok ? installed.data.code : 'invalid_installer_response';
      return this.#failure(request.mode, 'mcp_install_failed', detail, false);
    }
    if (installed.data.operationId !== request.evidenceContext.operationId) {
      return this.#afterMcpCompensation(request.mode, installed.data.record, 'mcp_install_failed', 'operation_id_mismatch');
    }
    if (installed.data.record.enabled || installed.data.record.state === 'enabled') {
      return this.#afterMcpCompensation(request.mode, installed.data.record, 'mcp_install_failed', 'url_mcp_must_start_disabled');
    }
    let staticResult: McpStaticValidationResult;
    try { staticResult = this.#mcp.staticValidate(installed.data.record.installationId); } catch {
      return this.#afterMcpCompensation(request.mode, installed.data.record, 'package_content_rejected', 'static_validation_exception');
    }
    if (!staticResult.ok || !staticResult.record
      || staticResult.record.installationId !== installed.data.record.installationId
      || staticResult.record.packageId !== installed.data.record.packageId
      || staticResult.record.packageVersion !== installed.data.record.packageVersion
      || staticResult.record.packageSha256 !== installed.data.record.packageSha256
      || staticResult.record.manifestSha256 !== installed.data.record.manifestSha256
      || staticResult.record.enabled || staticResult.record.state !== 'static_verified') {
      return this.#afterMcpCompensation(request.mode, installed.data.record, 'package_content_rejected', 'static_validation_failed');
    }
    return this.#persistMcpDefinition(request, staticResult.record, false, 'url');
  }

  async #applyMcpRequirements(request: RequirementsMcpApplyRequest): Promise<PersonalizationExtensionApplyResponse> {
    if (request.runProbe) {
      return this.#failure(
        request.mode, 'probe_required', 'generated_activation_transaction_required', false,
      );
    }
    let raw: McpBuilderResponse;
    try {
      raw = await this.#mcpBuilder.build({
        operationId: request.evidenceContext.operationId,
        requirement: request.requirement,
        requestedPackageId: request.requestedPackageId,
      });
    } catch {
      return this.#failure(request.mode, 'mcp_builder_failed', 'builder_exception', false);
    }
    const result = McpBuilderResponseSchema.safeParse(raw);
    if (!result.success || !result.data.ok) {
      const detail = result.success && !result.data.ok ? result.data.code : 'invalid_builder_response';
      return this.#failure(request.mode, 'mcp_builder_failed', detail, false);
    }
    if (result.data.operationId !== request.evidenceContext.operationId
      || result.data.record.packageId !== request.requestedPackageId) {
      return this.#afterMcpCompensation(request.mode, result.data.record, 'mcp_builder_failed', 'builder_identity_mismatch');
    }
    const safelyPending = result.data.outcome === 'pending_probe'
      && !result.data.record.enabled
      && result.data.record.state !== 'enabled';
    if (!safelyPending) {
      return this.#afterMcpCompensation(request.mode, result.data.record, 'mcp_builder_failed', 'probe_state_inconsistent');
    }
    return this.#persistMcpDefinition(request, result.data.record, false, 'generated');
  }

  #applyMcpPackage(
    request: PackageMcpApplyRequest,
    invocation: PersonalizationExtensionInvocation | undefined,
  ): PersonalizationExtensionApplyResponse {
    const sourcePath = invocation?.resolveLocalMcpSource(request.sourceCapabilityId);
    if (!sourcePath) return this.#failure(request.mode, 'mcp_install_failed', 'local_package_unavailable', false);
    let installed: McpInstalledRecord;
    try { installed = this.#mcp.installFromDirectory(sourcePath); } catch {
      return this.#failure(request.mode, 'mcp_install_failed', 'local_package_invalid', false);
    }
    let staticResult: McpStaticValidationResult;
    try { staticResult = this.#mcp.staticValidate(installed.installationId); } catch {
      return this.#afterMcpCompensation(request.mode, installed, 'package_content_rejected', 'static_validation_exception');
    }
    if (!staticResult.ok || !staticResult.record
      || staticResult.record.installationId !== installed.installationId
      || staticResult.record.packageSha256 !== installed.packageSha256
      || staticResult.record.manifestSha256 !== installed.manifestSha256
      || staticResult.record.enabled || staticResult.record.state !== 'static_verified') {
      return this.#afterMcpCompensation(request.mode, installed, 'package_content_rejected', 'static_validation_failed');
    }
    return this.#persistMcpDefinition(request, staticResult.record, false, 'package');
  }

  #persistMcpDefinition(
    request: UrlMcpApplyRequest | RequirementsMcpApplyRequest | PackageMcpApplyRequest,
    installed: McpInstalledRecord,
    enabled: boolean,
    sourceMode: 'url' | 'generated' | 'package',
  ): PersonalizationExtensionApplyResponse {
    try {
      return this.#persistMcpDefinitionChecked(request, installed, enabled, sourceMode);
    } catch {
      return this.#afterMcpCompensation(request.mode, installed, 'package_content_rejected', 'service_exception');
    }
  }

  #persistMcpDefinitionChecked(
    request: UrlMcpApplyRequest | RequirementsMcpApplyRequest | PackageMcpApplyRequest,
    installed: McpInstalledRecord,
    enabled: boolean,
    sourceMode: 'url' | 'generated' | 'package',
  ): PersonalizationExtensionApplyResponse {
    if (enabled) {
      const launch = this.#mcp.getLaunchDescriptor(installed.installationId);
      if (!launch) {
        return this.#afterMcpCompensation(
          request.mode, installed, 'mcp_builder_failed', 'verified_launch_descriptor_missing',
        );
      }
      if (Object.values(launch.secretRefs)
        .some((secretRef) => !/^\$\{secret:[A-Z_][A-Z0-9_]{0,127}\}$/u.test(secretRef))) {
        return this.#afterMcpCompensation(
          request.mode, installed, 'package_content_rejected', 'raw_secret_rejected',
        );
      }
    }
    const definition = this.#buildMcpDefinitionCandidate(request, installed, enabled, sourceMode);
    if (!definition) return this.#afterMcpCompensation(request.mode, installed, 'definition_rejected', 'mcp_definition_invalid');
    const sourceUrl = request.mode === 'mcp_url' ? request.manifestUrl : null;
    const envelope = this.#issueEnvelope(request.evidenceContext, definition, 'mcp', sourceUrl, {
      kind: 'json',
      canonicalJson: canonicalJson({
        sourceMode,
        definitionId: request.definitionId,
        installationId: installed.installationId,
        packageId: installed.packageId,
        packageVersion: installed.packageVersion,
        packageDigest: installed.packageSha256,
        manifestDigest: installed.manifestSha256,
        probeState: enabled ? 'probe_verified' : 'pending',
      }),
    });
    if (!envelope) return this.#afterMcpCompensation(request.mode, installed, 'evidence_unavailable', 'signing_failed');
    const saved = this.#saveDefinition(definition, request.expectedRevision);
    if (!saved) return this.#afterMcpCompensation(request.mode, installed, 'definition_rejected', 'definition_cas_failed');
    return this.#success(request.mode, saved, envelope, null, installed);
  }

  #buildMcpDefinitionCandidate(
    request: UrlMcpApplyRequest | RequirementsMcpApplyRequest | PackageMcpApplyRequest,
    installed: McpInstalledRecord,
    enabled: boolean,
    sourceMode: 'url' | 'generated' | 'package',
  ): McpDefinition | undefined {
    const definitionId = request.definitionId;
    const launch = enabled ? this.#mcp.getLaunchDescriptor(installed.installationId) : null;
    if (enabled && !launch) return undefined;
    const environment: McpDefinition['environment'] = {};
    for (const [name, secretRef] of Object.entries(launch?.secretRefs ?? {})) {
      if (!/^\$\{secret:[A-Z_][A-Z0-9_]{0,127}\}$/u.test(secretRef)) return undefined;
      environment[name] = { secret: true, value: null };
    }
    const now = this.#now();
    const current = this.#definitions.get(definitionId);
    const sourceUrl = request.mode === 'mcp_url' ? request.manifestUrl : null;
    const definition = McpDefinitionSchema.safeParse({
      contractVersion: PERSONALIZATION_CONTRACT_VERSION,
      id: definitionId,
      kind: 'mcp',
      name: installed.packageId,
      description: `Managed MCP package ${installed.packageId} ${installed.packageVersion}`,
      enabled,
      tags: [sourceMode, enabled ? 'probe-verified' : 'pending-probe'],
      revision: request.expectedRevision + 1,
      provenance: {
        origin: sourceMode === 'package' ? 'user' : sourceMode,
        author: sourceMode === 'generated' ? 'Metis MCP Builder' : sourceMode === 'package' ? 'Local MCP package' : 'External MCP package',
        version: installed.packageVersion,
        license: null,
        sourceUrl,
        sourceRevision: installed.installationId,
        installedDigest: installed.packageSha256,
        parentId: current?.provenance.parentId ?? null,
        parentVersion: current?.provenance.parentVersion ?? null,
        locallyModified: false,
        createdAt: current?.provenance.createdAt ?? now,
        updatedAt: now,
      },
      sourceMode,
      transport: 'stdio',
      command: 'metis-managed-mcp',
      args: [installed.installationId],
      environment,
      sourceUrl,
      exposedTools: enabled ? installed.exposedTools : [],
      workingDirectoryToken: installed.installationId,
    });
    return definition.success ? definition.data : undefined;
  }

  #issueEnvelope(
    context: ExtensionEvidenceContext,
    definition: PersonalizationDefinition,
    sourceKind: 'skill' | 'mcp',
    sourceUrl: string | null,
    payload: { kind: 'json'; canonicalJson: string },
  ): EvidenceEnvelope | undefined {
    const issued = this.#evidence.issue({
      contractVersion: PERSONALIZATION_CONTRACT_VERSION,
      sessionId: context.sessionId,
      projectId: context.projectId,
      operationId: context.operationId,
      runManifestDigest: context.runManifestDigest,
      sourceDefinitionId: definition.id,
      sourceDefinitionRevision: definition.revision,
      sourceKind,
      observedAt: context.observedAt,
      sourceUrl,
      locator: null,
      payload,
    });
    const envelope = EvidenceEnvelopeSchema.safeParse(issued);
    if (!envelope.success || !this.#evidence.verify(envelope.data)) return undefined;
    return envelope.data;
  }

  #coherentSkillInstallation(
    installed: InstalledSkillVersion,
    sourceMode: 'package' | 'url',
    expectedSourceUrl: string | null,
    expectedId: string | null,
    expectedVersion: string | null,
  ): boolean {
    const expectedStorageKey = createHash('sha256').update(installed.id).digest('hex');
    return installed.id === installed.manifest.id
      && installed.name === installed.manifest.name
      && installed.version === installed.manifest.version
      && installed.storageKey === expectedStorageKey
      && installed.packageDigest === installed.provenance.archiveSha256
      && installed.provenance.sourceMode === sourceMode
      && (sourceMode === 'package'
        ? installed.id.startsWith('user:skills/') && installed.provenance.sourceUrl === null
        : installed.id.startsWith('url:skills/') && sameRemoteUrl(installed.provenance.sourceUrl, expectedSourceUrl))
      && (expectedId === null || installed.id === expectedId)
      && (expectedVersion === null || installed.version === expectedVersion);
  }

  #saveDefinition(definition: PersonalizationDefinition, expectedRevision: number): PersonalizationDefinition | undefined {
    let raw: PersonalizationMutationResult;
    try {
      raw = this.#definitions.save({
        contractVersion: PERSONALIZATION_CONTRACT_VERSION,
        definition,
        expectedRevision,
      });
    } catch {
      return undefined;
    }
    const result = PersonalizationMutationResultSchema.safeParse(raw);
    if (!result.success || !result.data.ok || result.data.code !== 'saved') return undefined;
    const parsed = PersonalizationDefinitionSchema.safeParse(result.data.definition);
    return parsed.success && stableEqual(parsed.data, definition) ? parsed.data : undefined;
  }

  #afterSkillCompensation(
    mode: 'skill_package' | 'skill_url',
    installation: InstalledSkillVersion,
    code: 'package_identity_rejected' | 'package_content_rejected' | 'definition_rejected' | 'evidence_unavailable',
    detail: string,
  ): PersonalizationExtensionApplyResponse {
    let compensated: boolean;
    try { compensated = this.#skills.uninstall(installation.id, installation.version).ok; } catch { compensated = false; }
    return compensated
      ? this.#failure(mode, code, detail, true)
      : this.#failure(mode, 'compensation_failed', detail, false);
  }

  #afterMcpCompensation(
    mode: 'mcp_requirements' | 'mcp_url' | 'mcp_package',
    installation: McpInstalledRecord,
    code: 'mcp_install_failed' | 'mcp_builder_failed' | 'package_content_rejected' | 'definition_rejected' | 'evidence_unavailable',
    detail: string,
  ): PersonalizationExtensionApplyResponse {
    let compensated: boolean;
    try { compensated = this.#mcpCompensator.rollbackInstallation(installation.installationId); } catch { compensated = false; }
    return compensated
      ? this.#failure(mode, code, detail, true)
      : this.#failure(mode, 'compensation_failed', detail, false);
  }

  #success(
    mode: PersonalizationExtensionApplyRequest['mode'],
    definition: PersonalizationDefinition,
    evidence: EvidenceEnvelope,
    skillInstallation: InstalledSkillVersion | null,
    mcpInstallation: McpInstalledRecord | null,
  ): PersonalizationExtensionApplyResponse {
    return PersonalizationExtensionApplyResponseSchema.parse({
      ok: true,
      mode,
      definition,
      evidence,
      skillInstallation,
      mcpInstallation,
    });
  }

  #failure(
    mode: PersonalizationExtensionApplyRequest['mode'] | null,
    code: Extract<PersonalizationExtensionApplyResponse, { ok: false }>['code'],
    detailCode: unknown,
    compensated: boolean,
  ): PersonalizationExtensionApplyResponse {
    return PersonalizationExtensionApplyResponseSchema.parse({
      ok: false,
      mode,
      code,
      detailCode: safeDetail(detailCode),
      compensated,
    });
  }
}
