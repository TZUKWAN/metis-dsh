import { z } from 'zod';
import { RuntimeIdSchema } from './ChatRuntimeContract.js';

export const ApprovalActionSchema = z.enum([
  'read_source',
  'write_research_data',
  'access_external_source',
  'run_analysis',
  'perform_research_action',
]);

export type ApprovalAction = z.infer<typeof ApprovalActionSchema>;

export const ApprovalRequestViewSchema = z.strictObject({
  requestId: RuntimeIdSchema,
  action: ApprovalActionSchema,
  createdAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export type ApprovalRequestView = z.infer<typeof ApprovalRequestViewSchema>;

export const ApprovalResponseRequestSchema = z.strictObject({
  requestId: RuntimeIdSchema,
  decision: z.enum(['approve', 'reject']),
});

export type ApprovalResponseRequest = z.infer<typeof ApprovalResponseRequestSchema>;

export const ApprovalRuleViewSchema = z.strictObject({
  id: RuntimeIdSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(400),
  enabled: z.boolean(),
});

export type ApprovalRuleView = z.infer<typeof ApprovalRuleViewSchema>;

export const ApprovalRuleToggleRequestSchema = z.strictObject({
  ruleId: RuntimeIdSchema,
  enabled: z.boolean(),
});

export const ApprovalMutationResultSchema = z.discriminatedUnion('success', [
  z.strictObject({ success: z.literal(true) }),
  z.strictObject({ success: z.literal(false), code: z.literal('approval_unavailable') }),
]);

export type ApprovalMutationResult = z.infer<typeof ApprovalMutationResultSchema>;

export function presentApprovalAction(toolName: unknown): ApprovalAction {
  if (typeof toolName !== 'string') return 'perform_research_action';
  const normalized = toolName.toLowerCase();
  if (/read|open|extract|inspect|list/u.test(normalized)) return 'read_source';
  if (/write|save|create|update|delete|export/u.test(normalized)) return 'write_research_data';
  if (/web|search|download|fetch|request|http/u.test(normalized)) return 'access_external_source';
  if (/run|execute|terminal|shell|script|mcp|python|stats|latex/u.test(normalized)) return 'run_analysis';
  return 'perform_research_action';
}

export function decodeApprovalRequestView(input: unknown): ApprovalRequestView | null {
  const parsed = ApprovalRequestViewSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function decodeApprovalResponseRequest(input: unknown): ApprovalResponseRequest | null {
  const parsed = ApprovalResponseRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function decodeApprovalRuleToggleRequest(input: unknown): z.infer<typeof ApprovalRuleToggleRequestSchema> | null {
  const parsed = ApprovalRuleToggleRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function decodeApprovalRuleViews(input: unknown): ApprovalRuleView[] {
  const parsed = z.array(ApprovalRuleViewSchema).max(100).safeParse(input);
  return parsed.success ? parsed.data : [];
}

export function createApprovalMutationFailure(): ApprovalMutationResult {
  return { success: false, code: 'approval_unavailable' };
}

export function decodeApprovalMutationResult(input: unknown): ApprovalMutationResult {
  const parsed = ApprovalMutationResultSchema.safeParse(input);
  return parsed.success ? parsed.data : createApprovalMutationFailure();
}

