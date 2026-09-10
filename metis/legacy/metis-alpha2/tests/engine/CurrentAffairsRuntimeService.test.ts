import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CurrentAffairsRuntimeService } from '../../electron/CurrentAffairsRuntimeService.js';
import { CurrentAffairsRepositoryService } from '../../engine/writing/CurrentAffairsRepositoryService.js';
import { CurrentAffairsApprovalStore } from '../../engine/writing/CurrentAffairsApprovalStore.js';
import { CurrentAffairsArtifactService, ProvenanceRecordSchema } from '../../engine/writing/CurrentAffairsArtifactService.js';
import { CurrentAffairsSessionState } from '../../engine/writing/CurrentAffairsSessionState.js';
import { generateReceiptSecret } from '../../engine/runtime/CurrentAffairsRuntimeContract.js';

const NOW = 1750000000000;
const OWNER = 'test-owner-001';
const ADAPTED = { id: 's1', projectId: 'proj-rts', title: '来源', kind: 'policy_document', authors: ['部委'], publishedAt: NOW-30*86400000, fetchedAt: NOW, url: 'https://gov.cn/s1', correctionState: 'clean', contentDigest: 'a'.repeat(64), deleted: false };

function makeRepoSource() {
  return { id: 's1', projectId: 'proj-rts', title: '来源', kind: 'policy_document', authors: ['部委'], publishedAt: NOW-30*86400000, fetchedAt: NOW, url: 'https://gov.cn/s1', correctionState: 'clean', contentDigest: 'a'.repeat(64), deleted: false };
}

describe('CurrentAffairsRuntimeService — canonical manifest', () => {
  let service: CurrentAffairsRuntimeService;
  let baseRoot: string;

  beforeEach(() => {
    baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-rts-'));
    service = new CurrentAffairsRuntimeService({
      repository: new CurrentAffairsRepositoryService({ getSource: () => makeRepoSource(), now: () => NOW }),
      approvalStore: new CurrentAffairsApprovalStore({ now: () => NOW, signingSecret: generateReceiptSecret() }),
      artifactService: new CurrentAffairsArtifactService(baseRoot),
      sessionState: new CurrentAffairsSessionState({ now: () => NOW }),
      receiptSecret: generateReceiptSecret(), now: () => NOW,
      getSource: () => ADAPTED,
      confirmApproval: async () => true,
    });
  });
  afterEach(() => { try { fs.rmSync(baseRoot, { recursive: true, force: true }); } catch { /* noop */ } });

  it('research with selected source IDs succeeds', async () => {
    const r = await service.research(OWNER, { projectId: 'proj-rts', workflowId: 'wf-rts', profileId: 'pf-rts', manifestVersion: 1, title: 'Test', selectedSourceIds: ['s1'] });
    expect(r.ok).toBe(true);
    expect(r.preview).toBeDefined();
  });

  it('research with unknown source fails', async () => {
    const svc2 = new CurrentAffairsRuntimeService({
      repository: new CurrentAffairsRepositoryService({ getSource: () => undefined, now: () => NOW }),
      approvalStore: new CurrentAffairsApprovalStore({ now: () => NOW, signingSecret: generateReceiptSecret() }),
      artifactService: new CurrentAffairsArtifactService(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-rts2-'))),
      sessionState: new CurrentAffairsSessionState({ now: () => NOW }),
      receiptSecret: generateReceiptSecret(), now: () => NOW,
      getSource: () => undefined,
      confirmApproval: async () => true,
    });
    const r = await svc2.research(OWNER, { projectId: 'p1', workflowId: 'w1', profileId: 'pf1', manifestVersion: 1, title: 'T', selectedSourceIds: ['s-unknown'] });
    expect(r.ok).toBe(false);
  });

  it('approve without research fails', async () => {
    const r = await service.approve(OWNER, { projectId: 'proj-rts', workflowId: 'wf-rts', profileId: 'pf-rts', manifestVersion: 1, contentDigest: 'a'.repeat(64), sourceSnapshotDigest: 'b'.repeat(64) });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_pending_research');
  });

  it('full chain research→approve', async () => {
    const r = await service.research(OWNER, { projectId: 'proj-rts', workflowId: 'wf-rts', profileId: 'pf-rts', manifestVersion: 1, title: 'Test', selectedSourceIds: ['s1'] });
    expect(r.ok).toBe(true);
    const a = await service.approve(OWNER, { projectId: 'proj-rts', workflowId: 'wf-rts', profileId: 'pf-rts', manifestVersion: 1, contentDigest: r.contentDigest!, sourceSnapshotDigest: r.sourceSnapshotDigest! });
    expect(a.ok).toBe(true);
  });

  it('cancel discard_draft without prior research returns no_pending_context', () => {
    const r = service.cancel(OWNER, { action: 'discard_draft', projectId: 'proj-rts', workflowId: 'wf-rts' });
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('no_pending_context');
  });

  it('clearOwner allows re-approval', async () => {
    const r1 = await service.research(OWNER, { projectId: 'proj-rts', workflowId: 'wf-rts', profileId: 'pf-rts', manifestVersion: 1, title: 'Test', selectedSourceIds: ['s1'] });
    expect(r1.ok).toBe(true);
    await service.approve(OWNER, { projectId: 'proj-rts', workflowId: 'wf-rts', profileId: 'pf-rts', manifestVersion: 1, contentDigest: r1.contentDigest!, sourceSnapshotDigest: r1.sourceSnapshotDigest! });
    service.clearOwner(OWNER);
    const r2 = await service.research(OWNER, { projectId: 'proj-rts', workflowId: 'wf-rts', profileId: 'pf-rts', manifestVersion: 1, title: 'Test', selectedSourceIds: ['s1'] });
    expect(r2.ok).toBe(true);
    const a2 = await service.approve(OWNER, { projectId: 'proj-rts', workflowId: 'wf-rts', profileId: 'pf-rts', manifestVersion: 1, contentDigest: r2.contentDigest!, sourceSnapshotDigest: r2.sourceSnapshotDigest! });
    expect(a2.ok).toBe(true);
  });

  it('clearOwner(OWNER) does not clear OWNER_B context (isolation)', async () => {
    const OWNER_B = 'test-owner-002';
    // Set up both owners
    const rA = await service.research(OWNER, { projectId: 'proj-rts', workflowId: 'wf-rts', profileId: 'pf-rts', manifestVersion: 1, title: 'Test A', selectedSourceIds: ['s1'] });
    expect(rA.ok).toBe(true);
    await service.approve(OWNER, { projectId: 'proj-rts', workflowId: 'wf-rts', profileId: 'pf-rts', manifestVersion: 1, contentDigest: rA.contentDigest!, sourceSnapshotDigest: rA.sourceSnapshotDigest! });

    const rB = await service.research(OWNER_B, { projectId: 'proj-rts', workflowId: 'wf-rts-b', profileId: 'pf-rts', manifestVersion: 1, title: 'Test B', selectedSourceIds: ['s1'] });
    expect(rB.ok).toBe(true);

    // Clear OWNER only — OWNER_B context survives
    service.clearOwner(OWNER);

    // OWNER context is gone
    const aAfter = await service.approve(OWNER, { projectId: 'proj-rts', workflowId: 'wf-rts', profileId: 'pf-rts', manifestVersion: 1, contentDigest: rA.contentDigest!, sourceSnapshotDigest: rA.sourceSnapshotDigest! });
    expect(aAfter.ok).toBe(false); // cleared

    // OWNER_B context still alive
    const bAfter = await service.approve(OWNER_B, { projectId: 'proj-rts', workflowId: 'wf-rts-b', profileId: 'pf-rts', manifestVersion: 1, contentDigest: rB.contentDigest!, sourceSnapshotDigest: rB.sourceSnapshotDigest! });
    expect(bAfter.ok).toBe(true); // NOT cleared
  });

  it('full chain research→approve→export with readArtifact provenance & replay rejection', async () => {
    const wf = 'wf-export'; const pf = 'pf-export'; const title = 'Export Test';
    const r = await service.research(OWNER, { projectId: 'proj-rts', workflowId: wf, profileId: pf, manifestVersion: 1, title, selectedSourceIds: ['s1'] });
    expect(r.ok).toBe(true);
    const a = await service.approve(OWNER, { projectId: 'proj-rts', workflowId: wf, profileId: pf, manifestVersion: 1, contentDigest: r.contentDigest!, sourceSnapshotDigest: r.sourceSnapshotDigest! });
    expect(a.ok).toBe(true);
    const receiptId = a.receipt!.receiptId;
    const receiptNonce = a.receipt!.nonce;

    // First export — must succeed
    const e1 = await service.export(OWNER, { projectId: 'proj-rts', workflowId: wf, receiptId, receiptNonce, contentDigest: r.contentDigest!, sourceSnapshotDigest: r.sourceSnapshotDigest! });
    expect(e1.ok).toBe(true);
    expect(e1.artifactId).toBeTruthy();

    // Verify via readArtifact
    const artifactSvc = new CurrentAffairsArtifactService(baseRoot);
    const readback = artifactSvc.readArtifact(e1.artifactId!, e1.artifactVersion!);
    expect(readback.ok).toBe(true);
    expect(readback.manifestDigest).toBe(e1.contentDigest);
    expect(readback.files.length).toBeGreaterThan(0);

    // Verify provenance with strict schema
    const provPath = path.join(baseRoot, e1.artifactId!, `v${e1.artifactVersion}`, 'provenance.json');
    const provResult = ProvenanceRecordSchema.safeParse(JSON.parse(fs.readFileSync(provPath, 'utf-8')));
    expect(provResult.success).toBe(true);
    if (provResult.success) {
      expect(provResult.data.receiptId).toBe(receiptId);
      expect(provResult.data.manifestDigest).toBe(e1.contentDigest);
      expect(provResult.data.artifactId).toBe(e1.artifactId);
    }

    // Replay: re-research same wf/pf/title rebuilds context; export old receipt
    const r2 = await service.research(OWNER, { projectId: 'proj-rts', workflowId: wf, profileId: pf, manifestVersion: 1, title, selectedSourceIds: ['s1'] });
    expect(r2.ok).toBe(true);
    // Direct export with old consumed receipt — context not_approved (no approve step for r2)
    const e2 = await service.export(OWNER, { projectId: 'proj-rts', workflowId: wf, receiptId, receiptNonce, contentDigest: r2.contentDigest!, sourceSnapshotDigest: r2.sourceSnapshotDigest! });
    expect(e2.ok).toBe(false);
    expect(e2.code).toBe('not_approved'); // correct: context not yet approved
    // No new version created
    expect(fs.readdirSync(path.join(baseRoot, e1.artifactId!)).length).toBe(1); // only v1

    // Store-level: consumed receipt replay independently blocked (defense-in-depth)
    const approvalStore = new CurrentAffairsApprovalStore({ now: () => NOW, signingSecret: generateReceiptSecret() });
    const issueR = approvalStore.issue({ projectId: 'proj-rts', workflowId: wf, profileId: pf, manifestVersion: 1, ownerSessionId: OWNER, contentDigest: r.contentDigest!, sourceSnapshotDigest: r.sourceSnapshotDigest! });
    expect(issueR.ok).toBe(true);
    const resR = approvalStore.reserveForExport({ receiptId: issueR.receipt.receiptId, nonce: issueR.receipt.nonce, projectId: 'proj-rts', workflowId: wf, profileId: pf, manifestVersion: 1, ownerSessionId: OWNER, contentDigest: r.contentDigest!, sourceSnapshotDigest: r.sourceSnapshotDigest! });
    expect(resR.ok).toBe(true);
    approvalStore.commitExport(resR.token);
    const reRes = approvalStore.reserveForExport({ receiptId: issueR.receipt.receiptId, nonce: issueR.receipt.nonce, projectId: 'proj-rts', workflowId: wf, profileId: pf, manifestVersion: 1, ownerSessionId: OWNER, contentDigest: r.contentDigest!, sourceSnapshotDigest: r.sourceSnapshotDigest! });
    expect(reRes.ok).toBe(false);
    expect(reRes.code).toBe('receipt_replayed');
    // No new version created
    expect(fs.readdirSync(path.join(baseRoot, e1.artifactId!)).length).toBe(1); // only v1
  });
});

describe('verifyStaged — ArtifactService staging validation', () => {
  it('clean staging passes verification', () => {
    const baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-vs-'));
    const svc = new CurrentAffairsArtifactService(baseRoot);
    try {
      const stagingDir = path.join(baseRoot, '.tmp-clean');
      fs.mkdirSync(stagingDir);
      const content = '# Report';
      fs.writeFileSync(path.join(stagingDir, 'report.md'), content, 'utf-8');
      const hash = createHash('sha256').update(content).digest('hex');
      const prov = { artifactId: 'a1', artifactVersion: 1, manifestDigest: 'a'.repeat(64), receiptId: 'r1', createdAt: Date.now(), createdBy: 'test', files: [{ name: 'report.md', size: content.length, sha256: hash }] };
      fs.writeFileSync(path.join(stagingDir, 'provenance.json'), JSON.stringify(prov), 'utf-8');

      const r = svc.verifyStaged(stagingDir, { artifactId: 'a1', artifactVersion: 1, manifestDigest: 'a'.repeat(64), receiptId: 'r1', files: [{ name: 'report.md', size: content.length, sha256: hash }] });
      expect(r.ok).toBe(true);
    } finally { try { fs.rmSync(baseRoot, { recursive: true, force: true }); } catch { /* cleanup */ } }
  });

  it('tampered manifestDigest in provenance → verifyStaged fails', () => {
    const baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-td-'));
    const svc = new CurrentAffairsArtifactService(baseRoot);
    try {
      const stagingDir = path.join(baseRoot, '.tmp-tamper');
      fs.mkdirSync(stagingDir);
      const content = '# Report';
      fs.writeFileSync(path.join(stagingDir, 'report.md'), content, 'utf-8');
      const hash = createHash('sha256').update(content).digest('hex');
      // Tampered: manifestDigest doesn't match expected
      const prov = { artifactId: 'a1', artifactVersion: 1, manifestDigest: 'f'.repeat(64), receiptId: 'r1', createdAt: Date.now(), createdBy: 'test', files: [{ name: 'report.md', size: content.length, sha256: hash }] };
      fs.writeFileSync(path.join(stagingDir, 'provenance.json'), JSON.stringify(prov), 'utf-8');

      const r = svc.verifyStaged(stagingDir, { artifactId: 'a1', artifactVersion: 1, manifestDigest: 'a'.repeat(64), receiptId: 'r1', files: [{ name: 'report.md', size: content.length, sha256: hash }] });
      expect(r.ok).toBe(false);
      expect((r as { code: string }).code).toBe('provenance_digest_mismatch');
    } finally { try { fs.rmSync(baseRoot, { recursive: true, force: true }); } catch { /* cleanup */ } }
  });

  it('extra payload file not in provenance → verifyStaged fails', () => {
    const baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ex-'));
    const svc = new CurrentAffairsArtifactService(baseRoot);
    try {
      const stagingDir = path.join(baseRoot, '.tmp-extra');
      fs.mkdirSync(stagingDir);
      const content = '# Report';
      fs.writeFileSync(path.join(stagingDir, 'report.md'), content, 'utf-8');
      fs.writeFileSync(path.join(stagingDir, 'extra.txt'), 'bonus', 'utf-8'); // NOT in provenance
      const hash = createHash('sha256').update(content).digest('hex');
      const prov = { artifactId: 'a1', artifactVersion: 1, manifestDigest: 'a'.repeat(64), receiptId: 'r1', createdAt: Date.now(), createdBy: 'test', files: [{ name: 'report.md', size: content.length, sha256: hash }] };
      fs.writeFileSync(path.join(stagingDir, 'provenance.json'), JSON.stringify(prov), 'utf-8');

      const r = svc.verifyStaged(stagingDir, { artifactId: 'a1', artifactVersion: 1, manifestDigest: 'a'.repeat(64), receiptId: 'r1', files: [{ name: 'report.md', size: content.length, sha256: hash }] });
      expect(r.ok).toBe(false);
      expect((r as { code: string }).code).toBe('staging_file_count_mismatch');
    } finally { try { fs.rmSync(baseRoot, { recursive: true, force: true }); } catch { /* cleanup */ } }
  });

  it('missing provenance.json → verifyStaged fails', () => {
    const baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-np-'));
    const svc = new CurrentAffairsArtifactService(baseRoot);
    try {
      const stagingDir = path.join(baseRoot, '.tmp-noprov');
      fs.mkdirSync(stagingDir);
      fs.writeFileSync(path.join(stagingDir, 'report.md'), '# R', 'utf-8');
      const r = svc.verifyStaged(stagingDir, { artifactId: 'a1', artifactVersion: 1, manifestDigest: 'a'.repeat(64), receiptId: 'r1', files: [] });
      expect(r.ok).toBe(false);
      expect((r as { code: string }).code).toBe('provenance_missing');
    } finally { try { fs.rmSync(baseRoot, { recursive: true, force: true }); } catch { /* cleanup */ } }
  });

  it('invalid provenance JSON → verifyStaged fails', () => {
    const baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ij-'));
    const svc = new CurrentAffairsArtifactService(baseRoot);
    try {
      const stagingDir = path.join(baseRoot, '.tmp-invalid');
      fs.mkdirSync(stagingDir);
      fs.writeFileSync(path.join(stagingDir, 'provenance.json'), '{broken', 'utf-8');
      const r = svc.verifyStaged(stagingDir, { artifactId: 'a1', artifactVersion: 1, manifestDigest: 'a'.repeat(64), receiptId: 'r1', files: [] });
      expect(r.ok).toBe(false);
      expect((r as { code: string }).code).toBe('provenance_invalid');
    } finally { try { fs.rmSync(baseRoot, { recursive: true, force: true }); } catch { /* cleanup */ } }
  });

  it('staging dir outside baseRoot → rejected', () => {
    const baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-out-'));
    const svc = new CurrentAffairsArtifactService(baseRoot);
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-outside-'));
    try {
      fs.writeFileSync(path.join(outsideDir, 'provenance.json'), JSON.stringify({ artifactId: 'a1', artifactVersion: 1, manifestDigest: 'a'.repeat(64), receiptId: 'r1', createdAt: 1, createdBy: 't', files: [] }), 'utf-8');
      const r = svc.verifyStaged(outsideDir, { artifactId: 'a1', artifactVersion: 1, manifestDigest: 'a'.repeat(64), receiptId: 'r1', files: [] });
      expect(r.ok).toBe(false);
      expect(['staging_outside_root', 'verify_failed']).toContain((r as { code: string }).code);
    } finally {
      try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch { /* cleanup */ }
      try { fs.rmSync(baseRoot, { recursive: true, force: true }); } catch { /* cleanup */ }
    }
  });

  it('staging dir is symlink/junction → rejected', () => {
    const baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-sym-'));
    const svc = new CurrentAffairsArtifactService(baseRoot);
    const realDir = path.join(baseRoot, '.real-staging');
    fs.mkdirSync(realDir);
    const linkPath = path.join(baseRoot, '.linked-staging');
    try {
      // Windows: use junction (no admin required); POSIX: use symlink
      if (process.platform === 'win32') fs.symlinkSync(realDir, linkPath, 'junction');
      else fs.symlinkSync(realDir, linkPath, 'dir');
      fs.writeFileSync(path.join(realDir, 'provenance.json'), JSON.stringify({ artifactId: 'a1', artifactVersion: 1, manifestDigest: 'a'.repeat(64), receiptId: 'r1', createdAt: 1, createdBy: 't', files: [] }), 'utf-8');
      const r = svc.verifyStaged(linkPath, { artifactId: 'a1', artifactVersion: 1, manifestDigest: 'a'.repeat(64), receiptId: 'r1', files: [] });
      expect(r.ok).toBe(false);
      expect((r as { code: string }).code).toBe('staging_symlink');
    } finally { try { fs.rmSync(baseRoot, { recursive: true, force: true }); } catch { /* cleanup */ } }
  });

  it('payload file is symlink → rejected', () => {
    const baseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-psym-'));
    const svc = new CurrentAffairsArtifactService(baseRoot);
    const stagingDir = path.join(baseRoot, '.staging');
    fs.mkdirSync(stagingDir);
    const realPayload = path.join(baseRoot, 'real-report.md');
    fs.writeFileSync(realPayload, '# Report', 'utf-8');
    const payloadHash = createHash('sha256').update(fs.readFileSync(realPayload)).digest('hex');
    try {
      try { fs.symlinkSync(realPayload, path.join(stagingDir, 'report.md'), 'file'); } catch (e: unknown) {
        if ((e as { code?: string }).code === 'EPERM') return; // Windows admin required for file symlinks
        throw e;
      }
      const prov = { artifactId: 'a1', artifactVersion: 1, manifestDigest: 'a'.repeat(64), receiptId: 'r1', createdAt: Date.now(), createdBy: 'test', files: [{ name: 'report.md', size: fs.statSync(realPayload).size, sha256: payloadHash }] };
      fs.writeFileSync(path.join(stagingDir, 'provenance.json'), JSON.stringify(prov), 'utf-8');
      const r = svc.verifyStaged(stagingDir, { artifactId: 'a1', artifactVersion: 1, manifestDigest: 'a'.repeat(64), receiptId: 'r1', files: [{ name: 'report.md', size: fs.statSync(realPayload).size, sha256: payloadHash }] });
      expect(r.ok).toBe(false);
      expect((r as { code: string }).code).toBe('non_file_in_staging');
    } finally { try { fs.rmSync(baseRoot, { recursive: true, force: true }); } catch { /* cleanup */ } }
  });
});

describe('finalizeExport transactional', () => {
  const OWNER = 'test-owner-003';

  it('publishCallback succeeds → receipt consumed, receipt not consumed before', () => {
    const approvalStore = new CurrentAffairsApprovalStore({ now: () => NOW, signingSecret: generateReceiptSecret() });
    const issueResult = approvalStore.issue({ projectId: 'p', workflowId: 'w', profileId: 'pf', manifestVersion: 1, ownerSessionId: OWNER, contentDigest: 'a'.repeat(64), sourceSnapshotDigest: 'b'.repeat(64) });
    expect(issueResult.ok).toBe(true);
    const reserve = approvalStore.reserveForExport({ receiptId: issueResult.receipt.receiptId, nonce: issueResult.receipt.nonce, projectId: 'p', workflowId: 'w', profileId: 'pf', manifestVersion: 1, ownerSessionId: OWNER, contentDigest: 'a'.repeat(64), sourceSnapshotDigest: 'b'.repeat(64) });
    expect(reserve.ok).toBe(true);

    // Before finalize: not consumed
    expect(approvalStore.getStatus(issueResult.receipt.receiptId).consumed).toBe(false);

    let callbackCalled = false;
    const result = approvalStore.finalizeExport(reserve.token, () => { callbackCalled = true; });
    expect(callbackCalled).toBe(true);
    expect(result.ok).toBe(true);

    // After finalize: consumed
    expect(approvalStore.getStatus(issueResult.receipt.receiptId).consumed).toBe(true);
  });

  it('publishCallback throws → reservation stays active, receipt NOT consumed, can retry', () => {
    const approvalStore = new CurrentAffairsApprovalStore({ now: () => NOW, signingSecret: generateReceiptSecret() });
    const issueResult = approvalStore.issue({ projectId: 'p', workflowId: 'w', profileId: 'pf', manifestVersion: 1, ownerSessionId: OWNER, contentDigest: 'a'.repeat(64), sourceSnapshotDigest: 'b'.repeat(64) });
    expect(issueResult.ok).toBe(true);
    const reserve = approvalStore.reserveForExport({ receiptId: issueResult.receipt.receiptId, nonce: issueResult.receipt.nonce, projectId: 'p', workflowId: 'w', profileId: 'pf', manifestVersion: 1, ownerSessionId: OWNER, contentDigest: 'a'.repeat(64), sourceSnapshotDigest: 'b'.repeat(64) });
    expect(reserve.ok).toBe(true);

    // finalizeExport with throwing callback
    let callbackCalled = false;
    const result = approvalStore.finalizeExport(reserve.token, () => {
      callbackCalled = true;
      throw new Error('Simulated publish failure');
    });
    expect(callbackCalled).toBe(true);
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('publish_failed');

    // Receipt NOT consumed — critical invariant
    const status = approvalStore.getStatus(issueResult.receipt.receiptId);
    expect(status.consumed).toBe(false);
    expect(status.exists).toBe(true);

    // Can release reservation and retry — no orphaned consumed receipt
    const released = approvalStore.releaseReservation(reserve.token);
    expect(released.ok).toBe(true);
    const reReserve = approvalStore.reserveForExport({ receiptId: issueResult.receipt.receiptId, nonce: issueResult.receipt.nonce, projectId: 'p', workflowId: 'w', profileId: 'pf', manifestVersion: 1, ownerSessionId: OWNER, contentDigest: 'a'.repeat(64), sourceSnapshotDigest: 'b'.repeat(64) });
    expect(reReserve.ok).toBe(true);
  });

  it('finalizeExport with invalid token returns token_invalid', () => {
    const approvalStore = new CurrentAffairsApprovalStore({ now: () => NOW, signingSecret: generateReceiptSecret() });
    const result = approvalStore.finalizeExport('nonexistent-token', () => { /* noop */ });
    expect(result.ok).toBe(false);
    expect((result as { code: string }).code).toBe('token_invalid');
  });

  it('finalizeExport fails after token already consumed (no double-consume)', () => {
    const approvalStore = new CurrentAffairsApprovalStore({ now: () => NOW, signingSecret: generateReceiptSecret() });
    const issueResult = approvalStore.issue({ projectId: 'p', workflowId: 'w', profileId: 'pf', manifestVersion: 1, ownerSessionId: OWNER, contentDigest: 'a'.repeat(64), sourceSnapshotDigest: 'b'.repeat(64) });
    expect(issueResult.ok).toBe(true);
    const reserve = approvalStore.reserveForExport({ receiptId: issueResult.receipt.receiptId, nonce: issueResult.receipt.nonce, projectId: 'p', workflowId: 'w', profileId: 'pf', manifestVersion: 1, ownerSessionId: OWNER, contentDigest: 'a'.repeat(64), sourceSnapshotDigest: 'b'.repeat(64) });
    expect(reserve.ok).toBe(true);

    // First finalize succeeds
    const r1 = approvalStore.finalizeExport(reserve.token, () => { /* noop */ });
    expect(r1.ok).toBe(true);
    expect(approvalStore.getStatus(issueResult.receipt.receiptId).consumed).toBe(true);

    // Second call with same (now-consumed) token fails
    const r2 = approvalStore.finalizeExport(reserve.token, () => { /* noop */ });
    expect(r2.ok).toBe(false);
    expect((r2 as { code: string }).code).toBe('token_invalid');
  });
});
