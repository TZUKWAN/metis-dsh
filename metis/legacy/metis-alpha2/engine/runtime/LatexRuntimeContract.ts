import { z } from 'zod';
import { FileCapabilityDescriptorSchema } from './FileCapabilityContract.js';

export const LATEX_RUNTIME_LIMITS = Object.freeze({
  sourceChars: 2_000_000,
  bibliographyChars: 1_000_000,
  issues: 500,
  line: 10_000_000,
} as const);

const SafeMultilineSchema = z.string()
  .max(LATEX_RUNTIME_LIMITS.sourceChars)
// eslint-disable-next-line no-control-regex
  .refine((value) => !/[\u0000\u000b\u000c]/u.test(value));

export const LatexCompileRequestSchema = z.strictObject({
  source: SafeMultilineSchema.min(1),
  bibliography: z.string()
    .max(LATEX_RUNTIME_LIMITS.bibliographyChars)
// eslint-disable-next-line no-control-regex
    .refine((value) => !/[\u0000\u000b\u000c]/u.test(value))
    .optional(),
});

export type LatexCompileRequest = z.infer<typeof LatexCompileRequestSchema>;

export const LatexCompileIssueSchema = z.strictObject({
  line: z.number().int().min(0).max(LATEX_RUNTIME_LIMITS.line),
  severity: z.enum(['error', 'warning']),
  code: z.enum(['latex_compile_error', 'latex_compile_warning']),
});

export type LatexCompileIssue = z.infer<typeof LatexCompileIssueSchema>;

const LatexCompileSuccessSchema = z.strictObject({
  status: z.literal('success'),
  pdf: FileCapabilityDescriptorSchema,
  issues: z.array(LatexCompileIssueSchema).max(LATEX_RUNTIME_LIMITS.issues),
});

const LatexCompileFailureSchema = z.strictObject({
  status: z.enum(['error', 'noCompiler']),
  code: z.enum(['latex_compile_unavailable', 'latex_compiler_unavailable']),
  issues: z.array(LatexCompileIssueSchema).max(LATEX_RUNTIME_LIMITS.issues),
});

export const LatexCompileResponseSchema = z.discriminatedUnion('status', [
  LatexCompileSuccessSchema,
  LatexCompileFailureSchema,
]);

export type LatexCompileResponse = z.infer<typeof LatexCompileResponseSchema>;

export function createLatexCompileRecovery(): LatexCompileResponse {
  return { status: 'error', code: 'latex_compile_unavailable', issues: [] };
}

export function decodeLatexCompileRequest(input: unknown):
  | { ok: true; value: LatexCompileRequest }
  | { ok: false } {
  const parsed = LatexCompileRequestSchema.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

export function decodeLatexCompileResponse(input: unknown): LatexCompileResponse {
  const parsed = LatexCompileResponseSchema.safeParse(input);
  return parsed.success ? parsed.data : createLatexCompileRecovery();
}

