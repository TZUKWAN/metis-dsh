import type { CurrentAffairsManifest } from './CurrentAffairsProfile.js';
import { isExpired, isFutureSource, needsCorrectionReview } from './CurrentAffairsProfile.js';
import { createWorkflowState, verifySource, advancePhase, type CurrentAffairsWorkflowState } from './CurrentAffairsWorkflow.js';

export interface CurrentAffairsServiceDeps {
  now: () => number;
}

export interface SourceVerificationResult {
  sourceId: string;
  verified: boolean;
  reason?: string;
}

export class CurrentAffairsService {
  #deps: CurrentAffairsServiceDeps;
  constructor(deps: CurrentAffairsServiceDeps) { this.#deps = deps; }

  verifyAllSources(manifest: CurrentAffairsManifest): SourceVerificationResult[] {
    return manifest.sources.map((source) => {
      const result = verifySource(source, this.#deps.now());
      return { sourceId: source.sourceId, verified: result.verified, reason: result.reason };
    });
  }

  checkTemporalValidity(manifest: CurrentAffairsManifest): { valid: boolean; expiredSources: string[]; futureSources: string[]; retractedSources: string[] } {
    const now = this.#deps.now();
    const expiredSources: string[] = [];
    const futureSources: string[] = [];
    const retractedSources: string[] = [];
    if (isExpired(manifest.timeWindow, now)) {
      expiredSources.push('__timeWindow__');
    }
    for (const source of manifest.sources) {
      if (isFutureSource(source, now)) futureSources.push(source.sourceId);
      if (needsCorrectionReview(source)) retractedSources.push(source.sourceId);
    }
    return {
      valid: expiredSources.length === 0 && futureSources.length === 0 && retractedSources.length === 0,
      expiredSources,
      futureSources,
      retractedSources,
    };
  }

  executeWorkflow(manifest: CurrentAffairsManifest): { state: CurrentAffairsWorkflowState; errors: string[] } {
    let state = createWorkflowState(manifest);
    const errors: string[] = [];

    const sourceResults = this.verifyAllSources(manifest);
    const failedSources = sourceResults.filter((r) => !r.verified);
    state.verifiedSourceIds = sourceResults.filter((r) => r.verified).map((r) => r.sourceId);
    state.rejectedSourceIds = failedSources.map((r) => r.sourceId);
    if (failedSources.length > 0) {
      errors.push(`${failedSources.length} source(s) failed verification: ${failedSources.map((f) => f.reason).join(', ')}`);
    } else {
      state = advancePhase(state, 'verify');
    }

    if (manifest.facts && manifest.facts.length > 0) {
      state = advancePhase(state, 'fact_split');
      state.factLayerComplete = true;
    }

    const temporal = this.checkTemporalValidity(manifest);
    if (!temporal.valid) {
      errors.push(`Temporal check failed: expired=${temporal.expiredSources.join(',')}, future=${temporal.futureSources.join(',')}, retracted=${temporal.retractedSources.join(',')}`);
    } else {
      state = advancePhase(state, 'temporal_check');
      state.temporalCheckPassed = true;
    }

    state = advancePhase(state, 'correction_monitor');
    state.correctionReviewComplete = true;

    if (errors.length === 0) {
      // Stop at approval phase — approval requires main-process receipt.
      // approved/exportReady are set by SessionState.markApproved after native confirmation+receipt.
      state = advancePhase(state, 'approval');
      state.approved = false;
      state.previewGenerated = true;
      state.exportReady = false;
    }

    return { state, errors };
  }
}
