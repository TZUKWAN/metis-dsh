import { describe, expect, it } from 'vitest';
import {
  McpActivationIpcRequestSchema,
  McpActivationRequestSchema,
  decodeMcpActivationResponse,
} from '../../engine/runtime/McpActivationContract.js';

const OWNER = { webContentsId: 7, processId: 8, routingId: 0, generation: 2 };

function request() {
  return {
    contractVersion: 1 as const,
    definitionId: 'url:mcp/verified-search',
    installationId: 'mcp_0123456789abcdef0123456789abcdef',
    expectedRevision: 1,
    evidenceContext: {
      sessionId: 'session-activation',
      projectId: 'project-activation',
      operationId: '00000000-0000-4000-8000-000000000111',
      runManifestDigest: 'a'.repeat(64),
      observedAt: 1_000,
      owner: OWNER,
    },
  };
}

describe('McpActivationContract', () => {
  it('accepts an exact owner-blind renderer request and rejects authority injection', () => {
    const rendererRequest = {
      contractVersion: 1 as const,
      operationId: '00000000-0000-4000-8000-000000000112',
      definitionId: 'url:mcp/verified-search',
      installationId: 'mcp_0123456789abcdef0123456789abcdef',
      expectedRevision: 1,
    };
    expect(McpActivationIpcRequestSchema.safeParse(rendererRequest).success).toBe(true);
    expect(McpActivationIpcRequestSchema.safeParse({
      ...rendererRequest,
      definitionId: 'generated:mcp/builder-output',
    }).success).toBe(false);
    for (const injected of [
      { owner: OWNER },
      { evidenceContext: request().evidenceContext },
      { sampleCall: { toolName: 'delete_all', arguments: {} } },
      { environment: { SECRET: 'renderer-controlled' } },
      { command: 'powershell.exe' },
    ]) {
      expect(McpActivationIpcRequestSchema.safeParse({ ...rendererRequest, ...injected }).success).toBe(false);
    }
    expect(Object.keys(McpActivationIpcRequestSchema.parse(rendererRequest)).sort()).toEqual([
      'contractVersion', 'definitionId', 'expectedRevision', 'installationId', 'operationId',
    ]);
  });

  it('accepts only an owner-bound URL or generated MCP activation request', () => {
    expect(McpActivationRequestSchema.safeParse(request()).success).toBe(true);
    expect(McpActivationRequestSchema.safeParse({ ...request(), sampleCall: { toolName: 'delete_all', arguments: {} } }).success)
      .toBe(false);
    const missingOwner = request();
    expect(McpActivationRequestSchema.safeParse({
      ...missingOwner,
      evidenceContext: { ...missingOwner.evidenceContext, owner: undefined },
    }).success).toBe(false);
    expect(McpActivationRequestSchema.safeParse({ ...request(), definitionId: 'generated:mcp/builder-output' }).success).toBe(true);
    expect(McpActivationRequestSchema.safeParse({ ...request(), definitionId: 'user:mcps/not-activatable' }).success).toBe(false);
    expect(McpActivationRequestSchema.safeParse({ ...request(), definitionId: 'builtin:mcps/not-activatable' }).success).toBe(false);
  });

  it('decodes malformed or truth-forging responses to a fixed failure', () => {
    const fixedFailure = {
      ok: false,
      contractVersion: 1,
      operationId: '00000000-0000-4000-8000-000000000000',
      code: 'invalid_response',
      compensated: false,
      recoveryPending: false,
    } as const;
    const attacks = [
      { ok: true, truth: { state: 'verified' } },
      { ok: false, contractVersion: 1, operationId: request().evidenceContext.operationId, code: 'probe_failed', compensated: false, recoveryPending: false, secret: 'reflect-me' },
      { ok: false, contractVersion: 1, operationId: request().evidenceContext.operationId, code: 'attacker_chosen', compensated: false, recoveryPending: false },
      new Error('C:\\private\\secret-token.txt'),
    ];
    for (const attack of attacks) {
      expect(decodeMcpActivationResponse(attack)).toEqual(fixedFailure);
      expect(JSON.stringify(decodeMcpActivationResponse(attack))).not.toMatch(/reflect-me|private|secret-token/iu);
    }
  });
});
