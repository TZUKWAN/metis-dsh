import { z } from 'zod';
import { McpToolNameSchema } from './McpInstallationContract.js';
import {
  McpDefinitionSchema,
  PERSONALIZATION_CONTRACT_VERSION,
  PersonalizationDigestSchema,
  PersonalizationLocalIdSchema,
  PersonalizationTimestampSchema,
} from './PersonalizationRuntimeContract.js';
import { EvidenceEnvelopeSchema } from './EvidenceEnvelopeContract.js';

export const MANAGED_MCP_COMMAND = 'metis-managed-mcp' as const;
export const MANAGED_MCP_RUNTIME_TOKEN_PATTERN = /^mmcp_[a-f0-9]{64}$/u;

const InstallationIdSchema = z.string().regex(/^mcp_[a-f0-9]{32}$/u);
const OperationIdSchema = z.string().uuid();

export const ManagedMcpOwnerSchema = z.strictObject({
  webContentsId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  processId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  routingId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

/**
 * A runnable personalization definition is only an opaque reference to a
 * main-process installation. Renderer-authored paths, commands and plaintext
 * environment values are rejected at this boundary.
 */
export const ManagedMcpDefinitionSchema = McpDefinitionSchema.superRefine((definition, context) => {
  if (!definition.enabled) {
    context.addIssue({ code: 'custom', path: ['enabled'], message: 'Managed MCP must be enabled' });
  }
  if (definition.command !== MANAGED_MCP_COMMAND) {
    context.addIssue({ code: 'custom', path: ['command'], message: 'Runtime command is main-process managed' });
  }
  if (definition.args.length !== 1 || !InstallationIdSchema.safeParse(definition.args[0]).success) {
    context.addIssue({ code: 'custom', path: ['args'], message: 'Exactly one installation identifier is required' });
  }
  if (definition.workingDirectoryToken !== definition.args[0]) {
    context.addIssue({ code: 'custom', path: ['workingDirectoryToken'], message: 'Working directory token must bind the installation' });
  }
  if (definition.exposedTools.length === 0) {
    context.addIssue({ code: 'custom', path: ['exposedTools'], message: 'At least one exposed tool is required' });
  }
  for (const [name, binding] of Object.entries(definition.environment)) {
    if (!binding.secret || binding.value !== null) {
      context.addIssue({ code: 'custom', path: ['environment', name], message: 'Only opaque secret references are accepted' });
    }
  }
});

const RuntimeBindingSchema = z.strictObject({
  sessionId: PersonalizationLocalIdSchema,
  projectId: PersonalizationLocalIdSchema,
  owner: ManagedMcpOwnerSchema,
});

export const ManagedMcpStartRequestSchema = RuntimeBindingSchema.extend({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  operationId: OperationIdSchema,
  definition: ManagedMcpDefinitionSchema,
}).strict();

export const ManagedMcpRuntimeTokenSchema = z.string().regex(MANAGED_MCP_RUNTIME_TOKEN_PATTERN);

const StartFailureCodeSchema = z.enum([
  'invalid_request',
  'replay_rejected',
  'already_running',
  'installation_unavailable',
  'descriptor_rejected',
  'secret_unavailable',
  'handshake_failed',
  'tool_drift',
  'schema_rejected',
  'evidence_boundary_unavailable',
]);

export const ManagedMcpStartResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
    operationId: OperationIdSchema,
    runtimeToken: ManagedMcpRuntimeTokenSchema,
    exposedTools: z.array(McpToolNameSchema).min(1).max(512),
    startedAt: PersonalizationTimestampSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
    operationId: OperationIdSchema,
    code: StartFailureCodeSchema,
  }),
]);

export const ManagedMcpInvokeRequestSchema = RuntimeBindingSchema.extend({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  operationId: OperationIdSchema,
  runtimeToken: ManagedMcpRuntimeTokenSchema,
  toolName: McpToolNameSchema,
  arguments: z.record(z.string(), z.unknown()),
  runManifestDigest: PersonalizationDigestSchema,
  timeoutMs: z.number().int().min(100).max(60_000),
}).strict();

const InvokeFailureCodeSchema = z.enum([
  'invalid_request',
  'runtime_unavailable',
  'binding_mismatch',
  'replay_rejected',
  'tool_unavailable',
  'arguments_rejected',
  'timeout',
  'aborted',
  'transport_failed',
  'output_rejected',
  'output_too_large',
  'secret_leak_blocked',
  'evidence_failed',
]);

export const ManagedMcpInvokeResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
    operationId: OperationIdSchema,
    envelope: EvidenceEnvelopeSchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
    operationId: OperationIdSchema,
    code: InvokeFailureCodeSchema,
  }),
]);

export const ManagedMcpStopRequestSchema = RuntimeBindingSchema.extend({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  operationId: OperationIdSchema,
  runtimeToken: ManagedMcpRuntimeTokenSchema,
}).strict();

export const ManagedMcpStopResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
    operationId: OperationIdSchema,
    stopped: z.literal(true),
  }),
  z.strictObject({
    ok: z.literal(false),
    contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
    operationId: OperationIdSchema,
    code: z.enum(['invalid_request', 'runtime_unavailable', 'binding_mismatch', 'replay_rejected']),
  }),
]);

export type ManagedMcpOwner = z.infer<typeof ManagedMcpOwnerSchema>;
export type ManagedMcpDefinition = z.infer<typeof ManagedMcpDefinitionSchema>;
export type ManagedMcpStartRequest = z.infer<typeof ManagedMcpStartRequestSchema>;
export type ManagedMcpStartResponse = z.infer<typeof ManagedMcpStartResponseSchema>;
export type ManagedMcpInvokeRequest = z.infer<typeof ManagedMcpInvokeRequestSchema>;
export type ManagedMcpInvokeResponse = z.infer<typeof ManagedMcpInvokeResponseSchema>;
export type ManagedMcpStopRequest = z.infer<typeof ManagedMcpStopRequestSchema>;
export type ManagedMcpStopResponse = z.infer<typeof ManagedMcpStopResponseSchema>;

export function decodeManagedMcpStartRequest(raw: unknown): ManagedMcpStartRequest | undefined {
  const parsed = ManagedMcpStartRequestSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function decodeManagedMcpInvokeRequest(raw: unknown): ManagedMcpInvokeRequest | undefined {
  const parsed = ManagedMcpInvokeRequestSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function decodeManagedMcpStopRequest(raw: unknown): ManagedMcpStopRequest | undefined {
  const parsed = ManagedMcpStopRequestSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
