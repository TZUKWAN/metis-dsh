/**
 * METIS-601 ~ 607 — Artifact Runtime tests.
 *
 * 601: manifest validation + canBeVerified (no sources → not verifiable).
 * 602: store atomic put / versioning / soft-delete / restore.
 * 603: provenance chain lineage + downstream-stale propagation.
 * 604: version diff (text + structural).
 * 605: selection bridge always carries containerId + objectId.
 * 606: viewer registry resolution + fallback + safe-load.
 * 607: review status computation (stale/partial/verified) + reliability gate.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { parseArtifactManifest, canBeVerified, effectiveArtifactReviewStatus, prepareArtifactManifestForRestore, type ArtifactManifest } from './ArtifactManifest.js';
import { bindDeliverableProfile } from '../writing/DeliverableProfile.js';
import { InMemoryArtifactStore, createProvenanceChain } from './ArtifactStore.js';
import { computeReviewStatus, isReliable, diffVersions } from './ArtifactReview.js';
import { buildAskFromSelection, registerViewer, resolveViewer, safeLoadViewer, resetViewerRegistry } from './SelectionBridge.js';

function makeManifest(over: Partial<ArtifactManifest> = {}): ArtifactManifest {
  const now = Date.now();
  const attestation = {
    sourceId: 's1', citationKeys: ['s1'], identifierType: 'doi' as const, identifier: '10.1234/example',
    locator: 'p. 1', triangulation: 'VERIFIED' as const, passport: 'verified' as const,
    retraction: 'clear' as const, journalIntegrity: 'trusted' as const, checkedAt: now,
  };
  return {
    id: 'a1', projectId: 'p1', title: 'T', artifactType: 'manuscript', reviewStatus: 'draft',
    inputs: [{ kind: 'claim', id: 'c1' }],
    generatedBy: { capabilityId: 'argumentation-writing', method: 'draft' },
    citedSourceIds: ['s1'],
    deliverableProfile: bindDeliverableProfile('sci'),
    deliverableContext: {
      templateId: 'sci-journal-author-guidelines', templateSourceId: 'template-source', contentFormat: 'markdown', citationStyle: 'apa',
      venueRuleSourceId: 'venue-rules', schoolRuleSourceId: null,
    },
    deliverableCompliance: {
      schemaVersion: 1, checkedAt: now, profileId: 'sci', templateId: 'sci-journal-author-guidelines', templateSourceId: 'template-source',
      contentFormat: 'markdown', citationStyle: 'apa', sourceIds: ['s1'],
      approvalDecisionIds: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'],
      approvalArtifactVersion: 1, contentDigest: 'c'.repeat(64),
    },
    citationRequests: [{ sourceId: 's1', locator: 'p. 1' }],
    citationTruthReceipts: [{
      schemaVersion: 1, issuer: 'metis-main', receiptId: `ctr_${'a'.repeat(32)}`, nonce: 'b'.repeat(32),
      projectId: 'p1', artifactId: 'a1', artifactVersion: 1, contentDigest: 'c'.repeat(64),
      sourceId: 's1', sourceSnapshotDigest: 'd'.repeat(64), attestation,
      referenceValidatedAt: now, issuedAt: now, expiresAt: now + 60_000, signature: 'e'.repeat(64),
    }],
    renderer: { kind: 'markdown', contentRef: 'ref1' },
    reviewTrail: [],
    version: 1, createdAt: now, updatedAt: now,
    ...over,
  };
}

// ── METIS-601 ──
describe('METIS-601 ArtifactManifest', () => {
  it('parses a valid manifest', () => {
    expect(parseArtifactManifest(makeManifest()).success).toBe(true);
  });
  it('rejects a manifest missing generatedBy', () => {
    const m = makeManifest() as unknown as Record<string, unknown>; delete m.generatedBy;
    expect(parseArtifactManifest(m).success).toBe(false);
  });
  it('rejects an unknown artifactType', () => {
    expect(parseArtifactManifest({ ...makeManifest(), artifactType: 'hologram' }).success).toBe(false);
  });
  it('canBeVerified is false when there are NO cited sources (METIS-601)', () => {
    const r = canBeVerified({ ...makeManifest(), citedSourceIds: [] });
    expect(r.ok).toBe(false);
  });
  it('canBeVerified is true with sources + inputs', () => {
    expect(canBeVerified(makeManifest(), { receiptVerified: true, profileEnforced: true }).ok).toBe(true);
  });
  it('keeps legacy unprofiled artifacts readable but treats them as draft/unverified', () => {
    const legacy = { ...makeManifest(), reviewStatus: 'verified' as const };
    delete (legacy as Partial<ArtifactManifest>).deliverableProfile;
    delete (legacy as Partial<ArtifactManifest>).citationTruthReceipts;
    expect(parseArtifactManifest(legacy).success).toBe(true);
    expect(canBeVerified(legacy).ok).toBe(false);
    expect(effectiveArtifactReviewStatus(legacy)).toBe('draft');
  });
  it('blocks verified status when retraction/passport/journal truth is not clear', () => {
    const manifest = makeManifest({
      citationTruthReceipts: [{
        ...makeManifest().citationTruthReceipts![0]!,
        attestation: { ...makeManifest().citationTruthReceipts![0]!.attestation, retraction: 'retracted' },
      }],
    });
    expect(canBeVerified(manifest, { receiptVerified: true, profileEnforced: true }).ok).toBe(false);
  });
  it('restoring an old verified version strips version-bound trust and returns it to draft', () => {
    const restored = prepareArtifactManifestForRestore({ ...makeManifest(), reviewStatus: 'verified' });
    expect(restored?.reviewStatus).toBe('draft');
    expect(restored?.citationTruthReceipts).toBeUndefined();
    expect(restored?.deliverableCompliance).toBeUndefined();
  });
});

// ── METIS-602 ──
describe('METIS-602 ArtifactStore', () => {
  it('puts and gets atomically', () => {
    const s = new InMemoryArtifactStore();
    s.putAtomic('a1', makeManifest(), '内容');
    expect(s.get('a1')?.content).toBe('内容');
  });
  it('saveVersion preserves old versions (no overwrite)', () => {
    const s = new InMemoryArtifactStore();
    s.putAtomic('a1', makeManifest(), 'v1内容');
    s.saveVersion('a1', makeManifest(), 'v2内容');
    expect(s.listVersions('a1')).toEqual([1, 2]);
    expect(s.get('a1')?.content).toBe('v2内容');
  });
  it('softDelete + restore', () => {
    const s = new InMemoryArtifactStore();
    s.putAtomic('a1', makeManifest(), 'x');
    s.softDelete('a1', 100);
    expect(s.listByProject('p1')).toHaveLength(0);
    s.restore('a1');
    expect(s.listByProject('p1')).toHaveLength(1);
  });
});

// ── METIS-603 ──
describe('METIS-603 ProvenanceChain', () => {
  it('lineage walks artifact → run → evidence → source', () => {
    const chain = createProvenanceChain();
    chain.link({ kind: 'source', id: 's1', parentId: null, hash: 'h-s1' });
    chain.link({ kind: 'evidence', id: 'e1', parentId: 's1', hash: 'h-e1' });
    chain.link({ kind: 'run', id: 'r1', parentId: 'e1', hash: 'h-r1' });
    chain.link({ kind: 'artifact', id: 'a1', parentId: 'r1', hash: 'h-a1' });
    const lin = chain.lineage('a1');
    expect(lin.map((n) => n.kind)).toEqual(['source', 'evidence', 'run', 'artifact']);
  });
  it('downstreamStale returns artifacts affected when a source changes', () => {
    const chain = createProvenanceChain();
    chain.link({ kind: 'source', id: 's1', parentId: null, hash: 'h1' });
    chain.link({ kind: 'evidence', id: 'e1', parentId: 's1', hash: 'h2' });
    chain.link({ kind: 'artifact', id: 'a1', parentId: 'e1', hash: 'h3' });
    chain.link({ kind: 'artifact', id: 'a2', parentId: 'e1', hash: 'h4' });
    const stale = chain.downstreamStale('s1');
    expect(stale.sort()).toEqual(['a1', 'a2']);
  });
});

// ── METIS-604 ──
describe('METIS-604 diffVersions', () => {
  it('detects identical content', () => {
    expect(diffVersions('same', 'same', 'manuscript').kind).toBe('identical');
  });
  it('counts text line add/remove', () => {
    const r = diffVersions('a\nb', 'a\nc\nd', 'manuscript');
    expect(r.kind).toBe('text');
    expect(r.added).toBeGreaterThanOrEqual(1);
  });
  it('structural diff for chart spec (JSON)', () => {
    const r = diffVersions('{"x":1}', '{"x":1,"y":2}', 'chart');
    expect(r.kind).toBe('spec');
    expect(r.added).toBeGreaterThanOrEqual(1);
  });
});

// ── METIS-605 ──
describe('METIS-605 SelectionBridge', () => {
  it('builds an ask request that always carries containerId + objectId', () => {
    const r = buildAskFromSelection({
      kind: 'pdf_paragraph', containerId: 'src-pdf-1', objectId: 'para-5',
      coordinates: { page: 3, charStart: 100, charEnd: 200 }, textSnapshot: '原文',
    }, '这段什么意思？');
    expect(r.contextForModel.containerId).toBe('src-pdf-1');
    expect(r.contextForModel.objectId).toBe('para-5');
    expect(r.contextForModel.text).toBe('原文');
  });
  it('throws if selection is missing stable ids (forbids visible-label-only)', () => {
    expect(() => buildAskFromSelection({ kind: 'chart_datapoint', containerId: '', objectId: '', coordinates: {}, textSnapshot: 'x' }, 'q')).toThrow(/containerId.*objectId|stable/i);
  });
});

// ── METIS-606 ──
describe('METIS-606 ViewerRegistry', () => {
  beforeEach(() => resetViewerRegistry());
  it('resolves a registered viewer for a handled kind', () => {
    registerViewer({ handles: ['pdf', 'pdf_source'], moduleId: 'PdfViewer', kind: 'pdf' });
    expect(resolveViewer('pdf').kind).toBe('pdf');
  });
  it('falls back to text viewer for an unknown kind', () => {
    expect(resolveViewer('ufo').kind).toBe('text_fallback');
  });
  it('safeLoadViewer returns fallback on load error (no crash)', async () => {
    const r = await safeLoadViewer({ handles: ['x'], moduleId: 'Broken', kind: 'chart_vega' }, async () => { throw new Error('module missing'); });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fallback.kind).toBe('text_fallback');
  });
  it('safeLoadViewer returns the module on success', async () => {
    const r = await safeLoadViewer({ handles: ['x'], moduleId: 'Ok', kind: 'pdf' }, async () => ({ render: () => {} }));
    expect(r.ok).toBe(true);
  });
});

// ── METIS-607 ──
describe('METIS-607 review status', () => {
  const okChecks = [{ name: '引用核验', passed: true, detail: '' }, { name: '数字一致', passed: true, detail: '' }];
  it('stale when a source was deleted', () => {
    const r = computeReviewStatus(makeManifest(), okChecks, { anySourceDeleted: true, inputStale: false });
    expect(r.status).toBe('stale');
    expect(r.blockingIssues.some((b) => b.includes('删除'))).toBe(true);
  });
  it('stale when inputs updated', () => {
    expect(computeReviewStatus(makeManifest(), okChecks, { anySourceDeleted: false, inputStale: true }).status).toBe('stale');
  });
  it('partial when a check failed', () => {
    const r = computeReviewStatus(makeManifest(), [{ name: 'x', passed: false, detail: 'bad' }], { anySourceDeleted: false, inputStale: false });
    expect(r.status).toBe('partial');
  });
  it('verified when all checks pass AND has sources', () => {
    const r = computeReviewStatus(
      makeManifest(),
      okChecks,
      { anySourceDeleted: false, inputStale: false },
      { receiptVerified: true, profileEnforced: true },
    );
    expect(r.status).toBe('verified');
    expect(isReliable(r)).toBe(true);
  });
  it('isReliable is false for anything but verified', () => {
    expect(isReliable({ status: 'draft', checks: [], blockingIssues: [] })).toBe(false);
    expect(isReliable({ status: 'partial', checks: [], blockingIssues: ['x'] })).toBe(false);
  });
});
