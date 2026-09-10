/**
 * Autonomous Research Engine — runtime contract.
 *
 * Defines the IPC surface and the live event payloads that flow from the main
 * process to the renderer while an autonomous research loop runs. Mirrors the
 * goal live-event contract pattern (boundedText + discriminatedUnion) so the
 * renderer side decoder is symmetric and tamper-resistant.
 *
 * The contract deliberately reuses the same shape vocabulary as
 * ChatRuntimeContract (RuntimeIdSchema/ShortTextSchema) to keep the renderer's
 * decode helper homogeneous.
 */

import { z } from 'zod';

export const AUTONOMOUS_CONTRACT_VERSION = 1 as const;

export const AUTONOMOUS_LIMITS = Object.freeze({
  idChars: 128,
  shortTextChars: 512,
  goalTextChars: 8_000,
  outputChars: 100_000,
  errorChars: 20_000,
  reflectionChars: 4_000,
  revisionNoteChars: 2_000,
  phaseNameChars: 128,
  phases: 32, // total phases across a loop (incl. redos)
  phaseSequence: 512, // step-level sequence counter cap
} as const);

// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

function boundedText(maxLength: number) {
  return z.string()
    .max(maxLength)
    .refine((value) => !UNSAFE_CONTROL_CHARACTERS.test(value), {
      message: 'Text contains unsafe control characters',
    });
}

export const RuntimeIdSchema = z.string()
  .min(1)
  .max(AUTONOMOUS_LIMITS.idChars)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const SequenceSchema = z.number().int().min(0).max(AUTONOMOUS_LIMITS.phaseSequence);

const ShortTextSchema = boundedText(AUTONOMOUS_LIMITS.shortTextChars);

export const ResearchPhaseKindSchema = z.enum([
  // Legacy natural-science phases remain decodable for checkpoint compatibility.
  'idea', 'experiment', 'paper',
  // Humanities and social-science research actions.
  'question_formulation', 'literature_review', 'source_discovery', 'screening',
  'conceptual_analysis', 'source_criticism', 'research_design', 'data_collection',
  'coding', 'data_preparation', 'statistics', 'analysis', 'triangulation',
  'argumentation', 'synthesis', 'quality_audit', 'writing',
]);
export type ResearchPhaseKind = z.infer<typeof ResearchPhaseKindSchema>;

// ─── Start request ────────────────────────────────────────────

export const AutonomousStartRequestSchema = z.strictObject({
  version: z.literal(AUTONOMOUS_CONTRACT_VERSION),
  sessionId: RuntimeIdSchema.optional(),
  goal: boundedText(AUTONOMOUS_LIMITS.goalTextChars).min(1),
  projectId: RuntimeIdSchema.optional(),
  /** User-defined research strategy id; when set the run follows its phases. */
  strategyId: RuntimeIdSchema.optional(),
  /** Paper structure template id for the writing action (strategy mode). */
  structureId: RuntimeIdSchema.optional(),
});
export type AutonomousStartRequest = z.infer<typeof AutonomousStartRequestSchema>;

export const AutonomousStartResponseSchema = z.strictObject({
  ok: z.boolean(),
  sessionId: RuntimeIdSchema.optional(),
  projectId: RuntimeIdSchema.optional(),
  error: ShortTextSchema.optional(),
});
export type AutonomousStartResponse = z.infer<typeof AutonomousStartResponseSchema>;

// ─── Control request (pause / interrupt / resume) ─────────────

export const AutonomousControlActionSchema = z.enum(['pause', 'resume', 'interrupt']);
export type AutonomousControlAction = z.infer<typeof AutonomousControlActionSchema>;

export const AutonomousControlRequestSchema = z.strictObject({
  version: z.literal(AUTONOMOUS_CONTRACT_VERSION),
  sessionId: RuntimeIdSchema,
  action: AutonomousControlActionSchema,
  reason: ShortTextSchema.optional(),
});
export type AutonomousControlRequest = z.infer<typeof AutonomousControlRequestSchema>;

export const AutonomousControlResponseSchema = z.strictObject({
  ok: z.boolean(),
  code: z.enum(['applied', 'no_active_session', 'invalid_request', 'not_found']).optional(),
});
export type AutonomousControlResponse = z.infer<typeof AutonomousControlResponseSchema>;

// ─── Live events (main → renderer) ────────────────────────────

const AutonomousLiveEventCommonSchema = {
  version: z.literal(AUTONOMOUS_CONTRACT_VERSION),
  sessionId: RuntimeIdSchema,
  sequence: SequenceSchema,
};

export const AutonomousEngineStartedEventSchema = z.strictObject({
  ...AutonomousLiveEventCommonSchema,
  type: z.literal('engine-started'),
  goal: boundedText(AUTONOMOUS_LIMITS.goalTextChars),
  plan: z.array(z.strictObject({
    phase: ResearchPhaseKindSchema,
    name: ShortTextSchema,
  })).min(1),
  method: z.strictObject({
    family: z.enum(['theoretical', 'qualitative', 'historical', 'quantitative', 'mixed', 'general']),
    name: ShortTextSchema,
    rationale: boundedText(AUTONOMOUS_LIMITS.reflectionChars),
    confidence: z.number().min(0).max(1),
    selectedBy: z.enum(['automatic_heuristic', 'automatic_provider', 'researcher']),
  }).optional(),
});

export const AutonomousPhaseStartedEventSchema = z.strictObject({
  ...AutonomousLiveEventCommonSchema,
  type: z.literal('phase-started'),
  phase: ResearchPhaseKindSchema,
  phaseIteration: z.number().int().min(1),
  phaseName: boundedText(AUTONOMOUS_LIMITS.phaseNameChars),
});

export const AutonomousStepEventSchema = z.strictObject({
  ...AutonomousLiveEventCommonSchema,
  type: z.enum(['step-start', 'step-complete', 'step-failed']),
  phase: ResearchPhaseKindSchema,
  stepId: RuntimeIdSchema,
  stepName: ShortTextSchema,
  output: boundedText(AUTONOMOUS_LIMITS.outputChars).optional(),
  error: boundedText(AUTONOMOUS_LIMITS.errorChars).optional(),
});

export const AutonomousReflectionEventSchema = z.strictObject({
  ...AutonomousLiveEventCommonSchema,
  type: z.literal('reflection'),
  phase: ResearchPhaseKindSchema,
  decision: z.enum(['advance', 'redo', 'rollback', 'done']),
  nextPhase: ResearchPhaseKindSchema.optional(),
  qualityScore: z.number().min(0).max(1),
  reasoning: boundedText(AUTONOMOUS_LIMITS.reflectionChars),
  revisionNote: boundedText(AUTONOMOUS_LIMITS.revisionNoteChars).optional(),
});

export const AutonomousProgressEventSchema = z.strictObject({
  ...AutonomousLiveEventCommonSchema,
  type: z.literal('progress'),
  completedPhases: z.number().int().min(0).max(AUTONOMOUS_LIMITS.phases),
  totalPhases: z.number().int().min(1).max(AUTONOMOUS_LIMITS.phases),
  currentPhase: ResearchPhaseKindSchema,
}).refine((value) => value.completedPhases <= value.totalPhases, {
  message: 'Completed phases cannot exceed total',
  path: ['completedPhases'],
});

export const AutonomousEngineCompletedEventSchema = z.strictObject({
  ...AutonomousLiveEventCommonSchema,
  type: z.literal('engine-completed'),
  summary: boundedText(AUTONOMOUS_LIMITS.outputChars),
  artifactIds: z.array(RuntimeIdSchema).default([]),
});

export const AutonomousEngineFailedEventSchema = z.strictObject({
  ...AutonomousLiveEventCommonSchema,
  type: z.literal('engine-failed'),
  reason: boundedText(AUTONOMOUS_LIMITS.errorChars),
  completedPhases: z.number().int().min(0).max(AUTONOMOUS_LIMITS.phases),
  recoverable: z.boolean(),
});

export const AutonomousEngineInterruptedEventSchema = z.strictObject({
  ...AutonomousLiveEventCommonSchema,
  type: z.literal('engine-interrupted'),
  reason: ShortTextSchema,
});

export const AutonomousEnginePausedEventSchema = z.strictObject({
  ...AutonomousLiveEventCommonSchema,
  type: z.literal('engine-paused'),
  reason: ShortTextSchema,
});

export const AutonomousEngineResumedEventSchema = z.strictObject({
  ...AutonomousLiveEventCommonSchema,
  type: z.literal('engine-resumed'),
  completedPhases: z.number().int().min(0).max(AUTONOMOUS_LIMITS.phases),
});

export const AutonomousLiveEventSchema = z.discriminatedUnion('type', [
  AutonomousEngineStartedEventSchema,
  AutonomousPhaseStartedEventSchema,
  AutonomousStepEventSchema,
  AutonomousReflectionEventSchema,
  AutonomousProgressEventSchema,
  AutonomousEngineCompletedEventSchema,
  AutonomousEngineFailedEventSchema,
  AutonomousEngineInterruptedEventSchema,
  AutonomousEnginePausedEventSchema,
  AutonomousEngineResumedEventSchema,
]);

export type AutonomousLiveEvent = z.infer<typeof AutonomousLiveEventSchema>;

// IPC channel names — single source of truth shared by main + preload.
export const AUTONOMOUS_CHANNELS = Object.freeze({
  start: 'autonomous:start',
  control: 'autonomous:control',
  listSessions: 'autonomous:listSessions',
  resumeSession: 'autonomous:resumeSession',
  live: {
    engineStarted: 'autonomous:engine-started',
    phaseStarted: 'autonomous:phase-started',
    stepStart: 'autonomous:step-start',
    stepComplete: 'autonomous:step-complete',
    stepFailed: 'autonomous:step-failed',
    reflection: 'autonomous:reflection',
    progress: 'autonomous:progress',
    engineCompleted: 'autonomous:engine-completed',
    engineFailed: 'autonomous:engine-failed',
    engineInterrupted: 'autonomous:engine-interrupted',
    enginePaused: 'autonomous:engine-paused',
    engineResumed: 'autonomous:engine-resumed',
  } as const,
} as const);

// ─── Decode helpers ───────────────────────────────────────────

export function decodeAutonomousStartRequest(input: unknown): AutonomousStartRequest | undefined {
  const result = AutonomousStartRequestSchema.safeParse(input);
  return result.success ? result.data : undefined;
}

export function decodeAutonomousControlRequest(input: unknown): AutonomousControlRequest | undefined {
  const result = AutonomousControlRequestSchema.safeParse(input);
  return result.success ? result.data : undefined;
}

export function decodeAutonomousLiveEvent(input: unknown): AutonomousLiveEvent | undefined {
  const result = AutonomousLiveEventSchema.safeParse(input);
  return result.success ? result.data : undefined;
}
