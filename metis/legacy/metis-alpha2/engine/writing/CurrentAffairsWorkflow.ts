import type { CurrentAffairsManifest, CurrentAffairsSourceRecord } from './CurrentAffairsProfile.js';

export interface CurrentAffairsWorkflowState {
  phase: 'retrieve' | 'verify' | 'fact_split' | 'temporal_check' | 'correction_monitor' | 'approval' | 'preview' | 'export';
  manifest: CurrentAffairsManifest;
  verifiedSourceIds: string[];
  rejectedSourceIds: string[];
  factLayerComplete: boolean;
  temporalCheckPassed: boolean;
  correctionReviewComplete: boolean;
  approved: boolean;
  previewGenerated: boolean;
  exportReady: boolean;
  errors: string[];
}

export function createWorkflowState(manifest: CurrentAffairsManifest): CurrentAffairsWorkflowState {
  return {
    phase: 'retrieve',
    manifest,
    verifiedSourceIds: [],
    rejectedSourceIds: [],
    factLayerComplete: false,
    temporalCheckPassed: false,
    correctionReviewComplete: false,
    approved: false,
    previewGenerated: false,
    exportReady: false,
    errors: [],
  };
}

export function verifySource(source: CurrentAffairsSourceRecord, now: number): { verified: boolean; reason?: string } {
  if (!source.fetchedAt) return { verified: false, reason: 'Missing fetch timestamp' };
  if (source.publishedAt && source.publishedAt > now) return { verified: false, reason: 'Future publication date' };
  if (source.effectiveAt && source.effectiveAt > now) return { verified: false, reason: 'Not yet effective' };
  if (source.correctionState === 'retracted') return { verified: false, reason: 'Retracted' };
  if (source.correctionState === 'correction_pending') return { verified: false, reason: 'Correction pending' };
  return { verified: true };
}

export function advancePhase(state: CurrentAffairsWorkflowState, target: CurrentAffairsWorkflowState['phase']): CurrentAffairsWorkflowState {
  const order: CurrentAffairsWorkflowState['phase'][] = ['retrieve', 'verify', 'fact_split', 'temporal_check', 'correction_monitor', 'approval', 'preview', 'export'];
  const currentIdx = order.indexOf(state.phase);
  const targetIdx = order.indexOf(target);
  if (targetIdx < currentIdx) {
    return { ...state, errors: [...state.errors, `Cannot regress from ${state.phase} to ${target}`] };
  }
  return { ...state, phase: target };
}
