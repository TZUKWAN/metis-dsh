import { z } from 'zod';
import {
  ExecutionGrantDescriptorSchema,
  ExecutionGrantIdSchema,
} from './ExecutionCapabilityContract.js';

export const TERMINAL_RUNTIME_LIMITS = Object.freeze({
  minimumColumns: 2,
  maximumColumns: 500,
  minimumRows: 1,
  maximumRows: 300,
  writeChars: 64 * 1024,
  eventChars: 256 * 1024,
  terminalIdChars: 80,
} as const);

export const TERMINAL_UNAVAILABLE = 'terminal_unavailable' as const;
export const TERMINAL_GRANT_ISSUED = 'terminal_grant_issued' as const;
export const TERMINAL_SESSION_CREATED = 'terminal_session_created' as const;
export const TERMINAL_OPERATION_COMPLETE = 'terminal_operation_complete' as const;

function parseWithoutThrow<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  try {
    const result = schema.safeParse(input);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export const TerminalIdSchema = z.string()
  .min(35)
  .max(TERMINAL_RUNTIME_LIMITS.terminalIdChars)
  .regex(/^ts_[A-Za-z0-9_-]{32,64}$/u);

export const TerminalGrantRequestSchema = z.strictObject({});

export const TerminalSessionGrantSchema = ExecutionGrantDescriptorSchema.superRefine(
  (grant, context) => {
    if (grant.operation !== 'terminal-session' || grant.lifetime !== 'session') {
      context.addIssue({
        code: 'custom',
        message: 'Terminal execution grant is unavailable',
      });
    }
  },
);

export const TerminalCreateRequestSchema = z.strictObject({
  executionGrantId: ExecutionGrantIdSchema,
  cols: z.number()
    .int()
    .min(TERMINAL_RUNTIME_LIMITS.minimumColumns)
    .max(TERMINAL_RUNTIME_LIMITS.maximumColumns),
  rows: z.number()
    .int()
    .min(TERMINAL_RUNTIME_LIMITS.minimumRows)
    .max(TERMINAL_RUNTIME_LIMITS.maximumRows),
});

const TerminalSessionAccessSchema = z.strictObject({
  terminalId: TerminalIdSchema,
  sessionAccessGrantId: ExecutionGrantIdSchema,
});

export const TerminalWriteRequestSchema = TerminalSessionAccessSchema.extend({
  data: z.string()
    .min(1)
    .max(TERMINAL_RUNTIME_LIMITS.writeChars)
    .refine((value) => !value.includes('\u0000'), {
      message: 'Terminal input is unavailable',
    }),
}).strict();

export const TerminalResizeRequestSchema = TerminalSessionAccessSchema.extend({
  cols: z.number()
    .int()
    .min(TERMINAL_RUNTIME_LIMITS.minimumColumns)
    .max(TERMINAL_RUNTIME_LIMITS.maximumColumns),
  rows: z.number()
    .int()
    .min(TERMINAL_RUNTIME_LIMITS.minimumRows)
    .max(TERMINAL_RUNTIME_LIMITS.maximumRows),
}).strict();

export const TerminalKillRequestSchema = TerminalSessionAccessSchema;

export type TerminalCreateRequest = z.infer<typeof TerminalCreateRequestSchema>;
export type TerminalWriteRequest = z.infer<typeof TerminalWriteRequestSchema>;
export type TerminalResizeRequest = z.infer<typeof TerminalResizeRequestSchema>;
export type TerminalKillRequest = z.infer<typeof TerminalKillRequestSchema>;

export const TerminalFailureSchema = z.strictObject({
  success: z.literal(false),
  code: z.literal(TERMINAL_UNAVAILABLE),
});

export type TerminalFailure = z.infer<typeof TerminalFailureSchema>;

const TerminalGrantSuccessSchema = z.strictObject({
  success: z.literal(true),
  code: z.literal(TERMINAL_GRANT_ISSUED),
  grant: TerminalSessionGrantSchema,
});

export const TerminalGrantResultSchema = z.union([
  TerminalGrantSuccessSchema,
  TerminalFailureSchema,
]);

const TerminalCreateSuccessSchema = z.strictObject({
  success: z.literal(true),
  code: z.literal(TERMINAL_SESSION_CREATED),
  terminalId: TerminalIdSchema,
  sessionAccessGrantId: ExecutionGrantIdSchema,
});

export const TerminalCreateResultSchema = z.union([
  TerminalCreateSuccessSchema,
  TerminalFailureSchema,
]);

const TerminalOperationSuccessSchema = z.strictObject({
  success: z.literal(true),
  code: z.literal(TERMINAL_OPERATION_COMPLETE),
});

export const TerminalOperationResultSchema = z.union([
  TerminalOperationSuccessSchema,
  TerminalFailureSchema,
]);

export type TerminalGrantResult = z.infer<typeof TerminalGrantResultSchema>;
export type TerminalCreateResult = z.infer<typeof TerminalCreateResultSchema>;
export type TerminalOperationResult = z.infer<typeof TerminalOperationResultSchema>;

export const TerminalDataEventSchema = z.strictObject({
  terminalId: TerminalIdSchema,
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  data: z.string()
    .max(TERMINAL_RUNTIME_LIMITS.eventChars)
    .refine((value) => !value.includes('\u0000'), {
      message: 'Terminal output is unavailable',
    }),
});

export const TerminalExitEventSchema = z.strictObject({
  terminalId: TerminalIdSchema,
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647),
  reason: z.enum(['exit', 'killed', 'unavailable']),
});

export type TerminalDataEvent = z.infer<typeof TerminalDataEventSchema>;
export type TerminalExitEvent = z.infer<typeof TerminalExitEventSchema>;

export function createTerminalFailure(): TerminalFailure {
  return { success: false, code: TERMINAL_UNAVAILABLE };
}

export function decodeTerminalGrantResult(input: unknown): TerminalGrantResult {
  return parseWithoutThrow(TerminalGrantResultSchema, input) ?? createTerminalFailure();
}

export function decodeTerminalCreateResult(input: unknown): TerminalCreateResult {
  return parseWithoutThrow(TerminalCreateResultSchema, input) ?? createTerminalFailure();
}

export function decodeTerminalOperationResult(input: unknown): TerminalOperationResult {
  return parseWithoutThrow(TerminalOperationResultSchema, input) ?? createTerminalFailure();
}

export function decodeTerminalDataEvent(input: unknown): TerminalDataEvent | null {
  return parseWithoutThrow(TerminalDataEventSchema, input) ?? null;
}

export function decodeTerminalExitEvent(input: unknown): TerminalExitEvent | null {
  return parseWithoutThrow(TerminalExitEventSchema, input) ?? null;
}
