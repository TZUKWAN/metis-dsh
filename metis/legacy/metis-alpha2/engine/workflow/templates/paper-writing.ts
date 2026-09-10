/**
 * Paper writing workflow template.
 *
 * Steps: Outline → Introduction → Methodology → Results → Discussion → Polish
 */

import type { WorkflowDefinition } from '../types.js';

export const PAPER_WRITING_WORKFLOW: WorkflowDefinition = {
  id: 'paper-writing',
  name: 'Paper Writing',
  description: 'Generate a complete academic paper from outline to final polish.',
  version: '1.0.0',
  steps: [
    {
      id: 'outline',
      name: 'Build Outline',
      description: 'Create a detailed paper outline.',
      prompt: `Create a detailed academic paper outline for the following topic.

Title: {{input.title}}
Abstract/Summary: {{input.summary}}
Key contributions: {{input.contributions}}

Provide:
1. Section structure (Introduction, Related Work, Method, Results, Discussion, Conclusion)
2. Key points for each section
3. Figure/table suggestions`,
      inputFrom: [],
      tools: [],
      maxTurns: 4,
    },
    {
      id: 'introduction',
      name: 'Write Introduction',
      description: 'Write the introduction section.',
      prompt: `Write the Introduction section based on this outline:

{{outline.output}}

Title: {{input.title}}

The introduction should:
1. Present the research problem
2. Provide context and motivation
3. State the contributions clearly
4. Outline the paper structure`,
      inputFrom: ['outline'],
      tools: [],
      maxTurns: 4,
    },
    {
      id: 'methodology',
      name: 'Write Methodology',
      description: 'Write the methodology section.',
      prompt: `Write the Methodology section based on this outline:

{{outline.output}}

Describe the approach, algorithms, experimental setup, and evaluation methods in academic style.`,
      inputFrom: ['outline'],
      tools: [],
      maxTurns: 6,
    },
    {
      id: 'results',
      name: 'Write Results',
      description: 'Write the results section.',
      prompt: `Write the Results section based on this outline and data:

Outline:
{{outline.output}}

Experimental data:
{{input.data}}

Present the results with tables, figures (described textually), and analysis.`,
      inputFrom: ['outline'],
      tools: [],
      maxTurns: 6,
    },
    {
      id: 'discussion',
      name: 'Write Discussion and Conclusion',
      description: 'Write discussion and conclusion sections.',
      prompt: `Write the Discussion and Conclusion sections.

Outline:
{{outline.output}}

Results:
{{results.output}}

Discuss:
1. Interpretation of results
2. Comparison with related work
3. Limitations
4. Future work
5. Concluding remarks`,
      inputFrom: ['outline', 'results'],
      tools: [],
      maxTurns: 6,
    },
    {
      id: 'polish',
      name: 'Integrate and Polish',
      description: 'Combine all sections and polish the paper.',
      prompt: `Combine and polish all sections into a complete paper.

Introduction:
{{introduction.output}}

Methodology:
{{methodology.output}}

Results:
{{results.output}}

Discussion and Conclusion:
{{discussion.output}}

Polish the paper:
1. Ensure consistent terminology
2. Add transitions between sections
3. Check logical flow
4. Improve clarity and academic tone
5. Generate a proper abstract`,
      inputFrom: ['introduction', 'methodology', 'results', 'discussion'],
      tools: [],
      maxTurns: 6,
      hitl: { requireApproval: true, allowEdit: true },
    },
  ],
  dependencies: {
    outline: [],
    introduction: ['outline'],
    methodology: ['outline'],
    results: ['outline'],
    discussion: ['outline', 'results'],
    polish: ['introduction', 'methodology', 'results', 'discussion'],
  },
};
