/**
 * METIS-405 — Claim-Evidence graph tests.
 *
 * Covers: many-to-many linking; coexistence of supporting + contradicting evidence;
 * status recompute (supported/contested/refuted/unsupported); source invalidation via
 * unlink; claim revision; complete evidence manifest generation.
 */

import { describe, it, expect } from 'vitest';
import { ClaimGraph, type ClaimStore } from './ClaimGraph.js';
import type { Claim, ClaimEvidenceLink } from '../persistence/researchModel.js';

class MemClaimStore implements ClaimStore {
  claims = new Map<string, Claim>();
  links = new Map<string, ClaimEvidenceLink>();
  insertClaim(c: Claim) { this.claims.set(c.id, { ...c }); }
  getClaim(id: string) { const c = this.claims.get(id); return c ? { ...c } : undefined; }
  listClaimsByProject(pid: string) { return [...this.claims.values()].filter((c) => c.projectId === pid); }
  updateClaim(id: string, patch: Partial<Claim>) { const c = this.claims.get(id); if (c) this.claims.set(id, { ...c, ...patch }); }
  insertLink(l: ClaimEvidenceLink) { this.links.set(l.id, { ...l }); }
  listLinksByClaim(cid: string) { return [...this.links.values()].filter((l) => l.claimId === cid); }
  listLinksByEvidence(eid: string) { return [...this.links.values()].filter((l) => l.evidenceId === eid); }
  deleteLink(id: string) { this.links.delete(id); }
}

function makeClaim(id: string, projectId = 'p1'): Claim {
  const now = Date.now();
  return {
    id, projectId, statement: `claim ${id}`, claimType: 'assertion',
    confidence: 0, status: 'unsupported', metadata: {},
    createdAt: now, updatedAt: now, deletedAt: null,
  };
}
function makeLink(id: string, claimId: string, evidenceId: string, relation: ClaimEvidenceLink['relation'], weight = 1): ClaimEvidenceLink {
  return { id, claimId, evidenceId, relation, weight, note: '', createdAt: Date.now() };
}

describe('METIS-405 ClaimGraph — status computation', () => {
  it('a claim with no evidence is unsupported', () => {
    const g = new ClaimGraph(new MemClaimStore());
    g.createClaim(makeClaim('c1'));
    expect(g.evidenceManifest('c1').claim?.status).toBe('unsupported');
  });

  it('a claim with only supporting evidence becomes supported', () => {
    const g = new ClaimGraph(new MemClaimStore());
    g.createClaim(makeClaim('c1'));
    g.linkEvidence(makeLink('l1', 'c1', 'e1', 'supports'));
    g.linkEvidence(makeLink('l2', 'c1', 'e2', 'supports'));
    expect(g.evidenceManifest('c1').claim?.status).toBe('supported');
  });

  it('a claim with coexisting support + contradiction is contested', () => {
    const g = new ClaimGraph(new MemClaimStore());
    g.createClaim(makeClaim('c1'));
    g.linkEvidence(makeLink('l1', 'c1', 'e1', 'supports', 1));
    g.linkEvidence(makeLink('l2', 'c1', 'e2', 'contradicts', 1));
    expect(g.evidenceManifest('c1').claim?.status).toBe('contested');
  });

  it('a claim where contradiction outweighs support is refuted', () => {
    const g = new ClaimGraph(new MemClaimStore());
    g.createClaim(makeClaim('c1'));
    g.linkEvidence(makeLink('l1', 'c1', 'e1', 'supports', 1));
    g.linkEvidence(makeLink('l2', 'c1', 'e2', 'contradicts', 3));
    expect(g.evidenceManifest('c1').claim?.status).toBe('refuted');
  });
});

describe('METIS-405 ClaimGraph — source invalidation / unlink', () => {
  it('removing a contradicting link flips status back to supported', () => {
    const store = new MemClaimStore();
    const g = new ClaimGraph(store);
    g.createClaim(makeClaim('c1'));
    g.linkEvidence(makeLink('l1', 'c1', 'e1', 'supports', 1));
    g.linkEvidence(makeLink('l2', 'c1', 'e2', 'contradicts', 1));
    expect(g.evidenceManifest('c1').claim?.status).toBe('contested');
    // the source backing e2 is invalidated → remove its link
    g.unlink('l2', 'c1');
    expect(g.evidenceManifest('c1').claim?.status).toBe('supported');
  });
});

describe('METIS-405 ClaimGraph — claim revision', () => {
  it('revising a claim updates its statement and updatedAt', () => {
    const g = new ClaimGraph(new MemClaimStore());
    g.createClaim(makeClaim('c1'));
    const before = g.evidenceManifest('c1').claim!;
    g.reviseClaim('c1', { statement: '修改后的论断' });
    const after = g.evidenceManifest('c1').claim!;
    expect(after.statement).toBe('修改后的论断');
    expect(after.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
  });
});

describe('METIS-405 ClaimGraph — many-to-many + evidence manifest', () => {
  it('one piece of evidence can back multiple claims', () => {
    const store = new MemClaimStore();
    const g = new ClaimGraph(store);
    g.createClaim(makeClaim('c1'));
    g.createClaim(makeClaim('c2'));
    g.linkEvidence(makeLink('l1', 'c1', 'shared-evidence', 'supports'));
    g.linkEvidence(makeLink('l2', 'c2', 'shared-evidence', 'supports'));
    expect(store.listLinksByEvidence('shared-evidence')).toHaveLength(2);
  });

  it('generates a complete evidence manifest for a final claim', () => {
    const g = new ClaimGraph(new MemClaimStore());
    g.createClaim(makeClaim('c1'));
    g.linkEvidence(makeLink('l1', 'c1', 'e1', 'supports', 2));
    g.linkEvidence(makeLink('l2', 'c1', 'e2', 'supports', 1));
    g.linkEvidence(makeLink('l3', 'c1', 'e3', 'contradicts', 1));
    g.linkEvidence(makeLink('l4', 'c1', 'e4', 'qualifies', 1));
    const manifest = g.evidenceManifest('c1');
    expect(manifest.supports).toHaveLength(2);
    expect(manifest.contradicts).toHaveLength(1);
    expect(manifest.qualifies).toHaveLength(1);
    expect(manifest.claim?.status).toBe('contested'); // 3 support vs 1 contra
  });
});
