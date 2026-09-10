import { z } from 'zod';

export const MEMORY_RUNTIME_LIMITS = Object.freeze({
  projectChars: 1_000_000,
} as const);

export const ProjectMemoryContentSchema = z.string()
  .max(MEMORY_RUNTIME_LIMITS.projectChars)
  .refine((value) => !value.includes('\u0000'), {
    message: 'Project memory cannot contain NUL characters',
  });

export const ProjectMemoryWriteRequestSchema = z.strictObject({
  content: ProjectMemoryContentSchema,
});
export type ProjectMemoryWriteRequest = z.infer<typeof ProjectMemoryWriteRequestSchema>;

export const ProjectMemoryMutationResultSchema = z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true), code: z.literal('saved') }),
  z.strictObject({ success: z.literal(false), code: z.literal('memory_unavailable') }),
]);
export type ProjectMemoryMutationResult = z.infer<typeof ProjectMemoryMutationResultSchema>;

export function decodeProjectMemoryContent(input: unknown): string {
  const parsed = ProjectMemoryContentSchema.safeParse(input);
  return parsed.success ? parsed.data : '';
}

export function decodeProjectMemoryWriteRequest(input: unknown): ProjectMemoryWriteRequest | undefined {
  const parsed = ProjectMemoryWriteRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

export function createProjectMemoryMutationFailure(): ProjectMemoryMutationResult {
  return { success: false, code: 'memory_unavailable' };
}

export function decodeProjectMemoryMutationResult(input: unknown): ProjectMemoryMutationResult {
  const parsed = ProjectMemoryMutationResultSchema.safeParse(input);
  return parsed.success ? parsed.data : createProjectMemoryMutationFailure();
}
