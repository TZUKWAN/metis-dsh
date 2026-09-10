/**
 * Claim-Evidence graph service (METIS-405).
 *
 * Records claims, the evidence that supports / contradicts / qualifies them, and per-link
 * weight + confidence. Supports many-to-many relations (one claim draws on many evidence
 * items; one evidence item may back many claims). Computes the overall support status of a
 * claim (supported / contested / refuted / unsupported) from its evidence relations.
 *
 * METIS-405 completion: "supports coexistence of supporting and contradicting evidence;
 * source invalidated; claim modified; version tests; final claim can generate a complete
 * evidence list".
 */

import type { Claim, ClaimEvidenceLink, ClaimStatus, ClaimEvidenceRelation } from '../persistence/researchModel.js';

// ─── Backing store interface (SQL or in-memory) ───────────────

export interface ClaimStore {
  insertClaim(c: Claim): void;
  getClaim(id: string): Claim | undefined;
  listClaimsByProject(projectId: string): Claim[];
  updateClaim(id: string, patch: Partial<Claim>): void;
  insertLink(l: ClaimEvidenceLink): void;
  listLinksByClaim(claimId: string): ClaimEvidenceLink[];
  listLinksByEvidence(evidenceId: string): ClaimEvidenceLink[];
  deleteLink(id: string): void;
}

// ─── Service ──────────────────────────────────────────────────

export class ClaimGraph {
  private readonly store: ClaimStore;
  constructor(store: ClaimStore) {
    this.store = store;
  }

  createClaim(c: Claim): Claim {
    this.store.insertClaim(c);
    return c;
  }

  /** Link a piece of evidence to a claim with a relation type + weight. */
  linkEvidence(link: ClaimEvidenceLink): ClaimEvidenceLink {
    this.store.insertLink(link);
    // Recompute the claim's status from its now-current evidence set.
    this.recomputeStatus(link.claimId);
    return link;
  }

  /** Remove a link (e.g. user rejects a piece of evidence) and recompute. */
  unlink(linkId: string, claimId: string): void {
    this.store.deleteLink(linkId);
    this.recomputeStatus(claimId);
  }

  /** Modify a claim's statement; bumps version via updatedAt (METIS-405: claim modified). */
  reviseClaim(id: string, patch: Partial<Claim>): void {
    this.store.updateClaim(id, { ...patch, updatedAt: Date.now() });
    this.recomputeStatus(id);
  }

  /**
   * Generate a complete, readable evidence list for a claim — for the final artifact's
   * audit trail (METIS-405: "final claim can generate a complete evidence list").
   */
  evidenceManifest(claimId: string): {
    claim: Claim | undefined;
    supports: ClaimEvidenceLink[];
    contradicts: ClaimEvidenceLink[];
    qualifies: ClaimEvidenceLink[];
  } {
    const claim = this.store.getClaim(claimId);
    const links = this.store.listLinksByClaim(claimId);
    return {
      claim,
      supports: links.filter((l) => l.relation === 'supports'),
      contradicts: links.filter((l) => l.relation === 'contradicts'),
      qualifies: links.filter((l) => l.relation === 'qualifies'),
    };
  }

  /**
   * Recompute a claim's status from its evidence. Rules:
   *   - has contradicting evidence with weight >= supporting weight => contested
   *   - contradicting weight > supporting weight => refuted
   *   - has supporting evidence and no contradiction => supported
   *   - no evidence at all => unsupported
   * Source invalidation is represented by the caller deleting the link (METIS-405: source
   * invalidated) — the recompute then no longer counts it.
   */
  recomputeStatus(claimId: string): ClaimStatus {
    const links = this.store.listLinksByClaim(claimId);
    const supportWeight = sumWeight(links, 'supports');
    const contraWeight = sumWeight(links, 'contradicts');

    let status: ClaimStatus;
    if (links.length === 0) status = 'unsupported';
    else if (contraWeight > supportWeight && contraWeight > 0) status = 'refuted';
    else if (contraWeight > 0) status = 'contested';
    else status = 'supported';

    this.store.updateClaim(claimId, { status, updatedAt: Date.now() });
    return status;
  }
}

function sumWeight(links: ClaimEvidenceLink[], relation: ClaimEvidenceRelation): number {
  return links.filter((l) => l.relation === relation).reduce((acc, l) => acc + l.weight, 0);
}
