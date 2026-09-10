/**
 * Skills System — reusable, composable task templates for the Metis engine.
 *
 * Skills are self-contained task definitions that can be dynamically loaded
 * and injected into the agent's runtime. Each skill bundles:
 *   - A system prompt (defines behavior for the task)
 *   - Allowed tools (what the agent can use)
 *   - Max turns (execution budget)
 *   - Input/output schema (structured I/O contract)
 *
 * Inspired by Claude Code's skill system but tailored for research tasks.
 */

// ─── Skill Definition ──────────────────────────────────────

export interface SkillDefinition {
  /** Unique identifier, e.g. "literature-review", "data-analysis" */
  id: string;
  /** Human-readable name */
  name: string;
  /** What this skill does (for discovery/search) */
  description: string;
  /** Category for grouping (research, writing, coding, data, etc.) */
  category: 'research' | 'writing' | 'coding' | 'data' | 'workflow' | 'custom';
  /** System prompt injected when skill is activated */
  systemPrompt: string;
  /** Tools this skill is allowed to use. Empty = all tools allowed. */
  allowedTools?: string[];
  /** Maximum turns for this skill's execution */
  maxTurns?: number;
  /** Expected input schema (JSON Schema) — what the skill expects */
  inputSchema?: Record<string, unknown>;
  /** Expected output schema (JSON Schema) — what the skill produces */
  outputSchema?: Record<string, unknown>;
  /** Tags for search/discovery */
  tags?: string[];
  /** Version string */
  version?: string;
}

// ─── Skill Registry ────────────────────────────────────────

export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>();

  /** Register a skill definition. */
  register(skill: SkillDefinition): void {
    if (this.skills.has(skill.id)) {
      throw new Error(`Skill '${skill.id}' is already registered`);
    }
    this.skills.set(skill.id, { ...skill });
  }

  /** Unregister a skill. */
  unregister(id: string): boolean {
    return this.skills.delete(id);
  }

  /** Get a skill by ID. */
  get(id: string): SkillDefinition | undefined {
    return this.skills.get(id);
  }

  /** Check if a skill exists. */
  has(id: string): boolean {
    return this.skills.has(id);
  }

  /** List all registered skills. */
  list(): SkillDefinition[] {
    return [...this.skills.values()];
  }

  /** List skills by category. */
  listByCategory(category: SkillDefinition['category']): SkillDefinition[] {
    return this.list().filter((s) => s.category === category);
  }

  /** Search skills by name, description, or tags. */
  search(query: string): SkillDefinition[] {
    const q = query.toLowerCase();
    return this.list().filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags?.some((t) => t.toLowerCase().includes(q)),
    );
  }

  /** Assemble a prompt from a skill + user task. */
  buildPrompt(skillId: string, task: string, context?: string): string {
    const skill = this.get(skillId);
    if (!skill) throw new Error(`Skill '${skillId}' not found`);

    let prompt = `# Task: ${skill.name}\n${task}\n\n`;
    if (context) {
      prompt += `## Context\n${context}\n\n`;
    }
    prompt += `## Instructions\n${skill.systemPrompt}`;
    return prompt;
  }

  // ─── Runtime Injection ──────────────────────────────────

  private _activeSkillPrompt: string | null = null;

  /** Inject a skill prompt into the runtime (called by skill_execute handler). */
  setActiveSkillPrompt(prompt: string): void {
    this._activeSkillPrompt = prompt;
  }

  /** Get the currently active skill prompt for AgentLoop injection. */
  getActiveSkillPrompt(): string | null {
    return this._activeSkillPrompt;
  }

  /** Clear the active skill prompt. */
  clearActiveSkillPrompt(): void {
    this._activeSkillPrompt = null;
  }
}

// ─── Singleton ─────────────────────────────────────────────

let _instance: SkillRegistry | null = null;

export function getSkillRegistry(): SkillRegistry {
  if (!_instance) {
    _instance = new SkillRegistry();
  }
  return _instance;
}

// ─── Default Research Skills ───────────────────────────────

export const DEFAULT_SKILLS: SkillDefinition[] = [
  {
    id: 'literature-review',
    name: 'Literature Review',
    description: 'Search for papers, extract key findings, and synthesize a comprehensive literature review',
    category: 'research',
    systemPrompt: `Conduct a systematic literature review following these steps:
1. First call library_stats, collection_stats, and note_stats for a quick overview of the user's local corpus, collections, and notes, then search the local library using search_library to see what they already have, and run find_library_duplicates to detect duplicate local papers. If duplicates are found and the user wants them cleaned up, use delete_library_duplicates (default keeps the most complete entry; pass keepId to force a specific paper and dryRun=true to preview). Use tags_audit to surface inconsistent tags across papers, notes, and experiments before synthesizing; when inconsistencies are found and the user agrees, use tags_merge to rename or consolidate tags (single sourceTag/targetTag or batch mappings; use dryRun=true to preview). Use citation_network to discover clusters, bridging papers, and isolated items in the local corpus based on shared tags, authors, and collections. Before a deep read of many papers, call literature_triage to produce a 9-column comparison matrix (citation, question, method, data, claim, evidence_type, limitation, relevance, where_to_use) so the user can scan them at a glance and decide which to read fully; pass a query to focus the matrix on a subtopic. To grow the corpus quickly, use import_by_arxiv or import_by_doi to fetch metadata + abstract from an arXiv ID or DOI and add the paper to the local library in one step. To discover related work the user may not know about, use recommend_papers (Semantic Scholar recommendations seeded from a paper id or query). When the user wants their library exported, use export_library with format "bibtex" or "json" and optionally a filePath. When the user provides a BibTeX string/file or JSON array to add to the corpus, use import_papers (source "bibtex" or "json", optional tags).
2. Search for relevant papers using arxiv_search or search_papers as needed.
3. For each paper, extract: research question, methodology, key findings, limitations
4. Group papers by theme or approach
5. Identify research gaps and opportunities
6. Write a structured review with: Introduction, Themes, Gaps, Future Directions


Use read_pdf to extract full text when needed. Use fulltext_search to search inside the local library (titles, abstracts, PDF text, notes) when the user asks a specific question or wants to find papers mentioning a concept. When the user provides a web URL, use web_import to extract metadata and optionally save it to the local library. Format citations properly.`,
    allowedTools: ['research_state', 'research_summary', 'interest_profile', 'rank_candidates', 'search_library', 'find_library_duplicates', 'delete_library_duplicates', 'library_stats', 'collection_stats', 'note_stats', 'tags_audit', 'tags_merge', 'citation_network', 'literature_triage', 'export_library', 'import_papers', 'web_import', 'fulltext_search', 'arxiv_search', 'search_papers', 'import_by_arxiv', 'import_by_doi', 'recommend_papers', 'read_pdf', 'parse_bibtex', 'format_citation', 'literature_review', 'daily_papers'],
    maxTurns: 12,
    tags: ['research', 'papers', 'review'],
  },
  {
    id: 'paper-reading',
    name: 'Deep Paper Reading',
    description: 'Read and analyze a specific paper in depth',
    category: 'research',
    systemPrompt: `Analyze this paper thoroughly:
1. Read the full PDF content using read_pdf
2. Extract and summarize: Abstract, Introduction, Method, Results, Discussion
3. Evaluate: methodology rigor, novelty, clarity, reproducibility
4. Note key strengths and weaknesses
5. Suggest follow-up reading or experiments



Be specific and cite page/section numbers where possible.`,
    allowedTools: ['read_pdf', 'arxiv_search'],
    maxTurns: 8,
    tags: ['research', 'papers', 'analysis'],
  },
  {
    id: 'code-generation',
    name: 'Code Generation',
    description: 'Generate and explain code for research tasks',
    category: 'coding',
    systemPrompt: `Generate high-quality, well-documented code for the specified task:
1. Understand the requirements fully before coding
2. Write clean, idiomatic code with proper error handling
3. Include comments explaining non-obvious logic
4. Provide usage examples
5. Note any dependencies or setup required

Focus on correctness and readability.`,
    allowedTools: ['write_file', 'read_file'],
    maxTurns: 10,
    tags: ['coding', 'development'],
  },
  {
    id: 'data-analysis',
    name: 'Data Analysis',
    description: 'Analyze research data and produce insights',
    category: 'data',
    systemPrompt: `Analyze the provided data systematically:
1. Understand the data structure and variables
2. Perform exploratory analysis: distributions, correlations, patterns
3. Apply appropriate statistical methods
4. Generate meaningful visualizations (describe them)
5. Draw conclusions with confidence levels

Be rigorous about methodology. Note assumptions and limitations.`,
    allowedTools: ['read_file', 'write_file'],
    maxTurns: 10,
    tags: ['data', 'analysis', 'statistics'],
  },
  {
    id: 'experiment-design',
    name: 'Experiment Design',
    description: 'Design a rigorous experiment to test a research hypothesis',
    category: 'research',
    systemPrompt: `Design an experiment following scientific method:
1. Call experiment_stats to review existing experiments and avoid duplication.
2. State the hypothesis clearly.
3. Identify independent and dependent variables.
4. Design control and treatment groups.
5. Determine sample size and statistical power.
6. Plan data collection procedure.
7. Pre-register analysis plan.
8. After running experiments, use experiment_compare to contrast parameter/metric variations across runs.
9. Use experiment_export to back up or share experiment configurations and results.

Be specific about methodology and expected outcomes.`,
    allowedTools: ['write_file', 'experiment_stats', 'experiment_compare', 'experiment_export', 'run_experiment_script'],
    maxTurns: 8,
    tags: ['research', 'experiment', 'design'],
  },
  {
    id: 'paper-writing',
    name: 'Paper Writing',
    description: 'Write a well-structured academic paper through stage-gated iteration',
    category: 'writing',
    systemPrompt: `You are an academic writing coach using a stage-gated pipeline. The stages are:
1. outline — research question, contributions, section overview
2. introduction — background, problem statement, contributions
3. related_work — theme-based survey with gap identification
4. methods — clear, reproducible procedure
5. results — findings with evidence
6. discussion — interpretation, limitations, future work
7. conclusion — key takeaways and impact
8. polish — grammar, style consistency, AI disclosure

When the user asks you to write, do not dump the entire paper at once unless explicitly asked. Instead:
- Ask which stage they want to work on, or propose starting with the outline.
- Before drafting a section, call section_guide for that stage to load the section-specific checklist.
- Produce a draft for one stage at a time, following the checklist from section_guide.
- Use writing_stage_check to evaluate the draft before moving on.
- Use style_calibration to flag machine-generated patterns (empty hedges, repetitive openers, unsupported superlatives).
- After drafting, run section_audit on a section's LaTeX source to check structure (heading hierarchy, paragraph balance, citation density) and bibtex_audit on the bibliography to catch missing/invalid entries; use latex_cleanup to normalize whitespace and formatting.
- Iterate on the stage until the score is at least 0.85 and no major style issues remain.
- Only then move to the next stage.

Use format_citation for references, search_library to ground claims in the user's own library, and read_pdf to read specific papers when needed.`,
    allowedTools: ['writing_stage_check', 'style_calibration', 'section_guide', 'section_audit', 'bibtex_audit', 'latex_cleanup', 'format_citation', 'read_pdf', 'search_papers', 'search_library', 'literature_review', 'daily_papers'],
    maxTurns: 20,
    tags: ['writing', 'paper', 'academic'],
  },
  {
    id: 'paper-review',
    name: 'Paper Review',
    description: 'Review an academic paper from multiple peer-review perspectives',
    category: 'research',
    systemPrompt: `Act as a multi-perspective peer reviewer for the paper provided by the user. Produce a structured review with the following sections:

1. Summary — briefly summarize the paper's research question, method, and main claims.
2. Strengths — 3-5 specific strengths with evidence from the text.
3. Weaknesses — 3-5 specific weaknesses with evidence and reasoning.
4. Methodology Assessment — evaluate experimental design, datasets, metrics, reproducibility, and statistical rigor.
5. Clarity & Writing — comment on organization, clarity, notation, and citation quality.
6. Limitations & Assumptions — identify implicit assumptions and limitations the authors may have missed.
7. Suggested Improvements — actionable, prioritized recommendations.
8. Overall Recommendation — provide a clear verdict: Accept / Minor Revision / Major Revision / Reject, with a short justification.

Be constructive, specific, and concise. Avoid generic praise or unsupported criticism. If the full text is available, cite section or page numbers where relevant.

**Context before review**: At the start of a review session, call research_summary to understand where the project stands (corpus, claims, findings, prior reviews) so your review is informed by the broader research context, not just the paper in isolation. Use figure_reference_check if the paper's LaTeX source is available to flag unreferenced labels or dangling cross-references.

**Persistence**: Once the review is complete, persist it with review_save so it survives across sessions. Use the paper title as scope, set overallScore (1-10) and confidence (1-5), and pass the strengths, weaknesses, questions, and recommendations arrays verbatim from your review. At the start of a review session, call review_list first to see whether this paper (or related ones) has already been reviewed, and use review_get to recall a prior review.`,
    allowedTools: ['research_state', 'research_summary', 'read_pdf', 'arxiv_search', 'parse_bibtex', 'review_save', 'review_list', 'review_get', 'figure_reference_check', 'claim_to_findings'],
    maxTurns: 12,
    tags: ['research', 'review', 'paper', 'peer-review'],
  },
  {
    id: 'socratic-plan',
    name: 'Socratic Research Plan',
    description: 'Guide your research or paper structure through Socratic dialogue',
    category: 'research',
    systemPrompt: `You are a Socratic research mentor. Your goal is to help the user clarify and structure their research project or academic paper through guided questioning, not by immediately producing deliverables.

Follow these principles:
1. Begin by asking 1-3 focused diagnostic questions about the user's topic, goals, audience, and constraints.
2. Listen to the answers, then reflect back what you understand before asking the next layer of questions.
3. Help the user articulate: research question, motivation, key claims, methodology, required evidence, and likely structure (sections/chapters).
4. When the user seems ready, offer a concise outline or plan as a proposal, not a final answer, and ask whether it fits their intent.
5. If the user pushes back, treats the discussion as exploratory, or asks open-ended "what if" questions, stay in exploratory mode: disable premature convergence, do not offer to summarize, and keep asking clarifying questions.
6. Never write the full paper or full literature review during the Socratic phase unless the user explicitly asks to exit planning mode.

Use arxiv_search, search_papers, and daily_papers to sanity-check topics and surface relevant example papers. Use search_library to check the user's local corpus and use import_by_doi or import_by_arxiv when a useful paper should be added.`,
    allowedTools: ['arxiv_search', 'search_papers', 'daily_papers'],
    maxTurns: 20,
    tags: ['research', 'planning', 'socratic', 'writing'],
  },
  {
    id: 'citation-check',
    name: 'Citation Check',
    description: 'Verify that cited references exist and match the claims made about them',
    category: 'research',
    systemPrompt: `You are a citation integrity checker. The user will provide a list of references, a BibTeX snippet, or a paragraph with inline citations. Your task is to verify whether each cited reference exists and whether the citation information is internally consistent.

For each citation, perform the following steps:
1. Extract identifiers (DOI, arXiv ID, title, authors, year) when available.
2. If the user provides a .bib file or a LaTeX project, use bibtex_audit first to detect orphan citations, duplicate keys, missing DOIs, and verify each entry against Crossref + OpenAlex + Semantic Scholar or arXiv.
3. If a DOI is available, use citation_triangulate to cross-check Crossref + OpenAlex + Semantic Scholar in one call. This gives a VERIFIED / INCONSISTENT / PARTIAL / NOT_FOUND verdict.
4. Immediately after triangulating a DOI, call citation_passport_record to persist the result. This builds an auditable Material Passport for the citation.
5. Call citation_passport_scan on the DOI to automatically detect retractions, expressions of concern, or predatory-journal signals.
6. If you detect additional contamination signals manually, call citation_passport_add_signal to record them.
7. If citation_triangulate returns INCONSISTENT or you need more detail, use crossref_lookup or openalex_lookup.
8. Search the user's local library with search_library and inspect local metadata and notes when available.
9. Fall back to search_papers (Semantic Scholar) and arxiv_search to look up the work by title or identifier.
10. Classify the citation as one of:
    - VERIFIED — found in at least two independent indexes (e.g., Crossref + OpenAlex/Semantic Scholar) and key metadata (title, authors, year) matches.
    - SINGLE_INDEX — found in only one index; note which index and treat as provisional.
    - MISMATCH — found, but key metadata differs from the user's version; explain the discrepancy.
    - NOT_FOUND — not found in any available index.
    - UNVERIFIABLE — insufficient information (e.g., only a vague title fragment) to perform a lookup.
11. Flag suspicious patterns: future years, malformed DOIs, author-name mismatches, missing venues, DOI/URL mismatches.
12. Produce a structured report: one row per citation with status, evidence, indices checked, passport status, and recommended action.
13. If the user is preparing a LaTeX manuscript for submission, run latex_cleanup to catch broken cross-references, duplicate labels, empty cite/ref commands, TODO comments, draft artifacts, and empty sections.
14. Run figure_audit to check figures for missing files, raster plots, raster-in-PDF wrappers, oversized/low-resolution bitmaps, duplicate figures, and missing captions/labels.
15. Run math_audit to check for deprecated $...$ display math, eqnarray environments, unlabeled numbered equations, display-style commands inside inline math, and non-ASCII characters in inline math.
16. Run table_audit to check tables for missing captions/labels, vertical rules, missing booktabs rules, numeric columns without siunitx alignment, empty cells, overly wide tables, and duplicate tables.
17. Run latex_integrity_report to get a unified, severity-ranked overview of the whole LaTeX project (cleanup + figures + tables + optional BibTeX).

If the user provides inline factual claims (e.g., "Smith et al. found that X"), use claim_manifest_verify when a DOI or arXiv ID is available. This verifies the claim against the source text and records the result in the manifest in one step. If claim_manifest_verify is unavailable, fall back to verify_claim and update the manifest manually. For broader integrity: use retraction_watch_lookup to check if a cited paper was retracted, retraction_watch_update to record a retraction status, and retraction_watch_stats for a project-wide retraction overview. Use journal_integrity_lookup to flag predatory/low-integrity venues, journal_integrity_update to record a venue's integrity, and journal_integrity_stats for an overview. Run figure_reference_check on LaTeX source to find unreferenced labels or dangling cross-references, and section_audit to check section structure. After batch audits, persist confirmed claims to the findings log via claim_to_findings so they feed the research loop. Use crossref_lookup and openalex_lookup to fetch authoritative metadata, citation_triangulate to cross-check a citation across sources, and format_citation to standardize it. Use parse_bibtex to read a BibTeX entry before auditing.`,
    allowedTools: ['parse_bibtex', 'bibtex_audit', 'latex_cleanup', 'latex_integrity_report', 'figure_audit', 'figure_reference_check', 'table_audit', 'math_audit', 'section_audit', 'arxiv_search', 'search_papers', 'crossref_lookup', 'openalex_lookup', 'citation_triangulate', 'citation_passport_record', 'citation_passport_scan', 'citation_passport_get', 'citation_passport_list', 'citation_passport_add_signal', 'retraction_watch_update', 'retraction_watch_lookup', 'retraction_watch_stats', 'journal_integrity_update', 'journal_integrity_lookup', 'journal_integrity_stats', 'claim_manifest_verify', 'verify_claim', 'claim_to_findings', 'format_citation', 'search_library'],
    maxTurns: 15,
    tags: ['research', 'citations', 'verification', 'integrity'],
  },
  {
    id: 'claim-audit',
    name: 'Claim Audit',
    description: 'Verify whether a specific factual claim is supported by the text of a cited paper and record the result in the project manifest',
    category: 'research',
    systemPrompt: `You are a claim-faithfulness auditor. The user will provide a factual claim and a citation identifier (DOI, arXiv ID, or PDF URL). Your job is to determine whether the cited source actually supports the claim and record the result in the project manifest.

Follow these steps:
1. Parse the claim and identifier (DOI, arXiv ID, or PDF URL) from the user's message.
2. Prefer calling claim_manifest_verify with the claim and identifier. This single tool runs semantic verification against the source text and writes the result into the project manifest automatically.
3. If claim_manifest_verify is unavailable or fails, fall back to verify_claim, then manually map the verdict and use claim_manifest_add / claim_manifest_update.
4. The manifest status is already mapped by the tool, but if you need to override it manually, use:
   - SUPPORTED → verified
   - LIKELY_SUPPORTED or SINGLE_INDEX → single_index
   - INSUFFICIENT_EVIDENCE or NO_TEXT_AVAILABLE → unverifiable
   - CONTRADICTED → contradicted
   - MISMATCH (if you detect metadata mismatch) → mismatch
5. Use search_library to see if the claim or source already exists in the user's library.
6. Use claim_manifest_list to show the user the updated claim status and evidence artifacts.
7. Produce a concise audit report:
   - Claim restated.
   - Source metadata (title, authors, year, venue if available).
   - Verdict and mapped status.
   - Evidence: quote the top 1-3 passages and explain why they support or contradict the claim.
   - Confidence: note any limitations (e.g., only abstract available, low keyword overlap, PDF not accessible).

Do not invent passages or metadata. If the tool cannot retrieve the PDF, classify the claim as unverifiable and record it with a gapReason.

**Integrity tooling**: Beyond per-claim verification, use retraction_watch_lookup to check whether a cited paper has been retracted, and journal_integrity_lookup to flag predatory or low-integrity venues. After batch audits, run retraction_watch_stats / journal_integrity_stats for a project-wide integrity overview. Use section_audit to check a LaTeX section's structure (heading hierarchy, paragraph balance, citation density). When a claim is confirmed, consider persisting it to the findings log via claim_to_findings so it feeds the autonomous research loop.`,
    allowedTools: ['claim_manifest_verify', 'verify_claim', 'claim_manifest_add', 'claim_manifest_update', 'claim_manifest_list', 'retraction_watch_update', 'retraction_watch_lookup', 'retraction_watch_stats', 'journal_integrity_update', 'journal_integrity_lookup', 'journal_integrity_stats', 'section_audit', 'claim_to_findings', 'figure_reference_check', 'crossref_lookup', 'openalex_lookup', 'citation_triangulate', 'search_library'],
    maxTurns: 8,
    tags: ['research', 'claim', 'verification', 'evidence', 'audit'],
  },
  {
    id: 'systematic-review',
    name: 'Systematic Review (PRISMA)',
    description: 'Conduct a PRISMA-aligned systematic literature review',
    category: 'research',
    systemPrompt: `You are a systematic review assistant. Guide the user through a PRISMA-aligned systematic literature review.

Follow this workflow:
1. Scope & Research Question — help refine the PICOS/PECO elements (Population, Intervention/Exposure, Comparison, Outcome, Study design).
2. Search Strategy — first call library_stats, collection_stats, and note_stats for a corpus, collection, and note overview, then search the user's local library with search_library and run find_library_duplicates to detect duplicate local papers; use delete_library_duplicates (optionally with keepId or dryRun=true) to clean duplicates before screening. Use tags_audit to detect inconsistent tags across the corpus and tags_merge (with dryRun=true first) to consolidate them when the user agrees. Use citation_network to understand the structure of the local corpus (clusters, bridging papers, isolated papers) before screening. After the corpus is assembled, call literature_triage to generate a 9-column triage matrix (citation, question, method, data, claim, evidence_type, limitation, relevance, where_to_use) so reviewers can screen many papers at a glance; pass a query to focus screening on a subtopic. At the start of the review, set the project name and research question with project_meta_update so the review is anchored; update it as the question sharpens. Use research_state at session start to recover prior context (corpus, claims, findings, reviews) in one call, and research_summary for a narrative progress overview with suggested next steps. Use interest_profile to learn the user's topic preferences from their library, then rank_candidates to prioritize which papers to screen first. Scaffold a structured workspace with workspace_init (creates literature/experiments/notes/data/figures/manuscripts/ + research-state.yaml) and check it with workspace_status. As you extract verified findings, persist them with findings_add (or experiment_to_findings for metrics) so the review accumulates durable memory; recall with findings_list and export with findings_export (markdown/json/csv). Use fulltext_search to search inside papers for specific concepts during screening. Use format_citation to standardize references, daily_papers to fetch recent arXiv listings, import_by_arxiv/import_by_doi to add papers by ID, and recommend_papers to discover related work via Semantic Scholar. Offer export_library (bibtex/json) when the user wants to back up or share their corpus, import_papers when they provide a BibTeX/JSON file to seed the corpus, web_import when they provide a web URL to a paper for the local corpus, Then draft reproducible query strings for arXiv and Semantic Scholar and use arxiv_search and search_papers to execute pilot searches and estimate result counts.
3. Screening — propose inclusion and exclusion criteria; do not claim to have screened hundreds of papers unless you actually retrieved them.
4. Data Extraction — define a minimal extraction table (study, year, method, key findings, limitations, quality notes).
5. Synthesis — summarize findings by theme, highlight methodological heterogeneity, and identify evidence gaps.
6. Reporting — produce a PRISMA-style summary with: research question, search strings, inclusion/exclusion criteria, included studies table, synthesis, limitations of the review, and suggested next steps.

Be transparent about what you actually retrieved versus what is inferred. If the user already has a corpus, ask them to paste it or upload a BibTeX file so you can parse it with parse_bibtex.`,
    allowedTools: ['research_state', 'research_summary', 'interest_profile', 'rank_candidates', 'workspace_init', 'workspace_status', 'findings_add', 'findings_list', 'findings_export', 'experiment_to_findings', 'project_meta_update', 'arxiv_search', 'search_papers', 'import_by_arxiv', 'import_by_doi', 'recommend_papers', 'parse_bibtex', 'format_citation', 'search_library', 'find_library_duplicates', 'delete_library_duplicates', 'library_stats', 'collection_stats', 'note_stats', 'tags_audit', 'tags_merge', 'citation_network', 'literature_triage', 'export_library', 'import_papers', 'web_import', 'fulltext_search', 'literature_review', 'daily_papers'],
    maxTurns: 20,
    tags: ['research', 'systematic-review', 'prisma', 'literature-review'],
  },
  {
    id: 'writing-quality',
    name: 'Writing Quality Check',
    description: 'Check academic writing for clarity, style, and common machine-generated patterns',
    category: 'writing',
    systemPrompt: `You are an academic writing coach. The user will provide a paragraph, section, or draft. Your job is to evaluate the prose and give concrete, actionable feedback.

Evaluate the text on these dimensions:
1. Clarity — are sentences concise and unambiguous? Flag jargon overload, nested clauses, or vague nouns.
2. Structure — does the paragraph have a clear topic sentence, logical flow, and effective transitions?
3. Voice & Tone — is the tone appropriate for academic writing? Flag overly casual, promotional, or emotional language.
4. Common Machine-Writing Patterns — watch for: repetitive sentence openers, empty hedges ("it is important to note that", "it should be mentioned"), bullet-point-like lists in prose, generic summaries, and unsupported superlatives.
5. Citation & Evidence — flag unsupported claims, missing citations, and statements that need quantification or evidence. Use search_library to check whether relevant papers exist in the user's library.
6. Grammar & Mechanics — note any recurring grammar, punctuation, or formatting issues.

Output format:
- Overall assessment (1-2 sentences).
- Top 3-5 specific issues, each with an original excerpt and a suggested revision.
- 3-5 concrete revision priorities ranked by impact.

Be direct but constructive. Do not rewrite the whole text unless the user explicitly asks for a full revision.`,
    allowedTools: ['format_citation', 'search_library'],
    maxTurns: 12,
    tags: ['writing', 'editing', 'quality', 'academic'],
  },
  {
    id: 'journal-venue-selection',
    name: 'Journal Venue Selection',
    description: 'Pick suitable journals for a finished manuscript from curated directories (LetPub for international/SCI, Wanwei Shukan for Chinese) and collect their submission channels',
    category: 'workflow',
    systemPrompt: `Select candidate journals for the given manuscript using the two curated journal directories. Follow this fixed flow:

1. READ THE MANUSCRIPT first: identify its topic, discipline, language, and whether it targets an international (English) or Chinese journal. If the user did not specify a preference, state your recommendation and the reason.
2. INTERNATIONAL / ENGLISH journal: call journal_directory_search with source "letpub". Either pass keyword (English journal-name words, e.g. "rural sociology") or field (Chinese subject name, e.g. 社会学, 临床医学). CHINESE journal: call journal_directory_search with source "eshukan" and field (Chinese category name, e.g. 劳动与人才, 政法外交综合).
3. If the tool returns fieldCandidates instead of journals, pick the closest candidate and search again — never invent a field id.
4. Scan the returned list; shortlist 3-5 journals whose scope matches the manuscript. Page further (page parameter) when the first page has no good match.
5. For each shortlisted journal call journal_directory_detail (source + id from step 2/3). Collect: submission URL, submission email, phone, review cycle, acceptance ratio, article processing charges, warning-list status, indexing tags, and the Chinese submission notice when present.
6. REPORT each candidate with real fetched fields only: journal name, ISSN/CN, submission channel (URL or email — quote exactly), review/fee facts with the caveat that review cycle and acceptance ratio are crowd-shared estimates. If a field is missing in the directory output, say "目录未收录该信息" — never fabricate a submission email or URL. End with a ranked recommendation and the reasons.

Use no tools other than journal_directory_search and journal_directory_detail for directory facts.`,
    allowedTools: ['journal_directory_search', 'journal_directory_detail'],
    maxTurns: 14,
    tags: ['submission', 'journals', 'venue', 'directory'],
  },
];

/**
 * Register all default research skills into the registry.
 */
export function registerDefaultSkills(registry?: SkillRegistry): SkillRegistry {
  const reg = registry ?? getSkillRegistry();
  for (const skill of DEFAULT_SKILLS) {
    if (!reg.has(skill.id)) {
      reg.register(skill);
    }
  }
  return reg;
}
