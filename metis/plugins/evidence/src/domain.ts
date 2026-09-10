import type {
  EvidenceRecord,
  EvidenceSourceInput as EvidenceSource,
  EvidenceSourceType,
  EvidenceVerificationState as VerificationState,
} from '../../../shared/data/src/index.ts'

export type { EvidenceRecord, EvidenceSource, EvidenceSourceType, VerificationState }

/** Compatibility export for callers that previously consumed the JSON file schema. */
export interface EvidenceStoreFile {
  schemaVersion: 1
  records: EvidenceRecord[]
}
