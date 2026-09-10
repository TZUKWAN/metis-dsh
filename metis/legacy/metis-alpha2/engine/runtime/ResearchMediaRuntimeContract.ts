import { z } from 'zod';
import { FileCapabilityIdSchema } from './FileCapabilityContract.js';
import { RuntimeIdSchema } from './ChatRuntimeContract.js';

export const RESEARCH_MEDIA_LIMITS = Object.freeze({
  decodedBytes: 3 * 1024 * 1024,
  widthPx: 10_000,
  heightPx: 10_000,
  pixels: 40_000_000,
  captionChars: 512,
  displayNameChars: 240,
  mediaPerArtifact: 16,
} as const);

export const RESEARCH_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
] as const;

// eslint-disable-next-line no-control-regex -- control characters are exactly what this boundary rejects
const SINGLE_LINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
const PATH_SEPARATOR = /[\\/]/u;
const SHA256 = /^[a-f0-9]{64}$/u;

const CaptionSchema = z.string()
  .trim()
  .min(1)
  .max(RESEARCH_MEDIA_LIMITS.captionChars)
  .refine((value) => !SINGLE_LINE_CONTROLS.test(value), {
    message: 'Media caption contains unsafe control characters',
  });

const DisplayNameSchema = z.string()
  .trim()
  .min(1)
  .max(RESEARCH_MEDIA_LIMITS.displayNameChars)
  .refine((value) => !SINGLE_LINE_CONTROLS.test(value), {
    message: 'Media display name contains unsafe control characters',
  })
  .refine((value) => !PATH_SEPARATOR.test(value) && value !== '.' && value !== '..', {
    message: 'Media display name is unavailable',
  });

export const ResearchMediaTypeSchema = z.enum(RESEARCH_MEDIA_TYPES);

export const ResearchMediaReferenceSchema = z.strictObject({
  sourceId: RuntimeIdSchema,
  caption: CaptionSchema,
  ordinal: z.number().int().min(0).max(RESEARCH_MEDIA_LIMITS.mediaPerArtifact - 1),
});

export const ResearchMediaDescriptorSchema = ResearchMediaReferenceSchema.extend({
  displayName: DisplayNameSchema,
  mediaType: ResearchMediaTypeSchema,
  byteLength: z.number().int().min(10).max(RESEARCH_MEDIA_LIMITS.decodedBytes),
  sha256: z.string().regex(SHA256),
  widthPx: z.number().int().min(1).max(RESEARCH_MEDIA_LIMITS.widthPx),
  heightPx: z.number().int().min(1).max(RESEARCH_MEDIA_LIMITS.heightPx),
}).superRefine((value, context) => {
  if (value.widthPx * value.heightPx > RESEARCH_MEDIA_LIMITS.pixels) {
    context.addIssue({
      code: 'custom',
      message: 'Media pixel count exceeds the safe limit',
      path: ['widthPx'],
    });
  }
});

export type ResearchMediaReference = z.infer<typeof ResearchMediaReferenceSchema>;
export type ResearchMediaDescriptor = z.infer<typeof ResearchMediaDescriptorSchema>;
export type ResearchMediaType = z.infer<typeof ResearchMediaTypeSchema>;

/** Renderer request: all trusted intrinsic fields are deliberately absent. */
export const ResearchMediaAttachRequestSchema = ResearchMediaReferenceSchema.extend({
  projectId: RuntimeIdSchema,
  capabilityId: FileCapabilityIdSchema,
});

export const ResearchMediaPurgeRequestSchema = z.strictObject({
  projectId: RuntimeIdSchema,
  sourceId: RuntimeIdSchema,
});

export type ResearchMediaAttachRequest = z.infer<typeof ResearchMediaAttachRequestSchema>;
export type ResearchMediaPurgeRequest = z.infer<typeof ResearchMediaPurgeRequestSchema>;

export const ResearchMediaFailureCodeSchema = z.enum([
  'research_media_unavailable',
  'research_media_conflict',
  'research_media_referenced',
]);

export const ResearchMediaAttachResultSchema = z.union([
  z.strictObject({
    success: z.literal(true),
    code: z.literal('research_media_attached'),
    media: ResearchMediaDescriptorSchema,
  }),
  z.strictObject({
    success: z.literal(false),
    code: ResearchMediaFailureCodeSchema,
  }),
]);

export const ResearchMediaPurgeResultSchema = z.union([
  z.strictObject({
    success: z.literal(true),
    code: z.literal('research_media_purged'),
    sourceId: RuntimeIdSchema,
  }),
  z.strictObject({
    success: z.literal(false),
    code: ResearchMediaFailureCodeSchema,
  }),
]);

export type ResearchMediaAttachResult = z.infer<typeof ResearchMediaAttachResultSchema>;
export type ResearchMediaPurgeResult = z.infer<typeof ResearchMediaPurgeResultSchema>;
export type ResearchMediaFailureCode = z.infer<typeof ResearchMediaFailureCodeSchema>;

function parseWithoutThrow<T>(schema: z.ZodType<T>, input: unknown): T | undefined {
  try {
    const parsed = schema.safeParse(input);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function decodeResearchMediaAttachRequest(input: unknown): ResearchMediaAttachRequest | undefined {
  return parseWithoutThrow(ResearchMediaAttachRequestSchema, input);
}

export function decodeResearchMediaPurgeRequest(input: unknown): ResearchMediaPurgeRequest | undefined {
  return parseWithoutThrow(ResearchMediaPurgeRequestSchema, input);
}

export function createResearchMediaAttachFailure(
  code: ResearchMediaFailureCode = 'research_media_unavailable',
): ResearchMediaAttachResult {
  return { success: false, code };
}

export function createResearchMediaPurgeFailure(
  code: ResearchMediaFailureCode = 'research_media_unavailable',
): ResearchMediaPurgeResult {
  return { success: false, code };
}

export function decodeResearchMediaAttachResult(input: unknown): ResearchMediaAttachResult {
  return parseWithoutThrow(ResearchMediaAttachResultSchema, input)
    ?? createResearchMediaAttachFailure();
}

export function decodeResearchMediaPurgeResult(input: unknown): ResearchMediaPurgeResult {
  return parseWithoutThrow(ResearchMediaPurgeResultSchema, input)
    ?? createResearchMediaPurgeFailure();
}
