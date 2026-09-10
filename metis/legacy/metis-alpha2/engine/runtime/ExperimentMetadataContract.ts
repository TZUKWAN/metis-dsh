import { z } from 'zod';
import { ExperimentMetricsSchema } from './ExperimentRuntimeContract.js';

export const EXPERIMENT_METADATA_LIMITS = Object.freeze({
  idChars: 128,
  nameChars: 512,
  descriptionChars: 4_096,
  parameterEntries: 128,
  parameterKeyChars: 64,
  parameterValueChars: 8_192,
  tags: 64,
  tagChars: 128,
  notesChars: 65_536,
  linkedPapers: 256,
} as const);

const IdSchema = z.string()
  .min(1)
  .max(EXPERIMENT_METADATA_LIMITS.idChars)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const ParameterKeySchema = z.string()
  .min(1)
  .max(EXPERIMENT_METADATA_LIMITS.parameterKeyChars)
  .regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/u);
const ParametersSchema = z.record(
  ParameterKeySchema,
  z.string().max(EXPERIMENT_METADATA_LIMITS.parameterValueChars),
).refine(
  (value) => Object.keys(value).length <= EXPERIMENT_METADATA_LIMITS.parameterEntries,
  { message: 'Too many experiment parameters' },
);

export const ExperimentMetadataSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(EXPERIMENT_METADATA_LIMITS.nameChars),
  description: z.string().max(EXPERIMENT_METADATA_LIMITS.descriptionChars),
  status: z.enum(['planned', 'running', 'completed', 'failed', 'cancelled']),
  parameters: ParametersSchema,
  metrics: ExperimentMetricsSchema,
  tags: z.array(z.string().min(1).max(EXPERIMENT_METADATA_LIMITS.tagChars))
    .max(EXPERIMENT_METADATA_LIMITS.tags),
  notes: z.string().max(EXPERIMENT_METADATA_LIMITS.notesChars),
  linkedPaperIds: z.array(IdSchema).max(EXPERIMENT_METADATA_LIMITS.linkedPapers),
  starred: z.boolean().optional(),
  createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type ExperimentMetadata = z.infer<typeof ExperimentMetadataSchema>;

export const ExperimentSaveRequestSchema = ExperimentMetadataSchema;
export type ExperimentSaveRequest = ExperimentMetadata;

export const ExperimentDeleteRequestSchema = z.strictObject({ id: IdSchema });
export type ExperimentDeleteRequest = z.infer<typeof ExperimentDeleteRequestSchema>;

export const ExperimentMetadataFailureCodeSchema = z.enum([
  'experiment_metadata_invalid',
  'experiment_metadata_unavailable',
]);
export type ExperimentMetadataFailureCode = z.infer<typeof ExperimentMetadataFailureCodeSchema>;

export const ExperimentListResultSchema = z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true), experiments: z.array(ExperimentMetadataSchema) }),
  z.strictObject({ success: z.literal(false), code: ExperimentMetadataFailureCodeSchema }),
]);
export type ExperimentListResult = z.infer<typeof ExperimentListResultSchema>;

export const ExperimentMutationResultSchema = z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true), code: z.enum(['saved', 'deleted']) }),
  z.strictObject({ success: z.literal(false), code: ExperimentMetadataFailureCodeSchema }),
]);
export type ExperimentMutationResult = z.infer<typeof ExperimentMutationResultSchema>;

function parseWithoutThrow<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  try {
    const parsed = schema.safeParse(input);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function decodeExperimentList(raw: unknown): ExperimentMetadata[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const parsed = parseWithoutThrow(ExperimentMetadataSchema, entry);
    return parsed ? [parsed] : [];
  });
}

export function decodeExperimentSave(raw: unknown): ExperimentSaveRequest | null {
  return parseWithoutThrow(ExperimentSaveRequestSchema, raw) ?? null;
}

export function decodeExperimentDelete(raw: unknown): string | null {
  return parseWithoutThrow(ExperimentDeleteRequestSchema, raw)?.id ?? null;
}

export function decodeExperimentListResult(raw: unknown): ExperimentListResult {
  return parseWithoutThrow(ExperimentListResultSchema, raw) ?? {
    success: false,
    code: 'experiment_metadata_unavailable',
  };
}

export function decodeExperimentMutationResult(raw: unknown): ExperimentMutationResult {
  return parseWithoutThrow(ExperimentMutationResultSchema, raw) ?? {
    success: false,
    code: 'experiment_metadata_unavailable',
  };
}

export function createExperimentMetadataFailure(): ExperimentMutationResult {
  return { success: false, code: 'experiment_metadata_unavailable' };
}
