import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { EvidenceEnvelopeService } from '../../electron/EvidenceEnvelopeService.js';
import { generateMcpBundle } from '../../electron/McpBuilderService.js';
import { PersonalizationExtensionService } from '../../electron/PersonalizationExtensionService.js';
import { PersonalizationMcpInstaller } from '../../electron/PersonalizationMcpInstaller.js';
import { PersonalizationSkillInstaller } from '../../electron/PersonalizationSkillInstaller.js';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import type { ChatMessage, NormalizedResponse, StreamChunk, ToolSpec } from '../../engine/core/types.js';
import {
  ScenarioRunCoordinator,
  digestResolvedManifestSnapshot,
  digestScenarioStepOutput,
  type ScenarioRunRecord,
  type ScenarioStepExecutionInput,
} from '../../engine/personalization/ScenarioRunCoordinator.js';
import { buildBuiltinPersonalizationDefinitions } from '../fixtures/personalization/legacyBuiltinDefinitions.js';
import { PersonalizationRepository } from '../../engine/personalization/PersonalizationRepository.js';
import { PersonalizationResolver } from '../../engine/personalization/PersonalizationResolver.js';
import { BaseProvider } from '../../engine/providers/BaseProvider.js';
import type {
  FullAccessPolicy,
  ResolvedRunManifest,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import {
  FullAccessPolicySchema,
  ResolvedRunManifestSchema,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import {
  McpBuilderSpecificationSchema,
  McpInstalledRecordSchema,
  McpUrlInstallResponseSchema,
} from '../../engine/runtime/McpInstallationContract.js';
import { UrlMcpApplyRequestSchema } from '../../engine/runtime/PersonalizationExtensionContract.js';
import { InMemoryLiveSteeringQueue } from '../../engine/runtime/LiveSteeringContract.js';
import { SkillUrlInstallRequestSchema } from '../../engine/runtime/SkillInstallationContract.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { PersonalizationRuntimeService } from '../../electron/PersonalizationRuntimeService.js';

const FULL_ACCESS: FullAccessPolicy = {
  mode: 'full_access',
  perActionConfirmation: false,
  liveSteering: true,
  silentCheckpoints: true,
  rollbackOnFailure: false,
  persistAcrossRestart: true,
};

const EXECUTE_COMMAND: ToolSpec = {
  name: 'execute_command',
  description: 'Execute a command',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
    },
    required: ['command', 'args'],
    additionalProperties: false,
  },
};

class OneToolProvider extends BaseProvider {
  constructor(private readonly call: { command: string; args: string[] }) { super(); }
  capabilities() {
    return {
      providerType: 'security-probe', model: 'security-probe', nativeToolCalling: true,
      jsonSchemaOutput: false, streaming: false, thinking: false,
      maxContextTokens: 8_000, maxOutputTokens: 1_000, retryableStatusCodes: [],
    };
  }
  async complete(_messages: ChatMessage[]): Promise<NormalizedResponse> {
    void _messages;
    return {
      content: '',
      toolCalls: [{ name: 'execute_command', arguments: this.call, id: 'destructive-probe' }],
      finishReason: 'tool_calls',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
  async *completeStream(): AsyncGenerator<StreamChunk, void, unknown> {}
}

function realFactoryManifest(scenarioId = 'builtin:scenarios/general-research'): ResolvedRunManifest {
  const definitions = buildBuiltinPersonalizationDefinitions();
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const resolver = new PersonalizationResolver({
    get: (id) => byId.get(id),
    list: (kind, includeDisabled) => definitions.filter((definition) => {
      if (kind && definition.kind !== kind) return false;
      return includeDisabled || definition.enabled;
    }),
  });
  const result = resolver.resolve({
    sessionId: 'security-session',
    projectId: 'security-project',
    scenarioId,
    createdAt: 1_785_398_400_000,
  });
  if (!result.ok) throw new Error(`Factory scenario failed to resolve: ${result.issues.join('; ')}`);
  return result.manifest;
}

function successfulStepResult(input: ScenarioStepExecutionInput) {
  const output = { executionKey: input.executionKey, stepId: input.step.id };
  return {
    ok: true as const,
    output,
    outputDigest: digestScenarioStepOutput(output),
    artifactRefs: [],
  };
}

function canonicalIntegrityJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalIntegrityJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalIntegrityJson(record[key])}`,
  ).join(',')}}`;
}

function manifestIntegrityTag(secret: Buffer, manifest: ResolvedRunManifest): string {
  return createHmac('sha256', secret)
    .update('metis:personalization-run-manifest:v2\0')
    .update(canonicalIntegrityJson(manifest), 'utf8')
    .digest('hex');
}

describe('Personalization platform security attacks', () => {
  it.each([
    ['powershell.exe', ['-NoProfile', '-Command', 'Remove-Item -LiteralPath . -Recurse -Force']],
    ['pwsh', ['-Command', 'Remove-Item -Path * -Recurse -Force']],
    ['cmd.exe', ['/d', '/s', '/c', 'rmdir /s /q .']],
    ['cmd.exe', ['/c', 'rd /s /q .']],
    ['PoWeRsHeLl.ExE', ['-NoProfile', '-Command', 'rM -FoRcE -ReCuRsE .']],
    ['pwsh.exe', ['-Command', 'Remove-Item', '-Force', '-LiteralPath', '.', '-Recurse']],
    ['powershell', ['-Command', '"Remove-Item -Path * -Force -Recurse"']],
    ['cmd', ['/c', '"RD /Q /S ."']],
    ['cmd.exe', ['/c', 'rmdir', '/q', '.', '/s']],
    ['powershell.exe', ['-Command', 'Get-ChildItem . | Remove-Item -Force -Recurse']],
    ['pwsh', ['-Command', 'Clear-Disk -Number 0 -RemoveData -Confirm:$false']],
    ['powershell.exe', ['-EncodedCommand', 'UgBlAG0AbwB2AGUALQBJAHQAZQBtACAALgAgAC0AUgBlAGMAdQByAHMAZQA=']],
    ['pwsh', ['-Command', 'IEX "Remove-Item -Recurse -Force ."']],
  ])('blocks destructive Full Access command without dispatching %s %j', async (command, args) => {
    let handlerCalls = 0;
    const registry = new ToolRegistry();
    registry.register(EXECUTE_COMMAND);
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('execute_command', async () => {
      handlerCalls += 1;
      return 'probe intercepted before a real process was started';
    });
    const loop = new AgentLoop({ provider: new OneToolProvider({ command, args }), registry, dispatcher });
    const result = await loop.run({
      messages: [{ role: 'user', content: 'security probe' }],
      maxTurns: 1,
      sessionId: `security-${command.replace(/[^A-Za-z]/gu, '-')}`,
      taskContractHash: 'security-task',
      promptStackHash: 'security-prompt',
      resumeFromCheckpoint: false,
      requestId: 'security-request',
      fullAccess: FULL_ACCESS,
      allowedTools: ['execute_command'],
    });

    expect(handlerCalls).toBe(0);
    expect(result.traceEvents.some((event) => event.event === 'tool.blocked_hard_safety')).toBe(true);
  });

  it.each([
    ['powershell.exe', ['-Command', "&('Remove'+'-Item') -LiteralPath . -Recurse -Force"]],
    ['python', ['-c', "import shutil; shutil.rmtree('.', ignore_errors=True)"]],
    ['node', ['-e', "require('node:fs').rmSync('.', {recursive:true, force:true})"]],
    ['bash', ['-c', 'find . -mindepth 1 -delete']],
  ])('rejects interpreter-backed execute_command before a personalization run can dispatch %s %j', (command, args) => {
    let handlerCalls = 0;
    const manifest = structuredClone(realFactoryManifest());
    manifest.allowedTools = ['execute_command'];
    const firstStep = manifest.workflow[0];
    if (firstStep) firstStep.toolIds = ['execute_command'];
    manifest.manifestDigest = digestResolvedManifestSnapshot(manifest);
    const parsed = ResolvedRunManifestSchema.safeParse(manifest);
    if (parsed.success) handlerCalls += 1;

    expect(command.length).toBeGreaterThan(0);
    expect(args.length).toBeGreaterThan(0);
    expect(parsed.success).toBe(false);
    expect(handlerCalls).toBe(0);
  });

  it.each([
    ['powershell.exe', ['-NoProfile', '-Command', 'Get-ChildItem -LiteralPath .']],
    ['pwsh', ['-Command', 'Get-Content -LiteralPath README.md']],
    ['cmd.exe', ['/d', '/s', '/c', 'dir /b']],
    ['git', ['status', '--short']],
  ])('does not false-positive on safe Full Access command %s %j', async (command, args) => {
    let handlerCalls = 0;
    const registry = new ToolRegistry();
    registry.register(EXECUTE_COMMAND);
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('execute_command', async () => {
      handlerCalls += 1;
      return 'safe command intercepted before a real process was started';
    });
    const loop = new AgentLoop({ provider: new OneToolProvider({ command, args }), registry, dispatcher });
    const result = await loop.run({
      messages: [{ role: 'user', content: 'security positive control' }],
      maxTurns: 1,
      sessionId: `security-safe-${command.replace(/[^A-Za-z]/gu, '-')}`,
      taskContractHash: 'security-task',
      promptStackHash: 'security-prompt',
      resumeFromCheckpoint: false,
      requestId: 'security-request-safe',
      fullAccess: FULL_ACCESS,
      allowedTools: ['execute_command'],
    });

    expect(handlerCalls).toBe(1);
    expect(result.traceEvents.some((event) => event.event === 'tool.blocked_hard_safety')).toBe(false);
  });

  it('rejects terminal run output and artifact rollback when the persisted HMAC is stale', async () => {
    let executorCalls = 0;
    const db = new Database(':memory:');
    try {
      const repository = new PersonalizationRepository(db, Buffer.alloc(32, 31));
      const coordinator = new ScenarioRunCoordinator({
        executor: async (input) => {
          executorCalls += 1;
          return successfulStepResult(input);
        },
        onCheckpoint: (record) => { repository.saveScenarioRunRecord(record); },
      });
      const completed = await coordinator.start({
        runId: 'security-terminal-rollback',
        manifest: realFactoryManifest(),
      });
      expect(completed.ok).toBe(true);
      if (!completed.ok) return;
      expect(completed.record.status).toBe('completed');
      const callsAfterCompletion = executorCalls;

      const tampered: ScenarioRunRecord = structuredClone(completed.record);
      tampered.status = 'interrupted';
      tampered.completedAt = null;
      const finalStepId = tampered.executionOrder.at(-1);
      const finalStep = tampered.steps.find((step) => step.stepId === finalStepId);
      if (!finalStep) throw new Error('Expected a completed final scenario step');
      finalStep.output = { text: 'ATTACKER-REWRITTEN FINAL ANSWER' };
      finalStep.outputDigest = digestScenarioStepOutput(finalStep.output);
      finalStep.artifactRefs = [{
        id: 'attacker-rewritten-artifact',
        version: 999,
        contentDigest: 'b'.repeat(64),
      }];

      // Simulate direct at-rest corruption of both the indexed status and JSON while
      // preserving the original keyed integrity tag.
      db.prepare(`
        UPDATE personalization_scenario_runs
        SET status = 'interrupted', record_json = ?
        WHERE run_id = ?
      `).run(JSON.stringify(tampered), tampered.runId);

      expect(repository.getScenarioRunRecord(tampered.runId)).toBeUndefined();
      expect(repository.getRecoverableScenarioRun(tampered.manifestSnapshot.sessionId)).toBeUndefined();
      expect(repository.listScenarioRunRecords(tampered.manifestSnapshot.sessionId)).toEqual([]);
      expect(() => repository.saveScenarioRunRecord(tampered)).toThrow(/integrity verification failed/u);
      expect(executorCalls).toBe(callsAfterCompletion);
    } finally {
      db.close();
    }
  });

  it('rejects MCP manifest credential queries before installer, definition, or evidence side effects', async () => {
    const secretBearingUrl = 'https://packages.example.org/manifest.json?token=TOP_SECRET_SENTINEL';
    const request = {
      contractVersion: 1,
      mode: 'mcp_url',
      definitionId: 'url:mcp/security-query-leak',
      manifestUrl: secretBearingUrl,
      expectedManifestSha256: null,
      expectedRevision: 0,
      evidenceContext: {
        sessionId: 'security-session',
        projectId: 'security-project',
        operationId: '00000000-0000-4000-8000-000000000042',
        runManifestDigest: 'a'.repeat(64),
        observedAt: 1_000,
      },
    } as const;
    expect(UrlMcpApplyRequestSchema.safeParse(request).success).toBe(false);

    let definitionCalls = 0;
    let evidenceCalls = 0;
    let installerCalls = 0;
    const service = new PersonalizationExtensionService({
      definitions: {
        get: () => { definitionCalls += 1; return undefined; },
        save: () => { definitionCalls += 1; throw new Error('must not be reached'); },
      },
      evidence: {
        issue: () => { evidenceCalls += 1; return undefined; },
        verify: () => { evidenceCalls += 1; return false; },
      },
      skills: {
        installFromPackage: () => { throw new Error('unused'); },
        installFromUrl: async () => { throw new Error('unused'); },
        uninstall: () => ({ ok: false }),
        resolveInstalledDirectory: () => undefined,
      },
      mcp: {
        installFromUrl: async () => { installerCalls += 1; throw new Error('must not be reached'); },
        getLaunchDescriptor: () => null,
      },
      mcpBuilder: { build: async () => { throw new Error('unused'); } },
      mcpCompensator: { rollbackInstallation: () => true },
      now: () => 1_100,
    });

    const result = await service.apply(request);

    expect(result).toEqual({
      ok: false,
      mode: null,
      code: 'invalid_request',
      detailCode: 'schema_rejected',
      compensated: false,
    });
    expect(definitionCalls).toBe(0);
    expect(evidenceCalls).toBe(0);
    expect(installerCalls).toBe(0);
  });

  it('pins the validated skill URL address into the fetch dispatcher', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-skill-dns-toctou-'));
    let lookupCalls = 0;
    let fetchCalls = 0;
    let fetchSawPinnedConnectionControl = false;
    const lookup = (async () => {
      lookupCalls += 1;
      return [{ address: '93.184.216.34', family: 4 }];
    }) as typeof dnsLookup;
    const fetchProbe: typeof fetch = async (_input, init) => {
      fetchCalls += 1;
      const options = init as RequestInit & { dispatcher?: unknown; lookup?: unknown };
      fetchSawPinnedConnectionControl = options.dispatcher !== undefined || options.lookup !== undefined;
      return new Response('rebind probe intercepted before network', {
        status: 502,
        headers: { 'content-type': 'text/plain' },
      });
    };
    try {
      const installer = new PersonalizationSkillInstaller(root, { lookup, fetch: fetchProbe });
      const result = await installer.installFromUrl('https://rebind.example.org/skill.zip');

      expect(result).toMatchObject({ ok: false, code: 'download_failed' });
      expect(lookupCalls).toBe(1);
      expect(fetchCalls).toBe(1);
      expect(fetchSawPinnedConnectionControl).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a failed Full Access tool honestly without promising impossible generic rollback', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-full-access-rollback-'));
    const marker = path.join(root, 'side-effect.txt');
    const registry = new ToolRegistry();
    registry.register(EXECUTE_COMMAND);
    const dispatcher = new ToolDispatcher(registry);
    dispatcher.registerHandler('execute_command', async () => {
      fs.writeFileSync(marker, 'mutation completed before handler failure', 'utf8');
      throw new Error('injected post-mutation tool failure');
    });
    const loop = new AgentLoop({
      provider: new OneToolProvider({ command: 'git', args: ['status', '--short'] }),
      registry,
      dispatcher,
    });
    try {
      const result = await loop.run({
        messages: [{ role: 'user', content: 'rollback security probe' }],
        maxTurns: 1,
        sessionId: 'security-rollback',
        taskContractHash: 'security-task',
        promptStackHash: 'security-prompt',
        resumeFromCheckpoint: false,
        requestId: 'security-request-rollback',
        fullAccess: FULL_ACCESS,
        allowedTools: ['execute_command'],
      });

      expect(result.status).toBe('max_turns_reached');
      expect(result.toolResults).toMatchObject([{ status: 'error' }]);
      expect(fs.readFileSync(marker, 'utf8')).toContain('mutation completed');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a Full Access policy that falsely claims generic rollback support', () => {
    expect(FullAccessPolicySchema.safeParse({ ...FULL_ACCESS, rollbackOnFailure: true }).success).toBe(false);
  });

  it('rejects active-manifest prompt injection when its stored digests no longer match a fresh resolution', () => {
    const original = realFactoryManifest();
    const secret = Buffer.alloc(32, 19);
    const tag = manifestIntegrityTag(secret, original);
    const manifest = structuredClone(original);
    const firstLayer = manifest.promptStack[0];
    if (!firstLayer) throw new Error('Expected a resolved prompt layer');
    const originalManifestDigest = manifest.manifestDigest;
    const originalLayerDigest = firstLayer.contentDigest;
    firstLayer.content = 'ATTACKER-INJECTED SYSTEM PROMPT';
    const schemaValidTamper = ResolvedRunManifestSchema.parse(manifest);
    expect(schemaValidTamper.manifestDigest).toBe(originalManifestDigest);
    expect(schemaValidTamper.promptStack[0]?.contentDigest).toBe(originalLayerDigest);

    const repositoryDouble = {
      getActiveRunManifestRecord: () => ({ manifest: schemaValidTamper, integrityTag: tag }),
      get: () => undefined,
      list: () => [],
      saveRunManifest: (candidate: ResolvedRunManifest) => candidate,
    } as unknown as PersonalizationRepository;
    const runtime = new PersonalizationRuntimeService(repositoryDouble, secret);

    const result = runtime.resolveForAgent({
      contractVersion: 1,
      sessionId: manifest.sessionId,
      projectId: manifest.projectId,
      scenarioId: manifest.scenarioId,
    });

    expect(result).toBeUndefined();
  });

  it('rejects a rehashed active-manifest prompt injection whose keyed integrity tag is stale', () => {
    const original = realFactoryManifest();
    const secret = Buffer.alloc(32, 23);
    const tag = manifestIntegrityTag(secret, original);
    const manifest = structuredClone(original);
    const firstLayer = manifest.promptStack[0];
    if (!firstLayer) throw new Error('Expected a resolved prompt layer');
    firstLayer.content = 'ATTACKER-INJECTED AND REHASHED SYSTEM PROMPT';
    firstLayer.contentDigest = createHash('sha256').update(firstLayer.content, 'utf8').digest('hex');
    manifest.manifestDigest = digestResolvedManifestSnapshot(manifest);
    const schemaValidTamper = ResolvedRunManifestSchema.parse(manifest);
    const repositoryDouble = {
      getActiveRunManifestRecord: () => ({ manifest: schemaValidTamper, integrityTag: tag }),
      get: () => undefined,
      list: () => [],
      saveRunManifest: (candidate: ResolvedRunManifest) => candidate,
    } as unknown as PersonalizationRepository;
    const runtime = new PersonalizationRuntimeService(repositoryDouble, secret);

    const result = runtime.resolveForAgent({
      contractVersion: 1,
      sessionId: manifest.sessionId,
      projectId: manifest.projectId,
      scenarioId: manifest.scenarioId,
    });

    expect(result).toBeUndefined();
  });

  it('isolates live steering by session and rejects sequence replay', () => {
    const queue = new InMemoryLiveSteeringQueue();
    queue.enqueue({
      type: 'instruction',
      id: 'steer-one',
      sessionId: 'owner-session-a',
      sequence: 1,
      createdAt: 1_000,
      content: 'Refine the current paragraph.',
    });

    expect(queue.drain({ sessionId: 'owner-session-b', afterSequence: 0 })).toEqual([]);
    expect(() => queue.enqueue({
      type: 'interrupt',
      id: 'replay-one',
      sessionId: 'owner-session-a',
      sequence: 1,
      createdAt: 1_001,
      reason: 'Replayed sequence',
    })).toThrow(/sequence must increase/u);
    expect(queue.drain({ sessionId: 'owner-session-a', afterSequence: 0 })).toMatchObject([
      { type: 'instruction', sessionId: 'owner-session-a', sequence: 1 },
    ]);
  });

  it('keeps automatic truth fields non-editable and detects signed evidence tampering', () => {
    const service = new EvidenceEnvelopeService(Buffer.alloc(32, 11));
    const ingress = {
      contractVersion: 1,
      sessionId: 'evidence-session',
      projectId: 'evidence-project',
      operationId: 'evidence-operation',
      runManifestDigest: 'a'.repeat(64),
      sourceDefinitionId: 'user:skills/evidence-probe',
      sourceDefinitionRevision: 1,
      sourceKind: 'skill',
      observedAt: 1_000,
      sourceUrl: null,
      locator: null,
      payload: { kind: 'text', content: 'Untrusted source text' },
    } as const;
    const envelope = service.issue(ingress);
    expect(envelope).toBeDefined();
    if (!envelope) return;
    expect(service.verify(envelope)).toBe(true);
    expect(service.issue({
      ...ingress,
      truth: { state: 'verified', publishEligible: true },
    })).toBeUndefined();
    expect(service.verify({
      ...envelope,
      payload: { kind: 'text', content: 'Attacker-rewritten source text' },
    })).toBe(false);
    expect(service.verify({
      ...envelope,
      truth: { ...envelope.truth, publishEligible: true },
    })).toBe(false);
  });

  it('rejects an enabled MCP returned by the URL installer and compensates it before definition persistence', async () => {
    const enabledRecord = McpInstalledRecordSchema.parse({
      installationId: `mcp_${'e'.repeat(32)}`,
      packageId: 'must-start-disabled',
      packageVersion: '1.0.0',
      manifestSha256: 'c'.repeat(64),
      packageSha256: 'd'.repeat(64),
      state: 'enabled',
      enabled: true,
      installedAt: 1_000,
      verifiedAt: 1_001,
      probedAt: 1_002,
      exposedTools: ['unexpected_tool'],
      failureCode: null,
    });
    let definitionCalls = 0;
    let evidenceCalls = 0;
    let compensationCalls = 0;
    const request = {
      contractVersion: 1,
      mode: 'mcp_url',
      definitionId: 'url:mcp/must-start-disabled',
      manifestUrl: 'https://packages.example.org/manifest.json',
      expectedManifestSha256: null,
      expectedRevision: 0,
      evidenceContext: {
        sessionId: 'security-session',
        projectId: 'security-project',
        operationId: '00000000-0000-4000-8000-000000000043',
        runManifestDigest: 'a'.repeat(64),
        observedAt: 1_000,
      },
    } as const;
    const service = new PersonalizationExtensionService({
      definitions: {
        get: () => { definitionCalls += 1; return undefined; },
        save: () => { definitionCalls += 1; throw new Error('must not persist'); },
      },
      evidence: {
        issue: () => { evidenceCalls += 1; return undefined; },
        verify: () => { evidenceCalls += 1; return false; },
      },
      skills: {
        installFromPackage: () => { throw new Error('unused'); },
        installFromUrl: async () => { throw new Error('unused'); },
        uninstall: () => ({ ok: false }),
        resolveInstalledDirectory: () => undefined,
      },
      mcp: {
        installFromUrl: async () => McpUrlInstallResponseSchema.parse({
          ok: true,
          operationId: request.evidenceContext.operationId,
          record: enabledRecord,
        }),
        getLaunchDescriptor: () => ({ secretRefs: {} }),
      },
      mcpBuilder: { build: async () => { throw new Error('unused'); } },
      mcpCompensator: {
        rollbackInstallation: () => { compensationCalls += 1; return true; },
      },
    });

    const result = await service.apply(request);

    expect(result).toMatchObject({
      ok: false,
      mode: 'mcp_url',
      code: 'mcp_install_failed',
      detailCode: 'url_mcp_must_start_disabled',
      compensated: true,
    });
    expect(compensationCalls).toBe(1);
    expect(definitionCalls).toBe(0);
    expect(evidenceCalls).toBe(0);
  });

  it('rejects post-install MCP entry tampering before returning a launch descriptor', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-mcp-entry-tamper-'));
    const originalSource = Buffer.from('export const installedIntegrityProbe = true;\n', 'utf8');
    const inputSchema = { type: 'object', properties: {}, additionalProperties: false };
    const tool = { name: 'integrity_probe', description: 'Integrity probe.', inputSchema };
    const digest = createHash('sha256').update(originalSource).digest('hex');
    try {
      const installer = new PersonalizationMcpInstaller(root, { runtimeExecutable: process.execPath });
      const record = installer.installGeneratedPackage({
        format: 'metis-mcp-package',
        contractVersion: 1,
        packageId: 'integrity-probe',
        version: '1.0.0',
        name: 'Integrity probe',
        description: 'Security test package.',
        transport: 'stdio',
        runtime: 'node',
        entry: 'server.mjs',
        args: [],
        environment: [],
        tools: [tool],
        files: [{
          path: 'server.mjs',
          url: 'https://packages.example.org/server.mjs',
          sha256: digest,
          size: originalSource.length,
        }],
      }, [{ path: 'server.mjs', body: originalSource }]);
      expect(installer.staticValidate(record.installationId).ok).toBe(true);
      const enabled = await installer.probeAndEnable(record.installationId, {
        probe: async () => ({ ok: true, protocolVersion: '2024-11-05', tools: [tool] }),
      });
      expect(enabled.ok).toBe(true);
      const initialDescriptor = installer.getLaunchDescriptor(record.installationId);
      expect(initialDescriptor).not.toBeNull();
      if (!initialDescriptor) return;
      const entry = initialDescriptor.args[0];
      if (!entry) throw new Error('Expected managed MCP entry path');
      fs.writeFileSync(entry, 'globalThis.__METIS_POST_INSTALL_TAMPER__ = true;\n', 'utf8');

      const descriptorAfterTamper = installer.getLaunchDescriptor(record.installationId);

      expect(descriptorAfterTamper).toBeNull();
      expect(fs.readFileSync(entry, 'utf8')).toContain('__METIS_POST_INSTALL_TAMPER__');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects generated MCP credential queries before executable source generation', () => {
    const credentialUrl = 'https://api.example.org/v1?token=TOP_SECRET_BUILDER_SENTINEL';
    const specification = {
      contractVersion: 1,
      packageId: 'builder-secret-query',
      version: '1.0.0',
      name: 'Builder secret query',
      description: 'Security probe.',
      tools: [{
        name: 'fetch_record',
        description: 'Fetch a record.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
        implementation: {
          kind: 'http_json',
          baseUrl: credentialUrl,
          routeTemplate: '/records/{id}',
          method: 'GET',
          bearerSecretEnv: null,
        },
      }],
      environment: [],
    } as const;

    expect(McpBuilderSpecificationSchema.safeParse(specification).success).toBe(false);
    expect(() => generateMcpBundle(specification)).toThrow();
  });

  it('rejects cleartext HTTP skill-package URLs before download', async () => {
    const url = 'http://packages.example.org/skill.zip';
    expect(SkillUrlInstallRequestSchema.safeParse({
      contractVersion: 1,
      url,
      expectedArchiveSha256: null,
      expectedId: null,
      expectedVersion: null,
    }).success).toBe(false);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-skill-http-'));
    let fetchCalls = 0;
    try {
      const installer = new PersonalizationSkillInstaller(root, {
        lookup: (async () => [{ address: '93.184.216.34', family: 4 }]) as typeof dnsLookup,
        fetch: (async () => {
          fetchCalls += 1;
          return new Response('cleartext probe intercepted', { status: 502 });
        }) as typeof fetch,
      });
      expect(await installer.installFromUrl(url)).toMatchObject({ ok: false, code: 'url_invalid' });
      expect(fetchCalls).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
