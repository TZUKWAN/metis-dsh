import { z } from 'zod';
import {
  PERSONALIZATION_LIMITS,
  PersonalizationDefinitionSchema,
  PersonalizationDigestSchema,
  PersonalizationIdSchema,
  PersonalizationLocalIdSchema,
  PersonalizationTimestampSchema,
} from './PersonalizationRuntimeContract.js';
import {
  InstalledSkillVersionSchema,
  SkillUrlInstallRequestSchema,
} from './SkillInstallationContract.js';
import {
  MCP_INSTALL_LIMITS,
  McpBuilderRequestSchema,
  McpHttpsUrlSchema,
  McpInstalledRecordSchema,
  McpPackageDigestSchema,
} from './McpInstallationContract.js';
import { EvidenceEnvelopeSchema } from './EvidenceEnvelopeContract.js';
import { FileCapabilityIdSchema } from './FileCapabilityContract.js';

export const PERSONALIZATION_EXTENSION_CONTRACT_VERSION = 1 as const;

function containsUnsafeControl(value: string, multiline: boolean): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x7f && code <= 0x9f) return true;
    if (code < 0x20 && !(multiline && (code === 0x09 || code === 0x0a || code === 0x0d))) return true;
  }
  return false;
}

const SafeLineSchema = z.string().min(1).max(4_096).refine((value) => !containsUnsafeControl(value, false));
const SafeMarkdownSchema = z.string().min(1).max(PERSONALIZATION_LIMITS.markdownChars)
  .refine((value) => !containsUnsafeControl(value, true));
const UniqueToolIdsSchema = z.array(PersonalizationLocalIdSchema).max(PERSONALIZATION_LIMITS.tools)
  .refine((values) => new Set(values).size === values.length);
const UniqueDefinitionIdsSchema = z.array(PersonalizationIdSchema).max(PERSONALIZATION_LIMITS.references)
  .refine((values) => new Set(values).size === values.length);
const UniqueTagsSchema = z.array(SafeLineSchema).max(PERSONALIZATION_LIMITS.tags)
  .refine((values) => new Set(values).size === values.length);

export const ExtensionEvidenceContextSchema = z.strictObject({
  sessionId: PersonalizationLocalIdSchema,
  projectId: PersonalizationLocalIdSchema,
  operationId: z.string().uuid(),
  runManifestDigest: PersonalizationDigestSchema,
  observedAt: PersonalizationTimestampSchema,
});

const ExtensionMutationShape = {
  contractVersion: z.literal(PERSONALIZATION_EXTENSION_CONTRACT_VERSION),
  expectedRevision: z.number().int().min(0).max(PERSONALIZATION_LIMITS.version),
  evidenceContext: ExtensionEvidenceContextSchema,
} as const;

export const MarkdownSkillApplyRequestSchema = z.strictObject({
  ...ExtensionMutationShape,
  mode: z.literal('skill_markdown'),
  id: PersonalizationIdSchema.refine((value) => value.startsWith('user:skills/')),
  name: SafeLineSchema.max(PERSONALIZATION_LIMITS.nameChars),
  description: z.string().max(PERSONALIZATION_LIMITS.descriptionChars)
    .refine((value) => !containsUnsafeControl(value, true)),
  author: SafeLineSchema.max(PERSONALIZATION_LIMITS.nameChars),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u),
  markdown: SafeMarkdownSchema,
  toolIds: UniqueToolIdsSchema.default([]),
  mcpIds: UniqueDefinitionIdsSchema.default([]),
  tags: UniqueTagsSchema.default([]),
  maxTurns: z.number().int().min(1).max(100).default(20),
  inputSchema: z.record(z.string(), z.unknown()).nullable().default(null),
  outputSchema: z.record(z.string(), z.unknown()).nullable().default(null),
});

const PackageSkillExpectedIdSchema = PersonalizationIdSchema
  .refine((value) => value.startsWith('user:skills/'))
  .nullable();
const UrlSkillExpectedIdSchema = PersonalizationIdSchema
  .refine((value) => value.startsWith('url:skills/'))
  .nullable();

function bindInstallIdentityToRevision(
  request: { expectedId: string | null; expectedRevision: number },
  context: z.RefinementCtx,
) {
  const createsDefinition = request.expectedRevision === 0;
  if (createsDefinition !== (request.expectedId === null)) {
    context.addIssue({
      code: 'custom',
      path: ['expectedId'],
      message: createsDefinition
        ? 'New installs cannot target an existing Skill identity'
        : 'Updates require the existing Skill identity',
    });
  }
}

export const PackageSkillApplyRequestSchema = z.strictObject({
  ...ExtensionMutationShape,
  mode: z.literal('skill_package'),
  sourceCapabilityId: FileCapabilityIdSchema,
  expectedId: PackageSkillExpectedIdSchema,
}).superRefine(bindInstallIdentityToRevision);

export const UrlSkillApplyRequestSchema = z.strictObject({
  ...SkillUrlInstallRequestSchema.shape,
  expectedId: UrlSkillExpectedIdSchema,
  mode: z.literal('skill_url'),
  expectedRevision: z.number().int().min(0).max(PERSONALIZATION_LIMITS.version),
  evidenceContext: ExtensionEvidenceContextSchema,
}).superRefine((request, context) => {
  bindInstallIdentityToRevision(request, context);
  try {
    const parsed = new URL(request.url);
    if (parsed.hash.length > 0) context.addIssue({ code: 'custom', path: ['url'], message: 'URL fragments are forbidden' });
    if ([...parsed.searchParams.keys()].some((key) => /(?:token|secret|password|credential|signature|api[_-]?key|access[_-]?key|auth)/iu.test(key))) {
      context.addIssue({ code: 'custom', path: ['url'], message: 'Credential query parameters are forbidden' });
    }
  } catch {
    context.addIssue({ code: 'custom', path: ['url'], message: 'Skill URL is invalid' });
  }
});

export const RequirementsMcpApplyRequestSchema = McpBuilderRequestSchema.extend({
  contractVersion: z.literal(PERSONALIZATION_EXTENSION_CONTRACT_VERSION),
  mode: z.literal('mcp_requirements'),
  definitionId: PersonalizationIdSchema.refine((value) => value.startsWith('generated:mcp/')),
  expectedRevision: z.number().int().min(0).max(PERSONALIZATION_LIMITS.version),
  evidenceContext: ExtensionEvidenceContextSchema,
  runProbe: z.boolean(),
}).strict().superRefine((request, context) => {
  if (request.operationId !== request.evidenceContext.operationId) {
    context.addIssue({ code: 'custom', path: ['operationId'], message: 'Builder and evidence operation IDs must match' });
  }
});

export const UrlMcpApplyRequestSchema = z.strictObject({
  ...ExtensionMutationShape,
  mode: z.literal('mcp_url'),
  definitionId: PersonalizationIdSchema.refine((value) => value.startsWith('url:mcp/')),
  manifestUrl: McpHttpsUrlSchema,
  expectedManifestSha256: McpPackageDigestSchema.nullable(),
}).superRefine((request, context) => {
  try {
    const parsed = new URL(request.manifestUrl);
    if ([...parsed.searchParams.keys()].some((key) => /(?:token|secret|password|credential|signature|api[_-]?key|access[_-]?key|auth)/iu.test(key))) {
      context.addIssue({
        code: 'custom',
        path: ['manifestUrl'],
        message: 'Credential query parameters are forbidden',
      });
    }
  } catch {
    context.addIssue({ code: 'custom', path: ['manifestUrl'], message: 'MCP URL is invalid' });
  }
});

/** Local MCP package directories are consumed once by the main process. */
export const PackageMcpApplyRequestSchema = z.strictObject({
  ...ExtensionMutationShape,
  mode: z.literal('mcp_package'),
  definitionId: PersonalizationIdSchema.refine((value) => value.startsWith('user:mcp/')),
  sourceCapabilityId: FileCapabilityIdSchema,
});

export const PersonalizationExtensionApplyRequestSchema = z.discriminatedUnion('mode', [
  MarkdownSkillApplyRequestSchema,
  PackageSkillApplyRequestSchema,
  UrlSkillApplyRequestSchema,
  RequirementsMcpApplyRequestSchema,
  UrlMcpApplyRequestSchema,
  PackageMcpApplyRequestSchema,
]);

/**
 * Renderer-facing request. Evidence identity is intentionally absent: the
 * Electron main process derives and signs it from the live frame/operation.
 */
export const PersonalizationExtensionIpcRequestSchema = z.discriminatedUnion('mode', [
  MarkdownSkillApplyRequestSchema.omit({ evidenceContext: true }).extend({
    operationId: z.string().uuid(),
  }).strict(),
  z.strictObject({
    contractVersion: z.literal(PERSONALIZATION_EXTENSION_CONTRACT_VERSION),
    mode: z.literal('skill_package'),
    sourceCapabilityId: FileCapabilityIdSchema,
    expectedId: PackageSkillExpectedIdSchema,
    expectedRevision: z.number().int().min(0).max(PERSONALIZATION_LIMITS.version),
    operationId: z.string().uuid(),
  }).superRefine(bindInstallIdentityToRevision),
  z.strictObject({
    ...SkillUrlInstallRequestSchema.shape,
    expectedId: UrlSkillExpectedIdSchema,
    mode: z.literal('skill_url'),
    expectedRevision: z.number().int().min(0).max(PERSONALIZATION_LIMITS.version),
    operationId: z.string().uuid(),
  }).superRefine(bindInstallIdentityToRevision),
  z.strictObject({
    ...McpBuilderRequestSchema.shape,
    contractVersion: z.literal(PERSONALIZATION_EXTENSION_CONTRACT_VERSION),
    mode: z.literal('mcp_requirements'),
    definitionId: PersonalizationIdSchema.refine((value) => value.startsWith('generated:mcp/')),
    expectedRevision: z.number().int().min(0).max(PERSONALIZATION_LIMITS.version),
    runProbe: z.boolean(),
  }),
  z.strictObject({
    ...ExtensionMutationShape,
    evidenceContext: z.never().optional(),
    mode: z.literal('mcp_url'),
    definitionId: PersonalizationIdSchema.refine((value) => value.startsWith('url:mcp/')),
    manifestUrl: McpHttpsUrlSchema,
    expectedManifestSha256: McpPackageDigestSchema.nullable(),
    operationId: z.string().uuid(),
  }).omit({ evidenceContext: true }),
  z.strictObject({
    contractVersion: z.literal(PERSONALIZATION_EXTENSION_CONTRACT_VERSION),
    mode: z.literal('mcp_package'),
    definitionId: PersonalizationIdSchema.refine((value) => value.startsWith('user:mcp/')),
    sourceCapabilityId: FileCapabilityIdSchema,
    expectedRevision: z.number().int().min(0).max(PERSONALIZATION_LIMITS.version),
    operationId: z.string().uuid(),
  }),
]).superRefine((request, context) => {
  if (request.mode !== 'skill_url' && request.mode !== 'mcp_url') return;
  const field = request.mode === 'skill_url' ? 'url' : 'manifestUrl';
  try {
    const rawUrl = request.mode === 'skill_url' ? request.url : request.manifestUrl;
    const parsed = new URL(rawUrl);
    if (parsed.hash.length > 0) {
      context.addIssue({ code: 'custom', path: [field], message: 'URL fragments are forbidden' });
    }
    if ([...parsed.searchParams.keys()].some((key) => /(?:token|secret|password|credential|signature|api[_-]?key|access[_-]?key|auth)/iu.test(key))) {
      context.addIssue({ code: 'custom', path: [field], message: 'Credential query parameters are forbidden' });
    }
  } catch {
    context.addIssue({ code: 'custom', path: [field], message: 'URL is invalid' });
  }
});

export const PersonalizationExtensionModeSchema = z.enum([
  'skill_markdown', 'skill_package', 'skill_url', 'mcp_requirements', 'mcp_url', 'mcp_package',
]);

const ExtensionSuccessSchema = z.strictObject({
  ok: z.literal(true),
  mode: PersonalizationExtensionModeSchema,
  definition: PersonalizationDefinitionSchema,
  evidence: EvidenceEnvelopeSchema,
  skillInstallation: InstalledSkillVersionSchema.nullable(),
  mcpInstallation: McpInstalledRecordSchema.nullable(),
}).superRefine((result, context) => {
  const skillMode = result.mode.startsWith('skill_');
  if (result.mode === 'skill_markdown' && result.skillInstallation !== null) {
    context.addIssue({ code: 'custom', path: ['skillInstallation'], message: 'Markdown skills have no package installation' });
  }
  if ((result.mode === 'skill_package' || result.mode === 'skill_url') && result.skillInstallation === null) {
    context.addIssue({ code: 'custom', path: ['skillInstallation'], message: 'Installed skills require installation provenance' });
  }
  if (skillMode && result.mcpInstallation !== null) {
    context.addIssue({ code: 'custom', path: ['mcpInstallation'], message: 'Skill results cannot contain an MCP installation' });
  }
  if (!skillMode && (result.mcpInstallation === null || result.skillInstallation !== null)) {
    context.addIssue({ code: 'custom', path: ['mcpInstallation'], message: 'MCP results require exactly one MCP installation' });
  }
});

export const PersonalizationExtensionFailureCodeSchema = z.enum([
  'invalid_request',
  'skill_install_failed',
  'mcp_install_failed',
  'mcp_builder_failed',
  'package_identity_rejected',
  'package_content_rejected',
  'evidence_unavailable',
  'definition_rejected',
  'probe_required',
  'compensation_failed',
]);

const ExtensionFailureSchema = z.strictObject({
  ok: z.literal(false),
  mode: PersonalizationExtensionModeSchema.nullable(),
  code: PersonalizationExtensionFailureCodeSchema,
  detailCode: SafeLineSchema.max(512).nullable(),
  compensated: z.boolean(),
});

export const PersonalizationExtensionApplyResponseSchema = z.union([
  ExtensionSuccessSchema,
  ExtensionFailureSchema,
]);

export type ExtensionEvidenceContext = z.infer<typeof ExtensionEvidenceContextSchema>;
export type MarkdownSkillApplyRequest = z.infer<typeof MarkdownSkillApplyRequestSchema>;
export type PackageSkillApplyRequest = z.infer<typeof PackageSkillApplyRequestSchema>;
export type UrlSkillApplyRequest = z.infer<typeof UrlSkillApplyRequestSchema>;
export type RequirementsMcpApplyRequest = z.infer<typeof RequirementsMcpApplyRequestSchema>;
export type UrlMcpApplyRequest = z.infer<typeof UrlMcpApplyRequestSchema>;
export type PackageMcpApplyRequest = z.infer<typeof PackageMcpApplyRequestSchema>;
export type PersonalizationExtensionApplyRequest = z.infer<typeof PersonalizationExtensionApplyRequestSchema>;
export type PersonalizationExtensionIpcRequest = z.infer<typeof PersonalizationExtensionIpcRequestSchema>;
export type PersonalizationExtensionApplyResponse = z.infer<typeof PersonalizationExtensionApplyResponseSchema>;

export const PERSONALIZATION_EXTENSION_LIMITS = Object.freeze({
  mcpRequirementChars: MCP_INSTALL_LIMITS.requirement,
  definitionChars: PERSONALIZATION_LIMITS.markdownChars,
} as const);

export function decodePersonalizationExtensionRequest(raw: unknown): PersonalizationExtensionApplyRequest | undefined {
  const parsed = PersonalizationExtensionApplyRequestSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function decodePersonalizationExtensionIpcRequest(raw: unknown): PersonalizationExtensionIpcRequest | undefined {
  const parsed = PersonalizationExtensionIpcRequestSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function decodePersonalizationExtensionResponse(raw: unknown): PersonalizationExtensionApplyResponse {
  const parsed = PersonalizationExtensionApplyResponseSchema.safeParse(raw);
  return parsed.success
    ? parsed.data
    : { ok: false, mode: null, code: 'invalid_request', detailCode: 'invalid_response', compensated: false };
}
