/**
 * METIS-1002/1003/1007/1008/1010 — acceptance & release-candidate audit tests.
 */

import { describe, it, expect } from 'vitest';
import {
  VISUAL_CAPTURE_PLAN, evaluateVisualDiff, visualGate, VISUAL_REVIEW_CHECKLIST,
  REAL_MODEL_EVAL_CASES, summarizeBoundaries, type RealModelEvalResult,
} from './VisualRealModel.js';
import {
  FOUR_ACCEPTANCE_SCENARIOS, evaluateScenario,
  CLEAN_WINDOWS_STEPS, validateCleanWindowsAcceptance,
  evaluateReleaseCandidate, type ReleaseCandidateAudit,
  type ScenarioEvidence,
} from './Acceptance.js';

// ── 1003 visual ──
describe('METIS-1003 visual regression', () => {
  it('capture plan covers multi-resolution + light/dark + variants', () => {
    const resolutions = new Set(VISUAL_CAPTURE_PLAN.flatMap((c) => c.resolutions.map((r) => `${r.width}x${r.height}`)));
    expect(resolutions.has('1366x768')).toBe(true);
    expect(resolutions.has('1920x1080')).toBe(true);
    expect(resolutions.has('2560x1440')).toBe(true);
    const themes = new Set(VISUAL_CAPTURE_PLAN.flatMap((c) => c.themes));
    expect(themes.has('light') && themes.has('dark')).toBe(true);
    const variants = new Set(VISUAL_CAPTURE_PLAN.map((c) => c.variant));
    expect(variants.has('large_table') && variants.has('empty') && variants.has('long_text')).toBe(true);
  });
  it('evaluateVisualDiff respects threshold', () => {
    expect(evaluateVisualDiff({ captureId: 'x', pixelDiffPct: 0.3, passed: false }).passed).toBe(true);
    expect(evaluateVisualDiff({ captureId: 'x', pixelDiffPct: 0.8, passed: false }).passed).toBe(false);
  });
  it('visualGate fails on any failing capture', () => {
    expect(visualGate([{ captureId: 'a', pixelDiffPct: 0.1, passed: true }, { captureId: 'b', pixelDiffPct: 1.0, passed: false }]).passed).toBe(false);
  });
  it('manual review checklist covers the METIS-1003 failure modes', () => {
    const text = VISUAL_REVIEW_CHECKLIST.join(' ');
    expect(text).toMatch(/overlap/i);
    expect(text).toMatch(/truncation|truncat/i);
    expect(text).toMatch(/blank/);
  });
});

// ── 1002 real model ──
describe('METIS-1002 real-model eval', () => {
  it('covers all four research capabilities with rating criteria', () => {
    expect(REAL_MODEL_EVAL_CASES.length).toBeGreaterThanOrEqual(4);
    for (const c of REAL_MODEL_EVAL_CASES) expect(c.ratingCriteria.length).toBeGreaterThan(0);
  });
  it('summarizeBoundaries separates acceptable vs needs-downgrade (no fabrication when empty)', () => {
    expect(summarizeBoundaries([])).toEqual([]); // empty results → empty summary (never fabricated)
    const results: RealModelEvalResult[] = [
      { modelClass: 'small_9b', model: 'qwen-7b', caseId: 'rme-design', score: 0.8, taskCompleted: true, fabricatedSource: false },
      { modelClass: 'small_9b', model: 'qwen-7b', caseId: 'rme-quant', score: 0.4, taskCompleted: false, fabricatedSource: false },
    ];
    const b = summarizeBoundaries(results)[0]!;
    expect(b.acceptable).toContain('rme-design');
    expect(b.needsDowngrade).toContain('rme-quant');
  });
  it('a model that fabricates a source is NOT acceptable even at high score', () => {
    const results: RealModelEvalResult[] = [
      { modelClass: 'strong', model: 'x', caseId: 'rme-review', score: 0.95, taskCompleted: true, fabricatedSource: true },
    ];
    const b = summarizeBoundaries(results)[0]!;
    expect(b.acceptable).not.toContain('rme-review');
  });
});

// ── 1008 four scenarios ──
describe('METIS-1008 four-scenario acceptance', () => {
  it('defines exactly the four core scenarios', () => {
    expect(FOUR_ACCEPTANCE_SCENARIOS.length).toBe(4);
    const ids = FOUR_ACCEPTANCE_SCENARIOS.map((s) => s.id);
    expect(ids).toContain('lit-history');
    expect(ids).toContain('lit-review');
    expect(ids).toContain('qual-interview');
    expect(ids).toContain('quant-mixed');
  });
  it('each scenario requires a one-sentence-need → auditable artifact flow', () => {
    for (const s of FOUR_ACCEPTANCE_SCENARIOS) {
      expect(s.oneSentenceNeed.length).toBeGreaterThan(0);
      expect(s.expectedFlow.length).toBeGreaterThan(0);
      expect(s.requiredEvidence.length).toBeGreaterThan(0);
    }
  });
  it('evaluateScenario passes only when all required evidence present', () => {
    const s = FOUR_ACCEPTANCE_SCENARIOS[0]!;
    const partial: ScenarioEvidence = { scenarioId: s.id, evidencePresent: { [s.requiredEvidence[0]!]: true } };
    expect(evaluateScenario(s, partial).passed).toBe(false);
    const full: ScenarioEvidence = { scenarioId: s.id, evidencePresent: Object.fromEntries(s.requiredEvidence.map((e) => [e, true])) };
    expect(evaluateScenario(s, full).passed).toBe(true);
  });
});

// ── 1007 clean Windows ──
describe('METIS-1007 clean-Windows acceptance', () => {
  it('covers install/config/scenarios/restart/upgrade/uninstall', () => {
    const ids = CLEAN_WINDOWS_STEPS.map((s) => s.id);
    expect(ids).toContain('cw-install-exe');
    expect(ids).toContain('cw-install-msi');
    expect(ids).toContain('cw-config-api');
    expect(ids).toContain('cw-four-scenarios');
    expect(ids).toContain('cw-uninstall');
  });
  it('fails if any step required an extra install or command line', () => {
    const r = validateCleanWindowsAcceptance([
      { id: 'cw-install-exe', passed: true, extraInstallRequired: false, commandLineRequired: false },
      { id: 'cw-config-api', passed: true, extraInstallRequired: true, commandLineRequired: false },
    ]);
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.includes('额外安装'))).toBe(true);
  });
  it('passes when nothing beyond API config is required', () => {
    const r = validateCleanWindowsAcceptance(CLEAN_WINDOWS_STEPS.map((s) => ({ id: s.id, passed: true, extraInstallRequired: false, commandLineRequired: false })));
    expect(r.passed).toBe(true);
  });
});

// ── 1010 release candidate ──
describe('METIS-1010 release-candidate full audit', () => {
  it('fails when a required task lacks evidence', () => {
    const audit: ReleaseCandidateAudit = { taskEvidence: { 'METIS-001': 'snapshot ref' }, residualRisks: [], docsMatchProduct: true, maskedAsOptimization: [] };
    const r = evaluateReleaseCandidate(audit, ['METIS-001', 'METIS-002']);
    expect(r.passed).toBe(false);
    expect(r.missing).toContain('METIS-002');
  });
  it('fails when a core acceptance is masked as optimization', () => {
    const audit: ReleaseCandidateAudit = { taskEvidence: {}, residualRisks: [], docsMatchProduct: true, maskedAsOptimization: ['四类场景验收延后'] };
    const r = evaluateReleaseCandidate(audit, []);
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.includes('后续优化'))).toBe(true);
  });
  it('passes when all tasks have evidence + no residual risk + docs match + nothing masked', () => {
    const audit: ReleaseCandidateAudit = { taskEvidence: { 'METIS-001': 'x', 'METIS-002': 'y' }, residualRisks: [], docsMatchProduct: true, maskedAsOptimization: [] };
    expect(evaluateReleaseCandidate(audit, ['METIS-001', 'METIS-002']).passed).toBe(true);
  });
});
