import { z } from 'zod';
import { CitationTruthAttestationSchema } from './CitationTruth.js';

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const CitationTruthRequestSchema = z.strictObject({
  sourceId: z.string().min(1),
  locator: z.string().trim().min(1).max(2_000),
});

export type CitationTruthRequest = z.infer<typeof CitationTruthRequestSchema>;

/**
 * Main-process proof that a citation was resolved against the current source
 * record and bound to one immutable artifact payload.  The renderer never
 * receives an API that can submit this structure.
 */
export const CitationTruthReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  issuer: z.literal('metis-main'),
  receiptId: z.string().regex(/^ctr_[A-Za-z0-9_-]{16,128}$/u),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/u),
  projectId: z.string().min(1),
  artifactId: z.string().min(1),
  artifactVersion: z.number().int().positive(),
  contentDigest: Sha256Schema,
  sourceId: z.string().min(1),
  sourceSnapshotDigest: Sha256Schema,
  attestation: CitationTruthAttestationSchema,
  referenceValidatedAt: z.number().int().positive(),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  signature: z.string().regex(/^[a-f0-9]{64}$/u),
}).superRefine((receipt, context) => {
  if (receipt.attestation.sourceId !== receipt.sourceId) {
    context.addIssue({
      code: 'custom',
      message: 'Receipt attestation source must match its bound source',
      path: ['attestation', 'sourceId'],
    });
  }
  if (receipt.expiresAt <= receipt.issuedAt) {
    context.addIssue({
      code: 'custom',
      message: 'Receipt expiry must follow issuance',
      path: ['expiresAt'],
    });
  }
  if (
    receipt.referenceValidatedAt > receipt.issuedAt + 60_000
    || receipt.issuedAt - receipt.referenceValidatedAt > 60_000
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Receipt must bind a contemporaneous reference validation',
      path: ['referenceValidatedAt'],
    });
  }
});

export type CitationTruthReceipt = z.infer<typeof CitationTruthReceiptSchema>;

export type UnsignedCitationTruthReceipt = Omit<CitationTruthReceipt, 'signature'>;

/** Canonical JSON used by the main-process HMAC implementation. */
export function canonicalReceiptPayload(value: UnsignedCitationTruthReceipt): string {
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    issuer: value.issuer,
    receiptId: value.receiptId,
    nonce: value.nonce,
    projectId: value.projectId,
    artifactId: value.artifactId,
    artifactVersion: value.artifactVersion,
    contentDigest: value.contentDigest,
    sourceId: value.sourceId,
    sourceSnapshotDigest: value.sourceSnapshotDigest,
    attestation: value.attestation,
    referenceValidatedAt: value.referenceValidatedAt,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  });
}
