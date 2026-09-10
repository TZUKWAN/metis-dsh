/**
 * ResearchStrategyContract — user-defined research workflow strategies.
 *
 * A strategy is an ordered list of research phases; each phase names one
 * research action from the action library (literature review, coding,
 * statistics, argumentation, writing, …). The autonomous engine executes the
 * phases in order instead of a hard-coded four-stage pipeline, so researchers
 * can express their own methodology (quantitative, qualitative, mixed, review,
 * theoretical) without the app imposing one paradigm.
 *
 * PaperStructureTemplate is the companion editor contract: the writing action
 * produces sections in the user's own structure, never a hard-coded one.
 */

import { z } from 'zod';
import { RuntimeIdSchema } from './AutonomousRuntimeContract.js';

export const STRATEGY_ACTIONS = [
  'question_formulation',
  'literature_review',
  'source_discovery',
  'screening',
  'conceptual_analysis',
  'source_criticism',
  'research_design',
  'data_collection',
  'coding',
  'data_preparation',
  'statistics',
  'triangulation',
  'argumentation',
  'writing',
  'analysis',
  'synthesis',
  'quality_audit',
] as const;

export type StrategyActionKind = (typeof STRATEGY_ACTIONS)[number];

export const StrategyActionKindSchema = z.enum(STRATEGY_ACTIONS);

export const RESEARCH_STRATEGY_LIMITS = Object.freeze({
  idChars: 128,
  nameChars: 200,
  descriptionChars: 2_000,
  phasePromptChars: 4_000,
  phases: 32,
  sections: 64,
  sectionTitleChars: 200,
  sectionInstructionChars: 4_000,
} as const);

const ResearchStrategyPhaseSchema = z.strictObject({
  action: StrategyActionKindSchema,
  name: z.string().trim().min(1).max(RESEARCH_STRATEGY_LIMITS.nameChars),
  /** Optional user instruction appended to the action's built-in prompt. */
  prompt: z.string().max(RESEARCH_STRATEGY_LIMITS.phasePromptChars).optional(),
});

export const ResearchStrategySchema = z.strictObject({
  id: RuntimeIdSchema,
  name: z.string().trim().min(1).max(RESEARCH_STRATEGY_LIMITS.nameChars),
  description: z.string().max(RESEARCH_STRATEGY_LIMITS.descriptionChars).optional(),
  phases: z.array(ResearchStrategyPhaseSchema)
    .min(1)
    .max(RESEARCH_STRATEGY_LIMITS.phases),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
  isDefault: z.boolean().default(false),
});

export type ResearchStrategy = z.infer<typeof ResearchStrategySchema>;
export type ResearchStrategyPhase = z.infer<typeof ResearchStrategyPhaseSchema>;

export const PaperSectionTemplateSchema = z.strictObject({
  id: RuntimeIdSchema,
  title: z.string().trim().min(1).max(RESEARCH_STRATEGY_LIMITS.sectionTitleChars),
  instruction: z.string().max(RESEARCH_STRATEGY_LIMITS.sectionInstructionChars).optional(),
});

export const PaperStructureTemplateSchema = z.strictObject({
  id: RuntimeIdSchema,
  name: z.string().trim().min(1).max(RESEARCH_STRATEGY_LIMITS.nameChars),
  sections: z.array(PaperSectionTemplateSchema)
    .min(1)
    .max(RESEARCH_STRATEGY_LIMITS.sections),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
  isDefault: z.boolean().default(false),
});

export type PaperStructureTemplate = z.infer<typeof PaperStructureTemplateSchema>;
export type PaperSectionTemplate = z.infer<typeof PaperSectionTemplateSchema>;

// ─── Request/response contracts ───────────────────────────────

const StrategyWriteSchema = z.strictObject({
  strategy: ResearchStrategySchema,
});

export const StrategySaveRequestSchema = StrategyWriteSchema;

export const StrategyListRequestSchema = z.strictObject({});

export const StrategyDeleteRequestSchema = z.strictObject({
  strategyId: RuntimeIdSchema,
});

export const StrategySetDefaultRequestSchema = z.strictObject({
  strategyId: RuntimeIdSchema,
});

export const PaperStructureWriteSchema = z.strictObject({
  template: PaperStructureTemplateSchema,
});

export const PaperStructureSaveRequestSchema = PaperStructureWriteSchema;

export const PaperStructureListRequestSchema = z.strictObject({});

export const PaperStructureDeleteRequestSchema = z.strictObject({
  templateId: RuntimeIdSchema,
});

export type StrategySaveRequest = z.infer<typeof StrategySaveRequestSchema>;
export type StrategyListRequest = z.infer<typeof StrategyListRequestSchema>;
export type StrategyDeleteRequest = z.infer<typeof StrategyDeleteRequestSchema>;
export type StrategySetDefaultRequest = z.infer<typeof StrategySetDefaultRequestSchema>;
export type PaperStructureSaveRequest = z.infer<typeof PaperStructureSaveRequestSchema>;
export type PaperStructureListRequest = z.infer<typeof PaperStructureListRequestSchema>;
export type PaperStructureDeleteRequest = z.infer<typeof PaperStructureDeleteRequestSchema>;

export const StrategyListResponseSchema = z.strictObject({
  ok: z.boolean(),
  strategies: z.array(ResearchStrategySchema).default([]),
  error: z.string().optional(),
});

export type StrategyListResponse = z.infer<typeof StrategyListResponseSchema>;

export const PaperStructureListResponseSchema = z.strictObject({
  ok: z.boolean(),
  templates: z.array(PaperStructureTemplateSchema).default([]),
  error: z.string().optional(),
});

export type PaperStructureListResponse = z.infer<typeof PaperStructureListResponseSchema>;

export const StrategyMutationResponseSchema = z.strictObject({
  ok: z.boolean(),
  error: z.string().optional(),
});

export type StrategyMutationResponse = z.infer<typeof StrategyMutationResponseSchema>;

// ─── Decode helpers ───────────────────────────────────────────

function parseWithoutThrow<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  const result = schema.safeParse(input);
  return result.success ? result.data : undefined;
}

export function decodeStrategySaveRequest(input: unknown): StrategySaveRequest | undefined {
  return parseWithoutThrow(StrategySaveRequestSchema, input);
}

export function decodeStrategyDeleteRequest(input: unknown): StrategyDeleteRequest | undefined {
  return parseWithoutThrow(StrategyDeleteRequestSchema, input);
}

export function decodeStrategySetDefaultRequest(input: unknown): StrategySetDefaultRequest | undefined {
  return parseWithoutThrow(StrategySetDefaultRequestSchema, input);
}

export function decodePaperStructureSaveRequest(input: unknown): PaperStructureSaveRequest | undefined {
  return parseWithoutThrow(PaperStructureSaveRequestSchema, input);
}

export function decodePaperStructureDeleteRequest(input: unknown): PaperStructureDeleteRequest | undefined {
  return parseWithoutThrow(PaperStructureDeleteRequestSchema, input);
}

export function decodeStrategyListResponse(input: unknown): StrategyListResponse {
  return parseWithoutThrow(StrategyListResponseSchema, input) ?? { ok: false, strategies: [] };
}

export function decodePaperStructureListResponse(input: unknown): PaperStructureListResponse {
  return parseWithoutThrow(PaperStructureListResponseSchema, input) ?? { ok: false, templates: [] };
}
