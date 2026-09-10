import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CurrentAffairsRuntimeService } from '../../electron/CurrentAffairsRuntimeService.js';
import {
  CA_RUNTIME_CONTRACT_VERSION,
  CurrentAffairsApproveResponseSchema,
  CurrentAffairsCancelResponseSchema,
  CurrentAffairsExportResponseSchema,
  CurrentAffairsResearchResponseSchema,
  generateReceiptSecret,
} from '../../engine/runtime/CurrentAffairsRuntimeContract.js';
import { CurrentAffairsApprovalStore } from '../../engine/writing/CurrentAffairsApprovalStore.js';
import { CurrentAffairsArtifactService } from '../../engine/writing/CurrentAffairsArtifactService.js';
import { CurrentAffairsRepositoryService } from '../../engine/writing/CurrentAffairsRepositoryService.js';
import { CurrentAffairsSessionState } from '../../engine/writing/CurrentAffairsSessionState.js';

const NOW = 1_750_000_000_000;
const OWNER = 'renderer-owner-1';
const PROJECT = 'project-envelope';
const SOURCE_HASH = 'a'.repeat(64);

function source() {
  return {
    id: 'source-envelope', projectId: PROJECT, title: 'Canonical source',
    kind: 'policy_document', authors: ['Author'], publishedAt: NOW - 86_400_000,
    fetchedAt: NOW, updatedAt: NOW, url: 'https://example.test/source',
    correctionState: 'clean', contentDigest: SOURCE_HASH, deleted: false,
  };
}

describe('CurrentAffairs Runtime → main envelope → strict renderer contract', () => {
  let root: string;
  let service: CurrentAffairsRuntimeService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-envelope-'));
    const secret = generateReceiptSecret();
    service = new CurrentAffairsRuntimeService({
      repository: new CurrentAffairsRepositoryService({ getSource: (id) => id === 'source-envelope' ? source() : undefined, now: () => NOW }),
      approvalStore: new CurrentAffairsApprovalStore({ now: () => NOW, signingSecret: secret }),
      artifactService: new CurrentAffairsArtifactService(root),
      sessionState: new CurrentAffairsSessionState({ now: () => NOW }),
      receiptSecret: secret,
      now: () => NOW,
      getSource: (id) => id === 'source-envelope' ? source() : undefined,
      confirmApproval: async () => true,
    });
  });

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* cleanup */ }
  });

  it('round-trips the complete successful research, approval and export chain', async () => {
    const research = await service.research(OWNER, {
      projectId: PROJECT, workflowId: 'workflow-envelope', profileId: 'profile-envelope',
      manifestVersion: 1, title: 'Envelope report', selectedSourceIds: ['source-envelope'],
    });
    const researchEnvelope = { ...research, version: CA_RUNTIME_CONTRACT_VERSION, operationId: 'op-research-envelope' };
    expect(CurrentAffairsResearchResponseSchema.safeParse(researchEnvelope).success).toBe(true);
    if (!research.ok) throw new Error('research failed');

    const approval = await service.approve(OWNER, {
      projectId: PROJECT, workflowId: 'workflow-envelope', profileId: 'profile-envelope', manifestVersion: 1,
      contentDigest: research.contentDigest!, sourceSnapshotDigest: research.sourceSnapshotDigest!,
    });
    const approvalEnvelope = { ...approval, version: CA_RUNTIME_CONTRACT_VERSION, operationId: 'op-approve-envelope' };
    expect(CurrentAffairsApproveResponseSchema.safeParse(approvalEnvelope).success).toBe(true);
    if (!approval.ok || !approval.receipt) throw new Error('approval failed');

    const exported = await service.export(OWNER, {
      projectId: PROJECT, workflowId: 'workflow-envelope',
      receiptId: approval.receipt.receiptId, receiptNonce: approval.receipt.nonce,
      contentDigest: research.contentDigest!, sourceSnapshotDigest: research.sourceSnapshotDigest!,
    });
    const exportEnvelope = { ...exported, version: CA_RUNTIME_CONTRACT_VERSION, operationId: 'op-export-envelope' };
    expect(CurrentAffairsExportResponseSchema.safeParse(exportEnvelope).success).toBe(true);
    expect(exported.ok).toBe(true);
  });

  it('round-trips a strict cancel failure instead of relying on decoder recovery', () => {
    const cancelled = service.cancel(OWNER, {
      action: 'discard_draft', projectId: PROJECT, workflowId: 'missing-workflow',
    });
    const envelope = { ...cancelled, version: CA_RUNTIME_CONTRACT_VERSION, operationId: 'op-cancel-envelope' };
    expect(CurrentAffairsCancelResponseSchema.safeParse(envelope).success).toBe(true);
  });

  it('round-trips approved-discard and forged-revoke failures with their real codes', async () => {
    const research = await service.research(OWNER, {
      projectId: PROJECT, workflowId: 'workflow-cancel', profileId: 'profile-cancel',
      manifestVersion: 1, title: 'Cancel report', selectedSourceIds: ['source-envelope'],
    });
    if (!research.ok) throw new Error('research failed');
    const approval = await service.approve(OWNER, {
      projectId: PROJECT, workflowId: 'workflow-cancel', profileId: 'profile-cancel', manifestVersion: 1,
      contentDigest: research.contentDigest!, sourceSnapshotDigest: research.sourceSnapshotDigest!,
    });
    if (!approval.ok || !approval.receipt) throw new Error('approval failed');

    const discard = service.cancel(OWNER, {
      action: 'discard_draft', projectId: PROJECT, workflowId: 'workflow-cancel',
    });
    expect(discard).toEqual({ ok: false, code: 'already_approved_use_revoke' });
    expect(CurrentAffairsCancelResponseSchema.safeParse({
      ...discard, version: CA_RUNTIME_CONTRACT_VERSION, operationId: 'op-discard-approved',
    }).success).toBe(true);

    const forged = service.cancel(OWNER, {
      action: 'revoke_approval', projectId: PROJECT, workflowId: 'workflow-cancel',
      profileId: 'profile-cancel', manifestVersion: 1,
      contentDigest: research.contentDigest!, sourceSnapshotDigest: research.sourceSnapshotDigest!,
      receiptId: approval.receipt.receiptId, receiptNonce: 'wrong-nonce',
    });
    expect(forged).toEqual({ ok: false, code: 'receipt_validation_failed' });
    expect(CurrentAffairsCancelResponseSchema.safeParse({
      ...forged, version: CA_RUNTIME_CONTRACT_VERSION, operationId: 'op-revoke-forged',
    }).success).toBe(true);
  });

  it('round-trips ordinary research, approval and export failures without decoder recovery', async () => {
    const research = await service.research(OWNER, {
      projectId: PROJECT, workflowId: 'workflow-missing-source', profileId: 'profile-missing-source',
      manifestVersion: 1, title: 'Missing source', selectedSourceIds: ['missing-source'],
    });
    expect(research.ok).toBe(false);
    expect(CurrentAffairsResearchResponseSchema.safeParse({
      ...research, version: CA_RUNTIME_CONTRACT_VERSION, operationId: 'op-research-failure',
    }).success).toBe(true);

    const approval = await service.approve(OWNER, {
      projectId: PROJECT, workflowId: 'workflow-no-context', profileId: 'profile-no-context',
      manifestVersion: 1, contentDigest: SOURCE_HASH, sourceSnapshotDigest: SOURCE_HASH,
    });
    expect(approval.ok).toBe(false);
    expect(CurrentAffairsApproveResponseSchema.safeParse({
      ...approval, version: CA_RUNTIME_CONTRACT_VERSION, operationId: 'op-approval-failure',
    }).success).toBe(true);

    const exported = await service.export(OWNER, {
      projectId: PROJECT, workflowId: 'workflow-no-context',
      receiptId: 'missing-receipt', receiptNonce: 'missing-nonce',
      contentDigest: SOURCE_HASH, sourceSnapshotDigest: SOURCE_HASH,
    });
    expect(exported.ok).toBe(false);
    expect(CurrentAffairsExportResponseSchema.safeParse({
      ...exported, version: CA_RUNTIME_CONTRACT_VERSION, operationId: 'op-export-failure',
    }).success).toBe(true);
  });

  it('preserves the typed recovery identity for a visibility-uncertain export', () => {
    const uncertain = {
      ok: false as const,
      version: CA_RUNTIME_CONTRACT_VERSION,
      operationId: 'op-export-uncertain',
      code: 'visibility_uncertain' as const,
      artifactId: 'artifact-recovery',
      artifactVersion: 1,
    };
    expect(CurrentAffairsExportResponseSchema.safeParse(uncertain).success).toBe(true);
  });
});
