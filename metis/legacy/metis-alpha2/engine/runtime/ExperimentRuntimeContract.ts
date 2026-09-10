import { z } from 'zod';
import {
  ExecutionGrantDescriptorSchema,
  ExecutionGrantIdSchema,
} from './ExecutionCapabilityContract.js';
import { RuntimeIdSchema } from './ChatRuntimeContract.js';
import { FileCapabilityDisplayNameSchema } from './FileCapabilityContract.js';

export const EXPERIMENT_RUNTIME_LIMITS = Object.freeze({
  attachmentIdChars: 80,
  scriptBytes: 4 * 1024 * 1024,
  metrics: 128,
  metricKeyChars: 64,
  metricMagnitude: 1_000_000_000_000_000,
} as const);

function parseWithoutThrow<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  try {
    const result = schema.safeParse(input);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export const ExperimentIdSchema = RuntimeIdSchema;

export const ExperimentScriptAttachmentIdSchema = z.string()
  .min(36)
  .max(EXPERIMENT_RUNTIME_LIMITS.attachmentIdChars)
  .regex(/^esa_[A-Za-z0-9_-]{32,64}$/u);

export const ExperimentScriptRuntimeSchema = z.enum(['python', 'node']);
export type ExperimentScriptRuntime = z.infer<typeof ExperimentScriptRuntimeSchema>;

const TimestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const UNSAFE_BIDI_CONTROL_CHARACTERS = /[\u202a-\u202e\u2066-\u2069]/u;
const UNSAFE_METRIC_KEYS = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'prototype',
  'toLocaleString',
  'toString',
  'valueOf',
]);

const ExperimentScriptDisplayNameSchema = FileCapabilityDisplayNameSchema.refine(
  (value) => !UNSAFE_BIDI_CONTROL_CHARACTERS.test(value),
  { message: 'Experiment script display name is unavailable' },
);

/** Renderer-safe script metadata. A local path is deliberately impossible here. */
export const ExperimentScriptAttachmentSchema = z.strictObject({
  attachmentId: ExperimentScriptAttachmentIdSchema,
  displayName: ExperimentScriptDisplayNameSchema,
  runtime: ExperimentScriptRuntimeSchema,
  sizeBytes: z.number().int().min(1).max(EXPERIMENT_RUNTIME_LIMITS.scriptBytes),
  attachedAt: TimestampSchema,
});
export type ExperimentScriptAttachment = z.infer<typeof ExperimentScriptAttachmentSchema>;

export const ExperimentRuntimeStatusSchema = z.enum([
  'not_attached',
  'attaching',
  'ready',
  'requesting_grant',
  'running',
  'completed',
  'failed',
  'timed_out',
  'cancelled',
  'rejected',
  'runtime_unavailable',
]);
export type ExperimentRuntimeStatus = z.infer<typeof ExperimentRuntimeStatusSchema>;

export const ExperimentScriptFailureCodeSchema = z.enum([
  'experiment_script_unavailable',
  'experiment_script_type_unsupported',
  'experiment_script_too_large',
  'experiment_script_not_text',
  'experiment_script_copy_failed',
  'experiment_script_not_attached',
  'experiment_runtime_unavailable',
  'experiment_grant_unavailable',
  'experiment_run_rejected',
  'experiment_run_timeout',
  'experiment_run_failed',
  'experiment_result_unavailable',
]);
export type ExperimentScriptFailureCode = z.infer<typeof ExperimentScriptFailureCodeSchema>;

export const ExperimentScriptAttachRequestSchema = z.strictObject({
  experimentId: ExperimentIdSchema,
});
export type ExperimentScriptAttachRequest = z.infer<
  typeof ExperimentScriptAttachRequestSchema
>;

const ExperimentScriptAttachSuccessSchema = z.strictObject({
  status: z.literal('attached'),
  attachment: ExperimentScriptAttachmentSchema,
});

const ExperimentScriptAttachCancelledSchema = z.strictObject({
  status: z.literal('cancelled'),
});

const ExperimentScriptAttachRejectedSchema = z.strictObject({
  status: z.literal('rejected'),
  code: ExperimentScriptFailureCodeSchema,
});

export const ExperimentScriptAttachResultSchema = z.discriminatedUnion('status', [
  ExperimentScriptAttachSuccessSchema,
  ExperimentScriptAttachCancelledSchema,
  ExperimentScriptAttachRejectedSchema,
]);
export type ExperimentScriptAttachResult = z.infer<
  typeof ExperimentScriptAttachResultSchema
>;

export const ExperimentExecutionGrantRequestSchema = z.strictObject({
  experimentId: ExperimentIdSchema,
});
export type ExperimentExecutionGrantRequest = z.infer<
  typeof ExperimentExecutionGrantRequestSchema
>;

export const ExperimentExecutionGrantDescriptorSchema = ExecutionGrantDescriptorSchema
  .superRefine((value, context) => {
    if (value.operation !== 'experiment-script' || value.lifetime !== 'once') {
      context.addIssue({
        code: 'custom',
        message: 'Experiment execution grant is unavailable',
      });
    }
  });
export type ExperimentExecutionGrantDescriptor = z.infer<
  typeof ExperimentExecutionGrantDescriptorSchema
>;

const ExperimentExecutionGrantSuccessSchema = z.strictObject({
  status: z.literal('granted'),
  grant: ExperimentExecutionGrantDescriptorSchema,
});

const ExperimentExecutionGrantRejectedSchema = z.strictObject({
  status: z.literal('rejected'),
  code: ExperimentScriptFailureCodeSchema,
});

export const ExperimentExecutionGrantResultSchema = z.discriminatedUnion('status', [
  ExperimentExecutionGrantSuccessSchema,
  ExperimentExecutionGrantRejectedSchema,
]);
export type ExperimentExecutionGrantResult = z.infer<
  typeof ExperimentExecutionGrantResultSchema
>;

export const ExperimentRunRequestSchema = z.strictObject({
  experimentId: ExperimentIdSchema,
  grant: ExperimentExecutionGrantDescriptorSchema,
});
export type ExperimentRunRequest = z.infer<typeof ExperimentRunRequestSchema>;

export const ExperimentMetricKeySchema = z.string()
  .min(1)
  .max(EXPERIMENT_RUNTIME_LIMITS.metricKeyChars)
  .regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/u)
  .refine((value) => !UNSAFE_METRIC_KEYS.has(value), {
    message: 'Metric key is unavailable',
  });

export const ExperimentMetricValueSchema = z.number()
  .finite()
  .min(-EXPERIMENT_RUNTIME_LIMITS.metricMagnitude)
  .max(EXPERIMENT_RUNTIME_LIMITS.metricMagnitude);

export const ExperimentMetricsSchema = z.record(
  ExperimentMetricKeySchema,
  ExperimentMetricValueSchema,
).refine((value) => Object.keys(value).length <= EXPERIMENT_RUNTIME_LIMITS.metrics, {
  message: 'Too many experiment metrics',
});
export type ExperimentMetrics = z.infer<typeof ExperimentMetricsSchema>;

export const ExperimentRunStatusSchema = z.enum([
  'completed',
  'failed',
  'timed_out',
  'cancelled',
  'rejected',
  'runtime_unavailable',
]);
export type ExperimentRunStatus = z.infer<typeof ExperimentRunStatusSchema>;

/**
 * Safe renderer result. stdout, stderr, raw errors and every local path are
 * intentionally absent; detailed output remains in main-process controlled logs.
 */
export const ExperimentRunResultSchema = z.strictObject({
  status: ExperimentRunStatusSchema,
  exitCode: z.union([
    z.null(),
    z.number().int().min(-2_147_483_648).max(2_147_483_647),
  ]),
  metrics: ExperimentMetricsSchema,
}).superRefine((value, context) => {
  if (value.status === 'completed' && value.exitCode !== 0) {
    context.addIssue({
      code: 'custom',
      message: 'Completed experiment must have exit code zero',
      path: ['exitCode'],
    });
  }
  if (value.status === 'failed' && value.exitCode === 0) {
    context.addIssue({
      code: 'custom',
      message: 'Failed experiment cannot have exit code zero',
      path: ['exitCode'],
    });
  }
  if (
    ['timed_out', 'cancelled', 'rejected', 'runtime_unavailable'].includes(value.status)
    && value.exitCode !== null
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Non-completed experiment status cannot expose an exit code',
      path: ['exitCode'],
    });
  }
  if (
    (value.status === 'rejected' || value.status === 'runtime_unavailable')
    && Object.keys(value.metrics).length > 0
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Unexecuted experiment cannot expose metrics',
      path: ['metrics'],
    });
  }
});
export type ExperimentRunResult = z.infer<typeof ExperimentRunResultSchema>;

export function decodeExperimentScriptAttachRequest(
  input: unknown,
): ExperimentScriptAttachRequest | undefined {
  return parseWithoutThrow(ExperimentScriptAttachRequestSchema, input);
}

export function decodeExperimentScriptAttachResult(
  input: unknown,
): ExperimentScriptAttachResult {
  return parseWithoutThrow(ExperimentScriptAttachResultSchema, input) ?? {
    status: 'rejected',
    code: 'experiment_script_unavailable',
  };
}

export function decodeExperimentExecutionGrantRequest(
  input: unknown,
): ExperimentExecutionGrantRequest | undefined {
  return parseWithoutThrow(ExperimentExecutionGrantRequestSchema, input);
}

export function decodeExperimentExecutionGrantResult(
  input: unknown,
): ExperimentExecutionGrantResult {
  return parseWithoutThrow(ExperimentExecutionGrantResultSchema, input) ?? {
    status: 'rejected',
    code: 'experiment_grant_unavailable',
  };
}

export function decodeExperimentRunRequest(input: unknown): ExperimentRunRequest | undefined {
  return parseWithoutThrow(ExperimentRunRequestSchema, input);
}

export function decodeExperimentRunResult(input: unknown): ExperimentRunResult {
  return parseWithoutThrow(ExperimentRunResultSchema, input) ?? {
    status: 'rejected',
    exitCode: null,
    metrics: {},
  };
}

export function createExperimentRunFailure(
  status: Exclude<ExperimentRunStatus, 'completed'>,
  metrics: ExperimentMetrics = {},
  exitCode: number | null = null,
): ExperimentRunResult {
  const candidate = { status, exitCode, metrics };
  return parseWithoutThrow(ExperimentRunResultSchema, candidate) ?? {
    status: 'rejected',
    exitCode: null,
    metrics: {},
  };
}

export { ExecutionGrantIdSchema };

// ─── Main-process-only persistence contracts (GLM-101) ─────────
// These types are used by ExperimentAttachmentRepository (engine/)
// and ExperimentScriptService (electron/).  They contain local paths
// and absolute hashes that MUST never cross IPC to the renderer.

export interface MainOnlyExperimentScriptAttachmentRecord {
  experimentId: string;
  attachment: ExperimentScriptAttachment;
  managedPath: string;
  contentSha256: string;
}

/**
 * Main-process-only access binding for a managed experiment attachment.
 * Both values are keyed digests produced from the current process secret;
 * the process secret and the renderer owner tuple never cross this boundary.
 */
export interface AttachmentAccessBinding {
  sessionBinding: string;
  ownerBinding: string;
}

export interface MainOnlyExperimentRunRecord {
  runId: string;
  experimentId: string;
  attachmentId: string;
  status: ExperimentRunResult['status'];
  exitCode: number | null;
  metrics: ExperimentMetrics;
  startedAt: number;
  finishedAt: number;
  stdoutLogPath: string;
  stderrLogPath: string;
}

export interface ExperimentScriptPersistence {
  loadAttachment(
    experimentId: string,
    binding: AttachmentAccessBinding,
  ): Promise<MainOnlyExperimentScriptAttachmentRecord | null>;
  saveAttachment(
    record: MainOnlyExperimentScriptAttachmentRecord,
    binding: AttachmentAccessBinding,
  ): Promise<void>;
  recordRun(record: MainOnlyExperimentRunRecord): Promise<void>;
}
