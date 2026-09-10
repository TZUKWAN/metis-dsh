import { z } from 'zod';

/**
 * WorkspaceAgentsContract — Metis.md runtime contract with legacy AGENTS.md migration support.
 *
 * Replaces the generic CLAUDE_MEMORY.md path with a purpose-built,
 * CAS-protected workspace agents file. Key differences from the old
 * MemoryRuntimeContract project-memory path:
 *
 *  - The public canonical file is Metis.md; legacy AGENTS.md remains an import-only migration source.
 *  - Hard limit 50 000 characters (aligned with UI maxLength).
 *  - Rejects C0 and C1 control characters (except \t \n \r).
 *  - Compare-And-Swap via version + content hash to detect concurrent writes.
 *  - IO failures are fail-closed (never silently swallowed).
 */

export const WORKSPACE_AGENTS_LIMITS = Object.freeze({
  maxChars: 50_000,
} as const);

export const WORKSPACE_METIS_FILENAME = 'Metis.md';
export const LEGACY_WORKSPACE_AGENTS_FILENAME = 'AGENTS.md';
/** @deprecated Use WORKSPACE_METIS_FILENAME. Kept as a source-compatible alias. */
export const WORKSPACE_AGENTS_FILENAME = WORKSPACE_METIS_FILENAME;

// ─── Control-character rejection ──────────────────────────────
//
// C0: U+0000 – U+001F  (allow \t=0009, \n=000A, \r=000D)
// C1: U+007F – U+009F
//
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;

export const WorkspaceAgentsContentSchema = z.string()
  .max(WORKSPACE_AGENTS_LIMITS.maxChars)
  .refine((value) => !CONTROL_CHAR_RE.test(value), {
    message: 'Workspace agents content must not contain C0/C1 control characters',
  });
export type WorkspaceAgentsContent = z.infer<typeof WorkspaceAgentsContentSchema>;

// ─── Content hash ──────────────────────────────────────────────

// ─── View (read result) ───────────────────────────────────────

export const PROJECT_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export const WorkspaceAgentsViewSchema = z.strictObject({
  exists: z.boolean(),
  content: z.string(),
  version: z.number().int().min(0),
  contentHash: z.string().min(0),
  externalConflict: z.boolean().optional(),
  projectId: z.string().max(128).refine(
    (v) => v === '' || PROJECT_ID_REGEX.test(v),
    'Invalid projectId',
  ),
});
export type WorkspaceAgentsView = z.infer<typeof WorkspaceAgentsViewSchema>;

export function createWorkspaceAgentsViewEmpty(): WorkspaceAgentsView {
  return { exists: false, content: '', version: 0, contentHash: '', projectId: '' };
}

export function decodeWorkspaceAgentsView(input: unknown): WorkspaceAgentsView {
  const parsed = WorkspaceAgentsViewSchema.safeParse(input);
  return parsed.success ? parsed.data : createWorkspaceAgentsViewEmpty();
}

// ─── Write request (CAS) ──────────────────────────────────────

export const WorkspaceAgentsWriteRequestSchema = z.strictObject({
  content: WorkspaceAgentsContentSchema,
  expectedVersion: z.number().int().min(0),
  projectId: z.string().min(1).max(128).regex(PROJECT_ID_REGEX),
});
export type WorkspaceAgentsWriteRequest = z.infer<typeof WorkspaceAgentsWriteRequestSchema>;

export const WorkspaceAgentsGetRequestSchema = z.strictObject({
  projectId: z.string().min(1).max(128).regex(PROJECT_ID_REGEX),
});
export type WorkspaceAgentsGetRequest = z.infer<typeof WorkspaceAgentsGetRequestSchema>;

export function decodeWorkspaceAgentsWriteRequest(input: unknown): WorkspaceAgentsWriteRequest | undefined {
  const parsed = WorkspaceAgentsWriteRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

export function decodeWorkspaceAgentsGetRequest(input: unknown): WorkspaceAgentsGetRequest | undefined {
  const parsed = WorkspaceAgentsGetRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

// ─── Mutation result (discriminated) ──────────────────────────

export const WorkspaceAgentsMutationResultSchema = z.discriminatedUnion('code', [
  z.strictObject({
    success: z.literal(true),
    code: z.literal('saved'),
    version: z.number().int().min(1),
    contentHash: z.string().min(1),
  }),
  z.strictObject({
    success: z.literal(false),
    code: z.literal('cas_conflict'),
    currentVersion: z.number().int().min(0),
    currentContentHash: z.string().min(0),
  }),
  z.strictObject({
    success: z.literal(false),
    code: z.literal('content_invalid'),
  }),
  z.strictObject({
    success: z.literal(false),
    code: z.literal('agents_unavailable'),
  }),
  z.strictObject({
    success: z.literal(false),
    code: z.literal('io_error'),
  }),
  z.strictObject({
    success: z.literal(false),
    code: z.literal('external_conflict'),
  }),
  z.strictObject({
    success: z.literal(false),
    code: z.literal('project_not_found'),
  }),
]);
export type WorkspaceAgentsMutationResult = z.infer<typeof WorkspaceAgentsMutationResultSchema>;

export function createWorkspaceAgentsFailure(
  code: 'content_invalid' | 'agents_unavailable' | 'io_error' | 'project_not_found',
): WorkspaceAgentsMutationResult {
  return { success: false, code };
}

export function createWorkspaceAgentsCASConflict(
  currentVersion: number,
  currentContentHash: string,
): WorkspaceAgentsMutationResult {
  return { success: false, code: 'cas_conflict', currentVersion, currentContentHash };
}

export function decodeWorkspaceAgentsMutationResult(input: unknown): WorkspaceAgentsMutationResult {
  const parsed = WorkspaceAgentsMutationResultSchema.safeParse(input);
  return parsed.success ? parsed.data : createWorkspaceAgentsFailure('agents_unavailable');
}
