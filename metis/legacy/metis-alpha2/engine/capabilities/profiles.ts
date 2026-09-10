/**
 * Discipline Profile (METIS-808) + Journal Profile (METIS-809).
 *
 * Lightweight data-driven profiles that replace hundreds of separate skills. A discipline
 * profile captures method preferences + terminology norms; a journal profile captures
 * source/date/word-count/abstract/citation/chart/submission rules. Both carry provenance +
 * version + expiry so an unverified/expired rule is never presented as settled fact.
 */

// ─── METIS-808 Discipline Profile ─────────────────────────────

import type { Discipline } from './types.js';

export interface DisciplineProfile {
  discipline: Discipline;
  /** Preferred methods (qualitative/quantitative/mixed) for this discipline. */
  preferredMethods: string[];
  /** Terminology norms (internal-term → accepted user-term). */
  terminologyNorms: Record<string, string>;
  /** Default citation style. */
  citationStyle: string;
  /** Whether human-subjects / IRB confirmation is typically required. */
  requiresHumanSubjectsConfirmation: boolean;
  source: string;
  version: string;
  verifiedAt: number;
  expiresAt: number | null;
}

export const DISCIPLINE_PROFILES: Record<Discipline, DisciplineProfile> = {
  literature: { discipline: 'literature', preferredMethods: ['close_reading', 'thematic'], terminologyNorms: { text: '文本', canon: '经典' }, citationStyle: 'MLA', requiresHumanSubjectsConfirmation: false, source: 'metis-internal', version: '1.0.0', verifiedAt: Date.now(), expiresAt: null },
  history: { discipline: 'history', preferredMethods: ['archival', 'source_criticism'], terminologyNorms: { primary_source: '一手史料' }, citationStyle: 'Chicago', requiresHumanSubjectsConfirmation: false, source: 'metis-internal', version: '1.0.0', verifiedAt: Date.now(), expiresAt: null },
  philosophy: { discipline: 'philosophy', preferredMethods: ['conceptual_analysis', 'argumentation'], terminologyNorms: {}, citationStyle: 'Chicago', requiresHumanSubjectsConfirmation: false, source: 'metis-internal', version: '1.0.0', verifiedAt: Date.now(), expiresAt: null },
  sociology: { discipline: 'sociology', preferredMethods: ['interview', 'survey', 'ethnography'], terminologyNorms: {}, citationStyle: 'ASA', requiresHumanSubjectsConfirmation: true, source: 'metis-internal', version: '1.0.0', verifiedAt: Date.now(), expiresAt: null },
  political_science: { discipline: 'political_science', preferredMethods: ['comparative', 'quantitative'], terminologyNorms: {}, citationStyle: 'APSA', requiresHumanSubjectsConfirmation: true, source: 'metis-internal', version: '1.0.0', verifiedAt: Date.now(), expiresAt: null },
  public_administration: { discipline: 'public_administration', preferredMethods: ['case_study', 'policy_analysis'], terminologyNorms: {}, citationStyle: 'APA', requiresHumanSubjectsConfirmation: true, source: 'metis-internal', version: '1.0.0', verifiedAt: Date.now(), expiresAt: null },
  communication: { discipline: 'communication', preferredMethods: ['discourse_analysis', 'content_analysis'], terminologyNorms: {}, citationStyle: 'APA', requiresHumanSubjectsConfirmation: true, source: 'metis-internal', version: '1.0.0', verifiedAt: Date.now(), expiresAt: null },
  education: { discipline: 'education', preferredMethods: ['mixed', 'case_study'], terminologyNorms: {}, citationStyle: 'APA', requiresHumanSubjectsConfirmation: true, source: 'metis-internal', version: '1.0.0', verifiedAt: Date.now(), expiresAt: null },
  law: { discipline: 'law', preferredMethods: ['doctrinal', 'comparative'], terminologyNorms: {}, citationStyle: 'Bluebook', requiresHumanSubjectsConfirmation: false, source: 'metis-internal', version: '1.0.0', verifiedAt: Date.now(), expiresAt: null },
  economics: { discipline: 'economics', preferredMethods: ['quantitative', 'causal_inference'], terminologyNorms: {}, citationStyle: 'Chicago', requiresHumanSubjectsConfirmation: true, source: 'metis-internal', version: '1.0.0', verifiedAt: Date.now(), expiresAt: null },
  interdisciplinary: { discipline: 'interdisciplinary', preferredMethods: ['mixed'], terminologyNorms: {}, citationStyle: 'APA', requiresHumanSubjectsConfirmation: true, source: 'metis-internal', version: '1.0.0', verifiedAt: Date.now(), expiresAt: null },
};

export function isProfileExpired(profile: DisciplineProfile, now = Date.now()): boolean {
  return profile.expiresAt !== null && now > profile.expiresAt;
}

// ─── METIS-809 Journal Profile ────────────────────────────────

export interface JournalProfile {
  journalId: string;
  name: string;
  wordLimit: number;
  abstractWordLimit: number;
  citationStyle: string;
  allowedChartTypes: string[];
  submissionRules: Array<{ rule: string; severity: 'error' | 'warning' }>;
  source: string;
  sourceDate: string;
  version: string;
  verified: boolean;
  expiresAt: number | null;
}

/** A journal rule that is unverified or expired must NOT be presented as a settled fact (METIS-809). */
export function isJournalRuleTrustworthy(profile: JournalProfile, now = Date.now()): boolean {
  if (!profile.verified) return false;
  if (profile.expiresAt !== null && now > profile.expiresAt) return false;
  return true;
}

/** Check a manuscript against the journal's rules. */
export function checkJournalCompliance(profile: JournalProfile, manuscript: { wordCount: number; hasAbstract: boolean; chartTypes: string[] }): Array<{ rule: string; severity: 'error' | 'warning'; passed: boolean }> {
  const results: Array<{ rule: string; severity: 'error' | 'warning'; passed: boolean }> = [];
  if (manuscript.wordCount > profile.wordLimit) {
    results.push({ rule: `字数超限（${manuscript.wordCount}/${profile.wordLimit}）`, severity: 'error', passed: false });
  }
  if (!manuscript.hasAbstract) {
    results.push({ rule: '缺少摘要', severity: 'error', passed: false });
  }
  for (const ct of manuscript.chartTypes) {
    if (!profile.allowedChartTypes.includes(ct)) {
      results.push({ rule: `图表类型 ${ct} 不被该刊允许`, severity: 'warning', passed: false });
    }
  }
  return results;
}
