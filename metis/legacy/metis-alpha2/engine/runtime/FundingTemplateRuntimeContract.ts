import { z } from 'zod';
import { FileCapabilityIdSchema } from './FileCapabilityContract.js';

export const FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION = 1 as const;
export const FUNDING_TEMPLATE_LIST_TOOL_NAME = 'funding_template_list' as const;
export const FUNDING_TEMPLATE_GET_ACTIVE_TOOL_NAME = 'funding_template_get_active' as const;
export const FUNDING_TEMPLATE_GET_DIFF_TOOL_NAME = 'funding_template_get_diff' as const;
const ZERO_OPERATION_ID = '00000000-0000-4000-8000-000000000000' as const;
const DECODE_SCOPE = 'decode-failure' as const;
const MAX_SAFE_REVISION = Number.MAX_SAFE_INTEGER - 1;

const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
// eslint-disable-next-line no-control-regex -- IPC identifiers must reject the complete C0/C1 range
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/u;
const PHONE_NUMBER = /^1[3-9]\d{9}$/u;
const IDENTITY_NUMBER = /^\d{17}[\dXx]$/u;
const SECRET_LIKE = /^(?:api[_-]?key|secret|token)[:_-]/iu;

/**
 * Renderer-visible identifiers are opaque scopes, never paths or user prose.
 * PII-shaped identifiers are rejected so successful responses cannot become a
 * side channel for emails, mobile numbers, identity numbers, or secrets.
 */
export const FundingTemplateRuntimeScopeIdSchema = z.string()
  .regex(SAFE_SCOPE)
  .refine((value) => !CONTROL_CHARACTERS.test(value))
  .refine((value) => !PHONE_NUMBER.test(value) && !IDENTITY_NUMBER.test(value) && !SECRET_LIKE.test(value));

export const FundingTemplateRuntimeDigestSchema = z.string().regex(DIGEST);
const OperationIdSchema = z.string().uuid();
const TimestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const TemplateVersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const TemplateRevisionSchema = z.number().int().min(0).max(MAX_SAFE_REVISION);
const PositiveTemplateRevisionSchema = z.number().int().positive().max(MAX_SAFE_REVISION);

const RequestIdentityShape = {
  contractVersion: z.literal(FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION),
  operationId: OperationIdSchema,
  ownerId: FundingTemplateRuntimeScopeIdSchema,
  projectId: FundingTemplateRuntimeScopeIdSchema,
};

const TemplateIdentityShape = {
  templateId: FundingTemplateRuntimeScopeIdSchema,
};

const CASShape = {
  expectedTemplateRevision: PositiveTemplateRevisionSchema,
  expectedActiveVersion: TemplateVersionSchema,
  expectedActiveDigest: FundingTemplateRuntimeDigestSchema,
};

export const FundingTemplateImportRequestSchema = z.strictObject({
  ...RequestIdentityShape,
  action: z.literal('import'),
  ...TemplateIdentityShape,
  /** Main must atomically consume this capability before resolving its path. */
  fileCapabilityId: FileCapabilityIdSchema,
  capabilityUse: z.literal('consume_once'),
  expectedTemplateRevision: TemplateRevisionSchema,
  expectedActiveVersion: TemplateVersionSchema.nullable(),
  expectedActiveDigest: FundingTemplateRuntimeDigestSchema.nullable(),
}).superRefine((request, context) => {
  const create = request.expectedTemplateRevision === 0;
  const emptyActive = request.expectedActiveVersion === null && request.expectedActiveDigest === null;
  const completeActive = request.expectedActiveVersion !== null && request.expectedActiveDigest !== null;
  if ((create && !emptyActive) || (!create && !completeActive)) {
    context.addIssue({ code: 'custom', message: 'Import CAS tuple is inconsistent' });
  }
});

export const FundingTemplateListRequestSchema = z.strictObject({
  ...RequestIdentityShape,
  action: z.literal('list'),
  includeArchived: z.boolean(),
});

export const FundingTemplateGetRequestSchema = z.strictObject({
  ...RequestIdentityShape,
  action: z.literal('get'),
  ...TemplateIdentityShape,
  templateVersion: TemplateVersionSchema,
  packageDigest: FundingTemplateRuntimeDigestSchema,
});

export const FundingTemplateDiffRequestSchema = z.strictObject({
  ...RequestIdentityShape,
  action: z.literal('diff'),
  ...TemplateIdentityShape,
  expectedTemplateRevision: PositiveTemplateRevisionSchema,
  fromVersion: TemplateVersionSchema,
  toVersion: TemplateVersionSchema,
  fromDigest: FundingTemplateRuntimeDigestSchema,
  toDigest: FundingTemplateRuntimeDigestSchema,
}).superRefine((request, context) => {
  if (request.toVersion !== request.fromVersion + 1) {
    context.addIssue({ code: 'custom', path: ['toVersion'], message: 'Only a persisted adjacent-version diff is addressable' });
  }
  if (request.fromDigest === request.toDigest) {
    context.addIssue({ code: 'custom', path: ['toDigest'], message: 'A stored version diff must advance the package digest' });
  }
});

export const FundingTemplateActivateRequestSchema = z.strictObject({
  ...RequestIdentityShape,
  action: z.literal('activate'),
  ...TemplateIdentityShape,
  ...CASShape,
  targetVersion: TemplateVersionSchema,
});

export const FundingTemplateArchiveRequestSchema = z.strictObject({
  ...RequestIdentityShape,
  action: z.literal('archive'),
  ...TemplateIdentityShape,
  ...CASShape,
});

export const FundingTemplateRestoreRequestSchema = z.strictObject({
  ...RequestIdentityShape,
  action: z.literal('restore'),
  ...TemplateIdentityShape,
  ...CASShape,
});

export const FundingTemplateRuntimeRequestSchema = z.discriminatedUnion('action', [
  FundingTemplateImportRequestSchema,
  FundingTemplateListRequestSchema,
  FundingTemplateGetRequestSchema,
  FundingTemplateDiffRequestSchema,
  FundingTemplateActivateRequestSchema,
  FundingTemplateArchiveRequestSchema,
  FundingTemplateRestoreRequestSchema,
]);

/** Renderer-facing requests deliberately omit ownerId. Electron main derives
 * it from the live main-frame WebContents and binds it before calling the
 * repository/service layer. */
const IpcRequestIdentityShape = {
  contractVersion: z.literal(FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION),
  operationId: OperationIdSchema,
  projectId: FundingTemplateRuntimeScopeIdSchema,
};

export const FundingTemplateImportIpcRequestSchema = z.strictObject({
  ...IpcRequestIdentityShape,
  action: z.literal('import'),
  ...TemplateIdentityShape,
  fileCapabilityId: FileCapabilityIdSchema,
  capabilityUse: z.literal('consume_once'),
  expectedTemplateRevision: TemplateRevisionSchema,
  expectedActiveVersion: TemplateVersionSchema.nullable(),
  expectedActiveDigest: FundingTemplateRuntimeDigestSchema.nullable(),
}).superRefine((request, context) => {
  const create = request.expectedTemplateRevision === 0;
  const emptyActive = request.expectedActiveVersion === null && request.expectedActiveDigest === null;
  const completeActive = request.expectedActiveVersion !== null && request.expectedActiveDigest !== null;
  if ((create && !emptyActive) || (!create && !completeActive)) {
    context.addIssue({ code: 'custom', message: 'Import CAS tuple is inconsistent' });
  }
});
export const FundingTemplateListIpcRequestSchema = z.strictObject({
  ...IpcRequestIdentityShape,
  action: z.literal('list'),
  includeArchived: z.boolean(),
});
export const FundingTemplateGetIpcRequestSchema = z.strictObject({
  ...IpcRequestIdentityShape,
  action: z.literal('get'),
  ...TemplateIdentityShape,
  templateVersion: TemplateVersionSchema,
  packageDigest: FundingTemplateRuntimeDigestSchema,
});
export const FundingTemplateDiffIpcRequestSchema = z.strictObject({
  ...IpcRequestIdentityShape,
  action: z.literal('diff'),
  ...TemplateIdentityShape,
  expectedTemplateRevision: PositiveTemplateRevisionSchema,
  fromVersion: TemplateVersionSchema,
  toVersion: TemplateVersionSchema,
  fromDigest: FundingTemplateRuntimeDigestSchema,
  toDigest: FundingTemplateRuntimeDigestSchema,
}).superRefine((request, context) => {
  if (request.toVersion !== request.fromVersion + 1) {
    context.addIssue({ code: 'custom', path: ['toVersion'], message: 'Only a persisted adjacent-version diff is addressable' });
  }
  if (request.fromDigest === request.toDigest) {
    context.addIssue({ code: 'custom', path: ['toDigest'], message: 'A stored version diff must advance the package digest' });
  }
});
export const FundingTemplateActivateIpcRequestSchema = z.strictObject({
  ...IpcRequestIdentityShape,
  action: z.literal('activate'),
  ...TemplateIdentityShape,
  ...CASShape,
  targetVersion: TemplateVersionSchema,
});
export const FundingTemplateArchiveIpcRequestSchema = z.strictObject({
  ...IpcRequestIdentityShape,
  action: z.literal('archive'),
  ...TemplateIdentityShape,
  ...CASShape,
});
export const FundingTemplateRestoreIpcRequestSchema = z.strictObject({
  ...IpcRequestIdentityShape,
  action: z.literal('restore'),
  ...TemplateIdentityShape,
  ...CASShape,
});
export const FundingTemplateIpcRequestSchema = z.discriminatedUnion('action', [
  FundingTemplateImportIpcRequestSchema,
  FundingTemplateListIpcRequestSchema,
  FundingTemplateGetIpcRequestSchema,
  FundingTemplateDiffIpcRequestSchema,
  FundingTemplateActivateIpcRequestSchema,
  FundingTemplateArchiveIpcRequestSchema,
  FundingTemplateRestoreIpcRequestSchema,
]);

export type FundingTemplateImportRequest = z.infer<typeof FundingTemplateImportRequestSchema>;
export type FundingTemplateListRequest = z.infer<typeof FundingTemplateListRequestSchema>;
export type FundingTemplateGetRequest = z.infer<typeof FundingTemplateGetRequestSchema>;
export type FundingTemplateDiffRequest = z.infer<typeof FundingTemplateDiffRequestSchema>;
export type FundingTemplateActivateRequest = z.infer<typeof FundingTemplateActivateRequestSchema>;
export type FundingTemplateArchiveRequest = z.infer<typeof FundingTemplateArchiveRequestSchema>;
export type FundingTemplateRestoreRequest = z.infer<typeof FundingTemplateRestoreRequestSchema>;
export type FundingTemplateRuntimeRequest = z.infer<typeof FundingTemplateRuntimeRequestSchema>;
export type FundingTemplateIpcRequest = z.infer<typeof FundingTemplateIpcRequestSchema>;

const QualityIssueSchema = z.enum([
  'limited_structure',
  'typography_not_observed',
  'margins_not_observed',
  'conflicting_layout_observations',
  'sensitive_content_excluded',
]);

export const FundingTemplateVersionViewSchema = z.strictObject({
  templateVersion: TemplateVersionSchema,
  packageDigest: FundingTemplateRuntimeDigestSchema,
  sourceDigest: FundingTemplateRuntimeDigestSchema,
  observationDigest: FundingTemplateRuntimeDigestSchema,
  savedAt: TimestampSchema,
  sourceFormat: z.enum(['pdf', 'docx']),
  pageCount: z.number().int().positive().max(20_000),
  quality: z.strictObject({
    status: z.enum(['ready', 'needs_review']),
    overallConfidence: z.number().min(0).max(1),
    issues: z.array(QualityIssueSchema).max(32)
      .refine((issues) => new Set(issues).size === issues.length),
  }),
  /** Counts and evidence state only; no headings, instructions, labels, or prose. */
  structure: z.strictObject({
    sectionCount: z.number().int().min(0).max(10_000),
    instructionCount: z.number().int().min(0).max(20_000),
    tableCount: z.number().int().min(0).max(5_000),
    contentSlotCount: z.number().int().min(0).max(20_000),
    fieldMappingCount: z.number().int().min(0).max(20_000),
    typographyRuleCount: z.number().int().min(0).max(3),
    layoutEvidence: z.enum(['observed', 'partial', 'not_observed']),
  }),
});

const FundingTemplateAgentTextSchema = z.string().min(1).max(500)
  .refine((value) => !CONTROL_CHARACTERS.test(value));
const FundingTemplateAgentAssertionStateSchema = z.enum(['observed', 'uncertain', 'not_observed']);

function agentAssertion<T extends z.ZodType>(valueSchema: T) {
  return z.strictObject({
    state: FundingTemplateAgentAssertionStateSchema,
    value: valueSchema.nullable(),
    confidence: z.number().min(0).max(1),
  }).superRefine((assertion, context) => {
    const assertionValue = 'value' in assertion ? assertion.value : null;
    if (assertion.state === 'not_observed') {
      if (assertionValue !== null || assertion.confidence !== 0) {
        context.addIssue({ code: 'custom', message: 'Unobserved Agent assertions cannot carry a value or confidence' });
      }
    } else if (assertionValue === null || assertion.confidence <= 0) {
      context.addIssue({ code: 'custom', message: 'Observed Agent assertions require a value and confidence' });
    }
  });
}

const FundingTemplateAgentRequiredSchema = z.union([z.boolean(), z.null()]);
const FundingTemplateAgentLengthSchema = z.strictObject({
  value: z.number().int().positive().max(10_000_000),
  unit: z.enum(['characters', 'words']),
});
const FundingTemplateAgentStringAssertionSchema = agentAssertion(FundingTemplateAgentTextSchema);
const FundingTemplateAgentNumberAssertionSchema = agentAssertion(z.number().min(0).max(100_000));

/**
 * Agent-only projection of verified, normalized blank-form structure. This is
 * intentionally separate from the renderer/IPC DTO and never contains a file
 * path, raw bytes, raw source text, applicant prose, or evidence excerpts.
 */
export const FundingTemplateAgentStructureSchema = z.strictObject({
  family: z.strictObject({
    code: z.enum(['nssfc', 'moe_humanities', 'custom', 'needs_review']),
    displayName: FundingTemplateAgentTextSchema,
    evidenceState: FundingTemplateAgentAssertionStateSchema,
    confidence: z.number().min(0).max(1),
  }),
  sections: z.array(z.strictObject({
    title: FundingTemplateAgentTextSchema,
    level: z.number().int().min(1).max(6),
    order: z.number().int().min(0).max(511),
    required: FundingTemplateAgentRequiredSchema,
    confidence: z.number().min(0).max(1),
  })).max(512),
  instructions: z.array(z.strictObject({
    sectionTitle: FundingTemplateAgentTextSchema.nullable(),
    kind: z.enum(['required', 'max_length', 'format', 'submission', 'other']),
    text: FundingTemplateAgentTextSchema,
    maxLength: FundingTemplateAgentLengthSchema.nullable(),
    confidence: z.number().min(0).max(1),
  })).max(2_000),
  fields: z.array(z.strictObject({
    sectionTitle: FundingTemplateAgentTextSchema.nullable(),
    label: FundingTemplateAgentTextSchema,
    canonicalField: z.enum([
      'project_name',
      'applicant',
      'organization',
      'discipline',
      'research_basis',
      'research_objectives',
      'research_methods',
      'research_plan',
      'expected_outputs',
      'budget',
      'schedule',
      'references',
      'custom',
    ]),
    kind: z.enum(['plain_text', 'rich_text', 'number', 'date', 'table', 'attachment', 'unknown']),
    required: FundingTemplateAgentRequiredSchema,
    maxLength: FundingTemplateAgentLengthSchema.nullable(),
  })).max(4_000),
  tables: z.array(z.strictObject({
    sectionTitle: FundingTemplateAgentTextSchema.nullable(),
    rowCount: z.number().int().positive().max(10_000),
    columnCount: z.number().int().positive().max(10_000),
    headers: z.array(z.strictObject({
      columnIndex: z.number().int().min(0).max(10_000),
      label: FundingTemplateAgentTextSchema,
    })).max(10_000),
  })).max(1_000),
  layout: z.strictObject({
    pageSizePt: agentAssertion(z.strictObject({
      widthPt: z.number().positive().max(100_000),
      heightPt: z.number().positive().max(100_000),
    })),
    marginsPt: agentAssertion(z.strictObject({
      top: z.number().min(0).max(10_000),
      right: z.number().min(0).max(10_000),
      bottom: z.number().min(0).max(10_000),
      left: z.number().min(0).max(10_000),
    })),
    typography: z.array(z.strictObject({
      scope: z.enum(['document_body', 'section_heading', 'table']),
      fontFamily: FundingTemplateAgentStringAssertionSchema,
      fontSizePt: FundingTemplateAgentNumberAssertionSchema,
      fontWeight: FundingTemplateAgentStringAssertionSchema,
      alignment: FundingTemplateAgentStringAssertionSchema,
      lineSpacingPt: FundingTemplateAgentNumberAssertionSchema,
      paragraphBeforePt: FundingTemplateAgentNumberAssertionSchema,
      paragraphAfterPt: FundingTemplateAgentNumberAssertionSchema,
    })).max(3),
  }),
});

export type FundingTemplateAgentStructure = z.infer<typeof FundingTemplateAgentStructureSchema>;

export const FundingTemplateSummarySchema = z.strictObject({
  ownerId: FundingTemplateRuntimeScopeIdSchema,
  projectId: FundingTemplateRuntimeScopeIdSchema,
  templateId: FundingTemplateRuntimeScopeIdSchema,
  templateRevision: PositiveTemplateRevisionSchema,
  activeVersion: TemplateVersionSchema,
  activeDigest: FundingTemplateRuntimeDigestSchema,
  latestVersion: TemplateVersionSchema,
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
}).superRefine((template, context) => {
  if (template.activeVersion > template.latestVersion) {
    context.addIssue({ code: 'custom', path: ['activeVersion'], message: 'Active version cannot exceed latest version' });
  }
  if (template.updatedAt < template.createdAt
    || (template.archivedAt !== null && template.archivedAt < template.createdAt)) {
    context.addIssue({ code: 'custom', message: 'Template timestamps are not monotonic' });
  }
});

const DiffChangeSchema = z.strictObject({
  kind: z.enum(['added', 'removed', 'changed']),
  entity: z.enum(['source', 'section', 'instruction', 'table', 'content_slot', 'field_mapping', 'typography', 'layout', 'quality']),
  /** SHA-256 of the internal stable key, not a source label or document text. */
  entityKeyDigest: FundingTemplateRuntimeDigestSchema,
  beforeDigest: FundingTemplateRuntimeDigestSchema.nullable(),
  afterDigest: FundingTemplateRuntimeDigestSchema.nullable(),
}).superRefine((change, context) => {
  const valid = change.kind === 'added'
    ? change.beforeDigest === null && change.afterDigest !== null
    : change.kind === 'removed'
      ? change.beforeDigest !== null && change.afterDigest === null
      : change.beforeDigest !== null && change.afterDigest !== null && change.beforeDigest !== change.afterDigest;
  if (!valid) context.addIssue({ code: 'custom', message: 'Diff change digest tuple is inconsistent' });
});

export const FundingTemplateDiffViewSchema = z.strictObject({
  schemaVersion: z.literal(1),
  templateId: FundingTemplateRuntimeScopeIdSchema,
  fromVersion: TemplateVersionSchema,
  toVersion: TemplateVersionSchema,
  fromDigest: FundingTemplateRuntimeDigestSchema,
  toDigest: FundingTemplateRuntimeDigestSchema,
  changes: z.array(DiffChangeSchema).max(20_000),
  breaking: z.boolean(),
  diffDigest: FundingTemplateRuntimeDigestSchema,
}).superRefine((diff, context) => {
  if (diff.toVersion !== diff.fromVersion + 1 || diff.fromDigest === diff.toDigest) {
    context.addIssue({ code: 'custom', message: 'Diff version or digest binding is inconsistent' });
  }
});

export const FundingTemplateRuntimeFailureCodeSchema = z.enum([
  'invalid_request',
  'file_capability_unavailable',
  'not_found',
  'archived',
  'cas_conflict',
  'source_unchanged',
  'observation_failed',
  'docx_layout_unobservable',
  'analysis_failed',
  'package_invalid',
  'sensitive_content',
  'repository_busy',
  'repository_corrupt',
  'persist_failed',
  'response_invalid',
]);
export type FundingTemplateRuntimeFailureCode = z.infer<typeof FundingTemplateRuntimeFailureCodeSchema>;

const ResponseIdentityShape = {
  contractVersion: z.literal(FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION),
  operationId: OperationIdSchema,
  ownerId: FundingTemplateRuntimeScopeIdSchema,
  projectId: FundingTemplateRuntimeScopeIdSchema,
};

type FundingTemplateRuntimeAction = FundingTemplateRuntimeRequest['action'];

function failureSchema<Action extends FundingTemplateRuntimeAction>(action: Action) {
  return z.strictObject({
    ok: z.literal(false),
    ...ResponseIdentityShape,
    action: z.literal(action),
    code: FundingTemplateRuntimeFailureCodeSchema,
  });
}

function sameScope(
  envelope: { ownerId: string; projectId: string },
  template: { ownerId: string; projectId: string },
  context: z.RefinementCtx,
): void {
  if (envelope.ownerId !== template.ownerId || envelope.projectId !== template.projectId) {
    context.addIssue({ code: 'custom', path: ['template'], message: 'Template scope does not match the response envelope' });
  }
}

const FundingTemplateImportSuccessSchema = z.strictObject({
  ok: z.literal(true),
  ...ResponseIdentityShape,
  action: z.literal('import'),
  template: FundingTemplateSummarySchema,
  version: FundingTemplateVersionViewSchema,
  diff: FundingTemplateDiffViewSchema.nullable(),
}).superRefine((response, context) => {
  sameScope(response, response.template, context);
  if (response.template.latestVersion !== response.version.templateVersion
    || response.template.activeVersion !== response.version.templateVersion
    || response.template.activeDigest !== response.version.packageDigest) {
    context.addIssue({ code: 'custom', path: ['version'], message: 'Imported version is not bound to active template state' });
  }
  if (response.diff === null) {
    if (response.version.templateVersion !== 1) context.addIssue({ code: 'custom', path: ['diff'], message: 'Reanalysis requires a stored diff' });
  } else if (response.diff.templateId !== response.template.templateId
    || response.diff.toVersion !== response.version.templateVersion
    || response.diff.toDigest !== response.version.packageDigest) {
    context.addIssue({ code: 'custom', path: ['diff'], message: 'Import diff is not bound to the imported version' });
  }
});

const FundingTemplateListSuccessSchema = z.strictObject({
  ok: z.literal(true),
  ...ResponseIdentityShape,
  action: z.literal('list'),
  templates: z.array(FundingTemplateSummarySchema).max(2_000),
}).superRefine((response, context) => {
  response.templates.forEach((template, index) => {
    if (response.ownerId !== template.ownerId || response.projectId !== template.projectId) {
      context.addIssue({ code: 'custom', path: ['templates', index], message: 'Listed template crosses the response scope' });
    }
  });
});

const FundingTemplateGetSuccessShape = {
  ok: z.literal(true),
  ...ResponseIdentityShape,
  action: z.literal('get'),
  template: FundingTemplateSummarySchema,
  version: FundingTemplateVersionViewSchema,
};

function validateGetSuccess(
  response: { ownerId: string; projectId: string; template: FundingTemplateSummary; version: FundingTemplateVersionView },
  context: z.RefinementCtx,
): void {
  sameScope(response, response.template, context);
  if (response.version.templateVersion > response.template.latestVersion) {
    context.addIssue({ code: 'custom', path: ['version'], message: 'Returned version is outside template history' });
  }
}

const FundingTemplateGetSuccessSchema = z.strictObject(FundingTemplateGetSuccessShape)
  .superRefine(validateGetSuccess);

const FundingTemplateToolGetSuccessSchema = z.strictObject({
  ...FundingTemplateGetSuccessShape,
  agentStructure: FundingTemplateAgentStructureSchema,
}).superRefine(validateGetSuccess);

const FundingTemplateDiffSuccessSchema = z.strictObject({
  ok: z.literal(true),
  ...ResponseIdentityShape,
  action: z.literal('diff'),
  diff: FundingTemplateDiffViewSchema,
});

function mutationSuccessSchema<Action extends 'activate' | 'archive' | 'restore'>(action: Action) {
  return z.strictObject({
    ok: z.literal(true),
    ...ResponseIdentityShape,
    action: z.literal(action),
    template: FundingTemplateSummarySchema,
  }).superRefine((response, context) => sameScope(response, response.template, context));
}

export const FundingTemplateImportResponseSchema = z.union([
  FundingTemplateImportSuccessSchema,
  failureSchema('import'),
]);
export const FundingTemplateListResponseSchema = z.union([
  FundingTemplateListSuccessSchema,
  failureSchema('list'),
]);
export const FundingTemplateGetResponseSchema = z.union([
  FundingTemplateGetSuccessSchema,
  failureSchema('get'),
]);
export const FundingTemplateToolGetResponseSchema = z.union([
  FundingTemplateToolGetSuccessSchema,
  failureSchema('get'),
]);
export const FundingTemplateDiffResponseSchema = z.union([
  FundingTemplateDiffSuccessSchema,
  failureSchema('diff'),
]);
export const FundingTemplateActivateResponseSchema = z.union([
  mutationSuccessSchema('activate'),
  failureSchema('activate'),
]);
export const FundingTemplateArchiveResponseSchema = z.union([
  mutationSuccessSchema('archive'),
  failureSchema('archive'),
]);
export const FundingTemplateRestoreResponseSchema = z.union([
  mutationSuccessSchema('restore'),
  failureSchema('restore'),
]);

export const FundingTemplateRuntimeResponseSchema = z.union([
  FundingTemplateImportResponseSchema,
  FundingTemplateListResponseSchema,
  FundingTemplateGetResponseSchema,
  FundingTemplateDiffResponseSchema,
  FundingTemplateActivateResponseSchema,
  FundingTemplateArchiveResponseSchema,
  FundingTemplateRestoreResponseSchema,
]);

export type FundingTemplateImportResponse = z.infer<typeof FundingTemplateImportResponseSchema>;
export type FundingTemplateListResponse = z.infer<typeof FundingTemplateListResponseSchema>;
export type FundingTemplateGetResponse = z.infer<typeof FundingTemplateGetResponseSchema>;
export type FundingTemplateToolGetResponse = z.infer<typeof FundingTemplateToolGetResponseSchema>;
export type FundingTemplateDiffResponse = z.infer<typeof FundingTemplateDiffResponseSchema>;
export type FundingTemplateActivateResponse = z.infer<typeof FundingTemplateActivateResponseSchema>;
export type FundingTemplateArchiveResponse = z.infer<typeof FundingTemplateArchiveResponseSchema>;
export type FundingTemplateRestoreResponse = z.infer<typeof FundingTemplateRestoreResponseSchema>;
export type FundingTemplateRuntimeResponse = z.infer<typeof FundingTemplateRuntimeResponseSchema>;
export type FundingTemplateVersionView = z.infer<typeof FundingTemplateVersionViewSchema>;
export type FundingTemplateSummary = z.infer<typeof FundingTemplateSummarySchema>;
export type FundingTemplateDiffView = z.infer<typeof FundingTemplateDiffViewSchema>;

function parseWithoutThrow<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  try {
    const result = schema.safeParse(input);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function decodeFundingTemplateIpcRequest(input: unknown): FundingTemplateIpcRequest | undefined {
  return parseWithoutThrow(FundingTemplateIpcRequestSchema, input);
}

export function decodeFundingTemplateImportRequest(input: unknown): FundingTemplateImportRequest | undefined {
  return parseWithoutThrow(FundingTemplateImportRequestSchema, input);
}
export function decodeFundingTemplateListRequest(input: unknown): FundingTemplateListRequest | undefined {
  return parseWithoutThrow(FundingTemplateListRequestSchema, input);
}
export function decodeFundingTemplateGetRequest(input: unknown): FundingTemplateGetRequest | undefined {
  return parseWithoutThrow(FundingTemplateGetRequestSchema, input);
}
export function decodeFundingTemplateDiffRequest(input: unknown): FundingTemplateDiffRequest | undefined {
  return parseWithoutThrow(FundingTemplateDiffRequestSchema, input);
}
export function decodeFundingTemplateActivateRequest(input: unknown): FundingTemplateActivateRequest | undefined {
  return parseWithoutThrow(FundingTemplateActivateRequestSchema, input);
}
export function decodeFundingTemplateArchiveRequest(input: unknown): FundingTemplateArchiveRequest | undefined {
  return parseWithoutThrow(FundingTemplateArchiveRequestSchema, input);
}
export function decodeFundingTemplateRestoreRequest(input: unknown): FundingTemplateRestoreRequest | undefined {
  return parseWithoutThrow(FundingTemplateRestoreRequestSchema, input);
}

function fixedFailure<Action extends FundingTemplateRuntimeAction>(action: Action) {
  return {
    ok: false as const,
    contractVersion: FUNDING_TEMPLATE_RUNTIME_CONTRACT_VERSION,
    action,
    operationId: ZERO_OPERATION_ID,
    ownerId: DECODE_SCOPE,
    projectId: DECODE_SCOPE,
    code: 'response_invalid' as const,
  };
}

export function decodeFundingTemplateImportResponse(input: unknown): FundingTemplateImportResponse {
  return parseWithoutThrow(FundingTemplateImportResponseSchema, input) ?? fixedFailure('import');
}
export function decodeFundingTemplateListResponse(input: unknown): FundingTemplateListResponse {
  return parseWithoutThrow(FundingTemplateListResponseSchema, input) ?? fixedFailure('list');
}
export function decodeFundingTemplateGetResponse(input: unknown): FundingTemplateGetResponse {
  return parseWithoutThrow(FundingTemplateGetResponseSchema, input) ?? fixedFailure('get');
}
export function decodeFundingTemplateDiffResponse(input: unknown): FundingTemplateDiffResponse {
  return parseWithoutThrow(FundingTemplateDiffResponseSchema, input) ?? fixedFailure('diff');
}
export function decodeFundingTemplateActivateResponse(input: unknown): FundingTemplateActivateResponse {
  return parseWithoutThrow(FundingTemplateActivateResponseSchema, input) ?? fixedFailure('activate');
}
export function decodeFundingTemplateArchiveResponse(input: unknown): FundingTemplateArchiveResponse {
  return parseWithoutThrow(FundingTemplateArchiveResponseSchema, input) ?? fixedFailure('archive');
}
export function decodeFundingTemplateRestoreResponse(input: unknown): FundingTemplateRestoreResponse {
  return parseWithoutThrow(FundingTemplateRestoreResponseSchema, input) ?? fixedFailure('restore');
}

export function decodeFundingTemplateRuntimeResponse(input: unknown): FundingTemplateRuntimeResponse {
  return parseWithoutThrow(FundingTemplateRuntimeResponseSchema, input) ?? fixedFailure('list');
}
