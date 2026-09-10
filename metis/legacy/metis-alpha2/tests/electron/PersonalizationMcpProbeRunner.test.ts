import fs from 'node:fs';

import path from 'node:path';
import { realTempRoot } from './helpers/realTempDir.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MCPServerConfig, MCPTool } from '../../engine/mcp/protocol.js';
import {
  PersonalizationMcpProbeRunner,
  type PersonalizationMcpProbeClient,
  type TrustedMcpControlledProbeRequest,
} from '../../electron/PersonalizationMcpProbeRunner.js';

const roots: string[] = [];
const PARENT_SENTINEL_NAME = 'METIS_PROBE_PARENT_SECRET';
const PARENT_SENTINEL_VALUE = 'parent-secret-must-not-cross';
const RESOLVED_SECRET = 'resolved-probe-secret-46f23b';
const TOOL: MCPTool = {
  name: 'bounded_echo',
  description: 'Return one bounded probe value.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
};

function temporaryServer(): { root: string; entry: string; callMarker: string } {
  const root = fs.mkdtempSync(path.join(realTempRoot(), 'metis-mcp-probe-runner-'));
  roots.push(root);
  const entry = path.join(root, 'server.mjs');
  const callMarker = path.join(root, 'sample-call.json');
  fs.writeFileSync(entry, `
import fs from 'node:fs';
import readline from 'node:readline';
const callMarker = process.argv[2];
const input = readline.createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'probe-fixture', version: '1.0.0' }
    } });
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: [{
      name: 'bounded_echo',
      description: JSON.stringify({
        environmentNames: Object.keys(process.env).sort(),
        secretAvailable: process.env.PROBE_TOKEN === ${JSON.stringify(RESOLVED_SECRET)}
      }),
      inputSchema: {
        type: 'object', properties: { text: { type: 'string' } },
        required: ['text'], additionalProperties: false
      }
    }] } });
  } else if (message.method === 'tools/call') {
    fs.writeFileSync(callMarker, JSON.stringify(message.params), 'utf8');
    send({ jsonrpc: '2.0', id: message.id, result: {
      content: [{ type: 'text', text: process.env.PROBE_TOKEN || 'missing' }], isError: false
    } });
  }
});
`, 'utf8');
  return { root, entry, callMarker };
}

function probeRequest(
  fixture: ReturnType<typeof temporaryServer>,
  overrides: Partial<TrustedMcpControlledProbeRequest> = {},
): TrustedMcpControlledProbeRequest {
  return {
    installationId: 'mcp_0123456789abcdef0123456789abcdef',
    command: process.execPath,
    args: [fixture.entry, fixture.callMarker],
    workingDirectory: fixture.root,
    secretRefs: { PROBE_TOKEN: '${secret:PROBE_TOKEN}' },
    timeoutMs: 3_000,
    shell: false,
    inheritParentEnvironment: false,
    fixedEnvironment: {},
    ...overrides,
  };
}

function fakeClient(overrides: Partial<PersonalizationMcpProbeClient> = {}): PersonalizationMcpProbeClient {
  return {
    protocolVersion: '2025-06-18',
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => [TOOL]),
    callTool: vi.fn(async () => 'ok'),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env[PARENT_SENTINEL_NAME];
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('PersonalizationMcpProbeRunner', () => {
  it('performs a real handshake and tools/list in an exact environment without blindly calling a tool', async () => {
    const fixture = temporaryServer();
    process.env[PARENT_SENTINEL_NAME] = PARENT_SENTINEL_VALUE;
    const resolve = vi.fn((secretRef: string) => secretRef === '${secret:PROBE_TOKEN}' ? RESOLVED_SECRET : undefined);
    const runner = new PersonalizationMcpProbeRunner({ resolve });

    const result = await runner.probe(probeRequest(fixture));

    expect(result).toMatchObject({ ok: true, protocolVersion: '2025-06-18' });
    if (!result.ok) throw new Error(`Probe failed: ${result.code}`);
    expect(result.tools).toHaveLength(1);
    const observed = JSON.parse(result.tools[0]!.description) as {
      environmentNames: string[];
      secretAvailable: boolean;
    };
    expect(observed.secretAvailable).toBe(true);
    expect(observed.environmentNames).toContain('PROBE_TOKEN');
    expect(observed.environmentNames).not.toContain(PARENT_SENTINEL_NAME);
    expect(JSON.stringify(result)).not.toContain(RESOLVED_SECRET);
    expect(fs.existsSync(fixture.callMarker)).toBe(false);
    expect(resolve).toHaveBeenCalledWith('${secret:PROBE_TOKEN}', {
      installationId: 'mcp_0123456789abcdef0123456789abcdef',
      environmentName: 'PROBE_TOKEN',
    });
  });

  it('executes exactly one explicitly trusted sample call and never returns its secret-bearing output', async () => {
    const fixture = temporaryServer();
    const runner = new PersonalizationMcpProbeRunner({ resolve: () => RESOLVED_SECRET });

    const result = await runner.probe(probeRequest(fixture, {
      sampleCall: { toolName: 'bounded_echo', arguments: { text: 'metis-controlled-probe' } },
    }));

    expect(result).toMatchObject({ ok: true, protocolVersion: '2025-06-18' });
    expect(JSON.stringify(result)).not.toContain(RESOLVED_SECRET);
    expect(JSON.parse(fs.readFileSync(fixture.callMarker, 'utf8'))).toEqual({
      name: 'bounded_echo',
      arguments: { text: 'metis-controlled-probe' },
    });
  });

  it('refuses a sample call unless the listed tool and its schema validate the trusted arguments', async () => {
    const fixture = temporaryServer();
    const client = fakeClient();
    const runner = new PersonalizationMcpProbeRunner(
      { resolve: () => RESOLVED_SECRET },
      { clientFactory: () => client },
    );

    await expect(runner.probe(probeRequest(fixture, {
      sampleCall: { toolName: 'undeclared_tool', arguments: {} },
    }))).resolves.toEqual({ ok: false, code: 'probe_sample_tool_unavailable' });
    expect(client.callTool).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();

    const second = fakeClient();
    const invalidArgumentsRunner = new PersonalizationMcpProbeRunner(
      { resolve: () => RESOLVED_SECRET },
      { clientFactory: () => second },
    );
    await expect(invalidArgumentsRunner.probe(probeRequest(fixture, {
      sampleCall: { toolName: 'bounded_echo', arguments: { text: 42 } },
    }))).resolves.toEqual({ ok: false, code: 'probe_sample_arguments_rejected' });
    expect(second.callTool).not.toHaveBeenCalled();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('enforces one total timeout across handshake, listing and sample call, then closes the client', async () => {
    const fixture = temporaryServer();
    const client = fakeClient({ listTools: vi.fn(() => new Promise<MCPTool[]>(() => {})) });
    const runner = new PersonalizationMcpProbeRunner(
      { resolve: () => RESOLVED_SECRET },
      { clientFactory: () => client },
    );

    const startedAt = Date.now();
    const result = await runner.probe(probeRequest(fixture, { timeoutMs: 25 }));

    expect(result).toEqual({ ok: false, code: 'probe_timeout' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('does not launch a process if secret resolution finishes after the total deadline', async () => {
    const fixture = temporaryServer();
    let releaseSecret: ((value: string) => void) | undefined;
    const delayedSecret = new Promise<string>((resolve) => { releaseSecret = resolve; });
    const clientFactory = vi.fn(() => fakeClient());
    const runner = new PersonalizationMcpProbeRunner(
      { resolve: () => delayedSecret },
      { clientFactory },
    );

    const result = await runner.probe(probeRequest(fixture, { timeoutMs: 25 }));
    expect(result).toEqual({ ok: false, code: 'probe_timeout' });

    releaseSecret?.(RESOLVED_SECRET);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('closes on phase failure, returns only fixed codes, and clears retained environment values', async () => {
    const fixture = temporaryServer();
    let capturedEnvironment: Record<string, string> | undefined;
    const client = fakeClient({ callTool: vi.fn(async () => { throw new Error(`remote echoed ${RESOLVED_SECRET}`); }) });
    const runner = new PersonalizationMcpProbeRunner(
      { resolve: () => RESOLVED_SECRET },
      {
        clientFactory: (config: MCPServerConfig) => {
          capturedEnvironment = config.env;
          return client;
        },
      },
    );

    const result = await runner.probe(probeRequest(fixture, {
      sampleCall: { toolName: 'bounded_echo', arguments: { text: 'safe' } },
    }));

    expect(result).toEqual({ ok: false, code: 'probe_sample_failed' });
    expect(JSON.stringify(result)).not.toContain(RESOLVED_SECRET);
    expect(client.close).toHaveBeenCalledOnce();
    expect(capturedEnvironment).toEqual({});
  });

  it('fails closed when cleanup fails or the request attempts runtime environment injection', async () => {
    const fixture = temporaryServer();
    const closeFailure = fakeClient({ close: vi.fn(async () => { throw new Error('close failed'); }) });
    const first = new PersonalizationMcpProbeRunner(
      { resolve: () => RESOLVED_SECRET },
      { clientFactory: () => closeFailure },
    );
    await expect(first.probe(probeRequest(fixture))).resolves.toEqual({
      ok: false,
      code: 'probe_cleanup_failed',
    });

    const factory = vi.fn(() => fakeClient());
    const second = new PersonalizationMcpProbeRunner(
      { resolve: () => RESOLVED_SECRET },
      { clientFactory: factory },
    );
    await expect(second.probe(probeRequest(fixture, {
      fixedEnvironment: { NODE_OPTIONS: '--require=attacker.js' },
    }))).resolves.toEqual({ ok: false, code: 'probe_request_rejected' });
    await expect(second.probe({ shell: false } as TrustedMcpControlledProbeRequest)).resolves.toEqual({
      ok: false,
      code: 'probe_request_rejected',
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it('closes after handshake failure and rejects an unrecognized negotiated protocol', async () => {
    const fixture = temporaryServer();
    const handshakeFailure = fakeClient({
      connect: vi.fn(async () => { throw new Error(`handshake exposed ${RESOLVED_SECRET}`); }),
    });
    const first = new PersonalizationMcpProbeRunner(
      { resolve: () => RESOLVED_SECRET },
      { clientFactory: () => handshakeFailure },
    );
    const firstResult = await first.probe(probeRequest(fixture));
    expect(firstResult).toEqual({ ok: false, code: 'probe_handshake_failed' });
    expect(JSON.stringify(firstResult)).not.toContain(RESOLVED_SECRET);
    expect(handshakeFailure.close).toHaveBeenCalledOnce();

    const unsupportedProtocol = fakeClient({ protocolVersion: '2099-01-01' });
    const second = new PersonalizationMcpProbeRunner(
      { resolve: () => RESOLVED_SECRET },
      { clientFactory: () => unsupportedProtocol },
    );
    await expect(second.probe(probeRequest(fixture))).resolves.toEqual({
      ok: false,
      code: 'probe_protocol_rejected',
    });
    expect(unsupportedProtocol.listTools).not.toHaveBeenCalled();
    expect(unsupportedProtocol.close).toHaveBeenCalledOnce();
  });
});
