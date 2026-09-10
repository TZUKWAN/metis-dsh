import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  EVIDENCE_ENVELOPE_VERSION,
  EvidenceEnvelopeSchema,
  EvidenceIngressRequestSchema,
  UnsignedEvidenceEnvelopeSchema,
  type EvidenceEnvelope,
  type EvidenceIngressRequest,
  type UnsignedEvidenceEnvelope,
} from '../engine/runtime/EvidenceEnvelopeContract.js';

const DOMAIN = 'metis:personalization-evidence:v1\0';
const MIN_SECRET_BYTES = 32;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sign(secret: Buffer, envelope: UnsignedEvidenceEnvelope): string {
  return createHmac('sha256', secret).update(DOMAIN).update(canonicalJson(envelope), 'utf8').digest('hex');
}

export class EvidenceEnvelopeService {
  readonly #secret: Buffer;

  constructor(secret: Buffer) {
    if (!Buffer.isBuffer(secret) || secret.byteLength < MIN_SECRET_BYTES) {
      throw new Error('Evidence envelope signing secret must contain at least 32 bytes');
    }
    this.#secret = Buffer.from(secret);
  }

  issue(raw: unknown): EvidenceEnvelope | undefined {
    const parsed = EvidenceIngressRequestSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    const request: EvidenceIngressRequest = parsed.data;
    const payloadDigest = sha256(canonicalJson(request.payload));
    const bindingDigest = sha256(canonicalJson({
      sessionId: request.sessionId,
      projectId: request.projectId,
      operationId: request.operationId,
      runManifestDigest: request.runManifestDigest,
      sourceDefinitionId: request.sourceDefinitionId,
      sourceDefinitionRevision: request.sourceDefinitionRevision,
      payloadDigest,
      observedAt: request.observedAt,
    }));
    const unsigned = UnsignedEvidenceEnvelopeSchema.parse({
      envelopeVersion: EVIDENCE_ENVELOPE_VERSION,
      envelopeId: `evidence_${bindingDigest.slice(0, 32)}`,
      sessionId: request.sessionId,
      projectId: request.projectId,
      operationId: request.operationId,
      runManifestDigest: request.runManifestDigest,
      sourceDefinitionId: request.sourceDefinitionId,
      sourceDefinitionRevision: request.sourceDefinitionRevision,
      sourceKind: request.sourceKind,
      observedAt: request.observedAt,
      sourceUrl: request.sourceUrl,
      locator: request.locator,
      payload: request.payload,
      payloadDigest,
      truth: {
        state: 'unverified',
        authority: 'metis_automatic_truth_layer',
        reviewStatus: 'pending',
        correctionState: 'unknown',
        claimEligible: false,
        publishEligible: false,
      },
    });
    return EvidenceEnvelopeSchema.parse({ ...unsigned, signature: sign(this.#secret, unsigned) });
  }

  verify(raw: unknown): raw is EvidenceEnvelope {
    const parsed = EvidenceEnvelopeSchema.safeParse(raw);
    if (!parsed.success) return false;
    const { signature, ...unsignedCandidate } = parsed.data;
    const unsigned = UnsignedEvidenceEnvelopeSchema.safeParse(unsignedCandidate);
    if (!unsigned.success) return false;
    const payloadDigest = sha256(canonicalJson(unsigned.data.payload));
    if (payloadDigest !== unsigned.data.payloadDigest) return false;
    const expected = Buffer.from(sign(this.#secret, unsigned.data), 'hex');
    const actual = Buffer.from(signature, 'hex');
    return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
  }
}
