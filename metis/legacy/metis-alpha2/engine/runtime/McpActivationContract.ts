import { z } from 'zod';
import { EvidenceEnvelopeSchema } from './EvidenceEnvelopeContract.js';
import { ExtensionEvidenceContextSchema } from './PersonalizationExtensionContract.js';
import {
  McpInstalledRecordSchema,
  McpPackageDigestSchema,
  McpPackageIdSchema,
  McpPackageVersionSchema,
  McpToolNameSchema,
  MCP_INSTALL_LIMITS,
} from './McpInstallationContract.js';
import { ManagedMcpOwnerSchema } from './ManagedMcpRuntimeContract.js';
import {
  McpDefinitionSchema,
  PERSONALIZATION_LIMITS,
  PersonalizationIdSchema,
} from './PersonalizationRuntimeContract.js';

export const MCP_ACTIVATION_CONTRACT_VERSION = 1 as const;
const FALLBACK_OPERATION_ID = '00000000-0000-4000-8000-000000000000';
const InstallationIdSchema = z.string().regex(/^mcp_[a-f0-9]{32}$/u);
const RevisionSchema = z.number().int().min(1).max(PERSONALIZATION_LIMITS.version);
const ActivatableMcpDefinitionIdSchema = PersonalizationIdSchema.refine(
  (value) => value.startsWith('url:mcp/') || value.startsWith('generated:mcp/') || value.startsWith('user:mcp/'),
);
const RendererActivatableMcpDefinitionIdSchema = PersonalizationIdSchema.refine(
  (value) => value.startsWith('url:mcp/') || value.startsWith('user:mcp/'),
);
const UniqueToolNamesSchema = z.array(McpToolNameSchema).min(1).max(MCP_INSTALL_LIMITS.tools)
  .refine((values) => new Set(values).size === values.length, { message: 'Tool names must be unique' });

export const McpActivationEvidenceContextSchema = ExtensionEvidenceContextSchema.extend({
  owner: ManagedMcpOwnerSchema,
}).strict();

/**
 * Renderer-to-main activation request. The main process derives owner and evidence context from
 * the authenticated IPC sender; renderer input can only identify the pending installation and
 * provide its CAS revision.
 */
export const McpActivationIpcRequestSchema = z.strictObject({
  contractVersion: z.literal(MCP_ACTIVATION_CONTRACT_VERSION),
  operationId: z.string().uuid(),
  // Generated MCP activation is a main-process transaction coordinated with
  // its durable definition journal. The public renderer path must never enter
  // the inner activation service directly.
  definitionId: RendererActivatableMcpDefinitionIdSchema,
  installationId: InstallationIdSchema,
  expectedRevision: RevisionSchema,
});

/** Main-process activation request. It deliberately has no tool-call/sample-call field. */
export const McpActivationRequestSchema = z.strictObject({
  contractVersion: z.literal(MCP_ACTIVATION_CONTRACT_VERSION),
  definitionId: ActivatableMcpDefinitionIdSchema,
  installationId: InstallationIdSchema,
  expectedRevision: RevisionSchema,
  evidenceContext: McpActivationEvidenceContextSchema,
});

/** Canonical JSON stored inside the signed evidence payload. */
export const McpActivationEvidencePayloadSchema = z.strictObject({
  event: z.enum(['mcp_url_activated', 'mcp_generated_activated', 'mcp_package_activated']),
  definitionId: ActivatableMcpDefinitionIdSchema,
  installationId: InstallationIdSchema,
  packageId: McpPackageIdSchema,
  packageVersion: McpPackageVersionSchema,
  packageDigest: McpPackageDigestSchema,
  manifestDigest: McpPackageDigestSchema,
  priorRevision: RevisionSchema,
  activatedRevision: RevisionSchema,
  exposedTools: UniqueToolNamesSchema,
  probeState: z.literal('probe_verified'),
  owner: ManagedMcpOwnerSchema,
}).superRefine((payload, context) => {
  if (payload.activatedRevision !== payload.priorRevision + 1) {
    context.addIssue({ code: 'custom', path: ['activatedRevision'], message: 'Activation must advance one revision' });
  }
  const expectedEvent = payload.definitionId.startsWith('generated:mcp/')
    ? 'mcp_generated_activated'
    : payload.definitionId.startsWith('user:mcp/') ? 'mcp_package_activated' : 'mcp_url_activated';
  if (payload.event !== expectedEvent) {
    context.addIssue({ code: 'custom', path: ['event'], message: 'Activation event must match the definition source' });
  }
});

/** Strict input to the repository's activation-only atomic transaction. */
export const McpActivationPersistenceInputSchema = z.strictObject({
  previousDefinition: McpDefinitionSchema,
  activatedDefinition: McpDefinitionSchema,
  installation: McpInstalledRecordSchema,
  envelope: EvidenceEnvelopeSchema,
  owner: ManagedMcpOwnerSchema,
});

const McpActivationSuccessSchema = z.strictObject({
  ok: z.literal(true),
  contractVersion: z.literal(MCP_ACTIVATION_CONTRACT_VERSION),
  operationId: z.string().uuid(),
  definition: McpDefinitionSchema,
  installation: McpInstalledRecordSchema,
  evidence: EvidenceEnvelopeSchema,
}).superRefine((result, context) => {
  const sourceMatches = (result.definition.sourceMode === 'url'
      && result.definition.id.startsWith('url:mcp/')
      && result.definition.provenance.origin === 'url'
      && result.definition.sourceUrl !== null
      && result.definition.sourceUrl === result.definition.provenance.sourceUrl)
    || (result.definition.sourceMode === 'generated'
      && result.definition.id.startsWith('generated:mcp/')
      && result.definition.provenance.origin === 'generated'
      && result.definition.sourceUrl === null
      && result.definition.provenance.sourceUrl === null)
    || (result.definition.sourceMode === 'package'
      && result.definition.id.startsWith('user:mcp/')
      && result.definition.provenance.origin === 'user'
      && result.definition.sourceUrl === null
      && result.definition.provenance.sourceUrl === null);
  if (!result.definition.enabled || !sourceMatches
    || result.definition.command !== 'metis-managed-mcp'
    || result.definition.args.length !== 1
    || result.definition.args[0] !== result.installation.installationId
    || result.definition.workingDirectoryToken !== result.installation.installationId
    || result.definition.provenance.sourceRevision !== result.installation.installationId
    || result.definition.provenance.installedDigest !== result.installation.packageSha256
    || result.definition.tags.includes('pending-probe')
    || !result.definition.tags.includes('probe-verified')
    || Object.values(result.definition.environment).some((entry) => !entry.secret || entry.value !== null)
    || result.definition.exposedTools.length !== result.installation.exposedTools.length
    || !result.definition.exposedTools.every((tool, index) => tool === result.installation.exposedTools[index])
    || !result.installation.enabled || result.installation.state !== 'enabled'
    || result.installation.verifiedAt === null || result.installation.probedAt === null
    || result.installation.failureCode !== null || result.installation.exposedTools.length === 0
    || result.evidence.sourceDefinitionId !== result.definition.id
    || result.evidence.sourceDefinitionRevision !== result.definition.revision
    || result.evidence.operationId !== result.operationId) {
    context.addIssue({ code: 'custom', message: 'Activation response bindings are inconsistent' });
  }
});

export const McpActivationFailureCodeSchema = z.enum([
  'invalid_request',
  'invalid_response',
  'recovery_failed',
  'definition_not_found',
  'revision_conflict',
  'definition_rejected',
  'installation_unavailable',
  'probe_failed',
  'launch_descriptor_unavailable',
  'evidence_unavailable',
  'persistence_failed',
  'compensation_failed',
]);

const McpActivationFailureSchema = z.strictObject({
  ok: z.literal(false),
  contractVersion: z.literal(MCP_ACTIVATION_CONTRACT_VERSION),
  operationId: z.string().uuid(),
  code: McpActivationFailureCodeSchema,
  compensated: z.boolean(),
  recoveryPending: z.boolean(),
});

export const McpActivationResponseSchema = z.discriminatedUnion('ok', [
  McpActivationSuccessSchema,
  McpActivationFailureSchema,
]);

export const McpActivationRecoveryResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    recovered: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.literal('recovery_failed'),
    recovered: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    pending: z.number().int().positive(),
  }),
]);

export type McpActivationEvidenceContext = z.infer<typeof McpActivationEvidenceContextSchema>;
export type McpActivationIpcRequest = z.infer<typeof McpActivationIpcRequestSchema>;
export type McpActivationRequest = z.infer<typeof McpActivationRequestSchema>;
export type McpActivationEvidencePayload = z.infer<typeof McpActivationEvidencePayloadSchema>;
export type McpActivationPersistenceInput = z.infer<typeof McpActivationPersistenceInputSchema>;
export type McpActivationResponse = z.infer<typeof McpActivationResponseSchema>;
export type McpActivationRecoveryResult = z.infer<typeof McpActivationRecoveryResultSchema>;

export function decodeMcpActivationResponse(raw: unknown): McpActivationResponse {
  const parsed = McpActivationResponseSchema.safeParse(raw);
  return parsed.success ? parsed.data : {
    ok: false,
    contractVersion: MCP_ACTIVATION_CONTRACT_VERSION,
    operationId: FALLBACK_OPERATION_ID,
    code: 'invalid_response',
    compensated: false,
    recoveryPending: false,
  };
}
