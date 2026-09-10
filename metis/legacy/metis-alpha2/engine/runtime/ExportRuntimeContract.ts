import { z } from 'zod';
import { FileCapabilityIdSchema } from './FileCapabilityContract.js';
import { RuntimeIdSchema } from './ChatRuntimeContract.js';

export const EXPORT_RUNTIME_LIMITS = Object.freeze({
  exportIdChars: 80,
  displayNameChars: 240,
  scopes: 5,
  issues: 32,
  resultFiles: 32,
  previewEntries: 32,
} as const);

export const EXPORT_RESULT_UNAVAILABLE = 'export_unavailable' as const;
export const EXPORT_RESULT_COMPLETE = 'export_complete' as const;
export const EXPORT_RESULT_PREVIEW_READY = 'export_preview_ready' as const;

// eslint-disable-next-line no-control-regex -- control characters are exactly what this boundary rejects
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function parseWithoutThrow<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  try {
    const result = schema.safeParse(input);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

const TimestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const ExportIdSchema = z.string()
  .min(35)
  .max(EXPORT_RUNTIME_LIMITS.exportIdChars)
  .regex(/^ex_[A-Za-z0-9_-]{32,64}$/u);

export const ExportScopeSchema = z.enum([
  'project',
  'artifact',
  'citations',
  'evidence',
  'audit',
]);

export const ExportFormatSchema = z.enum([
  'markdown',
  'html',
  'docx',
  'pdf',
  'csv',
  'json-bundle',
]);

export const ExportPrivacyProfileSchema = z.enum([
  'private-local',
  'deidentified',
  'public-share',
]);

export const ExportDisplayNameSchema = z.string()
  .min(1)
  .max(EXPORT_RUNTIME_LIMITS.displayNameChars)
  .refine((value) => !UNSAFE_CONTROL_CHARACTERS.test(value), {
    message: 'Export display name contains unsafe control characters',
  })
  .refine((value) => !/[\\/]/u.test(value) && value !== '.' && value !== '..', {
    message: 'Export display name is unavailable',
  });

export const ExportRedactionOptionsSchema = z.strictObject({
  stripSecrets: z.literal(true).default(true),
  stripAbsolutePaths: z.boolean().default(true),
  stripPersonalData: z.boolean().default(true),
  pseudonymizeParticipants: z.boolean().default(true),
  omitRawTranscripts: z.boolean().default(true),
  omitModelPrompts: z.boolean().default(true),
  omitToolArguments: z.boolean().default(true),
});

export const DEFAULT_EXPORT_REDACTION = Object.freeze({
  stripSecrets: true,
  stripAbsolutePaths: true,
  stripPersonalData: true,
  pseudonymizeParticipants: true,
  omitRawTranscripts: true,
  omitModelPrompts: true,
  omitToolArguments: true,
} as const);

export type ExportRedactionOptions = z.infer<typeof ExportRedactionOptionsSchema>;
export type ExportScope = z.infer<typeof ExportScopeSchema>;
export type ExportFormat = z.infer<typeof ExportFormatSchema>;
export type ExportPrivacyProfile = z.infer<typeof ExportPrivacyProfileSchema>;

const ExportScopesSchema = z.array(ExportScopeSchema)
  .min(1)
  .max(EXPORT_RUNTIME_LIMITS.scopes)
  .superRefine((scopes, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < scopes.length; index += 1) {
      const scope = scopes[index];
      if (scope === undefined) continue;
      if (seen.has(scope)) {
        context.addIssue({
          code: 'custom',
          message: 'Export scopes must be unique',
          path: [index],
        });
      }
      seen.add(scope);
    }
  });

export const ExportRequestSchema = z.strictObject({
  exportId: ExportIdSchema,
  projectId: RuntimeIdSchema,
  artifactId: RuntimeIdSchema,
  destinationCapabilityId: FileCapabilityIdSchema,
  displayName: ExportDisplayNameSchema,
  scopes: ExportScopesSchema,
  format: ExportFormatSchema,
  privacyProfile: ExportPrivacyProfileSchema,
  redaction: ExportRedactionOptionsSchema.default(DEFAULT_EXPORT_REDACTION),
  requestedAt: TimestampSchema,
  /** Strict artifact version — must be provided by caller, no default. */
  artifactVersion: z.number().int().min(1),
});

export type ExportRequest = z.infer<typeof ExportRequestSchema>;

/** Main-side request enriched from the immutable repository artifact manifest. */
export const TrustedExportRequestSchema = ExportRequestSchema.extend({
  artifactManifestDigest: z.string().regex(SHA256),
});

export type TrustedExportRequest = z.infer<typeof TrustedExportRequestSchema>;

export const ExportIssueCodeSchema = z.enum([
  'export_invalid_request',
  'export_destination_unavailable',
  'export_format_unsupported',
  'export_snapshot_unavailable',
  'export_artifact_binding_mismatch',
  'export_privacy_blocked',
  'export_limit_exceeded',
  'export_write_failed',
  'export_redaction_applied',
  'export_scope_empty',
  'export_gate_blocked',
  'export_gate_warning',
  'export_render_failed',
]);

export const ExportIssueSchema = z.strictObject({
  code: ExportIssueCodeSchema,
  severity: z.enum(['warning', 'error']),
  scope: ExportScopeSchema.optional(),
});

export type ExportIssue = z.infer<typeof ExportIssueSchema>;

export const ExportResultFileSchema = z.strictObject({
  displayName: ExportDisplayNameSchema,
  mediaType: z.string().min(3).max(127).regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu,
  ),
  byteLength: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(SHA256),
});

export const ExportPreviewEntrySchema = ExportResultFileSchema.extend({
  role: z.enum(['deterministic-candidate', 'html-intermediate']),
});

const ExportSuccessSchema = z.strictObject({
  success: z.literal(true),
  code: z.literal(EXPORT_RESULT_COMPLETE),
  exportId: ExportIdSchema,
  format: ExportFormatSchema,
  artifactId: RuntimeIdSchema,
  artifactVersion: z.number().int().min(1),
  artifactManifestDigest: z.string().regex(SHA256),
  files: z.array(ExportResultFileSchema).min(1).max(EXPORT_RUNTIME_LIMITS.resultFiles),
  manifestSha256: z.string().regex(SHA256),
  issues: z.array(ExportIssueSchema).max(EXPORT_RUNTIME_LIMITS.issues),
});

const ExportPreviewSchema = z.strictObject({
  success: z.literal(true),
  code: z.literal(EXPORT_RESULT_PREVIEW_READY),
  exportId: ExportIdSchema,
  format: ExportFormatSchema,
  artifactId: RuntimeIdSchema,
  artifactVersion: z.number().int().min(1),
  artifactManifestDigest: z.string().regex(SHA256),
  previewKind: z.enum(['deterministic-candidate', 'html-intermediate']),
  entries: z.array(ExportPreviewEntrySchema)
    .min(1)
    .max(EXPORT_RUNTIME_LIMITS.previewEntries),
  issues: z.array(ExportIssueSchema).max(EXPORT_RUNTIME_LIMITS.issues),
}).superRefine((value, context) => {
  const expectedRole = value.previewKind;
  for (let index = 0; index < value.entries.length; index += 1) {
    const entry = value.entries[index];
    if (entry === undefined) continue;
    if (entry.role !== expectedRole) {
      context.addIssue({
        code: 'custom',
        message: 'Export preview entry role does not match preview kind',
        path: ['entries', index, 'role'],
      });
    }
    if (
      value.previewKind === 'html-intermediate'
      && entry.mediaType.toLowerCase() !== 'text/html'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'HTML intermediate preview entries must use text/html',
        path: ['entries', index, 'mediaType'],
      });
    }
  }
});

const ExportFailureSchema = z.strictObject({
  success: z.literal(false),
  code: z.literal(EXPORT_RESULT_UNAVAILABLE),
  issues: z.array(ExportIssueSchema).min(1).max(EXPORT_RUNTIME_LIMITS.issues),
});

export const ExportResultSchema = z.union([
  ExportSuccessSchema,
  ExportPreviewSchema,
  ExportFailureSchema,
]);

export type ExportSuccess = z.infer<typeof ExportSuccessSchema>;
export type ExportPreview = z.infer<typeof ExportPreviewSchema>;
export type ExportFailure = z.infer<typeof ExportFailureSchema>;
export type ExportResult = z.infer<typeof ExportResultSchema>;

export type ExportRequestDecodeResult =
  | { ok: true; value: ExportRequest }
  | { ok: false; failure: ExportFailure };

export function createExportFailure(
  issue: ExportIssue = { code: 'export_invalid_request', severity: 'error' },
): ExportFailure {
  return { success: false, code: EXPORT_RESULT_UNAVAILABLE, issues: [issue] };
}

export function decodeExportRequest(input: unknown): ExportRequestDecodeResult {
  const value = parseWithoutThrow(ExportRequestSchema, input);
  return value === undefined
    ? { ok: false, failure: createExportFailure() }
    : { ok: true, value };
}

export function decodeExportResult(input: unknown): ExportResult {
  return parseWithoutThrow(ExportResultSchema, input) ?? createExportFailure();
}
