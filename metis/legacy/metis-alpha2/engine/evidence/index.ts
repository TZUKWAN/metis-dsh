/**
 * Evidence layer barrel exports — provenance, references, audit, integrity.
 */

export { ProvenanceChain, type ProvenanceEntry, type ProvenanceReport } from './ProvenanceChain.js';
export {
  ReferenceValidator,
  type ReferenceValidationResult,
  type ReferenceValidationOptions,
  type ReferenceValidatorOptions,
  getReferenceValidator,
} from './ReferenceValidator.js';
export { AuditTrail, type AuditEntry, type AuditChainStatus } from './AuditTrail.js';
export { IntegrityReporter, type IntegrityReport, type DimensionScore, getIntegrityReporter } from './IntegrityReporter.js';
