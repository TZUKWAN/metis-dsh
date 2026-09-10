import { z } from 'zod';

export const FILE_CAPABILITY_LIMITS = Object.freeze({
  capabilityIdChars: 80,
  displayNameChars: 240,
  mimeChars: 127,
  operations: 4,
  defaultReadBytes: 8 * 1024 * 1024,
  maxReadBytes: 16 * 1024 * 1024,
  defaultExtractChars: 50_000,
  maxExtractChars: 1_000_000,
  maxImportBytes: 16 * 1024 * 1024,
} as const);

export const FILE_CAPABILITY_UNAVAILABLE = 'file_capability_unavailable' as const;

// eslint-disable-next-line no-control-regex -- control characters are exactly what this boundary rejects
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
// eslint-disable-next-line no-control-regex -- control characters are exactly what this boundary rejects
const UNSAFE_MULTILINE_TEXT_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const PATH_SEPARATOR = /[\\/]/u;
const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu;

function boundedControlFreeText(maxLength: number) {
  return z.string()
    .max(maxLength)
    .refine((value) => !UNSAFE_CONTROL_CHARACTERS.test(value), {
      message: 'Text contains unsafe control characters',
    });
}

function boundedMultilineText(maxLength: number) {
  return z.string()
    .max(maxLength)
    .refine((value) => !UNSAFE_MULTILINE_TEXT_CHARACTERS.test(value), {
      message: 'Text contains unsafe control characters',
    });
}

function parseWithoutThrow<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  try {
    const result = schema.safeParse(input);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

const TimestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const FileCapabilityIdSchema = z.string()
  .min(35)
  .max(FILE_CAPABILITY_LIMITS.capabilityIdChars)
  .regex(/^fc_[A-Za-z0-9_-]{32,64}$/u);

export const FileCapabilityKindSchema = z.enum(['file', 'folder']);

export const FileCapabilityOperationSchema = z.enum([
  'file',
  'folder',
  'read',
  'extract',
]);

export const FileCapabilityDisplayNameSchema = boundedControlFreeText(
  FILE_CAPABILITY_LIMITS.displayNameChars,
)
  .min(1)
  .refine((value) => !PATH_SEPARATOR.test(value), {
    message: 'Display name cannot contain path separators',
  })
  .refine((value) => value !== '.' && value !== '..', {
    message: 'Display name is unavailable',
  });

export const FileCapabilityMimeSchema = boundedControlFreeText(
  FILE_CAPABILITY_LIMITS.mimeChars,
)
  .min(3)
  .regex(MIME_TYPE);

export const FileCapabilityOperationsSchema = z.array(FileCapabilityOperationSchema)
  .min(1)
  .max(FILE_CAPABILITY_LIMITS.operations)
  .superRefine((operations, context) => {
    const seen = new Set<string>();
    operations.forEach((operation, index) => {
      if (seen.has(operation)) {
        context.addIssue({
          code: 'custom',
          message: 'Capability operations must be unique',
          path: [index],
        });
      }
      seen.add(operation);
    });
  });

/** Renderer-safe descriptor. It intentionally never contains a local path. */
export const FileCapabilityDescriptorSchema = z.strictObject({
  capabilityId: FileCapabilityIdSchema,
  kind: FileCapabilityKindSchema,
  mime: FileCapabilityMimeSchema,
  displayName: FileCapabilityDisplayNameSchema,
  operations: FileCapabilityOperationsSchema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
}).superRefine((value, context) => {
  if (value.expiresAt <= value.issuedAt) {
    context.addIssue({
      code: 'custom',
      message: 'Capability expiry must follow issuance',
      path: ['expiresAt'],
    });
  }
  if (value.kind === 'folder' && value.operations.some((operation) => operation !== 'folder')) {
    context.addIssue({
      code: 'custom',
      message: 'Folder capabilities only support folder operations',
      path: ['operations'],
    });
  }
});

export type FileCapabilityDescriptor = z.infer<typeof FileCapabilityDescriptorSchema>;
export type FileCapabilityKind = z.infer<typeof FileCapabilityKindSchema>;
export type FileCapabilityOperation = z.infer<typeof FileCapabilityOperationSchema>;

export const FileCapabilityPurposeSchema = z.enum([
  'artifact-attachment',
  'research-source',
  'analysis-dataset',
  'personalization-skill-package',
  'personalization-skill-directory',
  'personalization-mcp-directory',
  'funding-template',
]);
export type FileCapabilityPurpose = z.infer<typeof FileCapabilityPurposeSchema>;

export const FileCapabilitySelectionRequestSchema = z.strictObject({
  purpose: FileCapabilityPurposeSchema,
});
export type FileCapabilitySelectionRequest = z.infer<
  typeof FileCapabilitySelectionRequestSchema
>;

const ImportedByteArraySchema = z.custom<Uint8Array>(
  (value) => value instanceof Uint8Array
    && value.byteLength > 0
    && value.byteLength <= FILE_CAPABILITY_LIMITS.maxImportBytes,
  { message: 'Imported file payload is unavailable' },
);

export const FileCapabilityImportRequestSchema = z.strictObject({
  purpose: FileCapabilityPurposeSchema,
  displayName: FileCapabilityDisplayNameSchema,
  mime: FileCapabilityMimeSchema,
  data: ImportedByteArraySchema,
}).superRefine((value, context) => {
  if (value.purpose === 'personalization-skill-directory' || value.purpose === 'personalization-mcp-directory') {
    context.addIssue({
      code: 'custom',
      path: ['purpose'],
      message: 'Directory capabilities cannot be created from imported file bytes',
    });
  }
});
export type FileCapabilityImportRequest = z.infer<typeof FileCapabilityImportRequestSchema>;

const FileOperationRequestSchema = z.strictObject({
  capabilityId: FileCapabilityIdSchema,
  operation: z.literal('file'),
});

const FolderOperationRequestSchema = z.strictObject({
  capabilityId: FileCapabilityIdSchema,
  operation: z.literal('folder'),
});

const ReadOperationRequestSchema = z.strictObject({
  capabilityId: FileCapabilityIdSchema,
  operation: z.literal('read'),
  maxBytes: z.number()
    .int()
    .min(1)
    .max(FILE_CAPABILITY_LIMITS.maxReadBytes)
    .default(FILE_CAPABILITY_LIMITS.defaultReadBytes),
});

const ExtractOperationRequestSchema = z.strictObject({
  capabilityId: FileCapabilityIdSchema,
  operation: z.literal('extract'),
  maxChars: z.number()
    .int()
    .min(1)
    .max(FILE_CAPABILITY_LIMITS.maxExtractChars)
    .default(FILE_CAPABILITY_LIMITS.defaultExtractChars),
});

export const FileCapabilityUseRequestSchema = z.discriminatedUnion('operation', [
  FileOperationRequestSchema,
  FolderOperationRequestSchema,
  ReadOperationRequestSchema,
  ExtractOperationRequestSchema,
]);

export type FileCapabilityUseRequest = z.infer<typeof FileCapabilityUseRequestSchema>;

export const FileCapabilityFailureSchema = z.strictObject({
  success: z.literal(false),
  code: z.literal(FILE_CAPABILITY_UNAVAILABLE),
});

export type FileCapabilityFailure = z.infer<typeof FileCapabilityFailureSchema>;

const OpenFileResultSchema = z.strictObject({
  success: z.literal(true),
  operation: z.literal('file'),
  capability: FileCapabilityDescriptorSchema,
});

const OpenFolderResultSchema = z.strictObject({
  success: z.literal(true),
  operation: z.literal('folder'),
  capability: FileCapabilityDescriptorSchema,
});

const BoundedByteArraySchema = z.custom<Uint8Array>(
  (value) => value instanceof Uint8Array
    && value.byteLength <= FILE_CAPABILITY_LIMITS.maxReadBytes,
  { message: 'Binary payload is unavailable' },
);

const ReadResultSchema = z.strictObject({
  success: z.literal(true),
  operation: z.literal('read'),
  capability: FileCapabilityDescriptorSchema,
  data: BoundedByteArraySchema,
});

const ExtractResultSchema = z.strictObject({
  success: z.literal(true),
  operation: z.literal('extract'),
  capability: FileCapabilityDescriptorSchema,
  text: boundedMultilineText(FILE_CAPABILITY_LIMITS.maxExtractChars),
  truncated: z.boolean(),
});

export const FileCapabilityUseResultSchema = z.union([
  OpenFileResultSchema,
  OpenFolderResultSchema,
  ReadResultSchema,
  ExtractResultSchema,
  FileCapabilityFailureSchema,
]);

export type FileCapabilityUseResult = z.infer<typeof FileCapabilityUseResultSchema>;

const FileCapabilitySelectionSuccessSchema = z.strictObject({
  success: z.literal(true),
  capability: FileCapabilityDescriptorSchema,
});

export const FileCapabilitySelectionResultSchema = z.union([
  FileCapabilitySelectionSuccessSchema,
  FileCapabilityFailureSchema,
]);
export type FileCapabilitySelectionResult = z.infer<
  typeof FileCapabilitySelectionResultSchema
>;

export type FileCapabilityRequestDecodeResult =
  | { ok: true; value: FileCapabilityUseRequest }
  | { ok: false; failure: FileCapabilityFailure };

export function createFileCapabilityFailure(): FileCapabilityFailure {
  return { success: false, code: FILE_CAPABILITY_UNAVAILABLE };
}

export function decodeFileCapabilityUseRequest(
  input: unknown,
): FileCapabilityRequestDecodeResult {
  const value = parseWithoutThrow(FileCapabilityUseRequestSchema, input);
  return value === undefined
    ? { ok: false, failure: createFileCapabilityFailure() }
    : { ok: true, value };
}

export function decodeFileCapabilityUseResult(input: unknown): FileCapabilityUseResult {
  return parseWithoutThrow(FileCapabilityUseResultSchema, input)
    ?? createFileCapabilityFailure();
}

export function decodeFileCapabilitySelectionRequest(
  input: unknown,
): FileCapabilitySelectionRequest | undefined {
  return parseWithoutThrow(FileCapabilitySelectionRequestSchema, input);
}

export function decodeFileCapabilityImportRequest(
  input: unknown,
): FileCapabilityImportRequest | undefined {
  return parseWithoutThrow(FileCapabilityImportRequestSchema, input);
}

export function decodeFileCapabilitySelectionResult(
  input: unknown,
): FileCapabilitySelectionResult {
  return parseWithoutThrow(FileCapabilitySelectionResultSchema, input)
    ?? createFileCapabilityFailure();
}
