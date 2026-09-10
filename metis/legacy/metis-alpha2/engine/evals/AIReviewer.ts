/**
 * Heuristic Review Engine — multi-perspective heuristic paper review.
 *
 * Generates structured review feedback from different reviewer personas,
 * each focusing on different aspects of the paper (methodology, clarity,
 * novelty, experimental rigor, presentation).
 *
 * NOTE: This engine uses rule-based heuristics (word counts, keyword matching,
 * structural checks) — NOT AI/LLM. It provides fast, deterministic reviews.
 * For LLM-powered deep analysis, integrate with AgentLoop separately.
 */

import { HookBus, type HookContext } from '../core/HookBus.js';

// ─── Review Types ────────────────────────────────────────────────

export interface PaperSubmission {
  title: string;
  abstract: string;
  sections: PaperSection[];
  authors: string[];
  keywords: string[];
  venue?: string;
  year?: number;
}

export interface PaperSection {
  type: 'introduction' | 'methodology' | 'results' | 'discussion' | 'related_work' | 'conclusion' | 'abstract' | 'other';
  title: string;
  content: string;
}

export interface ReviewCriterion {
  name: string;
  score: number;       // 1-10
  maxScore: number;
  comment: string;
  suggestions: string[];
}

export interface ReviewReport {
  reviewerId: string;
  reviewerPersona: ReviewerPersona;
  overallScore: number;  // weighted average 1-10
  confidence: number;    // 1-5
  summary: string;
  strengths: string[];
  weaknesses: string[];
  criteria: ReviewCriterion[];
  questions: string[];
  recommendation: 'accept' | 'weak_accept' | 'borderline' | 'weak_reject' | 'reject';
  detailedComments: string;
  timestamp: number;
}

export type ReviewerPersona = 'methodologist' | 'clarity_reviewer' | 'novelty_expert' | 'experimentalist' | 'domain_expert';

export interface ReviewSession {
  id: string;
  submission: PaperSubmission;
  reports: ReviewReport[];
  metaReview: MetaReview;
  status: 'pending' | 'in_review' | 'completed';
  createdAt: number;
  completedAt?: number;
}

export interface MetaReview {
  overallRecommendation: 'accept' | 'weak_accept' | 'borderline' | 'weak_reject' | 'reject';
  consensusScore: number;
  agreement: number;  // 0-1 how much reviewers agree
  keyIssues: string[];
  decisionRationale: string;
}

// ─── Reviewer Persona Definitions ────────────────────────────────

interface PersonaDefinition {
  id: ReviewerPersona;
  name: string;
  focus: string;
  criteriaWeights: Record<string, number>;
  evaluationBiases: Record<string, number>;
}

const PERSONAS: PersonaDefinition[] = [
  {
    id: 'methodologist',
    name: 'Dr. Methodology',
    focus: 'Research methodology, experimental design, statistical validity',
    criteriaWeights: { methodology: 0.35, experimental_rigor: 0.25, clarity: 0.15, novelty: 0.15, presentation: 0.10 },
    evaluationBiases: { has_methodology_section: 1.5, has_baselines: 1.3, has_ablation: 1.2 },
  },
  {
    id: 'clarity_reviewer',
    name: 'Dr. Clarity',
    focus: 'Writing quality, logical flow, reproducibility of descriptions',
    criteriaWeights: { clarity: 0.35, presentation: 0.25, methodology: 0.15, experimental_rigor: 0.15, novelty: 0.10 },
    evaluationBiases: { section_structure: 1.4, abstract_quality: 1.3, has_figures_mentioned: 1.1 },
  },
  {
    id: 'novelty_expert',
    name: 'Dr. Novelty',
    focus: 'Contribution novelty, significance, advancement over prior work',
    criteriaWeights: { novelty: 0.40, methodology: 0.20, experimental_rigor: 0.20, clarity: 0.10, presentation: 0.10 },
    evaluationBiases: { has_related_work: 1.4, claims_supported: 1.3, has_comparison: 1.2 },
  },
  {
    id: 'experimentalist',
    name: 'Dr. Experiments',
    focus: 'Experimental design, baselines, ablation studies, statistical significance',
    criteriaWeights: { experimental_rigor: 0.40, methodology: 0.20, novelty: 0.15, clarity: 0.15, presentation: 0.10 },
    evaluationBiases: { has_results_section: 1.5, has_baselines: 1.4, has_ablation: 1.3, has_error_bars: 1.2 },
  },
  {
    id: 'domain_expert',
    name: 'Dr. Domain',
    focus: 'Domain relevance, practical impact, correctness of domain-specific claims',
    criteriaWeights: { novelty: 0.25, methodology: 0.25, experimental_rigor: 0.20, clarity: 0.15, presentation: 0.15 },
    evaluationBiases: { keyword_relevance: 1.3, practical_impact: 1.4 },
  },
];

const CRITERIA_NAMES = ['methodology', 'experimental_rigor', 'clarity', 'novelty', 'presentation'] as const;

// ─── Heuristic Evaluation Engine ─────────────────────────────────

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function hasKeyword(content: string, keywords: string[]): boolean {
  const lower = content.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

function countKeywordOccurrences(content: string, keywords: string[]): number {
  const lower = content.toLowerCase();
  let count = 0;
  for (const kw of keywords) {
    const regex = new RegExp(kw.toLowerCase(), 'gi');
    const matches = lower.match(regex);
    if (matches) count += matches.length;
  }
  return count;
}

function getSectionByType(submission: PaperSubmission, type: PaperSection['type']): PaperSection | undefined {
  return submission.sections.find((s) => s.type === type);
}

function evaluateMethodology(submission: PaperSubmission): { score: number; comment: string; suggestions: string[] } {
  const suggestions: string[] = [];
  let score = 5; // baseline

  const methodSection = getSectionByType(submission, 'methodology');
  if (!methodSection) {
    suggestions.push('Add a dedicated methodology section to clearly describe your approach.');
    return { score: 2, comment: 'No methodology section found.', suggestions };
  }

  const wordCount = countWords(methodSection.content);
  if (wordCount < 100) {
    score -= 2;
    suggestions.push('The methodology section is very short. Provide more detail on your approach.');
  } else if (wordCount < 300) {
    score -= 1;
    suggestions.push('Consider expanding the methodology section with more implementation details.');
  } else if (wordCount >= 300 && wordCount < 800) {
    score += 1;
  } else if (wordCount >= 800) {
    score += 2;
  }

  // Check for key methodology indicators
  const methodKeywords = ['algorithm', 'approach', 'model', 'architecture', 'framework', 'pipeline', 'procedure', 'design'];
  const foundKeywords = methodKeywords.filter((kw) => hasKeyword(methodSection.content, [kw]));
  score += Math.min(foundKeywords.length, 3);

  // Check for mathematical formulations
  if (hasKeyword(methodSection.content, ['equation', 'formula', 'mathematically', 'theorem', 'lemma', 'proof'])) {
    score += 1;
  }

  // Check for assumptions/limitations
  if (hasKeyword(methodSection.content, ['assumption', 'limitation', 'constraint', 'condition'])) {
    score += 1;
  } else {
    suggestions.push('Explicitly state assumptions and limitations of your methodology.');
  }

  const comment = wordCount < 100
    ? 'Methodology section lacks sufficient detail.'
    : wordCount < 300
      ? 'Methodology is present but could be more detailed.'
      : 'Methodology section is well-structured and detailed.';

  return { score: Math.max(1, Math.min(10, score)), comment, suggestions };
}

function evaluateExperimentalRigor(submission: PaperSubmission): { score: number; comment: string; suggestions: string[] } {
  const suggestions: string[] = [];
  let score = 5;

  const resultsSection = getSectionByType(submission, 'results');
  if (!resultsSection) {
    suggestions.push('Add a results section presenting experimental outcomes.');
    return { score: 2, comment: 'No results section found.', suggestions };
  }

  const wordCount = countWords(resultsSection.content);
  if (wordCount < 100) {
    score -= 2;
    suggestions.push('Results section needs significantly more experimental evidence.');
  } else if (wordCount >= 400) {
    score += 2;
  } else if (wordCount >= 200) {
    score += 1;
  }

  // Check for baselines
  if (hasKeyword(resultsSection.content, ['baseline', 'comparison', 'versus', 'compared to', 'outperform'])) {
    score += 2;
  } else {
    suggestions.push('Include comparisons with baseline methods to demonstrate improvement.');
  }

  // Check for ablation studies
  if (hasKeyword(resultsSection.content, ['ablation', 'component analysis', 'contribution', 'variant'])) {
    score += 1;
  } else {
    suggestions.push('Consider adding ablation studies to analyze component contributions.');
  }

  // Check for statistical significance
  if (hasKeyword(resultsSection.content, ['significance', 'p-value', 'confidence interval', 'error bar', 'standard deviation', 'variance'])) {
    score += 1;
  } else {
    suggestions.push('Report statistical significance or error margins for experimental results.');
  }

  // Check for datasets
  if (hasKeyword(resultsSection.content, ['dataset', 'benchmark', 'corpus', 'evaluation set'])) {
    score += 1;
  } else {
    suggestions.push('Clearly specify the datasets or benchmarks used for evaluation.');
  }

  // Check for metrics
  if (hasKeyword(resultsSection.content, ['accuracy', 'precision', 'recall', 'f1', 'bleu', 'rouge', 'metric', 'score', 'performance'])) {
    score += 1;
  }

  const comment = score >= 7
    ? 'Experiments are well-designed with appropriate baselines and metrics.'
    : score >= 5
      ? 'Experimental evaluation is present but could be strengthened.'
      : 'Experimental evaluation needs significant improvement.';

  return { score: Math.max(1, Math.min(10, score)), comment, suggestions };
}

function evaluateClarity(submission: PaperSubmission): { score: number; comment: string; suggestions: string[] } {
  const suggestions: string[] = [];
  let score = 5;

  // Abstract quality
  const abstractWords = countWords(submission.abstract);
  if (abstractWords < 50) {
    score -= 2;
    suggestions.push('Abstract is too short. A good abstract should be 150-300 words.');
  } else if (abstractWords < 100) {
    score -= 1;
    suggestions.push('Consider expanding the abstract to better summarize contributions.');
  } else if (abstractWords >= 150 && abstractWords <= 300) {
    score += 2;
  } else if (abstractWords > 400) {
    score -= 1;
    suggestions.push('Abstract is too long. Aim for 150-300 words.');
  }

  // Section completeness
  const sectionTypes = new Set(submission.sections.map((s) => s.type));
  const expectedSections = ['introduction', 'methodology', 'results', 'discussion', 'conclusion'];
  const missingSections = expectedSections.filter((s) => !sectionTypes.has(s as PaperSection['type']));
  if (missingSections.length > 0) {
    score -= missingSections.length;
    suggestions.push(`Consider adding ${missingSections.join(', ')} section(s).`);
  } else {
    score += 2;
  }

  // Title quality
  if (submission.title.length < 10) {
    score -= 1;
    suggestions.push('Title seems too short. Use a descriptive title.');
  } else if (submission.title.length > 100) {
    score -= 1;
    suggestions.push('Title is very long. Consider making it more concise.');
  }

  // Check for structural indicators
  const allContent = submission.sections.map((s) => s.content).join(' ');
  if (hasKeyword(allContent, ['first', 'second', 'finally', 'in summary', 'in conclusion', 'furthermore', 'moreover'])) {
    score += 1;
  }

  const comment = score >= 7
    ? 'The paper is well-written with clear structure.'
    : score >= 5
      ? 'Writing is readable but structural improvements would help.'
      : 'Paper needs significant improvements in clarity and organization.';

  return { score: Math.max(1, Math.min(10, score)), comment, suggestions };
}

function evaluateNovelty(submission: PaperSubmission): { score: number; comment: string; suggestions: string[] } {
  const suggestions: string[] = [];
  let score = 5;

  // Check for related work section
  const relatedWork = getSectionByType(submission, 'related_work');
  if (relatedWork) {
    const rwWords = countWords(relatedWork.content);
    if (rwWords >= 200) {
      score += 1;
    }
    // Check if related work compares with specific works
    if (hasKeyword(relatedWork.content, ['unlike', 'different from', 'improves upon', 'extends', 'in contrast to', 'distinct from'])) {
      score += 1;
    }
  } else {
    suggestions.push('Add a related work section to position your contribution among existing research.');
  }

  // Check for novelty claims
  const introSection = getSectionByType(submission, 'introduction');
  if (introSection) {
    const noveltyTerms = ['novel', 'first', 'new', 'unique', 'original', 'innovative', 'pioneering', 'contribution'];
    const noveltyCount = countKeywordOccurrences(introSection.content, noveltyTerms);
    if (noveltyCount >= 3) {
      score += 2;
    } else if (noveltyCount >= 1) {
      score += 1;
    } else {
      suggestions.push('Explicitly state the novel contributions of your work in the introduction.');
    }
  }

  // Check for contributions list
  if (hasKeyword(submission.abstract, ['contribution', 'we propose', 'we introduce', 'we present', 'our contribution'])) {
    score += 1;
  }

  const comment = score >= 7
    ? 'The paper makes a clear and significant novel contribution.'
    : score >= 5
      ? 'Novelty is present but could be more clearly articulated.'
      : 'The novelty of the contribution needs stronger justification.';

  return { score: Math.max(1, Math.min(10, score)), comment, suggestions };
}

function evaluatePresentation(submission: PaperSubmission): { score: number; comment: string; suggestions: string[] } {
  const suggestions: string[] = [];
  let score = 5;

  // Overall word count check
  const totalWords = countWords(submission.abstract) + submission.sections.reduce((sum, s) => sum + countWords(s.content), 0);
  if (totalWords < 1000) {
    score -= 2;
    suggestions.push('The paper is very short. Research papers typically need 4000-8000 words.');
  } else if (totalWords < 3000) {
    score -= 1;
    suggestions.push('Consider adding more content for a complete research paper.');
  } else if (totalWords >= 4000 && totalWords <= 8000) {
    score += 2;
  } else if (totalWords > 10000) {
    score -= 1;
    suggestions.push('The paper is very long. Consider tightening the presentation.');
  }

  // Keywords
  if (submission.keywords.length >= 3) {
    score += 1;
  } else if (submission.keywords.length === 0) {
    suggestions.push('Add keywords to improve discoverability.');
  }

  // Section titles quality
  const goodTitlePattern = /^(introduction|background|related work|method|methodology|approach|experiment|evaluation|results|discussion|conclusion|abstract|limitation|future work)/i;
  const wellNamedSections = submission.sections.filter((s) => goodTitlePattern.test(s.title)).length;
  if (wellNamedSections >= 4) {
    score += 1;
  }

  const comment = score >= 7
    ? 'The paper is well-presented with good structure and length.'
    : score >= 5
      ? 'Presentation is adequate but could be improved.'
      : 'Presentation needs significant improvement in structure and content.';

  return { score: Math.max(1, Math.min(10, score)), comment, suggestions };
}

// ─── Review Generation ───────────────────────────────────────────

type CriterionEvaluator = (submission: PaperSubmission) => { score: number; comment: string; suggestions: string[] };

const CRITERIA_EVALUATORS: Record<string, CriterionEvaluator> = {
  methodology: evaluateMethodology,
  experimental_rigor: evaluateExperimentalRigor,
  clarity: evaluateClarity,
  novelty: evaluateNovelty,
  presentation: evaluatePresentation,
};

function computeRecommendation(score: number): ReviewReport['recommendation'] {
  if (score >= 8) return 'accept';
  if (score >= 6.5) return 'weak_accept';
  if (score >= 5) return 'borderline';
  if (score >= 3.5) return 'weak_reject';
  return 'reject';
}

function generateDetailedComments(report: ReviewReport): string {
  const lines: string[] = [];

  lines.push(`## Review by ${report.reviewerPersona}`);
  lines.push(`**Overall Score: ${report.overallScore.toFixed(1)}/10**`);
  lines.push(`**Recommendation: ${report.recommendation.replace('_', ' ').toUpperCase()}**`);
  lines.push('');

  lines.push('### Summary');
  lines.push(report.summary);
  lines.push('');

  if (report.strengths.length > 0) {
    lines.push('### Strengths');
    for (const s of report.strengths) lines.push(`- ${s}`);
    lines.push('');
  }

  if (report.weaknesses.length > 0) {
    lines.push('### Weaknesses');
    for (const w of report.weaknesses) lines.push(`- ${w}`);
    lines.push('');
  }

  if (report.criteria.length > 0) {
    lines.push('### Detailed Scores');
    for (const c of report.criteria) {
      lines.push(`- **${c.name}**: ${c.score}/${c.maxScore} — ${c.comment}`);
      for (const s of c.suggestions) lines.push(`  - [建议] ${s}`);
    }
    lines.push('');
  }

  if (report.questions.length > 0) {
    lines.push('### Questions for Authors');
    for (const q of report.questions) lines.push(`- ${q}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── AI Reviewer Engine ──────────────────────────────────────────

/** @deprecated Use HeuristicReviewer — this class does NOT use AI, only heuristics */
export class AIReviewer {
  private readonly hooks: HookBus;
  private readonly sessions = new Map<string, ReviewSession>();

  constructor(hooks?: HookBus) {
    this.hooks = hooks ?? new HookBus();
  }

  /**
   * Run a full multi-perspective review on a paper submission.
   * Each reviewer persona evaluates the paper independently.
   */
  async review(
    submission: PaperSubmission,
    options?: {
      personas?: ReviewerPersona[];
      sessionId?: string;
    },
  ): Promise<ReviewSession> {
    const sessionId = options?.sessionId ?? `review-${Date.now()}`;
    const personas = options?.personas ?? ['methodologist', 'clarity_reviewer', 'novelty_expert', 'experimentalist', 'domain_expert'];

    const session: ReviewSession = {
      id: sessionId,
      submission,
      reports: [],
      metaReview: {
        overallRecommendation: 'borderline',
        consensusScore: 0,
        agreement: 0,
        keyIssues: [],
        decisionRationale: '',
      },
      status: 'in_review',
      createdAt: Date.now(),
    };

    this.sessions.set(sessionId, session);

    await this.hooks.emitAsync('review.start', { sessionId, title: submission.title } as unknown as HookContext);

    // Generate individual reviews
    for (const personaId of personas) {
      const persona = PERSONAS.find((p) => p.id === personaId);
      if (!persona) continue;

      const report = this.generateReview(submission, persona);
      session.reports.push(report);

      await this.hooks.emitAsync('review.report_generated', {
        sessionId,
        reviewerId: report.reviewerId,
        score: report.overallScore,
        recommendation: report.recommendation,
      } as unknown as HookContext);
    }

    // Generate meta-review
    session.metaReview = this.generateMetaReview(session.reports);
    session.status = 'completed';
    session.completedAt = Date.now();

    await this.hooks.emitAsync('review.complete', {
      sessionId,
      recommendation: session.metaReview.overallRecommendation,
      consensusScore: session.metaReview.consensusScore,
    } as unknown as HookContext);

    return session;
  }

  /**
   * Generate a single review from a specific persona.
   */
  generateReview(submission: PaperSubmission, persona: PersonaDefinition): ReviewReport {
    const criteria: ReviewCriterion[] = [];

    for (const criterionName of CRITERIA_NAMES) {
      const evaluator = CRITERIA_EVALUATORS[criterionName];
      if (!evaluator) continue;

      const result = evaluator(submission);
      criteria.push({
        name: criterionName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        score: result.score,
        maxScore: 10,
        comment: result.comment,
        suggestions: result.suggestions,
      });
    }

    // Compute weighted overall score
    let weightedSum = 0;
    let weightTotal = 0;
    for (const criterion of criteria) {
      const criterionKey = criterion.name.toLowerCase().replace(/ /g, '_');
      const weight = persona.criteriaWeights[criterionKey] ?? 0.2;
      weightedSum += criterion.score * weight;
      weightTotal += weight;
    }

    const overallScore = weightTotal > 0 ? weightedSum / weightTotal : 5;

    // Extract strengths and weaknesses from criteria
    const strengths: string[] = [];
    const weaknesses: string[] = [];
    const questions: string[] = [];

    for (const criterion of criteria) {
      if (criterion.score >= 7) {
        strengths.push(`${criterion.name}: ${criterion.comment}`);
      } else if (criterion.score <= 4) {
        weaknesses.push(`${criterion.name}: ${criterion.comment}`);
      }
    }

    // Generate questions based on missing elements
    const allContent = submission.sections.map((s) => s.content).join(' ').toLowerCase();
    if (!allContent.includes('limitation')) {
      questions.push('What are the main limitations of your approach?');
    }
    if (!allContent.includes('future work') && !allContent.includes('future direction')) {
      questions.push('What are the potential directions for future work?');
    }
    if (!allContent.includes('reproducib') && !allContent.includes('code available')) {
      questions.push('Will the code and data be made publicly available for reproducibility?');
    }

    const summary = `This review by ${persona.name} focuses on ${persona.focus}. ` +
      `The paper "${submission.title}" receives an overall score of ${overallScore.toFixed(1)}/10. ` +
      (strengths.length > 0 ? `Key strengths include ${strengths.slice(0, 2).join('; ')}. ` : '') +
      (weaknesses.length > 0 ? `Main concerns: ${weaknesses.slice(0, 2).join('; ')}.` : 'No major weaknesses identified.');

    const report: ReviewReport = {
      reviewerId: persona.id,
      reviewerPersona: persona.id,
      overallScore: Math.round(overallScore * 10) / 10,
      confidence: Math.min(5, Math.max(1, Math.round(overallScore / 2))),
      summary,
      strengths,
      weaknesses,
      criteria,
      questions,
      recommendation: computeRecommendation(overallScore),
      detailedComments: '',
      timestamp: Date.now(),
    };

    report.detailedComments = generateDetailedComments(report);

    return report;
  }

  /**
   * Generate a meta-review that synthesizes all individual reviews.
   */
  generateMetaReview(reports: ReviewReport[]): MetaReview {
    if (reports.length === 0) {
      return {
        overallRecommendation: 'reject',
        consensusScore: 0,
        agreement: 0,
        keyIssues: [],
        decisionRationale: 'No reviews generated.',
      };
    }

    // Compute consensus score (average)
    const consensusScore = Math.round(
      (reports.reduce((sum, r) => sum + r.overallScore, 0) / reports.length) * 10,
    ) / 10;

    // Compute agreement (inverse of score variance, normalized 0-1)
    const mean = consensusScore;
    const variance = reports.reduce((sum, r) => sum + (r.overallScore - mean) ** 2, 0) / reports.length;
    const agreement = Math.max(0, Math.min(1, 1 - variance / 10));

    // Collect key issues (most mentioned weaknesses)
    const issueCounts = new Map<string, number>();
    for (const report of reports) {
      for (const weakness of report.weaknesses) {
        // Simplify weakness to a key phrase
        const key = weakness.split(':')[0] ?? weakness.slice(0, 50);
        issueCounts.set(key, (issueCounts.get(key) ?? 0) + 1);
      }
    }

    const keyIssues = [...issueCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([issue]) => issue);

    // Determine overall recommendation
    const recommendations = reports.map((r) => r.recommendation);
    const recScores: Record<string, number> = {
      accept: 5,
      weak_accept: 4,
      borderline: 3,
      weak_reject: 2,
      reject: 1,
    };
    const avgRecScore = recommendations.reduce((sum, r) => sum + (recScores[r] ?? 3), 0) / recommendations.length;

    let overallRecommendation: MetaReview['overallRecommendation'];
    if (avgRecScore >= 4.5) overallRecommendation = 'accept';
    else if (avgRecScore >= 3.5) overallRecommendation = 'weak_accept';
    else if (avgRecScore >= 2.5) overallRecommendation = 'borderline';
    else if (avgRecScore >= 1.5) overallRecommendation = 'weak_reject';
    else overallRecommendation = 'reject';

    // Decision rationale
    const acceptedCount = reports.filter((r) => r.recommendation === 'accept' || r.recommendation === 'weak_accept').length;
    const rejectedCount = reports.filter((r) => r.recommendation === 'reject' || r.recommendation === 'weak_reject').length;

    const decisionRationale = reports.length === 0
      ? 'No reviews available.'
      : `${acceptedCount}/${reports.length} reviewers lean accept, ${rejectedCount}/${reports.length} lean reject. ` +
        `Consensus score: ${consensusScore.toFixed(1)}/10. Agreement: ${(agreement * 100).toFixed(0)}%. ` +
        (keyIssues.length > 0 ? `Key concerns: ${keyIssues.join('; ')}.` : 'No major concerns raised.');

    return {
      overallRecommendation,
      consensusScore,
      agreement,
      keyIssues,
      decisionRationale,
    };
  }

  /** Get a review session by ID. */
  getSession(id: string): ReviewSession | undefined {
    return this.sessions.get(id);
  }

  /** List all review sessions. */
  listSessions(): ReviewSession[] {
    return [...this.sessions.values()];
  }

  /** Get available persona definitions. */
  getPersonas(): PersonaDefinition[] {
    return [...PERSONAS];
  }
}

/** Canonical name — this class uses heuristics, not AI */
export const HeuristicReviewer = AIReviewer;
