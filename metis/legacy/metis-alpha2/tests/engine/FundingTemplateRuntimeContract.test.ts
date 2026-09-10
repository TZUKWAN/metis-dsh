import { describe, expect, it } from 'vitest';
import {
  FundingTemplateActivateRequestSchema,
  FundingTemplateArchiveRequestSchema,
  FundingTemplateDiffRequestSchema,
  FundingTemplateGetRequestSchema,
  FundingTemplateImportIpcRequestSchema,
  FundingTemplateImportRequestSchema,
  FundingTemplateIpcRequestSchema,
  FundingTemplateListRequestSchema,
  FundingTemplateRestoreRequestSchema,
  FundingTemplateRuntimeRequestSchema,
  FundingTemplateRuntimeResponseSchema,
  decodeFundingTemplateActivateRequest,
  decodeFundingTemplateActivateResponse,
  decodeFundingTemplateArchiveRequest,
  decodeFundingTemplateArchiveResponse,
  decodeFundingTemplateDiffRequest,
  decodeFundingTemplateDiffResponse,
  decodeFundingTemplateGetRequest,
  decodeFundingTemplateGetResponse,
  decodeFundingTemplateImportRequest,
  decodeFundingTemplateImportResponse,
  decodeFundingTemplateListRequest,
  decodeFundingTemplateListResponse,
  decodeFundingTemplateRestoreRequest,
  decodeFundingTemplateRestoreResponse,
} from '../../engine/runtime/FundingTemplateRuntimeContract.js';

const OPERATION_ID = '00000000-0000-4000-8000-000000000001';
const CAPABILITY_ID = `fc_${'A'.repeat(32)}`;
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);

const identity = {
  contractVersion: 1 as const,
  operationId: OPERATION_ID,
  ownerId: 'owner-1',
  projectId: 'project-1',
};

const templateSummary = {
  ownerId: 'owner-1',
  projectId: 'project-1',
  templateId: 'user:funding-template-1',
  templateRevision: 2,
  activeVersion: 2,
  activeDigest: DIGEST_B,
  latestVersion: 2,
  archivedAt: null,
  createdAt: 1_900_000_000_000,
  updatedAt: 1_900_000_000_100,
};

const versionView = {
  templateVersion: 2,
  packageDigest: DIGEST_B,
  sourceDigest: DIGEST_C,
  observationDigest: DIGEST_A,
  savedAt: 1_900_000_000_100,
  sourceFormat: 'pdf' as const,
  pageCount: 3,
  quality: {
    status: 'ready' as const,
    overallConfidence: 0.91,
    issues: [] as const,
  },
  structure: {
    sectionCount: 8,
    instructionCount: 12,
    tableCount: 2,
    contentSlotCount: 16,
    fieldMappingCount: 14,
    typographyRuleCount: 3,
    layoutEvidence: 'observed' as const,
  },
};

const diffView = {
  schemaVersion: 1 as const,
  templateId: 'user:funding-template-1',
  fromVersion: 1,
  toVersion: 2,
  fromDigest: DIGEST_A,
  toDigest: DIGEST_B,
  changes: [{
    kind: 'changed' as const,
    entity: 'layout' as const,
    entityKeyDigest: DIGEST_C,
    beforeDigest: DIGEST_A,
    afterDigest: DIGEST_B,
  }],
  breaking: true,
  diffDigest: DIGEST_C,
};

function importRequest() {
  return {
    ...identity,
    action: 'import' as const,
    templateId: 'user:funding-template-1',
    fileCapabilityId: CAPABILITY_ID,
    capabilityUse: 'consume_once' as const,
    expectedTemplateRevision: 0,
    expectedActiveVersion: null,
    expectedActiveDigest: null,
  };
}

function casRequest(action: 'activate' | 'archive' | 'restore') {
  return {
    ...identity,
    action,
    templateId: 'user:funding-template-1',
    expectedTemplateRevision: 2,
    expectedActiveVersion: 2,
    expectedActiveDigest: DIGEST_B,
  };
}

describe('FundingTemplateRuntimeContract strict requests', () => {
  it('accepts all seven real operations with owner, project, template, version, CAS, and operation bindings', () => {
    const requests = [
      importRequest(),
      { ...identity, action: 'list', includeArchived: false },
      {
        ...identity, action: 'get', templateId: 'user:funding-template-1',
        templateVersion: 2, packageDigest: DIGEST_B,
      },
      {
        ...identity, action: 'diff', templateId: 'user:funding-template-1', expectedTemplateRevision: 2,
        fromVersion: 1, toVersion: 2, fromDigest: DIGEST_A, toDigest: DIGEST_B,
      },
      { ...casRequest('activate'), targetVersion: 1 },
      casRequest('archive'),
      casRequest('restore'),
    ];
    expect(requests.map((request) => FundingTemplateRuntimeRequestSchema.safeParse(request).success))
      .toEqual([true, true, true, true, true, true, true]);
  });

  it('requires an opaque, one-time FileCapability identifier and rejects every renderer path or byte channel', () => {
    expect(FundingTemplateImportRequestSchema.safeParse(importRequest()).success).toBe(true);
    for (const attack of [
      { ...importRequest(), fileCapabilityId: 'C:\\private\\application.pdf' },
      { ...importRequest(), filePath: 'C:\\private\\application.pdf' },
      { ...importRequest(), trustedRoot: 'C:\\private' },
      { ...importRequest(), rawDocument: 'applicant narrative' },
      { ...importRequest(), data: new Uint8Array([1, 2, 3]) },
      { ...importRequest(), capabilityUse: 'reuse' },
    ]) expect(FundingTemplateImportRequestSchema.safeParse(attack).success).toBe(false);
  });

  it('enforces creation/update CAS tuples without partial null or renderer-selected version gaps', () => {
    const update = {
      ...importRequest(), expectedTemplateRevision: 3,
      expectedActiveVersion: 2, expectedActiveDigest: DIGEST_B,
    };
    expect(FundingTemplateImportRequestSchema.safeParse(update).success).toBe(true);
    expect(FundingTemplateImportRequestSchema.safeParse({ ...update, expectedActiveDigest: null }).success).toBe(false);
    expect(FundingTemplateImportRequestSchema.safeParse({ ...importRequest(), expectedActiveVersion: 1 }).success).toBe(false);
    expect(FundingTemplateImportRequestSchema.safeParse({ ...update, expectedTemplateRevision: 0 }).success).toBe(false);
  });

  it('requires exact read version/digest and adjacent stored diff bindings', () => {
    const get = {
      ...identity, action: 'get' as const, templateId: 'user:funding-template-1',
      templateVersion: 2, packageDigest: DIGEST_B,
    };
    expect(FundingTemplateGetRequestSchema.safeParse(get).success).toBe(true);
    expect(FundingTemplateGetRequestSchema.safeParse({ ...get, packageDigest: undefined }).success).toBe(false);
    const diff = {
      ...identity, action: 'diff' as const, templateId: 'user:funding-template-1', expectedTemplateRevision: 2,
      fromVersion: 1, toVersion: 2, fromDigest: DIGEST_A, toDigest: DIGEST_B,
    };
    expect(FundingTemplateDiffRequestSchema.safeParse(diff).success).toBe(true);
    expect(FundingTemplateDiffRequestSchema.safeParse({ ...diff, toVersion: 3 }).success).toBe(false);
    expect(FundingTemplateDiffRequestSchema.safeParse({ ...diff, toDigest: DIGEST_A }).success).toBe(false);
  });

  it('strictly rejects extra keys, missing owner scope, unsafe IDs, invalid UUIDs, and loose mutation CAS', () => {
    expect(FundingTemplateListRequestSchema.safeParse({ ...identity, action: 'list', includeArchived: false, path: '/tmp' }).success).toBe(false);
    expect(FundingTemplateListRequestSchema.safeParse({ ...identity, action: 'list', includeArchived: false, ownerId: undefined }).success).toBe(false);
    expect(FundingTemplateListRequestSchema.safeParse({ ...identity, action: 'list', includeArchived: false, operationId: 'operation-1' }).success).toBe(false);
    expect(FundingTemplateListRequestSchema.safeParse({ ...identity, action: 'list', includeArchived: false, ownerId: 'private.person@example.com' }).success).toBe(false);
    expect(FundingTemplateActivateRequestSchema.safeParse({ ...casRequest('activate'), targetVersion: 0 }).success).toBe(false);
    expect(FundingTemplateArchiveRequestSchema.safeParse({ ...casRequest('archive'), expectedActiveDigest: null }).success).toBe(false);
    expect(FundingTemplateRestoreRequestSchema.safeParse({ ...casRequest('restore'), expectedTemplateRevision: 0 }).success).toBe(false);
  });

  it('returns only a validated request or undefined and never reflects malformed input', () => {
    const decoders = [
      decodeFundingTemplateImportRequest,
      decodeFundingTemplateListRequest,
      decodeFundingTemplateGetRequest,
      decodeFundingTemplateDiffRequest,
      decodeFundingTemplateActivateRequest,
      decodeFundingTemplateArchiveRequest,
      decodeFundingTemplateRestoreRequest,
    ];
    for (const decoder of decoders) {
      expect(decoder({ path: 'C:\\private\\application.pdf', applicantText: 'private narrative' })).toBeUndefined();
      expect(decoder(new Proxy({}, { get: () => { throw new Error('hostile getter'); } }))).toBeUndefined();
    }
    expect(decodeFundingTemplateImportRequest(importRequest())).toEqual(importRequest());
  });

  it('keeps renderer IPC owner-blind while preserving strict import CAS and rejecting owner injection', () => {
    const { ownerId: _ownerId, ...rendererImport } = importRequest();
    void _ownerId;
    expect(FundingTemplateImportIpcRequestSchema.safeParse(rendererImport).success).toBe(true);
    expect(FundingTemplateIpcRequestSchema.safeParse(rendererImport).success).toBe(true);
    expect(FundingTemplateImportIpcRequestSchema.safeParse({ ...rendererImport, ownerId: 'attacker' }).success).toBe(false);
    expect(FundingTemplateImportIpcRequestSchema.safeParse({
      ...rendererImport,
      expectedTemplateRevision: 2,
      expectedActiveVersion: null,
      expectedActiveDigest: null,
    }).success).toBe(false);
    expect(FundingTemplateImportIpcRequestSchema.safeParse({ ...rendererImport, filePath: 'C:\\private\\template.pdf' }).success).toBe(false);
  });
});

describe('FundingTemplateRuntimeContract renderer-safe responses', () => {
  const importSuccess = {
    ok: true as const,
    ...identity,
    action: 'import' as const,
    template: templateSummary,
    version: versionView,
    diff: diffView,
  };

  it('accepts content-free import, list, get, diff, activate, archive, and restore envelopes', () => {
    const responses = [
      importSuccess,
      { ok: true, ...identity, action: 'list', templates: [templateSummary] },
      { ok: true, ...identity, action: 'get', template: templateSummary, version: versionView },
      { ok: true, ...identity, action: 'diff', diff: diffView },
      { ok: true, ...identity, action: 'activate', template: { ...templateSummary, activeVersion: 1, activeDigest: DIGEST_A } },
      { ok: true, ...identity, action: 'archive', template: { ...templateSummary, archivedAt: 1_900_000_001_000 } },
      { ok: true, ...identity, action: 'restore', template: templateSummary },
    ];
    expect(responses.map((response) => FundingTemplateRuntimeResponseSchema.safeParse(response).success))
      .toEqual([true, true, true, true, true, true, true]);
  });

  it('rejects applicant prose, PII, absolute paths, raw bytes, and arbitrary error messages anywhere in a response', () => {
    for (const attack of [
      { ...importSuccess, applicantText: 'private applicant narrative' },
      { ...importSuccess, sourcePath: 'C:\\Users\\person\\application.pdf' },
      { ...importSuccess, rawDocument: new Uint8Array([1, 2, 3]) },
      { ...importSuccess, template: { ...templateSummary, ownerId: 'private.person@example.com' } },
      { ...importSuccess, version: { ...versionView, title: 'Applicant health details' } },
      {
        ok: false, ...identity, action: 'import', code: 'observation_failed',
        message: 'C:\\Users\\person\\application.pdf failed for private.person@example.com',
      },
    ]) expect(FundingTemplateRuntimeResponseSchema.safeParse(attack).success).toBe(false);
  });

  it('uses fixed, action-specific, non-reflective decoder fallbacks for malformed or cross-action payloads', () => {
    const malicious = {
      ok: false, contractVersion: 1, action: 'import',
      operationId: 'attacker-operation', ownerId: 'private.person@example.com', projectId: 'C:\\private',
      code: 'C:\\private\\document.pdf', message: 'applicant narrative',
    };
    const decoders = [
      ['import', decodeFundingTemplateImportResponse],
      ['list', decodeFundingTemplateListResponse],
      ['get', decodeFundingTemplateGetResponse],
      ['diff', decodeFundingTemplateDiffResponse],
      ['activate', decodeFundingTemplateActivateResponse],
      ['archive', decodeFundingTemplateArchiveResponse],
      ['restore', decodeFundingTemplateRestoreResponse],
    ] as const;
    for (const [action, decoder] of decoders) {
      const decoded = decoder(malicious);
      expect(decoded).toEqual({
        ok: false,
        contractVersion: 1,
        action,
        operationId: '00000000-0000-4000-8000-000000000000',
        ownerId: 'decode-failure',
        projectId: 'decode-failure',
        code: 'response_invalid',
      });
      expect(JSON.stringify(decoded)).not.toMatch(/attacker|private|applicant/iu);
    }
    expect(decodeFundingTemplateListResponse(importSuccess)).toMatchObject({ ok: false, code: 'response_invalid' });
  });
});
