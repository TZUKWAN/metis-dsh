import {
  type ClaimEvidenceLink,
  type ClaimEvidenceRelation,
  type ClaimType,
  type EvidenceExcerptRecord,
  type EvidenceLocatorType,
  MetisDataStore,
  type EvidenceRecord,
  type EvidenceSourceType,
  type EvidenceVerificationState as VerificationState,
  type RegisterEvidenceInput,
} from '../../../shared/data/src/index.ts'

export interface RegisterObservationInput extends RegisterEvidenceInput {}

/**
 * Backward-compatible domain facade over the unified SQLite store. This class
 * owns no JSON file or process-local cache; every method reads/writes metis.db.
 */
export class EvidenceStore {
  private readonly data: MetisDataStore

  constructor(data: MetisDataStore) {
    this.data = data
  }

  registerObservation(input: RegisterObservationInput): { record: EvidenceRecord; duplicate: boolean } {
    return this.data.registerEvidence(input)
  }

  verify(id: string): EvidenceRecord | undefined {
    return this.data.setEvidenceVerification(id, 'verified') ?? undefined
  }

  reject(id: string): EvidenceRecord | undefined {
    return this.data.setEvidenceVerification(id, 'invalid') ?? undefined
  }

  markConflict(id: string): EvidenceRecord | undefined {
    return this.data.setEvidenceVerification(id, 'conflicting') ?? undefined
  }

  markStale(id: string): EvidenceRecord | undefined {
    return this.data.setEvidenceVerification(id, 'stale') ?? undefined
  }

  get(id: string): EvidenceRecord | undefined {
    return this.data.getEvidence(id) ?? undefined
  }

  queryByProject(projectId: string): EvidenceRecord[] {
    return this.data.queryEvidence({ projectId })
  }

  queryByDoi(doi: string): EvidenceRecord[] {
    return this.data.queryEvidence({ doi })
  }

  queryByUrl(url: string): EvidenceRecord[] {
    return this.data.queryEvidence({ url })
  }

  all(): EvidenceRecord[] {
    return this.data.queryEvidence()
  }

  createClaim(projectId: string, text: string, options: { claimType?: ClaimType; artifactId?: string } = {}) {
    return this.data.createClaim(projectId, text, options)
  }

  getClaim(id: string) {
    return this.data.getClaim(id) ?? undefined
  }

  listClaims(filter: { projectId?: string; artifactId?: string } = {}) {
    return this.data.listClaims(filter)
  }

  setClaimStatus(id: string, state: Parameters<MetisDataStore['setClaimStatus']>[1]) {
    return this.data.setClaimStatus(id, state) ?? undefined
  }

  linkClaimEvidence(claimId: string, evidenceId: string, relation?: ClaimEvidenceRelation, confidence?: number): ClaimEvidenceLink {
    return this.data.linkClaimEvidence(claimId, evidenceId, relation, confidence)
  }

  listClaimEvidence(claimId: string): EvidenceRecord[] {
    return this.data.listClaimEvidence(claimId)
  }

  addEvidenceExcerpt(input: { evidenceId: string; content: string; locatorType?: EvidenceLocatorType; locatorValue?: string }): EvidenceExcerptRecord {
    return this.data.addEvidenceExcerpt(input)
  }

  listEvidenceExcerpts(evidenceId: string): EvidenceExcerptRecord[] {
    return this.data.listEvidenceExcerpts(evidenceId)
  }

  artifactEvidenceCheck(artifactId: string) {
    return this.data.artifactEvidenceCheck(artifactId)
  }
}

export type { EvidenceSourceType, VerificationState }
