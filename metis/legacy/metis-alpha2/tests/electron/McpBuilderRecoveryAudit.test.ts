import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MCPClient } from '../../engine/mcp/MCPClient.js';
import { ExactEnvironmentStdioTransport } from '../../engine/mcp/ExactEnvironmentStdioTransport.js';
import { McpBuilderService, generateMcpBundle } from '../../electron/McpBuilderService.js';
import {
  PersonalizationMcpInstaller,
  type McpControlledProbeRequest,
  type McpControlledProbeRunner,
} from '../../electron/PersonalizationMcpInstaller.js';

const roots: string[] = [];
const INPUT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-mcp-builder-recovery-'));
  roots.push(value);
  return value;
}

function specification() {
  return {
    contractVersion: 1 as const,
    packageId: 'retriable-builder',
    version: '1.0.0',
    name: 'Retriable Builder',
    description: 'Deterministic recovery fixture.',
    environment: [],
    tools: [{
      name: 'echo_text',
      description: 'Echo validated text.',
      inputSchema: INPUT_SCHEMA,
      implementation: { kind: 'echo' as const, argument: 'text' },
    }],
  };
}

function request() {
  return {
    operationId: randomUUID(),
    requirement: 'Build a bounded echo tool.',
    requestedPackageId: 'retriable-builder',
  };
}

class ActualProbe implements McpControlledProbeRunner {
  async probe(input: McpControlledProbeRequest): Promise<unknown> {
    const client = new MCPClient(
      { name: input.installationId, command: [input.command, ...input.args], env: { ...input.fixedEnvironment } },
      new ExactEnvironmentStdioTransport(input.workingDirectory),
    );
    try {
      await client.connect(input.timeoutMs);
      const tools = await client.listTools();
      expect(await client.callTool('echo_text', { text: 'recovered' })).toBe('"recovered"');
      return { ok: true, protocolVersion: '2025-06-18', tools };
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

class CleanupRefusingInstaller extends PersonalizationMcpInstaller {
  override removeUnactivatedInstallation(installationId: string): boolean {
    void installationId;
    return false;
  }
}

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe('MCP Builder failure recovery', () => {
  it('idempotently resumes an exact static installation left before the transaction journal', async () => {
    const installationRoot = root();
    const first = new McpBuilderService(
      new PersonalizationMcpInstaller(installationRoot),
      { createSpecification: async () => specification() },
    );
    const prepared = await first.build(request());
    expect(prepared).toMatchObject({ ok: true, outcome: 'pending_probe', record: { state: 'static_verified' } });
    if (!prepared.ok) throw new Error(prepared.code);

    const restartedInstaller = new PersonalizationMcpInstaller(installationRoot);
    const restarted = new McpBuilderService(
      restartedInstaller,
      { createSpecification: async () => specification() },
    );
    const resumed = await restarted.build(request());
    expect(resumed).toMatchObject({
      ok: true,
      outcome: 'pending_probe',
      record: { installationId: prepared.record.installationId, state: 'static_verified', enabled: false },
    });
  });

  it('removes a probe-failed installation so the same generated package can be retried and truly enabled', async () => {
    const installationRoot = root();
    const firstInstaller = new PersonalizationMcpInstaller(installationRoot);
    const firstBuilder = new McpBuilderService(firstInstaller, { createSpecification: async () => specification() });
    const failed = await firstBuilder.build(request(), {
      probe: async () => ({
        ok: true,
        protocolVersion: '2025-06-18',
        tools: [{
          name: 'phantom_tool',
          description: 'Must not match the generated manifest.',
          inputSchema: INPUT_SCHEMA,
        }],
      }),
    });
    expect(failed).toMatchObject({ ok: false, code: 'probe_failed' });

    const restartedInstaller = new PersonalizationMcpInstaller(installationRoot);
    const restartedBuilder = new McpBuilderService(
      restartedInstaller,
      { createSpecification: async () => specification() },
    );
    const retried = await restartedBuilder.build(request(), new ActualProbe());
    expect(retried).toMatchObject({
      ok: true,
      outcome: 'enabled',
      record: { enabled: true, state: 'enabled', exposedTools: ['echo_text'] },
    });
    if (!retried.ok) throw new Error(`Retry remained blocked: ${retried.code}`);
    expect(restartedInstaller.getLaunchDescriptor(retried.record.installationId)).not.toBeNull();
    expect(restartedInstaller.removeUnactivatedInstallation(retried.record.installationId)).toBe(false);
    expect(restartedInstaller.readInstalledRecord(retried.record.installationId)).toMatchObject({
      enabled: true,
      state: 'enabled',
    });
    const duplicateEnabled = new McpBuilderService(
      new PersonalizationMcpInstaller(installationRoot),
      { createSpecification: async () => specification() },
    );
    await expect(duplicateEnabled.build(request())).resolves.toMatchObject({
      ok: false,
      code: 'installation_failed',
    });
  });

  it('reports cleanup_failed instead of hiding a failed installation it could not remove', async () => {
    const installer = new CleanupRefusingInstaller(root());
    const builder = new McpBuilderService(installer, { createSpecification: async () => specification() });
    await expect(builder.build(request(), {
      probe: async () => ({ ok: false, code: 'controlled_probe_failure' }),
    })).resolves.toMatchObject({ ok: false, code: 'cleanup_failed' });
  });

  it('emits the DNS-pinned IPv6 SSRF guard into every generated HTTP server', () => {
    const base = specification();
    const httpSpecification = {
      ...base,
      tools: [{
        ...base.tools[0]!,
        implementation: {
          kind: 'http_json' as const,
          baseUrl: 'https://api.example.org',
          routeTemplate: '/lookup/{text}',
          method: 'GET' as const,
          bearerSecretEnv: null,
        },
      }],
    };
    const source = Buffer.from(generateMcpBundle(httpSpecification).files[0]!.body).toString('utf8');
    expect(source).toContain('const BLOCKED_IPV6 = new net.BlockList()');
    expect(source).toContain("['fec0::', 10]");
    expect(source).toContain("['ff00::', 8]");
    expect(source).toContain("['2001:db8::', 32]");
    expect(source).toContain('resolved.some((item) => privateAddress(item.address))');
    expect(source).toContain('callback(null, chosen.address, chosen.family)');
  });
});
