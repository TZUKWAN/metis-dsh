import { DEFAULT_SKILLS } from '../../../engine/skills/SkillRegistry.js';
import type {
  AgentDefinition,
  MetisRulesDefinition,
  PersonalizationDefinition,
  ScenarioDefinition,
  SkillDefinitionV2,
} from '../../../engine/runtime/PersonalizationRuntimeContract.js';
import {
  buildFundingTemplateBuiltinDraft,
  isFundingTemplateBuiltinDraftReady,
} from '../../../engine/personalization/FundingTemplateBuiltinDraft.js';

/**
 * Legacy alpha fixture retained only to exercise migration and compatibility.
 * Production startup and renderer code never import or seed these definitions.
 */

const FACTORY_TIME = 1_785_398_400_000;

function factoryProvenance() {
  return {
    origin: 'builtin' as const,
    author: 'Metis',
    version: '1.0.0',
    license: 'Apache-2.0',
    sourceUrl: null,
    sourceRevision: null,
    installedDigest: null,
    parentId: null,
    parentVersion: null,
    locallyModified: false,
    createdAt: FACTORY_TIME,
    updatedAt: FACTORY_TIME,
  };
}

function skillMarkdown(name: string, description: string, systemPrompt: string): string {
  return [
    `# ${name}`,
    '',
    '## Purpose',
    '',
    description,
    '',
    '## Instructions',
    '',
    systemPrompt,
  ].join('\n');
}

export function buildBuiltinSkillDefinitions(): SkillDefinitionV2[] {
  return DEFAULT_SKILLS.map((skill): SkillDefinitionV2 => ({
    contractVersion: 1,
    id: `builtin:skills/${skill.id}`,
    kind: 'skill',
    name: skill.name,
    description: skill.description,
    enabled: true,
    tags: skill.tags ?? [],
    revision: 1,
    provenance: {
      ...factoryProvenance(),
      version: skill.version ?? '1.0.0',
    },
    sourceMode: 'markdown',
    markdown: skillMarkdown(skill.name, skill.description, skill.systemPrompt),
    systemPrompt: skill.systemPrompt,
    toolIds: skill.allowedTools ?? [],
    mcpIds: [],
    maxTurns: skill.maxTurns ?? 12,
    inputSchema: skill.inputSchema ?? null,
    outputSchema: skill.outputSchema ?? null,
    packageEntry: null,
  }));
}

type WorkflowStep = ScenarioDefinition['workflow'][number];

interface WorkflowRecipe {
  id: string;
  name: string;
  description: string;
  skills: string[];
  dependsOn: string[];
  maxTurns: number;
}

interface PresetOutputPlan {
  primaryDeliverable: string;
  requiredArtifacts: string[];
  qualityGates: string[];
}

interface ScenarioProfile {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  capability: ScenarioDefinition['capability'];
  role: string;
  agentPrompt: string;
  workflow: WorkflowRecipe[];
  triggerPhrases: string[];
  outputFormat?: AgentDefinition['output']['format'];
  outputPlan: PresetOutputPlan;
}

interface VenueOverlay {
  key: string;
  label: string;
  zhLabel: string;
  description: string;
  role: string;
  agentPrompt: string;
  gate: Omit<WorkflowRecipe, 'dependsOn'>;
  outputPlan: PresetOutputPlan;
}

interface ArticleTypeProfile extends ScenarioProfile {
  articleKey: string;
  zhLabel: string;
  terminalStepId: string;
}

const FULL_ACCESS: ScenarioDefinition['fullAccess'] = Object.freeze({
  mode: 'full_access',
  perActionConfirmation: false,
  liveSteering: true,
  silentCheckpoints: true,
  rollbackOnFailure: false,
  persistAcrossRestart: true,
});

const PROJECT_MEMORY: AgentDefinition['memory'] = Object.freeze({
  scope: 'project',
  retainDecisions: true,
  retainArtifacts: true,
  maxSummaryChars: 100_000,
});

function outputContract(
  format: AgentDefinition['output']['format'],
  plan?: PresetOutputPlan,
): AgentDefinition['output'] {
  return {
    format,
    schema: plan ? {
      contract: 'metis.preset-output.v1',
      primaryDeliverable: plan.primaryDeliverable,
      requiredArtifacts: [...plan.requiredArtifacts],
      qualityGates: [...plan.qualityGates],
    } : null,
    requireEvidenceEnvelope: true,
    includeIntegrityReport: true,
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function outputPlan(
  primaryDeliverable: string,
  requiredArtifacts: readonly string[],
  qualityGates: readonly string[],
): PresetOutputPlan {
  return {
    primaryDeliverable,
    requiredArtifacts: unique(requiredArtifacts),
    qualityGates: unique(qualityGates),
  };
}

function mergeOutputPlans(
  primaryDeliverable: string,
  ...plans: readonly PresetOutputPlan[]
): PresetOutputPlan {
  return outputPlan(
    primaryDeliverable,
    plans.flatMap((plan) => plan.requiredArtifacts),
    plans.flatMap((plan) => plan.qualityGates),
  );
}

function withVenueGate(
  workflow: readonly WorkflowRecipe[],
  overlay: VenueOverlay,
  terminalStepId: string,
): WorkflowRecipe[] {
  if (!workflow.some((step) => step.id === terminalStepId)) {
    throw new Error(`Venue gate dependency is unavailable: ${terminalStepId}`);
  }
  return [
    ...workflow.map((step) => ({
      ...step,
      skills: [...step.skills],
      dependsOn: [...step.dependsOn],
    })),
    { ...overlay.gate, skills: [...overlay.gate.skills], dependsOn: [terminalStepId] },
  ];
}

function requiredSkill(skills: readonly SkillDefinitionV2[], legacyId: string): SkillDefinitionV2 {
  const skill = skills.find((candidate) => candidate.id === `builtin:skills/${legacyId}`);
  if (!skill) throw new Error(`Built-in skill is unavailable: ${legacyId}`);
  return skill;
}

function makeProfileDefinitions(
  profile: ScenarioProfile,
  skills: readonly SkillDefinitionV2[],
  globalRules: MetisRulesDefinition,
): [AgentDefinition, ScenarioDefinition] {
  const recipeSkills = unique(profile.workflow.flatMap((step) => step.skills))
    .map((skillId) => requiredSkill(skills, skillId));
  const agentId = `builtin:agents/${profile.slug}`;
  const output = outputContract(profile.outputFormat ?? 'document', profile.outputPlan);
  const agent: AgentDefinition = {
    contractVersion: 1,
    id: agentId,
    kind: 'agent',
    name: `${profile.name} agent`,
    description: profile.description,
    enabled: true,
    tags: unique(['research', ...profile.tags]),
    revision: 1,
    provenance: factoryProvenance(),
    role: profile.role,
    systemPrompt: [
      profile.agentPrompt,
      `Primary deliverable: ${profile.outputPlan.primaryDeliverable}.`,
      `Required supporting artifacts: ${profile.outputPlan.requiredArtifacts.join('; ')}.`,
      `Do not declare the scenario complete until these quality gates are explicit: ${profile.outputPlan.qualityGates.join('; ')}.`,
      'Use the user\'s working language. When the user works in Chinese, use clear academic Chinese unless the target venue or institution requires another language.',
      'Execute only capabilities provided by the bound skills and tools.',
      'Treat venue, institution, and funding-program rules as unverified until bound to a current official or user-provided source.',
      'Preserve source identity and uncertainty; never manufacture evidence, review outcomes, statistics, or completed artifacts.',
    ].join('\n\n'),
    modelPreference: null,
    skillIds: recipeSkills.map((skill) => skill.id),
    toolIds: unique(recipeSkills.flatMap((skill) => skill.toolIds)),
    mcpIds: [],
    memory: PROJECT_MEMORY,
    output,
    maxTurns: Math.max(...profile.workflow.map((step) => step.maxTurns)),
    retryLimit: 2,
  };

  const workflow: WorkflowStep[] = profile.workflow.map((recipe) => {
    const stepSkills = recipe.skills.map((skillId) => requiredSkill(skills, skillId));
    return {
      id: recipe.id,
      name: recipe.name,
      description: recipe.description,
      agentId,
      skillIds: stepSkills.map((skill) => skill.id),
      toolIds: unique(stepSkills.flatMap((skill) => skill.toolIds)),
      mcpIds: [],
      dependsOn: recipe.dependsOn,
      maxTurns: recipe.maxTurns,
    };
  });
  const scenario: ScenarioDefinition = {
    contractVersion: 1,
    id: `builtin:scenarios/${profile.slug}`,
    kind: 'scenario',
    name: profile.name,
    description: profile.description,
    enabled: true,
    tags: unique(['research', ...profile.tags]),
    revision: 1,
    provenance: factoryProvenance(),
    agentIds: [agentId],
    skillIds: recipeSkills.map((skill) => skill.id),
    mcpIds: [],
    rulesIds: [globalRules.id],
    workflow,
    fullAccess: FULL_ACCESS,
    memory: PROJECT_MEMORY,
    output,
    triggerPhrases: profile.triggerPhrases,
    capability: profile.capability,
  };
  return [agent, scenario];
}

function standardArticleWorkflow(): WorkflowRecipe[] {
  return [
    { id: 'scope', name: 'Scope', description: 'Define the question, contribution, audience, and constraints.', skills: ['socratic-plan'], dependsOn: [], maxTurns: 12 },
    { id: 'evidence', name: 'Evidence review', description: 'Retrieve and synthesize traceable literature for the scoped question.', skills: ['literature-review'], dependsOn: ['scope'], maxTurns: 12 },
    { id: 'draft', name: 'Stage-gated draft', description: 'Develop the article through the existing academic writing stages.', skills: ['paper-writing'], dependsOn: ['evidence'], maxTurns: 20 },
    { id: 'citation-audit', name: 'Citation audit', description: 'Verify citations, claims, and integrity signals in the draft.', skills: ['citation-check'], dependsOn: ['draft'], maxTurns: 15 },
    { id: 'writing-quality', name: 'Writing quality', description: 'Audit clarity, academic style, structure, and unsupported prose.', skills: ['writing-quality'], dependsOn: ['draft'], maxTurns: 12 },
    { id: 'final-review', name: 'Independent review', description: 'Review the evidence-bound draft after both audit branches complete.', skills: ['paper-review'], dependsOn: ['citation-audit', 'writing-quality'], maxTurns: 12 },
  ];
}

function reviewArticleWorkflow(): WorkflowRecipe[] {
  return [
    { id: 'scope', name: 'Review protocol', description: 'Define the review question, boundaries, and transparent protocol.', skills: ['socratic-plan'], dependsOn: [], maxTurns: 12 },
    { id: 'systematic-search', name: 'Systematic search', description: 'Run the existing PRISMA-aligned review workflow without inventing screening results.', skills: ['systematic-review'], dependsOn: ['scope'], maxTurns: 20 },
    { id: 'synthesis', name: 'Evidence synthesis', description: 'Synthesize only retrieved and traceable sources.', skills: ['literature-review'], dependsOn: ['systematic-search'], maxTurns: 12 },
    { id: 'draft', name: 'Review draft', description: 'Draft the review article through stage-gated writing.', skills: ['paper-writing'], dependsOn: ['synthesis'], maxTurns: 20 },
    { id: 'citation-audit', name: 'Citation audit', description: 'Verify references and evidence attribution.', skills: ['citation-check'], dependsOn: ['draft'], maxTurns: 15 },
    { id: 'final-review', name: 'Review quality gate', description: 'Review the completed article and its methodological limitations.', skills: ['paper-review', 'writing-quality'], dependsOn: ['citation-audit'], maxTurns: 12 },
  ];
}

function theoreticalWorkflow(): WorkflowRecipe[] {
  return [
    { id: 'scope', name: 'Conceptual scope', description: 'Define the theoretical problem, concepts, and intended contribution.', skills: ['socratic-plan'], dependsOn: [], maxTurns: 12 },
    { id: 'traditions', name: 'Literature and traditions', description: 'Map relevant theoretical traditions from traceable sources.', skills: ['literature-review'], dependsOn: ['scope'], maxTurns: 12 },
    { id: 'claim-audit', name: 'Claim audit', description: 'Test pivotal factual and interpretive claims against available sources.', skills: ['claim-audit'], dependsOn: ['traditions'], maxTurns: 8 },
    { id: 'draft', name: 'Theoretical draft', description: 'Draft the theoretical argument while keeping inference separate from source facts.', skills: ['paper-writing'], dependsOn: ['claim-audit'], maxTurns: 20 },
    { id: 'citation-audit', name: 'Citation audit', description: 'Verify the draft citation chain.', skills: ['citation-check'], dependsOn: ['draft'], maxTurns: 15 },
    { id: 'final-review', name: 'Argument review', description: 'Review argumentative coherence, limits, and writing quality.', skills: ['paper-review', 'writing-quality'], dependsOn: ['citation-audit'], maxTurns: 12 },
  ];
}

function qualitativeWorkflow(): WorkflowRecipe[] {
  return [
    { id: 'scope', name: 'Qualitative design scope', description: 'Define the qualitative question, units of analysis, materials, and limitations.', skills: ['socratic-plan'], dependsOn: [], maxTurns: 12 },
    { id: 'evidence', name: 'Context literature', description: 'Build a traceable contextual literature base.', skills: ['literature-review'], dependsOn: ['scope'], maxTurns: 12 },
    { id: 'source-reading', name: 'Source reading', description: 'Read user-provided PDF materials closely; do not claim unavailable transcription or coding.', skills: ['paper-reading'], dependsOn: ['scope'], maxTurns: 8 },
    { id: 'draft', name: 'Qualitative report draft', description: 'Write from the supplied materials and clearly label interpretation.', skills: ['paper-writing'], dependsOn: ['evidence', 'source-reading'], maxTurns: 20 },
    { id: 'claim-audit', name: 'Evidence claim audit', description: 'Audit claims that can be checked against the available source text.', skills: ['claim-audit', 'citation-check'], dependsOn: ['draft'], maxTurns: 15 },
    { id: 'final-review', name: 'Qualitative review', description: 'Review transparency, limits, transferability, and prose quality.', skills: ['paper-review', 'writing-quality'], dependsOn: ['claim-audit'], maxTurns: 12 },
  ];
}

function quantitativeWorkflow(): WorkflowRecipe[] {
  return [
    { id: 'scope', name: 'Quantitative question', description: 'Define hypotheses, variables, data requirements, and identification limits.', skills: ['socratic-plan'], dependsOn: [], maxTurns: 12 },
    { id: 'evidence', name: 'Method literature', description: 'Review traceable theory and methods literature.', skills: ['literature-review'], dependsOn: ['scope'], maxTurns: 12 },
    { id: 'design', name: 'Research design', description: 'Use the existing experiment-design capability to state design and assumptions.', skills: ['experiment-design'], dependsOn: ['scope'], maxTurns: 8 },
    { id: 'analysis', name: 'Data analysis', description: 'Analyze supplied data with explicit assumptions and limitations.', skills: ['data-analysis'], dependsOn: ['design'], maxTurns: 10 },
    { id: 'draft', name: 'Empirical draft', description: 'Draft the article using actual analysis outputs and literature.', skills: ['paper-writing'], dependsOn: ['evidence', 'analysis'], maxTurns: 20 },
    { id: 'audit', name: 'Evidence and citation audit', description: 'Audit reported claims, citations, and reproducibility limits.', skills: ['citation-check', 'paper-review'], dependsOn: ['draft'], maxTurns: 15 },
  ];
}

type ThesisLevel = 'masters' | 'doctoral';
type ThesisContext = 'china' | 'international';

function thesisWorkflow(level: ThesisLevel, context: ThesisContext): WorkflowRecipe[] {
  const institutionalStep: WorkflowRecipe = context === 'china'
    ? {
        id: 'cn-institutional-brief',
        name: 'Chinese institution requirements brief',
        description: 'Extract the current university and department requirements, degree type, language, abstract, review, and submission constraints from user-provided official materials; do not infer them from a generic national template.',
        skills: ['paper-reading', 'socratic-plan'], dependsOn: [], maxTurns: 12,
      }
    : {
        id: 'international-institutional-brief',
        name: 'International institution requirements brief',
        description: 'Extract the current handbook, discipline, ethics, required language, formatting, examination, and deposit constraints from the user-provided institution sources.',
        skills: ['paper-reading', 'socratic-plan'], dependsOn: [], maxTurns: 12,
      };
  const levelGate: WorkflowRecipe = level === 'doctoral'
    ? {
        id: 'doctoral-contribution-gate',
        name: 'Doctoral original-contribution gate',
        description: 'State the original contribution as defensible claims, contrast each claim with the closest literature, identify required evidence, and record boundary conditions and likely examiner objections.',
        skills: ['claim-audit', 'paper-review'], dependsOn: ['evidence', 'methodology-plan'], maxTurns: 15,
      }
    : {
        id: 'masters-feasibility-gate',
        name: 'Master thesis feasibility gate',
        description: 'Confirm that the question, evidence, method, schedule, and chapter scope are feasible for a master thesis without inflating the contribution claim.',
        skills: ['paper-review'], dependsOn: ['evidence', 'methodology-plan'], maxTurns: 10,
      };
  const submissionStep: WorkflowRecipe = context === 'china'
    ? {
        id: 'cn-submission-package',
        name: 'Chinese degree submission package',
        description: 'Prepare the institution-bound submission checklist, Chinese and required foreign-language abstracts, terminology consistency list, bibliography checks, and unresolved-compliance register.',
        skills: ['writing-quality', 'citation-check'], dependsOn: ['final-review'], maxTurns: 12,
      }
    : {
        id: 'international-submission-package',
        name: 'International degree submission package',
        description: 'Prepare the institution-bound submission, language, ethics, examination, repository-deposit, and unresolved-compliance checklist without assuming one country-wide format.',
        skills: ['writing-quality', 'citation-check'], dependsOn: ['final-review'], maxTurns: 12,
      };
  return [
    institutionalStep,
    { id: 'scope', name: 'Thesis scope and contribution', description: 'Define the research question, contribution level, audience, boundaries, and completion criteria under the verified institution brief.', skills: ['socratic-plan'], dependsOn: [institutionalStep.id], maxTurns: 15 },
    { id: 'evidence', name: 'Literature foundation', description: 'Build a traceable literature map that distinguishes established findings, contested claims, gaps, and the thesis position.', skills: ['literature-review'], dependsOn: ['scope'], maxTurns: 15 },
    { id: 'methodology-plan', name: 'Methodology and evidence plan', description: 'Specify the method, materials or data, analysis logic, limitations, ethics dependencies, and evidence needed for every research question.', skills: ['socratic-plan', 'literature-review'], dependsOn: ['scope'], maxTurns: 15 },
    levelGate,
    { id: 'chapter-architecture', name: 'Chapter architecture', description: 'Define the function, inputs, key claims, evidence, and handoff of every chapter so the thesis is one argument rather than disconnected papers.', skills: ['socratic-plan', 'paper-writing'], dependsOn: ['scope', 'methodology-plan'], maxTurns: 15 },
    { id: 'chapter-draft', name: 'Chapter-by-chapter drafting', description: 'Draft one chapter at a time from its evidence packet, preserve open gaps, and keep the approved contribution and chapter handoffs visible.', skills: ['paper-writing'], dependsOn: ['evidence', levelGate.id, 'chapter-architecture'], maxTurns: level === 'doctoral' ? 30 : 24 },
    { id: 'citation-audit', name: 'Citation and integrity audit', description: 'Audit citations, locators, claim support, bibliography integrity, and source status across the complete draft.', skills: ['citation-check'], dependsOn: ['chapter-draft'], maxTurns: 15 },
    { id: 'cross-chapter-review', name: 'Cross-chapter coherence review', description: 'Review concept definitions, method consistency, terminology, repetition, contradictions, chapter transitions, and whether conclusions answer the original questions.', skills: ['claim-audit', 'writing-quality'], dependsOn: ['chapter-draft'], maxTurns: 15 },
    { id: 'final-review', name: level === 'doctoral' ? 'Dissertation and defense readiness review' : 'Master thesis final review', description: level === 'doctoral'
      ? 'Run an examiner-style review of originality, evidence, method, limitations, cross-chapter coherence, and defensibility after both audit branches complete.'
      : 'Run a proportionate final review of question fit, evidence, method, chapter coherence, limitations, and completion after both audit branches complete.', skills: ['paper-review'], dependsOn: ['citation-audit', 'cross-chapter-review'], maxTurns: 15 },
    submissionStep,
  ];
}

function thesisOutputPlan(level: ThesisLevel, context: ThesisContext): PresetOutputPlan {
  const levelArtifacts = level === 'doctoral'
    ? ['original-contribution matrix', 'examiner-objection and defense-readiness dossier']
    : ['scope-and-feasibility memo', 'proportionate contribution statement'];
  const contextArtifacts = context === 'china'
    ? ['Chinese institution requirements brief', 'Chinese degree submission package']
    : ['international institution requirements brief', 'language, ethics, examination, and deposit checklist'];
  return outputPlan(
    level === 'doctoral' ? 'complete, defensible doctoral dissertation' : 'complete, feasible master thesis',
    [
      ...contextArtifacts,
      ...levelArtifacts,
      'research-question and evidence matrix',
      'methodology and limitations plan',
      'chapter architecture with handoffs',
      'chapter manuscripts',
      'citation and cross-chapter audit reports',
      'final thesis or dissertation manuscript',
    ],
    [
      'institution requirements are bound to supplied current sources',
      level === 'doctoral' ? 'every originality claim is contrasted with the closest literature' : 'the contribution is proportionate to master level and feasible',
      'every chapter has a defined function, evidence packet, and transition',
      'citation and cross-chapter audits complete before final review',
      'unresolved evidence, ethics, language, or compliance gaps remain explicit',
    ],
  );
}

function monographWorkflow(): WorkflowRecipe[] {
  return [
    {
      id: 'topic-positioning',
      name: 'Topic positioning',
      description: 'Produce a positioning brief that fixes the book-level scholarly problem, audience, central thesis, contribution, competing books or traditions, boundaries, and completion criteria.',
      skills: ['socratic-plan'],
      dependsOn: [],
      maxTurns: 15,
    },
    {
      id: 'manuscript-architecture',
      name: 'Monograph architecture and table of contents',
      description: 'Design the book-level argument, table of contents, chapter promises, inputs and outputs, dependency order, narrative arc, and explicit handoffs between chapters.',
      skills: ['socratic-plan', 'paper-writing'],
      dependsOn: ['topic-positioning'],
      maxTurns: 18,
    },
    {
      id: 'source-evidence-plan',
      name: 'Sources and evidence plan',
      description: 'Build a chapter-claim-evidence matrix that maps every pivotal claim to source needs, locators, evidence state, competing interpretations, gaps, and verification work.',
      skills: ['literature-review', 'claim-audit'],
      dependsOn: ['topic-positioning', 'manuscript-architecture'],
      maxTurns: 18,
    },
    {
      id: 'chapter-research',
      name: 'Chapter-by-chapter research',
      description: 'Research each chapter chapter-by-chapter and create one dossier per chapter with claim cards, source locators, quotations or data references, counterevidence, open gaps, and a readiness decision before drafting.',
      skills: ['literature-review', 'paper-reading'],
      dependsOn: ['source-evidence-plan'],
      maxTurns: 25,
    },
    {
      id: 'chapter-writing',
      name: 'Chapter-by-chapter writing',
      description: 'Write each chapter chapter-by-chapter from its research dossier, preserve its promise and handoff, record deferred gaps, and do not silently turn article fragments into a book chapter.',
      skills: ['paper-writing'],
      dependsOn: ['manuscript-architecture', 'chapter-research'],
      maxTurns: 30,
    },
    {
      id: 'citation-verification',
      name: 'Citation verification',
      description: 'Verify citations, locators, bibliography identity, source status, attribution, and claim support across every drafted chapter and record unresolved evidence gaps.',
      skills: ['citation-check'],
      dependsOn: ['chapter-writing'],
      maxTurns: 20,
    },
    {
      id: 'cross-chapter-consistency',
      name: 'Cross-chapter concept and argument consistency',
      description: 'Produce a cross-chapter consistency ledger for concept definitions, terminology, actors, chronology, argumentative dependencies, evidence reuse, repetition, omissions, and contradictions.',
      skills: ['claim-audit', 'writing-quality'],
      dependsOn: ['chapter-writing'],
      maxTurns: 18,
    },
    {
      id: 'manuscript-review',
      name: 'Manuscript-wide editing and review',
      description: 'Perform development editing, whole-book argument review, chapter transition repair, repetition control, and prose review only after citation and consistency gates have passed.',
      skills: ['paper-review', 'writing-quality'],
      dependsOn: ['citation-verification', 'cross-chapter-consistency'],
      maxTurns: 20,
    },
    {
      id: 'final-manuscript',
      name: 'Final manuscript delivery',
      description: 'Deliver the complete manuscript, front and back matter plan, bibliography, chapter dossiers, consistency ledger, integrity report, unresolved limitations, and artifact provenance.',
      skills: ['paper-writing', 'paper-review'],
      dependsOn: ['manuscript-review'],
      maxTurns: 15,
    },
  ];
}

function monographOutputPlan(): PresetOutputPlan {
  return outputPlan(
    'coherent, evidence-bound academic monograph manuscript',
    [
      'topic-positioning and competing-book brief',
      'book thesis, table of contents, chapter promises, and handoff map',
      'chapter-claim-evidence matrix',
      'one traceable research dossier per chapter',
      'chapter-by-chapter manuscript',
      'citation and unresolved-evidence report',
      'cross-chapter concept, chronology, repetition, and contradiction ledger',
      'developmental and whole-manuscript review',
      'final manuscript, bibliography, front/back matter plan, and provenance bundle',
    ],
    [
      'the project has a book-level thesis and contribution rather than an article collection',
      'every chapter has a distinct promise, evidence packet, and explicit handoff',
      'each pivotal claim maps to traceable evidence or an unresolved gap',
      'citation verification and cross-chapter consistency both pass before whole-manuscript editing',
      'the final bundle preserves limitations, unresolved gaps, and artifact provenance',
    ],
  );
}

type OfficialFundingProgram = 'nssfc' | 'moe-humanities';

function fundWorkflow(program: OfficialFundingProgram): WorkflowRecipe[] {
  if (program === 'nssfc') {
    return [
      { id: 'nssfc-call-brief', name: 'NSSFC call and form brief', description: 'Extract the exact eligible category, discipline, current form sections, limits, and evaluation language from the current official call and form.', skills: ['paper-reading', 'socratic-plan'], dependsOn: [], maxTurns: 12 },
      { id: 'nssfc-topic-rationale', name: 'Problem orientation and topic rationale', description: 'Define the problem consciousness, academic and practical value, scope, and title logic without substituting slogans for a researchable question.', skills: ['socratic-plan'], dependsOn: ['nssfc-call-brief'], maxTurns: 15 },
      { id: 'nssfc-scholarship-map', name: 'Domestic and international scholarship map', description: 'Build a traceable map of relevant domestic and international scholarship, competing positions, and the exact gap the proposal addresses.', skills: ['literature-review'], dependsOn: ['nssfc-topic-rationale'], maxTurns: 15 },
      { id: 'nssfc-research-design', name: 'Research content and design', description: 'Align objectives, key and difficult problems, content modules, method, schedule, and evidence with the scoped question.', skills: ['socratic-plan', 'paper-writing'], dependsOn: ['nssfc-scholarship-map'], maxTurns: 15 },
      { id: 'nssfc-proposal-draft', name: 'NSSFC proposal draft', description: 'Draft against the verified official structure while keeping unknown limits and applicant-specific information unresolved.', skills: ['paper-writing'], dependsOn: ['nssfc-research-design'], maxTurns: 24 },
      { id: 'nssfc-innovation-feasibility', name: 'Innovation and feasibility gate', description: 'Separate genuine theoretical, perspective, method, or material innovation from generic novelty language and test feasibility against foundation, team, schedule, and outputs actually supplied.', skills: ['claim-audit', 'paper-review'], dependsOn: ['nssfc-proposal-draft'], maxTurns: 15 },
      { id: 'nssfc-final-review', name: 'NSSFC evidence and writing review', description: 'Audit citations, factual claims, section alignment, terminology, feasibility, and unresolved official-form constraints.', skills: ['citation-check', 'writing-quality'], dependsOn: ['nssfc-innovation-feasibility'], maxTurns: 15 },
    ];
  }
  return [
    { id: 'moe-call-brief', name: 'MOE humanities call and form brief', description: 'Extract the exact program category, eligibility, current form sections, limits, and evaluation requirements from official call materials.', skills: ['paper-reading', 'socratic-plan'], dependsOn: [], maxTurns: 12 },
    { id: 'moe-program-fit', name: 'Humanities and social-science program fit', description: 'Define the research problem, educational or humanities relevance where actually applicable, project scale, audience, and program fit without inventing a policy priority.', skills: ['socratic-plan'], dependsOn: ['moe-call-brief'], maxTurns: 12 },
    { id: 'moe-evidence-gap', name: 'Evidence and gap review', description: 'Build a traceable scholarship and evidence foundation for the exact project problem.', skills: ['literature-review'], dependsOn: ['moe-program-fit'], maxTurns: 12 },
    { id: 'moe-workplan-outcomes', name: 'Work plan, outcomes, and feasibility', description: 'Align objectives, tasks, methods, milestones, feasible outputs, dissemination, and team basis to the verified form and project scale.', skills: ['socratic-plan', 'paper-writing'], dependsOn: ['moe-evidence-gap'], maxTurns: 15 },
    { id: 'moe-proposal-draft', name: 'MOE humanities proposal draft', description: 'Draft section by section against the verified form without inventing eligibility, quotas, word limits, or applicant achievements.', skills: ['paper-writing'], dependsOn: ['moe-workplan-outcomes'], maxTurns: 22 },
    { id: 'moe-claim-audit', name: 'MOE evidence and feasibility audit', description: 'Audit citations, factual claims, expected outcomes, schedule, feasibility, and alignment between problem, tasks, method, and outputs.', skills: ['citation-check', 'claim-audit'], dependsOn: ['moe-proposal-draft'], maxTurns: 15 },
    { id: 'moe-final-review', name: 'MOE proposal review', description: 'Review structure, clarity, program fit, official-form compliance gaps, and writing quality.', skills: ['paper-review', 'writing-quality'], dependsOn: ['moe-claim-audit'], maxTurns: 12 },
  ];
}

function fundingOutputPlan(program: OfficialFundingProgram): PresetOutputPlan {
  return program === 'nssfc'
    ? outputPlan(
        'source-bound National Social Science Fund proposal package',
        ['current NSSFC call and form brief', 'topic-rationale memo', 'domestic and international scholarship map', 'research-content and method matrix', 'proposal manuscript', 'innovation-and-feasibility matrix', 'citation and compliance-gap report'],
        ['official call and form control every claimed requirement', 'problem, gap, content, method, innovation, foundation, and outputs form one traceable chain', 'innovation claims are specific and evidence-bound', 'unknown applicant or program facts remain unresolved'],
      )
    : outputPlan(
        'source-bound Ministry of Education humanities and social sciences proposal package',
        ['current MOE call and form brief', 'program-fit memo', 'scholarship and evidence map', 'task-method-milestone-output matrix', 'proposal manuscript', 'feasibility and claim audit', 'compliance-gap report'],
        ['official call and form control every claimed requirement', 'project scale and outputs remain feasible for the selected category', 'problem, evidence, tasks, methods, schedule, and outcomes stay aligned', 'unknown applicant or program facts remain unresolved'],
      );
}

function policyBriefWorkflow(): WorkflowRecipe[] {
  return [
    { id: 'policy-question', name: 'Decision question and audience', description: 'Define the decision, jurisdiction, time horizon, affected population, decision maker, and what is outside scope.', skills: ['socratic-plan'], dependsOn: [], maxTurns: 12 },
    { id: 'policy-evidence-map', name: 'Policy evidence and stakeholder map', description: 'Map current authoritative sources, research evidence, stakeholder positions, implementation context, uncertainty, and missing evidence.', skills: ['literature-review', 'paper-reading'], dependsOn: ['policy-question'], maxTurns: 15 },
    { id: 'policy-options', name: 'Options and trade-off analysis', description: 'Compare a baseline and credible policy options across mechanism, benefits, costs, distributional effects, feasibility, risks, and evidence strength.', skills: ['claim-audit', 'socratic-plan'], dependsOn: ['policy-evidence-map'], maxTurns: 15 },
    { id: 'policy-recommendation', name: 'Recommendation and implementation path', description: 'Draft a proportionate recommendation, implementation sequence, owner assumptions, monitoring indicators, and explicit conditions that could change the recommendation.', skills: ['paper-writing'], dependsOn: ['policy-options'], maxTurns: 15 },
    { id: 'policy-audit', name: 'Policy claim and neutrality audit', description: 'Audit factual claims, source dates, legal or jurisdiction assumptions, option balance, affected groups, uncertainty, and unsupported advocacy.', skills: ['citation-check', 'paper-review'], dependsOn: ['policy-recommendation'], maxTurns: 15 },
    { id: 'policy-brief', name: 'Decision-ready policy brief', description: 'Produce a concise brief with executive summary, decision context, evidence, options, recommendation, implementation, risks, indicators, and source notes.', skills: ['writing-quality', 'paper-writing'], dependsOn: ['policy-audit'], maxTurns: 12 },
  ];
}

function teachingDesignWorkflow(): WorkflowRecipe[] {
  return [
    { id: 'learner-context', name: 'Learner and teaching context', description: 'Define learner level, prerequisites, course duration, delivery constraints, accessibility needs, language, and institution requirements.', skills: ['socratic-plan'], dependsOn: [], maxTurns: 12 },
    { id: 'learning-outcomes', name: 'Observable learning outcomes', description: 'Write measurable outcomes at an appropriate cognitive level and distinguish must-learn outcomes from optional enrichment.', skills: ['socratic-plan'], dependsOn: ['learner-context'], maxTurns: 12 },
    { id: 'teaching-evidence', name: 'Content and pedagogy evidence', description: 'Build a traceable reading and evidence foundation for subject content and any pedagogy claims used in the design.', skills: ['literature-review'], dependsOn: ['learning-outcomes'], maxTurns: 12 },
    { id: 'course-architecture', name: 'Course and session architecture', description: 'Sequence modules and sessions so prerequisites, concepts, activities, readings, and workload build toward the outcomes.', skills: ['socratic-plan', 'paper-writing'], dependsOn: ['learning-outcomes', 'teaching-evidence'], maxTurns: 15 },
    { id: 'assessment-alignment', name: 'Assessment and rubric alignment', description: 'Map every outcome to formative and summative evidence, criteria, feedback opportunities, workload, and academic-integrity expectations.', skills: ['paper-writing', 'claim-audit'], dependsOn: ['course-architecture'], maxTurns: 15 },
    { id: 'teaching-package-review', name: 'Teaching package quality review', description: 'Review constructive alignment, feasibility, accessibility, inclusion, workload, reading traceability, rubric clarity, and unresolved institution constraints.', skills: ['paper-review', 'writing-quality'], dependsOn: ['assessment-alignment'], maxTurns: 12 },
  ];
}

function uploadedFundTemplateWorkflow(useVerifiedTemplateTools: boolean): WorkflowRecipe[] {
  return [
    {
      id: 'inspect-template',
      name: 'Inspect verified uploaded template',
      description: useVerifiedTemplateTools
        ? 'Discover saved funding templates, select the intended exact active version, and read its verified normalized sections, fields, instructions, limits, and observable layout through main-process-bound read-only tools.'
        : 'Stop until the dedicated funding-template tools are registered; do not fall back to generic file reading.',
      skills: useVerifiedTemplateTools ? ['funding-template-analysis'] : ['paper-reading'],
      dependsOn: [],
      maxTurns: 8,
    },
    { id: 'derive-structure', name: 'Derive proposal structure', description: 'Turn observed template sections into a proposed application outline.', skills: ['socratic-plan'], dependsOn: ['inspect-template'], maxTurns: 12 },
    { id: 'evidence-plan', name: 'Evidence plan', description: 'Map each proposed section to traceable evidence needs.', skills: ['literature-review'], dependsOn: ['derive-structure'], maxTurns: 12 },
    { id: 'template-draft', name: 'Template-aligned draft', description: 'Draft against the observed structure; unsupported visual or form behavior is not claimed.', skills: ['paper-writing'], dependsOn: ['evidence-plan'], maxTurns: 20 },
    { id: 'audit', name: 'Template draft audit', description: 'Audit citations, claims, and writing quality.', skills: ['citation-check', 'writing-quality'], dependsOn: ['template-draft'], maxTurns: 15 },
  ];
}

function scenarioProfiles(useVerifiedTemplateTools = false): ScenarioProfile[] {
  const standardArticleOutput = outputPlan(
    'submission-ready, source-grounded journal article',
    ['target-journal source brief', 'question-contribution-outline memo', 'traceable evidence map', 'article manuscript', 'citation audit', 'writing and reviewer revision log'],
    ['the exact target-journal rules are attached as current sources', 'the contribution follows from the evidence and method', 'citation and writing audits complete before final review', 'unresolved evidence and venue-fit gaps remain explicit'],
  );
  const venueOverlays: VenueOverlay[] = [
    {
      key: 'sci', label: 'SCI', zhLabel: 'SCI',
      description: 'A science-indexed journal workflow with an explicit reporting, figures/tables, and reproducibility gate.',
      role: 'SCI reporting and reproducibility editor',
      agentPrompt: 'Prepare a science-indexed journal article. Bind the exact target-journal instructions as a current source and make methods, units, figures, tables, data or code availability, and reproducibility limits explicit where applicable.',
      gate: { id: 'sci-reporting-gate', name: 'SCI reporting and reproducibility gate', description: 'Check the target-journal source brief, method reproducibility, units and nomenclature, figures and tables, data/code statements, abstract-claim alignment, and unresolved reporting gaps.', skills: ['citation-check', 'writing-quality'], maxTurns: 15 },
      outputPlan: outputPlan('SCI-targeted article package', ['SCI target-journal source brief', 'methods and reproducibility checklist', 'figures, tables, units, and data/code statement checklist'], ['scientific reporting is reproducible to the extent supported by supplied materials', 'figures, tables, units, and abstract claims agree with the manuscript']),
    },
    {
      key: 'ssci', label: 'SSCI', zhLabel: 'SSCI',
      description: 'A social-science-indexed workflow with an explicit theory, construct, context, ethics, and interpretation gate.',
      role: 'SSCI theory, methods, and context editor',
      agentPrompt: 'Prepare an SSCI-oriented social-science article. Keep theory, constructs, empirical evidence, context, ethics, interpretation, and generalization limits distinct, and bind exact target-journal rules to current sources.',
      gate: { id: 'ssci-theory-context-gate', name: 'SSCI theory, construct, and context gate', description: 'Audit theoretical contribution, construct clarity, method fit, ethics or reflexivity where relevant, contextual scope, interpretation, and generalization limits against the target-journal brief.', skills: ['claim-audit', 'paper-review'], maxTurns: 15 },
      outputPlan: outputPlan('SSCI-targeted article package', ['SSCI target-journal source brief', 'theory and construct contribution matrix', 'context, ethics, interpretation, and generalization memo'], ['theoretical contribution and empirical support remain distinct', 'construct, context, ethics, and generalization limits are explicit']),
    },
    {
      key: 'pku-core', label: 'Peking University Core', zhLabel: '北大核心',
      description: 'A Chinese core-journal workflow with an explicit domestic scholarship, terminology, Chinese prose, and venue-fit gate.',
      role: 'Chinese core-journal scholarship and prose editor',
      agentPrompt: 'Prepare a Peking University Core-oriented Chinese journal article. Position it in the relevant domestic scholarly conversation, use precise Chinese academic terminology, and never infer one journal format or policy from the index label alone.',
      gate: { id: 'pku-scholarship-language-gate', name: 'Chinese scholarship and prose gate', description: 'Audit the domestic scholarship lineage, problem statement, Chinese academic terminology, title/abstract/keywords, section logic, citation practice, and exact target-journal requirements.', skills: ['literature-review', 'writing-quality'], maxTurns: 15 },
      outputPlan: outputPlan('Peking University Core-targeted article package', ['current Chinese target-journal source brief', 'domestic scholarship and debate map', 'Chinese title, abstract, keywords, terminology, and prose checklist'], ['the article is positioned in the relevant domestic scholarly conversation', 'Chinese terminology and abstract-level claims remain consistent']),
    },
    {
      key: 'cssci', label: 'CSSCI', zhLabel: 'CSSCI',
      description: 'A CSSCI-oriented workflow with an explicit problem consciousness, theory, contribution, and inference-boundary gate.',
      role: 'CSSCI problem, theory, and contribution editor',
      agentPrompt: 'Prepare a CSSCI-oriented social-science article with a specific problem consciousness, explicit theoretical dialogue, traceable evidence, a bounded contribution, and current journal rules supplied as sources.',
      gate: { id: 'cssci-problem-theory-gate', name: 'CSSCI problem, theory, and contribution gate', description: 'Audit problem consciousness, conceptual and theoretical dialogue, domestic and international scholarship, contribution type, evidence sufficiency, policy or practical inference boundaries, and Chinese prose.', skills: ['claim-audit', 'writing-quality'], maxTurns: 15 },
      outputPlan: outputPlan('CSSCI-targeted article package', ['CSSCI target-journal source brief', 'problem-theory-contribution matrix', 'domestic/international dialogue map', 'policy and practical inference-boundary memo'], ['problem, theory, evidence, and contribution form one explicit chain', 'policy or practical implications do not outrun the evidence']),
    },
    {
      key: 'cscd', label: 'CSCD', zhLabel: 'CSCD',
      description: 'A CSCD-oriented workflow with an explicit technical reporting, method, data, figures/tables, and reproducibility gate.',
      role: 'CSCD methods and technical-reporting editor',
      agentPrompt: 'Prepare a CSCD-oriented research article with precise technical terminology, reproducible method reporting, traceable data or material descriptions, and target-journal requirements bound to current sources.',
      gate: { id: 'cscd-method-reporting-gate', name: 'CSCD method and technical-reporting gate', description: 'Audit method completeness, data or material provenance, parameters and units, statistical reporting, figures and tables, terminology, reproducibility limits, and the current target-journal brief.', skills: ['citation-check', 'paper-review'], maxTurns: 15 },
      outputPlan: outputPlan('CSCD-targeted article package', ['CSCD target-journal source brief', 'method, material/data, parameter, and unit checklist', 'technical terminology and figure/table audit', 'reproducibility-limit statement'], ['technical claims map to reported method and evidence', 'parameters, units, figures, tables, and terminology are internally consistent']),
    },
  ];

  const articleTypeProfiles: ArticleTypeProfile[] = [
    {
      slug: 'article-review', name: 'Review article', description: 'A transparent review-article workflow built from the existing PRISMA, literature, writing, and audit skills.', tags: ['article', 'review'], capability: 'writing', role: 'Review article specialist',
      articleKey: 'review', zhLabel: '综述论文', terminalStepId: 'final-review',
      agentPrompt: 'Develop a review article using only actually retrieved sources and explicitly reported search, deduplication, screening, extraction, and synthesis actions.', workflow: reviewArticleWorkflow(), triggerPhrases: ['write a review article', '撰写综述文章'],
      outputPlan: outputPlan('transparent, source-grounded review article', ['review question and protocol', 'search strings and retrieval log', 'deduplication and screening log', 'included-study and evidence extraction matrix', 'synthesis map', 'review manuscript', 'review limitations'], ['reported counts match actual retrieval and screening actions', 'every synthesis claim maps to included traceable sources', 'heterogeneity and evidence gaps remain explicit']),
    },
    {
      slug: 'article-theoretical', name: 'Theoretical exposition article', description: 'A theory-focused article workflow that separates source facts, interpretation, and original argument.', tags: ['article', 'theory', 'theoretical'], capability: 'writing', role: 'Theoretical writing specialist',
      articleKey: 'theoretical', zhLabel: '理论阐释论文', terminalStepId: 'final-review',
      agentPrompt: 'Develop a theoretical exposition with explicit concepts, intellectual lineages, inferential steps, rival explanations, counterarguments, boundary conditions, and source/interpretation boundaries.', workflow: theoreticalWorkflow(), triggerPhrases: ['write a theoretical article', '撰写理论阐释文章'],
      outputPlan: outputPlan('coherent theoretical exposition article', ['concept glossary', 'theoretical lineage map', 'premise-inference-claim argument map', 'source fact versus interpretation ledger', 'counterargument and rival-explanation matrix', 'boundary-condition statement', 'article manuscript'], ['pivotal concepts are defined and used consistently', 'each inferential step and source boundary is visible', 'counterarguments and boundary conditions are answered without invented evidence']),
    },
    {
      slug: 'article-qualitative', name: 'Qualitative empirical article', description: 'A qualitative article workflow for user-supplied sources and close reading; no unavailable transcription or coding capability is claimed.', tags: ['article', 'qualitative'], capability: 'analysis', role: 'Qualitative research writing specialist',
      articleKey: 'qualitative', zhLabel: '定性实证论文', terminalStepId: 'final-review',
      agentPrompt: 'Develop a qualitative empirical article from user-supplied materials. Keep sampling or case selection, context, analytic procedure, source passages, interpretation, negative cases, reflexivity, and transferability limits visible; do not claim unavailable transcription or coding.', workflow: qualitativeWorkflow(), triggerPhrases: ['write a qualitative study', '撰写定性实证研究'],
      outputPlan: outputPlan('traceable qualitative empirical article', ['material/case and context inventory', 'sampling or case-selection rationale', 'analytic procedure and interpretation trail', 'source-passage-to-claim matrix', 'negative-case and reflexivity memo', 'transferability and limitation statement', 'article manuscript'], ['all empirical interpretations map to supplied materials', 'unavailable transcription, coding, consent, or fieldwork is not claimed', 'negative cases, reflexivity, and transferability limits are explicit']),
    },
    {
      slug: 'article-quantitative', name: 'Quantitative empirical article', description: 'A quantitative article workflow using the existing design, data analysis, writing, and audit capabilities.', tags: ['article', 'quantitative'], capability: 'analysis', role: 'Quantitative research writing specialist',
      articleKey: 'quantitative', zhLabel: '定量实证论文', terminalStepId: 'audit',
      agentPrompt: 'Develop a quantitative empirical article from actual supplied data and analysis results. Keep hypotheses or estimands, variables, sample construction, missingness, model assumptions, analysis outputs, robustness work, and limitations explicit; never invent statistics, sample properties, or significance.', workflow: quantitativeWorkflow(), triggerPhrases: ['write a quantitative study', '撰写定量实证研究'],
      outputPlan: outputPlan('reproducible quantitative empirical article', ['hypothesis or estimand table', 'data and sample provenance memo', 'variable/data dictionary', 'analysis plan and assumption register', 'actual model and descriptive outputs', 'robustness or sensitivity record', 'reproducibility and limitation statement', 'article manuscript'], ['every reported number comes from supplied data or actual analysis output', 'sample, variables, models, assumptions, missingness, and uncertainty are explicit', 'robustness limits and non-results are not hidden']),
    },
  ];

  const venueProfiles: ScenarioProfile[] = venueOverlays.map((venue) => ({
    slug: `journal-${venue.key}`,
    name: `${venue.label} journal article`,
    description: venue.description,
    tags: ['journal', venue.key],
    capability: 'writing',
    role: venue.role,
    agentPrompt: venue.agentPrompt,
    workflow: withVenueGate(standardArticleWorkflow(), venue, 'final-review'),
    triggerPhrases: [`start journal-${venue.key}`, `撰写${venue.zhLabel}期刊论文`],
    outputPlan: mergeOutputPlans(`${venue.label}-targeted journal article package`, standardArticleOutput, venue.outputPlan),
  }));

  const combinedJournalProfiles: ScenarioProfile[] = venueOverlays.flatMap((venue) => (
    articleTypeProfiles.map((articleType) => {
      return {
        slug: `journal-${venue.key}-${articleType.articleKey}`,
        name: `${venue.label} ${articleType.name}`,
        description: `${articleType.description} ${venue.description} Exact ${venue.label} target-journal rules remain source-bound rather than inferred from the index label.`,
        tags: unique(['journal', venue.key, ...articleType.tags]),
        capability: articleType.capability,
        role: `${venue.label} ${articleType.role}`,
        agentPrompt: `${venue.agentPrompt}\n\n${articleType.agentPrompt}`,
        workflow: withVenueGate(articleType.workflow, venue, articleType.terminalStepId),
        triggerPhrases: [
          `write a ${venue.key} ${articleType.articleKey} article`,
          `start ${venue.key} ${articleType.articleKey} journal workflow`,
          `撰写${venue.zhLabel}${articleType.zhLabel}`,
        ],
        outputPlan: mergeOutputPlans(`${venue.label} ${articleType.outputPlan.primaryDeliverable}`, articleType.outputPlan, venue.outputPlan),
      };
    })
  ));

  return [
    ...venueProfiles,
    ...articleTypeProfiles,
    ...combinedJournalProfiles,
    {
      slug: 'thesis-cn-masters', name: 'Chinese master thesis', description: 'An editable full-thesis workflow for a domestic Chinese master program.', tags: ['thesis', 'masters', 'china'], capability: 'writing', role: 'Chinese master thesis specialist',
      agentPrompt: 'Develop a feasible Chinese master thesis while treating the student’s current university handbook and department template as controlling sources and keeping the contribution proportionate to master level.', workflow: thesisWorkflow('masters', 'china'), triggerPhrases: ['write a Chinese master thesis', '撰写国内硕士毕业论文'], outputPlan: thesisOutputPlan('masters', 'china'),
    },
    {
      slug: 'thesis-international-masters', name: 'International master thesis', description: 'An editable full-thesis workflow for a master program outside mainland China.', tags: ['thesis', 'masters', 'international'], capability: 'writing', role: 'International master thesis specialist',
      agentPrompt: 'Develop a feasible international master thesis using the user’s current university handbook, discipline conventions, ethics requirements, examination model, and required language as explicit inputs.', workflow: thesisWorkflow('masters', 'international'), triggerPhrases: ['write an international master thesis', '撰写国外硕士毕业论文'], outputPlan: thesisOutputPlan('masters', 'international'),
    },
    {
      slug: 'thesis-cn-doctoral', name: 'Chinese doctoral dissertation', description: 'An editable dissertation workflow for a domestic Chinese doctoral program.', tags: ['thesis', 'doctoral', 'china'], capability: 'writing', role: 'Chinese doctoral dissertation specialist',
      agentPrompt: 'Develop a Chinese doctoral dissertation with a defensible original contribution, examiner-ready objection handling, and an auditable evidence chain governed by the current institution rules.', workflow: thesisWorkflow('doctoral', 'china'), triggerPhrases: ['write a Chinese doctoral dissertation', '撰写国内博士毕业论文'], outputPlan: thesisOutputPlan('doctoral', 'china'),
    },
    {
      slug: 'thesis-international-doctoral', name: 'International doctoral dissertation', description: 'An editable dissertation workflow for a doctoral program outside mainland China.', tags: ['thesis', 'doctoral', 'international'], capability: 'writing', role: 'International doctoral dissertation specialist',
      agentPrompt: 'Develop an international doctoral dissertation with explicit originality, methodology, ethics, limitations, examiner-facing defensibility, and institution-bound language, examination, and deposit requirements.', workflow: thesisWorkflow('doctoral', 'international'), triggerPhrases: ['write an international doctoral dissertation', '撰写国外博士毕业论文'], outputPlan: thesisOutputPlan('doctoral', 'international'),
    },
    {
      slug: 'academic-monograph', name: 'Academic monograph', description: 'An editable book-length research and writing workflow from topic positioning through final manuscript delivery.', tags: ['monograph', 'book', 'long-form'], capability: 'writing', role: 'Academic monograph specialist',
      agentPrompt: 'Develop a coherent academic monograph as a book-level argument. Position the book against competing literature, design chapter promises and handoffs, build one evidence dossier per chapter, write and accept chapters sequentially, reconcile the whole manuscript, and never treat disconnected article drafts as a finished book.', workflow: monographWorkflow(), triggerPhrases: ['write an academic monograph', 'develop a scholarly book', '撰写学术专著'], outputPlan: monographOutputPlan(),
    },
    {
      slug: 'fund-nssfc', name: 'National Social Science Fund proposal', description: 'An editable evidence-grounded proposal workflow for China’s National Social Science Fund.', tags: ['funding', 'nssfc'], capability: 'funding', role: 'National Social Science Fund proposal specialist',
      agentPrompt: 'Develop a National Social Science Fund proposal with explicit problem consciousness, domestic/international scholarship positioning, research content, method, innovation, foundation, feasibility, and outputs; apply every eligibility, section, limit, or formatting rule only when bound to current official call documents.', workflow: fundWorkflow('nssfc'), triggerPhrases: ['prepare an NSSFC proposal', '撰写国家社会科学基金申报书'], outputPlan: fundingOutputPlan('nssfc'),
    },
    {
      slug: 'fund-moe-humanities', name: 'Ministry of Education Humanities and Social Sciences proposal', description: 'An editable evidence-grounded proposal workflow for the Ministry of Education humanities and social sciences fund.', tags: ['funding', 'moe-humanities'], capability: 'funding', role: 'MOE humanities proposal specialist',
      agentPrompt: 'Develop a Ministry of Education humanities and social sciences proposal with program fit, a feasible project scale, evidence, tasks, methods, milestones, outputs, dissemination, and team basis aligned to the current official call and form.', workflow: fundWorkflow('moe-humanities'), triggerPhrases: ['prepare an MOE humanities proposal', '撰写教育部人文社科基金申报书'], outputPlan: fundingOutputPlan('moe-humanities'),
    },
    {
      slug: 'fund-uploaded-template', name: 'Uploaded fund template analysis', description: useVerifiedTemplateTools
        ? 'A conservative workflow that uses a persisted, integrity-checked funding template package and never exposes the local source path or applicant prose.'
        : 'A conservative workflow that analyzes observable structure in an uploaded PDF or extracted-text application form and drafts against it.', tags: ['funding', 'template'], capability: 'funding', role: 'Funding template analysis specialist',
      agentPrompt: useVerifiedTemplateTools
        ? 'Use only the dedicated funding-template list and verified structure DTO for the exact active repository version. Draft against observed normalized sections, fields, instructions, limits, and layout evidence; never request a local path, invent hidden content or coordinates, or bypass a revision/digest mismatch.'
        : 'Analyze only structure and text actually observable in the uploaded PDF or extracted content, then propose a reusable application outline without claiming unsupported layout extraction.', workflow: uploadedFundTemplateWorkflow(useVerifiedTemplateTools), triggerPhrases: ['analyze a fund application template', '分析上传的基金申报书模板'],
      outputPlan: outputPlan('traceable funding-template analysis and aligned draft package', ['observed template version and integrity summary', 'verified family, section, field, instruction, limit, and adjacent-version table', 'evidence-needs map', 'template-aligned outline and draft', 'unsupported-layout and unresolved-field register'], ['every derived section and field maps to verified normalized template structure', 'hidden fields, coordinates, limits, and applicant facts are not invented', 'the exact template revision remains identified']),
    },
    {
      slug: 'policy-brief', name: 'Evidence-grounded policy brief', description: 'A decision-oriented policy workflow from question framing and stakeholder evidence through options, recommendation, implementation, and audit.', tags: ['policy', 'decision-support'], capability: 'writing', role: 'Policy evidence synthesis and options specialist',
      agentPrompt: 'Develop a decision-ready policy brief that distinguishes authoritative rules, research evidence, stakeholder positions, model interpretation, and uncertainty. Compare credible options before recommending one and keep jurisdiction and implementation assumptions explicit.', workflow: policyBriefWorkflow(), triggerPhrases: ['write an evidence-grounded policy brief', '撰写循证政策简报', '分析政策选项'], outputFormat: 'artifact_bundle',
      outputPlan: outputPlan('decision-ready evidence-grounded policy brief package', ['decision question and scope memo', 'dated source and stakeholder evidence map', 'policy options and trade-off matrix', 'recommendation with conditions', 'implementation, risk, and monitoring plan', 'claim, neutrality, and uncertainty audit', 'concise policy brief'], ['authoritative rules, research evidence, stakeholder positions, and interpretation stay distinct', 'at least a baseline and credible alternatives are compared', 'recommendation strength matches evidence strength', 'jurisdiction, distributional effects, uncertainty, and implementation conditions are explicit']),
    },
    {
      slug: 'teaching-course-design', name: 'Research-informed course design', description: 'A teaching-design workflow from learner context and observable outcomes through evidence, course architecture, aligned assessment, and quality review.', tags: ['teaching', 'course-design', 'curriculum'], capability: 'writing', role: 'Research-informed curriculum and assessment designer',
      agentPrompt: 'Develop a teachable course package that aligns learner context, observable outcomes, evidence-based content, session sequence, activities, assessments, rubrics, workload, accessibility, and institution constraints. Do not invent accreditation or institution requirements.', workflow: teachingDesignWorkflow(), triggerPhrases: ['design a research-informed course', '设计研究导向课程', '制定课程与考核方案'], outputFormat: 'artifact_bundle',
      outputPlan: outputPlan('aligned, research-informed course design package', ['learner and constraint brief', 'observable learning-outcome matrix', 'evidence-based reading and content map', 'module and session sequence', 'activity and workload plan', 'assessment blueprint and rubrics', 'accessibility, inclusion, and academic-integrity checklist', 'quality-review and unresolved-constraint report'], ['every outcome maps to content, learning activity, and assessment evidence', 'course sequence respects prerequisites and feasible workload', 'readings and pedagogy claims remain traceable', 'accessibility, inclusion, integrity, and unknown institution constraints are explicit']),
    },
  ];
}

export function buildBuiltinPersonalizationDefinitions(
  options: { fundingTemplateRegisteredToolIds?: ReadonlySet<string> } = {},
): PersonalizationDefinition[] {
  const fundingTemplateToolsReady = isFundingTemplateBuiltinDraftReady(
    options.fundingTemplateRegisteredToolIds ?? new Set<string>(),
  );
  const baseSkills = buildBuiltinSkillDefinitions();
  const fundingDraft = buildFundingTemplateBuiltinDraft();
  const fundingSkill: SkillDefinitionV2 = {
    ...fundingDraft.skill,
    enabled: true,
    description: 'Read-only, integrity-bound analysis of funding template structure and adjacent version differences.',
    tags: fundingDraft.skill.tags.filter((tag) => tag !== 'draft'),
    provenance: { ...fundingDraft.skill.provenance, version: '1.0.0' },
  };
  const skills = fundingTemplateToolsReady
    ? [...baseSkills, fundingSkill]
    : baseSkills;
  const literatureReviewSkill = requiredSkill(skills, 'literature-review');

  const globalRules: MetisRulesDefinition = {
    contractVersion: 1,
    id: 'builtin:rules/global',
    kind: 'rules',
    name: 'Metis defaults',
    description: 'Default autonomous research behavior and integrity requirements.',
    enabled: true,
    tags: ['metis', 'default'],
    revision: 1,
    provenance: factoryProvenance(),
    scope: 'global',
    scopeId: null,
    markdown: [
      '# Metis.md',
      '',
      '- Work autonomously and accept live user steering.',
      '- Do not request per-action permission while Full Access is active.',
      '- Preserve source identity, evidence state, and artifact provenance.',
      '- Keep source facts, user positions, and model interpretation distinguishable.',
      '- Never present unverified material as verified.',
      '- Truth and correction state are assigned only by the automatic integrity layer, never by an editable scenario or agent.',
    ].join('\n'),
  };

  const generalAgent: AgentDefinition = {
    contractVersion: 1,
    id: 'builtin:agents/general-researcher',
    kind: 'agent',
    name: 'General researcher',
    description: 'A source-grounded general research agent.',
    enabled: true,
    tags: ['research'],
    revision: 1,
    provenance: factoryProvenance(),
    role: 'Researcher',
    systemPrompt: 'Plan and execute research with traceable evidence. Keep unverified material explicitly labeled.',
    modelPreference: null,
    skillIds: [literatureReviewSkill.id],
    toolIds: literatureReviewSkill.toolIds,
    mcpIds: [],
    memory: PROJECT_MEMORY,
    output: outputContract('artifact_bundle'),
    maxTurns: 20,
    retryLimit: 2,
  };

  const generalScenario: ScenarioDefinition = {
    contractVersion: 1,
    id: 'builtin:scenarios/general-research',
    kind: 'scenario',
    name: 'General research',
    description: 'The editable factory starting point for source-grounded research.',
    enabled: true,
    tags: ['research', 'default'],
    revision: 1,
    provenance: factoryProvenance(),
    agentIds: [generalAgent.id],
    skillIds: [literatureReviewSkill.id],
    mcpIds: [],
    rulesIds: [globalRules.id],
    workflow: [{
      id: 'research',
      name: 'Research',
      description: 'Plan, retrieve, verify, synthesize, and produce an integrity report.',
      agentId: generalAgent.id,
      skillIds: [literatureReviewSkill.id],
      toolIds: literatureReviewSkill.toolIds,
      mcpIds: [],
      dependsOn: [],
      maxTurns: 20,
    }],
    fullAccess: FULL_ACCESS,
    memory: PROJECT_MEMORY,
    output: generalAgent.output,
    triggerPhrases: ['start research', '开始研究', '研究这个问题'],
    capability: 'research',
  };

  const profileDefinitions = scenarioProfiles(fundingTemplateToolsReady)
    .flatMap((profile) => makeProfileDefinitions(profile, skills, globalRules));

  const presentationReserved: ScenarioDefinition = {
    contractVersion: 1,
    id: 'builtin:scenarios/presentation-reserved',
    kind: 'scenario',
    name: 'Presentation (reserved)',
    description: 'Reserved for a future product specification. No PPT behavior is currently defined.',
    enabled: false,
    tags: ['presentation', 'reserved'],
    revision: 1,
    provenance: factoryProvenance(),
    agentIds: [],
    skillIds: [],
    mcpIds: [],
    rulesIds: [globalRules.id],
    workflow: [],
    fullAccess: FULL_ACCESS,
    memory: PROJECT_MEMORY,
    output: outputContract('artifact_bundle'),
    triggerPhrases: [],
    capability: 'presentation_reserved',
  };

  return [
    ...skills,
    globalRules,
    generalAgent,
    generalScenario,
    ...profileDefinitions,
    presentationReserved,
  ];
}
