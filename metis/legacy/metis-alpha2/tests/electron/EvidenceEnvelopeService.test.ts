import { describe, expect, it } from 'vitest';
import { EvidenceIngressRequestSchema } from '../../engine/runtime/EvidenceEnvelopeContract.js';
import { EvidenceEnvelopeService } from '../../electron/EvidenceEnvelopeService.js';

const SECRET = Buffer.alloc(32, 7);
const DIGEST = 'a'.repeat(64);

function request() {
  return {
    contractVersion: 1 as const,
    sessionId: 'session-1',
    projectId: 'project-1',
    operationId: 'operation-1',
    runManifestDigest: DIGEST,
    sourceDefinitionId: 'user:skills/imported',
    sourceDefinitionRevision: 2,
    sourceKind: 'skill' as const,
    observedAt: 1_785_398_400_000,
    sourceUrl: 'https://github.com/example/skill',
    locator: 'result:1',
    payload: { kind: 'text' as const, content: 'The extension claims this result is verified.' },
  };
}

describe('EvidenceEnvelopeService', () => {
  it('always labels third-party output unverified and ineligible regardless of its text', () => {
    const service = new EvidenceEnvelopeService(SECRET);
    const envelope = service.issue(request());
    expect(envelope?.truth).toEqual({
      state: 'unverified',
      authority: 'metis_automatic_truth_layer',
      reviewStatus: 'pending',
      correctionState: 'unknown',
      claimEligible: false,
      publishEligible: false,
    });
    expect(service.verify(envelope)).toBe(true);
  });

  it('strictly rejects attempts to smuggle truth or correction fields into ingress', () => {
    expect(EvidenceIngressRequestSchema.safeParse({
      ...request(),
      verified: true,
      correctionState: 'clean',
      publishEligible: true,
    }).success).toBe(false);
  });

  it('detects payload, truth, manifest and signature tampering', () => {
    const service = new EvidenceEnvelopeService(SECRET);
    const envelope = service.issue(request())!;
    expect(service.verify({ ...envelope, payload: { kind: 'text', content: 'changed' } })).toBe(false);
    expect(service.verify({ ...envelope, truth: { ...envelope.truth, state: 'verified' } })).toBe(false);
    expect(service.verify({ ...envelope, runManifestDigest: 'b'.repeat(64) })).toBe(false);
    expect(service.verify({ ...envelope, signature: '0'.repeat(64) })).toBe(false);
  });

  it('binds envelopes to session, project, definition revision and run manifest', () => {
    const service = new EvidenceEnvelopeService(SECRET);
    const first = service.issue(request())!;
    const second = service.issue({ ...request(), sourceDefinitionRevision: 3 })!;
    expect(first.envelopeId).not.toBe(second.envelopeId);
    expect(first.payloadDigest).toBe(second.payloadDigest);
    expect(service.verify(first)).toBe(true);
    expect(service.verify(second)).toBe(true);
  });

  it('fails closed for invalid requests and short signing secrets', () => {
    expect(() => new EvidenceEnvelopeService(Buffer.alloc(31))).toThrow(/32 bytes/u);
    const service = new EvidenceEnvelopeService(SECRET);
    expect(service.issue({ ...request(), sourceUrl: 'file:///secret' })).toBeUndefined();
    expect(service.issue({ ...request(), sessionId: '../escape' })).toBeUndefined();
  });
});
