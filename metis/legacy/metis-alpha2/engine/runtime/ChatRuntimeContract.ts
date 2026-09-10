import { z } from 'zod';
import { PersonalizationIdSchema, PersonalizationLocalIdSchema } from './PersonalizationRuntimeContract.js';

export const CHAT_RUNTIME_CONTRACT_VERSION = 1 as const;
export const LEGACY_GOAL_MARKER_PREFIX = '__GOAL_CARD__';

export const CHAT_RUNTIME_LIMITS = Object.freeze({
  idChars: 128,
  shortTextChars: 512,
  historyTextChars: 200_000,
  legacyGoalMarkerChars: 512_000,
  answerChars: 200_000,
  diagnosticMessageChars: 20_000,
  eventSummaryChars: 4_000,
  streamChunkChars: 64_000,
  toolResultDetailChars: 4_000,
  toolResultSources: 32,
  goalOutputChars: 100_000,
  goalErrorChars: 20_000,
  historyItems: 500,
  goalSteps: 64,
  diagnostics: 64,
  citations: 128,
  agentEvents: 256,
  agentReplayEvents: 256,
  agentLedgerEventsPerRun: 2_048,
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

function normalizeKnownValue<const T extends readonly string[]>(
  value: unknown,
  knownValues: T,
): T[number] | 'unknown' {
  return typeof value === 'string' && (knownValues as readonly string[]).includes(value)
    ? value as T[number]
    : 'unknown';
}

function parseWithoutThrow<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  try {
    const result = schema.safeParse(input);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export const RuntimeIdSchema = z.string()
  .min(1)
  .max(CHAT_RUNTIME_LIMITS.idChars)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const RuntimeCodeSchema = RuntimeIdSchema;
const ShortTextSchema = boundedText(CHAT_RUNTIME_LIMITS.shortTextChars);
const HistoryTextSchema = boundedText(CHAT_RUNTIME_LIMITS.historyTextChars);
const TimestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const SequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ReplayCursorSchema = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER);

const KNOWN_AGENT_STATUSES = [
  'completed',
  'interrupted',
  'error',
  'max_turns_reached',
  'context_exhausted',
  'cancelled',
] as const;
const AGENT_STATUSES = [...KNOWN_AGENT_STATUSES, 'unknown'] as const;

const KNOWN_GOAL_PHASES = [
  'creating',
  'planning',
  'plan_ready',
  'executing',
  'completed',
  'failed',
  'cancelled',
] as const;
const GOAL_PHASES = [...KNOWN_GOAL_PHASES, 'unknown'] as const;

const KNOWN_STEP_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
] as const;
const STEP_STATUSES = [...KNOWN_STEP_STATUSES, 'unknown'] as const;

const KNOWN_AGENT_LIFECYCLE_PHASES = [
  'started',
  'running',
  'completed',
  'interrupted',
  'failed',
  'cancelled',
] as const;
const AGENT_LIFECYCLE_PHASES = [...KNOWN_AGENT_LIFECYCLE_PHASES, 'unknown'] as const;

export const AgentStatusSchema = z.enum(AGENT_STATUSES);
export const GoalPhaseSchema = z.enum(GOAL_PHASES);
export const StepStatusSchema = z.enum(STEP_STATUSES);
export const AgentLifecyclePhaseSchema = z.enum(AGENT_LIFECYCLE_PHASES);
export type AgentLifecyclePhase = z.infer<typeof AgentLifecyclePhaseSchema>;

export const ProviderMessageSchema = z.strictObject({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: HistoryTextSchema,
});

export const AgentChatRequestSchema = z.strictObject({
  version: z.literal(CHAT_RUNTIME_CONTRACT_VERSION),
  turnId: RuntimeIdSchema,
  sessionId: RuntimeIdSchema,
  messages: z.array(ProviderMessageSchema).min(1).max(CHAT_RUNTIME_LIMITS.historyItems),
  skillId: RuntimeIdSchema.optional(),
  scenarioId: PersonalizationIdSchema.optional(),
  projectId: PersonalizationLocalIdSchema.optional(),
  mode: z.enum(['send', 'regenerate']),
});

export const AgentChatOptionsSchema = z.strictObject({
  mode: z.enum(['send', 'regenerate']),
  /** Renderer-generated correlation ID for live execution events. */
  turnId: RuntimeIdSchema.optional(),
  scenarioId: PersonalizationIdSchema.optional(),
  projectId: PersonalizationLocalIdSchema.optional(),
});

export type AgentChatRequest = z.infer<typeof AgentChatRequestSchema>;
export type AgentChatOptions = z.infer<typeof AgentChatOptionsSchema>;

const AgentStatusInputSchema = z.unknown().transform((value) => (
  normalizeKnownValue(value, KNOWN_AGENT_STATUSES)
));
const GoalPhaseInputSchema = z.unknown().transform((value) => (
  normalizeKnownValue(value, KNOWN_GOAL_PHASES)
));
const StepStatusInputSchema = z.unknown().transform((value) => (
  normalizeKnownValue(value, KNOWN_STEP_STATUSES)
));
const AgentLifecyclePhaseInputSchema = z.unknown().transform((value) => (
  normalizeKnownValue(value, KNOWN_AGENT_LIFECYCLE_PHASES)
));

const GoalStepSchema = z.strictObject({
  id: RuntimeIdSchema,
  name: ShortTextSchema,
  description: boundedText(4_000),
});

const GoalStepStatusInputSchema = z.strictObject({
  stepId: RuntimeIdSchema,
  stepName: ShortTextSchema,
  status: StepStatusInputSchema,
  output: boundedText(CHAT_RUNTIME_LIMITS.goalOutputChars),
});

const GoalStepStatusesSchema = z.record(RuntimeIdSchema, GoalStepStatusInputSchema)
  .refine((value) => Object.keys(value).length <= CHAT_RUNTIME_LIMITS.goalSteps, {
    message: 'Too many goal step statuses',
  });

const GoalProgressSchema = z.strictObject({
  completed: z.number().int().min(0).max(CHAT_RUNTIME_LIMITS.goalSteps),
  total: z.number().int().min(0).max(CHAT_RUNTIME_LIMITS.goalSteps),
  currentStep: ShortTextSchema,
}).refine((value) => value.completed <= value.total, {
  message: 'Completed progress cannot exceed total progress',
  path: ['completed'],
});

const GoalSnapshotBaseSchema = z.strictObject({
  goalId: RuntimeIdSchema,
  description: boundedText(10_000),
  phase: GoalPhaseInputSchema,
  planName: ShortTextSchema.optional(),
  planDescription: boundedText(10_000).optional(),
  steps: z.array(GoalStepSchema).max(CHAT_RUNTIME_LIMITS.goalSteps),
  stepStatuses: GoalStepStatusesSchema,
  progress: GoalProgressSchema,
  reasoning: boundedText(CHAT_RUNTIME_LIMITS.diagnosticMessageChars).optional(),
  error: boundedText(CHAT_RUNTIME_LIMITS.goalErrorChars).optional(),
  canRefine: z.boolean(),
});

export const GoalSnapshotSchema = GoalSnapshotBaseSchema.superRefine((value, context) => {
  const stepIds = new Set<string>();
  for (let index = 0; index < value.steps.length; index += 1) {
    const step = value.steps[index];
    if (!step) continue;
    if (stepIds.has(step.id)) {
      context.addIssue({
        code: 'custom',
        message: 'Goal step IDs must be unique',
        path: ['steps', index, 'id'],
      });
    }
    stepIds.add(step.id);
  }

  for (const [key, status] of Object.entries(value.stepStatuses)) {
    if (status.stepId !== key) {
      context.addIssue({
        code: 'custom',
        message: 'Goal step status key must match stepId',
        path: ['stepStatuses', key, 'stepId'],
      });
    }
    if (!stepIds.has(key)) {
      context.addIssue({
        code: 'custom',
        message: 'Goal step status must reference a known step',
        path: ['stepStatuses', key],
      });
    }
  }
});

export type GoalSnapshot = z.infer<typeof GoalSnapshotSchema>;

const StoredMessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);

/**
 * O8 引用条目(engine/core/Citation.ts Citation 的契约镜像):collectCitations
 * 与 extractDoiCitations 产出该形状,ChatPage 的 chat-citations 芯片按
 * id/label/url/doi 渲染。与 ArtifactManifest 的 VerifiedCitation(sourceId/
 * verified)是两套用途不同的引用。
 */
export const CitationChipSchema = z.strictObject({
  id: boundedText(64),
  label: boundedText(CHAT_RUNTIME_LIMITS.shortTextChars),
  paperId: RuntimeIdSchema.optional(),
  doi: boundedText(256).optional(),
  url: boundedText(1_200).optional(),
  page: z.number().int().min(1).optional(),
  quote: boundedText(2_000).optional(),
});

const HistoryRunMetadataSchema = z.strictObject({
  runId: RuntimeIdSchema.optional(),
  turnId: RuntimeIdSchema.optional(),
  status: AgentStatusSchema.optional(),
  startedAt: TimestampSchema.optional(),
  completedAt: TimestampSchema.optional(),
  lastSequence: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).optional(),
  eventsPruned: z.boolean().optional(),
  citations: z.array(CitationChipSchema).max(CHAT_RUNTIME_LIMITS.citations).optional(),
});

const StoredMessageRowSchema = z.strictObject({
  role: StoredMessageRoleSchema,
  content: HistoryTextSchema,
  metadata: HistoryRunMetadataSchema.optional(),
});

export const LegacyGoalMarkerSchema = boundedText(CHAT_RUNTIME_LIMITS.legacyGoalMarkerChars)
  .refine((value) => value.startsWith(LEGACY_GOAL_MARKER_PREFIX), {
    message: 'Legacy goal marker is missing its prefix',
  });

const StoredGoalRowSchema = z.strictObject({
  role: z.literal('goal'),
  content: LegacyGoalMarkerSchema,
});

export const StoredHistoryRowSchema = z.discriminatedUnion('role', [
  StoredMessageRowSchema,
  StoredGoalRowSchema,
]);

export const HistoryRecoveryCodeSchema = z.enum([
  'history_unavailable',
  'history_item_unavailable',
  'goal_snapshot_unavailable',
]);

const HistoryMessageItemSchema = z.strictObject({
  kind: z.literal('message'),
  role: StoredMessageRoleSchema,
  content: HistoryTextSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const HistoryGoalItemSchema = z.strictObject({
  kind: z.literal('goal'),
  goal: GoalSnapshotSchema,
});

const HistoryRecoveryItemSchema = z.strictObject({
  kind: z.literal('recovery'),
  code: HistoryRecoveryCodeSchema,
});

export const HistoryItemSchema = z.discriminatedUnion('kind', [
  HistoryMessageItemSchema,
  HistoryGoalItemSchema,
  HistoryRecoveryItemSchema,
]);

export type HistoryItem = z.infer<typeof HistoryItemSchema>;

export const HistoryItemsSchema = z.array(HistoryItemSchema)
  .max(CHAT_RUNTIME_LIMITS.historyItems);

function historyRecovery(
  code: z.infer<typeof HistoryRecoveryCodeSchema>,
): HistoryItem {
  return { kind: 'recovery', code };
}

export function decodeLegacyGoalMarker(input: unknown): HistoryItem {
  const marker = parseWithoutThrow(LegacyGoalMarkerSchema, input);
  if (!marker) return historyRecovery('goal_snapshot_unavailable');

  const encoded = marker.slice(LEGACY_GOAL_MARKER_PREFIX.length);
  if (!encoded) return historyRecovery('goal_snapshot_unavailable');

  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return historyRecovery('goal_snapshot_unavailable');
  }

  const goal = parseWithoutThrow(GoalSnapshotSchema, parsed);
  return goal
    ? { kind: 'goal', goal }
    : historyRecovery('goal_snapshot_unavailable');
}

export function decodeStoredHistoryEntry(input: unknown): HistoryItem {
  const row = parseWithoutThrow(StoredHistoryRowSchema, input);
  if (!row) return historyRecovery('history_item_unavailable');
  if (row.role === 'goal') return decodeLegacyGoalMarker(row.content);
  return {
    kind: 'message',
    role: row.role,
    content: row.content,
    ...(row.metadata ? { metadata: row.metadata } : {}),
  };
}

const StoredHistoryContainerSchema = z.array(z.unknown())
  .max(CHAT_RUNTIME_LIMITS.historyItems);

export function decodeStoredHistory(input: unknown): HistoryItem[] {
  const rows = parseWithoutThrow(StoredHistoryContainerSchema, input);
  if (!rows) return [historyRecovery('history_unavailable')];
  return rows.map(decodeStoredHistoryEntry);
}

export function decodeHistoryItems(input: unknown): HistoryItem[] {
  return parseWithoutThrow(HistoryItemsSchema, input)
    ?? [historyRecovery('history_unavailable')];
}

/** Accepts the current structured payload and safely migrates strict legacy rows. */
export function decodeHistoryPayload(input: unknown): HistoryItem[] {
  const structured = parseWithoutThrow(HistoryItemsSchema, input);
  return structured ?? decodeStoredHistory(input);
}

export const DiagnosticSchema = z.strictObject({
  severity: z.enum(['info', 'warning', 'error']),
  code: RuntimeCodeSchema,
  message: boundedText(CHAT_RUNTIME_LIMITS.diagnosticMessageChars).optional(),
});

export const VerifiedCitationSchema = z.strictObject({
  sourceId: RuntimeIdSchema,
  label: ShortTextSchema,
  locator: ShortTextSchema.optional(),
  verified: z.literal(true),
});

const AgentLifecycleEventSchema = z.strictObject({
  type: z.literal('lifecycle'),
  phase: AgentLifecyclePhaseInputSchema,
  timestamp: TimestampSchema,
  eventId: RuntimeIdSchema.optional(),
  sequence: SequenceSchema.optional(),
  summary: boundedText(CHAT_RUNTIME_LIMITS.eventSummaryChars).optional(),
});

const AgentActionEventSchema = z.strictObject({
  type: z.literal('action'),
  action: RuntimeCodeSchema,
  status: StepStatusInputSchema,
  timestamp: TimestampSchema,
  eventId: RuntimeIdSchema.optional(),
  sequence: SequenceSchema.optional(),
  summary: boundedText(CHAT_RUNTIME_LIMITS.eventSummaryChars).optional(),
});

const AgentProgressEventSchema = z.strictObject({
  type: z.literal('progress'),
  completed: z.number().int().min(0).max(1_000_000),
  total: z.number().int().min(0).max(1_000_000),
  timestamp: TimestampSchema,
  eventId: RuntimeIdSchema.optional(),
  sequence: SequenceSchema.optional(),
  label: ShortTextSchema.optional(),
}).refine((value) => value.completed <= value.total, {
  message: 'Completed progress cannot exceed total progress',
  path: ['completed'],
});

/** A source that a tool actually returned and the renderer may display. */
export const AgentToolResultSourceSchema = z.strictObject({
  label: ShortTextSchema,
  url: z.string().url().max(4_096).refine((value) => /^https?:\/\//iu.test(value), {
    message: 'Tool source URLs must use HTTP(S)',
  }).optional(),
});
export type AgentToolResultSource = z.infer<typeof AgentToolResultSourceSchema>;

/**
 * Completion detail for a tool run. `detail` is presenter-sanitized text, not
 * the raw ToolResult, and sources only come from actual tool-result metadata.
 */
const AgentToolResultEventSchema = z.strictObject({
  type: z.literal('tool_result'),
  toolCallId: RuntimeIdSchema,
  toolName: RuntimeCodeSchema,
  status: z.enum(['completed', 'failed']),
  timestamp: TimestampSchema,
  eventId: RuntimeIdSchema.optional(),
  sequence: SequenceSchema.optional(),
  summary: boundedText(CHAT_RUNTIME_LIMITS.eventSummaryChars).optional(),
  detail: boundedText(CHAT_RUNTIME_LIMITS.toolResultDetailChars).optional(),
  sources: z.array(AgentToolResultSourceSchema).max(CHAT_RUNTIME_LIMITS.toolResultSources),
});

export const AgentPresentationEventSchema = z.discriminatedUnion('type', [
  AgentLifecycleEventSchema,
  AgentActionEventSchema,
  AgentProgressEventSchema,
  AgentToolResultEventSchema,
]);
export type AgentPresentationEvent = z.infer<typeof AgentPresentationEventSchema>;

/**
 * A live event emitted while one normal Agent chat turn is still running.
 * `turnId` is supplied by the renderer (or generated by main as a fallback),
 * so a new Chat UI can ignore delayed events from an older turn safely.
 */
/**
 * Stable envelope for live and replayable agent execution events. `sequence` is
 * monotonic within one run; `eventId` makes append delivery idempotent.
 */
export const AgentExecutionEventSchema = z.strictObject({
  version: z.literal(CHAT_RUNTIME_CONTRACT_VERSION),
  eventId: RuntimeIdSchema,
  runId: RuntimeIdSchema,
  sessionId: RuntimeIdSchema,
  turnId: RuntimeIdSchema,
  sequence: SequenceSchema,
  correlationId: RuntimeIdSchema,
  event: AgentPresentationEventSchema,
});
export type AgentExecutionEvent = z.infer<typeof AgentExecutionEventSchema>;

export const AgentEventReplayRequestSchema = z.strictObject({
  version: z.literal(CHAT_RUNTIME_CONTRACT_VERSION),
  sessionId: RuntimeIdSchema,
  runId: RuntimeIdSchema,
  afterSequence: ReplayCursorSchema,
  limit: z.number().int().min(1).max(CHAT_RUNTIME_LIMITS.agentReplayEvents).default(CHAT_RUNTIME_LIMITS.agentReplayEvents),
});
export type AgentEventReplayRequest = z.infer<typeof AgentEventReplayRequestSchema>;

export const AgentEventReplayResponseSchema = z.strictObject({
  version: z.literal(CHAT_RUNTIME_CONTRACT_VERSION),
  sessionId: RuntimeIdSchema,
  runId: RuntimeIdSchema,
  afterSequence: ReplayCursorSchema,
  events: z.array(AgentExecutionEventSchema).max(CHAT_RUNTIME_LIMITS.agentReplayEvents),
  retentionGap: z.boolean().default(false),
});
export type AgentEventReplayResponse = z.infer<typeof AgentEventReplayResponseSchema>;

export const AgentResponseSchema = z.strictObject({
  version: z.literal(CHAT_RUNTIME_CONTRACT_VERSION),
  turnId: RuntimeIdSchema,
  status: AgentStatusInputSchema,
  answer: boundedText(CHAT_RUNTIME_LIMITS.answerChars),
  diagnostics: z.array(DiagnosticSchema).max(CHAT_RUNTIME_LIMITS.diagnostics),
  citations: z.array(CitationChipSchema).max(CHAT_RUNTIME_LIMITS.citations),
  events: z.array(AgentPresentationEventSchema).max(CHAT_RUNTIME_LIMITS.agentEvents),
}).superRefine((value, context) => {
  if (value.status === 'completed' && value.answer.trim().length === 0) {
    context.addIssue({
      code: 'custom',
      message: 'Completed responses require a non-empty answer',
      path: ['answer'],
    });
  }
  if (value.status !== 'completed' && value.answer.length > 0) {
    context.addIssue({
      code: 'custom',
      message: 'Non-completed responses cannot expose a partial answer',
      path: ['answer'],
    });
  }

  const citationIds = new Set<string>();
  for (let index = 0; index < value.citations.length; index += 1) {
    const citation = value.citations[index];
    if (!citation) continue;
    if (citationIds.has(citation.id)) {
      context.addIssue({
        code: 'custom',
        message: 'Citation IDs must be unique',
        path: ['citations', index, 'id'],
      });
    }
    citationIds.add(citation.id);
  }
});

export type AgentResponse = z.infer<typeof AgentResponseSchema>;

export function createAgentResponseRecovery(): AgentResponse {
  return {
    version: CHAT_RUNTIME_CONTRACT_VERSION,
    turnId: 'runtime-recovery',
    status: 'unknown',
    answer: '',
    diagnostics: [{
      severity: 'error',
      code: 'runtime_contract_error',
      message: 'Runtime response unavailable.',
    }],
    citations: [],
    events: [],
  };
}

export function decodeAgentResponse(input: unknown): AgentResponse {
  return parseWithoutThrow(AgentResponseSchema, input) ?? createAgentResponseRecovery();
}

const StreamChunkCommonSchema = {
  version: z.literal(CHAT_RUNTIME_CONTRACT_VERSION),
  turnId: RuntimeIdSchema,
  sequence: SequenceSchema,
};

const StreamDeltaSchema = z.strictObject({
  ...StreamChunkCommonSchema,
  kind: z.literal('delta'),
  text: boundedText(CHAT_RUNTIME_LIMITS.streamChunkChars),
});

const StreamDoneSchema = z.strictObject({
  ...StreamChunkCommonSchema,
  kind: z.literal('done'),
});

export const StreamChunkSchema = z.discriminatedUnion('kind', [
  StreamDeltaSchema,
  StreamDoneSchema,
]);

export type StreamChunk = z.infer<typeof StreamChunkSchema>;

/**
 * Renderer-facing streamed text payload. Unlike the provider-level
 * `StreamChunk`, this includes the chat session and turn correlation IDs used
 * to reject delayed chunks from an earlier renderer turn.
 */
export const ChatStreamChunkEventSchema = z.strictObject({
  turnId: RuntimeIdSchema,
  sessionId: RuntimeIdSchema,
  content: boundedText(CHAT_RUNTIME_LIMITS.streamChunkChars),
  reasoning: boundedText(CHAT_RUNTIME_LIMITS.streamChunkChars).optional(),
  isFinished: z.boolean(),
  profileId: RuntimeIdSchema.optional(),
});
export type ChatStreamChunkEvent = z.infer<typeof ChatStreamChunkEventSchema>;

const GoalLiveEventCommonSchema = {
  version: z.literal(CHAT_RUNTIME_CONTRACT_VERSION),
  goalId: RuntimeIdSchema,
  sequence: SequenceSchema,
};

const GoalStepStartEventSchema = z.strictObject({
  ...GoalLiveEventCommonSchema,
  type: z.literal('step-start'),
  stepId: RuntimeIdSchema,
  stepName: ShortTextSchema,
});

const GoalStepCompleteEventSchema = z.strictObject({
  ...GoalLiveEventCommonSchema,
  type: z.literal('step-complete'),
  stepId: RuntimeIdSchema,
  stepName: ShortTextSchema,
  output: boundedText(CHAT_RUNTIME_LIMITS.goalOutputChars),
});

const GoalStepFailedEventSchema = z.strictObject({
  ...GoalLiveEventCommonSchema,
  type: z.literal('step-failed'),
  stepId: RuntimeIdSchema,
  stepName: ShortTextSchema,
  error: boundedText(CHAT_RUNTIME_LIMITS.goalErrorChars),
});

const GoalProgressEventSchema = z.strictObject({
  ...GoalLiveEventCommonSchema,
  type: z.literal('progress'),
  completed: z.number().int().min(0).max(CHAT_RUNTIME_LIMITS.goalSteps),
  total: z.number().int().min(0).max(CHAT_RUNTIME_LIMITS.goalSteps),
  currentStep: ShortTextSchema,
}).refine((value) => value.completed <= value.total, {
  message: 'Completed progress cannot exceed total progress',
  path: ['completed'],
});

export const GoalLiveEventSchema = z.discriminatedUnion('type', [
  GoalStepStartEventSchema,
  GoalStepCompleteEventSchema,
  GoalStepFailedEventSchema,
  GoalProgressEventSchema,
]);

export type GoalLiveEvent = z.infer<typeof GoalLiveEventSchema>;

export const RuntimeRecoverySchema = z.strictObject({
  kind: z.literal('recovery'),
  code: z.enum([
    'stream_chunk_unavailable',
    'chat_stream_chunk_event_unavailable',
    'goal_event_unavailable',
    'agent_execution_event_unavailable',
  ]),
});

export type RuntimeRecovery = z.infer<typeof RuntimeRecoverySchema>;

export type RuntimeDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; recovery: RuntimeRecovery };

function decodeWithRecovery<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code: RuntimeRecovery['code'],
): RuntimeDecodeResult<T> {
  const value = parseWithoutThrow(schema, input);
  return value === undefined
    ? { ok: false, recovery: { kind: 'recovery', code } }
    : { ok: true, value };
}

export function decodeStreamChunk(input: unknown): RuntimeDecodeResult<StreamChunk> {
  return decodeWithRecovery(StreamChunkSchema, input, 'stream_chunk_unavailable');
}

export function decodeChatStreamChunkEvent(input: unknown): RuntimeDecodeResult<ChatStreamChunkEvent> {
  return decodeWithRecovery(ChatStreamChunkEventSchema, input, 'chat_stream_chunk_event_unavailable');
}

export function decodeAgentExecutionEvent(input: unknown): RuntimeDecodeResult<AgentExecutionEvent> {
  return decodeWithRecovery(AgentExecutionEventSchema, input, 'agent_execution_event_unavailable');
}

export function decodeGoalLiveEvent(input: unknown): RuntimeDecodeResult<GoalLiveEvent> {
  return decodeWithRecovery(GoalLiveEventSchema, input, 'goal_event_unavailable');
}
