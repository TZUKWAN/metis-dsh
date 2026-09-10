import {
  FUNDING_TEMPLATE_GET_ACTIVE_TOOL_NAME,
  FUNDING_TEMPLATE_GET_DIFF_TOOL_NAME,
  FUNDING_TEMPLATE_LIST_TOOL_NAME,
} from '../runtime/FundingTemplateRuntimeContract.js';
import type {
  AgentDefinition,
  SkillDefinitionV2,
} from '../runtime/PersonalizationRuntimeContract.js';

const DRAFT_TIME = 1_900_030_000_000;

export const FUNDING_TEMPLATE_BUILTIN_REQUIRED_TOOLS = Object.freeze([
  FUNDING_TEMPLATE_LIST_TOOL_NAME,
  FUNDING_TEMPLATE_GET_ACTIVE_TOOL_NAME,
  FUNDING_TEMPLATE_GET_DIFF_TOOL_NAME,
] as const);

export interface FundingTemplateBuiltinDraft {
  status: 'inactive_pending_tool_registration';
  requiredToolIds: Array<(typeof FUNDING_TEMPLATE_BUILTIN_REQUIRED_TOOLS)[number]>;
  skill: SkillDefinitionV2;
  agent: AgentDefinition;
}

function provenance() {
  return {
    origin: 'builtin' as const,
    author: 'Metis',
    version: '0.1.0-draft',
    license: 'Apache-2.0',
    sourceUrl: null,
    sourceRevision: null,
    installedDigest: null,
    parentId: null,
    parentVersion: null,
    locallyModified: false,
    createdAt: DRAFT_TIME,
    updatedAt: DRAFT_TIME,
  };
}

function skillDefinition(): SkillDefinitionV2 {
  const toolIds = [...FUNDING_TEMPLATE_BUILTIN_REQUIRED_TOOLS];
  const systemPrompt = [
    'Use only the read-only funding template tools for templates previously imported by the user through the main-process FileCapability flow.',
    'First call funding_template_list with the trusted owner and project to discover saved templates and their exact repository revision, active version, and package digest. If more than one template is available and the user has not identified one, present the understandable choices before selecting.',
    'Then call funding_template_get_active with the exact discovered binding. Use only its verified normalized family, sections, blank-form fields, instructions, limits, layout, typography, quality flags, and evidence states when deriving an outline or drafting.',
    'Never invent a section, field, instruction, applicant fact, formatting coordinate, official currency, or unobserved layout value. Treat null and not_observed values as explicit gaps.',
    'Use funding_template_get_diff only for an adjacent persisted version comparison with the exact stored bindings.',
    'A stale revision, version, digest, archived template, missing registration, or integrity failure is a hard stop. Do not fall back to read_pdf, a local path, or an unverified reconstruction.',
    'This skill cannot import, activate, archive, restore, delete, or write a template.',
  ].join('\n\n');
  return {
    contractVersion: 1,
    id: 'builtin:skills/funding-template-analysis',
    kind: 'skill',
    name: 'Funding template integrity analysis',
    description: 'Inactive draft for discovering and reading verified structure and version differences from a previously imported funding template.',
    enabled: false,
    tags: ['funding', 'template', 'read-only', 'draft'],
    revision: 1,
    provenance: provenance(),
    sourceMode: 'markdown',
    markdown: [
      '# Funding template integrity analysis',
      '',
      '## Activation gate',
      '',
      'Keep this definition disabled until all required read-only tools are registered in the production ToolRegistry.',
      '',
      '## Instructions',
      '',
      systemPrompt,
    ].join('\n'),
    systemPrompt,
    toolIds,
    mcpIds: [],
    maxTurns: 8,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ownerId: { type: 'string' },
        projectId: { type: 'string' },
        templateId: { type: 'string' },
        templateRevision: { type: 'integer', minimum: 1 },
        templateVersion: { type: 'integer', minimum: 1 },
        packageDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      },
      required: ['ownerId', 'projectId'],
    },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        verified: { type: 'boolean' },
        family: { type: 'string', enum: ['nssfc', 'moe_humanities', 'custom', 'needs_review'] },
        templateVersion: { type: 'integer', minimum: 1 },
        packageDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        sections: { type: 'array', items: { type: 'string' } },
        fields: { type: 'array', items: { type: 'string' } },
        instructions: { type: 'array', items: { type: 'string' } },
        layoutEvidence: { type: 'string', enum: ['observed', 'partial', 'not_observed'] },
        integrityIssues: { type: 'array', items: { type: 'string' } },
      },
      required: [
        'verified', 'family', 'templateVersion', 'packageDigest',
        'sections', 'fields', 'instructions', 'layoutEvidence', 'integrityIssues',
      ],
    },
    packageEntry: null,
  };
}

function agentDefinition(skill: SkillDefinitionV2): AgentDefinition {
  return {
    contractVersion: 1,
    id: 'builtin:agents/funding-template-analysis',
    kind: 'agent',
    name: 'Funding template integrity agent',
    description: 'Inactive draft Agent for evidence-bound, read-only inspection of a saved funding template version.',
    enabled: false,
    tags: ['funding', 'template', 'read-only', 'draft'],
    revision: 1,
    provenance: provenance(),
    role: 'Funding template integrity reader',
    systemPrompt: [
      'Remain inactive until the main process has registered all required read-only funding template tools.',
      'Use the dedicated skill to discover saved templates, verify the selected active snapshot, and read an adjacent version diff only when needed.',
      'Draft only from verified normalized blank-form structure. Never request a local file path, import a document, mutate repository state, or reconstruct content not present in the Agent DTO.',
    ].join('\n\n'),
    modelPreference: null,
    skillIds: [skill.id],
    toolIds: [...skill.toolIds],
    mcpIds: [],
    memory: {
      scope: 'project',
      retainDecisions: true,
      retainArtifacts: true,
      maxSummaryChars: 50_000,
    },
    output: {
      format: 'artifact_bundle',
      schema: null,
      requireEvidenceEnvelope: true,
      includeIntegrityReport: true,
    },
    maxTurns: 8,
    retryLimit: 1,
  };
}

/** Returns a fresh, disabled draft. It never mutates the active factory catalog. */
export function buildFundingTemplateBuiltinDraft(): FundingTemplateBuiltinDraft {
  const skill = skillDefinition();
  return {
    status: 'inactive_pending_tool_registration',
    requiredToolIds: [...FUNDING_TEMPLATE_BUILTIN_REQUIRED_TOOLS],
    skill,
    agent: agentDefinition(skill),
  };
}

/** A main-process registration audit may use this gate before activating copies. */
export function isFundingTemplateBuiltinDraftReady(registeredToolIds: ReadonlySet<string>): boolean {
  return FUNDING_TEMPLATE_BUILTIN_REQUIRED_TOOLS.every((toolId) => registeredToolIds.has(toolId));
}
