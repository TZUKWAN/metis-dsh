import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CurrentAffairsResearchRequest,
  CurrentAffairsApproveRequest,
  CurrentAffairsExportRequest,
  CurrentAffairsCancelRequest,
  CurrentAffairsListSourcesRequest,
  SourceReviewRequest,
} from '../../engine/runtime/CurrentAffairsRuntimeContract.js';
import type {
  PersonalizationDeleteRequest,
  PersonalizationForkRequest,
  PersonalizationGetRequest,
  PersonalizationListRequest,
  PersonalizationTrashListRequest,
  PersonalizationResolveRequest,
  PersonalizationRestoreRequest,
  PersonalizationTrashRestoreRequest,
  PersonalizationVersionsRequest,
  PersonalizationSaveRequest,
} from '../../engine/runtime/PersonalizationRuntimeContract.js';
import type { AgentControlRequest } from '../../engine/runtime/LiveSteeringContract.js';
import type { PersonalizationExtensionIpcRequest } from '../../engine/runtime/PersonalizationExtensionContract.js';
import type {
  PersonalizationBundleExportIpcRequest,
  PersonalizationBundleImportIpcRequest,
} from '../../engine/runtime/PersonalizationBundleContract.js';
import type {
  PersonalizationSecretListRequest,
  PersonalizationSecretRemoveRequest,
  PersonalizationSecretSetRequest,
} from '../../engine/runtime/PersonalizationSecretContract.js';
import type { FundingTemplateIpcRequest } from '../../engine/runtime/FundingTemplateRuntimeContract.js';
import type { McpActivationIpcRequest } from '../../engine/runtime/McpActivationContract.js';
import type {
  ProviderProfileListRequest,
  ProviderProfileSaveRequest,
} from '../../engine/runtime/ProviderProfileContract.js';

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: electronMocks.exposeInMainWorld,
  },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}));

async function loadExposedAPI() {
  await import('../../electron/preload.js');
  expect(electronMocks.exposeInMainWorld).toHaveBeenCalledTimes(1);
  const [, api] = electronMocks.exposeInMainWorld.mock.calls[0];
  return api as {
    acceptanceEnvironment(): Promise<unknown>;
    acceptanceSetWindowSize(request: {
      mode: 'outer' | 'content';
      width: number;
      height: number;
    }): Promise<unknown>;
    acceptanceReleaseWindowControl(): Promise<unknown>;
    runtimeIdentity(): Promise<unknown>;
    openExternal(url: string): Promise<{ success: boolean; error?: string }>;
    createSession(sessionId: string): Promise<unknown>;
    listSessions(): Promise<unknown>;
    deleteSession(sessionId: string): Promise<unknown>;
    updateSession(sessionId: string, patch: { title?: string; archived?: boolean }): Promise<unknown>;
    getMessages(sessionId: string): Promise<unknown>;
    appendMessage(sessionId: string, role: string, content: string): Promise<number>;
    createArtifact(record: Record<string, unknown>): Promise<unknown>;
    listArtifacts(sessionId: string): Promise<unknown>;
    getArtifactContent(sessionId: string, artifactId: string): Promise<unknown>;
    deleteArtifact(id: string): Promise<unknown>;
    onArtifactCreated(callback: (event: unknown) => void): () => void;
    agentChat(
      sessionId: string,
      messages: unknown[],
      skillId: string | undefined,
      options: { mode: 'send' | 'regenerate'; turnId?: string },
    ): Promise<unknown>;
    onChatStreamChunk(callback: (payload: import('../../engine/runtime/ChatRuntimeContract.js').ChatStreamChunkEvent) => void): () => void;
    onAgentExecutionEvent(callback: (payload: import('../../engine/runtime/ChatRuntimeContract.js').AgentExecutionEvent) => void): () => void;
    replayAgentEvents(request: import('../../engine/runtime/ChatRuntimeContract.js').AgentEventReplayRequest): Promise<unknown>;
    agentControl(request: AgentControlRequest): Promise<unknown>;
    executeGoal(goalId: string): Promise<unknown>;
    createGoal(description: string, context?: string): Promise<unknown>;
    generatePlan(goalId: string): Promise<unknown>;
    listGoals(): Promise<unknown>;
    onGoalStepStart(callback: (event: unknown) => void): () => void;
    researchMediaAttach(request: import('../../engine/runtime/ResearchMediaRuntimeContract.js').ResearchMediaAttachRequest): Promise<unknown>;
    researchMediaPurge(request: import('../../engine/runtime/ResearchMediaRuntimeContract.js').ResearchMediaPurgeRequest): Promise<unknown>;
    useFileCapability(request: import('../../engine/runtime/FileCapabilityContract.js').FileCapabilityUseRequest): Promise<unknown>;
    downloadPaperPdf(paperId: string): Promise<unknown>;
    listExperiments(): Promise<unknown>;
    saveExperiment(input: unknown): Promise<unknown>;
    deleteExperiment(id: string): Promise<unknown>;
    loadAllData(): Promise<{ experiments: unknown[] }>;
    getWorkspaceAgents(projectId: string): Promise<{ exists: boolean; content: string; version: number; contentHash: string; externalConflict?: boolean; projectId: string }>;
    setWorkspaceAgents(projectId: string, content: string, expectedVersion: number): Promise<{ success: boolean; code: string; version?: number; contentHash?: string; currentVersion?: number; currentContentHash?: string }>;
    currentAffairsResearch(raw: CurrentAffairsResearchRequest): Promise<unknown>;
    currentAffairsApprove(raw: CurrentAffairsApproveRequest): Promise<unknown>;
    currentAffairsExport(raw: CurrentAffairsExportRequest): Promise<unknown>;
    currentAffairsCancel(raw: CurrentAffairsCancelRequest): Promise<unknown>;
    currentAffairsReviewSource(raw: SourceReviewRequest): Promise<unknown>;
    currentAffairsListSources(raw: CurrentAffairsListSourcesRequest): Promise<unknown>;
    listPersonalization(raw: PersonalizationListRequest): Promise<unknown>;
    listPersonalizationTrash(raw: PersonalizationTrashListRequest): Promise<unknown>;
    getPersonalization(raw: PersonalizationGetRequest): Promise<unknown>;
    savePersonalization(raw: PersonalizationSaveRequest): Promise<unknown>;
    archivePersonalization(raw: PersonalizationDeleteRequest): Promise<unknown>;
    forkPersonalization(raw: PersonalizationForkRequest): Promise<unknown>;
    restorePersonalization(raw: PersonalizationRestoreRequest): Promise<unknown>;
    restorePersonalizationFromTrash(raw: PersonalizationTrashRestoreRequest): Promise<unknown>;
    listPersonalizationVersions(raw: PersonalizationVersionsRequest): Promise<unknown>;
    resolvePersonalization(raw: PersonalizationResolveRequest): Promise<unknown>;
    applyPersonalizationExtension(raw: PersonalizationExtensionIpcRequest): Promise<unknown>;
    activatePersonalizationMcp(raw: McpActivationIpcRequest): Promise<unknown>;
    exportPersonalizationBundle(raw: PersonalizationBundleExportIpcRequest): Promise<unknown>;
    importPersonalizationBundle(raw: PersonalizationBundleImportIpcRequest): Promise<unknown>;
    listPersonalizationSecrets(raw: PersonalizationSecretListRequest): Promise<unknown>;
    setPersonalizationSecret(raw: PersonalizationSecretSetRequest): Promise<unknown>;
    removePersonalizationSecret(raw: PersonalizationSecretRemoveRequest): Promise<unknown>;
    fundingTemplate(raw: FundingTemplateIpcRequest): Promise<unknown>;
    chatOutcomeAssistant(raw: import('../../engine/runtime/OutcomeRuntimeContract.js').OutcomeAssistantChatRequest): Promise<unknown>;
    getOutcomeImageSettings(): Promise<unknown>;
    setOutcomeImageSettings(raw: unknown): Promise<unknown>;
    generateOutcomeImage(raw: unknown): Promise<unknown>;
    providerProfilesList(raw: ProviderProfileListRequest): Promise<unknown>;
    providerProfilesSave(raw: ProviderProfileSaveRequest): Promise<unknown>;
    storageGetLocation(): Promise<unknown>;
    storageChooseLocation(): Promise<unknown>;
    storageSetLocation(target: string): Promise<unknown>;
    storageOpenFolder(): Promise<unknown>;
    createOutcome(request: unknown): Promise<unknown>;
    browserShow(bounds: { x: number; y: number; width: number; height: number }): Promise<unknown>;
    browserHide(): Promise<unknown>;
    browserNavigate(url: string): Promise<unknown>;
    browserState(): Promise<unknown>;
    browserClick(x: number, y: number): Promise<unknown>;
    browserType(text: string): Promise<unknown>;
    browserScreenshot(): Promise<unknown>;
    browserCollect(): Promise<unknown>;
    browserAcceptDownload(id: string, projectId: string | null): Promise<unknown>;
    browserCancelDownload(id: string): Promise<unknown>;
    onBrowserState(callback: (state: unknown) => void): () => void;
    onBrowserDownloadRequest(callback: (download: unknown) => void): () => void;
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('preload personalization boundary', () => {
  it('forwards only strict renderer-correlated chat stream chunks and detaches the IPC subscription', async () => {
    const api = await loadExposedAPI();
    const callback = vi.fn();
    const unsubscribe = api.onChatStreamChunk(callback);
    const registration = electronMocks.on.mock.calls.find(([channel]) => channel === 'chat:stream-chunk');
    expect(registration).toBeDefined();
    const handler = registration?.[1] as (event: unknown, payload: unknown) => void;
    handler({}, {
      turnId: 'renderer-turn-1', sessionId: 'session-1', content: '真实实时文本', reasoning: '真实推理', isFinished: false,
    });
    handler({}, { sessionId: 'session-1', content: '没有 turnId 的旧 payload', isFinished: false });
    handler({}, { turnId: 'renderer-turn-1', sessionId: 'session-1', content: '额外字段', isFinished: false, leaked: true });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'renderer-turn-1', sessionId: 'session-1' }));
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledWith('chat:stream-chunk', handler);
  });

  it('forwards strict live agent execution events and detaches the IPC subscription', async () => {
    const api = await loadExposedAPI();
    const callback = vi.fn();
    const unsubscribe = api.onAgentExecutionEvent(callback);
    const registration = electronMocks.on.mock.calls.find(([channel]) => channel === 'agent:execution-event');
    expect(registration).toBeDefined();
    const handler = registration?.[1] as (event: unknown, payload: unknown) => void;
    handler({}, {
      version: 1,
      eventId: 'turn-live-001:0', runId: 'turn-live-001', sessionId: 'session-1', turnId: 'turn-live-001',
      sequence: 0, correlationId: 'turn-live-001',
      event: { type: 'action', action: 'tool:lookup', status: 'completed', timestamp: 1, summary: 'tool.dispatched' },
    });
    handler({}, { turnId: 'turn-live-001', event: { type: 'tool', leaked: true } });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'turn-live-001', sequence: 0 }));
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledWith('agent:execution-event', handler);
  });

  it('replays only strict durable agent events after a validated cursor', async () => {
    const api = await loadExposedAPI();
    const request = { version: 1 as const, sessionId: 'session-1', runId: 'turn-live-001', afterSequence: 0, limit: 32 };
    const response = {
      version: 1,
      sessionId: 'session-1',
      runId: 'turn-live-001',
      afterSequence: 0,
      events: [{
        version: 1,
        eventId: 'turn-live-001:1', runId: 'turn-live-001', sessionId: 'session-1', turnId: 'turn-live-001',
        sequence: 1, correlationId: 'turn-live-001',
        event: { type: 'progress', completed: 1, total: 2, timestamp: 2, label: '已恢复进度' },
      }],
      retentionGap: false,
    };
    electronMocks.invoke.mockResolvedValueOnce(response);
    await expect(api.replayAgentEvents(request)).resolves.toEqual(response);
    expect(electronMocks.invoke).toHaveBeenCalledWith('agent:execution-replay', request);
    const fullReplay = { ...request, afterSequence: -1 as const };
    electronMocks.invoke.mockResolvedValueOnce({ ...response, afterSequence: -1, events: [], retentionGap: false });
    await expect(api.replayAgentEvents(fullReplay)).resolves.toMatchObject({ afterSequence: -1, events: [] });
    expect(electronMocks.invoke).toHaveBeenCalledTimes(2);
  });

  it('validates outcome assistant requests locally and forwards only a strict decoded response', async () => {
    const api = await loadExposedAPI();
    await expect(api.chatOutcomeAssistant({} as import('../../engine/runtime/OutcomeRuntimeContract.js').OutcomeAssistantChatRequest))
      .resolves.toMatchObject({ status: 'error', code: 'invalid_request' });
    expect(electronMocks.invoke).not.toHaveBeenCalled();

    const request = {
      projectId: 'project-a', outcomeId: 'outcome-a', instruction: '精炼这个元素。',
      selection: { type: 'ppt_element' as const, pageId: 'slide-1', elementId: 'title-1' },
    };
    const message = { id: 'message-a', role: 'user', content: '精炼首段。', sources: [], createdAt: 1 };
    electronMocks.invoke.mockResolvedValueOnce({
      status: 'completed', model: 'configured-model', answer: '已完成。',
      userMessage: message,
      assistantMessage: { ...message, id: 'message-b', role: 'assistant', content: '已完成。', createdAt: 2 },
      sources: [], diagnostics: [],
    });
    await expect(api.chatOutcomeAssistant(request)).resolves.toMatchObject({ status: 'completed', answer: '已完成。' });
    expect(electronMocks.invoke).toHaveBeenCalledWith('outcomes:assistant:chat', request);
  });

  it('exposes only strict image-settings and durable-image generation contracts', async () => {
    const api = await loadExposedAPI();
    electronMocks.invoke.mockResolvedValueOnce({ ok:true, settings:{ provider:'OpenAI compatible', model:'gpt-image-1', endpoint:'https://images.example.test/v1/generate', defaultQuality:'high', hasApiKey:true } });
    await expect(api.getOutcomeImageSettings()).resolves.toEqual({ ok:true, settings:{ provider:'OpenAI compatible', model:'gpt-image-1', endpoint:'https://images.example.test/v1/generate', defaultQuality:'high', hasApiKey:true } });
    expect(electronMocks.invoke).toHaveBeenCalledWith('outcomes:image-settings:get');

    await expect(api.setOutcomeImageSettings({ provider:'OpenAI compatible', model:'gpt-image-1', endpoint:'http://images.example.test/unsafe', defaultQuality:'high', apiKeyRef:null })).resolves.toEqual({ ok:false, code:'invalid_request' });
    expect(electronMocks.invoke.mock.calls.some(([channel]) => channel === 'outcomes:image-settings:set')).toBe(false);

    electronMocks.invoke.mockResolvedValueOnce({ ok:true, media:{ id:'om-1', mediaType:'image/png', displayName:'AI-generated.png', byteLength:8 }, mimeType:'image/png' });
    await expect(api.generateOutcomeImage({ projectId:'project-a', outcomeId:'outcome-a', prompt:'研究配图' })).resolves.toEqual({ ok:true, media:{ id:'om-1', mediaType:'image/png', displayName:'AI-generated.png', byteLength:8 }, mimeType:'image/png' });
    expect(electronMocks.invoke).toHaveBeenCalledWith('outcomes:image:generate',{ projectId:'project-a', outcomeId:'outcome-a', prompt:'研究配图', visualContext:'' });

    electronMocks.invoke.mockResolvedValueOnce({ ok:true, dataUrl:'data:image/png;base64,iVBORw0KGgo=' });
    await expect(api.getOutcomeImageSettings()).resolves.toEqual({ ok:false, code:'settings_read_failed' });
  });

  it('rejects malformed requests without IPC', async () => {
    const api = await loadExposedAPI();
    const malformed = {} as PersonalizationSaveRequest;
    await expect(api.savePersonalization(malformed)).resolves.toEqual({ ok: false, code: 'invalid_request' });
    expect(electronMocks.invoke.mock.calls.some(([channel]) => channel === 'personalization:save')).toBe(false);
  });

  it('forwards a strict list request and decodes the response', async () => {
    electronMocks.invoke.mockResolvedValueOnce({ ok: true, definitions: [] });
    const api = await loadExposedAPI();
    const request: PersonalizationListRequest = {
      contractVersion: 1,
      kind: 'skill',
      includeDisabled: true,
    };
    await expect(api.listPersonalization(request)).resolves.toEqual({ ok: true, definitions: [] });
    expect(electronMocks.invoke).toHaveBeenCalledWith('personalization:list', request);
  });

  it('forwards the strict scenario trash request without exposing raw database rows', async () => {
    electronMocks.invoke.mockResolvedValueOnce({ ok: true, definitions: [] });
    const api = await loadExposedAPI();
    const request: PersonalizationTrashListRequest = { contractVersion: 1, kind: 'scenario' };
    await expect(api.listPersonalizationTrash(request)).resolves.toEqual({ ok: true, definitions: [] });
    expect(electronMocks.invoke).toHaveBeenCalledWith('personalization:trash:list', request);
  });

  it('drops malformed main-process responses', async () => {
    electronMocks.invoke.mockResolvedValueOnce({ ok: true, definitions: [{ __leak: 'secret' }] });
    const api = await loadExposedAPI();
    await expect(api.listPersonalization({ contractVersion: 1, includeDisabled: false }))
      .rejects.toThrow('Personalization list failed: invalid_response');
  });

  it('rejects version-mismatched list requests and responses without inventing an empty catalog', async () => {
    const api = await loadExposedAPI();
    await expect(api.listPersonalization({
      contractVersion: 2,
      includeDisabled: false,
    } as unknown as PersonalizationListRequest)).rejects.toThrow('Invalid personalization list request');
    expect(electronMocks.invoke).not.toHaveBeenCalledWith('personalization:list', expect.anything());

    electronMocks.invoke.mockResolvedValueOnce({
      contractVersion: 2,
      ok: true,
      definitions: [],
    });
    await expect(api.listPersonalization({ contractVersion: 1, includeDisabled: false }))
      .rejects.toThrow('Personalization list failed: invalid_response');
  });

  it.each(['invalid_request', 'unavailable'] as const)(
    'rejects an explicit %s main-process list failure instead of resolving an empty catalog',
    async (code) => {
      electronMocks.invoke.mockResolvedValueOnce({ ok: false, code });
      const api = await loadExposedAPI();
      await expect(api.listPersonalization({ contractVersion: 1, includeDisabled: false }))
        .rejects.toThrow(`Personalization list failed: ${code}`);
    },
  );

  it('forwards a valid factory fork and rejects unsafe targets', async () => {
    electronMocks.invoke.mockResolvedValueOnce({
      ok: false,
      code: 'not_found',
    });
    const api = await loadExposedAPI();
    const request: PersonalizationForkRequest = {
      contractVersion: 1,
      sourceId: 'builtin:skills/literature-review',
      targetId: 'user:skills/my-review',
      author: 'Researcher',
    };
    await expect(api.forkPersonalization(request)).resolves.toEqual({ ok: false, code: 'not_found' });
    expect(electronMocks.invoke).toHaveBeenCalledWith('personalization:fork', request);

    electronMocks.invoke.mockClear();
    await expect(api.forkPersonalization({
      ...request,
      targetId: 'builtin:skills/overwrite',
    })).resolves.toEqual({ ok: false, code: 'invalid_request' });
    expect(electronMocks.invoke).not.toHaveBeenCalled();
  });

  it('rejects malformed extension and bundle requests without IPC', async () => {
    const api = await loadExposedAPI();
    await expect(api.applyPersonalizationExtension({ mode: 'skill_package' } as PersonalizationExtensionIpcRequest))
      .resolves.toEqual({
        ok: false,
        mode: null,
        code: 'invalid_request',
        detailCode: 'invalid_response',
        compensated: false,
      });
    await expect(api.exportPersonalizationBundle({} as PersonalizationBundleExportIpcRequest))
      .resolves.toEqual({
        ok: false,
        operationId: '00000000-0000-4000-8000-000000000000',
        code: 'invalid_request',
      });
    await expect(api.importPersonalizationBundle({} as PersonalizationBundleImportIpcRequest))
      .resolves.toEqual({
        ok: false,
        operationId: '00000000-0000-4000-8000-000000000000',
        code: 'invalid_request',
      });
    expect(electronMocks.invoke.mock.calls.some(([channel]) => String(channel).startsWith('personalization:extension'))).toBe(false);
    expect(electronMocks.invoke.mock.calls.some(([channel]) => String(channel).startsWith('personalization:bundle'))).toBe(false);
  });

  it('rejects owner/evidence injection and malformed MCP activation before IPC', async () => {
    const api = await loadExposedAPI();
    const result = await api.activatePersonalizationMcp({
      contractVersion: 1,
      operationId: '12121212-1212-4212-8212-121212121212',
      definitionId: 'url:mcp/reference-manager',
      installationId: `mcp_${'a'.repeat(32)}`,
      expectedRevision: 1,
      owner: { webContentsId: 999 },
    } as McpActivationIpcRequest);
    expect(result).toMatchObject({ ok: false, code: 'invalid_response' });
    expect(electronMocks.invoke.mock.calls.some(([channel]) => channel === 'personalization:mcp:activate')).toBe(false);
  });

  it('rejects generated MCP activation before IPC so it cannot bypass the generated transaction coordinator', async () => {
    const api = await loadExposedAPI();
    const result = await api.activatePersonalizationMcp({
      contractVersion: 1,
      operationId: '12121212-1212-4212-8212-121212121213',
      definitionId: 'generated:mcp/builder-output',
      installationId: `mcp_${'a'.repeat(32)}`,
      expectedRevision: 1,
    } as McpActivationIpcRequest);
    expect(result).toMatchObject({ ok: false, code: 'invalid_response' });
    expect(electronMocks.invoke.mock.calls.some(([channel]) => channel === 'personalization:mcp:activate')).toBe(false);
  });

  it('forwards a strict MCP activation and suppresses malformed main responses', async () => {
    const request: McpActivationIpcRequest = {
      contractVersion: 1,
      operationId: '13131313-1313-4313-8313-131313131313',
      definitionId: 'url:mcp/reference-manager',
      installationId: `mcp_${'b'.repeat(32)}`,
      expectedRevision: 1,
    };
    electronMocks.invoke.mockResolvedValueOnce({
      ok: true,
      contractVersion: 1,
      operationId: request.operationId,
      definition: { id: request.definitionId },
      installation: { installationId: request.installationId },
      evidence: {},
      localPath: 'C:\\private\\mcp',
    });
    const api = await loadExposedAPI();
    await expect(api.activatePersonalizationMcp(request)).resolves.toMatchObject({
      ok: false,
      code: 'invalid_response',
    });
    expect(electronMocks.invoke).toHaveBeenCalledWith('personalization:mcp:activate', request);
  });

  it('forwards a strict Markdown extension request and drops malformed main responses', async () => {
    const request: PersonalizationExtensionIpcRequest = {
      contractVersion: 1,
      mode: 'skill_markdown',
      operationId: '11111111-1111-4111-8111-111111111111',
      expectedRevision: 0,
      id: 'user:skills/causal-review',
      name: 'Causal review',
      description: 'Review causal evidence.',
      author: 'Local user',
      version: '1.0.0',
      markdown: '# Causal review\n\nUse traceable evidence.',
      toolIds: [],
      mcpIds: [],
      tags: ['review'],
      maxTurns: 12,
      inputSchema: null,
      outputSchema: null,
    };
    electronMocks.invoke.mockResolvedValueOnce({ ok: true, definition: { id: request.id }, localPath: 'C:\\secret' });
    const api = await loadExposedAPI();
    await expect(api.applyPersonalizationExtension(request)).resolves.toEqual({
      ok: false,
      mode: null,
      code: 'invalid_request',
      detailCode: 'invalid_response',
      compensated: false,
    });
    expect(electronMocks.invoke).toHaveBeenCalledWith('personalization:extension:apply', request);
  });

  it('forwards strict bundle export and import requests and decodes responses', async () => {
    const exportRequest: PersonalizationBundleExportIpcRequest = {
      contractVersion: 1,
      operationId: '22222222-2222-4222-8222-222222222222',
      rootDefinitionIds: ['user:scenarios/my-research'],
    };
    const importRequest: PersonalizationBundleImportIpcRequest = {
      contractVersion: 1,
      operationId: '33333333-3333-4333-8333-333333333333',
    };
    electronMocks.invoke
      .mockResolvedValueOnce({
        ok: true,
        operationId: exportRequest.operationId,
        action: 'exported',
        bundleDigest: 'a'.repeat(64),
        definitionCount: 3,
      })
      .mockResolvedValueOnce({
        ok: true,
        operationId: importRequest.operationId,
        action: 'imported',
        bundleDigest: 'b'.repeat(64),
        definitionCount: 3,
      });
    const api = await loadExposedAPI();
    await expect(api.exportPersonalizationBundle(exportRequest)).resolves.toMatchObject({ ok: true, action: 'exported' });
    await expect(api.importPersonalizationBundle(importRequest)).resolves.toMatchObject({ ok: true, action: 'imported' });
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, 'personalization:bundle:export', exportRequest);
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(2, 'personalization:bundle:import', importRequest);
  });

  it('keeps provider profile metadata-only and rejects a main-process response that leaks a key', async () => {
    const request: ProviderProfileListRequest = {
      contractVersion: 1,
      operationId: '11111111-1111-4111-8111-111111111111',
    };
    electronMocks.invoke.mockResolvedValueOnce({
      ok: true,
      contractVersion: 1,
      operationId: request.operationId,
      revision: 1,
      profiles: [{
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Research Qwen',
        baseUrl: 'https://example.test/v1',
        model: 'qwen3.5-122b-a10b',
        vision: false,
        maxContextTokens: 131072,
        apiKeyStored: true,
        isActive: true,
        createdAt: 1,
        updatedAt: 1,
        apiKey: 'malicious-main-response-key',
      }],
    });
    const api = await loadExposedAPI();
    const result = await api.providerProfilesList(request);
    expect(electronMocks.invoke).toHaveBeenCalledWith('providerProfiles:list', request);
    expect(result).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(JSON.stringify(result)).not.toContain('malicious-main-response-key');
  });

  it('rejects malformed provider profile saves before IPC', async () => {
    const api = await loadExposedAPI();
    const result = await api.providerProfilesSave({
      contractVersion: 1,
      operationId: '33333333-3333-4333-8333-333333333333',
      expectedRevision: 0,
      name: 'Invalid',
      baseUrl: 'https://example.test/v1',
      model: 'qwen3.5-122b-a10b',
      vision: false,
      maxContextTokens: 0,
      keyMode: 'saved',
      newApiKey: 'must-not-cross-ipc-12345',
    } as ProviderProfileSaveRequest);
    expect(result).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(JSON.stringify(result)).not.toContain('must-not-cross-ipc-12345');
    expect(electronMocks.invoke).not.toHaveBeenCalled();
  });

  it('keeps secret values write-only and returns metadata-only responses', async () => {
    const setRequest: PersonalizationSecretSetRequest = {
      contractVersion: 1,
      operationId: '44444444-4444-4444-8444-444444444444',
      expectedRevision: 0,
      name: 'ZOTERO_API_KEY',
      value: 'renderer-write-only-secret',
    };
    const listRequest: PersonalizationSecretListRequest = {
      contractVersion: 1,
      operationId: '55555555-5555-4555-8555-555555555555',
    };
    electronMocks.invoke
      .mockResolvedValueOnce({
        ok: true,
        contractVersion: 1,
        operationId: setRequest.operationId,
        revision: 1,
        secret: { name: 'ZOTERO_API_KEY', createdAt: 10, updatedAt: 10 },
      })
      .mockResolvedValueOnce({
        ok: true,
        contractVersion: 1,
        operationId: listRequest.operationId,
        revision: 1,
        secrets: [{ name: 'ZOTERO_API_KEY', createdAt: 10, updatedAt: 10 }],
      });
    const api = await loadExposedAPI();
    const saved = await api.setPersonalizationSecret(setRequest);
    const listed = await api.listPersonalizationSecrets(listRequest);
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, 'personalization:secrets:set', setRequest);
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(2, 'personalization:secrets:list', listRequest);
    expect(JSON.stringify(saved)).not.toContain(setRequest.value);
    expect(JSON.stringify(listed)).not.toContain(setRequest.value);
    expect(listed).toMatchObject({ ok: true, revision: 1, secrets: [{ name: 'ZOTERO_API_KEY' }] });
  });

  it('rejects malformed secret requests and strips leaked plaintext from malformed responses', async () => {
    const api = await loadExposedAPI();
    await expect(api.setPersonalizationSecret({
      contractVersion: 1,
      operationId: '66666666-6666-4666-8666-666666666666',
      expectedRevision: 0,
      name: 'PATH',
      value: 'forbidden',
    } as PersonalizationSecretSetRequest)).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
    expect(electronMocks.invoke).not.toHaveBeenCalled();

    const request: PersonalizationSecretListRequest = {
      contractVersion: 1,
      operationId: '77777777-7777-4777-8777-777777777777',
    };
    electronMocks.invoke.mockResolvedValueOnce({
      ok: true,
      contractVersion: 1,
      operationId: request.operationId,
      revision: 1,
      secrets: [{ name: 'ZOTERO_API_KEY', createdAt: 1, updatedAt: 1, value: 'leak' }],
    });
    await expect(api.listPersonalizationSecrets(request)).resolves.toEqual({
      ok: false,
      contractVersion: 1,
      operationId: request.operationId,
      code: 'invalid_request',
    });
  });

  it('rejects malformed funding-template requests before IPC', async () => {
    const api = await loadExposedAPI();
    const result = await api.fundingTemplate({
      contractVersion: 1,
      operationId: '88888888-8888-4888-8888-888888888888',
      action: 'import',
      projectId: 'project-a',
      templateId: 'user:funding-a',
      fileCapabilityId: `fc_${'a'.repeat(32)}`,
      capabilityUse: 'consume_once',
      expectedTemplateRevision: 0,
      expectedActiveVersion: null,
      expectedActiveDigest: null,
      localPath: 'C:\\private\\template.pdf',
    } as FundingTemplateIpcRequest);
    expect(result).toMatchObject({ ok: false, action: 'list', code: 'response_invalid' });
    expect(electronMocks.invoke.mock.calls.some(([channel]) => channel === 'fundingTemplate:invoke')).toBe(false);
  });

  it('forwards a strict funding list request and decodes a safe response', async () => {
    const request: FundingTemplateIpcRequest = {
      contractVersion: 1,
      operationId: '99999999-9999-4999-8999-999999999999',
      action: 'list',
      projectId: 'project-a',
      includeArchived: false,
    };
    electronMocks.invoke.mockResolvedValueOnce({
      ok: true,
      contractVersion: 1,
      operationId: request.operationId,
      action: 'list',
      ownerId: 'local-user',
      projectId: 'project-a',
      templates: [],
    });
    const api = await loadExposedAPI();
    await expect(api.fundingTemplate(request)).resolves.toMatchObject({ ok: true, action: 'list', templates: [] });
    expect(electronMocks.invoke).toHaveBeenCalledWith('fundingTemplate:invoke', request);
  });

  it('suppresses path and prose injection from malformed funding responses', async () => {
    const request: FundingTemplateIpcRequest = {
      contractVersion: 1,
      operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      action: 'list',
      projectId: 'project-a',
      includeArchived: false,
    };
    electronMocks.invoke.mockResolvedValueOnce({
      ok: true,
      contractVersion: 1,
      operationId: request.operationId,
      action: 'list',
      ownerId: 'local-user',
      projectId: 'project-a',
      templates: [],
      localPath: 'C:\\private\\funding.pdf',
      sourceText: 'private applicant content',
    });
    const api = await loadExposedAPI();
    const result = await api.fundingTemplate(request);
    expect(result).toMatchObject({ ok: false, action: 'list', code: 'response_invalid' });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('applicant');
  });
});

describe('preload live steering boundary', () => {
  it('rejects malformed control requests without IPC', async () => {
    const api = await loadExposedAPI();
    await expect(api.agentControl({ action: 'instruction' } as AgentControlRequest)).resolves.toMatchObject({
      ok: false,
      code: 'queue_unavailable',
    });
    expect(electronMocks.invoke.mock.calls.some(([channel]) => channel === 'agent:control')).toBe(false);
  });

  it('forwards a strict instruction and decodes the echoed result', async () => {
    const request: AgentControlRequest = {
      contractVersion: 1,
      operationId: 'steer-1',
      sessionId: 'session-1',
      action: 'instruction',
      content: 'Focus on the causal mechanism.',
    };
    electronMocks.invoke.mockResolvedValueOnce({
      ok: true,
      contractVersion: 1,
      operationId: 'steer-1',
      action: 'instruction',
      sequence: 1,
    });
    const api = await loadExposedAPI();
    await expect(api.agentControl(request)).resolves.toEqual({
      ok: true,
      contractVersion: 1,
      operationId: 'steer-1',
      action: 'instruction',
      sequence: 1,
    });
    expect(electronMocks.invoke).toHaveBeenCalledWith('agent:control', request);
  });

  it('drops malformed main-process control responses', async () => {
    electronMocks.invoke.mockResolvedValueOnce({ ok: true, action: 'interrupt', sequence: 1, secret: 'leak' });
    const api = await loadExposedAPI();
    await expect(api.agentControl({
      contractVersion: 1,
      operationId: 'interrupt-1',
      sessionId: 'session-1',
      action: 'interrupt',
      reason: 'Stop now',
    })).resolves.toEqual({
      ok: false,
      contractVersion: 1,
      operationId: 'interrupt-1',
      code: 'queue_unavailable',
    });
  });
});

describe('preload acceptance bridge', () => {
  it('exposes the runtime identity through the dedicated IPC channel', async () => {
    const identity = { buildId: 'metis-alpha2-release', appVersion: '0.1.0-alpha.2' };
    electronMocks.invoke.mockResolvedValueOnce(identity);
    const api = await loadExposedAPI();

    await expect(api.runtimeIdentity()).resolves.toBe(identity);
    expect(electronMocks.invoke).toHaveBeenCalledWith('runtime:identity');
  });

  it('exposes the environment handshake through the dedicated IPC channel', async () => {
    const metadata = { enabled: false };
    electronMocks.invoke.mockResolvedValueOnce(metadata);
    const api = await loadExposedAPI();

    await expect(api.acceptanceEnvironment()).resolves.toBe(metadata);
    expect(electronMocks.invoke).toHaveBeenCalledWith('acceptance:environment');
  });

  it('forwards only the structured native window size request', async () => {
    const result = {
      mode: 'content',
      requested: { width: 1300, height: 900 },
    };
    const request = {
      mode: 'content' as const,
      width: 1300,
      height: 900,
    };
    electronMocks.invoke.mockResolvedValueOnce(result);
    const api = await loadExposedAPI();

    await expect(api.acceptanceSetWindowSize(request)).resolves.toBe(result);
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      'acceptance:window:setSize',
      request,
    );
  });

  it('exposes an explicit one-way release for native window control', async () => {
    const result = { released: true };
    electronMocks.invoke.mockResolvedValueOnce(result);
    const api = await loadExposedAPI();

    await expect(api.acceptanceReleaseWindowControl()).resolves.toBe(result);
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      'acceptance:window:release',
    );
  });
});

describe('preload external-navigation bridge', () => {
  it('forwards only a canonical clean HTTPS URL', async () => {
    const result = { success: true };
    electronMocks.invoke.mockResolvedValueOnce(result);
    const api = await loadExposedAPI();

    await expect(api.openExternal('https://例子.测试/paper')).resolves.toBe(result);
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      'shell:openExternal',
      'https://xn--fsqu00a.xn--0zwm56d/paper',
    );
  });

  it.each([
    'http://example.test/paper',
    'https://user:password@example.test/paper',
    'https://example.test/paper?token=secret',
    'https://example.test/paper#private',
    'file:///C:/Users/researcher/private.pdf',
  ])('rejects unsafe destination %s before IPC', async (url) => {
    const api = await loadExposedAPI();

    await expect(api.openExternal(url)).resolves.toEqual({
      success: false,
      error: 'External link blocked',
    });
    expect(electronMocks.invoke).not.toHaveBeenCalled();
  });
});

describe('preload runtime-schema boundary', () => {
  it('keeps research media IPC pathless in both request and response directions', async () => {
    const api = await loadExposedAPI();
    const unsafeRequest = await api.researchMediaAttach({
      projectId: 'project_media_contract',
      sourceId: 'source_media_contract',
      capabilityId: `fc_${'a'.repeat(32)}`,
      caption: 'Figure 1',
      ordinal: 0,
      filePath: 'C:\\private\\figure.png',
    } as never);
    expect(unsafeRequest).toEqual({ success: false, code: 'research_media_unavailable' });
    expect(electronMocks.invoke).not.toHaveBeenCalled();

    electronMocks.invoke.mockResolvedValueOnce({
      success: true,
      code: 'research_media_attached',
      media: {
        sourceId: 'source_media_contract',
        caption: 'Figure 1',
        ordinal: 0,
        displayName: 'figure.png',
        mediaType: 'image/png',
        byteLength: 68,
        sha256: '0'.repeat(64),
        widthPx: 1,
        heightPx: 1,
        filePath: 'C:\\private\\figure.png',
      },
    });
    const unsafeResponse = await api.researchMediaAttach({
      projectId: 'project_media_contract',
      sourceId: 'source_media_contract',
      capabilityId: `fc_${'b'.repeat(32)}`,
      caption: 'Figure 1',
      ordinal: 0,
    });
    expect(unsafeResponse).toEqual({ success: false, code: 'research_media_unavailable' });
    expect(JSON.stringify(unsafeResponse)).not.toContain('private');
    expect(electronMocks.invoke).toHaveBeenCalledWith('research:mediaAttach', {
      projectId: 'project_media_contract',
      sourceId: 'source_media_contract',
      capabilityId: `fc_${'b'.repeat(32)}`,
      caption: 'Figure 1',
      ordinal: 0,
    });
  });

  it('rejects renderer-supplied file capability owner identity before IPC', async () => {
    const api = await loadExposedAPI();
    const result = await api.useFileCapability({
      capabilityId: `fc_${'a'.repeat(32)}`,
      operation: 'read',
      maxBytes: 1024,
      owner: {
        webContentsId: 1,
        mainFrameProcessId: 2,
        mainFrameRoutingId: 3,
      },
    } as never);
    expect(result).toEqual({ success: false, code: 'file_capability_unavailable' });
    expect(electronMocks.invoke).not.toHaveBeenCalled();
  });

  it('useFileCapability rejects requests with extra keys before IPC', async () => {
    const api = await loadExposedAPI();

    const withSubframeId = await api.useFileCapability({
      capabilityId: `fc_${'x'.repeat(32)}`,
      operation: 'read',
      maxBytes: 1024,
      subframeId: 999,
    } as never);
    expect(withSubframeId).toEqual({ success: false, code: 'file_capability_unavailable' });
    expect(electronMocks.invoke).not.toHaveBeenCalled();

    const withDestroyedFlag = await api.useFileCapability({
      capabilityId: `fc_${'y'.repeat(32)}`,
      operation: 'read',
      destroyed: true,
    } as never);
    expect(withDestroyedFlag).toEqual({ success: false, code: 'file_capability_unavailable' });
    expect(electronMocks.invoke).not.toHaveBeenCalled();
  });

  it('does not expose deprecated raw-stream, raw-agent, arbitrary open-path, or PDF raw-path capabilities', async () => {
    const api = await loadExposedAPI() as Record<string, unknown>;

    expect(api.onStreamChunk).toBeUndefined();
    expect(api.agentRun).toBeUndefined();
    expect(api.openPath).toBeUndefined();
    expect(api.extractPdfText).toBeUndefined();
    expect(api.downloadPdf).toBeUndefined();
    expect(api.readFile).toBeUndefined();
  });

  it('rejects savePaper with pdfPath, path, or owner fields before IPC', async () => {
    const api = await loadExposedAPI();

    const withPdfPath = await api.savePaper({
      id: 'paper-sp-1',
      title: 'Leak Paper',
      authors: ['Author'],
      year: 2024,
      venue: 'Venue',
      abstract: 'Abstract',
      tags: [],
      notes: '',
      readStatus: 'unread',
      rating: 0,
      addedAt: 1,
      pdfPath: 'C:\\private\\path.pdf',
    } as never);
    expect(withPdfPath).toEqual({ success: false, code: 'library_mutation_unavailable' });
    expect(electronMocks.invoke).not.toHaveBeenCalled();

    const withPath = await api.savePaper({
      id: 'paper-sp-2',
      title: 'Path Paper',
      authors: ['Author'],
      year: 2024,
      venue: 'Venue',
      abstract: 'Abstract',
      tags: [],
      notes: '',
      readStatus: 'unread',
      rating: 0,
      addedAt: 1,
      path: '/tmp/secret.pdf',
    } as never);
    expect(withPath).toEqual({ success: false, code: 'library_mutation_unavailable' });
    expect(electronMocks.invoke).not.toHaveBeenCalled();

    const withOwner = await api.savePaper({
      id: 'paper-sp-3',
      title: 'Owned Paper',
      authors: ['Author'],
      year: 2024,
      venue: 'Venue',
      abstract: 'Abstract',
      tags: [],
      notes: '',
      readStatus: 'unread',
      rating: 0,
      addedAt: 1,
      owner: { webContentsId: 99 },
    } as never);
    expect(withOwner).toEqual({ success: false, code: 'library_mutation_unavailable' });
    expect(electronMocks.invoke).not.toHaveBeenCalled();

    // Valid save goes through
    electronMocks.invoke.mockResolvedValueOnce({ success: true, code: 'saved' });
    const ok = await api.savePaper({
      id: 'paper-sp-4',
      title: 'Safe Paper',
      authors: ['Author'],
      year: 2024,
      venue: 'Venue',
      abstract: 'Abstract',
      tags: [],
      notes: '',
      readStatus: 'unread',
      rating: 0,
      addedAt: 1,
    });
    expect(ok).toEqual({ success: true, code: 'saved' });
    expect(electronMocks.invoke).toHaveBeenLastCalledWith('paper:save', expect.objectContaining({ id: 'paper-sp-4' }));
    const savePayload = electronMocks.invoke.mock.calls[electronMocks.invoke.mock.calls.length - 1][1];
    expect(savePayload).not.toHaveProperty('pdfPath');
    expect(savePayload).not.toHaveProperty('path');
    expect(savePayload).not.toHaveProperty('owner');
  });

  it('paper:list IPC rejects entire array when any paper has pdfPath', async () => {
    const api = await loadExposedAPI();
    // Safe papers only → pass through
    electronMocks.invoke.mockResolvedValueOnce([
      { id: 'paper-list-1', title: 'Safe', authors: [], year: 2024, venue: '', abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: 1 },
    ]);
    const safe = await api.listPapers();
    expect(safe).toHaveLength(1);
    expect(safe[0]?.id).toBe('paper-list-1');

    // Any paper with pdfPath → entire list rejected (strictObject array decode)
    electronMocks.invoke.mockResolvedValueOnce([
      { id: 'paper-list-safe', title: 'Safe', authors: [], year: 2024, venue: '', abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: 1 },
      { id: 'paper-list-leaky', title: 'Leaky', authors: [], year: 2024, venue: '', abstract: '', tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: 1, pdfPath: 'C:\\private\\list.pdf' },
    ]);
    const blocked = await api.listPapers();
    expect(blocked).toEqual([]);
    expect(JSON.stringify(blocked)).not.toContain('private');
  });

  it('downloadPaperPdf decodes only valid paperId and rejects path-containing responses', async () => {
    const api = await loadExposedAPI();
    // Invalid paperId: rejected before IPC
    const bad = await api.downloadPaperPdf('][data-secret=download-leak-marker]');
    expect(bad).toEqual({ success: false, code: 'paper_download_unavailable' });
    expect(electronMocks.invoke).not.toHaveBeenCalled();

    // Response with path leak: decoder rejects
    electronMocks.invoke.mockResolvedValueOnce({
      success: true,
      code: 'paper_download_complete',
      pdfCapability: {
        capabilityId: `fc_${'c'.repeat(32)}`,
        kind: 'file',
        mime: 'application/pdf',
        displayName: 'paper.pdf',
        operations: ['read'],
        issuedAt: 1,
        expiresAt: 9999999999999,
      },
      displayName: 'paper.pdf',
      byteLength: 99999,
      sha256: 'a'.repeat(64),
      path: 'C:\\private\\downloaded.pdf',
    });
    const leaked = await api.downloadPaperPdf('paper-dl-1');
    expect(leaked).toEqual({ success: false, code: 'paper_download_unavailable' });
    expect(JSON.stringify(leaked)).not.toContain('private');

    // Valid download response
    electronMocks.invoke.mockResolvedValueOnce({
      success: true,
      code: 'paper_download_complete',
      pdfCapability: {
        capabilityId: `fc_${'d'.repeat(32)}`,
        kind: 'file',
        mime: 'application/pdf',
        displayName: 'attention.pdf',
        operations: ['read'],
        issuedAt: 1,
        expiresAt: 9999999999999,
      },
      displayName: 'attention.pdf',
      byteLength: 123456,
      sha256: 'b'.repeat(64),
    });
    const ok = await api.downloadPaperPdf('paper-dl-2');
    expect(ok).toEqual({
      success: true,
      code: 'paper_download_complete',
      pdfCapability: expect.objectContaining({ displayName: 'attention.pdf' }),
      displayName: 'attention.pdf',
      byteLength: 123456,
      sha256: 'b'.repeat(64),
    });
    expect(JSON.stringify(ok)).not.toContain('path');
    expect(electronMocks.invoke).toHaveBeenLastCalledWith('paper:downloadPdf', { paperId: 'paper-dl-2' });
  });

  it('rejects downloadPaperPdf responses missing required fields', async () => {
    const api = await loadExposedAPI();
    electronMocks.invoke.mockResolvedValueOnce({
      success: true,
      code: 'paper_download_complete',
      displayName: 'paper.pdf',
      byteLength: 100,
      // missing sha256 and pdfCapability
    });
    const result = await api.downloadPaperPdf('paper-dl-3');
    expect(result).toEqual({ success: false, code: 'paper_download_unavailable' });
  });

  it('strictly decodes experiment CRUD in both IPC directions', async () => {
    const api = await loadExposedAPI();
    electronMocks.invoke.mockResolvedValueOnce({
      success: true,
      experiments: [{
        id: 'exp-1',
        name: 'Unsafe',
        description: '',
        status: 'planned',
        parameters: {},
        metrics: {},
        tags: [],
        notes: '',
        linkedPaperIds: [],
        createdAt: 1,
        scriptPath: 'C:\\private\\leak.js',
      }],
    });
    const list = await api.listExperiments();
    expect(list).toEqual({ success: false, code: 'experiment_metadata_unavailable' });
    expect(JSON.stringify(list)).not.toContain('private');

    const forgedSave = await api.saveExperiment({
      id: 'exp-1',
      name: 'Forged',
      description: '',
      status: 'planned',
      parameters: {},
      metrics: {},
      tags: [],
      notes: '',
      linkedPaperIds: [],
      createdAt: 1,
      owner: { webContentsId: 1 },
    });
    expect(forgedSave).toEqual({ success: false, code: 'experiment_metadata_invalid' });
    expect(electronMocks.invoke).toHaveBeenCalledTimes(1);

    electronMocks.invoke.mockResolvedValueOnce({ success: true, code: 'deleted' });
    await expect(api.deleteExperiment('exp-1')).resolves.toEqual({ success: true, code: 'deleted' });
    expect(electronMocks.invoke).toHaveBeenLastCalledWith('experiment:delete', { id: 'exp-1' });
  });

  it('removes unsafe raw experiment rows from bulk hydration', async () => {
    const api = await loadExposedAPI();
    electronMocks.invoke.mockResolvedValueOnce({
      papers: [],
      notes: [],
      collections: [],
      experiments: [{
        id: 'exp-1',
        name: 'Unsafe',
        description: '',
        status: 'planned',
        parameters: {},
        metrics: {},
        tags: [],
        notes: '',
        linkedPaperIds: [],
        createdAt: 1,
        scriptPath: 'C:\\private\\leak.js',
      }],
    });
    const result = await api.loadAllData();
    expect(result.experiments).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('strips papers with pdfPath or owner from bulk hydration', async () => {
    const api = await loadExposedAPI();
    electronMocks.invoke.mockResolvedValueOnce({
      papers: [
        {
          id: 'paper-safe',
          title: 'Safe Paper',
          authors: ['Author'],
          year: 2024,
          venue: 'Venue',
          abstract: 'Abstract',
          tags: [],
          notes: '',
          readStatus: 'unread',
          rating: 0,
          addedAt: 1,
        },
        {
          id: 'paper-leaky',
          title: 'Leaky Paper',
          authors: ['Author'],
          year: 2024,
          venue: 'Venue',
          abstract: 'Abstract',
          tags: [],
          notes: '',
          readStatus: 'unread',
          rating: 0,
          addedAt: 1,
          pdfPath: 'C:\\private\\leaky.pdf',
        },
        {
          id: 'paper-owned',
          title: 'Owned Paper',
          authors: ['Author'],
          year: 2024,
          venue: 'Venue',
          abstract: 'Abstract',
          tags: [],
          notes: '',
          readStatus: 'unread',
          rating: 0,
          addedAt: 1,
          owner: { webContentsId: 1 },
        },
      ],
      notes: [],
      collections: [],
      experiments: [],
    });
    const result = await api.loadAllData();
    expect(result.papers).toHaveLength(1);
    expect((result.papers[0] as Record<string, unknown>)?.id).toBe('paper-safe');
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('pdfPath');
    expect(JSON.stringify(result)).not.toContain('owner');
  });

  it('validates session mutations before IPC and forwards only structured requests', async () => {
    const api = await loadExposedAPI();

    const invalidCreate = await api.createSession('unsafe session id');
    const invalidUpdate = await api.updateSession('session-1', {
      title: 'C:\\private\\session-update-secret-marker',
    });
    const invalidDelete = await api.deleteSession('][data-session-secret]');
    expect(invalidCreate).toEqual({ success: false, code: 'session_mutation_unavailable' });
    expect(invalidUpdate).toEqual({ success: false, code: 'session_mutation_unavailable' });
    expect(invalidDelete).toEqual({ success: false, code: 'session_mutation_unavailable' });
    expect(JSON.stringify([invalidCreate, invalidUpdate, invalidDelete])).not.toContain('secret-marker');
    expect(electronMocks.invoke).not.toHaveBeenCalled();

    electronMocks.invoke.mockResolvedValueOnce({ success: true, code: 'created' });
    await expect(api.createSession('session-1')).resolves.toEqual({
      success: true,
      code: 'created',
    });
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      'session:create',
      { sessionId: 'session-1' },
    );

    electronMocks.invoke.mockResolvedValueOnce({ success: true, code: 'updated' });
    await expect(api.updateSession('session-1', { title: '安全标题', archived: true })).resolves.toEqual({
      success: true,
      code: 'updated',
    });
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      'session:update',
      { sessionId: 'session-1', patch: { title: '安全标题', archived: true } },
    );

    electronMocks.invoke.mockResolvedValueOnce({ success: true, code: 'deleted' });
    await expect(api.deleteSession('session-1')).resolves.toEqual({
      success: true,
      code: 'deleted',
    });
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      'session:delete',
      { sessionId: 'session-1' },
    );
  });

  it('revalidates session lists and never exposes metadata, paths, or unknown fields', async () => {
    electronMocks.invoke.mockResolvedValueOnce({
      success: true,
      sessions: [{
        id: 'session-1',
        title: 'C:\\private\\session-list-secret-marker',
        createdAt: 1,
        lastActivity: 1,
        messageCount: 0,
        archived: false,
        metadata: { token: 'metadata-secret-marker' },
      }],
    });
    const api = await loadExposedAPI();

    const result = await api.listSessions();
    expect(result).toEqual({
      success: false,
      code: 'session_list_unavailable',
      sessions: [],
    });
    expect(JSON.stringify(result)).not.toContain('session-list-secret-marker');
    expect(JSON.stringify(result)).not.toContain('metadata-secret-marker');
    expect(electronMocks.invoke).toHaveBeenCalledWith('session:list', {});
  });

  it('revalidates structured history and never reflects an invalid role', async () => {
    electronMocks.invoke.mockResolvedValueOnce([
      { kind: 'message', role: 'attacker-secret-role', content: 'secret history payload' },
    ]);
    const api = await loadExposedAPI();

    const result = await api.getMessages('session-1');
    expect(result).toEqual([{ kind: 'recovery', code: 'history_unavailable' }]);
    expect(JSON.stringify(result)).not.toContain('attacker-secret-role');
    expect(JSON.stringify(result)).not.toContain('secret history payload');
  });

  it('rejects invalid persisted message roles and malformed Goal markers before IPC', async () => {
    const api = await loadExposedAPI();

    await expect(api.appendMessage('session-1', 'attacker-secret-role', 'secret payload')).resolves.toBe(-1);
    await expect(api.appendMessage(
      'session-1',
      'goal',
      '__GOAL_CARD__{"apiKey":"goal-secret-marker"}',
    )).resolves.toBe(-1);
    expect(electronMocks.invoke).not.toHaveBeenCalled();
  });

  it('rejects malformed artifact mutations before IPC without reflecting raw fields', async () => {
    const api = await loadExposedAPI();

    const createResult = await api.createArtifact({
      id: 'artifact-1',
      sessionId: 'session-1',
      name: 'paper.pdf',
      type: 'pdf',
      path: 'https://example.test/private.pdf?token=artifact-secret-marker',
    });
    const deleteResult = await api.deleteArtifact('"][data-secret="artifact-delete-marker"]');

    expect(createResult).toEqual({ success: false, code: 'artifact_mutation_unavailable' });
    expect(deleteResult).toEqual({ success: false, code: 'artifact_mutation_unavailable' });
    expect(JSON.stringify([createResult, deleteResult])).not.toContain('artifact-secret-marker');
    expect(JSON.stringify([createResult, deleteResult])).not.toContain('artifact-delete-marker');
    expect(electronMocks.invoke).not.toHaveBeenCalled();
  });

  it('revalidates artifact list responses and rejects path or metadata payloads', async () => {
    electronMocks.invoke.mockResolvedValueOnce({
      success: true,
      items: [{
        id: 'artifact-1',
        sessionId: 'session-1',
        name: 'paper.pdf',
        type: 'pdf',
        contentAvailable: false,
        createdAt: 1,
        path: 'C:\\Users\\researcher\\artifact-list-secret-marker.pdf',
      }],
    });
    const api = await loadExposedAPI();

    const result = await api.listArtifacts('session-1');
    expect(result).toEqual({ success: false, code: 'artifact_list_unavailable', items: [] });
    expect(JSON.stringify(result)).not.toContain('artifact-list-secret-marker');
  });

  it('drops malformed artifact notifications before renderer callbacks', async () => {
    const api = await loadExposedAPI();
    const callback = vi.fn();
    api.onArtifactCreated(callback);
    const registration = electronMocks.on.mock.calls.find(([channel]) => channel === 'artifact:created');
    const handler = registration?.[1] as ((event: unknown, payload: unknown) => void) | undefined;
    expect(handler).toBeDefined();

    handler?.({}, {
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      name: 'paper.pdf',
      type: 'pdf',
      contentAvailable: false,
      createdAt: 1,
      path: 'C:\\Users\\researcher\\artifact-event-secret-marker.pdf',
    });
    expect(callback).not.toHaveBeenCalled();

    handler?.({}, {
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      name: 'paper.pdf',
      type: 'pdf',
      contentAvailable: false,
      createdAt: 1,
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(callback.mock.calls)).not.toContain('artifact-event-secret-marker');
  });

  it('strictly decodes artifact content requests and responses', async () => {
    electronMocks.invoke.mockResolvedValueOnce({
      success: true,
      id: 'artifact-1',
      sessionId: 'session-1',
      name: 'analysis.md',
      type: 'md',
      content: '# Persisted analysis',
      createdAt: 1,
    });
    const api = await loadExposedAPI();

    await expect(api.getArtifactContent('session-1', 'artifact-1')).resolves.toEqual({
      success: true,
      id: 'artifact-1',
      sessionId: 'session-1',
      name: 'analysis.md',
      type: 'md',
      content: '# Persisted analysis',
      createdAt: 1,
    });
    expect(electronMocks.invoke).toHaveBeenCalledWith('artifact:get-content', {
      sessionId: 'session-1',
      artifactId: 'artifact-1',
    });
  });

  it('blocks malformed artifact content traffic on both sides of IPC', async () => {
    const api = await loadExposedAPI();

    await expect(api.getArtifactContent('../session', 'artifact-1')).resolves.toEqual({
      success: false,
      code: 'artifact_content_unavailable',
    });
    expect(electronMocks.invoke).not.toHaveBeenCalled();

    electronMocks.invoke.mockResolvedValueOnce({
      success: true,
      id: 'artifact-1',
      sessionId: 'session-1',
      name: 'analysis.md',
      type: 'md',
      content: '# Safe content',
      createdAt: 1,
      path: 'C:\\private\\artifact-content-secret-marker.md',
    });
    const result = await api.getArtifactContent('session-1', 'artifact-1');
    expect(result).toEqual({ success: false, code: 'artifact_content_unavailable' });
    expect(JSON.stringify(result)).not.toContain('artifact-content-secret-marker');
  });

  it('revalidates the final agent response and drops malformed partial content', async () => {
    electronMocks.invoke.mockResolvedValueOnce({
      status: 'completed',
      content: 'Authorization: Bearer response-secret-marker',
    });
    const api = await loadExposedAPI();

    const result = await api.agentChat(
      'session-1',
      [{ role: 'user', content: 'question' }],
      undefined,
      { mode: 'send' },
    );
    expect(result).toMatchObject({
      version: 1,
      status: 'unknown',
      answer: '',
      citations: [],
      events: [],
    });
    expect(JSON.stringify(result)).not.toContain('response-secret-marker');
  });

  it('forwards the renderer turnId unchanged so live execution events and the final response share one key', async () => {
    const api = await loadExposedAPI();
    electronMocks.invoke.mockResolvedValueOnce({
      version: 1,
      turnId: 'turn-correlation-001',
      status: 'completed',
      answer: '已完成。',
      diagnostics: [],
      citations: [],
      events: [],
    });

    await expect(api.agentChat(
      'session-correlation-001',
      [{ role: 'user', content: '请回答。' }],
      undefined,
      { mode: 'send', turnId: 'turn-correlation-001' },
    )).resolves.toMatchObject({ turnId: 'turn-correlation-001', status: 'completed' });
    expect(electronMocks.invoke).toHaveBeenCalledWith(
      'agent:chat',
      'session-correlation-001',
      [{ role: 'user', content: '请回答。' }],
      undefined,
      { mode: 'send', turnId: 'turn-correlation-001' },
    );
  });

  it('rejects a renderer-forged projectRulesId before invoking agent:chat IPC', async () => {
    const api = await loadExposedAPI();
    const result = await api.agentChat(
      'project-rule-forgery-session',
      [{ role: 'user', content: 'question' }],
      undefined,
      {
        mode: 'send',
        projectId: 'project-integrity',
        scenarioId: 'builtin:scenarios/general-research',
        projectRulesId: 'user:projects/project-integrity/metis-md',
      } as never,
    );

    expect(result).toMatchObject({ version: 1, status: 'unknown', answer: '' });
    expect(electronMocks.invoke.mock.calls.some(([channel]) => channel === 'agent:chat')).toBe(false);
  });

  it('drops malformed Goal live events before invoking renderer callbacks', async () => {
    const api = await loadExposedAPI();
    const callback = vi.fn();
    api.onGoalStepStart(callback);
    const registration = electronMocks.on.mock.calls.find(([channel]) => channel === 'goal:step:start');
    const handler = registration?.[1] as ((event: unknown, payload: unknown) => void) | undefined;
    expect(handler).toBeDefined();

    handler?.({}, {
      type: 'step-start',
      goalId: 'goal-1',
      sequence: 0,
      stepId: 'step-1',
      stepName: 'Authorization: Bearer event-secret-marker',
    });
    expect(callback).not.toHaveBeenCalled();

    handler?.({}, {
      version: 1,
      type: 'step-start',
      goalId: 'goal-1',
      sequence: 0,
      stepId: 'step-1',
      stepName: 'Research step',
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(callback.mock.calls)).not.toContain('event-secret-marker');
  });

  it('subscribes to goal:changed broadcasts with strict decoding and cleanup', async () => {
    const api = await loadExposedAPI();
    const callback = vi.fn();
    const unsubscribe = api.onGoalChanged(callback);
    const registration = electronMocks.on.mock.calls.find(([channel]) => channel === 'goal:changed');
    const handler = registration?.[1] as ((event: unknown, payload: unknown) => void) | undefined;
    expect(handler).toBeDefined();

    handler?.({}, {
      goalId: 'goal-1',
      label: 'Research goal',
      status: 'running',
      priority: 'high',
      createdAt: 42,
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]![0]).toMatchObject({ goalId: 'goal-1', status: 'running', priority: 'high' });

    // Malformed payloads are dropped before reaching the renderer callback.
    handler?.({}, { goalId: 'goal-1', label: '', status: 'running', createdAt: 42 });
    handler?.({}, { goalId: 'goal-1', label: 'Research goal', status: 'running', createdAt: 42, secret: 'changed-secret-marker' });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(callback.mock.calls)).not.toContain('changed-secret-marker');

    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledWith('goal:changed', handler);
  });

  it('revalidates Goal execution results with a fixed recovery', async () => {
    electronMocks.invoke.mockResolvedValueOnce({
      success: false,
      code: 'Authorization: Bearer execution-secret-marker',
    });
    const api = await loadExposedAPI();

    const result = await api.executeGoal('goal-1');
    expect(result).toEqual({ success: false, code: 'goal_execution_unavailable' });
    expect(JSON.stringify(result)).not.toContain('execution-secret-marker');
  });

  it('revalidates Goal create, list, and plan responses without raw reflection', async () => {
    const api = await loadExposedAPI();

    electronMocks.invoke.mockResolvedValueOnce({
      success: true,
      goalId: '"][data-secret=create-secret-marker]',
      status: 'draft',
    });
    const createResult = await api.createGoal('question');
    expect(createResult).toEqual({ success: false, code: 'goal_create_unavailable' });

    electronMocks.invoke.mockResolvedValueOnce({
      success: true,
      goals: [{
        goalId: 'goal-1',
        label: 'Research goal',
        status: 'attacker-secret-status',
        createdAt: 1,
      }],
    });
    const listResult = await api.listGoals();
    expect(listResult).toMatchObject({
      success: true,
      goals: [{ status: 'unknown' }],
    });

    electronMocks.invoke.mockResolvedValueOnce({
      success: true,
      goalId: 'goal-1',
      label: 'Research plan',
      steps: [{
        stepId: 'step-1',
        label: 'Research step',
        ordinal: 1,
        prompt: 'Authorization: Bearer plan-secret-marker',
      }],
    });
    const planResult = await api.generatePlan('goal-1');
    expect(planResult).toEqual({
      success: false,
      code: 'goal_plan_unavailable',
      label: 'Research plan',
      steps: [],
    });

    const serialized = JSON.stringify([createResult, listResult, planResult]);
    for (const marker of ['create-secret-marker', 'attacker-secret-status', 'plan-secret-marker']) {
      expect(serialized).not.toContain(marker);
    }
  });
});

// ─── Project Metis.md preload compatibility boundary ─────────────
// Every test that sets up mockResolvedValueOnce must call
// electronMocks.invoke.mockReset() FIRST to prevent queue leakage
// across tests (clearAllMocks does not reset implementations).

describe('preload project Metis.md — authoritative contract parity', () => {
  // ── Reject invalid projectIds (no IPC) ──────────────────────

  it('getWorkspaceAgents: path traversal rejected, no IPC', async () => {
    const api = await loadExposedAPI();
    const view = await api.getWorkspaceAgents('../../etc/passwd');
    expect(view.exists).toBe(false);
    expect(view.version).toBe(0);
    const calls = electronMocks.invoke.mock.calls.filter(
      ([c]: [string]) => c === 'workspace:agents:get',
    );
    expect(calls.length).toBe(0);
  });

  it('getWorkspaceAgents: control character in projectId rejected, no IPC', async () => {
    const api = await loadExposedAPI();
    const view = await api.getWorkspaceAgents('proj\x00ctrl');
    expect(view.exists).toBe(false);
    const calls = electronMocks.invoke.mock.calls.filter(
      ([c]: [string]) => c === 'workspace:agents:get',
    );
    expect(calls.length).toBe(0);
  });

  it('getWorkspaceAgents: empty projectId rejected, no IPC', async () => {
    const api = await loadExposedAPI();
    const view = await api.getWorkspaceAgents('');
    expect(view.exists).toBe(false);
  });

  // ── Accept valid projectIds with contract PROJECT_ID_REGEX ──

  it('getWorkspaceAgents: UUID with hyphens accepted, forwards to IPC', async () => {
    electronMocks.invoke.mockReset();
    electronMocks.invoke.mockResolvedValueOnce({
      exists: true, content: '# rules', version: 1,
      contentHash: 'a'.repeat(64), projectId: '550e8400-e29b-41d4-a716-446655440000',
    });
    const api = await loadExposedAPI();
    const view = await api.getWorkspaceAgents('550e8400-e29b-41d4-a716-446655440000');
    expect(view.exists).toBe(true);
    expect(view.version).toBe(1);
  });

  it('getWorkspaceAgents: projectId with dots accepted, forwards to IPC', async () => {
    electronMocks.invoke.mockReset();
    electronMocks.invoke.mockResolvedValueOnce({
      exists: true, content: '# dots', version: 2,
      contentHash: 'b'.repeat(64), projectId: 'my.project.v1',
    });
    const api = await loadExposedAPI();
    const view = await api.getWorkspaceAgents('my.project.v1');
    expect(view.exists).toBe(true);
    expect(view.version).toBe(2);
  });

  it('getWorkspaceAgents: hyphenated projectId accepted (was rejected by old regex)', async () => {
    electronMocks.invoke.mockReset();
    electronMocks.invoke.mockResolvedValueOnce({
      exists: true, content: '# Metis.md\n', version: 3,
      contentHash: 'c'.repeat(64), projectId: 'test-project-001',
    });
    const api = await loadExposedAPI();
    const view = await api.getWorkspaceAgents('test-project-001');
    expect(view.exists).toBe(true);
    expect(view.content).toBe('# Metis.md\n');
    expect(view.version).toBe(3);
  });

  it('getWorkspaceAgents: underscore projectId accepted', async () => {
    electronMocks.invoke.mockReset();
    electronMocks.invoke.mockResolvedValueOnce({
      exists: true, content: '# us', version: 4,
      contentHash: 'd'.repeat(64), projectId: 'test_project_abc',
    });
    const api = await loadExposedAPI();
    const view = await api.getWorkspaceAgents('test_project_abc');
    expect(view.exists).toBe(true);
    expect(view.version).toBe(4);
  });

  // ── setWorkspaceAgents boundary ─────────────────────────────

  it('setWorkspaceAgents returns content_invalid for malformed input (no IPC)', async () => {
    const api = await loadExposedAPI();
    const result = await api.setWorkspaceAgents('', 'content', 0);
    expect(result.success).toBe(false);
    expect(result.code).toBe('content_invalid');
    const calls = electronMocks.invoke.mock.calls.filter(
      ([c]: [string]) => c === 'workspace:agents:set',
    );
    expect(calls.length).toBe(0);
  });

  it.each(['\u0000', '\u0001', '\u007f', '\u0085'])(
    'setWorkspaceAgents rejects forbidden C0/C1 content %j before IPC',
    async (control) => {
      electronMocks.invoke.mockReset();
      const api = await loadExposedAPI();
      const result = await api.setWorkspaceAgents('project_rules', `# Metis.md\n${control}`, 0);
      expect(result).toEqual({ success: false, code: 'content_invalid' });
      expect(electronMocks.invoke).not.toHaveBeenCalledWith('workspace:agents:set', expect.anything());
    },
  );

  it('setWorkspaceAgents accepts exactly 50,000 characters and forwards only the authoritative tuple', async () => {
    electronMocks.invoke.mockReset();
    electronMocks.invoke.mockResolvedValueOnce({
      success: true,
      code: 'saved',
      version: 1,
      contentHash: 'e'.repeat(64),
    });
    const api = await loadExposedAPI();
    const content = 'x'.repeat(50_000);
    const result = await api.setWorkspaceAgents('project_rules', content, 0);
    expect(result).toMatchObject({ success: true, version: 1 });
    expect(electronMocks.invoke).toHaveBeenCalledWith('workspace:agents:set', {
      projectId: 'project_rules',
      content,
      expectedVersion: 0,
    });
  });

  it('setWorkspaceAgents rejects 50,001 characters before IPC', async () => {
    electronMocks.invoke.mockReset();
    const api = await loadExposedAPI();
    const result = await api.setWorkspaceAgents('project_rules', 'x'.repeat(50_001), 0);
    expect(result).toEqual({ success: false, code: 'content_invalid' });
    expect(electronMocks.invoke).not.toHaveBeenCalledWith('workspace:agents:set', expect.anything());
  });

  it('setWorkspaceAgents passes through project_not_found from main', async () => {
    electronMocks.invoke.mockReset();
    electronMocks.invoke.mockResolvedValueOnce({
      success: false, code: 'project_not_found',
    });
    const api = await loadExposedAPI();
    const result = await api.setWorkspaceAgents('deleted_proj', '# rules', 0);
    expect(result.success).toBe(false);
    expect(result.code).toBe('project_not_found');
  });

  it('setWorkspaceAgents passes through cas_conflict from main', async () => {
    electronMocks.invoke.mockReset();
    electronMocks.invoke.mockResolvedValueOnce({
      success: false, code: 'cas_conflict',
      currentVersion: 5, currentContentHash: 'abcdef12',
    });
    const api = await loadExposedAPI();
    const result = await api.setWorkspaceAgents('proj_x', '# edit', 2);
    expect(result.success).toBe(false);
    expect(result.code).toBe('cas_conflict');
    if (result.code === 'cas_conflict') {
      expect(result.currentVersion).toBe(5);
    }
  });

  it('getWorkspaceAgents passes through externalConflict from main', async () => {
    electronMocks.invoke.mockReset();
    electronMocks.invoke.mockResolvedValueOnce({
      exists: true, content: '', version: 0, contentHash: '',
      externalConflict: true, projectId: 'proj_cf',
    });
    const api = await loadExposedAPI();
    const view = await api.getWorkspaceAgents('proj_cf');
    expect(view.exists).toBe(true);
    expect(view.externalConflict).toBe(true);
  });

  it('getWorkspaceAgents falls back to empty view on malformed IPC response', async () => {
    electronMocks.invoke.mockReset();
    electronMocks.invoke.mockResolvedValueOnce({ garbage: true });
    const api = await loadExposedAPI();
    const view = await api.getWorkspaceAgents('proj_mal');
    expect(view.exists).toBe(false);
    expect(view.content).toBe('');
    expect(view.version).toBe(0);
  });
});

// ─── Current Affairs preload boundary ─────────────────────────────
// Validate that all six CA methods use strict RuntimeContract types,
// reject invalid requests before IPC, and recover from malformed responses.

const VALID_PROJECT_ID = 'project-ca-test';
const VALID_WF_ID = 'wf-ca-test';
const VALID_DIGEST = 'a'.repeat(64);
const VALID_OPID = 'op-ca-test';

describe('preload current-affairs — strict contract boundary', () => {
  it('currentAffairsResearch: invalid request returns recovery, no IPC', async () => {
    const api = await loadExposedAPI();
    // Missing required fields (no operationId, no title, no selectedSourceIds)
    const result = await api.currentAffairsResearch({} as CurrentAffairsResearchRequest);
    expect(result).toEqual(expect.objectContaining({ ok: false }));
    const calls = electronMocks.invoke.mock.calls.filter(([c]: [string]) => c === 'ca:research');
    expect(calls.length).toBe(0);
  });

  it('currentAffairsResearch: valid request forwards to IPC', async () => {
    electronMocks.invoke.mockReset();
    electronMocks.invoke.mockResolvedValueOnce({
      ok: true, version: 1, operationId: VALID_OPID,
      draft: true, readyForApproval: true, phase: 'approval',
      approved: false, exportReady: false, temporalCheckPassed: true,
      correctionReviewComplete: true, verifiedSourceCount: 1,
      rejectedSourceCount: 0, sourceCount: 1, factCount: 0,
      contentDigest: VALID_DIGEST, sourceSnapshotDigest: VALID_DIGEST,
      preview: { title: 'P', summary: 'S', sections: [], sourceCount: 1, factCount: 0 },
      errors: [],
    });
    const api = await loadExposedAPI();
    await api.currentAffairsResearch({
      version: 1, operationId: VALID_OPID, projectId: VALID_PROJECT_ID,
      workflowId: VALID_WF_ID, profileId: 'pf-test', manifestVersion: 1,
      title: 'Test', selectedSourceIds: ['src-1'],
    });
    expect(electronMocks.invoke).toHaveBeenCalledWith('ca:research', expect.objectContaining({ operationId: VALID_OPID }));
  });

  it('currentAffairsResearch: malformed IPC response → recovery decoder', async () => {
    electronMocks.invoke.mockReset();
    electronMocks.invoke.mockResolvedValueOnce({ garbage: true, __malicious: 'leak' });
    const api = await loadExposedAPI();
    const result = await api.currentAffairsResearch({
      version: 1, operationId: VALID_OPID, projectId: VALID_PROJECT_ID,
      workflowId: VALID_WF_ID, profileId: 'pf-test', manifestVersion: 1,
      title: 'Test', selectedSourceIds: ['src-1'],
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'repository_unavailable' }));
    expect(JSON.stringify(result)).not.toContain('leak');
  });

  it('currentAffairsApprove: invalid request returns recovery, no IPC', async () => {
    const api = await loadExposedAPI();
    const result = await api.currentAffairsApprove({} as CurrentAffairsApproveRequest);
    expect(result).toEqual(expect.objectContaining({ ok: false }));
    const calls = electronMocks.invoke.mock.calls.filter(([c]: [string]) => c === 'ca:approve');
    expect(calls.length).toBe(0);
  });

  it('currentAffairsApprove: malformed IPC response → recovery decoder', async () => {
    electronMocks.invoke.mockReset();
    electronMocks.invoke.mockResolvedValueOnce(null);
    const api = await loadExposedAPI();
    const result = await api.currentAffairsApprove({
      version: 1, operationId: VALID_OPID, projectId: VALID_PROJECT_ID,
      workflowId: VALID_WF_ID, profileId: 'pf-test', manifestVersion: 1,
      contentDigest: VALID_DIGEST, sourceSnapshotDigest: VALID_DIGEST,
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'approval_unavailable' }));
  });

  it('currentAffairsExport: invalid request returns recovery, no IPC', async () => {
    const api = await loadExposedAPI();
    const result = await api.currentAffairsExport({} as CurrentAffairsExportRequest);
    expect(result).toEqual(expect.objectContaining({ ok: false }));
    const calls = electronMocks.invoke.mock.calls.filter(([c]: [string]) => c === 'ca:export');
    expect(calls.length).toBe(0);
  });

  it('currentAffairsExport: malformed IPC response → recovery decoder', async () => {
    electronMocks.invoke.mockReset();
    electronMocks.invoke.mockResolvedValueOnce({ __bad: true });
    const api = await loadExposedAPI();
    const result = await api.currentAffairsExport({
      version: 1, operationId: VALID_OPID, projectId: VALID_PROJECT_ID,
      workflowId: VALID_WF_ID, profileId: 'pf-test', manifestVersion: 1,
      contentDigest: VALID_DIGEST, receiptId: 'r1', receiptNonce: 'n1',
      sourceSnapshotDigest: VALID_DIGEST,
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'export_unavailable' }));
  });

  it('currentAffairsCancel: invalid request returns recovery, no IPC', async () => {
    const api = await loadExposedAPI();
    const result = await api.currentAffairsCancel({} as CurrentAffairsCancelRequest);
    expect(result).toEqual(expect.objectContaining({ ok: false }));
    const calls = electronMocks.invoke.mock.calls.filter(([c]: [string]) => c === 'ca:cancel');
    expect(calls.length).toBe(0);
  });

  it('currentAffairsCancel: discriminates discard_draft vs revoke_approval', async () => {
    electronMocks.invoke.mockReset();
    electronMocks.invoke.mockResolvedValueOnce({ ok: true, version: 1, operationId: 'cc1', action: 'discard_draft' });
    const api = await loadExposedAPI();
    const result = await api.currentAffairsCancel({
      action: 'discard_draft', version: 1, operationId: 'cc1',
      projectId: VALID_PROJECT_ID, workflowId: VALID_WF_ID,
    });
    expect(result).toEqual(expect.objectContaining({ ok: true, action: 'discard_draft' }));
    expect(electronMocks.invoke).toHaveBeenCalledWith('ca:cancel', expect.objectContaining({ action: 'discard_draft' }));

    electronMocks.invoke.mockResolvedValueOnce({ ok: true, version: 1, operationId: 'cc2', action: 'revoke_approval' });
    const result2 = await api.currentAffairsCancel({
      action: 'revoke_approval', version: 1, operationId: 'cc2',
      projectId: VALID_PROJECT_ID, workflowId: VALID_WF_ID,
      profileId: 'pf-test', manifestVersion: 1,
      contentDigest: VALID_DIGEST, sourceSnapshotDigest: VALID_DIGEST,
      receiptId: 'r1', receiptNonce: 'n1',
    });
    expect(result2).toEqual(expect.objectContaining({ ok: true, action: 'revoke_approval' }));
  });

  it('currentAffairsCancel: malformed IPC response → recovery decoder', async () => {
    electronMocks.invoke.mockReset();
    electronMocks.invoke.mockResolvedValueOnce(undefined);
    const api = await loadExposedAPI();
    const result = await api.currentAffairsCancel({
      action: 'discard_draft', version: 1, operationId: 'cc3',
      projectId: VALID_PROJECT_ID, workflowId: VALID_WF_ID,
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'cancel_unavailable' }));
  });

  it('currentAffairsReviewSource: invalid request returns recovery, no IPC', async () => {
    const api = await loadExposedAPI();
    const result = await api.currentAffairsReviewSource({} as SourceReviewRequest);
    expect(result).toEqual(expect.objectContaining({ ok: false }));
    const calls = electronMocks.invoke.mock.calls.filter(([c]: [string]) => c === 'ca:review-source');
    expect(calls.length).toBe(0);
  });

  it('currentAffairsReviewSource: malformed IPC response → recovery decoder', async () => {
    electronMocks.invoke.mockReset();
    electronMocks.invoke.mockResolvedValueOnce({ __leak: 'secret' });
    const api = await loadExposedAPI();
    const result = await api.currentAffairsReviewSource({
      version: 1, operationId: VALID_OPID, projectId: VALID_PROJECT_ID,
      sourceId: 'src-1', expectedSourceVersionHash: VALID_DIGEST,
      expectedUpdatedAt: 1, caKind: 'policy_document',
      correctionState: 'clean',
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'review_failed' }));
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('currentAffairsListSources: invalid request returns recovery, no IPC', async () => {
    const api = await loadExposedAPI();
    const result = await api.currentAffairsListSources({} as CurrentAffairsListSourcesRequest);
    expect(result).toEqual(expect.objectContaining({ ok: false }));
    const calls = electronMocks.invoke.mock.calls.filter(([c]: [string]) => c === 'ca:list-sources');
    expect(calls.length).toBe(0);
  });

  it('currentAffairsListSources: valid request forwards to IPC', async () => {
    electronMocks.invoke.mockReset();
    electronMocks.invoke.mockResolvedValueOnce({ ok: true, version: 1, operationId: 'ls1', sources: [] });
    const api = await loadExposedAPI();
    await api.currentAffairsListSources({ version: 1, operationId: 'ls1', projectId: VALID_PROJECT_ID });
    expect(electronMocks.invoke).toHaveBeenCalledWith('ca:list-sources', expect.objectContaining({ operationId: 'ls1' }));
  });

  it('currentAffairsListSources: malformed IPC response → recovery decoder', async () => {
    electronMocks.invoke.mockReset();
    electronMocks.invoke.mockResolvedValueOnce({ __bad: 'data' });
    const api = await loadExposedAPI();
    const result = await api.currentAffairsListSources({ version: 1, operationId: 'ls2', projectId: VALID_PROJECT_ID });
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'repository_unavailable' }));
  });

  it('currentAffairsListSources: response with path-leaking source is rejected', async () => {
    electronMocks.invoke.mockReset();
    electronMocks.invoke.mockResolvedValueOnce({
      ok: true, version: 1, operationId: 'ls3',
      sources: [{
        sourceId: 'src-1', projectId: VALID_PROJECT_ID,
        title: 'Test', kind: 'policy_document',
        authors: ['A'], url: null, contentDigest: VALID_DIGEST,
        correctionState: 'clean', updatedAt: 1,
        publishedAt: null, fetchedAt: null, deleted: false,
        eligible: true, reviewStatus: 'clean', reason: '',
        __leak: 'C:\\private\\secret.txt',
      }],
    });
    const api = await loadExposedAPI();
    const result = await api.currentAffairsListSources({ version: 1, operationId: 'ls3', projectId: VALID_PROJECT_ID });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('secret.txt');
  });
});

describe('createSession with project binding', () => {
  it('forwards the projectId and drops forged ids before invoking IPC', async () => {
    electronMocks.invoke.mockResolvedValueOnce({ success: true, code: 'created' });
    const api = await loadExposedAPI();

    const ok = await api.createSession('session-proj', 'project-1');
    expect(ok).toEqual({ success: true, code: 'created' });
    expect(electronMocks.invoke).toHaveBeenCalledWith('session:create', { sessionId: 'session-proj', projectId: 'project-1' });

    // A forged project id fails decode and never reaches IPC.
    electronMocks.invoke.mockClear();
    const forged = await api.createSession('session-proj', '../escape');
    expect(forged).toEqual({ success: false, code: 'session_mutation_unavailable' });
    expect(electronMocks.invoke.mock.calls.some(([channel]) => channel === 'session:create')).toBe(false);
  });
});

describe('outcome import ownership bridge', () => {
  it('forwards a valid import-owned create request and drops an invalid actor before IPC', async () => {
    const api = await loadExposedAPI();
    const request = { projectId: 'project-1', categoryId: null, title: '外部报告', kind: 'word', content: { type: 'word', blocks: [{ id: 'p-1', kind: 'paragraph', text: '外部正文' }], page: { paper: 'A4' }, header: '', footer: '' }, note: '导入 external.docx', actor: 'import' };
    electronMocks.invoke.mockResolvedValueOnce({ outcome: { id: 'out-1' }, version: { version: 1 } });
    await api.createOutcome(request);
    expect(electronMocks.invoke).toHaveBeenCalledWith('outcomes:create', expect.objectContaining({ actor: 'import', title: '外部报告' }));
    electronMocks.invoke.mockClear();
    expect(await api.createOutcome({ ...request, actor: 'forged' })).toBeNull();
    expect(electronMocks.invoke).not.toHaveBeenCalled();
  });
});

describe('storage location bridge', () => {
  it('forwards get/choose/set/reset/open to their IPC channels', async () => {
    const api = await loadExposedAPI();

    electronMocks.invoke.mockResolvedValueOnce({
      ok: true,
      dataDir: 'D:\\Data',
      defaultDir: 'C:\\u\\metis-data',
      usingDefault: false,
    });
    expect(await api.storageGetLocation()).toEqual({
      ok: true,
      dataDir: 'D:\\Data',
      defaultDir: 'C:\\u\\metis-data',
      usingDefault: false,
    });
    expect(electronMocks.invoke).toHaveBeenCalledWith('storage:getLocation');

    electronMocks.invoke.mockResolvedValueOnce({ canceled: false, path: 'D:\\New' });
    expect(await api.storageChooseLocation()).toEqual({ canceled: false, path: 'D:\\New' });
    expect(electronMocks.invoke).toHaveBeenCalledWith('storage:chooseLocation');

    electronMocks.invoke.mockResolvedValueOnce({ ok: true, restarting: true, dataDir: 'D:\\New' });
    expect(await api.storageSetLocation('D:\\New')).toEqual({ ok: true, restarting: true, dataDir: 'D:\\New' });
    expect(electronMocks.invoke).toHaveBeenCalledWith('storage:setLocation', 'D:\\New');

    electronMocks.invoke.mockResolvedValueOnce({ ok: true });
    expect(await api.storageOpenFolder()).toEqual({ ok: true });
    expect(electronMocks.invoke).toHaveBeenCalledWith('storage:openFolder');
  });

  it('surfaces failure responses without inventing success', async () => {
    const api = await loadExposedAPI();
    electronMocks.invoke.mockResolvedValueOnce({ ok: false, error: 'location_not_empty' });
    expect(await api.storageSetLocation('D:\\Occupied')).toEqual({ ok: false, error: 'location_not_empty' });
  });
});


describe('research browser bridge', () => {
  it('forwards navigation/control/collect/download calls to their IPC channels', async () => {
    const api = await loadExposedAPI();

    electronMocks.invoke.mockResolvedValueOnce({ ok: true });
    expect(await api.browserShow({ x: 10, y: 20, width: 800, height: 600 })).toEqual({ ok: true });
    expect(electronMocks.invoke).toHaveBeenCalledWith('browser:show', { x: 10, y: 20, width: 800, height: 600 });

    electronMocks.invoke.mockResolvedValueOnce({ ok: true, url: 'https://scholar.google.com' });
    expect(await api.browserNavigate('https://scholar.google.com')).toEqual({ ok: true, url: 'https://scholar.google.com' });
    expect(electronMocks.invoke).toHaveBeenCalledWith('browser:navigate', 'https://scholar.google.com');

    electronMocks.invoke.mockResolvedValueOnce({ ok: true, state: { url: '', title: '', loading: false, canGoBack: false, canGoForward: false } });
    expect(await api.browserState()).toMatchObject({ ok: true });
    expect(electronMocks.invoke).toHaveBeenCalledWith('browser:state');

    electronMocks.invoke.mockResolvedValueOnce({ ok: true });
    expect(await api.browserClick(120, 340)).toEqual({ ok: true });
    expect(electronMocks.invoke).toHaveBeenCalledWith('browser:click', { x: 120, y: 340 });

    electronMocks.invoke.mockResolvedValueOnce({ ok: true });
    expect(await api.browserType('quantum entanglement')).toEqual({ ok: true });
    expect(electronMocks.invoke).toHaveBeenCalledWith('browser:type', 'quantum entanglement');

    electronMocks.invoke.mockResolvedValueOnce({ ok: true, imageBase64: 'AAAA' });
    expect(await api.browserScreenshot()).toMatchObject({ ok: true, imageBase64: 'AAAA' });
    expect(electronMocks.invoke).toHaveBeenCalledWith('browser:screenshot');

    electronMocks.invoke.mockResolvedValueOnce({ ok: true, paper: { paperId: 'paper-1', merged: false, title: 'X' } });
    expect(await api.browserCollect()).toMatchObject({ ok: true, paper: { paperId: 'paper-1' } });
    expect(electronMocks.invoke).toHaveBeenCalledWith('browser:collect');

    electronMocks.invoke.mockResolvedValueOnce({ ok: true, savedPath: 'C:\\p.pdf' });
    expect(await api.browserAcceptDownload('dl-1', 'proj-1')).toMatchObject({ ok: true });
    expect(electronMocks.invoke).toHaveBeenCalledWith('browser:acceptDownload', { id: 'dl-1', projectId: 'proj-1' });

    electronMocks.invoke.mockResolvedValueOnce({ ok: true });
    expect(await api.browserCancelDownload('dl-1')).toEqual({ ok: true });
    expect(electronMocks.invoke).toHaveBeenCalledWith('browser:cancelDownload', 'dl-1');
  });

  it('subscribes to browser state and download events with unsubscribe', async () => {
    const api = await loadExposedAPI();
    const stateCb = vi.fn();
    const downloadCb = vi.fn();
    const offState = api.onBrowserState(stateCb);
    const offDownload = api.onBrowserDownloadRequest(downloadCb);
    expect(electronMocks.on).toHaveBeenCalledWith('browser:state', expect.any(Function));
    expect(electronMocks.on).toHaveBeenCalledWith('browser:download-request', expect.any(Function));

    // invoke the registered handlers through the mock
    const stateHandler = electronMocks.on.mock.calls.find(([ch]) => ch === 'browser:state')![1];
    stateHandler({}, { url: 'https://x', title: 'X', loading: false, canGoBack: true, canGoForward: false });
    expect(stateCb).toHaveBeenCalledWith({ url: 'https://x', title: 'X', loading: false, canGoBack: true, canGoForward: false });

    const downloadHandler = electronMocks.on.mock.calls.find(([ch]) => ch === 'browser:download-request')![1];
    downloadHandler({}, { id: 'dl-2', url: 'https://x/a.pdf', filename: 'a.pdf', mimeType: 'application/pdf', pageUrl: '', pageTitle: '' });
    expect(downloadCb).toHaveBeenCalledWith(expect.objectContaining({ id: 'dl-2', filename: 'a.pdf' }));

    offState();
    offDownload();
    expect(electronMocks.removeListener).toHaveBeenCalledWith('browser:state', stateHandler);
    expect(electronMocks.removeListener).toHaveBeenCalledWith('browser:download-request', downloadHandler);
  });
});
