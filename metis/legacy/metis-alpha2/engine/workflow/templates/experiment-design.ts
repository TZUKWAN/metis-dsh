/**
 * Experiment design workflow template.
 *
 * Steps: Question → Hypothesis → Design → Feasibility → Code → Dry Run
 */

import type { WorkflowDefinition } from '../types.js';

export const EXPERIMENT_DESIGN_WORKFLOW: WorkflowDefinition = {
  id: 'experiment-design',
  name: 'Experiment Design',
  description: 'Design a rigorous experiment from research question to executable code.',
  version: '1.0.0',
  steps: [
    {
      id: 'question',
      name: 'Define Research Question',
      description: 'Clearly define the research question and hypotheses.',
      prompt: `Define a clear research question and hypotheses for the following topic.

Research area: {{input.topic}}
Background: {{input.background}}

Provide:
1. Primary research question (precise and testable)
2. Null hypothesis (H0)
3. Alternative hypothesis (H1)
4. Secondary questions (if any)
5. Measurable outcomes`,
      inputFrom: [],
      tools: ['search_content'],
      maxTurns: 4,
    },
    {
      id: 'design',
      name: 'Design Experiment',
      description: 'Design the experimental protocol including variables, groups, and procedure.',
      prompt: `Design a detailed experimental protocol based on the following research question:

Research question:
{{question.output}}

Design:
1. Independent variables (factors to manipulate)
2. Dependent variables (outcomes to measure)
3. Control variables (factors to hold constant)
4. Experimental groups (treatment and control)
5. Sample size justification
6. Randomization procedure
7. Data collection protocol
8. Statistical tests to use`,
      inputFrom: ['question'],
      tools: ['search_content'],
      maxTurns: 6,
    },
    {
      id: 'feasibility',
      name: 'Assess Feasibility',
      description: 'Evaluate whether the experiment can be executed with available resources.',
      prompt: `Assess the feasibility of the following experimental design.

Experiment design:
{{design.output}}

Evaluate:
1. Resource requirements (time, equipment, data, compute)
2. Potential confounds and how to mitigate them
3. Power analysis (minimum detectable effect size)
4. Ethical considerations
5. Alternative designs if the primary is infeasible
6. Risk assessment and mitigation strategies`,
      inputFrom: ['design'],
      tools: [],
      maxTurns: 4,
    },
    {
      id: 'code',
      name: 'Generate Experiment Code',
      description: 'Generate reproducible experiment code with proper randomization and statistical analysis.',
      prompt: `Generate executable code for the following experiment design.

Experiment design:
{{design.output}}

Feasibility assessment:
{{feasibility.output}}

Generate code that:
1. Sets up the experimental environment
2. Implements randomization
3. Runs the experiment (or simulation)
4. Collects and stores results
5. Performs statistical analysis
6. Generates visualizations

Use clear function names, docstrings, and make the code reproducible.`,
      inputFrom: ['design', 'feasibility'],
      tools: [],
      maxTurns: 6,
    },
    {
      id: 'review',
      name: 'Review and Validate',
      description: 'Review the complete experiment plan and generate a summary report.',
      prompt: `Review the complete experiment plan and generate a summary.

Research question:
{{question.output}}

Experiment design:
{{design.output}}

Feasibility:
{{feasibility.output}}

Code:
{{code.output}}

Provide:
1. Executive summary of the experiment
2. Strengths of the design
3. Potential weaknesses and countermeasures
4. Expected outcomes and their significance
5. Timeline estimate`,
      inputFrom: ['question', 'design', 'feasibility', 'code'],
      tools: [],
      maxTurns: 4,
      hitl: { requireApproval: true, allowEdit: true },
    },
  ],
  dependencies: {
    question: [],
    design: ['question'],
    feasibility: ['design'],
    code: ['design', 'feasibility'],
    review: ['question', 'design', 'feasibility', 'code'],
  },
};
