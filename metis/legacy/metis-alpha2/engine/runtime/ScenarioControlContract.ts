import { z } from 'zod';

/**
 * Public Scenario run-control contract (pause / cancel).
 *
 * Mirrors the LiveSteering agent-control shape: strict request validation in
 * the renderer bridge and again in the main process, plus a decoded response
 * union so a malformed main-process reply can never crash the renderer.
 *
 * - `pause` persists a durable `paused` checkpoint that a later run resumes.
 * - `cancel` moves the run to terminal `cancelled`; late provider results
 *   cannot revive a cancelled run and it is never offered as recoverable.
 */

export const SCENARIO_CONTROL_CONTRACT_VERSION = 1 as const;

// eslint-disable-next-line no-control-regex -- C0/C1 input is rejected at the runtime boundary
const UNSAFE_SINGLE_LINE = /[\u0000-\u001f\u007f-\u009f]/u;

const SafeIdSchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const SafeSessionIdSchema = z.string()
  .min(1)
  .max(512)
  .refine((value) => !UNSAFE_SINGLE_LINE.test(value), 'Session ID contains control characters');

const SafeReasonSchema = z.string()
  .min(1)
  .max(2_000)
  .refine((value) => !UNSAFE_SINGLE_LINE.test(value), 'Control reason contains control characters');

const ScenarioRunControlBaseSchema = z.strictObject({
  contractVersion: z.literal(SCENARIO_CONTROL_CONTRACT_VERSION),
  operationId: SafeIdSchema,
  sessionId: SafeSessionIdSchema,
});

export const ScenarioRunControlRequestSchema = z.discriminatedUnion('action', [
  ScenarioRunControlBaseSchema.extend({
    action: z.literal('pause'),
    reason: SafeReasonSchema.optional(),
  }).strict(),
  ScenarioRunControlBaseSchema.extend({
    action: z.literal('cancel'),
    reason: SafeReasonSchema.optional(),
  }).strict(),
]);

export type ScenarioRunControlRequest = z.infer<typeof ScenarioRunControlRequestSchema>;

export const SCENARIO_RUN_CONTROL_SUCCESS_CODES = [
  'pause_requested',
  'already_paused',
  'cancel_requested',
  'already_cancelled',
] as const;

export const SCENARIO_RUN_CONTROL_FAILURE_CODES = [
  'invalid_request',
  'no_active_run',
  'no_cancellable_run',
  'owner_mismatch',
  'application_shutting_down',
  'scenario_control_unavailable',
] as const;

export const ScenarioRunControlResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    contractVersion: z.literal(SCENARIO_CONTROL_CONTRACT_VERSION),
    operationId: SafeIdSchema,
    action: z.enum(['pause', 'cancel']),
    code: z.enum(SCENARIO_RUN_CONTROL_SUCCESS_CODES),
  }),
  z.strictObject({
    ok: z.literal(false),
    contractVersion: z.literal(SCENARIO_CONTROL_CONTRACT_VERSION),
    operationId: SafeIdSchema,
    code: z.enum(SCENARIO_RUN_CONTROL_FAILURE_CODES),
  }),
]);

export type ScenarioRunControlResponse = z.infer<typeof ScenarioRunControlResponseSchema>;

export function decodeScenarioRunControlResponse(
  input: unknown,
  operationId = 'scenario-control-recovery',
): ScenarioRunControlResponse {
  const parsed = ScenarioRunControlResponseSchema.safeParse(input);
  return parsed.success ? parsed.data : {
    ok: false,
    contractVersion: SCENARIO_CONTROL_CONTRACT_VERSION,
    operationId,
    code: 'scenario_control_unavailable',
  };
}
