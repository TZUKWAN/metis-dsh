import { z } from 'zod';
import {
  CHAT_RUNTIME_LIMITS,
  RuntimeIdSchema,
} from './ChatRuntimeContract.js';
import {
  FileCapabilityDescriptorSchema,
  FileCapabilityIdSchema,
} from './FileCapabilityContract.js';

export const ARTIFACT_RUNTIME_LIMITS = Object.freeze({
  items: CHAT_RUNTIME_LIMITS.historyItems,
  nameChars: 240,
  rawNameChars: CHAT_RUNTIME_LIMITS.shortTextChars,
  sizeChars: 64,
  localPathChars: 32_767,
  contentChars: 2_000_000,
} as const);

const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u; // eslint-disable-line no-control-regex
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
const ABSOLUTE_LOCAL_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u;

function boundedControlFreeText(maxLength: number) {
  return z.string()
    .max(maxLength)
    .refine((value) => !UNSAFE_CONTROL_CHARACTERS.test(value), {
      message: 'Text contains unsafe control characters',
    });
}

function safeBasename(value: string): string {
  const withoutUrlMetadata = (value.split(/[?#]/u, 1)[0] ?? '').trim();
  const segments = withoutUrlMetadata.split(/[\\/]/u).filter(Boolean);
  return (segments.at(-1) ?? withoutUrlMetadata).trim();
}

function parseWithoutThrow<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  try {
    const result = schema.safeParse(input);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

const RawArtifactNameSchema = boundedControlFreeText(ARTIFACT_RUNTIME_LIMITS.rawNameChars)
  .min(1);

export const ArtifactDisplayNameSchema = RawArtifactNameSchema
  .transform(safeBasename)
  .pipe(
    boundedControlFreeText(ARTIFACT_RUNTIME_LIMITS.nameChars)
      .min(1)
      .refine((value) => value !== '.' && value !== '..' && !/^[A-Za-z]:$/u.test(value), {
        message: 'Artifact name does not contain a safe basename',
      }),
  );

export const ArtifactTypeSchema = z.enum([
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'md',
  'latex',
  'other',
]);

export const ArtifactSizeSchema = boundedControlFreeText(ARTIFACT_RUNTIME_LIMITS.sizeChars);
export const ArtifactContentSchema = boundedControlFreeText(ARTIFACT_RUNTIME_LIMITS.contentChars);

export const MainLocalPathSchema = boundedControlFreeText(ARTIFACT_RUNTIME_LIMITS.localPathChars)
  .min(1)
  .refine((value) => !URI_SCHEME.test(value), {
    message: 'Local artifact path cannot be a URI',
  })
  .refine((value) => ABSOLUTE_LOCAL_PATH.test(value), {
    message: 'Local artifact path must be absolute',
  });

export const ArtifactCreateRequestSchema = z.strictObject({
  id: RuntimeIdSchema,
  sessionId: RuntimeIdSchema,
  name: ArtifactDisplayNameSchema,
  type: ArtifactTypeSchema,
  sourceCapabilityId: FileCapabilityIdSchema.optional(),
  size: ArtifactSizeSchema.optional(),
});

export type ArtifactCreateRequest = z.infer<typeof ArtifactCreateRequestSchema>;

export const ArtifactListItemSchema = z.strictObject({
  id: RuntimeIdSchema,
  sessionId: RuntimeIdSchema,
  name: ArtifactDisplayNameSchema,
  type: ArtifactTypeSchema,
  size: ArtifactSizeSchema.optional(),
  sourceCapability: FileCapabilityDescriptorSchema.optional(),
  contentAvailable: z.boolean(),
  createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export type ArtifactListItem = z.infer<typeof ArtifactListItemSchema>;

export const ArtifactCreatedNotificationSchema = z.strictObject({
  artifactId: RuntimeIdSchema,
  sessionId: RuntimeIdSchema,
  name: ArtifactDisplayNameSchema,
  type: ArtifactTypeSchema,
  size: ArtifactSizeSchema.optional(),
  sourceCapability: FileCapabilityDescriptorSchema.optional(),
  contentAvailable: z.boolean(),
  createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export type ArtifactCreatedNotification = z.infer<typeof ArtifactCreatedNotificationSchema>;

export const ArtifactRecoverySchema = z.strictObject({
  kind: z.literal('recovery'),
  code: z.enum([
    'artifact_create_request_unavailable',
    'artifact_list_item_unavailable',
    'artifact_notification_unavailable',
    'artifact_content_request_unavailable',
  ]),
});

export type ArtifactRecovery = z.infer<typeof ArtifactRecoverySchema>;

export type ArtifactDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; recovery: ArtifactRecovery };

function decodeWithRecovery<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code: ArtifactRecovery['code'],
): ArtifactDecodeResult<T> {
  const value = parseWithoutThrow(schema, input);
  return value === undefined
    ? { ok: false, recovery: { kind: 'recovery', code } }
    : { ok: true, value };
}

export function decodeArtifactCreateRequest(
  input: unknown,
): ArtifactDecodeResult<ArtifactCreateRequest> {
  return decodeWithRecovery(
    ArtifactCreateRequestSchema,
    input,
    'artifact_create_request_unavailable',
  );
}

export function decodeArtifactListItem(
  input: unknown,
): ArtifactDecodeResult<ArtifactListItem> {
  return decodeWithRecovery(
    ArtifactListItemSchema,
    input,
    'artifact_list_item_unavailable',
  );
}

export function decodeArtifactCreatedNotification(
  input: unknown,
): ArtifactDecodeResult<ArtifactCreatedNotification> {
  return decodeWithRecovery(
    ArtifactCreatedNotificationSchema,
    input,
    'artifact_notification_unavailable',
  );
}

export const ArtifactContentRequestSchema = z.strictObject({
  artifactId: RuntimeIdSchema,
  sessionId: RuntimeIdSchema,
});

export type ArtifactContentRequest = z.infer<typeof ArtifactContentRequestSchema>;

export function decodeArtifactContentRequest(
  input: unknown,
): ArtifactDecodeResult<ArtifactContentRequest> {
  return decodeWithRecovery(
    ArtifactContentRequestSchema,
    input,
    'artifact_content_request_unavailable',
  );
}

const ArtifactContentSuccessSchema = z.strictObject({
  success: z.literal(true),
  id: RuntimeIdSchema,
  sessionId: RuntimeIdSchema,
  name: ArtifactDisplayNameSchema,
  type: ArtifactTypeSchema,
  content: ArtifactContentSchema,
  createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const ArtifactContentFailureSchema = z.strictObject({
  success: z.literal(false),
  code: z.enum(['not_found', 'artifact_content_unavailable']),
});

export const ArtifactContentResponseSchema = z.discriminatedUnion('success', [
  ArtifactContentSuccessSchema,
  ArtifactContentFailureSchema,
]);

export type ArtifactContentResponse = z.infer<typeof ArtifactContentResponseSchema>;

export function createArtifactContentRecovery(): ArtifactContentResponse {
  return { success: false, code: 'artifact_content_unavailable' };
}

export function decodeArtifactContentResponse(input: unknown): ArtifactContentResponse {
  return parseWithoutThrow(ArtifactContentResponseSchema, input)
    ?? createArtifactContentRecovery();
}

const ArtifactListSuccessSchema = z.strictObject({
  success: z.literal(true),
  items: z.array(ArtifactListItemSchema).max(ARTIFACT_RUNTIME_LIMITS.items),
});

const ArtifactListFailureSchema = z.strictObject({
  success: z.literal(false),
  code: z.literal('artifact_list_unavailable'),
  items: z.tuple([]),
});

export const ArtifactListResponseSchema = z.discriminatedUnion('success', [
  ArtifactListSuccessSchema,
  ArtifactListFailureSchema,
]);

export type ArtifactListResponse = z.infer<typeof ArtifactListResponseSchema>;

export function createArtifactListRecovery(): ArtifactListResponse {
  return { success: false, code: 'artifact_list_unavailable', items: [] };
}

export function decodeArtifactListResponse(input: unknown): ArtifactListResponse {
  return parseWithoutThrow(ArtifactListResponseSchema, input) ?? createArtifactListRecovery();
}

/** Safely migrates legacy list arrays while discarding path/metadata extras. */
export function decodeArtifactListPayload(input: unknown): ArtifactListResponse {
  const current = parseWithoutThrow(ArtifactListResponseSchema, input);
  if (current) return current;
  if (!Array.isArray(input) || input.length > ARTIFACT_RUNTIME_LIMITS.items) {
    return createArtifactListRecovery();
  }

  const items: ArtifactListItem[] = [];
  for (const raw of input) {
    if (raw === null || typeof raw !== 'object') return createArtifactListRecovery();
    const record = raw as Record<string, unknown>;
    const decoded = decodeArtifactListItem({
      id: record.id,
      sessionId: record.sessionId,
      name: record.name,
      type: record.type,
      size: record.size,
      sourceCapability: record.sourceCapability,
      contentAvailable: record.contentAvailable ?? false,
      createdAt: record.createdAt,
    });
    if (!decoded.ok) return createArtifactListRecovery();
    items.push(decoded.value);
  }
  return { success: true, items };
}

export const ArtifactMutationCodeSchema = z.enum([
  'created',
  'deleted',
  'not_found',
  'rejected',
  'failed',
  'artifact_mutation_unavailable',
]);

export const ArtifactMutationResultSchema = z.strictObject({
  success: z.boolean(),
  code: ArtifactMutationCodeSchema.optional(),
}).superRefine((value, context) => {
  if (
    value.success
    && value.code !== undefined
    && value.code !== 'created'
    && value.code !== 'deleted'
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Successful artifact mutation may only report created or deleted',
      path: ['code'],
    });
  }
  if (!value.success && (value.code === 'created' || value.code === 'deleted')) {
    context.addIssue({
      code: 'custom',
      message: 'Failed artifact mutation cannot report created or deleted',
      path: ['code'],
    });
  }
});

export type ArtifactMutationResult = z.infer<typeof ArtifactMutationResultSchema>;

export function createArtifactMutationRecovery(): ArtifactMutationResult {
  return { success: false, code: 'artifact_mutation_unavailable' };
}

export function decodeArtifactMutationResult(input: unknown): ArtifactMutationResult {
  return parseWithoutThrow(ArtifactMutationResultSchema, input)
    ?? createArtifactMutationRecovery();
}
