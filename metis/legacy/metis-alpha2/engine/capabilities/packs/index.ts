/**
 * The seven native capability packs (METIS-203).
 *
 * Each pack is a thin manifest: it registers a task template, tool references, and method
 * rules — it does NOT copy any complete external repository (ADR-001 §11, METIS-201).
 *
 * This registry is the single place that defines the seven first-class capabilities. The
 * exported SEVEN_CAPABILITY_PACKS array MUST contain exactly seven entries; the test in
 * packs.test.ts enforces that invariant (METIS-203 completion: "the product layer has no
 * eighth first-class capability").
 */

import type { CapabilityManifest } from '../types.js';

// ─── Pack 1: Research Design (METIS-801) ──────────────────────

const researchDesign: CapabilityManifest = {
  id: 'research-design',
  name: '研究设计',
  version: '1.0.0',
  description: 'From a fuzzy interest, form a researchable question, scope, theoretical lens, method, and deliverable. Absorbs humanities-thesis-skill questioning ideas (process only).',
  stages: ['design'],
  disciplines: ['literature', 'history', 'philosophy', 'sociology', 'political_science', 'public_administration', 'communication', 'education', 'law', 'economics', 'interdisciplinary'],
  inputs: [
    { name: 'interest', type: 'string', required: true, description: 'Fuzzy research interest or topic' },
  ],
  outputs: [
    { name: 'research_design_card', type: 'Artifact<research_design>', description: 'A modifiable design card, NOT a finished paper' },
  ],
  permissions: ['read_source', 'search_web'],
  dependencies: [],
  producesArtifacts: ['research_design_card'],
  visualization: 'none',
  source: {
    origin: 'internal',
    repository: 'metis',
    license: 'internal',
    licenseEvidence: 'Authored inside Metis. Process ideas inspired by ganzhi-black/humanities-thesis-skill (MIT, METIS-201 #1); no code/prompt copied.',
  },
  limitations: ['At most three rounds of truly necessary clarification.', 'Cannot replace researcher judgement on final scope.'],
};

// ─── Pack 2: Source Research (METIS-802) ──────────────────────

const sourceResearch: CapabilityManifest = {
  id: 'source-research',
  name: '资料研究',
  version: '1.0.0',
  description: 'Unified import, retrieval, dedup, metadata completion, and evidence extraction for papers/books/archives/web/interviews/audio/data.',
  stages: ['source_research'],
  disciplines: ['interdisciplinary'],
  inputs: [
    { name: 'query_or_seed', type: 'string|Source[]', required: true, description: 'Search query or seed materials' },
  ],
  outputs: [
    { name: 'sources', type: 'Source[]', description: 'Deduplicated, metadata-complete sources' },
  ],
  permissions: ['read_source', 'search_web', 'write_file'],
  dependencies: [],
  producesArtifacts: [],
  visualization: 'none',
  source: {
    origin: 'internal',
    repository: 'metis',
    license: 'internal',
    licenseEvidence: 'Authored inside Metis. Uses existing academic tools (OpenAlex/Crossref/Semantic Scholar/arXiv). No third-party code copied.',
  },
  limitations: ['Must never fabricate sources; retrieval failures must be explicit.', 'CNKI auto-login/bulk download deferred (ADR-001 §10).'],
};

// ─── Pack 3: Literature Review (METIS-803) ────────────────────

const literatureReview: CapabilityManifest = {
  id: 'literature-review',
  name: '文献综述',
  version: '1.0.0',
  description: 'Retrieve, expand, screen, read, classify, synthesize, and citation-verify. Borrows LitReviewSkill PROCESS ONLY (no license => no code/prompt copied).',
  stages: ['literature_review'],
  disciplines: ['interdisciplinary'],
  inputs: [
    { name: 'review_question', type: 'string', required: true, description: 'The review question' },
  ],
  outputs: [
    { name: 'synthesis', type: 'Artifact<literature_review>', description: 'A synthesis with audit trail, not a single-search summary' },
  ],
  permissions: ['read_source', 'search_web', 'write_file'],
  dependencies: [],
  producesArtifacts: ['literature_review'],
  visualization: 'none',
  source: {
    origin: 'internal',
    repository: 'metis',
    license: 'internal',
    licenseEvidence: 'Authored inside Metis. Process inspired by Zsun79/LitReviewSkill which has NO license — only the process idea is borrowed, no code or prompt text is copied (METIS-201 #4).',
  },
  limitations: ['Must save search strings, inclusion/exclusion criteria, candidate set, exclusion reasons, final citations.'],
};

// ─── Pack 4: Qualitative & Humanistic Analysis (METIS-804) ────

const qualitativeAnalysis: CapabilityManifest = {
  id: 'qualitative-analysis',
  name: '质性与人文分析',
  version: '1.0.0',
  description: 'Close reading, historical source criticism, thematic coding, discourse/narrative analysis, case comparison. Maps GABRIEL classify/extract/codify/compare into unified tasks.',
  stages: ['qualitative_analysis'],
  disciplines: ['literature', 'history', 'sociology', 'communication', 'education', 'political_science'],
  inputs: [
    { name: 'corpus', type: 'Source[]', required: true, description: 'Texts/contacts/archives to analyze' },
  ],
  outputs: [
    { name: 'codes_claims', type: 'NoteCode[]|Claim[]', description: 'Codes/claims with evidence spans and confidence' },
  ],
  permissions: ['read_source', 'access_sensitive', 'write_file'],
  dependencies: [
    { name: 'gabriel-runtime', kind: 'runtime', required: false },
  ],
  producesArtifacts: ['coding_book', 'theme_analysis'],
  visualization: 'network',
  source: {
    origin: 'third_party',
    repository: 'openai/GABRIEL',
    commit: 'main',
    license: 'Apache-2.0',
    licenseEvidence: 'LICENSE file Apache 2.0 (verified 2026-07-24, METIS-201 #2). Adapter layer only; isolated runtime.',
    registerEntry: '#2',
  },
  limitations: ['AI coding must output evidence spans and confidence.', 'Human-review sampling flow is mandatory; AI suggestion vs human confirm strictly separated.'],
};

// ─── Pack 5: Quantitative & Causal Analysis (METIS-805) ───────

const quantitativeAnalysis: CapabilityManifest = {
  id: 'quantitative-analysis',
  name: '定量与因果分析',
  version: '1.0.0',
  description: 'Method-constrained descriptive stats, regression, causal inference. Selects only necessary methods — does NOT integrate all 1094 skills. Adapts StatsPAI.',
  stages: ['quantitative_analysis'],
  disciplines: ['economics', 'sociology', 'political_science', 'public_administration', 'education'],
  inputs: [
    { name: 'dataset', type: 'Source<data>', required: true, description: 'Structured dataset' },
  ],
  outputs: [
    { name: 'results', type: 'Artifact<quant_results>', description: 'Diagnostics + code + results + charts + limitations' },
  ],
  permissions: ['read_source', 'execute_code', 'write_file'],
  dependencies: [
    { name: 'statspai-runtime', kind: 'runtime', required: false },
  ],
  producesArtifacts: ['quant_results', 'chart'],
  visualization: 'chart',
  source: {
    origin: 'third_party',
    repository: 'brycewang-stanford/StatsPAI',
    commit: 'main',
    license: 'MIT',
    licenseEvidence: 'MIT badge + LICENSE (verified 2026-07-24, METIS-201 #3). Adapter layer; isolated runtime.',
    registerEntry: '#3',
  },
  limitations: ['Method choice MUST check data structure, identification assumptions, applicability before running.', 'Model cannot bypass diagnostics to output a causal conclusion.'],
};

// ─── Pack 6: Argumentation & Writing (METIS-806) ──────────────

const argumentationWriting: CapabilityManifest = {
  id: 'argumentation-writing',
  name: '论证与写作',
  version: '1.0.0',
  description: 'Generate structured, auditable academic artifacts from evidence and claims. Distinguishes fact/citation/interpretation/author-claim.',
  stages: ['argumentation_writing'],
  disciplines: ['interdisciplinary'],
  inputs: [
    { name: 'claims_evidence', type: 'Claim[]|Evidence[]', required: true, description: 'Registered project claims and evidence' },
  ],
  outputs: [
    { name: 'manuscript', type: 'Artifact<manuscript>', description: 'A manuscript section or full draft' },
  ],
  permissions: ['read_source', 'write_file'],
  dependencies: [],
  producesArtifacts: ['manuscript'],
  visualization: 'manuscript',
  source: {
    origin: 'internal',
    repository: 'metis',
    license: 'internal',
    licenseEvidence: 'Authored inside Metis. Discipline/journal differences use Profile data (METIS-808/809), not separate agents.',
  },
  limitations: ['Every citation must reference a registered in-project source.', 'No un-locatable citations or data allowed.'],
};

// ─── Pack 7: Verification & Delivery (METIS-807) ──────────────

const verificationDelivery: CapabilityManifest = {
  id: 'verification-delivery',
  name: '核验与交付',
  version: '1.0.0',
  description: 'Unified audit of citations, argumentation, method, numbers, language, format, artifact completeness. Absorbs reference-formatter/citation-finder/humanizer rules.',
  stages: ['verification_delivery'],
  disciplines: ['interdisciplinary'],
  inputs: [
    { name: 'artifact', type: 'Artifact', required: true, description: 'The artifact to verify' },
  ],
  outputs: [
    { name: 'integrity_report', type: 'Artifact<integrity_report>', description: 'Report distinguishing errors/warnings/suggestions/unverifiable' },
  ],
  permissions: ['read_source', 'search_web'],
  dependencies: [],
  producesArtifacts: ['integrity_report'],
  visualization: 'none',
  source: {
    origin: 'internal',
    repository: 'metis',
    license: 'internal',
    licenseEvidence: 'Authored inside Metis. Rule inspiration from chinese-reference-formatter-skill (MIT, #5), citation-finder (MIT, #6), humanizer (MIT, #7) — rules rewritten, no code copied.',
  },
  limitations: ['Audit results MUST distinguish error/warning/suggestion/unverifiable.', 'Cannot mark as verified while severe issues unresolved.'],
};

// ─── The seven ────────────────────────────────────────────────

export const SEVEN_CAPABILITY_PACKS: readonly CapabilityManifest[] = [
  researchDesign,
  sourceResearch,
  literatureReview,
  qualitativeAnalysis,
  quantitativeAnalysis,
  argumentationWriting,
  verificationDelivery,
];

export const SEVEN_CAPABILITY_IDS = SEVEN_CAPABILITY_PACKS.map((p) => p.id);
