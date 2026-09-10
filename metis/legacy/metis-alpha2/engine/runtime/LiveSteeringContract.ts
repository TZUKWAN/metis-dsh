import { z } from 'zod';

/**
 * Strict, process-local contract for steering an already-running agent.
 *
 * The renderer/main bridge can be layered on top of this contract later. AgentLoop only
 * consumes unknown events through LiveSteeringSource and validates every event again, so a
 * custom queue implementation cannot smuggle malformed messages into provider context.
 */

const MAX_STEERING_TEXT_CHARS = 32_000;
const MAX_STEERING_EVENTS_PER_DRAIN = 100;
export const LIVE_STEERING_CONTRACT_VERSION = 1 as const;

// eslint-disable-next-line no-control-regex -- C0/C1 input is rejected at the runtime boundary
const UNSAFE_SINGLE_LINE = /[\u0000-\u001f\u007f-\u009f]/u;
// eslint-disable-next-line no-control-regex -- newlines/tabs are allowed in live instructions
const UNSAFE_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

const SafeIdSchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const SafeSessionIdSchema = z.string()
  .min(1)
  .max(512)
  .refine((value) => !UNSAFE_SINGLE_LINE.test(value), 'Session ID contains control characters');

const SafeMultilineSchema = z.string()
  .min(1)
  .max(MAX_STEERING_TEXT_CHARS)
  .refine((value) => !UNSAFE_MULTILINE.test(value), 'Steering text contains control characters');

const LiveSteeringBaseSchema = z.strictObject({
  id: SafeIdSchema,
  sessionId: SafeSessionIdSchema,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export const LiveSteeringInstructionSchema = LiveSteeringBaseSchema.extend({
  type: z.literal('instruction'),
  content: SafeMultilineSchema,
}).strict();

export const LiveSteeringInterruptSchema = LiveSteeringBaseSchema.extend({
  type: z.literal('interrupt'),
  reason: SafeMultilineSchema,
}).strict();

export const LiveSteeringEventSchema = z.discriminatedUnion('type', [
  LiveSteeringInstructionSchema,
  LiveSteeringInterruptSchema,
]);

export type LiveSteeringEvent = z.infer<typeof LiveSteeringEventSchema>;
export type LiveSteeringInstruction = z.infer<typeof LiveSteeringInstructionSchema>;
export type LiveSteeringInterrupt = z.infer<typeof LiveSteeringInterruptSchema>;

const AgentControlRequestBaseSchema = z.strictObject({
  contractVersion: z.literal(LIVE_STEERING_CONTRACT_VERSION),
  operationId: SafeIdSchema,
  sessionId: SafeSessionIdSchema,
});

export const AgentControlRequestSchema = z.discriminatedUnion('action', [
  AgentControlRequestBaseSchema.extend({
    action: z.literal('instruction'),
    content: SafeMultilineSchema,
  }).strict(),
  AgentControlRequestBaseSchema.extend({
    action: z.literal('interrupt'),
    reason: SafeMultilineSchema,
  }).strict(),
]);

export const AgentControlResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    contractVersion: z.literal(LIVE_STEERING_CONTRACT_VERSION),
    operationId: SafeIdSchema,
    action: z.enum(['instruction', 'interrupt']),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    ok: z.literal(false),
    contractVersion: z.literal(LIVE_STEERING_CONTRACT_VERSION),
    operationId: SafeIdSchema,
    code: z.enum(['invalid_request', 'no_active_run', 'owner_mismatch', 'queue_unavailable']),
  }),
]);

export type AgentControlRequest = z.infer<typeof AgentControlRequestSchema>;
export type AgentControlResponse = z.infer<typeof AgentControlResponseSchema>;

export function decodeAgentControlResponse(input: unknown, operationId = 'control-recovery'): AgentControlResponse {
  const parsed = AgentControlResponseSchema.safeParse(input);
  return parsed.success ? parsed.data : {
    ok: false,
    contractVersion: LIVE_STEERING_CONTRACT_VERSION,
    operationId,
    code: 'queue_unavailable',
  };
}

export interface LiveSteeringDrainRequest {
  sessionId: string;
  afterSequence: number;
}

/**
 * Deliberately returns unknown values. AgentLoop is the trust boundary and re-validates every
 * event before adding it to message history or acting on an interrupt.
 */
export interface LiveSteeringSource {
  drain(request: LiveSteeringDrainRequest): readonly unknown[] | Promise<readonly unknown[]>;
}

/** Small in-memory queue suitable for a main-process run coordinator. */
export class InMemoryLiveSteeringQueue implements LiveSteeringSource {
  private readonly pending = new Map<string, LiveSteeringEvent[]>();
  private readonly lastSequence = new Map<string, number>();

  enqueue(raw: unknown): LiveSteeringEvent {
    const event = LiveSteeringEventSchema.parse(raw);
    const last = this.lastSequence.get(event.sessionId) ?? 0;
    if (event.sequence <= last) {
      throw new Error(`Steering sequence must increase for session '${event.sessionId}'`);
    }

    const events = this.pending.get(event.sessionId) ?? [];
    if (events.length >= MAX_STEERING_EVENTS_PER_DRAIN) {
      throw new Error(`Steering queue limit exceeded for session '${event.sessionId}'`);
    }
    events.push(event);
    this.pending.set(event.sessionId, events);
    this.lastSequence.set(event.sessionId, event.sequence);
    return event;
  }

  drain(request: LiveSteeringDrainRequest): readonly LiveSteeringEvent[] {
    const parsed = z.strictObject({
      sessionId: SafeSessionIdSchema,
      afterSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    }).parse(request);
    const events = this.pending.get(parsed.sessionId) ?? [];
    const drained = events.filter((event) => event.sequence > parsed.afterSequence);
    this.pending.delete(parsed.sessionId);
    return drained;
  }

  clear(sessionId: string): void {
    SafeSessionIdSchema.parse(sessionId);
    this.pending.delete(sessionId);
    this.lastSequence.delete(sessionId);
  }
}
