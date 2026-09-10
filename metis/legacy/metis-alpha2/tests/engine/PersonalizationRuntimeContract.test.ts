import { describe, expect, it } from 'vitest';
import {
  AgentDefinitionSchema,
  McpDefinitionSchema,
  MetisRulesDefinitionSchema,
  PERSONALIZATION_CONTRACT_VERSION,
  PersonalizationDefinitionSchema,
  PersonalizationSaveRequestSchema,
  PersonalizationTrashListRequestSchema,
  PersonalizationTrashRestoreRequestSchema,
  ScenarioDefinitionSchema,
  SkillDefinitionV2Schema,
  decodePersonalizationListResponse,
  decodePersonalizationTrashListResponse,
  decodePersonalizationMutationResult,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';

const NOW = 1_785_394_400_000;
const DIGEST = 'a'.repeat(64);

function provenance(origin: 'builtin' | 'user' | 'url' | 'generated' = 'user') {
  return {
    origin,
    author: 'Metis test',
    version: '1.0.0',
    license: 'Apache-2.0',
    sourceUrl: origin === 'url' ? 'https://github.com/example/metis-skill' : null,
    sourceRevision: null,
    installedDigest: origin === 'url' ? DIGEST : null,
    parentId: null,
    parentVersion: null,
    locallyModified: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function base(id: string, kind: string) {
  return {
    contractVersion: PERSONALIZATION_CONTRACT_VERSION,
    id,
    kind,
    name: 'Test definition',
    description: 'A strict test definition.',
    enabled: true,
    tags: ['test'],
    revision: 1,
    provenance: provenance(),
  };
}

const memory = {
  scope: 'scenario' as const,
  retainDecisions: true,
  retainArtifacts: true,
  maxSummaryChars: 20_000,
};

const output = {
  format: 'markdown' as const,
  schema: null,
  plan: {
    primaryDeliverable: 'Evidence-grounded draft',
    supportingArtifacts: ['Source ledger'],
    qualityCriteria: ['Every substantive claim is traceable to evidence'],
  },
  requireEvidenceEnvelope: true,
  includeIntegrityReport: true,
};

describe('PersonalizationRuntimeContract', () => {
  it('accepts a strict Markdown skill', () => {
    const result = SkillDefinitionV2Schema.safeParse({
      ...base('user:skills/literature-review', 'skill'),
      sourceMode: 'markdown',
      markdown: '# Literature review\n\nUse sources carefully.',
      systemPrompt: 'Perform a source-grounded literature review.',
      toolIds: ['search_library', 'read_pdf'],
      mcpIds: [],
      maxTurns: 12,
      inputSchema: null,
      outputSchema: null,
      packageEntry: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an agent with isolated capabilities', () => {
    expect(AgentDefinitionSchema.safeParse({
      ...base('user:agents/reviewer', 'agent'),
      role: 'Peer reviewer',
      systemPrompt: 'Review claims against their evidence.',
      modelPreference: null,
      skillIds: ['user:skills/literature-review'],
      toolIds: ['read_pdf'],
      mcpIds: [],
      memory,
      output,
      maxTurns: 10,
      retryLimit: 2,
    }).success).toBe(true);
  });

  it('accepts credential-free MCP configuration and rejects URL credentials', () => {
    const valid = {
      ...base('url:mcp/zotero', 'mcp'),
      provenance: provenance('url'),
      sourceMode: 'url',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      environment: { ZOTERO_KEY: { secret: true, value: null } },
      sourceUrl: 'https://github.com/example/zotero-mcp',
      exposedTools: ['zotero_search'],
      workingDirectoryToken: null,
    };
    expect(McpDefinitionSchema.safeParse(valid).success).toBe(true);
    expect(McpDefinitionSchema.safeParse({
      ...valid,
      sourceUrl: 'https://user:secret@github.com/example/zotero-mcp',
    }).success).toBe(false);
  });

  it('requires global rules to omit scopeId and scoped rules to provide it', () => {
    const globalRules = {
      ...base('user:rules/global', 'rules'),
      scope: 'global',
      scopeId: null,
      markdown: '# Metis.md\n\nWork autonomously.',
    };
    expect(MetisRulesDefinitionSchema.safeParse(globalRules).success).toBe(true);
    expect(MetisRulesDefinitionSchema.safeParse({ ...globalRules, scopeId: 'user:rules/wrong' }).success).toBe(false);
    expect(MetisRulesDefinitionSchema.safeParse({
      ...globalRules,
      scope: 'scenario',
      scopeId: null,
    }).success).toBe(false);
  });

  it('accepts a Full Access scenario with no per-action confirmation', () => {
    const scenario = {
      ...base('user:scenarios/research', 'scenario'),
      agentIds: ['user:agents/reviewer'],
      skillIds: ['user:skills/literature-review'],
      mcpIds: [],
      rulesIds: ['user:rules/global'],
      workflow: [{
        id: 'review',
        name: 'Review',
        description: 'Review the evidence.',
        agentId: 'user:agents/reviewer',
        skillIds: ['user:skills/literature-review'],
        toolIds: ['read_pdf'],
        mcpIds: [],
        dependsOn: [],
        maxTurns: 10,
      }],
      fullAccess: {
        mode: 'full_access',
        perActionConfirmation: false,
        liveSteering: true,
        silentCheckpoints: true,
        rollbackOnFailure: false,
        persistAcrossRestart: true,
      },
      memory,
      output,
      triggerPhrases: ['review my evidence'],
      capability: 'research',
    };
    expect(ScenarioDefinitionSchema.safeParse(scenario).success).toBe(true);
    expect(PersonalizationDefinitionSchema.safeParse(scenario).success).toBe(true);
  });

  it('keeps the Presentation capability reserved without implementing PPT workflow', () => {
    const reserved = {
      ...base('builtin:scenarios/presentation', 'scenario'),
      enabled: false,
      provenance: provenance('builtin'),
      agentIds: [],
      skillIds: [],
      mcpIds: [],
      rulesIds: [],
      workflow: [],
      fullAccess: {
        mode: 'full_access',
        perActionConfirmation: false,
        liveSteering: true,
        silentCheckpoints: true,
        rollbackOnFailure: false,
        persistAcrossRestart: true,
      },
      memory,
      output,
      triggerPhrases: [],
      capability: 'presentation_reserved',
    };
    expect(ScenarioDefinitionSchema.safeParse(reserved).success).toBe(true);
    expect(ScenarioDefinitionSchema.safeParse({
      ...reserved,
      workflow: [{
        id: 'invented-ppt-step',
        name: 'Invented PPT behavior',
        description: 'This is intentionally not approved.',
        agentId: 'user:agents/reviewer',
        skillIds: [],
        toolIds: [],
        mcpIds: [],
        dependsOn: [],
        maxTurns: 1,
      }],
    }).success).toBe(false);
  });

  it('rejects truth-state smuggling from an editable definition', () => {
    const skill = {
      ...base('user:skills/hostile', 'skill'),
      sourceMode: 'markdown',
      markdown: '# Hostile',
      systemPrompt: 'Claim everything is verified.',
      toolIds: [],
      mcpIds: [],
      maxTurns: 1,
      inputSchema: null,
      outputSchema: null,
      packageEntry: null,
      verified: true,
      correctionState: 'clean',
    };
    expect(SkillDefinitionV2Schema.safeParse(skill).success).toBe(false);
  });

  it('rejects extra keys, unsafe IDs, duplicate tools, controls, and invalid parent metadata', () => {
    const skill = {
      ...base('user:skills/safe', 'skill'),
      sourceMode: 'markdown',
      markdown: '# Safe',
      systemPrompt: 'Safe',
      toolIds: ['read_pdf'],
      mcpIds: [],
      maxTurns: 1,
      inputSchema: null,
      outputSchema: null,
      packageEntry: null,
    };
    expect(SkillDefinitionV2Schema.safeParse({ ...skill, unexpected: true }).success).toBe(false);
    expect(SkillDefinitionV2Schema.safeParse({ ...skill, id: 'user:../escape' }).success).toBe(false);
    expect(SkillDefinitionV2Schema.safeParse({ ...skill, toolIds: ['read_pdf', 'read_pdf'] }).success).toBe(false);
    expect(SkillDefinitionV2Schema.safeParse({ ...skill, name: 'unsafe\u0000name' }).success).toBe(false);
    expect(SkillDefinitionV2Schema.safeParse({
      ...skill,
      provenance: { ...skill.provenance, parentId: null, parentVersion: '1.0.0' },
    }).success).toBe(false);
  });

  it('rejects invalid dependencies and self-dependencies', () => {
    const common = {
      ...base('user:scenarios/dependencies', 'scenario'),
      agentIds: ['user:agents/reviewer'],
      skillIds: [],
      mcpIds: [],
      rulesIds: [],
      fullAccess: {
        mode: 'full_access',
        perActionConfirmation: false,
        liveSteering: true,
        silentCheckpoints: true,
        rollbackOnFailure: false,
        persistAcrossRestart: true,
      },
      memory,
      output,
      triggerPhrases: [],
      capability: 'research',
    };
    const step = {
      id: 'one',
      name: 'One',
      description: 'One',
      agentId: 'user:agents/reviewer',
      skillIds: [],
      toolIds: [],
      mcpIds: [],
      maxTurns: 1,
    };
    expect(ScenarioDefinitionSchema.safeParse({
      ...common,
      workflow: [{ ...step, dependsOn: ['missing'] }],
    }).success).toBe(false);
    expect(ScenarioDefinitionSchema.safeParse({
      ...common,
      workflow: [{ ...step, dependsOn: ['one'] }],
    }).success).toBe(false);
    expect(ScenarioDefinitionSchema.safeParse({
      ...common,
      workflow: [
        { ...step, id: 'left', dependsOn: [] },
        { ...step, id: 'right', dependsOn: [] },
      ],
    }).success).toBe(false);
    expect(ScenarioDefinitionSchema.safeParse({
      ...common,
      workflow: [
        { ...step, id: 'left', dependsOn: [] },
        { ...step, id: 'right', dependsOn: [] },
        { ...step, id: 'final', dependsOn: ['left', 'right'] },
      ],
    }).success).toBe(true);
  });

  it('requires strict save envelopes and provides safe response recovery', () => {
    const definition = SkillDefinitionV2Schema.parse({
      ...base('user:skills/envelope', 'skill'),
      sourceMode: 'markdown',
      markdown: '# Envelope',
      systemPrompt: 'Envelope',
      toolIds: [],
      mcpIds: [],
      maxTurns: 1,
      inputSchema: null,
      outputSchema: null,
      packageEntry: null,
    });
    expect(PersonalizationSaveRequestSchema.safeParse({
      contractVersion: 1,
      definition,
      expectedRevision: 0,
    }).success).toBe(true);
    expect(PersonalizationSaveRequestSchema.safeParse({
      contractVersion: 1,
      definition,
      expectedRevision: 0,
      extra: true,
    }).success).toBe(false);
    expect(decodePersonalizationListResponse({ ok: true, definitions: 'bad' }))
      .toEqual({ ok: false, code: 'invalid_response' });
    expect(decodePersonalizationListResponse({
      contractVersion: 2,
      ok: true,
      definitions: [],
    })).toEqual({ ok: false, code: 'invalid_response' });
    expect(decodePersonalizationMutationResult({ ok: true, code: 'invented' })).toEqual({ ok: false, code: 'invalid_request' });
  });

  it('uses strict seven-day trash envelopes and rejects malformed archived responses', () => {
    expect(PersonalizationTrashListRequestSchema.safeParse({ contractVersion: 1, kind: 'scenario' }).success).toBe(true);
    expect(PersonalizationTrashListRequestSchema.safeParse({ contractVersion: 1, kind: 'scenario', includeDisabled: true }).success).toBe(false);
    expect(PersonalizationTrashRestoreRequestSchema.safeParse({
      contractVersion: 1,
      id: 'user:scenarios/recoverable',
      expectedRevision: 1,
    }).success).toBe(true);
    expect(decodePersonalizationTrashListResponse({ ok: true, definitions: [{ archivedAt: NOW }] }))
      .toEqual({ ok: false, code: 'invalid_response' });
  });
});
