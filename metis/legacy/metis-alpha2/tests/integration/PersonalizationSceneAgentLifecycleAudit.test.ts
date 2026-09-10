import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { PersonalizationRuntimeService } from '../../electron/PersonalizationRuntimeService.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import { PersonalizationResolver } from '../../engine/personalization/PersonalizationResolver.js';
import {
  PersonalizationDefinitionSchema,
  ScenarioDefinitionSchema,
  type AgentDefinition,
  type McpDefinition,
  type MetisRulesDefinition,
  type PersonalizationDefinition,
  type ScenarioDefinition,
  type SkillDefinitionV2,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';

const NOW = 1_700_000_000_000;
const MANIFEST_SECRET = Buffer.alloc(32, 0x4d);
const PRESENTATION_ID = 'builtin:scenarios/presentation-reserved';
const VENUES = ['sci', 'ssci', 'pku-core', 'cssci', 'cscd'] as const;
const ARTICLE_TYPES = [
  ['review'],
  ['theory', 'theoretical'],
  ['qualitative'],
  ['quantitative'],
] as const;
const STANDALONE_IDS = [
  'builtin:scenarios/thesis-cn-masters',
  'builtin:scenarios/thesis-international-masters',
  'builtin:scenarios/thesis-cn-doctoral',
  'builtin:scenarios/thesis-international-doctoral',
  'builtin:scenarios/fund-nssfc',
  'builtin:scenarios/fund-moe-humanities',
  'builtin:scenarios/fund-uploaded-template',
  'builtin:scenarios/academic-monograph',
] as const;

const MEMORY = {
  scope: 'scenario' as const,
  retainDecisions: true,
  retainArtifacts: true,
  maxSummaryChars: 20_000,
};
const OUTPUT = {
  format: 'artifact_bundle' as const,
  schema: null,
  requireEvidenceEnvelope: true,
  includeIntegrityReport: true,
};
const FULL_ACCESS = {
  mode: 'full_access' as const,
  perActionConfirmation: false,
  liveSteering: true,
  silentCheckpoints: true,
  rollbackOnFailure: false,
  persistAcrossRestart: true,
};

interface Harness {
  db: Database.Database;
  repository: PersonalizationRepository;
  runtime: PersonalizationRuntimeService;
}

interface CustomGraph {
  marker: string;
  mcp: McpDefinition;
  skill: SkillDefinitionV2;
  agent: AgentDefinition;
  rule: MetisRulesDefinition;
  scenario: ScenarioDefinition;
}

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function harness(): Harness {
  const db = new Database(':memory:');
  databases.push(db);
  const repository = new PersonalizationRepository(db, MANIFEST_SECRET);
  repository.seedBuiltins(buildBuiltinPersonalizationDefinitions());
  return {
    db,
    repository,
    runtime: new PersonalizationRuntimeService(repository, MANIFEST_SECRET),
  };
}

function provenance(updatedAt = NOW) {
  return {
    origin: 'user' as const,
    author: 'Scene/Agent lifecycle audit',
    version: '1.0.0',
    license: null,
    sourceUrl: null,
    sourceRevision: null,
    installedDigest: null,
    parentId: null,
    parentVersion: null,
    locallyModified: true,
    createdAt: NOW,
    updatedAt,
  };
}

function header(id: string, kind: PersonalizationDefinition['kind'], revision = 1) {
  return {
    contractVersion: 1 as const,
    id,
    kind,
    name: id,
    description: `Lifecycle definition ${id}`,
    enabled: true,
    tags: [id.split('/').at(-1) ?? kind],
    revision,
    provenance: provenance(NOW + revision - 1),
  };
}

function graph(suffix: string, marker = `GRAPH_${suffix.toUpperCase()}_ONLY`): CustomGraph {
  const scenarioId = `user:scenarios/lifecycle-${suffix}`;
  const mcp: McpDefinition = {
    ...header(`user:mcp/lifecycle-${suffix}`, 'mcp'),
    kind: 'mcp',
    sourceMode: 'generated',
    transport: 'stdio',
    command: 'node',
    args: [`server-${suffix}.js`],
    environment: {},
    sourceUrl: null,
    exposedTools: [`mcp_tool_${suffix}`],
    workingDirectoryToken: null,
  };
  const skill: SkillDefinitionV2 = {
    ...header(`user:skills/lifecycle-${suffix}`, 'skill'),
    kind: 'skill',
    sourceMode: 'markdown',
    markdown: `# ${marker}`,
    systemPrompt: `SKILL_${marker}`,
    toolIds: [`skill_tool_${suffix}`],
    mcpIds: [mcp.id],
    maxTurns: 8,
    inputSchema: null,
    outputSchema: null,
    packageEntry: null,
  };
  const agent: AgentDefinition = {
    ...header(`user:agents/lifecycle-${suffix}`, 'agent'),
    kind: 'agent',
    role: `Agent ${marker}`,
    systemPrompt: `AGENT_${marker}`,
    modelPreference: null,
    skillIds: [skill.id],
    toolIds: [`agent_tool_${suffix}`],
    mcpIds: [mcp.id],
    memory: MEMORY,
    output: OUTPUT,
    maxTurns: 8,
    retryLimit: 1,
  };
  const rule: MetisRulesDefinition = {
    ...header(`user:rules/lifecycle-${suffix}`, 'rules'),
    kind: 'rules',
    scope: 'scenario',
    scopeId: scenarioId,
    markdown: `# Metis.md\n\nRULE_${marker}`,
  };
  const scenario: ScenarioDefinition = {
    ...header(scenarioId, 'scenario'),
    kind: 'scenario',
    agentIds: [agent.id],
    skillIds: [skill.id],
    mcpIds: [mcp.id],
    rulesIds: [rule.id],
    workflow: [{
      id: `step-${suffix}`,
      name: `Step ${marker}`,
      description: `Execute ${marker}`,
      agentId: agent.id,
      skillIds: [skill.id],
      toolIds: [`workflow_tool_${suffix}`],
      mcpIds: [mcp.id],
      dependsOn: [],
      maxTurns: 8,
    }],
    fullAccess: FULL_ACCESS,
    memory: MEMORY,
    output: OUTPUT,
    triggerPhrases: [`run ${suffix}`],
    capability: 'custom',
  };
  return { marker, mcp, skill, agent, rule, scenario };
}

function saveGraph(target: Harness, value: CustomGraph): void {
  for (const definition of [value.mcp, value.skill, value.agent, value.rule, value.scenario]) {
    const result = target.repository.save({
      contractVersion: 1,
      definition,
      expectedRevision: 0,
    });
    if (!result.ok) throw new Error(`Failed to save ${definition.id}: ${result.code}`);
  }
}

function factoryScenarios(): { functional: ScenarioDefinition[]; presentation: ScenarioDefinition } {
  const scenarios = buildBuiltinPersonalizationDefinitions()
    .filter((definition): definition is ScenarioDefinition => definition.kind === 'scenario');
  const combined = VENUES.flatMap((venue) => ARTICLE_TYPES.map((typeTags) => {
    const match = scenarios.find((scenario) => scenario.enabled
      && scenario.tags.includes('journal')
      && scenario.tags.includes(venue)
      && typeTags.some((tag) => scenario.tags.includes(tag)));
    if (!match) throw new Error(`Missing functional factory preset: ${venue}/${typeTags[0]}`);
    return match;
  }));
  const standalone = STANDALONE_IDS.map((id) => {
    const match = scenarios.find((scenario) => scenario.id === id && scenario.enabled);
    if (!match) throw new Error(`Missing functional factory preset: ${id}`);
    return match;
  });
  const presentation = scenarios.find((scenario) => scenario.id === PRESENTATION_ID);
  if (!presentation) throw new Error('Missing Presentation reservation');
  return { functional: [...combined, ...standalone], presentation };
}

function rawReader(definitions: readonly PersonalizationDefinition[]) {
  const values = new Map(definitions.map((definition) => [definition.id, definition]));
  return {
    get: (id: string) => values.get(id),
    list: (kind?: PersonalizationDefinition['kind'], includeDisabled = false) => definitions.filter((definition) => (
      (!kind || definition.kind === kind) && (includeDisabled || definition.enabled)
    )),
  };
}

describe('factory preset protection and update compatibility', () => {
  it('protects all 29 required factory cards and forks every functional preset into a resolvable user copy', () => {
    const target = harness();
    const { functional, presentation } = factoryScenarios();
    expect(functional).toHaveLength(28);
    expect(new Set(functional.map((scenario) => scenario.id)).size).toBe(28);
    const requiredFactories = [...functional, presentation];
    expect(requiredFactories).toHaveLength(29);

    const pristine = new Map(requiredFactories.map((scenario) => [
      scenario.id,
      structuredClone(target.repository.getFactory(scenario.id)),
    ]));
    for (const [index, factory] of requiredFactories.entries()) {
      expect(target.repository.save({
        contractVersion: 1,
        definition: factory,
        expectedRevision: factory.revision,
      })).toEqual({ ok: false, code: 'factory_protected' });
      expect(target.repository.archive(factory.id, factory.revision))
        .toEqual({ ok: false, code: 'factory_protected' });
      expect(target.repository.getFactory(factory.id)).toEqual(pristine.get(factory.id));

      if (!factory.enabled) continue;
      const copyId = `user:scenarios/factory-lifecycle-${index}`;
      const forked = target.runtime.fork({
        contractVersion: 1,
        sourceId: factory.id,
        targetId: copyId,
        author: 'Lifecycle audit',
      });
      expect(forked.ok, `failed to fork ${factory.id}`).toBe(true);
      const copy = target.repository.get(copyId);
      expect(copy).toMatchObject({
        id: copyId,
        kind: 'scenario',
        revision: 1,
        provenance: { origin: 'user', parentId: factory.id, locallyModified: true },
      });
      const resolved = target.runtime.resolveForAgent({
        contractVersion: 1,
        sessionId: `factory-session-${index}`,
        projectId: `factory-project-${index}`,
        scenarioId: copyId,
      });
      expect(resolved?.ok, `fork did not resolve: ${factory.id}`).toBe(true);
      expect(target.repository.getFactory(factory.id)).toEqual(pristine.get(factory.id));
    }

    const reservedCopy = target.runtime.fork({
      contractVersion: 1,
      sourceId: presentation.id,
      targetId: 'user:scenarios/presentation-reserved-lifecycle',
      author: 'Lifecycle audit',
    });
    expect(reservedCopy.ok).toBe(true);
    if (!reservedCopy.ok || reservedCopy.definition.kind !== 'scenario') return;
    expect(reservedCopy.definition).toMatchObject({
      enabled: false,
      capability: 'presentation_reserved',
      agentIds: [],
      skillIds: [],
      mcpIds: [],
      workflow: [],
    });
    expect(target.runtime.save({
      contractVersion: 1,
      expectedRevision: 1,
      definition: { ...reservedCopy.definition, enabled: true, revision: 2 },
    })).toEqual({ ok: false, code: 'invalid_request' });
    expect(target.runtime.resolveForAgent({
      contractVersion: 1,
      sessionId: 'presentation-must-not-run',
      projectId: 'presentation-project',
      scenarioId: reservedCopy.definition.id,
    })).toBeUndefined();
  });

  it('keeps an edited user fork and its history intact after a factory update', () => {
    const target = harness();
    const sourceId = 'builtin:scenarios/academic-monograph';
    const copyId = 'user:scenarios/update-safe-monograph';
    const forked = target.runtime.fork({
      contractVersion: 1,
      sourceId,
      targetId: copyId,
      author: 'Lifecycle audit',
    });
    expect(forked.ok).toBe(true);
    if (!forked.ok || forked.definition.kind !== 'scenario') return;
    const edited = PersonalizationDefinitionSchema.parse({
      ...forked.definition,
      name: 'User monograph survives official update',
      description: 'USER_COPY_SENTINEL',
      revision: 2,
      provenance: {
        ...forked.definition.provenance,
        updatedAt: forked.definition.provenance.updatedAt + 1,
      },
    });
    expect(target.runtime.save({
      contractVersion: 1,
      definition: edited,
      expectedRevision: 1,
    }).ok).toBe(true);
    const userBeforeUpdate = structuredClone(target.repository.get(copyId));

    const updatedBuiltins = buildBuiltinPersonalizationDefinitions().map((definition) => (
      definition.id === sourceId
        ? {
            ...definition,
            name: `${definition.name} Official update`,
            description: `${definition.description} OFFICIAL_UPDATE_SENTINEL`,
            provenance: {
              ...definition.provenance,
              updatedAt: Math.max(
                definition.provenance.createdAt,
                definition.provenance.updatedAt,
              ) + 1,
            },
          }
        : definition
    ));
    target.repository.seedBuiltins(updatedBuiltins);

    expect(target.repository.getFactory(sourceId)).toMatchObject({
      revision: 2,
      name: expect.stringContaining('Official update'),
      description: expect.stringContaining('OFFICIAL_UPDATE_SENTINEL'),
    });
    expect(target.repository.get(copyId)).toEqual(userBeforeUpdate);
    expect(target.repository.listVersions(copyId).map((version) => version.revision)).toEqual([2, 1]);
    const resolved = target.runtime.resolveForAgent({
      contractVersion: 1,
      sessionId: 'user-copy-after-official-update',
      projectId: 'update-project',
      scenarioId: copyId,
    });
    expect(resolved?.ok).toBe(true);
    expect(resolved?.manifest.scenarioRevision).toBe(2);
  });
});

describe('custom scene and agent lifecycle', () => {
  it('creates, edits, versions, restores, resolves, and archives a complete selected graph', () => {
    const target = harness();
    const selected = graph('selected');
    const decoy = graph('decoy');
    saveGraph(target, selected);
    saveGraph(target, decoy);

    const revisedAgent: AgentDefinition = {
      ...selected.agent,
      revision: 2,
      systemPrompt: `${selected.agent.systemPrompt}\nAGENT_REVISION_2`,
      provenance: { ...selected.agent.provenance, updatedAt: NOW + 30 },
    };
    expect(target.runtime.save({
      contractVersion: 1,
      definition: revisedAgent,
      expectedRevision: 1,
    }).ok).toBe(true);
    const revisedScenario: ScenarioDefinition = {
      ...selected.scenario,
      revision: 2,
      name: 'Selected custom scene revision 2',
      provenance: { ...selected.scenario.provenance, updatedAt: NOW + 31 },
    };
    expect(target.runtime.save({
      contractVersion: 1,
      definition: revisedScenario,
      expectedRevision: 1,
    }).ok).toBe(true);

    const resolved = target.runtime.resolveForAgent({
      contractVersion: 1,
      sessionId: 'selected-session-r2',
      projectId: 'selected-project',
      scenarioId: selected.scenario.id,
    });
    expect(resolved?.ok).toBe(true);
    if (!resolved?.ok) return;
    expect(resolved.manifest.agentIds).toEqual([selected.agent.id]);
    expect(resolved.manifest.skillIds).toEqual([selected.skill.id]);
    expect(resolved.manifest.mcpIds).toEqual([selected.mcp.id]);
    expect(resolved.manifest.definitionRevisions).toMatchObject({
      [selected.scenario.id]: 2,
      [selected.agent.id]: 2,
      [selected.skill.id]: 1,
      [selected.mcp.id]: 1,
      [selected.rule.id]: 1,
    });
    expect(resolved.manifest.definitionRevisions[decoy.agent.id]).toBeUndefined();
    expect(resolved.manifest.definitionRevisions[decoy.skill.id]).toBeUndefined();
    expect(resolved.manifest.definitionRevisions[decoy.mcp.id]).toBeUndefined();
    expect(resolved.manifest.definitionRevisions[decoy.rule.id]).toBeUndefined();
    expect(resolved.systemPrompt).toContain('AGENT_REVISION_2');
    expect(resolved.systemPrompt).toContain(`RULE_${selected.marker}`);
    expect(resolved.systemPrompt).not.toContain(decoy.marker);

    expect(target.runtime.restore({
      contractVersion: 1,
      id: selected.agent.id,
      sourceRevision: 1,
      expectedRevision: 2,
    }).ok).toBe(true);
    expect(target.runtime.restore({
      contractVersion: 1,
      id: selected.scenario.id,
      sourceRevision: 1,
      expectedRevision: 2,
    }).ok).toBe(true);
    expect(target.runtime.versions({ contractVersion: 1, id: selected.agent.id })
      .versions.map((version) => version.revision)).toEqual([3, 2, 1]);
    expect(target.runtime.versions({ contractVersion: 1, id: selected.scenario.id })
      .versions.map((version) => version.revision)).toEqual([3, 2, 1]);

    const restored = target.runtime.resolveForAgent({
      contractVersion: 1,
      sessionId: 'selected-session-restored',
      projectId: 'selected-project',
      scenarioId: selected.scenario.id,
    });
    expect(restored?.ok).toBe(true);
    expect(restored?.manifest.definitionRevisions[selected.agent.id]).toBe(3);
    expect(restored?.manifest.definitionRevisions[selected.scenario.id]).toBe(3);
    expect(restored?.systemPrompt).not.toContain('AGENT_REVISION_2');

    expect(target.runtime.archive({
      contractVersion: 1,
      id: selected.scenario.id,
      expectedRevision: 3,
    })).toEqual({ ok: true, code: 'deleted', id: selected.scenario.id });
    expect(target.runtime.archive({
      contractVersion: 1,
      id: selected.agent.id,
      expectedRevision: 3,
    })).toEqual({ ok: true, code: 'deleted', id: selected.agent.id });
    expect(target.repository.get(selected.scenario.id)).toBeUndefined();
    expect(target.repository.get(selected.agent.id)).toBeUndefined();
    expect(target.repository.get(selected.scenario.id, true)?.revision).toBe(3);
    expect(target.repository.get(selected.agent.id, true)?.revision).toBe(3);
    expect(target.runtime.resolveForAgent({
      contractVersion: 1,
      sessionId: 'archived-scenario-must-not-run',
      projectId: 'selected-project',
      scenarioId: selected.scenario.id,
    })).toBeUndefined();
  });

  it('keeps different sessions, projects, selected graphs, and definition revisions isolated', async () => {
    const target = harness();
    const first = graph('alpha');
    const second = graph('beta');
    saveGraph(target, first);
    saveGraph(target, second);
    const firstAgentRevision2: AgentDefinition = {
      ...first.agent,
      revision: 2,
      systemPrompt: `${first.agent.systemPrompt}\nALPHA_REVISION_2`,
      provenance: { ...first.agent.provenance, updatedAt: NOW + 40 },
    };
    expect(target.repository.save({
      contractVersion: 1,
      definition: firstAgentRevision2,
      expectedRevision: 1,
    }).ok).toBe(true);
    const secondSkillRevision2: SkillDefinitionV2 = {
      ...second.skill,
      revision: 2,
      systemPrompt: `${second.skill.systemPrompt}\nBETA_REVISION_2`,
      provenance: { ...second.skill.provenance, updatedAt: NOW + 41 },
    };
    expect(target.repository.save({
      contractVersion: 1,
      definition: secondSkillRevision2,
      expectedRevision: 1,
    }).ok).toBe(true);

    const [alpha, beta] = await Promise.all([
      Promise.resolve().then(() => target.runtime.resolveForAgent({
        contractVersion: 1,
        sessionId: 'concurrent-alpha',
        projectId: 'project-alpha',
        scenarioId: first.scenario.id,
      })),
      Promise.resolve().then(() => target.runtime.resolveForAgent({
        contractVersion: 1,
        sessionId: 'concurrent-beta',
        projectId: 'project-beta',
        scenarioId: second.scenario.id,
      })),
    ]);
    expect(alpha?.ok).toBe(true);
    expect(beta?.ok).toBe(true);
    if (!alpha?.ok || !beta?.ok) return;
    expect(alpha.manifest).toMatchObject({
      sessionId: 'concurrent-alpha',
      projectId: 'project-alpha',
      agentIds: [first.agent.id],
      skillIds: [first.skill.id],
      mcpIds: [first.mcp.id],
    });
    expect(beta.manifest).toMatchObject({
      sessionId: 'concurrent-beta',
      projectId: 'project-beta',
      agentIds: [second.agent.id],
      skillIds: [second.skill.id],
      mcpIds: [second.mcp.id],
    });
    expect(alpha.manifest.definitionRevisions[first.agent.id]).toBe(2);
    expect(alpha.manifest.definitionRevisions[second.skill.id]).toBeUndefined();
    expect(beta.manifest.definitionRevisions[second.skill.id]).toBe(2);
    expect(beta.manifest.definitionRevisions[first.agent.id]).toBeUndefined();
    expect(alpha.systemPrompt).toContain('ALPHA_REVISION_2');
    expect(alpha.systemPrompt).not.toContain(second.marker);
    expect(beta.systemPrompt).toContain('BETA_REVISION_2');
    expect(beta.systemPrompt).not.toContain(first.marker);
    expect(alpha.manifest.manifestDigest).not.toBe(beta.manifest.manifestDigest);
  });
});

describe('scene dependency selection attacks', () => {
  it('rejects workflow Agent, Skill, and MCP bindings that are absent from the scene selection', () => {
    const selected = graph('declared');
    const smuggled = graph('smuggled');
    const attacked: ScenarioDefinition = {
      ...selected.scenario,
      id: 'user:scenarios/unselected-workflow-smuggling',
      rulesIds: [],
      workflow: [{
        ...selected.scenario.workflow[0]!,
        agentId: smuggled.agent.id,
        skillIds: [smuggled.skill.id],
        mcpIds: [smuggled.mcp.id],
      }],
    };
    expect(ScenarioDefinitionSchema.safeParse(attacked).success).toBe(false);

    const target = harness();
    for (const definition of [
      selected.mcp, selected.skill, selected.agent,
      smuggled.mcp, smuggled.skill, smuggled.agent,
    ]) {
      expect(target.repository.save({
        contractVersion: 1,
        definition,
        expectedRevision: 0,
      }).ok).toBe(true);
    }
    // save now returns a diagnostics `issues` array alongside the rejection
    // (schema validation reports exactly which binding was smuggled).
    const smuggleRejection = target.repository.save({
      contractVersion: 1,
      definition: attacked,
      expectedRevision: 0,
    });
    expect(smuggleRejection).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(smuggleRejection.issues?.join('\n')).toContain('must be declared by scenario');

    const corruptReaderDefinitions: PersonalizationDefinition[] = [
      selected.mcp, selected.skill, selected.agent,
      smuggled.mcp, smuggled.skill, smuggled.agent,
      attacked,
    ];
    const resolved = new PersonalizationResolver(rawReader(corruptReaderDefinitions)).resolve({
      sessionId: 'unselected-workflow-attack',
      projectId: 'unselected-project',
      scenarioId: attacked.id,
      createdAt: NOW,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.code).toBe('dependency_invalid');
      expect(resolved.issues.join('\n')).toContain('not declared by scenario');
    }
  });

  it('fails closed when a selected dependency is archived or has the wrong kind', () => {
    const target = harness();
    const selected = graph('dependency-failure');
    saveGraph(target, selected);
    expect(target.repository.archive(selected.skill.id, 1))
      .toEqual({ ok: true, code: 'deleted', id: selected.skill.id });
    expect(target.runtime.resolveForAgent({
      contractVersion: 1,
      sessionId: 'archived-dependency',
      projectId: 'dependency-project',
      scenarioId: selected.scenario.id,
    })).toBeUndefined();

    const wrongKindScenario: ScenarioDefinition = {
      ...selected.scenario,
      id: 'user:scenarios/wrong-kind-dependency',
      agentIds: [selected.mcp.id],
      skillIds: [],
      mcpIds: [selected.mcp.id],
      rulesIds: [],
      workflow: [],
    };
    // 2026-08-29 policy (healScenarioReferenceKinds): wrong-kind reference
    // labels are healed against the library's real types instead of failing
    // the run -- an MCP id mis-declared under agentIds is migrated into the
    // mcp arrays, so resolution now succeeds with the binding intact.
    const healed = new PersonalizationResolver(rawReader([
      selected.mcp,
      wrongKindScenario,
    ])).resolve({
      sessionId: 'wrong-kind-dependency',
      projectId: 'dependency-project',
      scenarioId: wrongKindScenario.id,
      createdAt: NOW,
    });
    expect(healed.ok).toBe(true);
    if (healed.ok) {
      expect(healed.manifest.mcpIds).toContain(selected.mcp.id);
      expect(healed.manifest.agentIds).not.toContain(selected.mcp.id);
    }
  });
});
