/**
 * Literature review workflow template.
 *
 * Steps: Search → Extract → Compare → Identify gaps → Write review
 */

import type { WorkflowDefinition } from '../types.js';

export const LITERATURE_REVIEW_WORKFLOW: WorkflowDefinition = {
  id: 'literature-review',
  name: 'Literature Review',
  description: 'Search papers, extract key findings, compare, identify gaps, and write a structured review.',
  version: '1.0.0',
  steps: [
    {
      id: 'search',
      name: 'Search Papers',
      description: 'Search for relevant papers on the given topic.',
      prompt: `Search for academic papers related to the following research topic. Use arxiv_search and web search tools to find the most relevant and recent papers.

Research topic: {{input.topic}}

Provide a structured list of papers found, including titles, authors, years, and key findings.`,
      inputFrom: [],
      tools: ['search_files', 'search_content', 'execute_command'],
      maxTurns: 8,
      hitl: { requireApproval: false, allowEdit: true },
    },
    {
      id: 'extract',
      name: 'Extract Key Findings',
      description: 'Extract core findings and methodology from each paper.',
      prompt: `Based on the following paper search results, extract the key findings, methodology, and contributions from each paper.

Search results:
{{search.output}}

For each paper, provide:
1. Main research question
2. Methodology used
3. Key findings
4. Limitations mentioned`,
      inputFrom: ['search'],
      tools: ['read_file', 'search_content'],
      maxTurns: 6,
    },
    {
      id: 'compare',
      name: 'Compare and Analyze',
      description: 'Compare findings across papers to identify patterns and contradictions.',
      prompt: `Compare and analyze the following extracted findings from multiple papers:

Paper findings:
{{extract.output}}

Create a comparison matrix that shows:
1. Common themes across papers
2. Contradicting findings
3. Methodological differences
4. Agreement and disagreement patterns`,
      inputFrom: ['extract'],
      tools: [],
      maxTurns: 4,
    },
    {
      id: 'gaps',
      name: 'Identify Research Gaps',
      description: 'Identify gaps in existing research based on the comparison.',
      prompt: `Based on the following comparison analysis, identify research gaps and opportunities for future work.

Comparison:
{{compare.output}}

Extracted findings:
{{extract.output}}

List the top research gaps with:
1. What is missing in current research
2. Why it matters
3. Suggested approach to address it`,
      inputFrom: ['compare', 'extract'],
      tools: [],
      maxTurns: 4,
    },
    {
      id: 'review',
      name: 'Write Literature Review',
      description: 'Write a comprehensive literature review synthesizing all findings.',
      prompt: `Write a comprehensive literature review based on the following analysis.

Research topic: {{input.topic}}

Paper findings:
{{extract.output}}

Comparison analysis:
{{compare.output}}

Research gaps:
{{gaps.output}}

Write the review in academic style with:
1. Introduction to the research area
2. Thematic organization of findings
3. Critical analysis of methodologies
4. Discussion of gaps and future directions
5. Conclusion`,
      inputFrom: ['extract', 'compare', 'gaps'],
      tools: [],
      maxTurns: 6,
      hitl: { requireApproval: true, allowEdit: true },
    },
  ],
  dependencies: {
    search: [],
    extract: ['search'],
    compare: ['extract'],
    gaps: ['compare', 'extract'],
    review: ['extract', 'compare', 'gaps'],
  },
};
