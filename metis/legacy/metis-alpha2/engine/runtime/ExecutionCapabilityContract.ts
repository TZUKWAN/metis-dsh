import { z } from 'zod';

export const EXECUTION_CAPABILITY_LIMITS = Object.freeze({
  grantIdChars: 80,
  operationKinds: 3,
} as const);

export const EXECUTION_CAPABILITY_UNAVAILABLE = 'execution_capability_unavailable' as const;
export const EXECUTION_CAPABILITY_AUTHORIZED = 'execution_capability_authorized' as const;

function parseWithoutThrow<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  try {
    const result = schema.safeParse(input);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

const TimestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const ExecutionGrantIdSchema = z.string()
  .min(35)
  .max(EXECUTION_CAPABILITY_LIMITS.grantIdChars)
  .regex(/^eg_[A-Za-z0-9_-]{32,64}$/u);

export const ExecutionOperationKindSchema = z.enum([
  'terminal-session',
  'mcp-server',
  'experiment-script',
]);

export const ExecutionGrantLifetimeSchema = z.enum(['once', 'session']);
export const ExecutionCapabilityActionSchema = z.enum(['execute', 'session-access']);

export const ExecutionGrantDescriptorSchema = z.strictObject({
  grantId: ExecutionGrantIdSchema,
  operation: ExecutionOperationKindSchema,
  lifetime: ExecutionGrantLifetimeSchema,
  consentedAt: TimestampSchema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
}).superRefine((value, context) => {
  if (value.consentedAt > value.issuedAt) {
    context.addIssue({
      code: 'custom',
      message: 'Consent timestamp is unavailable',
      path: ['consentedAt'],
    });
  }
  if (value.expiresAt <= value.issuedAt) {
    context.addIssue({
      code: 'custom',
      message: 'Grant expiry must follow issuance',
      path: ['expiresAt'],
    });
  }
});

export type ExecutionGrantDescriptor = z.infer<typeof ExecutionGrantDescriptorSchema>;
export type ExecutionOperationKind = z.infer<typeof ExecutionOperationKindSchema>;
export type ExecutionGrantLifetime = z.infer<typeof ExecutionGrantLifetimeSchema>;
export type ExecutionCapabilityAction = z.infer<typeof ExecutionCapabilityActionSchema>;

export const ExecutionCapabilityUseRequestSchema = z.strictObject({
  grantId: ExecutionGrantIdSchema,
  operation: ExecutionOperationKindSchema,
  action: ExecutionCapabilityActionSchema,
});

export type ExecutionCapabilityUseRequest = z.infer<
  typeof ExecutionCapabilityUseRequestSchema
>;

export const ExecutionCapabilityFailureSchema = z.strictObject({
  success: z.literal(false),
  code: z.literal(EXECUTION_CAPABILITY_UNAVAILABLE),
});

export type ExecutionCapabilityFailure = z.infer<typeof ExecutionCapabilityFailureSchema>;

export const ExecutionCapabilitySuccessSchema = z.strictObject({
  success: z.literal(true),
  code: z.literal(EXECUTION_CAPABILITY_AUTHORIZED),
  action: ExecutionCapabilityActionSchema,
  grant: ExecutionGrantDescriptorSchema,
});

export type ExecutionCapabilitySuccess = z.infer<typeof ExecutionCapabilitySuccessSchema>;

export const ExecutionCapabilityResultSchema = z.union([
  ExecutionCapabilitySuccessSchema,
  ExecutionCapabilityFailureSchema,
]);

export type ExecutionCapabilityResult = z.infer<typeof ExecutionCapabilityResultSchema>;

export type ExecutionCapabilityRequestDecodeResult =
  | { ok: true; value: ExecutionCapabilityUseRequest }
  | { ok: false; failure: ExecutionCapabilityFailure };

export function createExecutionCapabilityFailure(): ExecutionCapabilityFailure {
  return { success: false, code: EXECUTION_CAPABILITY_UNAVAILABLE };
}

export function decodeExecutionCapabilityUseRequest(
  input: unknown,
): ExecutionCapabilityRequestDecodeResult {
  const value = parseWithoutThrow(ExecutionCapabilityUseRequestSchema, input);
  return value === undefined
    ? { ok: false, failure: createExecutionCapabilityFailure() }
    : { ok: true, value };
}

export function decodeExecutionCapabilityResult(input: unknown): ExecutionCapabilityResult {
  return parseWithoutThrow(ExecutionCapabilityResultSchema, input)
    ?? createExecutionCapabilityFailure();
}
