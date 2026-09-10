/**
 * Section-specific academic writing guidance.
 *
 * Provides concrete, checklist-style advice for each stage of a research paper.
 * The guidance is inspired by structured paper-writing skill packs (e.g.,
 * Research-Paper-Writing-Skills) but tailored for Metis's stage-gated pipeline.
 */

// NOTE: This list must stay aligned with the writing stages in
// `WritingPipeline.ts` (outline → introduction → related_work → methods →
// results → discussion → conclusion → polish). `abstract` is kept as an extra
// guide because abstracts are a real paper section even though they are not a
// gated pipeline stage — users often draft an abstract last, so the guide is
// still useful when requested explicitly.
export const SECTION_GUIDE_SECTIONS = [
  'outline',
  'abstract',
  'introduction',
  'related_work',
  'methods',
  'results',
  'discussion',
  'conclusion',
  'polish',
] as const;

export type SectionGuideSection = (typeof SECTION_GUIDE_SECTIONS)[number];

/**
 * Return a concise, actionable guide for the requested paper section.
 * Unknown sections fall back to a generic academic-writing checklist.
 */
export function getSectionGuide(section: string): string {
  const normalized = section.toLowerCase().trim().replace(/\s+/g, '_');

  switch (normalized) {
    case 'outline':
      return `## Outline Checklist

1. **Research question** — State the precise, falsifiable question the paper answers.
2. **Contributions** — List 2–4 concrete, verifiable contributions (each must map to a later section).
3. **Section overview** — Sketch one line per section: what it argues and what evidence it uses.
4. **Target venue & constraints** — Note page/format limits, review criteria, and audience.
5. **Risk register** — Flag the weakest claims or experiments and how you will defend them.

Constraints:
- Each contribution must be deliverable within the planned sections; remove any orphan contribution.
- The outline is a contract: later stages are checked against it. Keep it short (≤1 page).
- Avoid locking in results you have not yet produced; mark open assumptions explicitly.`;

    case 'abstract':
      return `## Abstract Checklist

1. **Context & gap** — In 1–2 sentences, state the problem and why it matters.
2. **Method** — Summarize the key approach/technique in one sentence.
3. **Results** — State the most important quantitative or qualitative outcome.
4. **Implication** — End with the takeaway or contribution.

Constraints:
- 150–250 words for most venues; check the target limit.
- No citations unless the venue requires them.
- Avoid vague claims ("we study", "we propose"); use specific verbs ("we derive", "we validate").
- Do not include future work or limitations.`;

    case 'introduction':
      return `## Introduction Checklist

1. **Hook** — Open with a concrete problem or observation, not a generic trend.
2. **Background** — Give only the minimum context needed to understand the gap.
3. **Gap** — Explicitly state what is missing, incorrect, or under-explored.
4. **Research question / hypothesis** — Make it precise and falsifiable.
5. **Contributions** — Use a numbered list of 2–4 concrete, verifiable contributions.
6. **Roadmap** — Briefly preview section structure.

Constraints:
- Each paragraph should have a clear job; do not stack unrelated facts.
- Cite the 3–5 most relevant prior works; avoid a laundry list.
- The contribution list must mirror what the paper actually delivers.`;

    case 'related_work':
      return `## Related Work Checklist

1. **Taxonomy first** — Group prior work by theme/approach, not by chronology.
2. **Representative citations** — For each theme, pick the most rigorous or influential papers.
3. **Compare, don't summarize** — For each theme, explain how your work differs.
4. **Gap synthesis** — After the taxonomy, state the combined limitation that motivates you.

Constraints:
- Avoid "X proposed Y" paragraphs that only describe others' work.
- Every cited work should connect to your gap or method.
- Use search_library to ground claims; verify citations exist.
- Flag any citation that cannot be verified rather than assuming it is correct.`;

    case 'methods':
      return `## Methods Checklist

1. **Overview** — One-paragraph intuition before formal details.
2. **Notation & definitions** — Define symbols and terms before using them.
3. **Procedure** — Present the method as a reproducible sequence or algorithm.
4. **Implementation details** — Mention software, hyperparameters, hardware if relevant.
5. **Validation plan** — Briefly state how you will evaluate correctness/performance.

Constraints:
- A reader should be able to reimplement the core method from this section.
- Avoid mixing results into methods; reserve evaluation for the Results section.
- Use equations only when they add precision; explain each one in prose.
- Cite foundational tools/datasets, not every minor library.`;

    case 'results':
      return `## Results Checklist

1. **Main result first** — Lead with the most important finding, not setup.
2. **Quantitative evidence** — Report metrics with confidence intervals or variance when possible.
3. **Ablations / controls** — Show what matters by removing or varying components.
4. **Figures & tables** — Reference each one in prose; ensure captions are self-contained.
5. **Statistical rigor** — Note sample size, significance tests, and effect sizes.

Constraints:
- Do not interpret here; save interpretation for Discussion.
- Report failures and negative results honestly.
- Ensure every number in prose matches the corresponding table/figure.
- Use siunitx-aligned numeric columns in tables.`;

    case 'discussion':
      return `## Discussion Checklist

1. **Interpretation** — Explain what the results mean in the context of the research question.
2. **Relation to prior work** — Compare your findings with the papers cited in Related Work.
3. **Limitations** — Be specific about scope, assumptions, data biases, and methodological weaknesses.
4. **Future work** — Suggest concrete next steps, not vague directions.
5. **Broader impact** — Briefly note practical or scientific implications.

Constraints:
- Avoid introducing new results here.
- Limitations should be honest but not undermine the paper's core contribution.
- Connect back to the gap stated in the Introduction.`;

    case 'conclusion':
      return `## Conclusion Checklist

1. **Restate contributions** — Summarize what was achieved in one paragraph.
2. **Key takeaway** — State the single most important message for the reader.
3. **Final framing** — Connect the result back to the original problem.

Constraints:
- No new claims, citations, or results.
- Keep it short: 1–2 paragraphs.
- End on the contribution, not on limitations.`;

    case 'polish':
      return `## Polish Checklist

1. **AI-Tell scan** — Remove empty hedges ("we study", "we explore"), repetitive openers, and unsupported superlatives ("novel", "comprehensive", "state-of-the-art" without evidence).
2. **Sentence-level cleanup** — Active voice by default; one idea per sentence; cut filler adverbs.
3. **Tense & voice consistency** — Methods/results in past tense; general facts in present tense; consistent first-person ("we").
4. **Terminology & notation** — Same symbol/term for the same concept throughout; define on first use.
5. **Citation & reference hygiene** — Every cited work appears in the bibliography; no broken \\ref/\\cite; verify DOIs via citation_triangulate or crossref_lookup.
6. **AI disclosure** — Add the venue-required generative-AI disclosure statement if applicable.

Constraints:
- Polish changes wording, not claims or results; if you find a substantive error, loop back to the relevant stage.
- Read the paper aloud once section by section to catch rhythm and repetition.
- Confirm figures, tables, and equations are referenced in prose and have self-contained captions.`;

    default:
      return `## Academic Writing Checklist

1. State the purpose of the section in the first sentence.
2. One idea per paragraph; use topic sentences.
3. Ground claims with citations or evidence.
4. Avoid empty hedges, repetitive openers, and unsupported superlatives.
5. End the section with a clear transition to the next section.

For section-specific guidance, use one of: ${SECTION_GUIDE_SECTIONS.join(', ')}.`;
  }
}
