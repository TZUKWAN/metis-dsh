import {
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

  createClaim(projectId: string, text: string) {
    return this.data.createClaim(projectId, text)
  }

  linkClaimEvidence(claimId: string, evidenceId: string, relation?: string): void {
    this.data.linkClaimEvidence(claimId, evidenceId, relation)
  }

  listClaimEvidence(claimId: string): EvidenceRecord[] {
    return this.data.listClaimEvidence(claimId)
  }
}

export type { EvidenceSourceType, VerificationState }
