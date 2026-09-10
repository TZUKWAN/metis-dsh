/**
 * Strict runtime contract for tool results that are allowed to enter the
 * provider context.
 *
 * SECURITY: This file is the single source of truth for the shape and
 * validation of provider-facing tool feedback. All values crossing this
 * boundary must pass Zod strictObject parsing; failures recover to a fixed,
 * non-leaking message.
 */

import { z } from 'zod';

/** Maximum length of any single string entering the provider context. */
export const MAX_PROVIDER_CONTENT_LENGTH = 4000;
export const MAX_TOOL_PRESENTATION_DETAIL_LENGTH = 8000;
export const MAX_SAFE_STRING_LENGTH = 10000;

/** Reject control characters and bound length. */
const SafeStringSchema = z
  .string()
  .max(MAX_SAFE_STRING_LENGTH)
  .refine(
    (s) => !makeControlCharsRegex().test(s),
    'Control characters are not allowed',
  );

function makeControlCharsRegex(): RegExp {
  const ranges: Array<[number, number]> = [
    [0x00, 0x08],
    [0x0b, 0x0c],
    [0x0e, 0x1f],
    [0x7f, 0x7f],
  ];
  const chars = ranges.flatMap(([start, end]) =>
    Array.from({ length: end - start + 1 }, (_, i) => String.fromCharCode(start + i)),
  );
  return new RegExp(`[${chars.map((c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')}]`);
}

export const ToolPresentationStatusSchema = z.enum([
  'ok',
  'error',
  'tool_failed',
  'completed',
]);
export type ToolPresentationStatus = z.infer<typeof ToolPresentationStatusSchema>;

/** Internal safe representation produced by a per-tool decoder/presenter. */
export const ToolPresentationSchema = z.strictObject({
  toolName: z.string().max(128),
  status: ToolPresentationStatusSchema,
  summary: SafeStringSchema.max(500),
  detail: SafeStringSchema.max(MAX_TOOL_PRESENTATION_DETAIL_LENGTH).optional(),
  fallback: z.boolean().optional(),
});
export type ToolPresentation = z.infer<typeof ToolPresentationSchema>;

const ToolCallIdSchema = SafeStringSchema.min(1).max(128);
const ToolNameSchema = SafeStringSchema.min(1).max(128);

/** Strict runtime shape of a raw ToolResult entering the presentation layer. */
export const ToolResultSchema = z
  .strictObject({
    toolName: ToolNameSchema,
    content: SafeStringSchema,
    status: z.enum(['ok', 'error']),
    toolCallId: ToolCallIdSchema,
    error: SafeStringSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .refine((r) => (r.status === 'ok' ? r.error === undefined : r.content === ''), {
    message: 'Discriminated ToolResult invariant violated: ok must not carry error, error must have empty content',
  });
export type StrictToolResult = z.infer<typeof ToolResultSchema>;

export function safeParseToolResult(
  value: unknown,
): { success: true; data: StrictToolResult } | { success: false; error: string } {
  const result = ToolResultSchema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  };
}

export const ProviderToolFeedbackStatusSchema = z.enum(['ok', 'error']);
export type ProviderToolFeedbackStatus = z.infer<typeof ProviderToolFeedbackStatusSchema>;

export const ProviderToolFeedbackCodeSchema = SafeStringSchema.min(1).max(64);

/** Strict DTO that may be serialized into the provider message history. */
const controlCharsRegex = makeControlCharsRegex();
export function ProviderToolFeedbackSchema(allowedToolNames: readonly string[]) {
  const names = allowedToolNames.length > 0
    ? (allowedToolNames as [string, ...string[]])
    : (['__none__'] as [string]);
  return z.strictObject({
    role: z.literal('tool'),
    content: SafeStringSchema.max(MAX_PROVIDER_CONTENT_LENGTH),
    toolCallId: ToolCallIdSchema,
    name: z.enum(names).refine(
      (n) => !controlCharsRegex.test(n),
      'Control characters are not allowed in tool name',
    ),
    status: ProviderToolFeedbackStatusSchema,
    code: ProviderToolFeedbackCodeSchema.optional(),
  });
}

export type ProviderToolFeedback = z.infer<ReturnType<typeof ProviderToolFeedbackSchema>>;

/**
 * Truncate content at a safe boundary so we never emit a partial path, token,
 * or control sequence. If the content cannot be truncated cleanly, fall back to
 * a fixed marker.
 */
export function safeTruncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const marker = '\n... [truncated]';
  const budget = maxChars - marker.length;
  if (budget <= 0) return content.slice(0, maxChars);
  let cut = budget;
  // Try to cut at a whitespace boundary to avoid splitting tokens/paths.
  while (cut > 0 && !/\s/.test(content[cut]!)) {
    cut--;
  }
  if (cut <= budget * 0.5) {
    // No clean boundary nearby; fall back to a fixed marker.
    return '[TOOL_OUTPUT_TRUNCATED]';
  }
  const truncated = `${content.slice(0, cut)}${marker}`;
  // Post-cut safety check: if the truncated content still contains a path
  // pattern (the cut landed mid-component), fall back to the fixed marker.
  if (/[A-Za-z]:\\|\\\\[a-zA-Z]|\/(?:home|tmp|root|srv|Users|var|etc|opt|run|data|workspace|Volumes)\//.test(truncated)) {
    return '[TOOL_OUTPUT_TRUNCATED]';
  }
  return truncated;
}

/** Fixed recovery message when serialization or parsing fails at the boundary. */
export const RECOVERY_TOOL_FEEDBACK: ProviderToolFeedback = Object.freeze({
  role: 'tool',
  content: '[TOOL_FEEDBACK_UNAVAILABLE]',
  toolCallId: 'unknown',
  name: '__recovery__',
  status: 'error',
  code: 'recovery_unavailable',
});

export function safeParseToolPresentation(
  value: unknown,
): { success: true; data: ToolPresentation } | { success: false; error: string } {
  const result = ToolPresentationSchema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  };
}

export function safeParseProviderFeedback(
  value: unknown,
  allowedToolNames: readonly string[],
): { success: true; data: ProviderToolFeedback } | { success: false; error: string } {
  const result = ProviderToolFeedbackSchema(allowedToolNames).safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  };
}

/**
 * Serialize a validated ProviderToolFeedback. If the input does not validate,
 * return the fixed recovery JSON so the boundary never throws.
 */
export function safeSerializeProviderFeedback(
  feedback: ProviderToolFeedback,
  allowedToolNames: readonly string[],
): string {
  const parsed = safeParseProviderFeedback(feedback, allowedToolNames);
  if (parsed.success) {
    return JSON.stringify(parsed.data);
  }
  return JSON.stringify(RECOVERY_TOOL_FEEDBACK);
}

/**
 * Parse a serialized ProviderToolFeedback. On failure, return the fixed
 * recovery object.
 */
export function safeDeserializeProviderFeedback(
  serialized: string,
  allowedToolNames: readonly string[],
): ProviderToolFeedback {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    const result = safeParseProviderFeedback(parsed, allowedToolNames);
    if (result.success) return result.data;
  } catch {
    // fall through to recovery
  }
  return RECOVERY_TOOL_FEEDBACK;
}
