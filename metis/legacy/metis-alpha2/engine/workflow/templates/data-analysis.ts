/**
 * Data analysis workflow template.
 *
 * Steps: Clean → Explore → Model → Validate → Report
 */

import type { WorkflowDefinition } from '../types.js';

export const DATA_ANALYSIS_WORKFLOW: WorkflowDefinition = {
  id: 'data-analysis',
  name: 'Data Analysis',
  description: 'Analyze research data from cleaning through modeling to final report.',
  version: '1.0.0',
  steps: [
    {
      id: 'clean',
      name: 'Data Cleaning',
      description: 'Clean and preprocess the raw data.',
      prompt: `Analyze and document a data cleaning strategy for the following dataset description.

Data description: {{input.dataDescription}}
Data format: {{input.dataFormat}}
Analysis goal: {{input.goal}}

Provide:
1. Missing value detection and handling strategy
2. Outlier detection and treatment
3. Data type conversions needed
4. Feature engineering suggestions
5. Normalization/standardization plan
6. Data splitting strategy (train/val/test)`,
      inputFrom: [],
      tools: ['read_file', 'execute_command'],
      maxTurns: 6,
    },
    {
      id: 'explore',
      name: 'Exploratory Analysis',
      description: 'Perform exploratory data analysis with descriptive statistics and visualizations.',
      prompt: `Perform exploratory data analysis based on the cleaning plan.

Cleaning plan:
{{clean.output}}

Analysis goal: {{input.goal}}

Provide:
1. Descriptive statistics (mean, median, std, quartiles)
2. Distribution analysis for key variables
3. Correlation matrix and key relationships
4. Patterns and trends identified
5. Visualization suggestions (chart types, what to plot)
6. Initial insights relevant to the research question`,
      inputFrom: ['clean'],
      tools: ['execute_command'],
      maxTurns: 6,
    },
    {
      id: 'model',
      name: 'Modeling and Analysis',
      description: 'Apply statistical models or ML algorithms to the data.',
      prompt: `Propose and justify modeling approaches based on the exploratory analysis.

Exploratory analysis:
{{explore.output}}

Analysis goal: {{input.goal}}

Provide:
1. Model/method selection with justification
2. Statistical test selection (if applicable)
3. Model parameters and assumptions
4. Validation strategy (cross-validation, holdout)
5. Evaluation metrics
6. Expected interpretation of results`,
      inputFrom: ['explore'],
      tools: [],
      maxTurns: 6,
    },
    {
      id: 'validate',
      name: 'Validation and Interpretation',
      description: 'Validate results, check assumptions, and interpret findings.',
      prompt: `Validate and interpret the analysis results.

Modeling approach:
{{model.output}}

Analysis goal: {{input.goal}}

Provide:
1. Model assumptions verification (residual analysis, normality, etc.)
2. Robustness checks (sensitivity analysis, alternative models)
3. Statistical significance interpretation
4. Practical significance and effect sizes
5. Limitations of the analysis
6. Alternative interpretations to consider`,
      inputFrom: ['model'],
      tools: [],
      maxTurns: 4,
    },
    {
      id: 'report',
      name: 'Generate Analysis Report',
      description: 'Produce a comprehensive analysis report with findings, figures, and conclusions.',
      prompt: `Generate a comprehensive data analysis report.

Cleaning plan:
{{clean.output}}

Exploratory analysis:
{{explore.output}}

Modeling approach:
{{model.output}}

Validation results:
{{validate.output}}

Report structure:
1. Executive summary
2. Data overview and cleaning summary
3. Exploratory findings with key statistics
4. Modeling results and interpretation
5. Validation and robustness
6. Conclusions and recommendations
7. Limitations and future work

Use academic tone, include specific numbers, and connect findings to the research question.`,
      inputFrom: ['clean', 'explore', 'model', 'validate'],
      tools: [],
      maxTurns: 6,
      hitl: { requireApproval: true, allowEdit: true },
    },
  ],
  dependencies: {
    clean: [],
    explore: ['clean'],
    model: ['explore'],
    validate: ['model'],
    report: ['clean', 'explore', 'model', 'validate'],
  },
};
