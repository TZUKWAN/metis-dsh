import { z } from 'zod';
import { McpEnvironmentNameSchema } from './McpInstallationContract.js';

export const PERSONALIZATION_SECRET_CONTRACT_VERSION = 1 as const;
export const PERSONALIZATION_SECRET_VALUE_MAX_CHARS = 32_768;
export const PERSONALIZATION_SECRET_MAX_ENTRIES = 128;

// eslint-disable-next-line no-control-regex -- environment secrets must be a single C0/C1-free value
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export const PersonalizationSecretNameSchema = McpEnvironmentNameSchema;
export const PersonalizationSecretRefSchema = z.string()
  .regex(/^\$\{secret:[A-Z_][A-Z0-9_]{0,127}\}$/u)
  .refine((value) => PersonalizationSecretNameSchema.safeParse(value.slice(9, -1)).success, {
    message: 'Secret reference uses a reserved or invalid environment name',
  });
export const PersonalizationSecretValueSchema = z.string()
  .min(1)
  .max(PERSONALIZATION_SECRET_VALUE_MAX_CHARS)
  .refine((value) => value.trim().length > 0 && !CONTROL.test(value), {
    message: 'Secret value is empty or contains control characters',
  });

const OperationIdSchema = z.string().uuid();
const RevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const TimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const PersonalizationSecretMetadataSchema = z.strictObject({
  name: PersonalizationSecretNameSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const PersonalizationSecretSetRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_SECRET_CONTRACT_VERSION),
  operationId: OperationIdSchema,
  expectedRevision: RevisionSchema,
  name: PersonalizationSecretNameSchema,
  value: PersonalizationSecretValueSchema,
});

export const PersonalizationSecretListRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_SECRET_CONTRACT_VERSION),
  operationId: OperationIdSchema,
});

export const PersonalizationSecretRemoveRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_SECRET_CONTRACT_VERSION),
  operationId: OperationIdSchema,
  expectedRevision: RevisionSchema,
  name: PersonalizationSecretNameSchema,
});

const MutationFailureSchema = z.discriminatedUnion('code', [
  z.strictObject({
    ok: z.literal(false),
    contractVersion: z.literal(PERSONALIZATION_SECRET_CONTRACT_VERSION),
    operationId: OperationIdSchema,
    code: z.literal('invalid_request'),
  }),
  z.strictObject({
    ok: z.literal(false),
    contractVersion: z.literal(PERSONALIZATION_SECRET_CONTRACT_VERSION),
    operationId: OperationIdSchema,
    code: z.enum(['storage_unavailable', 'integrity_error', 'io_error', 'not_found', 'capacity_exceeded']),
  }),
  z.strictObject({
    ok: z.literal(false),
    contractVersion: z.literal(PERSONALIZATION_SECRET_CONTRACT_VERSION),
    operationId: OperationIdSchema,
    code: z.literal('revision_conflict'),
    currentRevision: RevisionSchema,
  }),
]);

export const PersonalizationSecretSetResponseSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    contractVersion: z.literal(PERSONALIZATION_SECRET_CONTRACT_VERSION),
    operationId: OperationIdSchema,
    revision: RevisionSchema,
    secret: PersonalizationSecretMetadataSchema,
  }),
  MutationFailureSchema,
]);

export const PersonalizationSecretListResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    contractVersion: z.literal(PERSONALIZATION_SECRET_CONTRACT_VERSION),
    operationId: OperationIdSchema,
    revision: RevisionSchema,
    secrets: z.array(PersonalizationSecretMetadataSchema).max(PERSONALIZATION_SECRET_MAX_ENTRIES),
  }),
  z.strictObject({
    ok: z.literal(false),
    contractVersion: z.literal(PERSONALIZATION_SECRET_CONTRACT_VERSION),
    operationId: OperationIdSchema,
    code: z.enum(['invalid_request', 'storage_unavailable', 'integrity_error', 'io_error']),
  }),
]);

export const PersonalizationSecretRemoveResponseSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    contractVersion: z.literal(PERSONALIZATION_SECRET_CONTRACT_VERSION),
    operationId: OperationIdSchema,
    revision: RevisionSchema,
    removed: z.literal(true),
    name: PersonalizationSecretNameSchema,
  }),
  MutationFailureSchema,
]);

export type PersonalizationSecretMetadata = z.infer<typeof PersonalizationSecretMetadataSchema>;
export type PersonalizationSecretSetRequest = z.infer<typeof PersonalizationSecretSetRequestSchema>;
export type PersonalizationSecretSetResponse = z.infer<typeof PersonalizationSecretSetResponseSchema>;
export type PersonalizationSecretListRequest = z.infer<typeof PersonalizationSecretListRequestSchema>;
export type PersonalizationSecretListResponse = z.infer<typeof PersonalizationSecretListResponseSchema>;
export type PersonalizationSecretRemoveRequest = z.infer<typeof PersonalizationSecretRemoveRequestSchema>;
export type PersonalizationSecretRemoveResponse = z.infer<typeof PersonalizationSecretRemoveResponseSchema>;

const RECOVERY_OPERATION_ID = '00000000-0000-4000-8000-000000000000';

function recoveryOperationId(operationId: string): string {
  return OperationIdSchema.safeParse(operationId).success ? operationId : RECOVERY_OPERATION_ID;
}

export function decodePersonalizationSecretSetResponse(
  raw: unknown,
  operationId = RECOVERY_OPERATION_ID,
): PersonalizationSecretSetResponse {
  const parsed = PersonalizationSecretSetResponseSchema.safeParse(raw);
  return parsed.success ? parsed.data : {
    ok: false,
    contractVersion: PERSONALIZATION_SECRET_CONTRACT_VERSION,
    operationId: recoveryOperationId(operationId),
    code: 'invalid_request',
  };
}

export function decodePersonalizationSecretListResponse(
  raw: unknown,
  operationId = RECOVERY_OPERATION_ID,
): PersonalizationSecretListResponse {
  const parsed = PersonalizationSecretListResponseSchema.safeParse(raw);
  return parsed.success ? parsed.data : {
    ok: false,
    contractVersion: PERSONALIZATION_SECRET_CONTRACT_VERSION,
    operationId: recoveryOperationId(operationId),
    code: 'invalid_request',
  };
}

export function decodePersonalizationSecretRemoveResponse(
  raw: unknown,
  operationId = RECOVERY_OPERATION_ID,
): PersonalizationSecretRemoveResponse {
  const parsed = PersonalizationSecretRemoveResponseSchema.safeParse(raw);
  return parsed.success ? parsed.data : {
    ok: false,
    contractVersion: PERSONALIZATION_SECRET_CONTRACT_VERSION,
    operationId: recoveryOperationId(operationId),
    code: 'invalid_request',
  };
}

export function secretRefForName(name: string): string | undefined {
  const parsed = PersonalizationSecretNameSchema.safeParse(name);
  return parsed.success ? `\${secret:${parsed.data}}` : undefined;
}

export function secretNameFromRef(reference: string): string | undefined {
  const parsed = PersonalizationSecretRefSchema.safeParse(reference);
  return parsed.success ? parsed.data.slice(9, -1) : undefined;
}
