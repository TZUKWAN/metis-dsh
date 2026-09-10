import { z } from 'zod';
import {
  CHAT_RUNTIME_LIMITS,
  RuntimeIdSchema,
} from './ChatRuntimeContract.js';

export const SESSION_RUNTIME_LIMITS = Object.freeze({
  sessions: CHAT_RUNTIME_LIMITS.historyItems,
  titleChars: 120,
  messageCount: 1_000_000_000,
} as const);

// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const PATH_OR_URL_PATTERN = /(?:[A-Za-z]:[\\/]|\\\\|(?:https?|file):\/\/|[\\/])/iu;
const CREDENTIAL_VALUE_PATTERN = /(?:\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|authorization|cookie|credential|secret)\b\s*[:=]|\bbearer\s+\S+)/iu;

function parseWithoutThrow<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  try {
    const result = schema.safeParse(input);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export const SessionIdSchema = RuntimeIdSchema;

export const SessionTitleSchema = z.string()
  .trim()
  .min(1)
  .max(SESSION_RUNTIME_LIMITS.titleChars)
  .refine((value) => !UNSAFE_CONTROL_CHARACTERS.test(value), {
    message: 'Session title contains unsafe control characters',
  })
  .refine((value) => !PATH_OR_URL_PATTERN.test(value), {
    message: 'Session title cannot contain a local path or URL',
  })
  .refine((value) => !CREDENTIAL_VALUE_PATTERN.test(value), {
    message: 'Session title cannot contain credential material',
  });

export const SessionCreateRequestSchema = z.strictObject({
  sessionId: SessionIdSchema,
  /** Owning project id so conversations can travel with their project. */
  projectId: RuntimeIdSchema.optional(),
});

export const SessionListRequestSchema = z.strictObject({
  /** 项目内会话查询(2026-09-04 多对话架构):按 projectId 过滤;缺省返回全部。 */
  projectId: RuntimeIdSchema.optional(),
  /** 归档会话默认不返回。 */
  includeArchived: z.boolean().optional(),
});

export const SessionDeleteRequestSchema = z.strictObject({
  sessionId: SessionIdSchema,
});

export const SessionUpdatePatchSchema = z.strictObject({
  title: SessionTitleSchema.optional(),
  archived: z.boolean().optional(),
  /** 当前工作线程使用的场景(2026-09-04 多对话架构):null 表示无场景普通对话。 */
  scenarioId: z.string().max(160).nullable().optional(),
  /** 当前工作对象(项目级成果引用;数组支持多对象比较/组合)。 */
  activeArtifactIds: z.array(RuntimeIdSchema).max(24).optional(),
}).refine(
  (value) => value.title !== undefined || value.archived !== undefined || value.scenarioId !== undefined || value.activeArtifactIds !== undefined,
  { message: 'Session update patch cannot be empty' },
);

export const SessionUpdateRequestSchema = z.strictObject({
  sessionId: SessionIdSchema,
  patch: SessionUpdatePatchSchema,
});

export type SessionCreateRequest = z.infer<typeof SessionCreateRequestSchema>;
export type SessionListRequest = z.infer<typeof SessionListRequestSchema>;
export type SessionDeleteRequest = z.infer<typeof SessionDeleteRequestSchema>;
export type SessionUpdateRequest = z.infer<typeof SessionUpdateRequestSchema>;

export const SessionRequestRecoverySchema = z.strictObject({
  kind: z.literal('recovery'),
  code: z.enum([
    'session_create_request_unavailable',
    'session_list_request_unavailable',
    'session_update_request_unavailable',
    'session_delete_request_unavailable',
  ]),
});

export type SessionRequestRecovery = z.infer<typeof SessionRequestRecoverySchema>;

export type SessionRequestDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; recovery: SessionRequestRecovery };

function decodeRequest<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code: SessionRequestRecovery['code'],
): SessionRequestDecodeResult<T> {
  const value = parseWithoutThrow(schema, input);
  return value === undefined
    ? { ok: false, recovery: { kind: 'recovery', code } }
    : { ok: true, value };
}

export function decodeSessionCreateRequest(
  input: unknown,
): SessionRequestDecodeResult<SessionCreateRequest> {
  return decodeRequest(
    SessionCreateRequestSchema,
    input,
    'session_create_request_unavailable',
  );
}

export function decodeSessionListRequest(
  input: unknown,
): SessionRequestDecodeResult<SessionListRequest> {
  return decodeRequest(
    SessionListRequestSchema,
    input,
    'session_list_request_unavailable',
  );
}

export function decodeSessionUpdateRequest(
  input: unknown,
): SessionRequestDecodeResult<SessionUpdateRequest> {
  return decodeRequest(
    SessionUpdateRequestSchema,
    input,
    'session_update_request_unavailable',
  );
}

export function decodeSessionDeleteRequest(
  input: unknown,
): SessionRequestDecodeResult<SessionDeleteRequest> {
  return decodeRequest(
    SessionDeleteRequestSchema,
    input,
    'session_delete_request_unavailable',
  );
}

const TimestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const SessionListItemSchema = z.strictObject({
  id: SessionIdSchema,
  title: SessionTitleSchema.optional(),
  createdAt: TimestampSchema,
  lastActivity: TimestampSchema,
  messageCount: z.number().int().min(0).max(SESSION_RUNTIME_LIMITS.messageCount),
  archived: z.boolean(),
  projectId: RuntimeIdSchema.optional(),
  scenarioId: z.string().max(160).nullable().optional(),
  activeArtifactIds: z.array(RuntimeIdSchema).max(24).optional(),
}).refine((value) => value.lastActivity >= value.createdAt, {
  message: 'Session activity cannot predate session creation',
  path: ['lastActivity'],
});

export type SessionListItem = z.infer<typeof SessionListItemSchema>;

const LegacySessionRecordSchema = z.strictObject({
  id: SessionIdSchema,
  title: z.unknown().optional(),
  createdAt: TimestampSchema,
  lastActivity: TimestampSchema,
  messageCount: z.number().int().min(0).max(SESSION_RUNTIME_LIMITS.messageCount),
  archived: z.unknown().optional(),
  metadata: z.unknown().optional(),
  projectId: RuntimeIdSchema.optional(),
  scenarioId: z.string().max(160).nullable().optional(),
  activeArtifactIds: z.array(RuntimeIdSchema).max(24).optional(),
}).refine((value) => value.lastActivity >= value.createdAt, {
  message: 'Session activity cannot predate session creation',
  path: ['lastActivity'],
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function selectLegacyMetadata(metadata: unknown): {
  title?: string;
  archived: boolean;
} {
  if (!isPlainRecord(metadata)) return { archived: false };

  let rawTitle: unknown;
  let rawArchived: unknown;
  try {
    rawTitle = metadata.title;
    rawArchived = metadata.archived;
  } catch {
    return { archived: false };
  }

  const title = parseWithoutThrow(SessionTitleSchema, rawTitle);
  return {
    ...(title === undefined ? {} : { title }),
    archived: rawArchived === true,
  };
}

export const SessionRecordRecoverySchema = z.strictObject({
  kind: z.literal('recovery'),
  code: z.literal('session_record_unavailable'),
});

export type SessionRecordDecodeResult =
  | { ok: true; value: SessionListItem }
  | { ok: false; recovery: z.infer<typeof SessionRecordRecoverySchema> };

export function decodeLegacySessionRecord(input: unknown): SessionRecordDecodeResult {
  const record = parseWithoutThrow(LegacySessionRecordSchema, input);
  if (!record) {
    return {
      ok: false,
      recovery: { kind: 'recovery', code: 'session_record_unavailable' },
    };
  }

  const metadata = selectLegacyMetadata(record.metadata);
  const title = metadata.title ?? parseWithoutThrow(SessionTitleSchema, record.title);
  const presentation = {
    id: record.id,
    ...(title === undefined ? {} : { title }),
    createdAt: record.createdAt,
    lastActivity: record.lastActivity,
    messageCount: record.messageCount,
    archived: metadata.archived || record.archived === true,
    ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
    ...(record.scenarioId === undefined ? {} : { scenarioId: record.scenarioId }),
    ...(record.activeArtifactIds === undefined ? {} : { activeArtifactIds: record.activeArtifactIds }),
  };
  const value = parseWithoutThrow(SessionListItemSchema, presentation);
  return value === undefined
    ? {
        ok: false,
        recovery: { kind: 'recovery', code: 'session_record_unavailable' },
      }
    : { ok: true, value };
}

const SessionListSuccessSchema = z.strictObject({
  success: z.literal(true),
  sessions: z.array(SessionListItemSchema).max(SESSION_RUNTIME_LIMITS.sessions),
});

const SessionListFailureSchema = z.strictObject({
  success: z.literal(false),
  code: z.literal('session_list_unavailable'),
  sessions: z.tuple([]),
});

export const SessionListResponseSchema = z.discriminatedUnion('success', [
  SessionListSuccessSchema,
  SessionListFailureSchema,
]);

export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

export function createSessionListRecovery(): SessionListResponse {
  return { success: false, code: 'session_list_unavailable', sessions: [] };
}

export function decodeLegacySessionList(input: unknown): SessionListResponse {
  const records = parseWithoutThrow(
    z.array(z.unknown()).max(SESSION_RUNTIME_LIMITS.sessions),
    input,
  );
  if (!records) return createSessionListRecovery();

  const sessions: SessionListItem[] = [];
  for (const record of records) {
    const decoded = decodeLegacySessionRecord(record);
    if (!decoded.ok) return createSessionListRecovery();
    sessions.push(decoded.value);
  }
  return { success: true, sessions };
}

export function decodeSessionListResponse(input: unknown): SessionListResponse {
  return parseWithoutThrow(SessionListResponseSchema, input) ?? createSessionListRecovery();
}

/**
 * Renderer-side compatibility decoder. Production preload returns the versioned
 * response shape, while older test doubles or databases may still surface the
 * legacy SessionRecord array. Both paths end in the same safe presentation type.
 */
export function decodeSessionListPayload(input: unknown): SessionListResponse {
  const response = parseWithoutThrow(SessionListResponseSchema, input);
  return response ?? decodeLegacySessionList(input);
}

export const SessionMutationCodeSchema = z.enum([
  'created',
  'updated',
  'deleted',
  'not_found',
  'rejected',
  'session_mutation_unavailable',
]);

export const SessionMutationResultSchema = z.strictObject({
  success: z.boolean(),
  code: SessionMutationCodeSchema.optional(),
}).superRefine((value, context) => {
  const successCodes = new Set(['created', 'updated', 'deleted']);
  if (value.success && value.code !== undefined && !successCodes.has(value.code)) {
    context.addIssue({
      code: 'custom',
      message: 'Successful session mutation has an invalid code',
      path: ['code'],
    });
  }
  if (!value.success && value.code !== undefined && successCodes.has(value.code)) {
    context.addIssue({
      code: 'custom',
      message: 'Failed session mutation cannot use a success code',
      path: ['code'],
    });
  }
});

export type SessionMutationResult = z.infer<typeof SessionMutationResultSchema>;

export function createSessionMutationRecovery(): SessionMutationResult {
  return { success: false, code: 'session_mutation_unavailable' };
}

export function decodeSessionMutationResult(input: unknown): SessionMutationResult {
  return parseWithoutThrow(SessionMutationResultSchema, input)
    ?? createSessionMutationRecovery();
}
