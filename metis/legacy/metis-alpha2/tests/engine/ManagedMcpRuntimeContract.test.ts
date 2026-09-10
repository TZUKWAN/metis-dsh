import { describe, expect, it } from 'vitest';
import {
  ManagedMcpDefinitionSchema,
  ManagedMcpInvokeRequestSchema,
  ManagedMcpStartResponseSchema,
  ManagedMcpStopRequestSchema,
  decodeManagedMcpInvokeRequest,
  decodeManagedMcpStartRequest,
  decodeManagedMcpStopRequest,
} from '../../engine/runtime/ManagedMcpRuntimeContract.js';

const INSTALLATION_ID = `mcp_${'a'.repeat(32)}`;
const OPERATION_ID = '00000000-0000-4000-8000-000000000001';
const OWNER = { webContentsId: 7, processId: 8, routingId: 0, generation: 3 };

function definition() {
  return {
    contractVersion: 1 as const,
    id: 'generated:mcp/bounded-echo',
    name: 'Bounded echo',
    description: 'A managed MCP definition.',
    enabled: true,
    tags: [],
    revision: 1,
    provenance: {
      origin: 'generated' as const,
      author: 'Metis MCP Builder',
      version: '1.0.0',
      license: null,
      sourceUrl: null,
      sourceRevision: null,
      installedDigest: 'b'.repeat(64),
      parentId: null,
      parentVersion: null,
      locallyModified: false,
      createdAt: 100,
      updatedAt: 100,
    },
    kind: 'mcp' as const,
    sourceMode: 'generated' as const,
    transport: 'stdio' as const,
    command: 'metis-managed-mcp',
    args: [INSTALLATION_ID],
    environment: {
      API_TOKEN: { secret: true, value: null },
    },
    sourceUrl: null,
    exposedTools: ['bounded_echo'],
    workingDirectoryToken: INSTALLATION_ID,
  };
}

function startRequest() {
  return {
    contractVersion: 1 as const,
    operationId: OPERATION_ID,
    sessionId: 'session-one',
    projectId: 'project-one',
    owner: OWNER,
    definition: definition(),
  };
}

function invokeRequest() {
  return {
    contractVersion: 1 as const,
    operationId: '00000000-0000-4000-8000-000000000002',
    sessionId: 'session-one',
    projectId: 'project-one',
    owner: OWNER,
    runtimeToken: `mmcp_${'c'.repeat(64)}`,
    toolName: 'bounded_echo',
    arguments: { text: 'hello' },
    runManifestDigest: 'd'.repeat(64),
    timeoutMs: 5_000,
  };
}

describe('ManagedMcpRuntimeContract', () => {
  it('accepts the exact main-managed definition and owner binding', () => {
    expect(ManagedMcpDefinitionSchema.safeParse(definition()).success).toBe(true);
    expect(decodeManagedMcpStartRequest(startRequest())).toBeDefined();
  });

  it.each([
    ['disabled', { enabled: false }],
    ['renderer command', { command: 'node' }],
    ['missing installation token', { args: [] }],
    ['extra launch argument', { args: [INSTALLATION_ID, '--unsafe'] }],
    ['path-shaped token', { args: ['../../server.mjs'], workingDirectoryToken: '../../server.mjs' }],
    ['working-directory mismatch', { workingDirectoryToken: `mcp_${'e'.repeat(32)}` }],
    ['phantom tools', { exposedTools: [] }],
  ])('rejects %s', (_label, mutation) => {
    expect(ManagedMcpDefinitionSchema.safeParse({ ...definition(), ...mutation }).success).toBe(false);
  });

  it('rejects plaintext or non-secret environment bindings', () => {
    expect(ManagedMcpDefinitionSchema.safeParse({
      ...definition(),
      environment: { API_TOKEN: { secret: true, value: 'plaintext' } },
    }).success).toBe(false);
    expect(ManagedMcpDefinitionSchema.safeParse({
      ...definition(),
      environment: { API_TOKEN: { secret: false, value: null } },
    }).success).toBe(false);
  });

  it('rejects extra truth and permission smuggling fields', () => {
    expect(decodeManagedMcpStartRequest({ ...startRequest(), verified: true })).toBeUndefined();
    expect(decodeManagedMcpStartRequest({
      ...startRequest(),
      definition: { ...definition(), clean: true },
    })).toBeUndefined();
  });

  it('requires the complete positive owner tuple', () => {
    expect(decodeManagedMcpStartRequest({
      ...startRequest(),
      owner: { webContentsId: 0, processId: 8, routingId: 0, generation: 3 },
    })).toBeUndefined();
    const incompleteOwner = {
      webContentsId: OWNER.webContentsId,
      processId: OWNER.processId,
      routingId: OWNER.routingId,
    };
    expect(decodeManagedMcpStartRequest({ ...startRequest(), owner: incompleteOwner })).toBeUndefined();
  });

  it('strictly decodes invoke input and bounds runtime tokens and timeouts', () => {
    expect(decodeManagedMcpInvokeRequest(invokeRequest())).toBeDefined();
    expect(decodeManagedMcpInvokeRequest({ ...invokeRequest(), runtimeToken: 'not-a-token' })).toBeUndefined();
    expect(decodeManagedMcpInvokeRequest({ ...invokeRequest(), timeoutMs: 60_001 })).toBeUndefined();
    expect(decodeManagedMcpInvokeRequest({ ...invokeRequest(), publishEligible: true })).toBeUndefined();
  });

  it('strictly decodes stop input', () => {
    const request = {
      contractVersion: 1,
      operationId: '00000000-0000-4000-8000-000000000003',
      sessionId: 'session-one',
      projectId: 'project-one',
      owner: OWNER,
      runtimeToken: `mmcp_${'c'.repeat(64)}`,
    };
    expect(decodeManagedMcpStopRequest(request)).toBeDefined();
    expect(decodeManagedMcpStopRequest({ ...request, force: true })).toBeUndefined();
    expect(ManagedMcpStopRequestSchema.safeParse({ ...request, projectId: '../other' }).success).toBe(false);
  });

  it('exposes only a capability token and tool names after start', () => {
    const parsed = ManagedMcpStartResponseSchema.parse({
      ok: true,
      contractVersion: 1,
      operationId: OPERATION_ID,
      runtimeToken: `mmcp_${'f'.repeat(64)}`,
      exposedTools: ['bounded_echo'],
      startedAt: 101,
    });
    expect(parsed).not.toHaveProperty('command');
    expect(parsed).not.toHaveProperty('workingDirectory');
    expect(parsed).not.toHaveProperty('environment');
  });

  it('rejects arrays at the arguments object boundary', () => {
    expect(ManagedMcpInvokeRequestSchema.safeParse({ ...invokeRequest(), arguments: [] }).success).toBe(false);
  });
});
