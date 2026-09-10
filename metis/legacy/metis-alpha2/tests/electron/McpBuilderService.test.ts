import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPClient } from '../../engine/mcp/MCPClient.js';
import { ExactEnvironmentStdioTransport } from '../../engine/mcp/ExactEnvironmentStdioTransport.js';
import { McpBuilderService, generateMcpBundle } from '../../electron/McpBuilderService.js';
import {
  PersonalizationMcpInstaller,
  type McpControlledProbeRequest,
  type McpControlledProbeRunner,
  type McpNetworkClient,
} from '../../electron/PersonalizationMcpInstaller.js';

const temporaryRoots: string[] = [];
const INPUT_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
  additionalProperties: false,
};

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-mcp-builder-'));
  temporaryRoots.push(root);
  return root;
}

const unusedNetwork: McpNetworkClient = {
  download: async () => { throw new Error('Builder must not download remote code'); },
};

function specification() {
  return {
    contractVersion: 1 as const,
    packageId: 'generated-search',
    version: '1.0.0',
    name: 'Generated Search',
    description: 'A deterministic generated MCP.',
    environment: [],
    tools: [{
      name: 'search',
      description: 'Echo a search query.',
      inputSchema: INPUT_SCHEMA,
      implementation: { kind: 'echo' as const, argument: 'query' },
    }],
  };
}

function request() {
  return {
    operationId: randomUUID(),
    requirement: 'Create a search MCP that echoes a validated query for the first iteration.',
    requestedPackageId: 'generated-search',
  };
}

class RealGeneratedServerProbe implements McpControlledProbeRunner {
  async probe(probeRequest: McpControlledProbeRequest): Promise<unknown> {
    expect(probeRequest.shell).toBe(false);
    const client = new MCPClient(
      { name: 'generated-probe', command: [probeRequest.command, ...probeRequest.args], env: { ...probeRequest.fixedEnvironment } },
      new ExactEnvironmentStdioTransport(probeRequest.workingDirectory),
    );
    try {
      await client.connect(probeRequest.timeoutMs);
      const tools = await client.listTools();
      const probeOutput = await client.callTool('search', { query: 'controlled-probe' });
      expect(probeOutput).toBe('"controlled-probe"');
      return { ok: true, protocolVersion: '2025-06-18', tools };
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('McpBuilderService', () => {
  it('calls the injected Provider and leaves generated code disabled without a controlled probe', async () => {
    const createSpecification = vi.fn(async () => specification());
    const installer = new PersonalizationMcpInstaller(temporaryRoot(), { network: unusedNetwork, now: () => 10 });
    const service = new McpBuilderService(installer, { createSpecification });
    const input = request();
    const result = await service.build(input);
    expect(createSpecification).toHaveBeenCalledWith({
      requirement: input.requirement,
      requestedPackageId: 'generated-search',
      contractVersion: 1,
    });
    expect(result).toMatchObject({
      ok: true,
      outcome: 'pending_probe',
      record: { state: 'static_verified', enabled: false },
    });
    if (result.ok) expect(installer.getLaunchDescriptor(result.record.installationId)).toBeNull();
  });

  it('runs the deterministic generated server through a real stdio MCP probe before enabling', async () => {
    const installer = new PersonalizationMcpInstaller(temporaryRoot(), { network: unusedNetwork });
    const service = new McpBuilderService(installer, { createSpecification: async () => specification() });
    const result = await service.build(request(), new RealGeneratedServerProbe());
    expect(result).toMatchObject({
      ok: true,
      outcome: 'enabled',
      record: { state: 'enabled', enabled: true, exposedTools: ['search'] },
    });
    if (result.ok) expect(installer.getLaunchDescriptor(result.record.installationId)?.shell).toBe(false);
  });

  it('fails closed when the provider fails or authors fields outside the DSL', async () => {
    const first = new McpBuilderService(
      new PersonalizationMcpInstaller(temporaryRoot(), { network: unusedNetwork }),
      { createSpecification: async () => { throw new Error('provider unavailable'); } },
    );
    await expect(first.build(request())).resolves.toMatchObject({ ok: false, code: 'provider_failed' });

    const second = new McpBuilderService(
      new PersonalizationMcpInstaller(temporaryRoot(), { network: unusedNetwork }),
      { createSpecification: async () => ({ ...specification(), sourceCode: 'process.exit(0)' }) },
    );
    await expect(second.build(request())).resolves.toMatchObject({ ok: false, code: 'spec_invalid' });
  });

  it('rejects package identity substitution and unsupported tool schemas', async () => {
    const substituted = new McpBuilderService(
      new PersonalizationMcpInstaller(temporaryRoot(), { network: unusedNetwork }),
      { createSpecification: async () => ({ ...specification(), packageId: 'attacker-package' }) },
    );
    await expect(substituted.build(request())).resolves.toMatchObject({ ok: false, code: 'package_id_mismatch' });

    const unsupportedSpec = specification();
    unsupportedSpec.tools[0]!.inputSchema = {
      ...INPUT_SCHEMA,
      oneOf: [{ type: 'object' }],
    } as typeof INPUT_SCHEMA;
    const unsupported = new McpBuilderService(
      new PersonalizationMcpInstaller(temporaryRoot(), { network: unusedNetwork }),
      { createSpecification: async () => unsupportedSpec },
    );
    await expect(unsupported.build(request())).resolves.toMatchObject({ ok: false, code: 'schema_unsupported' });
  });

  it('does not enable when the probe invents a phantom tool', async () => {
    const installer = new PersonalizationMcpInstaller(temporaryRoot(), { network: unusedNetwork });
    const service = new McpBuilderService(installer, { createSpecification: async () => specification() });
    const result = await service.build(request(), {
      probe: async () => ({
        ok: true,
        protocolVersion: '2025-06-18',
        tools: [
          { name: 'search', description: 'Echo a search query.', inputSchema: INPUT_SCHEMA },
          { name: 'delete_everything', description: 'Phantom tool.', inputSchema: INPUT_SCHEMA },
        ],
      }),
    });
    expect(result).toMatchObject({ ok: false, code: 'probe_failed' });
  });

  it('generates code only from serialized DSL values and never embeds literal secret values', () => {
    const spec = specification();
    spec.environment.push({
      name: 'SEARCH_TOKEN',
      secretRef: '${secret:SEARCH_TOKEN}',
      required: true,
      description: 'Token resolved only by the trusted runtime.',
    });
    const bundle = generateMcpBundle(spec);
    const source = Buffer.from(bundle.files[0]!.body).toString('utf8');
    expect(source).toContain("import readline from 'node:readline'");
    expect(source).not.toContain('super-secret-value');
    expect(source).not.toMatch(/child_process|shell\s*:\s*true|\beval\s*\(/u);
    expect(bundle.manifest.environment[0]?.secretRef).toBe('${secret:SEARCH_TOKEN}');
  });
});
