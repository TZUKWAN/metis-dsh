import { z } from 'zod';

export const SETUP_RUNTIME_CONTRACT_VERSION = 1 as const;

export const SETUP_RUNTIME_LIMITS = Object.freeze({
  baseUrlChars: 2_048,
  apiKeyChars: 4_096,
  modelChars: 256,
  operationIdChars: 128,
  configVersion: Number.MAX_SAFE_INTEGER,
  contextTokens: 10_000_000,
  strategyTurns: 128,
  strategyTools: 64,
  strategyRetries: 20,
  strategyReviewInterval: 128,
  outputTokens: 1_000_000,
  warnings: 8,
} as const);

export const SETUP_DEFAULT_INPUT = Object.freeze({
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
} as const);

// eslint-disable-next-line no-control-regex
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const ANY_WHITESPACE = /\s/u;
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

function parseWithoutThrow<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  try {
    const result = schema.safeParse(input);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '[::1]'
    || normalized === '::1';
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  const path = url.pathname === '/'
    ? ''
    : url.pathname.replace(/\/+$/u, '');
  return `${url.origin}${path}`;
}

export const SetupBaseUrlSchema = z.string()
  .min(1)
  .max(SETUP_RUNTIME_LIMITS.baseUrlChars)
  .superRefine((value, context) => {
    if (
      value !== value.trim()
      || UNSAFE_CONTROL_CHARACTERS.test(value)
      || ANY_WHITESPACE.test(value)
      || value.includes('\\')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'setup_api_url_invalid',
      });
      return;
    }

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'setup_api_url_invalid',
      });
      return;
    }

    const protocolAllowed = url.protocol === 'https:'
      || (url.protocol === 'http:' && isLoopbackHostname(url.hostname));
    if (
      !protocolAllowed
      || !url.hostname
      || url.username !== ''
      || url.password !== ''
      || url.search !== ''
      || url.hash !== ''
    ) {
      context.addIssue({
        code: 'custom',
        message: 'setup_api_url_invalid',
      });
    }
  })
  .transform(normalizeBaseUrl);

export const SetupApiKeySchema = z.string()
  .min(8)
  .max(SETUP_RUNTIME_LIMITS.apiKeyChars)
  .refine((value) => (
    value === value.trim()
    && !UNSAFE_CONTROL_CHARACTERS.test(value)
    && !ANY_WHITESPACE.test(value)
  ), {
    message: 'setup_api_key_invalid',
  });

export const SetupModelSchema = z.string()
  .min(1)
  .max(SETUP_RUNTIME_LIMITS.modelChars)
  .refine((value) => (
    value === value.trim()
    && !UNSAFE_CONTROL_CHARACTERS.test(value)
    && MODEL_NAME_PATTERN.test(value)
  ), {
    message: 'setup_model_invalid',
  });

export const SetupInputSchema = z.strictObject({
  baseUrl: SetupBaseUrlSchema,
  apiKey: SetupApiKeySchema,
  model: SetupModelSchema,
});

export type SetupInput = z.infer<typeof SetupInputSchema>;

export const SetupInputFieldSchema = z.enum(['baseUrl', 'apiKey', 'model']);
export type SetupInputField = z.infer<typeof SetupInputFieldSchema>;

export const SetupInputFieldErrorCodeSchema = z.enum([
  'setup_api_url_invalid',
  'setup_api_key_invalid',
  'setup_model_invalid',
]);
export type SetupInputFieldErrorCode = z.infer<typeof SetupInputFieldErrorCodeSchema>;

export type SetupInputInspection =
  | { ok: true; value: SetupInput }
  | {
      ok: false;
      code: 'setup_input_invalid';
      fieldErrors: Partial<Record<SetupInputField, SetupInputFieldErrorCode>>;
    };

export function inspectSetupInput(input: unknown): SetupInputInspection {
  const result = (() => {
    try {
      return SetupInputSchema.safeParse(input);
    } catch {
      return undefined;
    }
  })();

  if (result?.success) return { ok: true, value: result.data };

  const fieldErrors: Partial<Record<SetupInputField, SetupInputFieldErrorCode>> = {};
  for (const issue of result?.error.issues ?? []) {
    const field = issue.path[0];
    if (field === 'baseUrl') fieldErrors.baseUrl = 'setup_api_url_invalid';
    if (field === 'apiKey') fieldErrors.apiKey = 'setup_api_key_invalid';
    if (field === 'model') fieldErrors.model = 'setup_model_invalid';
  }
  return { ok: false, code: 'setup_input_invalid', fieldErrors };
}

export const SetupOperationIdSchema = z.string()
  .min(1)
  .max(SETUP_RUNTIME_LIMITS.operationIdChars)
  .regex(OPERATION_ID_PATTERN);

export const SetupProbeIdSchema = z.string().uuid();
export const SetupConfigVersionSchema = z.number()
  .int()
  .min(0)
  .max(SETUP_RUNTIME_LIMITS.configVersion);
const PositiveSetupConfigVersionSchema = SetupConfigVersionSchema
  .refine((value) => value > 0);

export const SetupStageSchema = z.enum([
  'input',
  'probe',
  'save',
  'restore',
  'runtime',
]);
export type SetupStage = z.infer<typeof SetupStageSchema>;

export const SetupErrorCodeSchema = z.enum([
  'setup_request_unavailable',
  'setup_input_invalid',
  'setup_api_url_invalid',
  'setup_api_key_invalid',
  'setup_model_invalid',
  'setup_secure_storage_unavailable',
  'setup_probe_unauthorized',
  'setup_probe_forbidden',
  'setup_probe_model_not_found',
  'setup_probe_rate_limited',
  'setup_probe_timeout',
  'setup_probe_tls_failed',
  'setup_probe_network_unavailable',
  'setup_probe_server_unavailable',
  'setup_probe_response_unavailable',
  'setup_probe_expired',
  'setup_save_conflict',
  'setup_save_failed',
  'setup_save_rollback_failed',
  'setup_config_invalid',
  'setup_config_decrypt_failed',
  'setup_restore_failed',
  'setup_runtime_rebuild_failed',
  'setup_operation_aborted',
]);
export type SetupErrorCode = z.infer<typeof SetupErrorCodeSchema>;

export const SetupRecoveryActionSchema = z.enum([
  'edit_api_url',
  'edit_api_key',
  'edit_model',
  'retry',
  'wait_and_retry',
  'restart_app',
  'contact_support',
]);
export type SetupRecoveryAction = z.infer<typeof SetupRecoveryActionSchema>;

export const SetupRecoverySchema = z.strictObject({
  kind: z.literal('recovery'),
  code: SetupErrorCodeSchema,
  stage: SetupStageSchema,
  action: SetupRecoveryActionSchema,
  retryable: z.boolean(),
});
export type SetupRecovery = z.infer<typeof SetupRecoverySchema>;

const RECOVERY_POLICIES: Record<SetupErrorCode, {
  stage: SetupStage;
  action: SetupRecoveryAction;
  retryable: boolean;
}> = {
  setup_request_unavailable: { stage: 'input', action: 'retry', retryable: true },
  setup_input_invalid: { stage: 'input', action: 'retry', retryable: true },
  setup_api_url_invalid: { stage: 'input', action: 'edit_api_url', retryable: true },
  setup_api_key_invalid: { stage: 'input', action: 'edit_api_key', retryable: true },
  setup_model_invalid: { stage: 'input', action: 'edit_model', retryable: true },
  setup_secure_storage_unavailable: { stage: 'save', action: 'restart_app', retryable: true },
  setup_probe_unauthorized: { stage: 'probe', action: 'edit_api_key', retryable: true },
  setup_probe_forbidden: { stage: 'probe', action: 'edit_api_key', retryable: true },
  setup_probe_model_not_found: { stage: 'probe', action: 'edit_model', retryable: true },
  setup_probe_rate_limited: { stage: 'probe', action: 'wait_and_retry', retryable: true },
  setup_probe_timeout: { stage: 'probe', action: 'retry', retryable: true },
  setup_probe_tls_failed: { stage: 'probe', action: 'edit_api_url', retryable: true },
  setup_probe_network_unavailable: { stage: 'probe', action: 'retry', retryable: true },
  setup_probe_server_unavailable: { stage: 'probe', action: 'wait_and_retry', retryable: true },
  setup_probe_response_unavailable: { stage: 'probe', action: 'retry', retryable: true },
  setup_probe_expired: { stage: 'probe', action: 'retry', retryable: true },
  setup_save_conflict: { stage: 'save', action: 'retry', retryable: true },
  setup_save_failed: { stage: 'save', action: 'retry', retryable: true },
  setup_save_rollback_failed: { stage: 'save', action: 'restart_app', retryable: false },
  setup_config_invalid: { stage: 'restore', action: 'contact_support', retryable: false },
  setup_config_decrypt_failed: { stage: 'restore', action: 'edit_api_key', retryable: true },
  setup_restore_failed: { stage: 'restore', action: 'restart_app', retryable: true },
  setup_runtime_rebuild_failed: { stage: 'runtime', action: 'retry', retryable: true },
  setup_operation_aborted: { stage: 'runtime', action: 'retry', retryable: true },
};

export function createSetupRecovery(
  code: SetupErrorCode,
  overrides: Partial<Pick<SetupRecovery, 'stage' | 'action' | 'retryable'>> = {},
): SetupRecovery {
  const policy = RECOVERY_POLICIES[code];
  return {
    kind: 'recovery',
    code,
    stage: overrides.stage ?? policy.stage,
    action: overrides.action ?? policy.action,
    retryable: overrides.retryable ?? policy.retryable,
  };
}

export const SetupCapabilityWarningSchema = z.enum([
  'setup_native_tools_unavailable',
  'setup_streaming_unavailable',
  'setup_structured_output_unavailable',
  'setup_context_length_unknown',
]);
export type SetupCapabilityWarning = z.infer<typeof SetupCapabilityWarningSchema>;

export const SetupCapabilitiesSchema = z.strictObject({
  streaming: z.boolean(),
  nativeToolCalling: z.boolean(),
  structuredOutput: z.boolean(),
  maxContextTokens: z.union([
    z.null(),
    z.number().int().min(1).max(SETUP_RUNTIME_LIMITS.contextTokens),
  ]),
  multimodal: z.boolean(),
});
export type SetupCapabilities = z.infer<typeof SetupCapabilitiesSchema>;

export const SetupAdaptiveStrategySchema = z.strictObject({
  tier: z.enum(['micro', 'small', 'standard', 'powerful']),
  maxTurnsPerStep: z.number().int().min(1).max(SETUP_RUNTIME_LIMITS.strategyTurns),
  maxToolsPerTurn: z.number().int().min(1).max(SETUP_RUNTIME_LIMITS.strategyTools),
  maxRetries: z.number().int().min(0).max(SETUP_RUNTIME_LIMITS.strategyRetries),
  reviewEveryNTurns: z.number().int().min(1).max(SETUP_RUNTIME_LIMITS.strategyReviewInterval),
  forceStructuredOutput: z.boolean(),
  contextBudgetTokens: z.number().int().min(1).max(SETUP_RUNTIME_LIMITS.contextTokens),
  maxOutputTokens: z.number().int().min(1).max(SETUP_RUNTIME_LIMITS.outputTokens),
  nativeToolCalling: z.boolean(),
});
export type SetupAdaptiveStrategy = z.infer<typeof SetupAdaptiveStrategySchema>;

const SetupCapabilityWarningsSchema = z.array(SetupCapabilityWarningSchema)
  .max(SETUP_RUNTIME_LIMITS.warnings)
  .refine((value) => new Set(value).size === value.length, {
    message: 'Setup capability warnings must be unique',
  });

export const SetupProgressPhaseSchema = z.enum([
  'validating_input',
  'checking_connection',
  'checking_tool_use',
  'checking_structured_output',
  'checking_streaming',
  'checking_model_details',
  'preparing_runtime',
  'protecting_api_key',
  'saving_configuration',
  'activating_runtime',
  'complete',
]);
export type SetupProgressPhase = z.infer<typeof SetupProgressPhaseSchema>;

export const SetupProgressEventSchema = z.strictObject({
  version: z.literal(SETUP_RUNTIME_CONTRACT_VERSION),
  operationId: SetupOperationIdSchema,
  phase: SetupProgressPhaseSchema,
  percent: z.number().int().min(0).max(100),
}).superRefine((value, context) => {
  if (value.phase === 'complete' && value.percent !== 100) {
    context.addIssue({
      code: 'custom',
      message: 'Completed setup progress must be 100 percent',
      path: ['percent'],
    });
  }
  if (value.phase !== 'complete' && value.percent >= 100) {
    context.addIssue({
      code: 'custom',
      message: 'Running setup progress must remain below 100 percent',
      path: ['percent'],
    });
  }
});
export type SetupProgressEvent = z.infer<typeof SetupProgressEventSchema>;

export const SetupProbeRequestSchema = z.strictObject({
  version: z.literal(SETUP_RUNTIME_CONTRACT_VERSION),
  operationId: SetupOperationIdSchema,
  input: SetupInputSchema,
});
export type SetupProbeRequest = z.infer<typeof SetupProbeRequestSchema>;

// ═══════════════════════════════════════════════════════════════════
// Strict keyMode-aware probe request (REVIEW-465 P0 fix)
// ═══════════════════════════════════════════════════════════════════

export const SetupKeyModeSchema = z.enum(['saved', 'replace']);
export type SetupKeyMode = z.infer<typeof SetupKeyModeSchema>;

/**
 * Strict probe request with explicit keyMode.
 * - saved:  uses existing stored key (no newApiKey in request)
 * - replace: provides newApiKey that meets SetupApiKeySchema (min 8, no control chars)
 *
 * The old SetupProbeRequestSchema is kept for backward compat during migration.
 */
export const SettingsProviderProbeRequestSchema = z.strictObject({
  version: z.literal(SETUP_RUNTIME_CONTRACT_VERSION),
  operationId: SetupOperationIdSchema,
  keyMode: SetupKeyModeSchema,
  baseUrl: SetupBaseUrlSchema,
  model: SetupModelSchema,
  newApiKey: SetupApiKeySchema.optional(),
}).superRefine((value, context) => {
  // saved mode: newApiKey must be absent
  if (value.keyMode === 'saved' && value.newApiKey !== undefined) {
    context.addIssue({
      code: 'custom',
      message: 'saved mode must not include newApiKey',
      path: ['newApiKey'],
    });
  }
  // replace mode: newApiKey must be present
  if (value.keyMode === 'replace' && value.newApiKey === undefined) {
    context.addIssue({
      code: 'custom',
      message: 'replace mode requires newApiKey',
      path: ['newApiKey'],
    });
  }
});
export type SettingsProviderProbeRequest = z.infer<typeof SettingsProviderProbeRequestSchema>;

export function decodeSettingsProviderProbeRequest(
  input: unknown,
): SetupRequestDecodeResult<SettingsProviderProbeRequest> {
  return decodeRequest(SettingsProviderProbeRequestSchema, input);
}

const SetupProbeSuccessSchema = z.strictObject({
  version: z.literal(SETUP_RUNTIME_CONTRACT_VERSION),
  operationId: SetupOperationIdSchema,
  success: z.literal(true),
  probeId: SetupProbeIdSchema,
  configVersion: SetupConfigVersionSchema,
  capabilities: SetupCapabilitiesSchema,
  strategy: SetupAdaptiveStrategySchema,
  warnings: SetupCapabilityWarningsSchema,
});

const SetupProbeFailureSchema = z.strictObject({
  version: z.literal(SETUP_RUNTIME_CONTRACT_VERSION),
  operationId: SetupOperationIdSchema,
  success: z.literal(false),
  recovery: SetupRecoverySchema,
});

export const SetupProbeResponseSchema = z.discriminatedUnion('success', [
  SetupProbeSuccessSchema,
  SetupProbeFailureSchema,
]);
export type SetupProbeResponse = z.infer<typeof SetupProbeResponseSchema>;
export type SetupProbeSuccess = z.infer<typeof SetupProbeSuccessSchema>;

export const SetupSaveRequestSchema = z.strictObject({
  version: z.literal(SETUP_RUNTIME_CONTRACT_VERSION),
  operationId: SetupOperationIdSchema,
  expectedConfigVersion: SetupConfigVersionSchema,
  probeId: SetupProbeIdSchema,
});
export type SetupSaveRequest = z.infer<typeof SetupSaveRequestSchema>;

export const SetupPublicConfigSchema = z.strictObject({
  baseUrl: SetupBaseUrlSchema,
  model: SetupModelSchema,
  apiKeyStored: z.literal(true),
});
export type SetupPublicConfig = z.infer<typeof SetupPublicConfigSchema>;

const SetupSaveSuccessSchema = z.strictObject({
  version: z.literal(SETUP_RUNTIME_CONTRACT_VERSION),
  operationId: SetupOperationIdSchema,
  success: z.literal(true),
  configVersion: PositiveSetupConfigVersionSchema,
  config: SetupPublicConfigSchema,
  capabilities: SetupCapabilitiesSchema,
  strategy: SetupAdaptiveStrategySchema,
  warnings: SetupCapabilityWarningsSchema,
});

const SetupSaveFailureSchema = z.strictObject({
  version: z.literal(SETUP_RUNTIME_CONTRACT_VERSION),
  operationId: SetupOperationIdSchema,
  success: z.literal(false),
  recovery: SetupRecoverySchema,
});

export const SetupSaveResponseSchema = z.discriminatedUnion('success', [
  SetupSaveSuccessSchema,
  SetupSaveFailureSchema,
]);
export type SetupSaveResponse = z.infer<typeof SetupSaveResponseSchema>;
export type SetupSaveSuccess = z.infer<typeof SetupSaveSuccessSchema>;

export const SetupRestoreRequestSchema = z.strictObject({
  version: z.literal(SETUP_RUNTIME_CONTRACT_VERSION),
  operationId: SetupOperationIdSchema,
});
export type SetupRestoreRequest = z.infer<typeof SetupRestoreRequestSchema>;

const SetupRestoreNotConfiguredSchema = z.strictObject({
  version: z.literal(SETUP_RUNTIME_CONTRACT_VERSION),
  operationId: SetupOperationIdSchema,
  state: z.literal('not_configured'),
  configVersion: z.literal(0),
});

const SetupRestoreReadySchema = z.strictObject({
  version: z.literal(SETUP_RUNTIME_CONTRACT_VERSION),
  operationId: SetupOperationIdSchema,
  state: z.literal('ready'),
  configVersion: PositiveSetupConfigVersionSchema,
  config: SetupPublicConfigSchema,
  capabilities: SetupCapabilitiesSchema,
  strategy: SetupAdaptiveStrategySchema,
  warnings: SetupCapabilityWarningsSchema,
});

const SetupRestoreRecoverySchema = z.strictObject({
  version: z.literal(SETUP_RUNTIME_CONTRACT_VERSION),
  operationId: SetupOperationIdSchema,
  state: z.literal('recovery'),
  recovery: SetupRecoverySchema,
});

export const SetupRestoreResponseSchema = z.discriminatedUnion('state', [
  SetupRestoreNotConfiguredSchema,
  SetupRestoreReadySchema,
  SetupRestoreRecoverySchema,
]);
export type SetupRestoreResponse = z.infer<typeof SetupRestoreResponseSchema>;
export type SetupRestoreReady = z.infer<typeof SetupRestoreReadySchema>;

export const SetupAbortRequestSchema = z.strictObject({
  version: z.literal(SETUP_RUNTIME_CONTRACT_VERSION),
  operationId: SetupOperationIdSchema,
});
export type SetupAbortRequest = z.infer<typeof SetupAbortRequestSchema>;

export const SetupAbortResponseSchema = z.strictObject({
  version: z.literal(SETUP_RUNTIME_CONTRACT_VERSION),
  operationId: SetupOperationIdSchema,
  success: z.boolean(),
  code: z.enum(['setup_operation_aborted', 'setup_operation_not_found']),
}).superRefine((value, context) => {
  if (value.success !== (value.code === 'setup_operation_aborted')) {
    context.addIssue({
      code: 'custom',
      message: 'Setup abort result is inconsistent',
      path: ['code'],
    });
  }
});
export type SetupAbortResponse = z.infer<typeof SetupAbortResponseSchema>;

export type SetupRequestDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; recovery: SetupRecovery };

function decodeRequest<T>(schema: z.ZodType<T>, input: unknown): SetupRequestDecodeResult<T> {
  const value = parseWithoutThrow(schema, input);
  return value === undefined
    ? { ok: false, recovery: createSetupRecovery('setup_request_unavailable') }
    : { ok: true, value };
}

export function decodeSetupProbeRequest(input: unknown): SetupRequestDecodeResult<SetupProbeRequest> {
  return decodeRequest(SetupProbeRequestSchema, input);
}

export function decodeSetupSaveRequest(input: unknown): SetupRequestDecodeResult<SetupSaveRequest> {
  return decodeRequest(SetupSaveRequestSchema, input);
}

export function decodeSetupRestoreRequest(input: unknown): SetupRequestDecodeResult<SetupRestoreRequest> {
  return decodeRequest(SetupRestoreRequestSchema, input);
}

export function decodeSetupAbortRequest(input: unknown): SetupRequestDecodeResult<SetupAbortRequest> {
  return decodeRequest(SetupAbortRequestSchema, input);
}

const RECOVERY_OPERATION_ID = 'setup-recovery';

export function decodeSetupProbeResponse(input: unknown): SetupProbeResponse {
  return parseWithoutThrow(SetupProbeResponseSchema, input) ?? {
    version: SETUP_RUNTIME_CONTRACT_VERSION,
    operationId: RECOVERY_OPERATION_ID,
    success: false,
    recovery: createSetupRecovery('setup_probe_response_unavailable'),
  };
}

export function decodeSetupSaveResponse(input: unknown): SetupSaveResponse {
  return parseWithoutThrow(SetupSaveResponseSchema, input) ?? {
    version: SETUP_RUNTIME_CONTRACT_VERSION,
    operationId: RECOVERY_OPERATION_ID,
    success: false,
    recovery: createSetupRecovery('setup_save_failed'),
  };
}

export function decodeSetupRestoreResponse(input: unknown): SetupRestoreResponse {
  return parseWithoutThrow(SetupRestoreResponseSchema, input) ?? {
    version: SETUP_RUNTIME_CONTRACT_VERSION,
    operationId: RECOVERY_OPERATION_ID,
    state: 'recovery',
    recovery: createSetupRecovery('setup_restore_failed'),
  };
}

export function decodeSetupProgressEvent(input: unknown): SetupProgressEvent | undefined {
  return parseWithoutThrow(SetupProgressEventSchema, input);
}
