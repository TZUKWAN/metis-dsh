/**
 * METIS-801 ~ 809 — Seven research capabilities + profiles tests.
 */

import { describe, it, expect } from 'vitest';
import {
  neededClarifications, produceDesignCard, validateDesignCard,
  deduplicateSources, validateReviewAudit,
  filterAiCodeSuggestions, gateQuantOutput,
  auditManuscriptCitations, canMarkVerified, flagUnsupportedInterpretations,
  type DiagnosticsResult,
} from './researchCapabilities.js';
import {
  DISCIPLINE_PROFILES, isProfileExpired,
  isJournalRuleTrustworthy, checkJournalCompliance,
  type JournalProfile,
} from './profiles.js';
import type { Project } from '../persistence/researchModel.js';

function project(): Project {
  const now = Date.now();
  return { id: 'p1', title: 'P', originalIntent: 'i', researchQuestion: '', lifecycle: 'draft', methodology: '', discipline: 'sociology', metadata: {}, createdAt: now, updatedAt: now, archivedAt: null, version: 1, source: 'user', deletedAt: null };
}

// ── 801 ──
describe('METIS-801 research design', () => {
  it('neededClarifications asks only what is missing (max 3 rounds)', () => {
    const r = neededClarifications('短视频', { hasDiscipline: false, hasScope: false, hasMethod: false });
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r.length).toBeLessThanOrEqual(3);
  });
  it('produceDesignCard + validateDesignCard', () => {
    const card = produceDesignCard(project(), { researchQuestion: '短视频如何影响学业？', theoreticalLens: '注意力经济', methodology: '混合方法', scope: '初中生', deliverables: ['报告'], clarifications: ['学科'] });
    expect(validateDesignCard(card).valid).toBe(true);
  });
  it('rejects a vague question', () => {
    const card = produceDesignCard(project(), { researchQuestion: '短视频', theoreticalLens: '', methodology: '', scope: '', deliverables: [], clarifications: [] });
    expect(validateDesignCard(card).valid).toBe(false);
  });
});

// ── 802 ──
describe('METIS-802 source research', () => {
  it('deduplicateSources removes dupes by identifier/title', () => {
    const r = deduplicateSources([
      { identifier: '10.1/x', title: 'A' },
      { identifier: '10.1/X', title: 'A2' }, // dup (case-insensitive)
      { identifier: '', title: 'B' },
    ]);
    expect(r.unique.length).toBe(2);
    expect(r.duplicatesRemoved).toBe(1);
  });
});

// ── 803 ──
describe('METIS-803 literature review', () => {
  it('validateReviewAudit requires a full audit trail', () => {
    const good = { searchStrings: ['q'], inclusionCriteria: ['c'], exclusionCriteria: [], candidateCount: 10, includedCount: 3, excludedReasons: [], finalCitations: ['c1'] };
    expect(validateReviewAudit(good).valid).toBe(true);
    const bad = { searchStrings: [], inclusionCriteria: [], exclusionCriteria: [], candidateCount: 0, includedCount: 0, excludedReasons: [], finalCitations: [] };
    expect(validateReviewAudit(bad).valid).toBe(false);
  });
});

// ── 804 ──
describe('METIS-804 qualitative', () => {
  it('filterAiCodeSuggestions drops low-confidence + spanless', () => {
    const out = filterAiCodeSuggestions([
      { code: 'A', evidenceSpan: 'span', confidence: 0.8 },
      { code: 'B', evidenceSpan: '', confidence: 0.9 },     // spanless → dropped
      { code: 'C', evidenceSpan: 'span', confidence: 0.3 }, // low conf → dropped
    ]);
    expect(out.length).toBe(1);
    expect(out[0]!.code).toBe('A');
  });
});

// ── 805 ──
describe('METIS-805 quantitative / causal', () => {
  const passing: DiagnosticsResult = { passed: true, checks: [{ name: '平行趋势', passed: true, detail: '' }] };
  const failing: DiagnosticsResult = { passed: false, checks: [{ name: '平行趋势', passed: false, detail: '不满足' }] };
  it('gateQuantOutput outputs results only when diagnostics pass', () => {
    const r = gateQuantOutput(passing, 'DID', { estimate: 1.5, ciLow: 0.5, ciHigh: 2.5 });
    expect(r.results).toBeDefined();
  });
  it('gateQuantOutput blocks causal conclusion when diagnostics fail (METIS-805)', () => {
    const r = gateQuantOutput(failing, 'DID', { estimate: 1.5, ciLow: 0.5, ciHigh: 2.5 });
    expect(r.results).toBeUndefined();
    expect(r.limitation).toMatch(/诊断未通过/);
  });
});

// ── 806 ──
describe('METIS-806 argumentation writing', () => {
  it('auditManuscriptCitations flags un-locatable cites', () => {
    const r = auditManuscriptCitations({ manuscriptCitations: ['s1', 'sX'], registeredSourceIds: new Set(['s1']) });
    expect(r.unlocated).toEqual(['sX']);
    expect(r.ok).toBe(false);
  });
  it('flagUnsupportedInterpretations flags interpretation without source', () => {
    const flagged = flagUnsupportedInterpretations([
      { kind: 'fact', text: 'f' },
      { kind: 'interpretation', text: 'i', sourceId: 's1' },     // has source → ok
      { kind: 'interpretation', text: 'i2' },                      // no source → flagged
      { kind: 'citation', text: 'c', sourceId: 's2' },
    ]);
    expect(flagged.length).toBe(1);
    expect(flagged[0]!.text).toBe('i2');
  });
});

// ── 807 ──
describe('METIS-807 verification', () => {
  it('canMarkVerified is false when errors exist', () => {
    expect(canMarkVerified([{ severity: 'error', category: 'citation', message: 'bad' }]).ok).toBe(false);
    expect(canMarkVerified([{ severity: 'warning', category: 'language', message: 'w' }]).ok).toBe(true);
  });
});

// ── 808 Discipline profile ──
describe('METIS-808 discipline profile', () => {
  it('every discipline has a profile with method preferences', () => {
    for (const d of Object.keys(DISCIPLINE_PROFILES) as Array<keyof typeof DISCIPLINE_PROFILES>) {
      expect(DISCIPLINE_PROFILES[d].preferredMethods.length).toBeGreaterThan(0);
    }
  });
  it('isProfileExpired detects expiry', () => {
    const expired = { ...DISCIPLINE_PROFILES.history, expiresAt: 1000 };
    expect(isProfileExpired(expired, 2000)).toBe(true);
  });
  it('sociology requires human-subjects confirmation', () => {
    expect(DISCIPLINE_PROFILES.sociology.requiresHumanSubjectsConfirmation).toBe(true);
  });
});

// ── 809 Journal profile ──
describe('METIS-809 journal profile', () => {
  const journal: JournalProfile = {
    journalId: 'j1', name: 'Demo Journal', wordLimit: 8000, abstractWordLimit: 250,
    citationStyle: 'APA', allowedChartTypes: ['bar', 'line'],
    submissionRules: [], source: 'official', sourceDate: '2026-01', version: '1.0.0', verified: true, expiresAt: null,
  };
  it('isJournalRuleTrustworthy is false when unverified or expired', () => {
    expect(isJournalRuleTrustworthy(journal)).toBe(true);
    expect(isJournalRuleTrustworthy({ ...journal, verified: false })).toBe(false);
    expect(isJournalRuleTrustworthy({ ...journal, expiresAt: 1000 })).toBe(false);
  });
  it('checkJournalCompliance flags over-limit + missing abstract + disallowed chart', () => {
    const r = checkJournalCompliance(journal, { wordCount: 9000, hasAbstract: false, chartTypes: ['bar', 'heatmap'] });
    const errorRules = r.filter((x) => x.severity === 'error' && !x.passed);
    expect(errorRules.length).toBeGreaterThanOrEqual(2);
    const chartWarn = r.find((x) => x.rule.includes('heatmap'));
    expect(chartWarn).toBeDefined();
  });
});
