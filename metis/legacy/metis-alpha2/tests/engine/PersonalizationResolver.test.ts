import { describe, expect, it } from 'vitest';
import {
  PersonalizationResolver,
  composeManifestSystemPrompt,
} from '../../engine/personalization/PersonalizationResolver.js';
import type {
  AgentDefinition,
  McpDefinition,
  MetisRulesDefinition,
  PersonalizationDefinition,
  ScenarioDefinition,
  SkillDefinitionV2,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';

const NOW = 1_785_394_400_000;

function header(id: string, kind: PersonalizationDefinition['kind']) {
  return {
    contractVersion: 1 as const,
    id,
    kind,
    name: id,
    description: id,
    enabled: true,
    tags: [],
    revision: 1,
    provenance: {
      origin: 'user' as const,
      author: 'Researcher',
      version: '1.0.0',
      license: null,
      sourceUrl: null,
      sourceRevision: null,
      installedDigest: null,
      parentId: null,
      parentVersion: null,
      locallyModified: true,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

const globalRules: MetisRulesDefinition = {
  ...header('user:rules/global', 'rules'),
  kind: 'rules',
  scope: 'global',
  scopeId: null,
  markdown: '# Global\n\nUse traceable evidence.',
};

const projectRules: MetisRulesDefinition = {
  ...header('user:rules/project-one', 'rules'),
  kind: 'rules',
  scope: 'project',
  scopeId: 'user:projects/project-one',
  markdown: '# Project\n\nUse the project terminology.',
};

const mcp: McpDefinition = {
  ...header('user:mcp/search', 'mcp'),
  kind: 'mcp',
  sourceMode: 'generated',
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  environment: {},
  sourceUrl: null,
  exposedTools: ['external_search'],
  workingDirectoryToken: null,
};

const skill: SkillDefinitionV2 = {
  ...header('user:skills/review', 'skill'),
  kind: 'skill',
  sourceMode: 'markdown',
  markdown: '# Review',
  systemPrompt: 'Review evidence.',
  toolIds: ['read_pdf'],
  mcpIds: [mcp.id],
  maxTurns: 10,
  inputSchema: null,
  outputSchema: null,
  packageEntry: null,
};

const agent: AgentDefinition = {
  ...header('user:agents/reviewer', 'agent'),
  kind: 'agent',
  role: 'Reviewer',
  systemPrompt: 'Act as a reviewer.',
  modelPreference: null,
  skillIds: [skill.id],
  toolIds: ['verify_claim'],
  mcpIds: [],
  memory: { scope: 'scenario', retainDecisions: true, retainArtifacts: true, maxSummaryChars: 20_000 },
  output: { format: 'markdown', schema: null, requireEvidenceEnvelope: true, includeIntegrityReport: true },
  maxTurns: 10,
  retryLimit: 2,
};

const scenario: ScenarioDefinition = {
  ...header('user:scenarios/research', 'scenario'),
  kind: 'scenario',
  agentIds: [agent.id],
  skillIds: [skill.id],
  mcpIds: [mcp.id],
  rulesIds: [globalRules.id],
  workflow: [{
    id: 'review',
    name: 'Review',
    description: 'Review evidence.',
    agentId: agent.id,
    skillIds: [],
    toolIds: ['format_citation'],
    mcpIds: [],
    dependsOn: [],
    maxTurns: 20,
  }],
  fullAccess: {
    mode: 'full_access',
    perActionConfirmation: false,
    liveSteering: true,
    silentCheckpoints: true,
    rollbackOnFailure: false,
    persistAcrossRestart: true,
  },
  memory: { scope: 'scenario', retainDecisions: true, retainArtifacts: true, maxSummaryChars: 20_000 },
  output: { format: 'markdown', schema: null, requireEvidenceEnvelope: true, includeIntegrityReport: true },
  triggerPhrases: ['review evidence'],
  capability: 'research',
};

class Reader {
  readonly definitions = new Map<string, PersonalizationDefinition>([
    [globalRules.id, globalRules],
    [projectRules.id, projectRules],
    [mcp.id, mcp],
    [skill.id, skill],
    [agent.id, agent],
    [scenario.id, scenario],
  ]);

  get(id: string): PersonalizationDefinition | undefined {
    return this.definitions.get(id);
  }

  list(kind?: PersonalizationDefinition['kind'], includeDisabled = false): PersonalizationDefinition[] {
    return [...this.definitions.values()].filter((definition) => (
      (!kind || definition.kind === kind) && (includeDisabled || definition.enabled)
    ));
  }
}

describe('PersonalizationResolver', () => {
  it('resolves an immutable run manifest with all transitive capabilities', () => {
    const result = new PersonalizationResolver(new Reader()).resolve({
      sessionId: 'session-one',
      projectId: 'project-one',
      scenarioId: scenario.id,
      projectRulesId: projectRules.id,
      createdAt: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.allowedTools).toEqual([
      'external_search',
      'format_citation',
      'read_pdf',
      'verify_claim',
    ]);
    expect(result.manifest.workflow[0]).toMatchObject({
      agentId: agent.id,
      agentModelPreference: null,
      retryLimit: 2,
      skillIds: [skill.id],
      mcpIds: [mcp.id],
      toolIds: ['external_search', 'format_citation', 'read_pdf', 'verify_claim'],
      maxTurns: 10,
      memory: agent.memory,
      output: agent.output,
    });
    expect(result.manifest.truthPolicy).toBe('automatic_required');
    expect(result.manifest.fullAccess.perActionConfirmation).toBe(false);
    expect(result.manifest.manifestDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.systemPrompt).toContain('Review evidence.');
    expect(result.systemPrompt).toContain('# Review');
    expect(result.systemPrompt).toContain('Use traceable evidence.');
    expect(result.systemPrompt).toContain('Use the project terminology.');
  });

  it('freezes the exact single-Agent runtime policy for an output plan without an authored workflow', () => {
    const reader = new Reader();
    const exactMemory = {
      scope: 'session' as const,
      retainDecisions: false,
      retainArtifacts: true,
      maxSummaryChars: 12_000,
    };
    reader.definitions.set(skill.id, { ...skill, maxTurns: 4 });
    reader.definitions.set(agent.id, {
      ...agent,
      modelPreference: 'specialized-output-model',
      maxTurns: 9,
      retryLimit: 3,
      memory: exactMemory,
    });
    reader.definitions.set(scenario.id, {
      ...scenario,
      workflow: [],
      output: {
        ...scenario.output,
        plan: {
          primaryDeliverable: 'Complete manuscript',
          supportingArtifacts: ['Evidence table'],
          qualityCriteria: ['Claims remain traceable'],
        },
      },
    });

    const result = new PersonalizationResolver(reader).resolve({
      sessionId: 'session-policy',
      projectId: 'project-one',
      scenarioId: scenario.id,
      createdAt: NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.workflow).toEqual([]);
    const frozen = (result.manifest as unknown as {
      implicitOutputStep?: Record<string, unknown>;
    }).implicitOutputStep;
    expect(frozen).toMatchObject({
      id: 'runtime-output-plan',
      agentId: agent.id,
      agentModelPreference: 'specialized-output-model',
      retryLimit: 3,
      skillIds: [skill.id],
      mcpIds: [mcp.id],
      toolIds: ['external_search', 'read_pdf', 'verify_claim'],
      maxTurns: 4,
      memory: exactMemory,
      output: agent.output,
    });
  });

  it('builds an isolated step prompt from only the executing agent and its effective skills', () => {
    const otherSkill: SkillDefinitionV2 = {
      ...skill,
      ...header('user:skills/statistics', 'skill'),
      id: 'user:skills/statistics',
      name: 'Statistics',
      markdown: '# Statistics',
      systemPrompt: 'Run the statistical analysis only.',
      toolIds: ['run_statistics'],
      mcpIds: [],
    };
    const otherAgent: AgentDefinition = {
      ...agent,
      ...header('user:agents/statistician', 'agent'),
      id: 'user:agents/statistician',
      name: 'Statistician',
      role: 'Statistician',
      systemPrompt: 'Act only as the statistician.',
      skillIds: [otherSkill.id],
      toolIds: [],
    };
    const reader = new Reader();
    reader.definitions.set(otherSkill.id, otherSkill);
    reader.definitions.set(otherAgent.id, otherAgent);
    reader.definitions.set(scenario.id, {
      ...scenario,
      agentIds: [agent.id, otherAgent.id],
      skillIds: [skill.id, otherSkill.id],
      workflow: [
        { ...scenario.workflow[0]!, skillIds: [], mcpIds: [] },
        {
          id: 'statistics',
          name: 'Statistics',
          description: 'Analyse the data.',
          agentId: otherAgent.id,
          skillIds: [],
          toolIds: [],
          mcpIds: [],
          dependsOn: ['review'],
          maxTurns: 10,
        },
      ],
      output: {
        ...scenario.output,
        plan: {
          primaryDeliverable: 'Complete evidence-grounded manuscript',
          supportingArtifacts: ['Evidence table'],
          qualityCriteria: ['Every claim is traceable'],
        },
      },
    });

    const result = new PersonalizationResolver(reader).resolve({
      sessionId: 'session-isolated',
      projectId: 'project-one',
      scenarioId: scenario.id,
      createdAt: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reviewPrompt = composeManifestSystemPrompt(result.manifest, result.manifest.workflow[0]);
    const statisticsPrompt = composeManifestSystemPrompt(result.manifest, result.manifest.workflow[1]);
    expect(reviewPrompt).toContain('Act as a reviewer.');
    expect(reviewPrompt).toContain('Review evidence.');
    expect(reviewPrompt).toContain('# Review');
    expect(reviewPrompt).not.toContain('Act only as the statistician.');
    expect(reviewPrompt).not.toContain('Run the statistical analysis only.');
    expect(statisticsPrompt).toContain('Act only as the statistician.');
    expect(statisticsPrompt).toContain('Run the statistical analysis only.');
    expect(statisticsPrompt).not.toContain('Act as a reviewer.');
    expect(statisticsPrompt).not.toContain('Review evidence.');
    expect(statisticsPrompt).toContain('Primary deliverable: Complete evidence-grounded manuscript.');
    expect(statisticsPrompt).toContain('- Evidence table');
    expect(statisticsPrompt).toContain('- Every claim is traceable');
  });

  it('is deterministic for the same request and changes digest for a material edit', () => {
    const reader = new Reader();
    const resolver = new PersonalizationResolver(reader);
    const request = {
      sessionId: 'session-one',
      projectId: 'project-one',
      scenarioId: scenario.id,
      createdAt: NOW,
    };
    const first = resolver.resolve(request);
    const second = resolver.resolve(request);
    expect(first.ok && second.ok && first.manifest.manifestDigest).toBe(
      second.ok ? second.manifest.manifestDigest : '',
    );
    reader.definitions.set(skill.id, { ...skill, revision: 2, systemPrompt: 'Changed review.' });
    const changed = resolver.resolve(request);
    expect(first.ok && changed.ok && changed.manifest.manifestDigest).not.toBe(
      first.ok ? first.manifest.manifestDigest : '',
    );
  });

  it('fails closed for missing, wrong-kind, or disabled dependencies', () => {
    const missingReader = new Reader();
    missingReader.definitions.delete(skill.id);
    const missing = new PersonalizationResolver(missingReader).resolve({
      sessionId: 'session-one', projectId: 'project-one', scenarioId: scenario.id, createdAt: NOW,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('dependency_invalid');

    const wrongReader = new Reader();
    wrongReader.definitions.set(skill.id, { ...agent, id: skill.id });
    const wrong = new PersonalizationResolver(wrongReader).resolve({
      sessionId: 'session-one', projectId: 'project-one', scenarioId: scenario.id, createdAt: NOW,
    });
    expect(wrong.ok).toBe(false);

    const disabledReader = new Reader();
    disabledReader.definitions.set(agent.id, { ...agent, enabled: false });
    const disabled = new PersonalizationResolver(disabledReader).resolve({
      sessionId: 'session-one', projectId: 'project-one', scenarioId: scenario.id, createdAt: NOW,
    });
    expect(disabled.ok).toBe(false);
  });

  it('does not leak project rules between concurrent scenario resolutions', () => {
    const resolver = new PersonalizationResolver(new Reader());
    const withProject = resolver.resolve({
      sessionId: 'session-a', projectId: 'project-one', scenarioId: scenario.id,
      projectRulesId: projectRules.id, createdAt: NOW,
    });
    const withoutProject = resolver.resolve({
      sessionId: 'session-b', projectId: 'project-two', scenarioId: scenario.id, createdAt: NOW,
    });
    expect(withProject.ok && withProject.systemPrompt).toContain('project terminology');
    expect(withoutProject.ok && withoutProject.systemPrompt).not.toContain('project terminology');
    expect(withProject.ok && withoutProject.ok && withProject.manifest.manifestDigest)
      .not.toBe(withoutProject.ok ? withoutProject.manifest.manifestDigest : '');
  });

  it('rejects a project rule that is bound to another project', () => {
    const reader = new Reader();
    reader.definitions.set(projectRules.id, {
      ...projectRules,
      scopeId: 'user:projects/project-two',
    });
    const result = new PersonalizationResolver(reader).resolve({
      sessionId: 'session-a',
      projectId: 'project-one',
      scenarioId: scenario.id,
      projectRulesId: projectRules.id,
      createdAt: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('dependency_invalid');
      expect(result.issues).toContain(
        `Project rule ${projectRules.id} is not bound to user:projects/project-one`,
      );
    }
  });

  it('rejects a scenario rule that is bound to another scenario', () => {
    const foreignRule: MetisRulesDefinition = {
      ...header('user:rules/foreign-scenario', 'rules'),
      kind: 'rules',
      scope: 'scenario',
      scopeId: 'user:scenarios/foreign',
      markdown: '# Foreign\n\nDo not leak.',
    };
    const reader = new Reader();
    reader.definitions.set(foreignRule.id, foreignRule);
    reader.definitions.set(scenario.id, {
      ...scenario,
      rulesIds: [...scenario.rulesIds, foreignRule.id],
    });
    const result = new PersonalizationResolver(reader).resolve({
      sessionId: 'session-a',
      projectId: 'project-one',
      scenarioId: scenario.id,
      createdAt: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((issue) => issue.includes('is not bound'))).toBe(true);
  });
});
