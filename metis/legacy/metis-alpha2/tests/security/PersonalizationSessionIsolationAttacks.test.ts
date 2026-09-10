import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import type {
  AgentRunRequest,
  ChatMessage,
  NormalizedResponse,
  StreamChunk,
  ToolSpec,
} from '../../engine/core/types.js';
import { ApprovalStore, WRITE_APPROVAL_RULE } from '../../engine/hitl/HITLCore.js';
import {
  ScenarioRunCoordinator,
  digestResolvedManifestSnapshot,
  digestScenarioStepOutput,
} from '../../engine/personalization/ScenarioRunCoordinator.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import { BaseProvider } from '../../engine/providers/BaseProvider.js';
import {
  AgentControlRequestSchema,
  InMemoryLiveSteeringQueue,
} from '../../engine/runtime/LiveSteeringContract.js';
import {
  PersonalizationDefinitionSchema,
  type AgentDefinition,
  type FullAccessPolicy,
  type McpDefinition,
  type MetisRulesDefinition,
  type PersonalizationDefinition,
  type ScenarioDefinition,
  type SkillDefinitionV2,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { EvidenceEnvelopeService } from '../../electron/EvidenceEnvelopeService.js';
import { PersonalizationRuntimeService } from '../../electron/PersonalizationRuntimeService.js';

const NOW = 1_900_800_000_000;
const MANIFEST_SECRET = Buffer.alloc(32, 31);
const EVIDENCE_SECRET = Buffer.alloc(32, 47);
const FULL_ACCESS: FullAccessPolicy = {
  mode: 'full_access',
  perActionConfirmation: false,
  liveSteering: true,
  silentCheckpoints: true,
  rollbackOnFailure: false,
  persistAcrossRestart: true,
};
const MEMORY = {
  scope: 'session' as const,
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

let db: Database.Database;
let repository: PersonalizationRepository;
let runtime: PersonalizationRuntimeService;

beforeEach(() => {
  db = new Database(':memory:');
  repository = new PersonalizationRepository(db, MANIFEST_SECRET);
  runtime = new PersonalizationRuntimeService(repository, MANIFEST_SECRET);
});

afterEach(() => {
  db.close();
});

function provenance() {
  return {
    origin: 'user' as const,
    author: 'Security test owner',
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
  };
}

function header(id: string, kind: PersonalizationDefinition['kind']) {
  return {
    contractVersion: 1 as const,
    id,
    kind,
    name: id,
    description: `Definition ${id}`,
    enabled: true,
    tags: [id.split('/').at(-1) ?? kind],
    revision: 1,
    provenance: provenance(),
  };
}

interface Graph {
  marker: string;
  rule: MetisRulesDefinition;
  mcp: McpDefinition;
  skill: SkillDefinitionV2;
  agent: AgentDefinition;
  scenario: ScenarioDefinition;
}

function graph(suffix: 'a' | 'b'): Graph {
  const marker = `SESSION_${suffix.toUpperCase()}_ONLY`;
  const scenarioId = `user:scenarios/session-${suffix}`;
  const rule: MetisRulesDefinition = {
    ...header(`user:rules/session-${suffix}`, 'rules'),
    kind: 'rules',
    scope: 'scenario',
    scopeId: scenarioId,
    markdown: `# Metis.md ${marker}\n\nApply only ${marker}.`,
  };
  const mcp: McpDefinition = {
    ...header(`user:mcp/session-${suffix}`, 'mcp'),
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
    ...header(`user:skills/session-${suffix}`, 'skill'),
    kind: 'skill',
    sourceMode: 'markdown',
    markdown: `# Skill ${marker}`,
    systemPrompt: `SKILL_PROMPT_${marker}`,
    toolIds: [`skill_tool_${suffix}`],
    mcpIds: [mcp.id],
    maxTurns: 8,
    inputSchema: null,
    outputSchema: null,
    packageEntry: null,
  };
  const agent: AgentDefinition = {
    ...header(`user:agents/session-${suffix}`, 'agent'),
    kind: 'agent',
    role: `Agent ${marker}`,
    systemPrompt: `AGENT_PROMPT_${marker}`,
    modelPreference: null,
    skillIds: [skill.id],
    toolIds: [`agent_tool_${suffix}`],
    mcpIds: [mcp.id],
    memory: MEMORY,
    output: OUTPUT,
    maxTurns: 8,
    retryLimit: 1,
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
      description: `Execute only ${marker}`,
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
    triggerPhrases: [`run session ${suffix}`],
    capability: 'custom',
  };
  return { marker, rule, mcp, skill, agent, scenario };
}

function saveDefinition(definition: PersonalizationDefinition, expectedRevision = 0): void {
  const result = repository.save({ contractVersion: 1, definition, expectedRevision });
  if (!result.ok) throw new Error(`Definition save failed: ${result.code}`);
}

function saveGraph(value: Graph): void {
  saveDefinition(value.mcp);
  saveDefinition(value.skill);
  saveDefinition(value.agent);
  saveDefinition(value.rule);
  saveDefinition(value.scenario);
}

function resolveSession(sessionId: string, projectId: string, scenarioId: string) {
  const resolved = runtime.resolveForAgent({
    contractVersion: 1,
    sessionId,
    projectId,
    scenarioId,
  });
  if (!resolved?.ok) throw new Error('Runtime failed to resolve the session snapshot');
  return resolved;
}

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function response(
  content: string,
  toolCalls: NormalizedResponse['toolCalls'] = [],
): NormalizedResponse {
  return {
    content,
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    usage: USAGE,
  };
}

class ScriptedProvider extends BaseProvider {
  readonly received: ChatMessage[][] = [];
  callCount = 0;
  #index = 0;

  constructor(private readonly responses: readonly NormalizedResponse[]) {
    super();
  }

  capabilities() {
    return {
      providerType: 'session-isolation-security-test',
      model: 'deterministic-security-provider',
      nativeToolCalling: true,
      jsonSchemaOutput: false,
      streaming: false,
      thinking: false,
      maxContextTokens: 16_000,
      maxOutputTokens: 2_000,
      retryableStatusCodes: [],
    };
  }

  async complete(messages: ChatMessage[]): Promise<NormalizedResponse> {
    this.callCount += 1;
    this.received.push(messages.map((message) => ({ ...message })));
    const result = this.responses[Math.min(this.#index, this.responses.length - 1)];
    this.#index += 1;
    if (!result) throw new Error('Missing deterministic provider response');
    return result;
  }

  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> {}
}

function runRequest(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    messages: [{ role: 'user', content: 'Run the isolated security task.' }],
    maxTurns: 4,
    sessionId: 'agent-session-a',
    taskContractHash: 'a'.repeat(64),
    promptStackHash: 'b'.repeat(64),
    resumeFromCheckpoint: false,
    requestId: 'session-attack-request',
    ...overrides,
  };
}

function agentLoop(
  provider: BaseProvider,
  specs: readonly ToolSpec[] = [],
  handlers: Readonly<Record<string, () => Promise<string>>> = {},
  approvalStore?: ApprovalStore,
) {
  const registry = new ToolRegistry();
  const dispatcher = new ToolDispatcher(registry);
  for (const spec of specs) registry.register(spec);
  for (const [name, handler] of Object.entries(handlers)) {
    dispatcher.registerHandler(name, async () => handler());
  }
  return new AgentLoop({ provider, registry, dispatcher, approvalStore });
}

describe('immutable per-session personalization snapshots', () => {
  it('keeps concurrent session prompt, tools, MCP, and Metis.md layers isolated', async () => {
    const firstGraph = graph('a');
    const secondGraph = graph('b');
    saveGraph(firstGraph);
    saveGraph(secondGraph);

    const [first, second] = await Promise.all([
      Promise.resolve().then(() => resolveSession('session-a', 'project-a', firstGraph.scenario.id)),
      Promise.resolve().then(() => resolveSession('session-b', 'project-b', secondGraph.scenario.id)),
    ]);

    expect(first.manifest.sessionId).toBe('session-a');
    expect(second.manifest.sessionId).toBe('session-b');
    expect(first.manifest.mcpIds).toEqual([firstGraph.mcp.id]);
    expect(second.manifest.mcpIds).toEqual([secondGraph.mcp.id]);
    expect(first.manifest.allowedTools).toEqual([
      'agent_tool_a', 'mcp_tool_a', 'skill_tool_a', 'workflow_tool_a',
    ]);
    expect(second.manifest.allowedTools).toEqual([
      'agent_tool_b', 'mcp_tool_b', 'skill_tool_b', 'workflow_tool_b',
    ]);
    expect(first.systemPrompt).toContain(firstGraph.marker);
    expect(first.systemPrompt).not.toContain(secondGraph.marker);
    expect(second.systemPrompt).toContain(secondGraph.marker);
    expect(second.systemPrompt).not.toContain(firstGraph.marker);
    expect(first.manifest.manifestDigest).not.toBe(second.manifest.manifestDigest);
    expect(repository.getActiveRunManifest('session-a')?.scenarioId).toBe(firstGraph.scenario.id);
    expect(repository.getActiveRunManifest('session-b')?.scenarioId).toBe(secondGraph.scenario.id);
  });

  it('does not let a running session observe a later definition edit, while a new session gets the new revision', () => {
    const value = graph('a');
    saveGraph(value);
    const original = resolveSession('session-a-old', 'project-a', value.scenario.id);
    const revisedSkill: SkillDefinitionV2 = {
      ...value.skill,
      revision: 2,
      systemPrompt: 'SKILL_PROMPT_SESSION_A_VERSION_2',
      toolIds: ['skill_tool_a_v2'],
      provenance: { ...value.skill.provenance, updatedAt: NOW + 1 },
    };
    saveDefinition(revisedSkill, 1);

    const sameSession = resolveSession('session-a-old', 'project-a', value.scenario.id);
    const newSession = resolveSession('session-a-new', 'project-a', value.scenario.id);
    expect(sameSession.manifest.manifestDigest).toBe(original.manifest.manifestDigest);
    expect(sameSession.systemPrompt).toBe(original.systemPrompt);
    expect(sameSession.manifest.definitionRevisions[value.skill.id]).toBe(1);
    expect(sameSession.manifest.allowedTools).toContain('skill_tool_a');
    expect(sameSession.manifest.allowedTools).not.toContain('skill_tool_a_v2');
    expect(newSession.manifest.definitionRevisions[value.skill.id]).toBe(2);
    expect(newSession.systemPrompt).toContain('SKILL_PROMPT_SESSION_A_VERSION_2');
    expect(newSession.manifest.allowedTools).toContain('skill_tool_a_v2');
  });

  it('binds execution to the manifest digest and rejects a modified snapshot before any step executes', async () => {
    const value = graph('a');
    saveGraph(value);
    const resolved = resolveSession('digest-session', 'digest-project', value.scenario.id);
    let executorCalls = 0;
    let seenDigest = '';
    const coordinator = new ScenarioRunCoordinator({
      now: () => NOW,
      executor: async (input) => {
        executorCalls += 1;
        seenDigest = input.manifestDigest;
        const output = { marker: 'bound-output', executionKey: input.executionKey };
        return { ok: true, output, outputDigest: digestScenarioStepOutput(output), artifactRefs: [] };
      },
    });
    expect(digestResolvedManifestSnapshot(resolved.manifest)).toBe(resolved.manifest.manifestDigest);
    const valid = await coordinator.start({ runId: 'manifest-bound-run', manifest: resolved.manifest });
    expect(valid).toMatchObject({ ok: true, record: { status: 'completed', manifestDigest: resolved.manifest.manifestDigest } });
    expect(executorCalls).toBe(1);
    expect(seenDigest).toBe(resolved.manifest.manifestDigest);

    const tampered = structuredClone(resolved.manifest);
    tampered.promptStack[0]!.content = 'FORGED_PROMPT_AFTER_RESOLUTION';
    const rejected = await coordinator.start({ runId: 'manifest-tamper-run', manifest: tampered });
    expect(rejected).toMatchObject({ ok: false, code: 'invalid_manifest' });
    expect(executorCalls).toBe(1);
  });

  it('rejects a tampered persisted manifest HMAC and re-resolves without using injected prompt content', () => {
    const value = graph('a');
    saveGraph(value);
    const original = resolveSession('hmac-session', 'hmac-project', value.scenario.id);
    expect(original.systemPrompt).toContain(value.marker);
    const row = db.prepare(`
      SELECT manifest_json FROM personalization_run_manifests
      WHERE session_id = ? AND active = 1
    `).get('hmac-session') as { manifest_json: string };
    const tampered = JSON.parse(row.manifest_json) as typeof original.manifest;
    tampered.promptStack[0]!.content = 'MALICIOUS_PERSISTED_PROMPT';
    db.prepare(`
      UPDATE personalization_run_manifests
      SET manifest_json = ?, integrity_tag = ?
      WHERE session_id = ? AND active = 1
    `).run(JSON.stringify(tampered), '0'.repeat(64), 'hmac-session');

    const recovered = resolveSession('hmac-session', 'hmac-project', value.scenario.id);
    expect(recovered.systemPrompt).not.toContain('MALICIOUS_PERSISTED_PROMPT');
    expect(recovered.systemPrompt).toContain(value.marker);
    expect(digestResolvedManifestSnapshot(recovered.manifest)).toBe(recovered.manifest.manifestDigest);
    // HMAC reject must never revive the tampered row: re-resolution must byte-match the original manifest (digest included).
    expect(recovered.manifest.manifestDigest).toBe(original.manifest.manifestDigest);
    expect(repository.getActiveRunManifest('hmac-session')?.manifestDigest).toBe(recovered.manifest.manifestDigest);
    expect(repository.getActiveRunManifest('hmac-session')?.promptStack[0]?.content)
      .not.toContain('MALICIOUS_PERSISTED_PROMPT');
  });
});

describe('live steering ownership, ordering, replay, and abort attacks', () => {
  it('keeps sessions isolated, rejects replayed sequence numbers, and drains an interrupt only for its session', () => {
    const queue = new InMemoryLiveSteeringQueue();
    queue.enqueue({
      type: 'instruction', id: 'instruction-a-1', sessionId: 'queue-session-a',
      sequence: 1, createdAt: NOW, content: 'Only session A may see this.',
    });
    queue.enqueue({
      type: 'interrupt', id: 'interrupt-b-1', sessionId: 'queue-session-b',
      sequence: 1, createdAt: NOW + 1, reason: 'Only session B must stop.',
    });
    expect(queue.drain({ sessionId: 'queue-session-a', afterSequence: 0 })).toMatchObject([
      { type: 'instruction', sessionId: 'queue-session-a', sequence: 1 },
    ]);
    expect(queue.drain({ sessionId: 'queue-session-a', afterSequence: 0 })).toEqual([]);
    expect(() => queue.enqueue({
      type: 'instruction', id: 'replay-a-1', sessionId: 'queue-session-a',
      sequence: 1, createdAt: NOW + 2, content: 'Replay attack.',
    })).toThrow(/increase/u);
    expect(queue.drain({ sessionId: 'queue-session-b', afterSequence: 0 })).toMatchObject([
      { type: 'interrupt', sessionId: 'queue-session-b', sequence: 1 },
    ]);
  });

  it('derives cross-window control ownership in main and rejects renderer-supplied owner fields', () => {
    expect(AgentControlRequestSchema.safeParse({
      contractVersion: 1,
      operationId: 'cross-window-control',
      action: 'interrupt',
      sessionId: 'owned-session',
      reason: 'Forged interrupt',
      ownerWebContentsId: 9999,
    }).success).toBe(false);

    const source = readFileSync(resolve(process.cwd(), 'electron/main.ts'), 'utf8');
    const handlerStart = source.indexOf("ipcMain.handle('agent:control'");
    const handlerEnd = source.indexOf('// ── Acceptance', handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);
    const ownerCheck = handler.indexOf('run.ownerWebContentsId !== event.sender.id');
    const enqueue = handler.indexOf('liveSteeringQueue.enqueue');
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handler).toContain('requireRendererMainFrame(event)');
    expect(handler).toContain("code: 'owner_mismatch'");
    expect(ownerCheck).toBeGreaterThanOrEqual(0);
    expect(enqueue).toBeGreaterThan(ownerCheck);
  });

  it('honors queued interrupt and AbortSignal without allowing a stale provider completion', async () => {
    const queue = new InMemoryLiveSteeringQueue();
    queue.enqueue({
      type: 'interrupt', id: 'interrupt-agent-1', sessionId: 'agent-session-a',
      sequence: 1, createdAt: NOW, reason: 'Stop the active run.',
    });
    const interruptedProvider = new ScriptedProvider([response('MUST_NOT_RUN')]);
    const interrupted = await agentLoop(interruptedProvider).run(runRequest({ liveSteering: queue }));
    expect(interrupted).toMatchObject({ status: 'interrupted', finalText: '', finalVerified: false });
    expect(interruptedProvider.callCount).toBe(0);

    const controller = new AbortController();
    controller.abort();
    const abortedProvider = new ScriptedProvider([response('STALE_ABORTED_COMPLETION')]);
    const aborted = await agentLoop(abortedProvider).run(runRequest({
      sessionId: 'agent-session-aborted',
      signal: controller.signal,
    }));
    expect(aborted).toMatchObject({ status: 'interrupted', finalText: '', finalVerified: false });
    expect(abortedProvider.callCount).toBe(0);
  });
});

describe('Full Access and automatic truth hard boundaries', () => {
  it('skips per-action confirmation for an allowed safe tool but still blocks destructive execution', async () => {
    const writeSpec: ToolSpec = {
      name: 'write_file',
      description: 'Write an authorized file',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    };
    let approvalCalls = 0;
    let safeHandlerCalls = 0;
    const approvals = new ApprovalStore();
    approvals.addRule(WRITE_APPROVAL_RULE);
    approvals.setHandler(async () => {
      approvalCalls += 1;
      return false;
    });
    const safeProvider = new ScriptedProvider([
      response('', [{ name: 'write_file', arguments: { path: 'authorized.txt', content: 'safe' }, id: 'safe-write' }]),
      response('Safe write completed.'),
    ]);
    const safe = await agentLoop(safeProvider, [writeSpec], {
      write_file: async () => {
        safeHandlerCalls += 1;
        return 'Successfully wrote authorized file';
      },
    }, approvals).run(runRequest({ fullAccess: FULL_ACCESS, allowedTools: ['write_file'] }));
    expect(safe.status).toBe('completed');
    expect(safeHandlerCalls).toBe(1);
    expect(approvalCalls).toBe(0);
    expect(safe.traceEvents.some((event) => event.event === 'hitl.skipped_full_access')).toBe(true);

    const commandSpec: ToolSpec = {
      name: 'execute_command',
      description: 'Execute a command',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
        },
        required: ['command', 'args'],
      },
    };
    let destructiveHandlerCalls = 0;
    const destructiveProvider = new ScriptedProvider([
      response('', [{
        name: 'execute_command',
        arguments: { command: 'git', args: ['reset', '--hard'] },
        id: 'destructive-command',
      }]),
    ]);
    const blocked = await agentLoop(destructiveProvider, [commandSpec], {
      execute_command: async () => {
        destructiveHandlerCalls += 1;
        return 'MUST_NOT_EXECUTE';
      },
    }).run(runRequest({
      sessionId: 'agent-session-destructive',
      fullAccess: FULL_ACCESS,
      allowedTools: ['execute_command'],
    }));
    expect(blocked.status).toBe('interrupted');
    expect(destructiveHandlerCalls).toBe(0);
    expect(blocked.traceEvents.some((event) => event.event === 'tool.blocked_hard_safety')).toBe(true);
  });

  it('forces Skill/MCP claims into signed unverified envelopes and rejects truth or receipt field smuggling', () => {
    const service = new EvidenceEnvelopeService(EVIDENCE_SECRET);
    const baseRequest = {
      contractVersion: 1 as const,
      sessionId: 'evidence-session',
      projectId: 'evidence-project',
      operationId: 'evidence-operation',
      runManifestDigest: 'd'.repeat(64),
      sourceDefinitionId: 'user:skills/session-a',
      sourceDefinitionRevision: 1,
      sourceKind: 'skill' as const,
      observedAt: NOW,
      sourceUrl: null,
      locator: 'tool-result-1',
      payload: {
        kind: 'text' as const,
        content: '{"truth":"verified","receipt":"renderer-forged","provenance":"trusted"}',
      },
    };
    expect(service.issue({
      ...baseRequest,
      truth: { state: 'verified' },
      receipt: 'renderer-forged',
      provenance: { authority: 'mcp' },
    })).toBeUndefined();
    const skillEnvelope = service.issue(baseRequest);
    const mcpEnvelope = service.issue({
      ...baseRequest,
      operationId: 'evidence-operation-mcp',
      sourceDefinitionId: 'user:mcp/session-a',
      sourceKind: 'mcp',
    });
    for (const envelope of [skillEnvelope, mcpEnvelope]) {
      expect(envelope?.truth).toEqual({
        state: 'unverified',
        authority: 'metis_automatic_truth_layer',
        reviewStatus: 'pending',
        correctionState: 'unknown',
        claimEligible: false,
        publishEligible: false,
      });
      expect(service.verify(envelope)).toBe(true);
      expect(service.verify({ ...envelope, truth: { ...envelope?.truth, state: 'verified' } })).toBe(false);
    }

    const authored = graph('a').skill;
    expect(PersonalizationDefinitionSchema.safeParse({
      ...authored,
      truth: { state: 'verified' },
      receipt: { verified: true },
    }).success).toBe(false);
  });

  it('rejects renderer attempts to self-assert URL or generated provenance through generic save', () => {
    const source = graph('a');
    const forgedUrlSkill = PersonalizationDefinitionSchema.parse({
      ...source.skill,
      id: 'url:skills/forged-installation',
      mcpIds: [],
      provenance: {
        ...source.skill.provenance,
        origin: 'url',
        sourceUrl: 'https://github.com/example/forged-skill',
        sourceRevision: 'forged-revision',
        installedDigest: 'f'.repeat(64),
      },
    });
    const forgedGeneratedMcp = PersonalizationDefinitionSchema.parse({
      ...source.mcp,
      id: 'generated:mcp/forged-server',
      provenance: {
        ...source.mcp.provenance,
        origin: 'generated',
        sourceRevision: 'forged-builder-receipt',
        installedDigest: 'e'.repeat(64),
      },
    });
    for (const definition of [forgedUrlSkill, forgedGeneratedMcp]) {
      const result = runtime.save({ contractVersion: 1, definition, expectedRevision: 0 });
      expect(result.ok).toBe(false);
    }
  });

  it('rejects a user-origin package Skill and accepts only a local generated MCP configuration', () => {
    const source = graph('a');
    const packageSkill = PersonalizationDefinitionSchema.parse({
      ...source.skill,
      id: 'user:skills/forged-package',
      mcpIds: [],
      sourceMode: 'package',
      packageEntry: 'SKILL.md',
    });
    const localMcp = PersonalizationDefinitionSchema.parse({
      ...source.mcp,
      id: 'user:mcp/local-config',
      sourceMode: 'generated',
      sourceUrl: null,
      exposedTools: [],
      workingDirectoryToken: null,
    });
    expect(runtime.save({
      contractVersion: 1,
      definition: packageSkill,
      expectedRevision: 0,
    }).ok).toBe(false);
    expect(runtime.save({
      contractVersion: 1,
      definition: localMcp,
      expectedRevision: 0,
    }).ok).toBe(true);
  });

  it('cannot restore an installer-authored historical revision through a currently user-authored definition', () => {
    const source = graph('a').skill;
    const id = 'user:skills/restore-provenance-bypass';
    const historyTime = 1_700_000_000_000;
    const installed = PersonalizationDefinitionSchema.parse({
      ...source,
      id,
      mcpIds: [],
      sourceMode: 'url',
      revision: 1,
      provenance: {
        ...source.provenance,
        origin: 'url',
        sourceUrl: 'https://github.com/example/original-installed-skill',
        sourceRevision: 'trusted-installer-revision',
        installedDigest: 'c'.repeat(64),
        createdAt: historyTime,
        updatedAt: historyTime,
      },
    });
    const userRevision = PersonalizationDefinitionSchema.parse({
      ...source,
      id,
      mcpIds: [],
      revision: 2,
      provenance: {
        ...source.provenance,
        createdAt: historyTime,
        updatedAt: historyTime + 1,
      },
    });
    expect(repository.save({ contractVersion: 1, definition: installed, expectedRevision: 0 }).ok).toBe(true);
    expect(repository.save({ contractVersion: 1, definition: userRevision, expectedRevision: 1 }).ok).toBe(true);
    const restored = runtime.restore({
      contractVersion: 1,
      id,
      sourceRevision: 1,
      expectedRevision: 2,
    });
    expect(restored.ok).toBe(false);
    expect(repository.get(id, true)?.provenance.origin).toBe('user');
  });
});
