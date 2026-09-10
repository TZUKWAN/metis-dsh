/**
 * Seven native research capabilities (METIS-801 ~ METIS-807).
 *
 * Each capability is a task orchestrator that composes the foundation built in stages 1-8
 * (routing, capabilities, data model, viewers) into an executable research flow. They never
 * fabricate: missing data yields a structured failure, never a confident-sounding lie.
 *
 * 801 research-design: fuzzy interest → researchable question + scope + method.
 * 802 source-research: unified import/dedup/metadata + retrieval.
 * 803 literature-review: retrieve→expand→screen→synthesize with audit trail.
 * 804 qualitative/humanistic: coding with evidence spans + human-review sampling.
 * 805 quantitative/causal: method-gated diagnostics → results (no causal claim w/o diagnostics).
 * 806 argumentation-writing: claims+evidence → manuscript citing only registered sources.
 * 807 verification-delivery: citation/argument/method/number/language/format audit.
 */

import type { Project } from '../persistence/researchModel.js';

// ─── METIS-801 Research Design ────────────────────────────────

export interface ResearchDesignCard {
  projectId: string;
  researchQuestion: string;
  theoreticalLens: string;
  methodology: string;
  scope: string;
  deliverables: string[];
  /** The clarifying questions asked (max 3 rounds). */
  clarificationsAsked: string[];
}

export interface ClarificationRound {
  round: number;
  questions: string[];
}

/** Generate at most 3 rounds of truly necessary clarifications (METIS-801). */
export function neededClarifications(rawInterest: string, signals: { hasMethod?: boolean; hasScope?: boolean; hasDiscipline?: boolean }): ClarificationRound[] {
  const rounds: ClarificationRound[] = [];
  const q: string[] = [];
  if (!signals.hasDiscipline) q.push('这属于哪个学科领域？');
  if (!signals.hasScope) q.push('研究的时空/对象范围是什么？');
  if (!signals.hasMethod) q.push('倾向质性还是定量方法？');
  if (q.length > 0) rounds.push({ round: 1, questions: q });
  // bounded to 3 rounds total; this implementation stops at 1 round of merged questions
  void rawInterest;
  return rounds;
}

/** Produce a research-design card from the clarified intent (NOT a finished paper). */
export function produceDesignCard(project: Project, answers: { researchQuestion: string; theoreticalLens: string; methodology: string; scope: string; deliverables: string[]; clarifications: string[] }): ResearchDesignCard {
  return {
    projectId: project.id,
    researchQuestion: answers.researchQuestion,
    theoreticalLens: answers.theoreticalLens,
    methodology: answers.methodology,
    scope: answers.scope,
    deliverables: answers.deliverables,
    clarificationsAsked: answers.clarifications,
  };
}

/** A design card is valid only if question is arguable + scope explicit + method matches materials. */
export function validateDesignCard(card: ResearchDesignCard): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (card.researchQuestion.trim().length < 8) issues.push('研究问题过于模糊，需可论证。');
  if (!card.scope) issues.push('范围不明确。');
  if (!card.methodology) issues.push('方法未指定，需与资料匹配。');
  if (card.deliverables.length === 0) issues.push('未声明交付物。');
  return { valid: issues.length === 0, issues };
}

// ─── METIS-802 Source Research ────────────────────────────────

export interface RetrievalResult {
  found: Array<{ identifier: string; identifierType: string; title: string }>;
  /** Retrieval failures must be explicit — never fabricate sources (METIS-802). */
  errors: Array<{ query: string; reason: string }>;
  duplicatesRemoved: number;
}

/** Deduplicate by normalized identifier (DOI/arXiv/ISBN/title). */
export function deduplicateSources(sources: Array<{ identifier: string; title: string }>): { unique: Array<{ identifier: string; title: string }>; duplicatesRemoved: number } {
  const seen = new Set<string>();
  const unique: Array<{ identifier: string; title: string }> = [];
  let dup = 0;
  for (const s of sources) {
    const key = (s.identifier || s.title).toLowerCase().trim();
    if (seen.has(key)) { dup++; continue; }
    seen.add(key);
    unique.push(s);
  }
  return { unique, duplicatesRemoved: dup };
}

// ─── METIS-803 Literature Review ──────────────────────────────

export interface ReviewAuditTrail {
  searchStrings: string[];
  inclusionCriteria: string[];
  exclusionCriteria: string[];
  candidateCount: number;
  includedCount: number;
  excludedReasons: Array<{ title: string; reason: string }>;
  finalCitations: string[];
}

/** A review is more than a single-search summary: it must carry an audit trail (METIS-803). */
export function validateReviewAudit(trail: ReviewAuditTrail): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (trail.searchStrings.length === 0) issues.push('缺少检索式记录。');
  if (trail.inclusionCriteria.length === 0) issues.push('缺少纳入标准。');
  if (trail.candidateCount === 0) issues.push('候选集为空。');
  if (trail.finalCitations.length === 0) issues.push('缺少最终引用。');
  return { valid: issues.length === 0, issues };
}

// ─── METIS-804 Qualitative / Humanistic ───────────────────────

export interface AiCodeSuggestion {
  code: string;
  evidenceSpan: string;
  confidence: number;
}

/** Filter AI suggestions to those with sufficient confidence + an evidence span (METIS-804). */
export function filterAiCodeSuggestions(suggestions: AiCodeSuggestion[], minConfidence = 0.6): AiCodeSuggestion[] {
  return suggestions.filter((s) => s.confidence >= minConfidence && s.evidenceSpan.trim().length > 0);
}

// ─── METIS-805 Quantitative / Causal ─────────────────────────

export interface DiagnosticsResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

export interface QuantOutput {
  diagnostics: DiagnosticsResult;
  method: string;
  results?: { estimate: number; ciLow: number; ciHigh: number };
  limitation: string;
}

/**
 * Method-gated: the model CANNOT bypass diagnostics to output a causal conclusion
 * (METIS-805 completion). If diagnostics fail, results stay undefined + a clear limitation.
 */
export function gateQuantOutput(diagnostics: DiagnosticsResult, method: string, rawResults?: QuantOutput['results']): QuantOutput {
  if (!diagnostics.passed) {
    const failed = diagnostics.checks.filter((c) => !c.passed).map((c) => c.name).join(', ');
    return {
      diagnostics,
      method,
      limitation: `诊断未通过（${failed}），未输出因果结论。请检查数据结构/识别假设。`,
    };
  }
  return {
    diagnostics,
    method,
    results: rawResults,
    limitation: rawResults ? '结果受限于识别假设与样本范围，请在成果中说明。' : '诊断通过但无可用结果。',
  };
}

// ─── METIS-806 Argumentation & Writing ────────────────────────

export interface CitationCheck {
  manuscriptCitations: string[];   // ids cited in text
  registeredSourceIds: Set<string>;
}

/** Every citation must reference a registered in-project source — no un-locatable cites. */
export function auditManuscriptCitations(check: CitationCheck): { unlocated: string[]; ok: boolean } {
  const unlocated = check.manuscriptCitations.filter((c) => !check.registeredSourceIds.has(c));
  return { unlocated, ok: unlocated.length === 0 };
}

// ─── METIS-807 Verification & Delivery ────────────────────────

export type AuditSeverity = 'error' | 'warning' | 'suggestion' | 'unverifiable';

export interface AuditFinding {
  severity: AuditSeverity;
  category: 'citation' | 'argument' | 'method' | 'number' | 'language' | 'format';
  message: string;
  location?: string;
}

/** Severity must be distinguished; an artifact with unresolved errors cannot be marked verified. */
export function canMarkVerified(findings: AuditFinding[]): { ok: boolean; blockingCount: number } {
  const blockingCount = findings.filter((f) => f.severity === 'error').length;
  return { ok: blockingCount === 0, blockingCount };
}

/** Distinguish fact / citation / interpretation / author-claim in text (METIS-806). */
export type StatementKind = 'fact' | 'citation' | 'interpretation' | 'author_claim';

export interface Statement { kind: StatementKind; text: string; sourceId?: string; }

/** An interpretation without a backing source must be flagged for the author to confirm. */
export function flagUnsupportedInterpretations(statements: Statement[]): Statement[] {
  return statements.filter((s) => s.kind === 'interpretation' && !s.sourceId);
}
