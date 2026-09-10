import fs from 'node:fs';

import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { realTempRoot } from './helpers/realTempDir.mjs';
import { afterEach, describe, expect, it } from 'vitest';
import { EvidenceEnvelopeService } from '../../electron/EvidenceEnvelopeService.js';
import {
  ManagedPersonalizationMcpRuntime,
  type ManagedMcpSecretResolver,
} from '../../electron/ManagedPersonalizationMcpRuntime.js';
import {
  PersonalizationMcpInstaller,
  type McpControlledProbeRequest,
  type McpControlledProbeRunner,
  type McpLaunchDescriptor,
} from '../../electron/PersonalizationMcpInstaller.js';
import { MCPClient } from '../../engine/mcp/MCPClient.js';
import { ExactEnvironmentStdioTransport } from '../../engine/mcp/ExactEnvironmentStdioTransport.js';
import type { McpProbeResult, McpPackageManifest } from '../../engine/runtime/McpInstallationContract.js';
import type { McpDefinition } from '../../engine/runtime/PersonalizationRuntimeContract.js';
import type { ManagedMcpOwner } from '../../engine/runtime/ManagedMcpRuntimeContract.js';

const roots: string[] = [];
const runtimes: ManagedPersonalizationMcpRuntime[] = [];
const OWNER: ManagedMcpOwner = { webContentsId: 11, processId: 22, routingId: 0, generation: 1 };
const SECRET_VALUE = 'runtime-secret-29f4380ad61f';
const RUN_DIGEST = 'f'.repeat(64);
let operationSequence = 1;

function operationId(): string {
  const suffix = operationSequence.toString().padStart(12, '0');
  operationSequence += 1;
  return `00000000-0000-4000-8000-${suffix}`;
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(realTempRoot(), 'metis-managed-mcp-runtime-'));
  roots.push(root);
  return root;
}

const INPUT_TEXT = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};
const INPUT_EMPTY = { type: 'object', properties: {}, additionalProperties: false };

const SERVER_SOURCE = `
import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin });
const tools = [
  { name: 'bounded_echo', description: 'Returns bounded text.', inputSchema: ${JSON.stringify(INPUT_TEXT)} },
  { name: 'environment_names', description: 'Lists environment keys.', inputSchema: ${JSON.stringify(INPUT_EMPTY)} },
  { name: 'secret_echo', description: 'Attempts to echo a secret.', inputSchema: ${JSON.stringify(INPUT_EMPTY)} },
  { name: 'large_output', description: 'Returns a bounded-protocol oversized payload.', inputSchema: ${JSON.stringify(INPUT_EMPTY)} },
  { name: 'slow_tool', description: 'Completes after a delay.', inputSchema: ${JSON.stringify(INPUT_EMPTY)} }
];
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'managed-fixture', version: '1' } });
    return;
  }
  if (message.method === 'tools/list') {
    send(message.id, { tools });
    return;
  }
  if (message.method !== 'tools/call') return;
  const name = message.params?.name;
  const respond = (text) => send(message.id, { content: [{ type: 'text', text }] });
  if (name === 'bounded_echo') respond(JSON.stringify({ text: message.params.arguments.text, verified: true, clean: true }));
  else if (name === 'environment_names') respond(Object.keys(process.env).sort().join(','));
  else if (name === 'secret_echo') respond(String(process.env.API_TOKEN ?? ''));
  else if (name === 'large_output') respond('x'.repeat(300000));
  else if (name === 'slow_tool') setTimeout(() => respond('late'), 2000);
});
`;

class ActualProbeRunner implements McpControlledProbeRunner {
  async probe(request: McpControlledProbeRequest): Promise<McpProbeResult> {
    const environment = { ...request.fixedEnvironment };
    for (const [name, reference] of Object.entries(request.secretRefs)) {
      if (reference !== '${secret:API_TOKEN}') return { ok: false, code: 'secret_ref_rejected' };
      environment[name] = SECRET_VALUE;
    }
    const client = new MCPClient(
      { name: request.installationId, command: [request.command, ...request.args], env: environment },
      new ExactEnvironmentStdioTransport(request.workingDirectory),
    );
    try {
      await client.connect(request.timeoutMs);
      return { ok: true, tools: await client.listTools(), protocolVersion: '2024-11-05' };
    } catch {
      return { ok: false, code: 'actual_probe_failed' };
    } finally {
      await client.close().catch(() => {});
    }
  }
}

interface Harness {
  root: string;
  installer: PersonalizationMcpInstaller;
  runtime: ManagedPersonalizationMcpRuntime;
  definition: McpDefinition;
  installationId: string;
  entry: string;
  resolverCalls: Array<{ reference: string; environmentName: string; sessionId: string; projectId: string }>;
}

async function createHarness(
  resolverValue: string | undefined | (() => string | undefined) = SECRET_VALUE,
): Promise<Harness> {
  const root = temporaryRoot();
  const installer = new PersonalizationMcpInstaller(path.join(root, 'installations'), {
    runtimeExecutable: process.execPath,
    now: () => 1_000,
  });
  const body = Buffer.from(SERVER_SOURCE, 'utf8');
  const manifest: McpPackageManifest = {
    format: 'metis-mcp-package',
    contractVersion: 1,
    packageId: 'managed-runtime-fixture',
    version: '1.0.0',
    name: 'Managed runtime fixture',
    description: 'Harmless newline-delimited MCP fixture used by the real runtime tests.',
    transport: 'stdio',
    runtime: 'node',
    entry: 'server.mjs',
    args: [],
    environment: [{
      name: 'API_TOKEN',
      secretRef: '${secret:API_TOKEN}',
      required: true,
      description: 'Test-only secret reference.',
    }],
    tools: [
      { name: 'bounded_echo', description: 'Returns bounded text.', inputSchema: INPUT_TEXT },
      { name: 'environment_names', description: 'Lists environment keys.', inputSchema: INPUT_EMPTY },
      { name: 'secret_echo', description: 'Attempts to echo a secret.', inputSchema: INPUT_EMPTY },
      { name: 'large_output', description: 'Returns a bounded-protocol oversized payload.', inputSchema: INPUT_EMPTY },
      { name: 'slow_tool', description: 'Completes after a delay.', inputSchema: INPUT_EMPTY },
    ],
    files: [{
      path: 'server.mjs',
      url: 'https://example.com/server.mjs',
      sha256: sha256(body),
      size: body.length,
    }],
  };
  const installed = installer.installGeneratedPackage(manifest, [{ path: 'server.mjs', body }]);
  expect(installer.staticValidate(installed.installationId).ok).toBe(true);
  const enabled = await installer.probeAndEnable(installed.installationId, new ActualProbeRunner());
  if (!enabled.ok) throw new Error(`Real MCP probe failed: ${enabled.code ?? 'unknown'}`);
  const descriptor = installer.getLaunchDescriptor(installed.installationId);
  expect(descriptor).not.toBeNull();

  const definition: McpDefinition = {
    contractVersion: 1,
    id: 'generated:mcp/managed-runtime-fixture',
    name: 'Managed runtime fixture',
    description: 'A runtime-bound MCP definition.',
    enabled: true,
    tags: [],
    revision: 1,
    provenance: {
      origin: 'generated',
      author: 'Metis MCP Builder',
      version: '1.0.0',
      license: null,
      sourceUrl: null,
      sourceRevision: null,
      installedDigest: installed.packageSha256,
      parentId: null,
      parentVersion: null,
      locallyModified: false,
      createdAt: 1_000,
      updatedAt: 1_000,
    },
    kind: 'mcp',
    sourceMode: 'generated',
    transport: 'stdio',
    command: 'metis-managed-mcp',
    args: [installed.installationId],
    environment: { API_TOKEN: { secret: true, value: null } },
    sourceUrl: null,
    exposedTools: manifest.tools.map((tool) => tool.name),
    workingDirectoryToken: installed.installationId,
  };
  const resolverCalls: Harness['resolverCalls'] = [];
  const resolver: ManagedMcpSecretResolver = {
    resolve(reference, context) {
      resolverCalls.push({ reference, environmentName: context.environmentName, sessionId: context.sessionId, projectId: context.projectId });
      return typeof resolverValue === 'function' ? resolverValue() : resolverValue;
    },
  };
  const runtime = new ManagedPersonalizationMcpRuntime(
    installer,
    resolver,
    new EvidenceEnvelopeService(randomBytes(32)),
    {
      now: () => 2_000,
      runtimeSnapshotRoot: path.join(root, 'runtime-snapshots'),
      recoverStaleSnapshots: true,
    },
  );
  runtimes.push(runtime);
  return {
    root,
    installer,
    runtime,
    definition,
    installationId: installed.installationId,
    entry: descriptor!.args[0]!,
    resolverCalls,
  };
}

function startRequest(definition: McpDefinition, owner = OWNER) {
  return {
    contractVersion: 1,
    operationId: operationId(),
    sessionId: 'session-one',
    projectId: 'project-one',
    owner,
    definition,
  };
}

function invokeRequest(runtimeToken: string, toolName: string, arguments_: Record<string, unknown>, owner = OWNER) {
  return {
    contractVersion: 1,
    operationId: operationId(),
    sessionId: 'session-one',
    projectId: 'project-one',
    owner,
    runtimeToken,
    toolName,
    arguments: arguments_,
    runManifestDigest: RUN_DIGEST,
    timeoutMs: 1_000,
  };
}

async function startHarness(harness: Harness) {
  const result = await harness.runtime.start(startRequest(harness.definition));
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdownAll()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  delete process.env.METIS_MANAGED_PARENT_SECRET;
});

describe('ManagedPersonalizationMcpRuntime', () => {
  it('launches an actually installed stdio MCP, handshakes, invokes, and signs untrusted output', async () => {
    const harness = await createHarness();
    const started = await startHarness(harness);
    const invoked = await harness.runtime.invoke(invokeRequest(started.runtimeToken, 'bounded_echo', { text: 'hello' }));
    expect(invoked.ok).toBe(true);
    if (!invoked.ok) return;
    expect(invoked.envelope.payload).toEqual({
      kind: 'text',
      content: JSON.stringify({ text: 'hello', verified: true, clean: true }),
    });
    expect(invoked.envelope.truth).toMatchObject({
      state: 'unverified',
      reviewStatus: 'pending',
      correctionState: 'unknown',
      claimEligible: false,
      publishEligible: false,
    });
    expect(invoked.envelope.sessionId).toBe('session-one');
    expect(invoked.envelope.projectId).toBe('project-one');
    expect(JSON.stringify(invoked)).not.toContain(SECRET_VALUE);
    expect(harness.resolverCalls).toEqual([{
      reference: '${secret:API_TOKEN}',
      environmentName: 'API_TOKEN',
      sessionId: 'session-one',
      projectId: 'project-one',
    }]);
  });

  it('does not inherit a parent secret environment variable', async () => {
    process.env.METIS_MANAGED_PARENT_SECRET = 'parent-secret-must-not-cross';
    const harness = await createHarness();
    const started = await startHarness(harness);
    const invoked = await harness.runtime.invoke(invokeRequest(started.runtimeToken, 'environment_names', {}));
    expect(invoked.ok).toBe(true);
    if (!invoked.ok || invoked.envelope.payload.kind !== 'text') return;
    expect(invoked.envelope.payload.content).toContain('API_TOKEN');
    expect(invoked.envelope.payload.content).not.toContain('METIS_MANAGED_PARENT_SECRET');
  });

  it('runs from an integrity-bound private snapshot when the installed source changes before spawn', async () => {
    let installedEntry = '';
    const harness = await createHarness(() => {
      fs.writeFileSync(installedEntry, 'throw new Error("changed after descriptor verification");\n', 'utf8');
      return SECRET_VALUE;
    });
    installedEntry = harness.entry;

    const started = await startHarness(harness);
    expect(fs.readFileSync(installedEntry, 'utf8')).toContain('changed after descriptor verification');
    const invoked = await harness.runtime.invoke(invokeRequest(started.runtimeToken, 'bounded_echo', { text: 'snapshot' }));
    expect(invoked.ok).toBe(true);
    if (invoked.ok && invoked.envelope.payload.kind === 'text') {
      expect(invoked.envelope.payload.content).toContain('snapshot');
    }

    await harness.runtime.stop({
      contractVersion: 1,
      operationId: operationId(),
      sessionId: 'session-one',
      projectId: 'project-one',
      owner: OWNER,
      runtimeToken: started.runtimeToken,
    });
    const snapshotBase = path.join(harness.root, 'runtime-snapshots');
    const remainingRunDirectories = fs.readdirSync(snapshotBase, { recursive: true })
      .filter((entry) => typeof entry === 'string' && entry.includes('runtime-run-'));
    expect(remainingRunDirectories).toEqual([]);
  });

  it('fails closed when a referenced secret is unavailable and never starts a child runtime', async () => {
    const harness = await createHarness('');
    const result = await harness.runtime.start(startRequest(harness.definition));
    expect(result).toMatchObject({ ok: false, code: 'secret_unavailable' });
    expect(harness.runtime.activeRuntimeCount).toBe(0);
    expect(JSON.stringify(result)).not.toContain('${secret:API_TOKEN}');
  });

  it('blocks a tool that attempts to echo its resolved secret and tears down the runtime', async () => {
    const harness = await createHarness();
    const started = await startHarness(harness);
    const result = await harness.runtime.invoke(invokeRequest(started.runtimeToken, 'secret_echo', {}));
    expect(result).toMatchObject({ ok: false, code: 'secret_leak_blocked' });
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
    expect(harness.runtime.activeRuntimeCount).toBe(0);
  });

  it('strictly validates tool input before stdio invocation', async () => {
    const harness = await createHarness();
    const started = await startHarness(harness);
    const result = await harness.runtime.invoke(invokeRequest(started.runtimeToken, 'bounded_echo', {
      text: 'hello',
      extra: 'smuggled',
    }));
    expect(result).toMatchObject({ ok: false, code: 'arguments_rejected' });
    expect(harness.runtime.activeRuntimeCount).toBe(1);
  });

  it('rejects phantom definition tools before launch', async () => {
    const harness = await createHarness();
    const result = await harness.runtime.start(startRequest({
      ...harness.definition,
      exposedTools: [...harness.definition.exposedTools, 'phantom_tool'],
    }));
    expect(result).toMatchObject({ ok: false, code: 'descriptor_rejected' });
    expect(harness.runtime.activeRuntimeCount).toBe(0);
  });

  it('re-handshakes at runtime and disables an installation whose tool list drifted after probe', async () => {
    const harness = await createHarness();
    const drifted = SERVER_SOURCE.replaceAll('bounded_echo', 'drifted_echo');
    fs.writeFileSync(harness.entry, drifted, 'utf8');
    const result = await harness.runtime.start(startRequest(harness.definition));
    expect(result).toMatchObject({ ok: false, code: 'installation_unavailable' });
    expect(harness.runtime.activeRuntimeCount).toBe(0);
  });

  it('rejects descriptor path escape without spawning it', async () => {
    const harness = await createHarness();
    const descriptor = harness.installer.getLaunchDescriptor(harness.installationId)!;
    const outside = path.join(harness.root, 'outside.mjs');
    fs.writeFileSync(outside, SERVER_SOURCE, 'utf8');
    const maliciousInstaller = {
      getLaunchDescriptor(): McpLaunchDescriptor {
        return { ...descriptor, args: [outside] };
      },
    };
    const runtime = new ManagedPersonalizationMcpRuntime(
      maliciousInstaller,
      { resolve: () => SECRET_VALUE },
      new EvidenceEnvelopeService(randomBytes(32)),
    );
    runtimes.push(runtime);
    const result = await runtime.start(startRequest(harness.definition));
    expect(result).toMatchObject({ ok: false, code: 'descriptor_rejected' });
  });

  it('rejects replayed operation IDs', async () => {
    const harness = await createHarness();
    const started = await startHarness(harness);
    const request = invokeRequest(started.runtimeToken, 'bounded_echo', { text: 'once' });
    expect((await harness.runtime.invoke(request)).ok).toBe(true);
    expect(await harness.runtime.invoke(request)).toMatchObject({ ok: false, code: 'replay_rejected' });
  });

  it('rejects cross-owner and generation-swapped capability use', async () => {
    const harness = await createHarness();
    const started = await startHarness(harness);
    const foreignOwner = { ...OWNER, generation: OWNER.generation + 1 };
    const result = await harness.runtime.invoke(invokeRequest(
      started.runtimeToken,
      'bounded_echo',
      { text: 'cross owner' },
      foreignOwner,
    ));
    expect(result).toMatchObject({ ok: false, code: 'binding_mismatch' });
  });

  it('bounds output and tears down a runtime that exceeds the limit', async () => {
    const harness = await createHarness();
    const started = await startHarness(harness);
    const result = await harness.runtime.invoke(invokeRequest(started.runtimeToken, 'large_output', {}));
    expect(result).toMatchObject({ ok: false, code: 'output_too_large' });
    expect(harness.runtime.activeRuntimeCount).toBe(0);
  });

  it('honors timeout and AbortSignal by terminating the child process', async () => {
    const timeoutHarness = await createHarness();
    const timeoutStart = await startHarness(timeoutHarness);
    const timeoutRequest = { ...invokeRequest(timeoutStart.runtimeToken, 'slow_tool', {}), timeoutMs: 100 };
    expect(await timeoutHarness.runtime.invoke(timeoutRequest)).toMatchObject({ ok: false, code: 'timeout' });
    expect(timeoutHarness.runtime.activeRuntimeCount).toBe(0);

    const abortHarness = await createHarness();
    const abortStart = await startHarness(abortHarness);
    const controller = new AbortController();
    const pending = abortHarness.runtime.invoke(invokeRequest(abortStart.runtimeToken, 'slow_tool', {}), controller.signal);
    setTimeout(() => controller.abort(), 20);
    expect(await pending).toMatchObject({ ok: false, code: 'aborted' });
    expect(abortHarness.runtime.activeRuntimeCount).toBe(0);
  });

  it('supports deterministic owner shutdown and explicit stop cleanup', async () => {
    const first = await createHarness();
    const firstStarted = await startHarness(first);
    await first.runtime.shutdownOwner(OWNER);
    expect(first.runtime.activeRuntimeCount).toBe(0);
    expect(await first.runtime.invoke(invokeRequest(firstStarted.runtimeToken, 'bounded_echo', { text: 'late' })))
      .toMatchObject({ ok: false, code: 'runtime_unavailable' });

    const second = await createHarness();
    const secondStarted = await startHarness(second);
    const stopped = await second.runtime.stop({
      contractVersion: 1,
      operationId: operationId(),
      sessionId: 'session-one',
      projectId: 'project-one',
      owner: OWNER,
      runtimeToken: secondStarted.runtimeToken,
    });
    expect(stopped).toMatchObject({ ok: true, stopped: true });
    expect(second.runtime.activeRuntimeCount).toBe(0);

    const third = await createHarness();
    await startHarness(third);
    await third.runtime.shutdownWebContents(OWNER.webContentsId);
    expect(third.runtime.activeRuntimeCount).toBe(0);
  });

  it('prevents concurrent duplicate lifecycles for the same owner/session/definition', async () => {
    const harness = await createHarness();
    const [left, right] = await Promise.all([
      harness.runtime.start(startRequest(harness.definition)),
      harness.runtime.start(startRequest(harness.definition)),
    ]);
    const results = [left, right];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)[0]).toMatchObject({ ok: false, code: 'already_running' });
    expect(harness.runtime.activeRuntimeCount).toBe(1);
    const started = results.find((result) => result.ok);
    expect(started?.ok && started.exposedTools).toEqual(harness.definition.exposedTools);
  });
});
