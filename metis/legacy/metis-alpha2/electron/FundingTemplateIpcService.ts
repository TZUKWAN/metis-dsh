import path from 'node:path';
import {
  FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
  FundingTemplateIpcRequestSchema,
  FundingTemplateRuntimeResponseSchema,
  FundingTemplateRuntimeScopeIdSchema,
  type FundingTemplateIpcRequest,
  type FundingTemplateRuntimeFailureCode,
  type FundingTemplateRuntimeResponse,
} from '../engine/runtime/FundingTemplateRuntimeContract.js';
import type { FundingTemplateRepository } from './FundingTemplateRepository.js';
import type { FundingTemplateService, FundingTemplateServiceFailureCode } from './FundingTemplateService.js';
import {
  mapFundingTemplateRepositoryFailure,
  projectFundingTemplateDiff,
  projectFundingTemplateSummary,
  projectFundingTemplateVersion,
} from './FundingTemplateRuntimeProjection.js';

export interface FundingTemplateConsumedFile {
  filePath: string;
  trustedRoot: string;
}

export interface FundingTemplateIpcServiceDependencies {
  repository: FundingTemplateRepository;
  service: FundingTemplateService;
  projectExists(projectId: string): boolean;
  consumeFundingFile(capabilityId: string): FundingTemplateConsumedFile | null;
}

function mapServiceFailure(code: FundingTemplateServiceFailureCode): FundingTemplateRuntimeFailureCode {
  return code;
}

function fixedInvalidResponse(): FundingTemplateRuntimeResponse {
  return {
    ok: false,
    contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
    action: 'list',
    operationId: '00000000-0000-4000-8000-000000000000',
    ownerId: 'decode-failure',
    projectId: 'decode-failure',
    code: 'invalid_request',
  };
}

function parseResponse(candidate: unknown): FundingTemplateRuntimeResponse {
  const parsed = FundingTemplateRuntimeResponseSchema.safeParse(candidate);
  return parsed.success ? parsed.data : fixedInvalidResponse();
}

function failure(
  request: FundingTemplateIpcRequest,
  ownerId: string,
  code: FundingTemplateRuntimeFailureCode,
): FundingTemplateRuntimeResponse {
  return parseResponse({
    ok: false,
    contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
    action: request.action,
    operationId: request.operationId,
    ownerId,
    projectId: request.projectId,
    code,
  });
}

function identity(request: FundingTemplateIpcRequest, ownerId: string) {
  return {
    contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
    action: request.action,
    operationId: request.operationId,
    ownerId,
    projectId: request.projectId,
  } as const;
}

/**
 * Main-only orchestration for funding-template IPC. The renderer supplies no
 * owner identity or filesystem path, and every successful result is projected
 * through the renderer-safe schemas before it leaves this service.
 */
export class FundingTemplateIpcService {
  readonly #repository: FundingTemplateRepository;
  readonly #service: FundingTemplateService;
  readonly #projectExists: FundingTemplateIpcServiceDependencies['projectExists'];
  readonly #consumeFundingFile: FundingTemplateIpcServiceDependencies['consumeFundingFile'];

  constructor(dependencies: FundingTemplateIpcServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#service = dependencies.service;
    this.#projectExists = dependencies.projectExists;
    this.#consumeFundingFile = dependencies.consumeFundingFile;
  }

  async handle(ownerIdRaw: unknown, rawRequest: unknown): Promise<FundingTemplateRuntimeResponse> {
    const owner = FundingTemplateRuntimeScopeIdSchema.safeParse(ownerIdRaw);
    const request = FundingTemplateIpcRequestSchema.safeParse(rawRequest);
    if (!owner.success || !request.success) return fixedInvalidResponse();
    const input = request.data;
    if (!this.#projectExists(input.projectId)) return failure(input, owner.data, 'not_found');

    if (input.action === 'import') {
      const consumed = this.#consumeFundingFile(input.fileCapabilityId);
      if (!consumed
        || path.dirname(consumed.filePath) !== consumed.trustedRoot
        || !['.pdf', '.docx'].includes(path.extname(consumed.filePath).toLowerCase())) {
        return failure(input, owner.data, 'file_capability_unavailable');
      }
      const imported = await this.#service.importOrReanalyze({
        ownerId: owner.data,
        projectId: input.projectId,
        templateId: input.templateId,
        filePath: consumed.filePath,
        trustedRoot: consumed.trustedRoot,
        expectedTemplateRevision: input.expectedTemplateRevision,
        expectedActiveVersion: input.expectedActiveVersion,
        expectedActiveDigest: input.expectedActiveDigest,
      });
      if (!imported.ok) return failure(input, owner.data, mapServiceFailure(imported.code));
      const loaded = this.#repository.getTemplate(owner.data, input.projectId, input.templateId, true);
      if (!loaded.ok) return failure(input, owner.data, mapFundingTemplateRepositoryFailure(loaded.code));
      const record = loaded.value;
      const versionRecord = record.versions.find((item) => item.version === imported.value.templateVersion);
      const template = projectFundingTemplateSummary(record);
      const version = versionRecord ? projectFundingTemplateVersion(versionRecord) : null;
      const diff = imported.value.templateVersion > 1
        ? projectFundingTemplateDiff(record, imported.value.templateVersion - 1, imported.value.templateVersion)
        : null;
      if (!template || !version || (imported.value.templateVersion > 1 && !diff)) {
        return failure(input, owner.data, 'repository_corrupt');
      }
      return parseResponse({ ok: true, ...identity(input, owner.data), template, version, diff });
    }

    if (input.action === 'list') {
      const listed = this.#repository.listTemplates(owner.data, input.projectId, input.includeArchived);
      if (!listed.ok) return failure(input, owner.data, mapFundingTemplateRepositoryFailure(listed.code));
      const templates = [];
      for (const item of listed.value) {
        const loaded = this.#repository.getTemplate(owner.data, input.projectId, item.templateId, true);
        const projected = loaded.ok ? projectFundingTemplateSummary(loaded.value) : null;
        if (!projected) return failure(input, owner.data, 'repository_corrupt');
        templates.push(projected);
      }
      return parseResponse({ ok: true, ...identity(input, owner.data), templates });
    }

    const loaded = this.#repository.getTemplate(owner.data, input.projectId, input.templateId, true);
    if (!loaded.ok) return failure(input, owner.data, mapFundingTemplateRepositoryFailure(loaded.code));
    const record = loaded.value;

    if (input.action === 'get') {
      if (record.archivedAt !== null) return failure(input, owner.data, 'archived');
      const versionRecord = record.versions.find((item) => item.version === input.templateVersion);
      const template = projectFundingTemplateSummary(record);
      const version = versionRecord && versionRecord.packageDigest === input.packageDigest
        ? projectFundingTemplateVersion(versionRecord)
        : null;
      if (!template || !version) return failure(input, owner.data, 'cas_conflict');
      return parseResponse({ ok: true, ...identity(input, owner.data), template, version });
    }

    if (input.action === 'diff') {
      if (record.archivedAt !== null) return failure(input, owner.data, 'archived');
      const previous = record.versions.find((item) => item.version === input.fromVersion);
      const next = record.versions.find((item) => item.version === input.toVersion);
      if (record.revision !== input.expectedTemplateRevision
        || previous?.packageDigest !== input.fromDigest
        || next?.packageDigest !== input.toDigest) return failure(input, owner.data, 'cas_conflict');
      const diff = projectFundingTemplateDiff(record, input.fromVersion, input.toVersion);
      return diff
        ? parseResponse({ ok: true, ...identity(input, owner.data), diff })
        : failure(input, owner.data, 'repository_corrupt');
    }

    const cas = {
      ownerId: owner.data,
      projectId: input.projectId,
      templateId: input.templateId,
      expectedTemplateRevision: input.expectedTemplateRevision,
      expectedActiveVersion: input.expectedActiveVersion,
      expectedActiveDigest: input.expectedActiveDigest,
    };
    const mutated = input.action === 'activate'
      ? this.#service.activate({ ...cas, targetVersion: input.targetVersion })
      : input.action === 'archive'
        ? this.#service.archive(cas)
        : this.#service.restore(cas);
    if (!mutated.ok) return failure(input, owner.data, mapServiceFailure(mutated.code));
    const template = projectFundingTemplateSummary(mutated.value);
    return template
      ? parseResponse({ ok: true, ...identity(input, owner.data), template })
      : failure(input, owner.data, 'repository_corrupt');
  }
}
