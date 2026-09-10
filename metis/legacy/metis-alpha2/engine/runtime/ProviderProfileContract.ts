import { z } from 'zod';
import {
  SETUP_RUNTIME_LIMITS,
  SetupApiKeySchema,
  SetupBaseUrlSchema,
  SetupModelSchema,
  SetupOperationIdSchema,
} from './SetupRuntimeContract.js';

/** Versioned, renderer-safe contract for named provider profiles. */
export const PROVIDER_PROFILE_CONTRACT_VERSION = 1 as const;

export const PROVIDER_PROFILE_LIMITS = Object.freeze({
  profiles: 64,
  nameChars: 96,
  maxContextTokens: SETUP_RUNTIME_LIMITS.contextTokens,
} as const);

// eslint-disable-next-line no-control-regex
const PROFILE_NAME_UNSAFE = /[\u0000-\u001f\u007f]/u;

export const ProviderProfileIdSchema = z.string().uuid();

export const ProviderProfileNameSchema = z.string()
  .min(1)
  .max(PROVIDER_PROFILE_LIMITS.nameChars)
  .refine((value) => value === value.trim() && !PROFILE_NAME_UNSAFE.test(value), {
    message: 'provider_profile_name_invalid',
  });

export const ProviderProfileMaxContextTokensSchema = z.number()
  .int()
  .min(0)
  .max(PROVIDER_PROFILE_LIMITS.maxContextTokens);

export const ProviderProfileSummarySchema = z.strictObject({
  id: ProviderProfileIdSchema,
  name: ProviderProfileNameSchema,
  baseUrl: SetupBaseUrlSchema,
  model: SetupModelSchema,
  vision: z.boolean(),
  maxContextTokens: ProviderProfileMaxContextTokensSchema,
  apiKeyStored: z.literal(true),
  isActive: z.boolean(),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  // 传输层可调参数回显（2026-09-06 P0 遗留：设置页表单需要回填当前值）。
  timeout: z.number().int().min(1_000).max(1_800_000).optional(),
  maxRetries: z.number().int().min(0).max(SETUP_RUNTIME_LIMITS.strategyRetries).optional(),
});
export type ProviderProfileSummary = z.infer<typeof ProviderProfileSummarySchema>;

const ProviderProfileRequestBaseSchema = z.strictObject({
  contractVersion: z.literal(PROVIDER_PROFILE_CONTRACT_VERSION),
  operationId: SetupOperationIdSchema,
});

export const ProviderProfileListRequestSchema = ProviderProfileRequestBaseSchema;
export type ProviderProfileListRequest = z.infer<typeof ProviderProfileListRequestSchema>;

export const ProviderProfileSaveRequestSchema = ProviderProfileRequestBaseSchema.extend({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  id: ProviderProfileIdSchema.optional(),
  name: ProviderProfileNameSchema,
  baseUrl: SetupBaseUrlSchema,
  model: SetupModelSchema,
  vision: z.boolean(),
  maxContextTokens: ProviderProfileMaxContextTokensSchema,
  keyMode: z.enum(['replace', 'saved']),
  newApiKey: SetupApiKeySchema.optional(),
  // 传输层可调参数（2026-08-22）：缺省时保留现有值，让已建 profile 可被修正。
  timeout: z.number().int().min(1_000).max(1_800_000).optional(),
  maxRetries: z.number().int().min(0).max(SETUP_RUNTIME_LIMITS.strategyRetries).optional(),
  retryBackoffSeconds: z.number().min(0).max(300).optional(),
}).superRefine((value, context) => {
  if (value.keyMode === 'replace' && !value.newApiKey) {
    context.addIssue({ code: 'custom', path: ['newApiKey'], message: 'provider_profile_api_key_required' });
  }
  if (value.keyMode === 'saved' && (value.newApiKey !== undefined || !value.id)) {
    context.addIssue({ code: 'custom', path: ['keyMode'], message: 'provider_profile_saved_key_invalid' });
  }
});
export type ProviderProfileSaveRequest = z.infer<typeof ProviderProfileSaveRequestSchema>;

export const ProviderProfileSwitchRequestSchema = ProviderProfileRequestBaseSchema.extend({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  id: ProviderProfileIdSchema,
});
export type ProviderProfileSwitchRequest = z.infer<typeof ProviderProfileSwitchRequestSchema>;

export const ProviderProfileDeleteRequestSchema = ProviderProfileRequestBaseSchema.extend({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  id: ProviderProfileIdSchema,
  replacementActiveId: ProviderProfileIdSchema.optional(),
});
export type ProviderProfileDeleteRequest = z.infer<typeof ProviderProfileDeleteRequestSchema>;

export const ProviderProfileResetRequestSchema = ProviderProfileRequestBaseSchema.extend({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type ProviderProfileResetRequest = z.infer<typeof ProviderProfileResetRequestSchema>;

// ─── Per-project provider/model override (O13) ────────────────
//
// 项目级覆盖：允许某个项目脱离全局激活 profile，使用自己的模型连接 / 模型 /
// 系统提示。覆盖存于 projects.metadata.providerOverride（JSON settings 存储，
// 无需 schema 迁移，不破坏既有数据）。运行时由 GoalEngine / WorkflowEngine 把
// 解析结果（ProviderProfileBinding）绑定到每一次 goal/run 记录上。

/** 单个项目允许覆盖的字段。全部可选；至少一个字段存在才视为有效覆盖。 */
export const PROJECT_PROVIDER_OVERRIDE_LIMITS = Object.freeze({
  systemPromptChars: 4000,
} as const);

export const ProjectProviderOverrideSchema = z.strictObject({
  /** 覆盖使用的 provider profile（取自全局 profile 列表的 id）。 */
  providerProfileId: ProviderProfileIdSchema.optional(),
  /** 仅覆盖模型名（沿用同一连接的 baseUrl/apiKey 时）。 */
  model: SetupModelSchema.optional(),
  /** 项目级系统提示，注入到每次执行的 system 消息之前。 */
  systemPrompt: z.string().min(1).max(PROJECT_PROVIDER_OVERRIDE_LIMITS.systemPromptChars).optional(),
});
export type ProjectProviderOverride = z.infer<typeof ProjectProviderOverrideSchema>;

/**
 * 运行时绑定：某次 goal/run 实际使用的 provider profile 解析结果。
 * source 标记绑定来源，便于审计 run 记录时区分「全局默认」与「项目覆盖」。
 */
export const ProviderProfileBindingSchema = z.strictObject({
  source: z.enum(['global', 'project_override']),
  /** 生效的 profile id；全局无激活 profile 时为 null。 */
  profileId: z.string().nullable(),
  /** 生效模型名。 */
  model: z.string(),
  /** 项目级系统提示（仅 project_override 来源可能存在）。 */
  systemPrompt: z.string().optional(),
});
export type ProviderProfileBinding = z.infer<typeof ProviderProfileBindingSchema>;

export interface GlobalProviderProfileRef {
  /** 全局激活 profile id（无激活 profile 时为 null）。 */
  profileId: string | null;
  /** 全局激活 profile 的模型名。 */
  model: string;
}

/** Public, credential-free availability used by runtime routing. */
export interface ProviderProfileAvailabilityRef {
  id: string;
  model: string;
  /** Main process derives this from secure storage; the key never enters this contract. */
  available: boolean;
}

export type ProjectProviderOverrideDecode =
  | { status: 'absent' }
  | { status: 'valid'; override: ProjectProviderOverride }
  | { status: 'invalid' };

/**
 * Decode the metadata value while preserving the distinction between an absent
 * override and damaged/unsupported project data. This distinction is required
 * for fail-closed routing; a malformed override must not silently become the
 * global profile.
 */
export function decodeProjectProviderOverrideState(raw: unknown): ProjectProviderOverrideDecode {
  if (raw === undefined || raw === null) return { status: 'absent' };
  const result = ProjectProviderOverrideSchema.safeParse(raw);
  if (!result.success) return { status: 'invalid' };
  const value = result.data;
  if (!value.providerProfileId && !value.model && !value.systemPrompt) return { status: 'absent' };
  return { status: 'valid', override: value };
}

export type ProviderProfileResolutionReason =
  | 'global_profile_unavailable'
  | 'project_override_invalid'
  | 'project_profile_not_found'
  | 'project_profile_unavailable'
  | 'project_runtime_unavailable';

export type ProviderProfileRuntimeResolution =
  | { status: 'ready'; binding: ProviderProfileBinding }
  | { status: 'pending'; reason: ProviderProfileResolutionReason; binding?: ProviderProfileBinding };

export interface ProviderProfileRuntimeInput {
  global: GlobalProviderProfileRef & { available: boolean };
  profiles: readonly ProviderProfileAvailabilityRef[];
}

function resolveProviderProfileRuntimeStateInternal(
  input: ProviderProfileRuntimeInput & { projectOverride: ProjectProviderOverrideDecode },
): ProviderProfileRuntimeResolution {
  const globalProfile = input.global.profileId
    ? input.profiles.find((profile) => profile.id === input.global.profileId)
    : undefined;
  const globalAvailable = input.global.available
    && input.global.model.trim().length > 0
    && (input.global.profileId === null || Boolean(globalProfile?.available));
  const decoded = input.projectOverride;
  if (decoded.status === 'invalid') return { status: 'pending', reason: 'project_override_invalid' };

  if (decoded.status === 'absent') {
    if (!globalAvailable) return { status: 'pending', reason: 'global_profile_unavailable' };
    return { status: 'ready', binding: { source: 'global', profileId: input.global.profileId, model: input.global.model } };
  }

  const override = decoded.override;
  if (override.providerProfileId) {
    const selected = input.profiles.find((profile) => profile.id === override.providerProfileId);
    if (!selected) {
      return {
        status: 'pending',
        reason: 'project_profile_not_found',
        binding: resolveProviderProfileBinding(input.global, override),
      };
    }
    if (!selected.available) {
      return {
        status: 'pending',
        reason: 'project_profile_unavailable',
        binding: resolveProviderProfileBinding(input.global, override, selected.model),
      };
    }
    return {
      status: 'ready',
      binding: resolveProviderProfileBinding(input.global, override, selected.model),
    };
  }

  if (!globalAvailable) {
    return {
      status: 'pending',
      reason: 'global_profile_unavailable',
      binding: resolveProviderProfileBinding(input.global, override),
    };
  }
  return { status: 'ready', binding: resolveProviderProfileBinding(input.global, override) };
}

/** Resolve a decoded metadata state without touching credentials. */
export function resolveProviderProfileRuntimeState(
  input: ProviderProfileRuntimeInput & { projectOverride: ProjectProviderOverrideDecode },
): ProviderProfileRuntimeResolution {
  return resolveProviderProfileRuntimeStateInternal(input);
}


/**
 * Resolve a project provider request without touching credentials.
 *
 * Fail-closed rules:
 *  - no override uses the global profile only when it is available;
 *  - a valid project override never falls back to global when its profile is
 *    missing/unavailable;
 *  - invalid metadata is pending and never treated as no override;
 *  - only public ids/models/availability cross this boundary.
 */
export function resolveProviderProfileRuntime(input: ProviderProfileRuntimeInput & { projectOverride?: unknown }): ProviderProfileRuntimeResolution {
  return resolveProviderProfileRuntimeState({
    ...input,
    projectOverride: decodeProjectProviderOverrideState(input.projectOverride),
  });
}

/**
 * 解析项目覆盖 → 运行时绑定（纯函数，可单测）。
 *
 * 规则：
 *  - override 为空 / 无任何有效字段 → 返回全局绑定（source: 'global'）。
 *  - override.providerProfileId 存在 → 绑定该 profile；模型取 override.model
 *    优先，其次 overrideProfileModel（该 profile 自身模型），最后退回全局模型。
 *  - 仅 override.model → 沿用全局 profile 连接但换模型。
 *  - systemPrompt 只要有值就带进绑定。
 */
export function resolveProviderProfileBinding(
  globalProfile: GlobalProviderProfileRef,
  override?: ProjectProviderOverride | null,
  overrideProfileModel?: string,
): ProviderProfileBinding {
  const hasOverride = Boolean(
    override && (override.providerProfileId || override.model || override.systemPrompt),
  );
  if (!hasOverride || !override) {
    return { source: 'global', profileId: globalProfile.profileId, model: globalProfile.model };
  }
  const profileId = override.providerProfileId ?? globalProfile.profileId;
  const model = override.model
    ?? (override.providerProfileId ? overrideProfileModel : undefined)
    ?? globalProfile.model;
  return {
    source: 'project_override',
    profileId,
    model,
    ...(override.systemPrompt ? { systemPrompt: override.systemPrompt } : {}),
  };
}

/**
 * 宽松解码项目覆盖（从 projects.metadata 读取未知 JSON 时）。
 * 解析失败或无任何有效字段时返回 null，绝不抛出。
 */
export function decodeProjectProviderOverride(raw: unknown): ProjectProviderOverride | null {
  const result = decodeProjectProviderOverrideState(raw);
  return result.status === 'valid' ? result.override : null;
}

export const ProviderProfileErrorCodeSchema = z.enum([
  'invalid_request',
  'storage_unavailable',
  'integrity_error',
  'io_error',
  'revision_conflict',
  'not_found',
  'saved_key_unavailable',
  'active_profile_requires_replacement',
  'profile_limit_reached',
  'runtime_rebuild_failed',
  'runtime_unavailable',
]);
export type ProviderProfileErrorCode = z.infer<typeof ProviderProfileErrorCodeSchema>;

const ProviderProfileResponseBaseSchema = z.strictObject({
  contractVersion: z.literal(PROVIDER_PROFILE_CONTRACT_VERSION),
  operationId: SetupOperationIdSchema,
});

export const ProviderProfileListResponseSchema = z.discriminatedUnion('ok', [
  ProviderProfileResponseBaseSchema.extend({
    ok: z.literal(true),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    profiles: z.array(ProviderProfileSummarySchema).max(PROVIDER_PROFILE_LIMITS.profiles),
  }),
  ProviderProfileResponseBaseSchema.extend({
    ok: z.literal(false),
    code: ProviderProfileErrorCodeSchema,
  }),
]);
export type ProviderProfileListResponse = z.infer<typeof ProviderProfileListResponseSchema>;

export const ProviderProfileMutationResponseSchema = z.discriminatedUnion('ok', [
  ProviderProfileResponseBaseSchema.extend({
    ok: z.literal(true),
    action: z.enum(['saved', 'switched', 'deleted', 'reset']),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    profile: ProviderProfileSummarySchema.optional(),
    activeId: ProviderProfileIdSchema.nullable(),
  }),
  ProviderProfileResponseBaseSchema.extend({
    ok: z.literal(false),
    code: ProviderProfileErrorCodeSchema,
    currentRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }),
]);
export type ProviderProfileMutationResponse = z.infer<typeof ProviderProfileMutationResponseSchema>;

type DecodeResult<T> = { ok: true; value: T } | { ok: false };

function decode<T>(schema: z.ZodType<T>, raw: unknown): DecodeResult<T> {
  const result = schema.safeParse(raw);
  return result.success ? { ok: true, value: result.data } : { ok: false };
}

export const decodeProviderProfileListRequest = (raw: unknown) => decode(ProviderProfileListRequestSchema, raw);
export const decodeProviderProfileSaveRequest = (raw: unknown) => decode(ProviderProfileSaveRequestSchema, raw);
export const decodeProviderProfileSwitchRequest = (raw: unknown) => decode(ProviderProfileSwitchRequestSchema, raw);
export const decodeProviderProfileDeleteRequest = (raw: unknown) => decode(ProviderProfileDeleteRequestSchema, raw);
export const decodeProviderProfileResetRequest = (raw: unknown) => decode(ProviderProfileResetRequestSchema, raw);

function fallbackOperationId(raw: unknown): string {
  const candidate = typeof raw === 'object' && raw !== null ? Reflect.get(raw, 'operationId') : undefined;
  return SetupOperationIdSchema.safeParse(candidate).success
    ? candidate as string
    : 'provider-profile-recovery';
}

export function createProviderProfileListRecovery(raw?: unknown): ProviderProfileListResponse {
  return {
    ok: false,
    contractVersion: PROVIDER_PROFILE_CONTRACT_VERSION,
    operationId: fallbackOperationId(raw),
    code: 'invalid_request',
  };
}

export function createProviderProfileMutationRecovery(raw?: unknown): ProviderProfileMutationResponse {
  return {
    ok: false,
    contractVersion: PROVIDER_PROFILE_CONTRACT_VERSION,
    operationId: fallbackOperationId(raw),
    code: 'invalid_request',
  };
}

export function decodeProviderProfileListResponse(raw: unknown, expectedOperationId?: string): ProviderProfileListResponse {
  const result = ProviderProfileListResponseSchema.safeParse(raw);
  if (!result.success || (expectedOperationId && result.data.operationId !== expectedOperationId)) {
    return createProviderProfileListRecovery({ operationId: expectedOperationId });
  }
  return result.data;
}

export function decodeProviderProfileMutationResponse(raw: unknown, expectedOperationId?: string): ProviderProfileMutationResponse {
  const result = ProviderProfileMutationResponseSchema.safeParse(raw);
  if (!result.success || (expectedOperationId && result.data.operationId !== expectedOperationId)) {
    return createProviderProfileMutationRecovery({ operationId: expectedOperationId });
  }
  return result.data;
}
