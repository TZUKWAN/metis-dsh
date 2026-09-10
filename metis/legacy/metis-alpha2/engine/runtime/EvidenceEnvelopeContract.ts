import { z } from 'zod';
import {
  PERSONALIZATION_CONTRACT_VERSION,
  PersonalizationDigestSchema,
  PersonalizationIdSchema,
  PersonalizationLocalIdSchema,
  PersonalizationTimestampSchema,
  PersonalizationUrlSchema,
} from './PersonalizationRuntimeContract.js';

export const EVIDENCE_ENVELOPE_VERSION = 1 as const;
export const EVIDENCE_PAYLOAD_MAX_CHARS = 1_000_000;

// eslint-disable-next-line no-control-regex -- boundary rejects unsafe C0/C1 control input
const UNSAFE_SINGLE_LINE = /[\u0000-\u001f\u007f-\u009f]/u;
// eslint-disable-next-line no-control-regex -- tabs/newlines are permitted in textual evidence
const UNSAFE_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

const SafeLineSchema = z.string().min(1).max(4096).refine((value) => !UNSAFE_SINGLE_LINE.test(value));
const SafeTextSchema = z.string().max(EVIDENCE_PAYLOAD_MAX_CHARS).refine((value) => !UNSAFE_MULTILINE.test(value));

export const UntrustedEvidencePayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), content: SafeTextSchema }),
  z.strictObject({ kind: z.literal('json'), canonicalJson: SafeTextSchema }),
  z.strictObject({
    kind: z.literal('binary_digest'),
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    sha256: PersonalizationDigestSchema,
    mediaType: SafeLineSchema,
  }),
]);

/**
 * Internal ingress request. It deliberately has no editable truth, review,
 * correction, claim-eligibility, or publication fields. Strict parsing makes
 * attempts to smuggle those properties fail before signing.
 */
export const EvidenceIngressRequestSchema = z.strictObject({
  contractVersion: z.literal(PERSONALIZATION_CONTRACT_VERSION),
  sessionId: PersonalizationLocalIdSchema,
  projectId: PersonalizationLocalIdSchema,
  operationId: PersonalizationLocalIdSchema,
  runManifestDigest: PersonalizationDigestSchema,
  sourceDefinitionId: PersonalizationIdSchema,
  sourceDefinitionRevision: z.number().int().min(1).max(1_000_000_000),
  sourceKind: z.enum(['skill', 'mcp']),
  observedAt: PersonalizationTimestampSchema,
  sourceUrl: PersonalizationUrlSchema.nullable(),
  locator: SafeLineSchema.nullable(),
  payload: UntrustedEvidencePayloadSchema,
});

export const AutomaticTruthStateSchema = z.strictObject({
  state: z.literal('unverified'),
  authority: z.literal('metis_automatic_truth_layer'),
  reviewStatus: z.literal('pending'),
  correctionState: z.literal('unknown'),
  claimEligible: z.literal(false),
  publishEligible: z.literal(false),
});

export const UnsignedEvidenceEnvelopeSchema = z.strictObject({
  envelopeVersion: z.literal(EVIDENCE_ENVELOPE_VERSION),
  envelopeId: z.string().regex(/^evidence_[a-f0-9]{32}$/u),
  sessionId: PersonalizationLocalIdSchema,
  projectId: PersonalizationLocalIdSchema,
  operationId: PersonalizationLocalIdSchema,
  runManifestDigest: PersonalizationDigestSchema,
  sourceDefinitionId: PersonalizationIdSchema,
  sourceDefinitionRevision: z.number().int().min(1).max(1_000_000_000),
  sourceKind: z.enum(['skill', 'mcp']),
  observedAt: PersonalizationTimestampSchema,
  sourceUrl: PersonalizationUrlSchema.nullable(),
  locator: SafeLineSchema.nullable(),
  payload: UntrustedEvidencePayloadSchema,
  payloadDigest: PersonalizationDigestSchema,
  truth: AutomaticTruthStateSchema,
});

export const EvidenceEnvelopeSchema = UnsignedEvidenceEnvelopeSchema.extend({
  signature: PersonalizationDigestSchema,
}).strict();

export type UntrustedEvidencePayload = z.infer<typeof UntrustedEvidencePayloadSchema>;
export type EvidenceIngressRequest = z.infer<typeof EvidenceIngressRequestSchema>;
export type UnsignedEvidenceEnvelope = z.infer<typeof UnsignedEvidenceEnvelopeSchema>;
export type EvidenceEnvelope = z.infer<typeof EvidenceEnvelopeSchema>;

export function decodeEvidenceEnvelope(input: unknown): EvidenceEnvelope | undefined {
  const parsed = EvidenceEnvelopeSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}
