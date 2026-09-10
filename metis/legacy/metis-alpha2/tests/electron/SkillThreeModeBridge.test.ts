import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonalizationExtensionIpcRequest } from '../../engine/runtime/PersonalizationExtensionContract.js';

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}));

async function loadExtensionBridge() {
  await import('../../electron/preload.js');
  expect(electronMocks.exposeInMainWorld).toHaveBeenCalledTimes(1);
  const api = electronMocks.exposeInMainWorld.mock.calls[0]?.[1] as {
    applyPersonalizationExtension(request: PersonalizationExtensionIpcRequest): Promise<unknown>;
    selectFileCapability(purpose: unknown): Promise<unknown>;
  };
  return api;
}

const invalidResponse = {
  ok: false,
  mode: null,
  code: 'invalid_request',
  detailCode: 'invalid_response',
  compensated: false,
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  electronMocks.invoke.mockResolvedValue(null);
});

describe('Skill three-mode preload boundary', () => {
  it('strictly forwards Markdown, package capability, and GitHub URL requests without renderer evidence fields', async () => {
    const { applyPersonalizationExtension: apply } = await loadExtensionBridge();
    const requests: PersonalizationExtensionIpcRequest[] = [
      {
        contractVersion: 1,
        mode: 'skill_markdown',
        operationId: '11111111-1111-4111-8111-111111111111',
        expectedRevision: 0,
        id: 'user:skills/preload-markdown',
        name: 'Preload Markdown',
        description: 'Strict renderer request.',
        author: 'Local user',
        version: '1.0.0',
        markdown: '# Preload Markdown\n\nUse traceable evidence.',
        toolIds: [],
        mcpIds: [],
        tags: ['bridge'],
        maxTurns: 8,
        inputSchema: null,
        outputSchema: null,
      },
      {
        contractVersion: 1,
        mode: 'skill_package',
        operationId: '22222222-2222-4222-8222-222222222222',
        expectedRevision: 0,
        sourceCapabilityId: `fc_${'a'.repeat(32)}`,
        expectedId: null,
      },
      {
        contractVersion: 1,
        mode: 'skill_url',
        operationId: '33333333-3333-4333-8333-333333333333',
        expectedRevision: 0,
        url: 'https://github.com/metis-test/research-skill',
        expectedArchiveSha256: 'b'.repeat(64),
        expectedId: null,
        expectedVersion: '1.0.0',
      },
    ];

    for (const request of requests) {
      await expect(apply(request)).resolves.toEqual(invalidResponse);
      expect(electronMocks.invoke).toHaveBeenLastCalledWith('personalization:extension:apply', request);
    }
    expect(electronMocks.invoke).toHaveBeenCalledTimes(3);
  });

  it('rejects renderer-supplied evidence and local paths before IPC', async () => {
    const { applyPersonalizationExtension: apply } = await loadExtensionBridge();
    const injected = {
      contractVersion: 1,
      mode: 'skill_package',
      operationId: '44444444-4444-4444-8444-444444444444',
      expectedRevision: 0,
      sourceCapabilityId: `fc_${'b'.repeat(32)}`,
      expectedId: null,
      sourcePath: 'C:\\Users\\victim\\secret-skill',
      evidenceContext: {
        sessionId: 'attacker',
        projectId: 'attacker',
        operationId: '44444444-4444-4444-8444-444444444444',
        runManifestDigest: 'c'.repeat(64),
        observedAt: 1,
      },
    } as unknown as PersonalizationExtensionIpcRequest;
    await expect(apply(injected)).resolves.toEqual(invalidResponse);
    expect(electronMocks.invoke).not.toHaveBeenCalled();
  });

  it('rejects URL Skill create/update identity mismatches before IPC', async () => {
    const { applyPersonalizationExtension: apply } = await loadExtensionBridge();
    const base = {
      contractVersion: 1,
      mode: 'skill_url',
      operationId: '55555555-5555-4555-8555-555555555555',
      url: 'https://github.com/metis-test/research-skill',
      expectedArchiveSha256: null,
      expectedVersion: null,
    } as const;
    await expect(apply({
      ...base,
      expectedRevision: 0,
      expectedId: 'url:skills/existing-target',
    } as PersonalizationExtensionIpcRequest)).resolves.toEqual(invalidResponse);
    await expect(apply({
      ...base,
      expectedRevision: 2,
      expectedId: null,
    } as PersonalizationExtensionIpcRequest)).resolves.toEqual(invalidResponse);
    expect(electronMocks.invoke).not.toHaveBeenCalled();
  });

  it('forwards the strict directory selection purpose and decodes only a folder descriptor', async () => {
    const now = Date.now();
    const response = {
      success: true,
      capability: {
        capabilityId: `fc_${'c'.repeat(32)}`,
        kind: 'folder',
        mime: 'inode/directory',
        displayName: 'research-skill',
        operations: ['folder'],
        issuedAt: now,
        expiresAt: now + 60_000,
      },
    };
    electronMocks.invoke.mockResolvedValueOnce(response);
    const { selectFileCapability } = await loadExtensionBridge();
    await expect(selectFileCapability('personalization-skill-directory')).resolves.toEqual(response);
    expect(electronMocks.invoke).toHaveBeenCalledWith('fileCapability:select', {
      purpose: 'personalization-skill-directory',
    });
  });
});

describe('Skill three-mode main-process source wiring attestation', () => {
  it('binds live-frame evidence and consumes a scoped single-use file capability before the real service', () => {
    const source = fs.readFileSync(path.resolve('electron/main.ts'), 'utf8');
    const handlerStart = source.indexOf("ipcMain.handle('personalization:extension:apply'");
    const handlerEnd = source.indexOf("ipcMain.handle('personalization:mcp:activate'", handlerStart);
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);
    expect(handler).toContain('requireRendererMainFrame(event)');
    expect(handler).toContain('PersonalizationExtensionIpcRequestSchema.safeParse(rawRequest)');
    expect(handler).toContain('bindPersonalizationExtensionRequest(publicRequest.data, event)');
    expect(handler).toContain("'personalization-skill-package'");
    expect(handler).toContain("'personalization-skill-directory'");
    expect(handler).toContain("kind: 'file'");
    expect(handler).toContain("kind: 'folder'");
    expect(handler).toContain('fileCapabilities.consumeMatching(');
    expect(handler).not.toContain('fileCapabilities.consume(');
    expect(handler).not.toContain('rawRequest.sourcePath');
    expect(handler).not.toContain('rawRequest.evidenceContext');
  });

  it('uses openFile/file for ZIP and openDirectory/folder for the distinct directory purpose', () => {
    const source = fs.readFileSync(path.resolve('electron/main.ts'), 'utf8');
    const handlerStart = source.indexOf("ipcMain.handle('fileCapability:select'");
    const handlerEnd = source.indexOf("ipcMain.handle('fileCapability:import'", handlerStart);
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);
    expect(handler).toContain("request.purpose === 'personalization-skill-directory'");
    expect(handler).toContain("{ properties: ['openDirectory'] }");
    expect(handler).toContain("{ properties: ['openFile'], filters }");
    expect(handler).toContain("kind: selectingSkillDirectory ? 'folder' : 'file'");
    expect(handler).toContain("? ['folder']");
    expect(handler).toContain("request.purpose === 'personalization-skill-package'");
    expect(handler).toContain("? ['file']");
  });
});
