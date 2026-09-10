import { z } from 'zod';

export const EVAL_RUNTIME_LIMITS = Object.freeze({
  tasks: 64,
  taskIdChars: 120,
  failedTaskIds: 64,
} as const);

export const EvalProfileSchema = z.enum(['dev', 'candidate', 'release']);
export type EvalProfile = z.infer<typeof EvalProfileSchema>;

export const EvalRunRequestSchema = z.strictObject({
  profile: EvalProfileSchema,
});
export type EvalRunRequest = z.infer<typeof EvalRunRequestSchema>;

const EvalTaskIdSchema = z.string()
  .trim()
  .min(1)
  .max(EVAL_RUNTIME_LIMITS.taskIdChars)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u);

const NonNegativeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const EvalTaskResultViewSchema = z.strictObject({
  taskId: EvalTaskIdSchema,
  success: z.boolean(),
  status: z.enum(['passed', 'failed', 'error', 'cancelled']),
  turnsUsed: NonNegativeIntegerSchema,
  toolCalls: NonNegativeIntegerSchema,
  latencyMs: NonNegativeIntegerSchema,
  toolFailures: NonNegativeIntegerSchema,
  qualityFailures: NonNegativeIntegerSchema,
  issueCount: NonNegativeIntegerSchema,
});
export type EvalTaskResultView = z.infer<typeof EvalTaskResultViewSchema>;

export const EvalRunResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('completed'),
    summary: z.strictObject({
      taskCount: NonNegativeIntegerSchema.max(EVAL_RUNTIME_LIMITS.tasks),
      passed: NonNegativeIntegerSchema.max(EVAL_RUNTIME_LIMITS.tasks),
      failed: NonNegativeIntegerSchema.max(EVAL_RUNTIME_LIMITS.tasks),
      successRate: z.number().finite().min(0).max(100),
    }),
    gate: z.strictObject({
      passed: z.boolean(),
      profile: EvalProfileSchema,
      failureCount: NonNegativeIntegerSchema,
      failedTaskIds: z.array(EvalTaskIdSchema).max(EVAL_RUNTIME_LIMITS.failedTaskIds),
    }),
    results: z.array(EvalTaskResultViewSchema).max(EVAL_RUNTIME_LIMITS.tasks),
  }),
  z.strictObject({
    status: z.literal('cancelled'),
    code: z.literal('eval_user_cancelled'),
  }),
  z.strictObject({
    status: z.literal('error'),
    code: z.enum(['eval_unavailable', 'eval_already_running', 'eval_execution_failed']),
  }),
]);
export type EvalRunResult = z.infer<typeof EvalRunResultSchema>;

export function decodeEvalRunRequest(input: unknown): EvalRunRequest | undefined {
  const parsed = EvalRunRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

export function createEvalRunFailure(
  code: 'eval_unavailable' | 'eval_already_running' | 'eval_execution_failed' = 'eval_unavailable',
): EvalRunResult {
  return { status: 'error', code };
}

export function decodeEvalRunResult(input: unknown): EvalRunResult {
  const parsed = EvalRunResultSchema.safeParse(input);
  return parsed.success ? parsed.data : createEvalRunFailure();
}
