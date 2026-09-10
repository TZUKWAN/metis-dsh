/**
 * FIX-METIS-470 三项 P0 红测 — 先证明当前实现失败。
 * 不碰 main/preload，仅测试 engine 层 contract + approval + service。
 */
import { describe, it, expect } from 'vitest';
import {
  ApprovalReceiptSchema,
  CurrentAffairsExportRequestSchema,
  CurrentAffairsExportResponseSchema,
  isReceiptExpired,
  isReceiptValid,
  createReceiptFingerprint,
  decodeCurrentAffairsResearchResponse,
  type ApprovalReceipt,
} from '../../runtime/CurrentAffairsRuntimeContract.js';
import { CurrentAffairsManifestSchema } from '../CurrentAffairsProfile.js';
import { CurrentAffairsService } from '../CurrentAffairsService.js';
import { executeCurrentAffairsExport } from '../CurrentAffairsExportAdapter.js';

const NOW = 1750000000000;

function makeManifest() {
  return CurrentAffairsManifestSchema.parse({
    schemaVersion: 1 as const, projectId: 'proj-red', workflowId: 'wf-red', manifestVersion: 1, profileId: 'approval-test', title: '审批门禁测试',
    timeWindow: { fetchedAt: NOW, timeSensitive: true, maxSourceAgeDays: 180 },
    sources: [
      { sourceId: 's1', kind: 'policy_document' as const, title: '政策', authors: ['部委'], publishedAt: NOW-30*86400000, fetchedAt: NOW, url: 'https://gov.cn/test', correctionState: 'clean' as const },
    ],
    facts: [{ claimId: 'c1', statement: '测试', evidenceSourceIds: ['s1'], verifiedAt: NOW }],
    createdAt: NOW, updatedAt: NOW,
  });
}

function makeReceipt(overrides: Partial<ApprovalReceipt> = {}): ApprovalReceipt {
  return {
    receiptId: 'rcpt-test-001',
    requestId: 'req-test-001',
    projectId: 'proj-test', workflowId: 'wf-test', profileId: 'approval-test', manifestVersion: 1,
    ownerSessionId: 'session-a',
    contentDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sourceSnapshotDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    nonce: 'nonce-12345',
    issuedAt: NOW,
    expiresAt: NOW + 300_000,
    approved: true,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// P0-1 RED: 无审批直出 — export without approval receipt
// ═══════════════════════════════════════════════════════════════
describe('P0-1: 无审批直出 (export without approval)', () => {
  it('RED: export request missing receiptId is rejected by schema', () => {
    const req = {
      version: 1,
      operationId: 'op-001',
      projectId: 'proj-test', workflowId: 'wf-test', profileId: 'approval-test', manifestVersion: 1,
      contentDigest: 'a'.repeat(64),
      // receiptId MISSING — no approval
      receiptNonce: 'nonce-12345',
    };
    const parsed = CurrentAffairsExportRequestSchema.safeParse(req);
    expect(parsed.success).toBe(false);
  });

  it('RED: export request with empty receiptId is rejected', () => {
    const req = {
      version: 1, operationId: 'op-002', projectId: 'proj-test', workflowId: 'wf-test', profileId: 'approval-test', manifestVersion: 1,
      contentDigest: 'a'.repeat(64),
      receiptId: '',
      receiptNonce: 'nonce-12345',
    };
    const parsed = CurrentAffairsExportRequestSchema.safeParse(req);
    expect(parsed.success).toBe(false);
  });

  it('FIXED: executeCurrentAffairsExport must FAIL without approval', () => {
    const manifest = makeManifest();
    const service = new CurrentAffairsService({ now: () => NOW });
    const { state } = service.executeWorkflow(manifest);
    const result = executeCurrentAffairsExport(manifest, state);
    // Service now stops at approval phase — export requires Runtime approve+markApproved
    expect(result.ok).toBe(false);
    expect(result.exportReady).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// P0-2 RED: self-asserted source — renderer claims source truth
// ═══════════════════════════════════════════════════════════════
describe('P0-2: self-asserted source (renderer claims source validity)', () => {
  it('FIXED: unverified manifest export fails (no approval)', () => {
    const manifest = makeManifest();
    const service = new CurrentAffairsService({ now: () => NOW });
    const { state } = service.executeWorkflow(manifest);
    const result = executeCurrentAffairsExport(manifest, state);
    // Service no longer auto-approves; repository re-check in Runtime
    expect(result.ok).toBe(false);
  });

  it('RED: manifest with renderer-asserted url is accepted without main validation', () => {
    const manifest = makeManifest();
    // Renderer can claim any URL — no main-side resolution
    manifest.sources[0]!.url = 'https://fake-renderer-claim.example.com/doc';
    const parsed = CurrentAffairsManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(true); // Schema accepts — need repository-backed truth
  });
});

// ═══════════════════════════════════════════════════════════════
// P0-3 RED: records-only 无 artifact — export plan without artifact
// ═══════════════════════════════════════════════════════════════
describe('P0-3: records-only 无 artifact (export plan without real artifact)', () => {
  it('RED: executeCurrentAffairsExport returns records but no artifactId/version', () => {
    const manifest = makeManifest();
    const service = new CurrentAffairsService({ now: () => NOW });
    const { state } = service.executeWorkflow(manifest);
    const result = executeCurrentAffairsExport(manifest, state);

    // Current: returns records array and preview, but NO artifact
    expect(result.records.length).toBeGreaterThan(0);
    // RED: result has no artifactId — this is just a plan, not a real artifact
    expect((result as unknown as Record<string, unknown>).artifactId).toBeUndefined();
    // RED: result has no artifactVersion
    expect((result as unknown as Record<string, unknown>).artifactVersion).toBeUndefined();
    // RED: result has no provenance
    expect((result as unknown as Record<string, unknown>).provenance).toBeUndefined();
  });

  it('RED: ExportResponse schema requires artifactId and provenance', () => {
    // Real export response MUST have artifactId, version, content, provenance
    const validExport = {
      ok: true,
      version: 1,
      operationId: 'op-ok',
      artifactId: 'art-test-001',
      artifactVersion: 1,
      contentDigest: 'a'.repeat(64),
      gatePassed: true,
      gateIssues: [],
      recordCount: 5,
      provenance: {
        exportedAt: NOW,
        exportedBy: 'session-a',
        receiptId: 'rcpt-001',
        sourceCount: 1,
      },
    };
    const parsed = CurrentAffairsExportResponseSchema.safeParse(validExport);
    expect(parsed.success).toBe(true);
  });

  it('RED: ExportResponse rejects records-only (no artifact)', () => {
    // A records-only response without artifact fields must be rejected
    const fakeExport = {
      ok: true,
      exportReady: true,
      gatePassed: true,
      gateIssues: [],
      recordCount: 5,
      contentDigest: 'a'.repeat(64),
      workflowErrors: [],
      // MISSING: artifactId, artifactVersion, artifactContent, provenance
    };
    const parsed = CurrentAffairsExportResponseSchema.safeParse(fakeExport);
    expect(parsed.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// ApprovalReceipt 独立单元测试
// ═══════════════════════════════════════════════════════════════
describe('ApprovalReceipt — security invariants', () => {
  it('receipt with valid digest and within TTL passes validation', () => {
    const receipt = makeReceipt();
    expect(isReceiptValid(receipt, receipt.contentDigest, NOW)).toBe(true);
  });

  it('receipt expired outside TTL fails validation', () => {
    const receipt = makeReceipt({ expiresAt: NOW - 1 });
    expect(isReceiptExpired(receipt, NOW)).toBe(true);
    expect(isReceiptValid(receipt, receipt.contentDigest, NOW)).toBe(false);
  });

  it('receipt with mismatched content digest fails validation', () => {
    const receipt = makeReceipt();
    expect(isReceiptValid(receipt, 'different-digest-64-chars-xxxxxxxxxxxxxxxxxxxxxxxxxxxx', NOW)).toBe(false);
  });

  it('rejected receipt (approved=false) fails validation', () => {
    const receipt = makeReceipt({ approved: false });
    expect(isReceiptValid(receipt, receipt.contentDigest, NOW)).toBe(false);
  });

  it('receipt fingerprint is unique per nonce', () => {
    const r1 = makeReceipt({ nonce: 'nonce-a' });
    const r2 = makeReceipt({ nonce: 'nonce-b' });
    expect(createReceiptFingerprint(r1)).not.toBe(createReceiptFingerprint(r2));
  });

  it('receipt schema rejects missing required fields', () => {
    const parsed = ApprovalReceiptSchema.safeParse({ receiptId: 'r1' });
    expect(parsed.success).toBe(false);
  });

  it('receipt schema rejects invalid contentDigest (wrong length)', () => {
    const parsed = ApprovalReceiptSchema.safeParse({ ...makeReceipt(), contentDigest: 'short' });
    expect(parsed.success).toBe(false);
  });

  it('receipt replay: same receipt used twice is detectable via fingerprint', () => {
    const receipt = makeReceipt();
    const fp = createReceiptFingerprint(receipt);
    // Same receipt → same fingerprint → replay detection possible
    expect(createReceiptFingerprint(receipt)).toBe(fp);
  });
});

// ═══════════════════════════════════════════════════════════════
// Repository-backed truth contracts
// ═══════════════════════════════════════════════════════════════
describe('CurrentAffairsRuntimeContract — unified decode', () => {
  it('research response ok shape passes strict decode', () => {
    const resp = {
      ok: true, version: 1, operationId: 'op-1',
      temporalCheckPassed: true, correctionReviewComplete: true,
      verifiedSourceCount: 2, rejectedSourceCount: 0,
      sourceCount: 2, factCount: 1,
      contentDigest: 'a'.repeat(64),
      sourceSnapshotDigest: 'b'.repeat(64),
      draft: true,
      readyForApproval: true,
      approved: false,
      exportReady: false,
      phase: 'approval',
      preview: { title: 'test', summary: 'summary', sections: [], sourceCount: 1, factCount: 1 },
      errors: [],
    };
    const decoded = decodeCurrentAffairsResearchResponse(resp);
    expect(decoded.ok).toBe(true);
  });

  it('export response without receipt is rejected', () => {
    const resp = { ok: true, artifactId: 'a1', artifactVersion: 1 };
    const parsed = CurrentAffairsExportResponseSchema.safeParse(resp);
    expect(parsed.success).toBe(false);
  });

  it('export response code for receipt_expired', () => {
    const resp = { ok: false, version: 1, operationId: 'op-err', code: 'receipt_expired' as const };
    const parsed = CurrentAffairsExportResponseSchema.safeParse(resp);
    expect(parsed.success).toBe(true);
    if (parsed.success && !parsed.data.ok) {
      expect(parsed.data.code).toBe('receipt_expired');
    }
  });
});
