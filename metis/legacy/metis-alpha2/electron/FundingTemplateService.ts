import { z } from 'zod';
import { analyzeFundingTemplate, verifyFundingTemplatePackage } from '../engine/personalization/FundingTemplateAnalyzer.js';
import { FundingTemplateSafeIdSchema, FundingTemplateTimestampSchema, type FundingTemplateDiff, type FundingTemplatePackage } from '../engine/runtime/FundingTemplateContract.js';
import { observeFundingTemplateFile, type FundingTemplateObservationAdapterResult } from './FundingTemplateObservationAdapter.js';
import {
  FundingTemplateRepository,
  type FundingTemplateActivateRequest,
  type FundingTemplateCASRequest,
  type FundingTemplateListItem,
  type FundingTemplateRepositoryFailureCode,
  type FundingTemplateRepositoryResult,
  type FundingTemplateStoredRecord,
} from './FundingTemplateRepository.js';

const DIGEST = /^[a-f0-9]{64}$/u;
// eslint-disable-next-line no-control-regex -- trusted local path request rejects C0/C1 controls
const UNSAFE_PATH_TEXT = new RegExp('[\\x00-\\x1f\\x7f-\\x9f]', 'u');

export const FundingTemplateImportRequestSchema = z.strictObject({
  ownerId: FundingTemplateSafeIdSchema,
  projectId: FundingTemplateSafeIdSchema,
  templateId: FundingTemplateSafeIdSchema,
  filePath: z.string().min(1).max(32_768).refine((value) => !UNSAFE_PATH_TEXT.test(value)),
  trustedRoot: z.string().min(1).max(32_768).refine((value) => !UNSAFE_PATH_TEXT.test(value)),
  expectedTemplateRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  expectedActiveVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  expectedActiveDigest: z.string().regex(DIGEST).nullable(),
}).superRefine((request, context) => {
  const creating = request.expectedTemplateRevision === 0;
  if (creating !== (request.expectedActiveVersion === null && request.expectedActiveDigest === null)) {
    context.addIssue({ code: 'custom', message: 'Creation and update CAS fields are inconsistent' });
  }
});

export type FundingTemplateServiceFailureCode =
  | 'invalid_request'
  | 'not_found'
  | 'archived'
  | 'cas_conflict'
  | 'source_unchanged'
  | 'observation_failed'
  | 'docx_layout_unobservable'
  | 'analysis_failed'
  | 'package_invalid'
  | 'sensitive_content'
  | 'repository_busy'
  | 'repository_corrupt'
  | 'persist_failed';

export type FundingTemplateServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: FundingTemplateServiceFailureCode };

export interface FundingTemplateImportReceipt {
  ownerId: string;
  projectId: string;
  templateId: string;
  templateVersion: number;
  templateRevision: number;
  activeVersion: number;
  packageDigest: string;
  sourceDigest: string;
  quality: FundingTemplatePackage['quality'];
  diffFromPrevious: FundingTemplateDiff | null;
}

export interface FundingTemplateServiceDependencies {
  observeFile?: (request: unknown) => Promise<FundingTemplateObservationAdapterResult>;
  analyze?: typeof analyzeFundingTemplate;
  verify?: typeof verifyFundingTemplatePackage;
  now?: () => number;
}

function activePackage(record: FundingTemplateStoredRecord): FundingTemplatePackage {
  const version = record.versions.find((candidate) => candidate.version === record.activeVersion);
  if (!version) throw new Error('Active package is missing');
  return version.template;
}

function mapRepositoryFailure(code: FundingTemplateRepositoryFailureCode): FundingTemplateServiceFailureCode {
  if (code === 'not_found') return 'not_found';
  if (code === 'archived') return 'archived';
  if (code === 'cas_conflict' || code === 'already_exists' || code === 'version_conflict') return 'cas_conflict';
  if (code === 'source_unchanged') return 'source_unchanged';
  if (code === 'invalid_package') return 'package_invalid';
  if (code === 'sensitive_content') return 'sensitive_content';
  if (code === 'repository_busy') return 'repository_busy';
  if (code === 'repository_corrupt') return 'repository_corrupt';
  if (code === 'invalid_request') return 'invalid_request';
  return 'persist_failed';
}

function mapRepositoryResult<T>(
  result: FundingTemplateRepositoryResult<T>,
): FundingTemplateServiceResult<T> {
  return result.ok ? result : { ok: false, code: mapRepositoryFailure(result.code) };
}

export class FundingTemplateService {
  private readonly observeFile: NonNullable<FundingTemplateServiceDependencies['observeFile']>;
  private readonly analyze: NonNullable<FundingTemplateServiceDependencies['analyze']>;
  private readonly verify: NonNullable<FundingTemplateServiceDependencies['verify']>;
  private readonly now: () => number;

  constructor(
    private readonly repository: FundingTemplateRepository,
    dependencies: FundingTemplateServiceDependencies = {},
  ) {
    this.observeFile = dependencies.observeFile ?? observeFundingTemplateFile;
    this.analyze = dependencies.analyze ?? analyzeFundingTemplate;
    this.verify = dependencies.verify ?? verifyFundingTemplatePackage;
    this.now = dependencies.now ?? Date.now;
  }

  async importOrReanalyze(raw: unknown): Promise<FundingTemplateServiceResult<FundingTemplateImportReceipt>> {
    const request = FundingTemplateImportRequestSchema.safeParse(raw);
    if (!request.success) return { ok: false, code: 'invalid_request' };
    const input = request.data;
    const existingResult = this.repository.getTemplate(input.ownerId, input.projectId, input.templateId, true);
    let existing: FundingTemplateStoredRecord | null = null;
    if (existingResult.ok) {
      existing = existingResult.value;
      if (existing.archivedAt !== null) return { ok: false, code: 'archived' };
      const active = activePackage(existing);
      if (existing.revision !== input.expectedTemplateRevision
        || existing.activeVersion !== input.expectedActiveVersion
        || active.canonicalDigest !== input.expectedActiveDigest) return { ok: false, code: 'cas_conflict' };
    } else if (existingResult.code !== 'not_found') {
      return { ok: false, code: mapRepositoryFailure(existingResult.code) };
    } else if (input.expectedTemplateRevision !== 0) {
      return { ok: false, code: 'cas_conflict' };
    }

    const timestamp = this.now();
    if (!FundingTemplateTimestampSchema.safeParse(timestamp).success) return { ok: false, code: 'invalid_request' };
    const observed = await this.observeFile({
      filePath: input.filePath,
      trustedRoot: input.trustedRoot,
      documentId: input.templateId,
      extractedAt: timestamp,
    });
    if (!observed.ok) {
      return {
        ok: false,
        code: observed.code === 'docx_layout_unobservable' ? 'docx_layout_unobservable' : 'observation_failed',
      };
    }
    const latest = existing?.versions[existing.versions.length - 1] ?? null;
    if (latest && latest.sourceDigest === observed.document.sourceDigest) {
      return { ok: false, code: 'source_unchanged' };
    }
    const templateVersion = (latest?.version ?? 0) + 1;
    const analyzed = this.analyze({
      templateId: input.templateId,
      templateVersion,
      createdAt: timestamp,
      document: observed.document,
    });
    if (!analyzed.ok) return { ok: false, code: 'analysis_failed' };
    const verified = this.verify(analyzed.template);
    if (!verified.ok || !verified.template) return { ok: false, code: 'package_invalid' };
    const saved = this.repository.saveVersion({
      ownerId: input.ownerId,
      projectId: input.projectId,
      template: verified.template,
      expectedTemplateRevision: input.expectedTemplateRevision,
      expectedActiveVersion: input.expectedActiveVersion,
      expectedActiveDigest: input.expectedActiveDigest,
    });
    if (!saved.ok) return { ok: false, code: mapRepositoryFailure(saved.code) };
    const storedVersion = saved.value.versions[saved.value.versions.length - 1];
    if (!storedVersion || storedVersion.version !== templateVersion) return { ok: false, code: 'repository_corrupt' };
    return {
      ok: true,
      value: {
        ownerId: saved.value.ownerId,
        projectId: saved.value.projectId,
        templateId: saved.value.templateId,
        templateVersion: storedVersion.version,
        templateRevision: saved.value.revision,
        activeVersion: saved.value.activeVersion,
        packageDigest: storedVersion.packageDigest,
        sourceDigest: storedVersion.sourceDigest,
        quality: cloneQuality(storedVersion.template.quality),
        diffFromPrevious: storedVersion.diffFromPrevious,
      },
    };
  }

  getActive(ownerId: string, projectId: string, templateId: string): FundingTemplateServiceResult<FundingTemplatePackage> {
    return mapRepositoryResult(this.repository.getActivePackage(ownerId, projectId, templateId));
  }

  list(ownerId: string, projectId: string, includeArchived = false): FundingTemplateServiceResult<FundingTemplateListItem[]> {
    return mapRepositoryResult(this.repository.listTemplates(ownerId, projectId, includeArchived));
  }

  activate(request: FundingTemplateActivateRequest): FundingTemplateServiceResult<FundingTemplateStoredRecord> {
    return mapRepositoryResult(this.repository.activateVersion(request));
  }

  archive(request: FundingTemplateCASRequest): FundingTemplateServiceResult<FundingTemplateStoredRecord> {
    return mapRepositoryResult(this.repository.archive(request));
  }

  restore(request: FundingTemplateCASRequest): FundingTemplateServiceResult<FundingTemplateStoredRecord> {
    return mapRepositoryResult(this.repository.restore(request));
  }
}

function cloneQuality(quality: FundingTemplatePackage['quality']): FundingTemplatePackage['quality'] {
  return { ...quality, issues: [...quality.issues] };
}
