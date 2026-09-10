import { z } from 'zod';
import { RuntimeIdSchema } from './ChatRuntimeContract.js';
import { FileCapabilityDescriptorSchema } from './FileCapabilityContract.js';

export const PaperIdRequestSchema = z.strictObject({ paperId: RuntimeIdSchema });
export type PaperIdRequest = z.infer<typeof PaperIdRequestSchema>;

const PaperAttachmentSuccessSchema = z.strictObject({
  success: z.literal(true),
  pdfCapability: FileCapabilityDescriptorSchema,
});

const PaperAttachmentFailureSchema = z.strictObject({
  success: z.literal(false),
  code: z.literal('paper_attachment_unavailable'),
});

export const PaperAttachmentResultSchema = z.discriminatedUnion('success', [
  PaperAttachmentSuccessSchema,
  PaperAttachmentFailureSchema,
]);

export type PaperAttachmentResult = z.infer<typeof PaperAttachmentResultSchema>;

export const PaperMutationResultSchema = z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true), code: z.enum(['attached', 'detached']) }),
  z.strictObject({ success: z.literal(false), code: z.literal('paper_mutation_unavailable') }),
]);

export type PaperMutationResult = z.infer<typeof PaperMutationResultSchema>;

const PaperDownloadSuccessSchema = z.strictObject({
  success: z.literal(true),
  code: z.literal('paper_download_complete'),
  pdfCapability: FileCapabilityDescriptorSchema,
  displayName: z.string().min(1).max(240),
  byteLength: z.number().int().min(1).max(256 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

const PaperDownloadFailureSchema = z.strictObject({
  success: z.literal(false),
  code: z.literal('paper_download_unavailable'),
});

export const PaperDownloadResultSchema = z.discriminatedUnion('success', [
  PaperDownloadSuccessSchema,
  PaperDownloadFailureSchema,
]);

export type PaperDownloadResult = z.infer<typeof PaperDownloadResultSchema>;

export function decodePaperIdRequest(input: unknown):
  | { ok: true; value: PaperIdRequest }
  | { ok: false } {
  const parsed = PaperIdRequestSchema.safeParse(input);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

export function createPaperAttachmentFailure(): PaperAttachmentResult {
  return { success: false, code: 'paper_attachment_unavailable' };
}

export function decodePaperAttachmentResult(input: unknown): PaperAttachmentResult {
  const parsed = PaperAttachmentResultSchema.safeParse(input);
  return parsed.success ? parsed.data : createPaperAttachmentFailure();
}

export function createPaperMutationFailure(): PaperMutationResult {
  return { success: false, code: 'paper_mutation_unavailable' };
}

export function decodePaperMutationResult(input: unknown): PaperMutationResult {
  const parsed = PaperMutationResultSchema.safeParse(input);
  return parsed.success ? parsed.data : createPaperMutationFailure();
}

export function createPaperDownloadFailure(): PaperDownloadResult {
  return { success: false, code: 'paper_download_unavailable' };
}

export function decodePaperDownloadResult(input: unknown): PaperDownloadResult {
  const parsed = PaperDownloadResultSchema.safeParse(input);
  return parsed.success ? parsed.data : createPaperDownloadFailure();
}
