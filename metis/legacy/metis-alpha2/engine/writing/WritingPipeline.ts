/**
 * Academic writing pipeline with stage gates and style calibration.
 *
 * Provides deterministic checks for each stage of an academic paper so the
 * AI writing coach can guide the user through outline → introduction →
 * related work → methods → results → discussion → conclusion → polish,
 * rather than dumping a full draft at once.
 */

export type WritingStage =
  | 'outline'
  | 'introduction'
  | 'related_work'
  | 'methods'
  | 'results'
  | 'discussion'
  | 'conclusion'
  | 'polish';

export const STAGE_ORDER: WritingStage[] = [
  'outline',
  'introduction',
  'related_work',
  'methods',
  'results',
  'discussion',
  'conclusion',
  'polish',
];

export interface StageCheckItem {
  criterion: string;
  present: boolean;
  evidence?: string;
}

export interface StageCheckResult {
  stage: WritingStage;
  score: number; // 0–1
  items: StageCheckItem[];
  nextStage?: WritingStage;
  advice: string;
}

export interface MachineTasteIssue {
  type:
    | 'repetitive_opener'
    | 'empty_hedge'
    | 'generic_summary'
    | 'unsupported_superlative'
    | 'bullet_in_prose'
    | 'redundant_pair';
  snippet: string;
  suggestion: string;
}

export interface StyleCalibrationResult {
  readabilityScore: number; // rough 0–1
  issues: MachineTasteIssue[];
  recommendations: string[];
}

const STAGE_CRITERIA: Record<WritingStage, string[]> = {
  outline: [
    'research_question',
    'contribution_statement',
    'section_overview',
    'target_venue_or_audience',
  ],
  introduction: [
    'background_context',
    'problem_statement',
    'contribution_statement',
    'paper_structure_preview',
  ],
  related_work: [
    'theme_organization',
    'gap_identification',
    'key_citations',
  ],
  methods: [
    'materials_or_data',
    'procedure',
    'reproducibility_details',
  ],
  results: [
    'findings_summary',
    'quantitative_or_qualitative_evidence',
    'figure_or_table_references',
  ],
  discussion: [
    'interpretation',
    'limitations',
    'future_work',
  ],
  conclusion: [
    'key_takeaways',
    'impact_statement',
  ],
  polish: [
    'grammar_checked',
    'style_consistency',
    'ai_disclosure',
  ],
};

const CRITERION_DESCRIPTIONS: Record<string, string> = {
  research_question: 'A clear research question or objective is stated.',
  contribution_statement: 'The paper states what is new.',
  section_overview: 'The planned paper structure is listed.',
  target_venue_or_audience: 'Target venue or reader is identified.',
  background_context: 'Background motivates the work.',
  problem_statement: 'A specific problem or gap is identified.',
  paper_structure_preview: 'A brief preview of sections is given.',
  theme_organization: 'Related work is grouped by theme.',
  gap_identification: 'Gaps in prior work are identified.',
  key_citations: 'Key prior papers are cited.',
  materials_or_data: 'Data or materials are described.',
  procedure: 'The methodological procedure is described.',
  reproducibility_details: 'Enough detail is given for reproduction.',
  findings_summary: 'Main findings are summarized.',
  quantitative_or_qualitative_evidence: 'Evidence (numbers, quotes, observations) is reported.',
  figure_or_table_references: 'Figures or tables are referenced.',
  interpretation: 'Findings are interpreted, not just restated.',
  limitations: 'Limitations are acknowledged.',
  future_work: 'Future directions are suggested.',
  key_takeaways: 'Key takeaways are summarized.',
  impact_statement: 'Broader impact or implications are stated.',
  grammar_checked: 'Grammar and spelling are checked.',
  style_consistency: 'Style and terminology are consistent.',
  ai_disclosure: 'AI assistance is disclosed if required by venue policy.',
};

const KEYWORD_HINTS: Record<string, string[]> = {
  research_question: ['research question', 'objective', 'aim', 'goal', 'we ask', 'we investigate'],
  contribution_statement: ['contribution', 'we introduce', 'we propose', 'we present', 'novel', 'new'],
  section_overview: ['outline', 'structure', 'organized', 'sections', 'rest of'],
  target_venue_or_audience: ['venue', 'conference', 'journal', 'readers', 'audience'],
  background_context: ['background', 'recent years', 'in recent', 'has become', 'widely studied'],
  problem_statement: ['however', 'nevertheless', 'yet', 'limitation', 'gap', 'challenge', 'problem'],
  paper_structure_preview: ['paper is organized', 'structure', 'section 2', 'the remainder'],
  theme_organization: ['theme', 'themes', 'stream', 'line of work', 'body of work', 'several studies'],
  gap_identification: ['gap', 'lacks', 'limited', 'few studies', 'little attention', 'not addressed'],
  key_citations: ['et al.', '[', 'doi', 'arxiv'],
  materials_or_data: ['dataset', 'data', 'corpus', 'participants', 'sample', 'materials'],
  procedure: ['procedure', 'pipeline', 'approach', 'method', 'algorithm', 'we first', 'we then'],
  reproducibility_details: ['code', 'available', 'reproduce', 'hyperparameters', 'implementation', 'github'],
  findings_summary: ['found', 'show', 'demonstrate', 'observe', 'results indicate', 'we find'],
  quantitative_or_qualitative_evidence: ['%', 'n=', 'p=', 'accuracy', 'f1', 'bleu', 'significant', 'participants reported'],
  figure_or_table_references: ['figure', 'table', 'fig.', 'tab.'],
  interpretation: ['suggest', 'imply', 'interpret', 'because', 'due to', 'this indicates'],
  limitations: ['limitation', 'limited', 'constraint', 'caveat', 'future work should'],
  future_work: ['future work', 'next steps', 'further research', 'we will'],
  key_takeaways: ['conclude', 'in summary', 'takeaway', 'main findings'],
  impact_statement: ['impact', 'implication', 'broader', 'practitioners', 'society'],
  grammar_checked: ['spelling', 'grammar', 'checked', 'proofread'],
  style_consistency: ['consistent', 'terminology', 'style'],
  ai_disclosure: ['ai', 'assistance', 'disclosure', 'generated', 'language model'],
};

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s[\].%=]/g, ' ').replace(/\s+/g, ' ').trim();
}

function checkCriterion(criterion: string, text: string): { present: boolean; evidence?: string } {
  const lower = normalizeText(text);
  const hints = KEYWORD_HINTS[criterion] ?? [];
  for (const hint of hints) {
    if (lower.includes(hint.toLowerCase())) {
      return { present: true, evidence: `Matched keyword: "${hint}"` };
    }
  }
  return { present: false };
}

/**
 * Check whether a draft satisfies the criteria for a given writing stage.
 */
export function checkStage(stage: WritingStage, text: string): StageCheckResult {
  const criteria = STAGE_CRITERIA[stage];
  const items: StageCheckItem[] = criteria.map((criterion) => {
    const { present, evidence } = checkCriterion(criterion, text);
    return {
      criterion: CRITERION_DESCRIPTIONS[criterion] ?? criterion,
      present,
      evidence,
    };
  });

  const passed = items.filter((i) => i.present).length;
  const score = items.length > 0 ? passed / items.length : 0;

  const currentIndex = STAGE_ORDER.indexOf(stage);
  const nextStage = currentIndex < STAGE_ORDER.length - 1 ? STAGE_ORDER[currentIndex + 1] : undefined;

  const advice = score >= 0.85
    ? `Stage "${stage}" looks solid. Move on to ${nextStage ?? 'final polishing'}.`
    : score >= 0.5
      ? `Stage "${stage}" is partially complete. Address the missing criteria before moving to ${nextStage ?? 'polishing'}.`
      : `Stage "${stage}" is missing most criteria. Draft or revise this section before proceeding.`;

  return { stage, score, items, nextStage, advice };
}

const EMPTY_HEDGES = [
  'it is important to note that',
  'it should be mentioned that',
  'it is worth noting that',
  'needless to say',
  'as a matter of fact',
  'in order to',
  // Common LLM filler / throat-clearing phrases (added round 303).
  // For "role" phrases we match the noun fragment so play/plays/played/playing
  // all match.
  'a crucial role',
  'a vital role',
  'a significant role',
  'a key role',
  'delve into',
  'in today\'s world',
  'in the modern era',
  'it is widely acknowledged that',
  'in the realm of',
];

const GENERIC_SUMMARIES = [
  'in conclusion',
  'to sum up',
  'overall',
  'all in all',
  'in summary',
];

const SUPERLATIVES = [
  'revolutionary',
  'groundbreaking',
  'unprecedented',
  'state-of-the-art',
  'best',
  'first ever',
  // High-frequency LLM superlatives (added round 303).
  'cutting-edge',
  'game-changing',
  'paradigm-shifting',
  'paradigm shifting',
  'pioneering',
  'leading',
];

// Redundant adjective pairs common in LLM prose — two near-synonyms joined by
// "and" that add no information (added round 303).
const REDUNDANT_PAIRS = [
  'novel and innovative',
  'innovative and novel',
  'highly effective and efficient',
  'effective and efficient',
  'efficient and effective',
  'robust and reliable',
  'reliable and robust',
  'comprehensive and thorough',
  'thorough and comprehensive',
  'cutting-edge and novel',
];

function getSentenceOpeners(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const firstWord = s.split(/\s+/)[0];
      return firstWord ? firstWord.toLowerCase() : '';
    })
    .filter(Boolean);
}

/**
 * Detect common machine-generated writing patterns.
 *
 * This is intentionally a lightweight heuristic; it flags symptoms that a
 * human editor should review, without trying to perfectly classify authorship.
 */
export function detectMachineTaste(text: string): MachineTasteIssue[] {
  const issues: MachineTasteIssue[] = [];
  const lower = text.toLowerCase();
  const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);

  // Repetitive sentence openers.
  const openers = getSentenceOpeners(text);
  const counts = new Map<string, number>();
  for (const o of openers) counts.set(o, (counts.get(o) ?? 0) + 1);
  const mostCommon = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (mostCommon && mostCommon[1] >= 4) {
    issues.push({
      type: 'repetitive_opener',
      snippet: mostCommon[0],
      suggestion: `Vary sentence openers; ${mostCommon[0]} starts ${mostCommon[1]} sentences.`,
    });
  }

  // Empty hedges.
  for (const hedge of EMPTY_HEDGES) {
    if (lower.includes(hedge)) {
      issues.push({
        type: 'empty_hedge',
        snippet: hedge,
        suggestion: 'Replace empty hedges with precise claims or remove them.',
      });
    }
  }

  // Generic summaries without nearby specifics.
  for (const phrase of GENERIC_SUMMARIES) {
    const idx = lower.indexOf(phrase);
    if (idx !== -1) {
      const surrounding = text.slice(Math.max(0, idx - 30), idx + phrase.length + 60);
      const hasNumber = /\d|%|et al\.|figure|table/i.test(surrounding);
      if (!hasNumber) {
        issues.push({
          type: 'generic_summary',
          snippet: phrase,
          suggestion: 'Add concrete numbers, citations, or references to figures/tables.',
        });
      }
    }
  }

  // Unsupported superlatives.
  for (const word of SUPERLATIVES) {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    if (regex.test(text)) {
      issues.push({
        type: 'unsupported_superlative',
        snippet: word,
        suggestion: 'Either cite evidence for the superlative or soften the claim.',
      });
    }
  }

  // Redundant adjective pairs (e.g. "novel and innovative") that add no
  // information beyond a single word. Added round 303.
  for (const pair of REDUNDANT_PAIRS) {
    if (lower.includes(pair)) {
      issues.push({
        type: 'redundant_pair',
        snippet: pair,
        suggestion: 'Two near-synonyms joined by "and" add no information; pick one.',
      });
    }
  }

  // Bullet-like lists embedded in prose.
  for (const sentence of sentences) {
    if (/^\s*(first|second|third|fourth|fifth|finally|moreover|furthermore|in addition)[,\s]/i.test(sentence)) {
      issues.push({
        type: 'bullet_in_prose',
        snippet: sentence.slice(0, 60),
        suggestion: 'Consider using a list or tighter transitions instead of enumerated prose.',
      });
    }
  }

  return issues.slice(0, 8);
}

function averageSentenceLength(text: string): number {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  if (sentences.length === 0) return 0;
  const words = text.split(/\s+/).filter(Boolean).length;
  return words / sentences.length;
}

/**
 * Calibrate style: return a readability score and concrete recommendations.
 */
export function calibrateStyle(text: string): StyleCalibrationResult {
  const avgLen = averageSentenceLength(text);
  const issues = detectMachineTaste(text);
  const recommendations: string[] = [];

  if (avgLen > 25) {
    recommendations.push(`Average sentence length is ${avgLen.toFixed(1)} words; consider breaking long sentences.`);
  }
  if (avgLen < 10 && text.length > 200) {
    recommendations.push('Sentences are very short; check whether the prose is choppy.');
  }
  if (issues.some((i) => i.type === 'empty_hedge')) {
    recommendations.push('Remove empty hedges that do not add meaning.');
  }
  if (issues.some((i) => i.type === 'unsupported_superlative')) {
    recommendations.push('Support or soften superlative claims.');
  }
  if (issues.some((i) => i.type === 'repetitive_opener')) {
    recommendations.push('Vary sentence openers to improve flow.');
  }
  if (issues.some((i) => i.type === 'redundant_pair')) {
    recommendations.push('Collapse redundant adjective pairs to a single precise word.');
  }

  const readabilityScore = Math.max(0, Math.min(1, 1 - issues.length * 0.1 - Math.max(0, avgLen - 20) * 0.01));

  return { readabilityScore, issues, recommendations };
}

/**
 * Convert a stage check result into a plain object for tool output.
 */
export function stageResultToPlain(result: StageCheckResult): Record<string, unknown> {
  return {
    stage: result.stage,
    score: Number(result.score.toFixed(2)),
    nextStage: result.nextStage,
    advice: result.advice,
    items: result.items.map((i) => ({
      criterion: i.criterion,
      present: i.present,
      evidence: i.evidence,
    })),
  };
}

/**
 * Convert a style calibration result into a plain object for tool output.
 */
export function styleResultToPlain(result: StyleCalibrationResult): Record<string, unknown> {
  return {
    readabilityScore: Number(result.readabilityScore.toFixed(2)),
    issueCount: result.issues.length,
    issues: result.issues,
    recommendations: result.recommendations,
  };
}
