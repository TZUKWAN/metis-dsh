/**
 * Electron preload script — exposes safe IPC APIs to the renderer process.
 *
 * All communication between renderer (React) and main process (Node.js)
 * goes through this bridge. No direct Node.js access in renderer.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { inspectExternalNavigationUrl } from '../engine/security/ExternalNavigation.js';
import { OutcomeExternalEditorStateRequestSchema, OutcomeExternalEditorStateSchema } from '../engine/runtime/OutcomeRuntimeContract.js';
import { OutcomeAssistantChatRequestSchema, OutcomeAssistantChatResultSchema, OutcomeExternalEditorCloseRequestSchema, OutcomeExternalEditorOpenRequestSchema, OutcomeExternalEditorOpenResultSchema, OutcomeExternalEditorSyncRequestSchema, OutcomeExternalEditorSyncResultSchema, ScopedConversationMessageRequestSchema, ScopedConversationRequestSchema } from '../engine/runtime/OutcomeRuntimeContract.js';
import {
  AgentChatOptionsSchema,
  decodeChatStreamChunkEvent,
  decodeAgentExecutionEvent,
  AgentEventReplayRequestSchema,
  AgentEventReplayResponseSchema,
  decodeAgentResponse,
  decodeGoalLiveEvent,
  decodeHistoryItems,
  decodeStoredHistoryEntry,
  RuntimeIdSchema,
  type AgentChatOptions,
  type GoalLiveEvent,
} from '../engine/runtime/ChatRuntimeContract.js';
import {
  decodeGoalChangedEvent,
  decodeGoalCreateResponse,
  decodeGoalExecutionResult,
  decodeGoalListResponse,
  decodeGoalPlanResponse,
  decodeGoalSummaryResponse,
  decodeGoalWorkflowResponse,
  type GoalChangedEvent,
} from '../engine/runtime/GoalRuntimeContract.js';
import {
  AUTONOMOUS_CHANNELS,
  AUTONOMOUS_CONTRACT_VERSION,
  decodeAutonomousLiveEvent,
  decodeAutonomousStartRequest,
  decodeAutonomousControlRequest,
  type AutonomousLiveEvent,
} from '../engine/runtime/AutonomousRuntimeContract.js';
import {
  createArtifactListRecovery,
  decodeArtifactContentRequest,
  decodeArtifactContentResponse,
  decodeArtifactCreateRequest,
  decodeArtifactCreatedNotification,
  decodeArtifactListResponse,
  decodeArtifactMutationResult,
} from '../engine/runtime/ArtifactRuntimeContract.js';
import {
  createSessionListRecovery,
  decodeSessionCreateRequest,
  decodeSessionDeleteRequest,
  decodeSessionListRequest,
  decodeSessionListResponse,
  decodeSessionMutationResult,
  decodeSessionUpdateRequest,
  type SessionUpdateRequest,
} from '../engine/runtime/SessionRuntimeContract.js';
import {
  createFileCapabilityFailure,
  decodeFileCapabilityImportRequest,
  decodeFileCapabilitySelectionRequest,
  decodeFileCapabilitySelectionResult,
  decodeFileCapabilityUseRequest,
  decodeFileCapabilityUseResult,
  type FileCapabilityPurpose,
} from '../engine/runtime/FileCapabilityContract.js';
import {
  createLatexCompileRecovery,
  decodeLatexCompileRequest,
  decodeLatexCompileResponse,
} from '../engine/runtime/LatexRuntimeContract.js';
import {
  createPaperAttachmentFailure,
  createPaperDownloadFailure,
  createPaperMutationFailure,
  decodePaperAttachmentResult,
  decodePaperDownloadResult,
  decodePaperIdRequest,
  decodePaperMutationResult,
} from '../engine/runtime/PaperRuntimeContract.js';
import {
  createApprovalMutationFailure,
  decodeApprovalMutationResult,
  decodeApprovalRequestView,
  decodeApprovalRuleToggleRequest,
  decodeApprovalRuleViews,
  decodeApprovalResponseRequest,
  type ApprovalRequestView,
} from '../engine/runtime/ApprovalRuntimeContract.js';
import {
  createResearchMutationRecovery,
  decodeResearchArtifactVersionListResult,
  decodeResearchArtifactVersionRequest,
  decodeResearchArtifactVersionResult,
  decodeResearchCheckpointListResult,
  decodeResearchCheckpointRequest,
  decodeResearchCheckpointResult,
  decodeResearchCrudRequest,
  decodeResearchDecisionListResult,
  decodeResearchDecisionRequest,
  decodeResearchEntityListResult,
  decodeResearchEntityResult,
  decodeResearchLinkListResult,
  decodeResearchLinkRequest,
  decodeResearchMutationResult,
  decodeResearchRestoreRequest,
  decodeResearchReviewRequest,
  decodeResearchSnapshotRequest,
  decodeResearchSnapshotResult,
  type ResearchArtifactVersionRequest,
  type ResearchCheckpointRequest,
  type ResearchCrudRequest,
  type ResearchDecisionRequest,
  type ResearchLinkRequest,
  type ResearchRestoreRequest,
  type ResearchReviewRequest,
  type ResearchSnapshotRequest,
} from '../engine/runtime/ResearchRuntimeContract.js';
import {
  decodeExperimentDelete,
  decodeExperimentList,
  decodeExperimentMutationResult,
  decodeExperimentSave,
} from '../engine/runtime/ExperimentMetadataContract.js';
import {
  ExperimentIdSchema,
  decodeExperimentExecutionGrantRequest,
  decodeExperimentExecutionGrantResult,
  decodeExperimentRunRequest,
  decodeExperimentRunResult,
  decodeExperimentScriptAttachRequest,
  decodeExperimentScriptAttachResult,
} from '../engine/runtime/ExperimentRuntimeContract.js';
import {
  decodeResearchMediaAttachRequest,
  decodeResearchMediaAttachResult,
  decodeResearchMediaPurgeRequest,
  decodeResearchMediaPurgeResult,
  type ResearchMediaAttachRequest,
  type ResearchMediaPurgeRequest,
} from '../engine/runtime/ResearchMediaRuntimeContract.js';
import {
  SETUP_RUNTIME_CONTRACT_VERSION,
  SetupAbortResponseSchema,
  decodeSetupAbortRequest,
  decodeSetupProbeResponse,
  decodeSetupProgressEvent,
  decodeSetupRestoreRequest,
  decodeSetupRestoreResponse,
  decodeSetupSaveRequest,
  decodeSetupSaveResponse,
  type SetupAbortRequest,
  type SetupProbeRequest,
  type SetupProgressEvent,
  type SetupRestoreRequest,
  type SetupSaveRequest,
  decodeSettingsProviderProbeRequest,
  type SettingsProviderProbeRequest,
} from '../engine/runtime/SetupRuntimeContract.js';
import {
  createProviderProfileListRecovery,
  createProviderProfileMutationRecovery,
  decodeProviderProfileDeleteRequest,
  decodeProviderProfileListRequest,
  decodeProviderProfileListResponse,
  decodeProviderProfileMutationResponse,
  decodeProviderProfileResetRequest,
  decodeProviderProfileSaveRequest,
  decodeProviderProfileSwitchRequest,
  type ProviderProfileDeleteRequest,
  type ProviderProfileListRequest,
  type ProviderProfileResetRequest,
  type ProviderProfileSaveRequest,
  type ProviderProfileSwitchRequest,
} from '../engine/runtime/ProviderProfileContract.js';
import {
  createExportFailure,
  decodeExportRequest,
  decodeExportResult,
  type ExportRequest,
} from '../engine/runtime/ExportRuntimeContract.js';
import {
  PersonalizationDeleteRequestSchema,
  PersonalizationForkRequestSchema,
  PersonalizationGetRequestSchema,
  PersonalizationListRequestSchema,
  PersonalizationIntegrityListRequestSchema,
  PersonalizationIntegrityRecoverRequestSchema,
  PersonalizationTrashListRequestSchema,
  PersonalizationResolveRequestSchema,
  PersonalizationRestoreRequestSchema,
  PersonalizationTrashRestoreRequestSchema,
  PersonalizationVersionsRequestSchema,
  PersonalizationSaveRequestSchema,
  decodePersonalizationGetResponse,
  decodePersonalizationListResponse,
  decodePersonalizationIntegrityListResponse,
  decodePersonalizationTrashListResponse,
  decodePersonalizationMutationResult,
  decodePersonalizationResolveResponse,
  decodePersonalizationVersionsResponse,
  type PersonalizationDeleteRequest,
  type PersonalizationForkRequest,
  type PersonalizationGetRequest,
  type PersonalizationListRequest,
  type PersonalizationIntegrityListRequest,
  type PersonalizationIntegrityRecoverRequest,
  type PersonalizationTrashListRequest,
  type PersonalizationResolveRequest,
  type PersonalizationRestoreRequest,
  type PersonalizationTrashRestoreRequest,
  type PersonalizationVersionsRequest,
  type PersonalizationSaveRequest,
  type ScenarioDefinition,
} from '../engine/runtime/PersonalizationRuntimeContract.js';
import type {
  ScenarioHarnessAssessment,
} from '../engine/personalization/ScenarioHarness.js';
import type {
  ScenarioHarnessDiffEntry,
} from '../engine/personalization/ScenarioHarnessCompiler.js';
import {
  PersonalizationExtensionIpcRequestSchema,
  decodePersonalizationExtensionResponse,
  type PersonalizationExtensionIpcRequest,
} from '../engine/runtime/PersonalizationExtensionContract.js';
import {
  PersonalizationBundleExportIpcRequestSchema,
  PersonalizationBundleImportIpcRequestSchema,
  decodePersonalizationBundleIpcResponse,
  type PersonalizationBundleExportIpcRequest,
  type PersonalizationBundleImportIpcRequest,
} from '../engine/runtime/PersonalizationBundleContract.js';
import {
  PersonalizationSecretListRequestSchema,
  PersonalizationSecretRemoveRequestSchema,
  PersonalizationSecretSetRequestSchema,
  decodePersonalizationSecretListResponse,
  decodePersonalizationSecretRemoveResponse,
  decodePersonalizationSecretSetResponse,
  type PersonalizationSecretListRequest,
  type PersonalizationSecretRemoveRequest,
  type PersonalizationSecretSetRequest,
} from '../engine/runtime/PersonalizationSecretContract.js';
import {
  FundingTemplateIpcRequestSchema,
  decodeFundingTemplateRuntimeResponse,
  type FundingTemplateIpcRequest,
} from '../engine/runtime/FundingTemplateRuntimeContract.js';
import {
  McpActivationIpcRequestSchema,
  decodeMcpActivationResponse,
  type McpActivationIpcRequest,
} from '../engine/runtime/McpActivationContract.js';
import {
  AgentControlRequestSchema,
  decodeAgentControlResponse,
  type AgentControlRequest,
} from '../engine/runtime/LiveSteeringContract.js';
import {
  ScenarioRunControlRequestSchema,
  decodeScenarioRunControlResponse,
  type ScenarioRunControlRequest,
} from '../engine/runtime/ScenarioControlContract.js';
import {
  TerminalCreateRequestSchema,
  TerminalDataEventSchema,
  TerminalExitEventSchema,
  TerminalKillRequestSchema,
  TerminalResizeRequestSchema,
  TerminalWriteRequestSchema,
  createTerminalFailure,
  decodeTerminalCreateResult,
  decodeTerminalGrantResult,
  decodeTerminalOperationResult,
  type TerminalCreateRequest,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalKillRequest,
  type TerminalResizeRequest,
  type TerminalWriteRequest,
} from '../engine/runtime/TerminalRuntimeContract.js';
import {
  createLibraryMutationFailure,
  decodeLibraryCollection,
  decodeLibraryCollectionList,
  decodeLibraryDeleteRequest,
  decodeLibraryMutationResult,
  decodeLibraryNote,
  decodeLibraryNoteList,
  decodeLibraryPaperList,
  decodeLibraryPaperSaveRequest,
} from '../engine/runtime/LibraryRuntimeContract.js';
import {
  createProjectMemoryMutationFailure,
  decodeProjectMemoryMutationResult,
  decodeProjectMemoryWriteRequest,
} from '../engine/runtime/MemoryRuntimeContract.js';
import {
  createWorkspaceAgentsFailure,
  createWorkspaceAgentsViewEmpty,
  decodeWorkspaceAgentsGetRequest,
  decodeWorkspaceAgentsMutationResult,
  decodeWorkspaceAgentsView,
  decodeWorkspaceAgentsWriteRequest,
} from '../engine/runtime/WorkspaceAgentsContract.js';
import {
  createSettingsMutationFailure,
  decodeSettingsMutationResult,
  decodeSettingsUpdateRequest,
  decodeSettingsView,
} from '../engine/runtime/SettingsRuntimeContract.js';
import {
  CurrentAffairsResearchRequestSchema,
  CurrentAffairsApproveRequestSchema,
  CurrentAffairsExportRequestSchema,
  CurrentAffairsCancelRequestSchema,
  CurrentAffairsListSourcesRequestSchema,
  SourceReviewRequestSchema,
  decodeCurrentAffairsResearchResponse,
  decodeCurrentAffairsApproveResponse,
  decodeCurrentAffairsExportResponse,
  decodeCurrentAffairsCancelResponse,
  decodeCurrentAffairsListSourcesResponse,
  decodeSourceReviewResponse,
  type CurrentAffairsResearchRequest,
  type CurrentAffairsApproveRequest,
  type CurrentAffairsExportRequest,
  type CurrentAffairsCancelRequest,
  type CurrentAffairsListSourcesRequest,
  type SourceReviewRequest,
} from '../engine/runtime/CurrentAffairsRuntimeContract.js';
import {
  createEvalRunFailure,
  decodeEvalRunRequest,
  decodeEvalRunResult,
} from '../engine/runtime/EvalRuntimeContract.js';

type GoalStepStartEvent = Extract<GoalLiveEvent, { type: 'step-start' }>;
type GoalStepCompleteEvent = Extract<GoalLiveEvent, { type: 'step-complete' }>;
type GoalStepFailedEvent = Extract<GoalLiveEvent, { type: 'step-failed' }>;
type GoalProgressEvent = Extract<GoalLiveEvent, { type: 'progress' }>;

// Autonomous research live event subtypes (typed narrowing for subscribers).
type AutonomousEngineStartedEvent = Extract<AutonomousLiveEvent, { type: 'engine-started' }>;
type AutonomousEngineFailedEvent = Extract<AutonomousLiveEvent, { type: 'engine-failed' }>;
type AutonomousPhaseStartedEvent = Extract<AutonomousLiveEvent, { type: 'phase-started' }>;
type AutonomousStepEvent = Extract<AutonomousLiveEvent, { type: 'step-start' | 'step-complete' | 'step-failed' }>;
type AutonomousReflectionEvent = Extract<AutonomousLiveEvent, { type: 'reflection' }>;
type AutonomousProgressEvent = Extract<AutonomousLiveEvent, { type: 'progress' }>;
type AutonomousEngineCompletedEvent = Extract<AutonomousLiveEvent, { type: 'engine-completed' }>;
type AutonomousEngineInterruptedEvent = Extract<AutonomousLiveEvent, { type: 'engine-interrupted' }>;
type AutonomousEnginePausedEvent = Extract<AutonomousLiveEvent, { type: 'engine-paused' }>;
type AutonomousEngineResumedEvent = Extract<AutonomousLiveEvent, { type: 'engine-resumed' }>;

async function invokeSetupWithProgress<T>(
  channel: 'setup:probe' | 'setup:save',
  request: SetupProbeRequest | SetupSaveRequest | SettingsProviderProbeRequest,
  decodeResponse: (input: unknown) => T,
  onProgress?: (event: SetupProgressEvent) => void,
): Promise<T> {
  const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
    const progress = decodeSetupProgressEvent(raw);
    if (progress?.operationId === request.operationId) onProgress?.(progress);
  };
  ipcRenderer.on('setup:progress', handler);
  try {
    return decodeResponse(await ipcRenderer.invoke(channel, request));
  } finally {
    ipcRenderer.removeListener('setup:progress', handler);
  }
}

import { submissionBridge } from './preload/submissionBridge.js';
import { outcomeBridge } from './preload/outcomeBridge.js';
import { topicBridge } from './preload/topicBridge.js';
import { freeModelBridge } from './preload/freeModelBridge.js';
import { systemBridge } from './preload/systemBridge.js';
const api = {
  ...submissionBridge,
  ...outcomeBridge,
  ...topicBridge,
  ...freeModelBridge,
  ...systemBridge,
  // ── Acceptance Environment ───────────────────────────────
  acceptanceEnvironment: () => ipcRenderer.invoke('acceptance:environment') as Promise<
    | { enabled: false }
    | {
        enabled: true;
        userDataPath: string;
        entryPath: string;
        tokenSha256: string;
      }
  >,
  acceptanceSetWindowSize: (request: {
    mode: 'outer' | 'content';
    width: number;
    height: number;
  }) => ipcRenderer.invoke('acceptance:window:setSize', request) as Promise<{
    mode: 'outer' | 'content';
    requested: { width: number; height: number };
    outerBounds: { x: number; y: number; width: number; height: number };
    contentBounds: { x: number; y: number; width: number; height: number };
    zoomFactor: number;
    display: {
      id: string;
      scaleFactor: number;
      bounds: { x: number; y: number; width: number; height: number };
      workArea: { x: number; y: number; width: number; height: number };
    };
    maximized: boolean;
    fullScreen: boolean;
  }>,
  acceptanceReleaseWindowControl: () =>
    ipcRenderer.invoke('acceptance:window:release') as Promise<{ released: true }>,

  // ── Store ──────────────────────────────────────────────
  storeReady: () => ipcRenderer.invoke('store:ready'),
  startupStatus: () => ipcRenderer.invoke('startup:status') as Promise<{ ready: boolean; storeReady: boolean }>,
  runtimeIdentity: () => ipcRenderer.invoke('runtime:identity') as Promise<{
    buildId: 'metis-alpha2-release';
    appVersion: string;
    mode: 'development' | 'packaged';
    sourceRoot: string;
    mainEntry: string;
    rendererEntry: string;
    dataDir: string;
    electronVersion: string;
    startedAt: number;
  }>,

  setupProbe: async (
    rawRequest: SettingsProviderProbeRequest,
    onProgress?: (event: SetupProgressEvent) => void,
  ) => {
    const decoded = decodeSettingsProviderProbeRequest(rawRequest);
    if (!decoded.ok) return decodeSetupProbeResponse(null);
    return invokeSetupWithProgress(
      'setup:probe',
      decoded.value,
      decodeSetupProbeResponse,
      onProgress,
    );
  },
  setupSave: async (
    rawRequest: SetupSaveRequest,
    onProgress?: (event: SetupProgressEvent) => void,
  ) => {
    const request = decodeSetupSaveRequest(rawRequest);
    if (!request.ok) return decodeSetupSaveResponse(null);
    return invokeSetupWithProgress(
      'setup:save',
      request.value,
      decodeSetupSaveResponse,
      onProgress,
    );
  },
  setupRestore: async (rawRequest: SetupRestoreRequest) => {
    const request = decodeSetupRestoreRequest(rawRequest);
    if (!request.ok) return decodeSetupRestoreResponse(null);
    return decodeSetupRestoreResponse(await ipcRenderer.invoke('setup:restore', request.value));
  },
  setupAbort: async (rawRequest: SetupAbortRequest) => {
    const request = decodeSetupAbortRequest(rawRequest);
    const fallback = {
      version: SETUP_RUNTIME_CONTRACT_VERSION,
      operationId: 'setup-recovery',
      success: false,
      code: 'setup_operation_not_found',
    } as const;
    if (!request.ok) return fallback;
    const parsed = SetupAbortResponseSchema.safeParse(
      await ipcRenderer.invoke('setup:abort', request.value),
    );
    return parsed.success ? parsed.data : fallback;
  },

  // Persistent research workspace (Project, Source, Evidence, NoteCode,
  // Claim and Artifact). Requests and responses are independently decoded on
  // both sides of the context-isolated bridge.
  researchListProjects: async (options: { includeDeleted?: boolean; limit?: number; offset?: number } = {}) => {
    const request = decodeResearchCrudRequest({
      operation: 'list',
      entityKind: 'project',
      projectId: 'project-list',
      includeDeleted: options.includeDeleted ?? false,
      limit: options.limit ?? 100,
      offset: options.offset ?? 0,
    });
    if (!request.ok) return decodeResearchEntityListResult(null);
    return decodeResearchEntityListResult(
      await ipcRenderer.invoke('research:crud', request.value),
    );
  },
  researchCrud: async (rawRequest: ResearchCrudRequest) => {
    const request = decodeResearchCrudRequest(rawRequest);
    if (!request.ok) return createResearchMutationRecovery();
    const raw = await ipcRenderer.invoke('research:crud', request.value) as unknown;
    if (request.value.operation === 'get') return decodeResearchEntityResult(raw);
    if (request.value.operation === 'list') return decodeResearchEntityListResult(raw);
    return decodeResearchMutationResult(raw);
  },
  researchLink: async (rawRequest: ResearchLinkRequest) => {
    const request = decodeResearchLinkRequest(rawRequest);
    if (!request.ok) return createResearchMutationRecovery();
    const raw = await ipcRenderer.invoke('research:link', request.value) as unknown;
    return request.value.operation === 'list_links'
      ? decodeResearchLinkListResult(raw)
      : decodeResearchMutationResult(raw);
  },
  researchReview: async (rawRequest: ResearchReviewRequest) => {
    const request = decodeResearchReviewRequest(rawRequest);
    if (!request.ok) return createResearchMutationRecovery();
    return decodeResearchMutationResult(
      await ipcRenderer.invoke('research:review', request.value),
    );
  },
  researchRestore: async (rawRequest: ResearchRestoreRequest) => {
    const request = decodeResearchRestoreRequest(rawRequest);
    if (!request.ok) return createResearchMutationRecovery();
    return decodeResearchMutationResult(
      await ipcRenderer.invoke('research:restore', request.value),
    );
  },
  researchVersion: async (rawRequest: ResearchArtifactVersionRequest) => {
    const request = decodeResearchArtifactVersionRequest(rawRequest);
    if (!request.ok) return createResearchMutationRecovery();
    const raw = await ipcRenderer.invoke('research:version', request.value) as unknown;
    if (request.value.operation === 'get_version') return decodeResearchArtifactVersionResult(raw);
    if (request.value.operation === 'list_versions') return decodeResearchArtifactVersionListResult(raw);
    return decodeResearchMutationResult(raw);
  },
  researchCheckpoint: async (rawRequest: ResearchCheckpointRequest) => {
    const request = decodeResearchCheckpointRequest(rawRequest);
    if (!request.ok) return createResearchMutationRecovery();
    const raw = await ipcRenderer.invoke('research:checkpoint', request.value) as unknown;
    if (request.value.operation === 'latest_checkpoint') return decodeResearchCheckpointResult(raw);
    if (request.value.operation === 'list_checkpoints') return decodeResearchCheckpointListResult(raw);
    return decodeResearchMutationResult(raw);
  },
  researchDecision: async (rawRequest: ResearchDecisionRequest) => {
    const request = decodeResearchDecisionRequest(rawRequest);
    if (!request.ok) return createResearchMutationRecovery();
    const raw = await ipcRenderer.invoke('research:decision', request.value) as unknown;
    if (request.value.operation === 'list_decisions') return decodeResearchDecisionListResult(raw);
    return decodeResearchMutationResult(raw);
  },
  researchSnapshot: async (rawRequest: ResearchSnapshotRequest) => {
    const request = decodeResearchSnapshotRequest(rawRequest);
    if (!request.ok) return decodeResearchSnapshotResult(null);
    return decodeResearchSnapshotResult(
      await ipcRenderer.invoke('research:snapshot', request.value),
    );
  },
  researchMediaAttach: async (rawRequest: ResearchMediaAttachRequest) => {
    const request = decodeResearchMediaAttachRequest(rawRequest);
    if (!request) return decodeResearchMediaAttachResult(null);
    return decodeResearchMediaAttachResult(
      await ipcRenderer.invoke('research:mediaAttach', request),
    );
  },
  researchMediaPurge: async (rawRequest: ResearchMediaPurgeRequest) => {
    const request = decodeResearchMediaPurgeRequest(rawRequest);
    if (!request) return decodeResearchMediaPurgeResult(null);
    return decodeResearchMediaPurgeResult(
      await ipcRenderer.invoke('research:mediaPurge', request),
    );
  },

  // ── Current Affairs (strict decode) ─────────────────────
  currentAffairsResearch: async (raw: CurrentAffairsResearchRequest) => {
    const req = CurrentAffairsResearchRequestSchema.safeParse(raw);
    if (!req.success) return decodeCurrentAffairsResearchResponse(null);
    const result = await ipcRenderer.invoke('ca:research', req.data);
    return decodeCurrentAffairsResearchResponse(result);
  },
  currentAffairsApprove: async (raw: CurrentAffairsApproveRequest) => {
    const req = CurrentAffairsApproveRequestSchema.safeParse(raw);
    if (!req.success) return decodeCurrentAffairsApproveResponse(null);
    const result = await ipcRenderer.invoke('ca:approve', req.data);
    return decodeCurrentAffairsApproveResponse(result);
  },
  currentAffairsExport: async (raw: CurrentAffairsExportRequest) => {
    const req = CurrentAffairsExportRequestSchema.safeParse(raw);
    if (!req.success) return decodeCurrentAffairsExportResponse(null);
    const result = await ipcRenderer.invoke('ca:export', req.data);
    return decodeCurrentAffairsExportResponse(result);
  },
  currentAffairsCancel: async (raw: CurrentAffairsCancelRequest) => {
    const req = CurrentAffairsCancelRequestSchema.safeParse(raw);
    if (!req.success) return decodeCurrentAffairsCancelResponse(null);
    const result = await ipcRenderer.invoke('ca:cancel', req.data);
    return decodeCurrentAffairsCancelResponse(result);
  },
  currentAffairsReviewSource: async (raw: SourceReviewRequest) => {
    const req = SourceReviewRequestSchema.safeParse(raw);
    if (!req.success) return decodeSourceReviewResponse(null);
    return decodeSourceReviewResponse(await ipcRenderer.invoke('ca:review-source', req.data));
  },
  currentAffairsListSources: async (raw: CurrentAffairsListSourcesRequest) => {
    const req = CurrentAffairsListSourcesRequestSchema.safeParse(raw);
    if (!req.success) return decodeCurrentAffairsListSourcesResponse(null);
    return decodeCurrentAffairsListSourcesResponse(await ipcRenderer.invoke('ca:list-sources', req.data));
  },

  // ── Session ────────────────────────────────────────────
  createSession: async (sessionId: string, projectId?: string) => {
    const decoded = decodeSessionCreateRequest({ sessionId, ...(projectId ? { projectId } : {}) });
    if (!decoded.ok) return decodeSessionMutationResult(null);
    return decodeSessionMutationResult(
      await ipcRenderer.invoke('session:create', decoded.value),
    );
  },
  listSessions: async (request?: { projectId?: string; includeArchived?: boolean }) => {
    // 多对话架构(2026-09-04):支持 projectId 过滤;契约仍严格校验。
    const decoded = decodeSessionListRequest(request ?? {});
    if (!decoded.ok) return createSessionListRecovery();
    return decodeSessionListResponse(
      await ipcRenderer.invoke('session:list', decoded.value),
    );
  },
  deleteSession: async (sessionId: string) => {
    const decoded = decodeSessionDeleteRequest({ sessionId });
    if (!decoded.ok) return decodeSessionMutationResult(null);
    return decodeSessionMutationResult(
      await ipcRenderer.invoke('session:delete', decoded.value),
    );
  },
  updateSession: async (
    sessionId: string,
    patch: SessionUpdateRequest['patch'],
  ) => {
    const decoded = decodeSessionUpdateRequest({ sessionId, patch });
    if (!decoded.ok) return decodeSessionMutationResult(null);
    return decodeSessionMutationResult(
      await ipcRenderer.invoke('session:update', decoded.value),
    );
  },
  createArtifact: async (record: Record<string, unknown>) => {
    const decoded = decodeArtifactCreateRequest(record);
    if (!decoded.ok) return decodeArtifactMutationResult(null);
    return decodeArtifactMutationResult(await ipcRenderer.invoke('artifact:create', decoded.value));
  },
  listArtifacts: async (sessionId: string) => {
    if (!RuntimeIdSchema.safeParse(sessionId).success) return createArtifactListRecovery();
    return decodeArtifactListResponse(await ipcRenderer.invoke('artifact:list', sessionId));
  },
  getArtifactContent: async (sessionId: string, artifactId: string) => {
    const decoded = decodeArtifactContentRequest({ sessionId, artifactId });
    if (!decoded.ok) return decodeArtifactContentResponse(null);
    return decodeArtifactContentResponse(
      await ipcRenderer.invoke('artifact:get-content', decoded.value),
    );
  },
  deleteArtifact: async (id: string) => {
    if (!RuntimeIdSchema.safeParse(id).success) return decodeArtifactMutationResult(null);
    return decodeArtifactMutationResult(await ipcRenderer.invoke('artifact:delete', id));
  },
  onArtifactCreated: (callback: (data: import('../engine/runtime/ArtifactRuntimeContract.js').ArtifactCreatedNotification) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeArtifactCreatedNotification(data);
      if (decoded.ok) callback(decoded.value);
    };
    ipcRenderer.on('artifact:created', handler);
    return () => { ipcRenderer.removeListener('artifact:created', handler); };
  },

  // ── Messages ───────────────────────────────────────────
  getMessages: async (sessionId: string) =>
    decodeHistoryItems(await ipcRenderer.invoke('messages:get', sessionId)),
  appendMessage: (sessionId: string, role: string, content: string) => {
    const decoded = decodeStoredHistoryEntry({ role, content });
    if (decoded.kind === 'recovery') return Promise.resolve(-1);
    return ipcRenderer.invoke('messages:append', sessionId, role, content);
  },

  // ── Eval ───────────────────────────────────────────────
  runEvalSuite: async (profile: unknown) => {
    const request = decodeEvalRunRequest({ profile });
    if (!request) return createEvalRunFailure();
    return decodeEvalRunResult(await ipcRenderer.invoke('eval:runSuite', request));
  },

  // ── LaTeX ────────────────────────────────────────────────
  compileLatex: async (source: string, bib?: string) => {
    const request = decodeLatexCompileRequest({ source, bibliography: bib });
    if (!request.ok) return createLatexCompileRecovery();
    return decodeLatexCompileResponse(
      await ipcRenderer.invoke('latex:compile', request.value.source, request.value.bibliography),
    );
  },

  useFileCapability: async (request: unknown) => {
    const decoded = decodeFileCapabilityUseRequest(request);
    if (!decoded.ok) return createFileCapabilityFailure();
    return decodeFileCapabilityUseResult(
      await ipcRenderer.invoke('fileCapability:use', decoded.value),
    );
  },

  // ── Shell ────────────────────────────────────────────────
  selectFileCapability: async (purpose: FileCapabilityPurpose) => {
    const request = decodeFileCapabilitySelectionRequest({ purpose });
    if (!request) return createFileCapabilityFailure();
    return decodeFileCapabilitySelectionResult(
      await ipcRenderer.invoke('fileCapability:select', request),
    );
  },
  importFileCapability: async (request: unknown) => {
    const decoded = decodeFileCapabilityImportRequest(request);
    if (!decoded) return createFileCapabilityFailure();
    return decodeFileCapabilitySelectionResult(
      await ipcRenderer.invoke('fileCapability:import', decoded),
    );
  },
  selectExportDestination: async () => decodeFileCapabilitySelectionResult(
    await ipcRenderer.invoke('export:selectDestination'),
  ),
  previewResearchExport: async (rawRequest: ExportRequest) => {
    const request = decodeExportRequest(rawRequest);
    if (!request.ok) return createExportFailure();
    return decodeExportResult(await ipcRenderer.invoke('export:preview', request.value));
  },
  executeResearchExport: async (rawRequest: ExportRequest) => {
    const request = decodeExportRequest(rawRequest);
    if (!request.ok) return createExportFailure();
    return decodeExportResult(await ipcRenderer.invoke('export:execute', request.value));
  },

  openExternal: (rawUrl: string) => {
    const decision = inspectExternalNavigationUrl(rawUrl);
    if (!decision.ok) {
      return Promise.resolve({ success: false, error: 'External link blocked' });
    }
    return ipcRenderer.invoke('shell:openExternal', decision.url);
  },

  // ── Settings ───────────────────────────────────────────
  getSettings: async () => decodeSettingsView(await ipcRenderer.invoke('settings:get')),
  markSetupSkipped: async () => ipcRenderer.invoke('settings:markSetupSkipped') as Promise<{ ok: boolean; error?: string }>,
  checkForUpdates: async () => ipcRenderer.invoke('update:check') as Promise<unknown>,
  getUpdateStatus: async () => ipcRenderer.invoke('update:status') as Promise<unknown>,
  downloadUpdate: async () => ipcRenderer.invoke('update:download') as Promise<unknown>,
  installUpdate: async () => ipcRenderer.invoke('update:install') as Promise<unknown>,
  getHealthReport: async () => ipcRenderer.invoke('diagnostics:healthReport') as Promise<unknown>,
  exportDiagnosticBundle: async () => ipcRenderer.invoke('diagnostics:exportBundle') as Promise<{ ok: boolean; path?: string; sha256?: string; entries?: number; error?: string }>,

  linkPaperToProject: async (request: { paperId: string; projectId: string; link?: boolean }) => ipcRenderer.invoke('paper:linkToProject', request) as Promise<{ ok: boolean; error?: string }>,
  exportProject: async (request: { projectId: string; destPath?: string }) =>
    ipcRenderer.invoke('project:export', request) as Promise<{ ok: boolean; path?: string; error?: string; manifest?: unknown }>,
  importProject: async (request: { archivePath: string; projectId?: string; overwrite?: boolean }) =>
    ipcRenderer.invoke('project:import', request) as Promise<{ ok: boolean; projectId?: string; error?: string; restored?: unknown }>,
  listProjects: async () => ipcRenderer.invoke('project:list') as Promise<
    | { success: true; projects: Array<{ id: string; title: string; updatedAt: number; archivedAt: number | null }> }
    | { success: false; code: string }
  >,
  // ── O13: 项目级 provider/model 覆盖 ──
  getProjectProviderOverride: async (projectId: string) =>
    ipcRenderer.invoke('project:getProviderOverride', projectId) as Promise<
      { ok: true; override: import('../engine/runtime/ProviderProfileContract.js').ProjectProviderOverride | null }
      | { ok: false; code: string }
    >,
  setProjectProviderOverride: async (request: {
    projectId: string;
    override: import('../engine/runtime/ProviderProfileContract.js').ProjectProviderOverride | null;
  }) =>
    ipcRenderer.invoke('project:setProviderOverride', request) as Promise<{ ok: boolean; code?: string }>,
  pickProjectArchive: async () => ipcRenderer.invoke('project:pickArchive') as Promise<{ canceled: boolean; path?: string }>,
  // ── Storage location (user-configurable data directory) ──
  storageGetLocation: async () => ipcRenderer.invoke('storage:getLocation') as Promise<{
    ok: boolean;
    dataDir?: string;
    defaultDir?: string;
    usingDefault?: boolean;
    error?: string;
  }>,

  storageSetLocation: async (target: string) => ipcRenderer.invoke('storage:setLocation', target) as Promise<{
    ok: boolean;
    restarting?: boolean;
    dataDir?: string;
    error?: string;
  }>,

  browserShow: async (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('browser:show', bounds) as Promise<{ ok: boolean; error?: string }>,
  browserHide: async () => ipcRenderer.invoke('browser:hide') as Promise<{ ok: boolean; error?: string }>,
  browserSetBounds: async (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('browser:setBounds', bounds) as Promise<{ ok: boolean; error?: string }>,
  // 任务2：可显式声明本次导航归属的项目（供 AI 消费浏览器上下文前校验）。
  browserNavigate: async (url: string, projectId?: string | null) =>
    ipcRenderer.invoke('browser:navigate', projectId ? { url, projectId } : url) as Promise<{ ok: boolean; url?: string; error?: string }>,
  browserBack: async () => ipcRenderer.invoke('browser:back') as Promise<{ ok: boolean; error?: string }>,
  browserForward: async () => ipcRenderer.invoke('browser:forward') as Promise<{ ok: boolean; error?: string }>,
  browserReload: async () => ipcRenderer.invoke('browser:reload') as Promise<{ ok: boolean; error?: string }>,
  browserStop: async () => ipcRenderer.invoke('browser:stop') as Promise<{ ok: boolean; error?: string }>,
  browserFocusRenderer: async () => ipcRenderer.invoke('browser:focusRenderer') as Promise<{ ok: boolean; error?: string }>,
  // ── 协同对话（第三方 AI 网页版 WebContentsView） ──
  collabShow: async (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('collab:show', bounds) as Promise<{ ok: boolean; error?: string }>,
  collabHide: async () => ipcRenderer.invoke('collab:hide') as Promise<{ ok: boolean; error?: string }>,
  collabSetBounds: async (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke('collab:setBounds', bounds) as Promise<{ ok: boolean; error?: string }>,
  collabNavigate: async (url: string) => ipcRenderer.invoke('collab:navigate', url) as Promise<{ ok: boolean; url?: string; error?: string }>,
  // ── Chatbot Context Bridge（2026-09-05 刘总规格书）──
  // METIS→Chatbot：把剪贴板内容粘贴进第三方 AI 页面（自动填入路径）。
  collabPaste: async () =>
    ipcRenderer.invoke('collab:paste') as Promise<{ ok: boolean; error?: string }>,
  // Chatbot→METIS：只读捕获选区原文；失败如实返回（渲染层走剪贴板 fallback）。
  collabCaptureSelection: async () =>
    ipcRenderer.invoke('collab:captureSelection') as Promise<{ ok: boolean; text?: string; error?: string }>,

  collabGetState: async () =>
    ipcRenderer.invoke('collab:getState') as Promise<{ ok: boolean; error?: string; state?: { url: string; title: string } }>,
  // 外部模型引用（外部参考·非证据）：确认卡通过后才调用 add。
  externalRefAdd: async (reference: Record<string, unknown>) =>
    ipcRenderer.invoke('externalRef:add', reference) as Promise<{
      ok: boolean; issues?: string[]; reference?: { v: 1; id: string; model: string; url: string; quotedText: string; contextDigest: string; capturedAt: number; projectId: string | null; sessionId: string | null }; duplicate?: boolean;
    }>,
  // 任务2 上下文隔离：读取必须显式给 projectId/sessionId（空 scope 返回
  // scope_required）；仅管理/审计页可传 global:true 浏览全量。
  externalRefList: async (query: { projectId?: string; sessionId?: string; limit?: number; global?: boolean } = {}) =>
    ipcRenderer.invoke('externalRef:list', query) as Promise<{
      ok: boolean; error?: string; references?: Array<{ v: 1; id: string; model: string; url: string; quotedText: string; contextDigest: string; capturedAt: number; projectId: string | null; sessionId: string | null }>;
    }>,
  externalRefRemove: async (id: string) =>
    ipcRenderer.invoke('externalRef:remove', id) as Promise<{ ok: boolean; error?: string }>,
  // ── 内置文献检索 ──
  literatureSearch: async (request: { query: string; sources: Array<'ncpssd' | 'openalex'>; page?: number; pageSize?: number; coreOnly?: boolean }) =>
    ipcRenderer.invoke('literature:search', request) as Promise<{
      ok: boolean;
      code?: string;
      recovery?: string;
      results?: Array<{
        id: string;
        source: 'ncpssd' | 'openalex';
        title: string;
        authors: string[];
        year: number;
        venue: string;
        abstract: string;
        doi?: string;
        url?: string;
        pdfUrl?: string;
        citationCount?: number;
        tags: string[];
        core: boolean;
      }>;
      total?: number;
      warnings?: string[];
    }>,
  // ── Background job queue (T10): long tasks like PDF full-text extraction ──
  listJobs: async () => ipcRenderer.invoke('jobs:list') as Promise<Array<{
    id: string;
    kind: string;
    label: string;
    status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
    progress: number;
    progressNote: string;
    error: string | null;
    finishedAt: number | null;
  }>>,
  cancelJob: async (jobId: string) => ipcRenderer.invoke('jobs:cancel', jobId) as Promise<{ ok: boolean }>,
  retryJob: async (jobId: string) => ipcRenderer.invoke('jobs:retry', jobId) as Promise<{ ok: boolean }>,
  extractBacklog: async () => ipcRenderer.invoke('jobs:extractBacklog') as Promise<{ ok: boolean; jobId: string | null }>,
  getResumeBrief: async (projectId: string) => ipcRenderer.invoke('research:resumeBrief', projectId) as Promise<{
    projectId: string;
    generatedAt: number;
    lastActivityAt: number | null;
    openTasks: number;
    runningTasks: number;
    lastCompletedTask: string | null;
    lastRunStatus: string | null;
    lastRunAt: number | null;
    artifactCount: number;
    lastArtifactTitle: string | null;
    lastArtifactAt: number | null;
    paperCount: number;
    lastPaperTitle: string | null;
    summaryText: string;
  } | null>,
  getProjectStage: async (projectId: string) => ipcRenderer.invoke('research:getStage', projectId) as Promise<string | null>,
  setProjectStage: async (projectId: string, stage: string) =>
    ipcRenderer.invoke('research:setStage', { projectId, stage }) as Promise<{ ok: boolean }>,
  archiveProject: async (projectId: string) => ipcRenderer.invoke('research:archiveProject', projectId) as Promise<{ ok: boolean; error?: string }>,
  restoreProject: async (projectId: string) => ipcRenderer.invoke('research:restoreProject', projectId) as Promise<{ ok: boolean; restoredLifecycle?: string; error?: string }>,
  deleteProject: async (projectId: string) => ipcRenderer.invoke('research:deleteProject', projectId) as Promise<{ ok: boolean }>,
  openDirectoryDialog: async () => ipcRenderer.invoke('dialog:openDirectory') as Promise<string | null>,
  setProjectDir: async (projectId: string, projectDir: string) => ipcRenderer.invoke('research:setProjectDir', { projectId, projectDir }) as Promise<{ ok: boolean }>,

  skillStudioGenerate: async (request: { experience: string; source: 'from_scratch' | 'from_experience' | 'from_files' | 'from_session' }) => (
    ipcRenderer.invoke('skillStudio:generate', request) as Promise<{ ok: boolean; code?: string; message?: string; skill?: Record<string, unknown> }>
  ),
  skillStudioTestRun: async (request: { systemPrompt: string; allowedTools: string[]; message: string }) => (
    ipcRenderer.invoke('skillStudio:testRun', request) as Promise<{ ok: boolean; status?: string; answer?: string; message?: string }>
  ),
  officePromptCapabilities: async () => (
    ipcRenderer.invoke('officePrompt:capabilities') as Promise<Array<{ kind: string; label: string; profileCount: number; defaultProfileId: string | null; aiEnabled: boolean }>>
  ),
  officePromptProfiles: async (officeKind: string) => (
    ipcRenderer.invoke('officePrompt:profiles', { officeKind }) as Promise<Array<{ id: string; officeKind: string; name: string; description: string; builtin: boolean; slots: Record<string, string>; deletedAt: number | null; createdAt: number; updatedAt: number }>>
  ),
  officePromptCreateProfile: async (request: { officeKind: string; name: string; description?: string; fromProfileId?: string }) => (
    ipcRenderer.invoke('officePrompt:createProfile', request) as Promise<{ ok: boolean; code?: string; profile?: Record<string, unknown> }>
  ),
  officePromptUpdateProfile: async (request: { profileId: string; name?: string; description?: string }) => (
    ipcRenderer.invoke('officePrompt:updateProfile', request) as Promise<Record<string, unknown> | null>
  ),
  officePromptDeleteProfile: async (profileId: string) => (
    ipcRenderer.invoke('officePrompt:deleteProfile', { profileId }) as Promise<boolean>
  ),
  officePromptDeletedProfiles: async (officeKind: string) =>
    ipcRenderer.invoke('officePrompt:deletedProfiles', { officeKind }) as Promise<Array<Record<string, unknown>>>,
  officePromptRestoreProfile: async (profileId: string) => (
    ipcRenderer.invoke('officePrompt:restoreProfile', { profileId }) as Promise<Record<string, unknown> | null>
  ),
  officePromptGetGlobal: async (request: { officeKind: string; outcomeId?: string | null }) =>
    ipcRenderer.invoke('officePrompt:getGlobal', request) as Promise<string | null>,
  officePromptSetGlobal: async (request: { profileId: string; content: string }) =>
    ipcRenderer.invoke('officePrompt:setGlobal', request) as Promise<Record<string, unknown> | null>,
  officePromptSetSlot: async (request: { profileId: string; slotId: string; content: string }) => (
    ipcRenderer.invoke('officePrompt:setSlot', request) as Promise<{ ok: boolean; code?: string }>
  ),
  officePromptSetDefault: async (request: { officeKind: string; profileId: string }) => (
    ipcRenderer.invoke('officePrompt:setDefault', request) as Promise<{ ok: boolean; code?: string }>
  ),
  officePromptGetBinding: async (outcomeId: string) =>
    ipcRenderer.invoke('officePrompt:getBinding', { outcomeId }) as Promise<string | null>,
  officePromptBindOutcome: async (request: { outcomeId: string; profileId: string | null }) => (
    ipcRenderer.invoke('officePrompt:bindOutcome', request) as Promise<{ ok: boolean }>
  ),
  officePromptResolveSlot: async (request: { officeKind: string; outcomeId?: string | null; slotId: string }) => (
    ipcRenderer.invoke('officePrompt:resolveSlot', request) as Promise<{ content: string | null }>
  ),

  getDefaultScenario: async (projectId: string) => (
    ipcRenderer.invoke('projects:getDefaultScenario', { projectId }) as Promise<{ scenarioId: string | null }>
  ),
  setDefaultScenario: async (projectId: string, scenarioId: string | null) => (
    ipcRenderer.invoke('projects:setDefaultScenario', { projectId, scenarioId }) as Promise<{ ok: boolean }>
  ),
  detectStage: async (projectId: string) => ipcRenderer.invoke('research:detectStage', projectId) as Promise<{ stage: string; rationale: string[] } | null>,
  // ── Method library (T4): reusable research workflows ──
  listMethods: async () => ipcRenderer.invoke('methods:list') as Promise<Array<{
    id: string;
    name: string;
    description: string;
    params: Record<string, string>;
    steps: Array<{ template: string }>;
    confirmEachStep: boolean;
    sourceProjectId: string | null;
    createdAt: number;
    updatedAt: number;
    runCount: number;
    lastRunAt: number | null;
  }>>,
  createMethod: async (request: { name: string; description?: string; steps: Array<{ template: string }>; confirmEachStep?: boolean; sourceProjectId?: string | null }) =>
    ipcRenderer.invoke('methods:create', request) as Promise<{ id: string } | null>,
  updateMethod: async (request: { id: string; name?: string; description?: string; steps?: Array<{ template: string }>; confirmEachStep?: boolean }) =>
    ipcRenderer.invoke('methods:update', request) as Promise<{ id: string } | null>,
  deleteMethod: async (methodId: string) => ipcRenderer.invoke('methods:delete', methodId) as Promise<boolean>,
  renderMethod: async (methodId: string, params: Record<string, string>) =>
    ipcRenderer.invoke('methods:render', { id: methodId, params }) as Promise<Array<{ instruction: string }> | null>,
  recordMethodRun: async (request: { id: string; projectId: string | null; params: Record<string, string>; outcome: 'applied' | 'cancelled' }) =>
    ipcRenderer.invoke('methods:recordRun', request) as Promise<void>,
  // ── Submission tracking (T20) ──
  listSubmissions: async (projectId?: string) => ipcRenderer.invoke('submissions:list', projectId ?? null) as Promise<Array<{
    id: string;
    projectId: string | null;
    artifactId: string | null;
    title: string;
    journal: string;
    status: 'submitted' | 'under_review' | 'revise' | 'accepted' | 'published' | 'rejected';
    submittedAt: number;
    updatedAt: number;
    comments: Array<{ id: string; text: string; resolved: boolean; revisionNote: string; createdAt: number }>;
    notes: string;
  }>>,

  previewSubmissionMail: async (request: {
    accountId: string; to: string; cc?: string; bcc?: string; subject: string; bodyText: string;
    attachments?: Array<{ filename: string; path?: string; contentBase64?: string }>;
  }) =>
    ipcRenderer.invoke('submission:mail:preview', request) as Promise<{ ok: true; preview: {
      accountId: string; accountLabel: string; from: string; to: string; cc: string; bcc: string;
      subject: string; bodyText: string;
      attachments: Array<{ filename: string; source: 'content' | 'path' | 'empty' }>;
      smtp: { host: string; port: number; secure: boolean } | null;
    } } | { ok: false; code: string; message: string } | null>,
  sendSubmissionMail: async (request: {
    projectId: string; caseId?: string; accountId: string; operationId: string;
    to: string; cc?: string; bcc?: string; subject: string; bodyText: string;
    attachments?: Array<{ filename: string; path?: string; contentBase64?: string }>;
    confirmed: true;
  }) =>
    ipcRenderer.invoke('submission:mail:send', request) as Promise<{ ok: true; alreadySent: boolean; record: import('../engine/submission/SubmissionCorrespondenceContract.js').SubmissionCorrespondence; messageId?: string } | { ok: false; code: string; message: string } | null>,

  onSubmissionMailChanged: (callback: (notification: { at: number; items: Array<{ projectId: string; records: Array<{ id: string; subject: string; classification: string; caseId: string | null }> }> }) => void) => {
    const listener = (_event: unknown, notification: Parameters<typeof callback>[0]) => callback(notification);
    ipcRenderer.on('submission:mail:changed', listener);
    return () => { ipcRenderer.removeListener('submission:mail:changed', listener); };
  },

  listWatchSubscriptions: async () => ipcRenderer.invoke('watch:list') as Promise<Array<{
    id: string;
    query: string;
    sources: Array<'ncpssd' | 'openalex'>;
    coreOnly: boolean;
    createdAt: number;
    lastCheckedAt: number | null;
    lastNewCount: number;
  }>>,
  addWatchSubscription: async (request: { query: string; sources?: Array<'ncpssd' | 'openalex'>; coreOnly?: boolean }) =>
    ipcRenderer.invoke('watch:add', request) as Promise<{ id: string } | null>,
  removeWatchSubscription: async (id: string) => ipcRenderer.invoke('watch:remove', id) as Promise<boolean>,
  checkWatchNow: async (id: string) => ipcRenderer.invoke('watch:checkNow', id) as Promise<{ ok: boolean; newCount: number; error?: string }>,
  // ── PDF bulk import (T26) ──
  importPdfFiles: async (files: string[]) => ipcRenderer.invoke('import:pdfFiles', files) as Promise<{ ok: boolean; imported: number; enriched: number; error?: string }>,
  openPdfDialog: async () => ipcRenderer.invoke('dialog:openPdf') as Promise<string[]>,
  // ── Research agenda (T24) ──
  getAgendaState: async () => ipcRenderer.invoke('agenda:getState') as Promise<{
    queue: Array<{ projectId: string; title: string; runsCompleted: number; maxRuns: number; enqueuedAt: number; autonomous?: boolean; goalPrompt?: string }>;
    autoContinue: boolean;
    cooldownMs: number;
    lastAdvanceAt: number | null;
  }>,
  enqueueAgenda: async (request: { projectId: string; title: string; maxRuns?: number }) =>
    ipcRenderer.invoke('agenda:enqueue', request) as Promise<{ projectId: string } | { error: string }>,
  removeAgenda: async (projectId: string) => ipcRenderer.invoke('agenda:remove', projectId) as Promise<boolean>,
  moveAgenda: async (projectId: string, direction: 'up' | 'down') => ipcRenderer.invoke('agenda:move', { projectId, direction }) as Promise<boolean>,
  setAgendaAutoContinue: async (enabled: boolean) => ipcRenderer.invoke('agenda:setAutoContinue', enabled) as Promise<{ autoContinue: boolean }>,
  reportAgendaCompletion: async (request: { projectId: string; success: boolean }) =>
    ipcRenderer.invoke('agenda:reportCompletion', request) as Promise<{ action: string; projectId: string | null; waitMs?: number; note: string }>,
  decideAgendaNext: async () => ipcRenderer.invoke('agenda:decideNext') as Promise<{ action: string; projectId: string | null; waitMs?: number; note: string }>,
  enqueueAgendaBatch: async (request: { entries: Array<{ key: string; title: string; goalPrompt: string }>; maxRuns?: number }) =>
    ipcRenderer.invoke('agenda:enqueueBatch', request) as Promise<{ added: number }>,
  // ── Autonomous profile & batch topics (自主改造 A/B) ──
  getAutonomousProfile: async () => ipcRenderer.invoke('autonomousProfile:get') as Promise<{
    version: 1;
    defaultPrompt: string;
    defaultBatchSize: number;
    injectUserProfile: boolean;
    constraints: {
      fieldPreference: string;
      methodPreference: 'any' | 'quantitative' | 'qualitative' | 'mixed';
      outputForm: 'any' | 'journal_article' | 'report';
      journalTier: 'any' | 'core' | 'general';
      language: 'zh' | 'en';
      lengthTarget: string;
      customRules: string[];
    };
  }>,
  saveAutonomousProfile: async (request: Record<string, unknown>) => ipcRenderer.invoke('autonomousProfile:save', request) as Promise<{ version: 1 }>,
  getAutonomousHardRules: async () => ipcRenderer.invoke('autonomousProfile:hardRules') as Promise<string[]>,
  generateAutonomousBatch: async (request: { prompt: string; count: number; method?: 'any' | 'quantitative' | 'qualitative' | 'mixed'; output?: 'any' | 'journal_article' | 'report' }) =>
    ipcRenderer.invoke('autonomous:generateBatch', request) as Promise<{
      ok: boolean; error?: string; added?: number; raw?: string;
      topics?: Array<{ title: string; researchQuestion: string; rationale: string }>;
    }>,
  createProjectForAutonomous: async (request: { title: string; researchQuestion?: string }) =>
    ipcRenderer.invoke('autonomous:createProjectFor', request) as Promise<{ ok: boolean; projectId: string | null }>,
  // ── Concept graph (T28) ──
  getConceptGraph: async (projectId: string) => ipcRenderer.invoke('concept:getGraph', projectId) as Promise<{
    nodes: Array<{ id: string; kind: 'source' | 'code' | 'claim'; label: string }>;
    edges: Array<{ from: string; to: string; kind: 'supports' | 'coded' }>;
  } | null>,
  // ── Local rolling backups (task 1 §八：受控恢复，完整重启语义) ──
  listBackups: async () => ipcRenderer.invoke('backup:list') as Promise<{ backups: Array<{ path: string; name: string }> }>,
  restoreBackup: async (backupPath: string) => ipcRenderer.invoke('backup:restore', { backupPath }) as Promise<{ ok: boolean; error?: string; rollback?: string }>,
  // ── WebDAV cloud backup (T33) ──
  getCloudSyncConfig: async () => ipcRenderer.invoke('cloudSync:getConfig') as Promise<{ configured: boolean; url?: string; username?: string }>,
  saveCloudSyncConfig: async (request: { url: string; username: string; password: string }) =>
    ipcRenderer.invoke('cloudSync:saveConfig', request) as Promise<{ ok: boolean }>,
  clearCloudSyncConfig: async () => ipcRenderer.invoke('cloudSync:clearConfig') as Promise<{ ok: boolean }>,
  testCloudSync: async () => ipcRenderer.invoke('cloudSync:test') as Promise<{ ok: boolean; error?: string }>,
  backupToCloud: async () => ipcRenderer.invoke('cloudSync:backup') as Promise<{ ok: boolean; objectName?: string; error?: string }>,
  listCloudBackups: async () => ipcRenderer.invoke('cloudSync:listBackups') as Promise<string[]>,
  stageCloudRestore: async (objectName: string) => ipcRenderer.invoke('cloudSync:stageRestore', objectName) as Promise<{ ok: boolean; error?: string }>,
  importIssnList: async () => ipcRenderer.invoke('settings:importIssnList') as Promise<{ ok: boolean; added: number; totalCandidates?: number; error?: string }>,
  onJobsChanged: (callback: (jobs: Array<{ id: string; kind: string; label: string; status: string; progress: number; progressNote: string; error: string | null; finishedAt: number | null }>) => void): (() => void) => {
    const handler = (_event: unknown, jobs: Parameters<typeof callback>[0]) => callback(jobs);
    ipcRenderer.on('jobs:changed', handler as never);
    return () => { ipcRenderer.removeListener('jobs:changed', handler as never); };
  },
  browserState: async () => ipcRenderer.invoke('browser:state') as Promise<{
    ok: boolean;
    state?: { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean };
    error?: string;
  }>,
  browserClick: async (x: number, y: number) => ipcRenderer.invoke('browser:click', { x, y }) as Promise<{ ok: boolean; error?: string }>,
  browserType: async (text: string) => ipcRenderer.invoke('browser:type', text) as Promise<{ ok: boolean; error?: string }>,
  browserKey: async (keyCode: string) => ipcRenderer.invoke('browser:key', keyCode) as Promise<{ ok: boolean; error?: string }>,
  browserScroll: async (deltaX: number, deltaY: number) => ipcRenderer.invoke('browser:scroll', { deltaX, deltaY }) as Promise<{ ok: boolean; error?: string }>,
  browserScreenshot: async () => ipcRenderer.invoke('browser:screenshot') as Promise<{ ok: boolean; imageBase64?: string; error?: string }>,
  browserExtract: async () => ipcRenderer.invoke('browser:extract') as Promise<{
    ok: boolean;
    page?: { title: string; text: string; url: string; links: string[] };
    error?: string;
  }>,
  browserCollect: async () => ipcRenderer.invoke('browser:collect') as Promise<{
    ok: boolean;
    paper?: { paperId: string; merged: boolean; title: string; doi?: string; metaSource?: 'complete' | 'crossref_enriched' | 'meta_only' | 'webpage' };
    error?: string;
  }>,
  browserListDownloads: async () => ipcRenderer.invoke('browser:listDownloads') as Promise<{
    ok: boolean;
    downloads: Array<{ id: string; url: string; filename: string; mimeType: string; pageUrl: string; pageTitle: string }>;
    error?: string;
  }>,
  browserAcceptDownload: async (id: string, projectId: string | null) =>
    ipcRenderer.invoke('browser:acceptDownload', { id, projectId }) as Promise<{ ok: boolean; savedPath?: string; paperId?: string; error?: string }>,
  browserCancelDownload: async (id: string) => ipcRenderer.invoke('browser:cancelDownload', id) as Promise<{ ok: boolean; error?: string }>,
  onBrowserState: (callback: (state: { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }) => void): (() => void) => {
    const handler = (_event: unknown, state: unknown) => callback(state as Parameters<typeof callback>[0]);
    ipcRenderer.on('browser:state', handler);
    return () => { ipcRenderer.removeListener('browser:state', handler); };
  },
  onBrowserDownloadRequest: (callback: (download: { id: string; url: string; filename: string; mimeType: string; pageUrl: string; pageTitle: string }) => void): (() => void) => {
    const handler = (_event: unknown, download: unknown) => callback(download as Parameters<typeof callback>[0]);
    ipcRenderer.on('browser:download-request', handler);
    return () => { ipcRenderer.removeListener('browser:download-request', handler); };
  },

  loadPaperDetail: async (paperId: string) => ipcRenderer.invoke('data:loadPaperDetail', { paperId }) as Promise<{ found: boolean; paper?: unknown }>,
  searchPapersFullText: async (query: string, limit?: number) => ipcRenderer.invoke('papers:searchFullText', query, limit) as Promise<{ results: Array<{ id: string; title: string; snippet: string }> }>,
  aiExplainPaper: async (request: { passage: string; paperTitle?: string; action?: 'explain' | 'translate' | 'summarize' }) => ipcRenderer.invoke('papers:aiExplain', request) as Promise<{ ok: boolean; text?: string; error?: string }>,
  aiSynthesis: async (request: { mode?: 'synthesis' | 'compare' | 'report'; papers: Array<{ title: string; authors: string[]; year: number; venue: string; abstract: string }> }) => ipcRenderer.invoke('papers:aiSynthesis', request) as Promise<{ ok: boolean; text?: string; error?: string }>,
  aiPolishLatex: async (request: { text: string; action?: 'polish' | 'rewrite' | 'expand' }) => ipcRenderer.invoke('latex:aiPolish', request) as Promise<{ ok: boolean; text?: string; error?: string }>,

  providerProfilesList: async (rawRequest: ProviderProfileListRequest) => {
    const request = decodeProviderProfileListRequest(rawRequest);
    if (!request.ok) return createProviderProfileListRecovery(rawRequest);
    return decodeProviderProfileListResponse(
      await ipcRenderer.invoke('providerProfiles:list', request.value),
      request.value.operationId,
    );
  },
  providerProfilesSave: async (rawRequest: ProviderProfileSaveRequest) => {
    const request = decodeProviderProfileSaveRequest(rawRequest);
    if (!request.ok) return createProviderProfileMutationRecovery(rawRequest);
    return decodeProviderProfileMutationResponse(
      await ipcRenderer.invoke('providerProfiles:save', request.value),
      request.value.operationId,
    );
  },
  providerProfilesSwitch: async (rawRequest: ProviderProfileSwitchRequest) => {
    const request = decodeProviderProfileSwitchRequest(rawRequest);
    if (!request.ok) return createProviderProfileMutationRecovery(rawRequest);
    return decodeProviderProfileMutationResponse(
      await ipcRenderer.invoke('providerProfiles:switch', request.value),
      request.value.operationId,
    );
  },
  providerProfilesDelete: async (rawRequest: ProviderProfileDeleteRequest) => {
    const request = decodeProviderProfileDeleteRequest(rawRequest);
    if (!request.ok) return createProviderProfileMutationRecovery(rawRequest);
    return decodeProviderProfileMutationResponse(
      await ipcRenderer.invoke('providerProfiles:delete', request.value),
      request.value.operationId,
    );
  },
  providerProfilesReset: async (rawRequest: ProviderProfileResetRequest) => {
    const request = decodeProviderProfileResetRequest(rawRequest);
    if (!request.ok) return createProviderProfileMutationRecovery(rawRequest);
    return decodeProviderProfileMutationResponse(
      await ipcRenderer.invoke('providerProfiles:reset', request.value),
      request.value.operationId,
    );
  },

  setSettings: async (config: unknown) => {
    const request = decodeSettingsUpdateRequest(config);
    if (!request) return createSettingsMutationFailure('secure_setup_required');
    return decodeSettingsMutationResult(await ipcRenderer.invoke('settings:set', request));
  },

  // ── Agent ──────────────────────────────────────────────
  agentStatus: () => ipcRenderer.invoke('agent:status'),
  agentChat: async (sessionId: string, messages: unknown[], skillId: string | undefined, rawOptions: AgentChatOptions) => {
    const options = AgentChatOptionsSchema.safeParse(rawOptions);
    if (!options.success) return decodeAgentResponse(null);
    return decodeAgentResponse(await ipcRenderer.invoke('agent:chat', sessionId, messages, skillId, options.data));
  },
  /**
   * O15: 多模型同会话对比——用指定 provider profile 跑一个临时对话回合。
   * 主进程用 ProviderProfileStore.configFor(profileId) 构建临时 provider /
   * AgentLoop，响应契约与 agentChat 完全一致（AgentResponse）；区别是该路径
   * 不在主进程落库，对比消息的持久化由渲染端统一负责，避免 N 个 profile
   * 各写一遍用户消息。
   */
  agentChatWithProfile: async (profileId: string, sessionId: string, messages: unknown[], skillId: string | undefined, rawOptions: AgentChatOptions) => {
    const options = AgentChatOptionsSchema.safeParse(rawOptions);
    if (!options.success) return decodeAgentResponse(null);
    return decodeAgentResponse(await ipcRenderer.invoke('agent:chatWithProfile', profileId, sessionId, messages, skillId, options.data));
  },
  agentControl: async (rawRequest: AgentControlRequest) => {
    const request = AgentControlRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodeAgentControlResponse(null);
    return decodeAgentControlResponse(
      await ipcRenderer.invoke('agent:control', request.data),
      request.data.operationId,
    );
  },
  /**
   * Public Scenario run control: pause persists a durable paused checkpoint
   * (the next turn resumes it); cancel moves the run to terminal cancelled.
   */
  scenarioControl: async (rawRequest: ScenarioRunControlRequest) => {
    const request = ScenarioRunControlRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodeScenarioRunControlResponse(null);
    return decodeScenarioRunControlResponse(
      await ipcRenderer.invoke('scenario:control', request.data),
      request.data.operationId,
    );
  },
  /**
   * 步骤卡控制（2026-09-01 刘总方案二期）：对运行的某一步「指导重做/跳过」。
   * 落库成功后前端补发「继续」即可触发断点恢复。
   */
  scenarioStepControl: async (request: { sessionId: string; stepId: string; action: 'redo' | 'skip'; guidance?: string }) => (
    ipcRenderer.invoke('scenario:stepControl', request) as Promise<
      { ok: true; runId: string; message: string } | { ok: false; code: string; message: string }
    >
  ),
  /**
   * Metis Office 关闭自动同步事件（2026-09-01 刘总要求）：编辑器进程退出时
   * 主进程自动同步（有改动建新版本/无改动安静收尾）并推送结果。
   * 返回取消订阅函数。
   */
  onOutcomeExternalEditorAutoSync: (callback: (payload: {
    projectId: string; outcomeId: string; ok: boolean; changed: boolean;
    version?: number; title?: string; code?: string; message?: string;
  }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof callback>[0]) => callback(payload);
    ipcRenderer.on('outcomes:external-editor:auto-sync', listener);
    return () => { ipcRenderer.removeListener('outcomes:external-editor:auto-sync', listener); };
  },

  // ── Papers ─────────────────────────────────────────────
  listPapers: async () => decodeLibraryPaperList(await ipcRenderer.invoke('paper:list')),
  savePaper: async (paper: unknown) => {
    const request = decodeLibraryPaperSaveRequest(paper);
    if (!request) return createLibraryMutationFailure();
    return decodeLibraryMutationResult(await ipcRenderer.invoke('paper:save', request));
  },
  deletePaper: async (id: string) => {
    const request = decodeLibraryDeleteRequest({ id });
    if (!request) return createLibraryMutationFailure();
    return decodeLibraryMutationResult(await ipcRenderer.invoke('paper:delete', request.id));
  },
  attachPaperPdf: async (paperId: string) => {
    const request = decodePaperIdRequest({ paperId });
    if (!request.ok) return createPaperAttachmentFailure();
    return decodePaperAttachmentResult(await ipcRenderer.invoke('paper:attachPdf', request.value));
  },
  detachPaperPdf: async (paperId: string) => {
    const request = decodePaperIdRequest({ paperId });
    if (!request.ok) return createPaperMutationFailure();
    return decodePaperMutationResult(await ipcRenderer.invoke('paper:detachPdf', request.value));
  },
  downloadPaperPdf: async (paperId: string) => {
    const request = decodePaperIdRequest({ paperId });
    if (!request.ok) return createPaperDownloadFailure();
    return decodePaperDownloadResult(await ipcRenderer.invoke('paper:downloadPdf', request.value));
  },
  reconcilePaper: async (request: { paperId: string; doi?: string; title?: string }) =>
    ipcRenderer.invoke('paper:reconcile', request) as Promise<{
      ok: boolean;
      paper?: { title: string; authors: string[]; year: number; venue: string; doi?: string; abstract?: string };
      error?: string;
    }>,

  // ── Collections ────────────────────────────────────────
  listCollections: async () => decodeLibraryCollectionList(await ipcRenderer.invoke('collection:list')),
  saveCollection: async (collection: unknown) => {
    const request = decodeLibraryCollection(collection);
    if (!request) return createLibraryMutationFailure();
    return decodeLibraryMutationResult(await ipcRenderer.invoke('collection:save', request));
  },
  deleteCollection: async (id: string) => {
    const request = decodeLibraryDeleteRequest({ id });
    if (!request) return createLibraryMutationFailure();
    return decodeLibraryMutationResult(await ipcRenderer.invoke('collection:delete', request.id));
  },

  // ── Notes ──────────────────────────────────────────────
  listNotes: async () => decodeLibraryNoteList(await ipcRenderer.invoke('note:list')),
  saveNote: async (note: unknown) => {
    const request = decodeLibraryNote(note);
    if (!request) return createLibraryMutationFailure();
    return decodeLibraryMutationResult(await ipcRenderer.invoke('note:save', request));
  },
  deleteNote: async (id: string) => {
    const request = decodeLibraryDeleteRequest({ id });
    if (!request) return createLibraryMutationFailure();
    return decodeLibraryMutationResult(await ipcRenderer.invoke('note:delete', request.id));
  },

  saveExperiment: async (input: unknown) => {
    const request = decodeExperimentSave(input);
    if (!request) return decodeExperimentMutationResult({
      success: false,
      code: 'experiment_metadata_invalid',
    });
    return decodeExperimentMutationResult(await ipcRenderer.invoke('experiment:save', request));
  },
  deleteExperiment: async (id: string) => {
    const requestId = decodeExperimentDelete({ id });
    if (!requestId) return decodeExperimentMutationResult({
      success: false,
      code: 'experiment_metadata_invalid',
    });
    return decodeExperimentMutationResult(
      await ipcRenderer.invoke('experiment:delete', { id: requestId }),
    );
  },
  // ── Experiments secure execution (GLM-102) ────────────────
  attachExperimentScript: async (experimentId: string) => {
    const request = decodeExperimentScriptAttachRequest({ experimentId });
    return decodeExperimentScriptAttachResult(
      request
        ? await ipcRenderer.invoke('experiment:attachScript', request)
        : undefined,
    );
  },
  requestExperimentRunGrant: async (experimentId: string) => {
    const request = decodeExperimentExecutionGrantRequest({ experimentId });
    return decodeExperimentExecutionGrantResult(
      request
        ? await ipcRenderer.invoke('experiment:requestRunGrant', request)
        : undefined,
    );
  },
  runExperiment: async (input: { experimentId: string; grant: unknown }) => {
    const request = decodeExperimentRunRequest(input);
    return decodeExperimentRunResult(
      request ? await ipcRenderer.invoke('experiment:run', request) : undefined,
    );
  },
  cancelExperiment: async (experimentId: string) => {
    const parsed = ExperimentIdSchema.safeParse(experimentId);
    if (!parsed.success) return false;
    return (await ipcRenderer.invoke('experiment:cancel', parsed.data)) === true;
  },

  loadAllData: async () => {
    const raw = await ipcRenderer.invoke('data:loadAll') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { papers: [], notes: [], experiments: [], collections: [] };
    }
    const data = raw as Record<string, unknown>;
    return {
      papers: Array.isArray(data.papers)
        ? data.papers.flatMap((item) => {
            const parsed = decodeLibraryPaperSaveRequest(item);
            return parsed && !(parsed as Record<string, unknown>).pdfPath && !(parsed as Record<string, unknown>).owner
              ? [parsed]
              : [];
          })
        : [],
      notes: Array.isArray(data.notes) ? data.notes : [],
      experiments: decodeExperimentList(data.experiments),
      collections: Array.isArray(data.collections) ? data.collections : [],
    };
  },

  setProjectMemory: async (content: string) => {
    const request = decodeProjectMemoryWriteRequest({ content });
    if (!request) return createProjectMemoryMutationFailure();
    return decodeProjectMemoryMutationResult(await ipcRenderer.invoke('memory:setProject', request));
  },

  getWorkspaceAgents: async (projectId: string) => {
    const request = decodeWorkspaceAgentsGetRequest({ projectId });
    if (!request) return createWorkspaceAgentsViewEmpty();
    return decodeWorkspaceAgentsView(await ipcRenderer.invoke('workspace:agents:get', request));
  },
  setWorkspaceAgents: async (projectId: string, content: string, expectedVersion: number) => {
    const request = decodeWorkspaceAgentsWriteRequest({ projectId, content, expectedVersion });
    if (!request) return createWorkspaceAgentsFailure('content_invalid');
    return decodeWorkspaceAgentsMutationResult(
      await ipcRenderer.invoke('workspace:agents:set', request),
    );
  },

  openOutcomeInGenoffice: async (raw: unknown) => { const p=OutcomeExternalEditorOpenRequestSchema.safeParse(raw); if (!p.success) return OutcomeExternalEditorOpenResultSchema.parse({ ok:false, code:'invalid_request', message:'GenOffice 编辑请求无效。' }); const result=OutcomeExternalEditorOpenResultSchema.safeParse(await ipcRenderer.invoke('outcomes:external-editor:open',p.data)); return result.success ? result.data : OutcomeExternalEditorOpenResultSchema.parse({ ok:false, code:'genoffice_open_failed', message:'GenOffice 编辑器打开失败。' }); },
  syncOutcomeFromGenoffice: async (raw: unknown) => { const p=OutcomeExternalEditorSyncRequestSchema.safeParse(raw); if (!p.success) return OutcomeExternalEditorSyncResultSchema.parse({ ok:false, code:'invalid_request', message:'GenOffice 同步请求无效。' }); const result=OutcomeExternalEditorSyncResultSchema.safeParse(await ipcRenderer.invoke('outcomes:external-editor:sync',p.data)); return result.success ? result.data : OutcomeExternalEditorSyncResultSchema.parse({ ok:false, code:'outcome_save_failed', message:'GenOffice 同步失败，当前成果没有被修改。' }); },
  closeOutcomeGenofficeEditor: async (raw: unknown) => { const p=OutcomeExternalEditorCloseRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:external-editor:close', p.data) as Promise<boolean> : false; },
  stateOutcomeGenofficeEditor: async (raw: unknown) => { const p=OutcomeExternalEditorStateRequestSchema.safeParse(raw); if (!p.success) return OutcomeExternalEditorStateSchema.parse({ exists: false, changed: false, session: null }); const result=OutcomeExternalEditorStateSchema.safeParse(await ipcRenderer.invoke('outcomes:external-editor:state', p.data)); return result.success ? result.data : OutcomeExternalEditorStateSchema.parse({ exists: false, changed: false, session: null }); },
  genofficeEmbeddedSetBounds: async (raw: unknown) => { try { return Boolean(await ipcRenderer.invoke('genoffice-embedded:set-bounds', raw)); } catch { return false; } },
  genofficeEmbeddedSetVisible: async (raw: unknown) => { try { return Boolean(await ipcRenderer.invoke('genoffice-embedded:set-visible', raw)); } catch { return false; } },
  genofficeEmbeddedFocus: async (raw: unknown) => { try { return Boolean(await ipcRenderer.invoke('genoffice-embedded:focus', raw)); } catch { return false; } },

  listScopedConversation: async (raw: unknown) => { const p=ScopedConversationRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:conversation:list',p.data) : []; },
  appendScopedConversation: async (raw: unknown) => { const p=ScopedConversationMessageRequestSchema.safeParse(raw); return p.success ? ipcRenderer.invoke('outcomes:conversation:append',p.data) : null; },
  chatOutcomeAssistant: async (raw: unknown) => { const p=OutcomeAssistantChatRequestSchema.safeParse(raw); if (!p.success) return OutcomeAssistantChatResultSchema.parse({ status:'error', code:'invalid_request', message:'成果助手请求无效。', answer:'', sources:[], diagnostics:[{code:'invalid_request',message:'成果助手请求未通过契约校验。'}] }); const value=await ipcRenderer.invoke('outcomes:assistant:chat',p.data); const result=OutcomeAssistantChatResultSchema.safeParse(value); return result.success ? result.data : OutcomeAssistantChatResultSchema.parse({ status:'error', code:'assistant_unavailable', message:'成果助手响应无效，请重试。', answer:'', sources:[], diagnostics:[{code:'assistant_unavailable',message:'主进程返回了无效的成果助手响应。'}] }); },

  analyzeFundingTemplateForAssistant: async (projectId: string) =>
    ipcRenderer.invoke('fundingTemplate:analyzeForAssistant', { projectId }) as Promise<{
      ok: boolean; message?: string; templateId?: string; summary?: string;
    }>,
  // 项目参考材料库（2026-09-01 刘总要求）：上传/列表/删除/改大类。
  projectMaterialImportDialog: async (request: { projectId: string; category?: string }) =>
    ipcRenderer.invoke('scenario:material:importDialog', request) as Promise<{
      ok: boolean; error?: string; imported?: Array<{ id: string; name: string; category: string; charCount: number }>; errors?: Array<{ name: string; error: string }>;
    }>,
  projectMaterialList: async (projectId: string) =>
    ipcRenderer.invoke('scenario:material:list', { projectId }) as Promise<{
      ok: boolean; error?: string; materials?: Array<{ id: string; name: string; category: string; charCount: number; addedAt: number; binaryArchive?: string }>;
    }>,
  projectMaterialDelete: async (id: string) =>
    ipcRenderer.invoke('scenario:material:delete', { id }) as Promise<{ ok: boolean; error?: string }>,
  projectMaterialSetCategory: async (request: { id: string; category: string }) =>
    ipcRenderer.invoke('scenario:material:setCategory', request) as Promise<{ ok: boolean; error?: string }>,
  // 能力库 Capability Vault（任务7）：入库不注入，绑定才加载。列表接口绝不带出 systemPrompt。
  capabilityVaultSources: async () =>
    ipcRenderer.invoke('capability:vault:sources') as Promise<{
      ok: boolean; error?: string; sources?: Array<{
        id: string; repo: string; name: string; expansion: 'per_skill' | 'single';
        domains: string[]; researchStages: string[]; licenseStatus: 'verified' | 'unverified'; notes?: string; vaultCount: number;
      }>;
    }>,
  capabilityVaultStats: async () =>
    ipcRenderer.invoke('capability:vault:stats') as Promise<{
      ok: boolean; error?: string; stats?: { total: number; skills: number; mcps: number; installed: number; sources: number };
    }>,
  capabilityVaultImportSource: async (sourceId: string) =>
    ipcRenderer.invoke('capability:vault:importSource', sourceId) as Promise<{
      ok: boolean; imported: number; excluded: number; error?: string;
    }>,
  capabilityVaultList: async (query: { keyword?: string; sourceId?: string; kind?: 'skill' | 'mcp'; stage?: string; limit?: number } = {}) =>
    ipcRenderer.invoke('capability:vault:list', query) as Promise<{
      ok: boolean; error?: string; entries?: Array<{
        id: string; kind: 'skill' | 'mcp'; name: string; description: string;
        sourceId: string; sourceRepo: string; originalPath: string;
        license: string | null; licenseStatus: string;
        domains: string[]; researchStages: string[]; tags: string[];
        contentDigest: string; included: boolean; exclusionReason: string | null;
        installedDefinitionId: string | null; importedAt: number; updatedAt: number;
      }>;
    }>,
  capabilityVaultGetDetail: async (id: string) =>
    ipcRenderer.invoke('capability:vault:getDetail', id) as Promise<{
      ok: boolean; error?: string; entry?: { id: string; kind: 'skill' | 'mcp'; name: string; description: string;
        sourceId: string; sourceRepo: string; originalPath: string;
        license: string | null; licenseStatus: string;
        domains: string[]; researchStages: string[]; tags: string[];
        contentDigest: string; included: boolean; exclusionReason: string | null;
        installedDefinitionId: string | null; importedAt: number; updatedAt: number; systemPrompt?: string };
    }>,
  capabilityVaultInstall: async (id: string) =>
    ipcRenderer.invoke('capability:vault:install', id) as Promise<{
      ok: boolean; code?: 'not_found' | 'excluded' | 'already_installed' | 'install_failed'; definitionId?: string; message?: string;
    }>,
  capabilityVaultUninstall: async (id: string) =>
    ipcRenderer.invoke('capability:vault:uninstall', id) as Promise<{ ok: boolean; removed?: boolean; error?: string }>,

  draftFundingOutline: async (request: { projectId: string; templateId: string; materialText?: string }) =>
    ipcRenderer.invoke('fundingTemplate:draftOutline', request) as Promise<{
      ok: boolean; code?: string; message?: string; markdown?: string;
    }>,

  createGoal: async (description: string, context?: string, projectId?: string) =>
    decodeGoalCreateResponse(await ipcRenderer.invoke('goal:create', description, context, projectId)),
  getGoal: async (goalId: string) =>
    decodeGoalSummaryResponse(await ipcRenderer.invoke('goal:get', goalId)),
  // O17: 读取 goal 的工作流定义 + 最新 run 步骤状态（WorkflowGraph 只读可视化）。
  getGoalWorkflow: async (goalId: string) =>
    decodeGoalWorkflowResponse(await ipcRenderer.invoke('goal:getWorkflow', goalId)),
  listGoals: async () => decodeGoalListResponse(await ipcRenderer.invoke('goal:list')),
  generatePlan: async (goalId: string) =>
    decodeGoalPlanResponse(await ipcRenderer.invoke('goal:generatePlan', goalId)),
  refinePlan: async (goalId: string, feedback: string) =>
    decodeGoalPlanResponse(await ipcRenderer.invoke('goal:refinePlan', goalId, feedback)),
  updatePlan: (goalId: string, workflow: Record<string, unknown>) => ipcRenderer.invoke('goal:updatePlan', goalId, workflow),
  executeGoal: async (goalId: string) =>
    decodeGoalExecutionResult(await ipcRenderer.invoke('goal:execute', goalId)),
  pauseGoal: (goalId: string) => ipcRenderer.invoke('goal:pause', goalId),
  resumeGoal: async (goalId: string, fromStepId?: string) =>
    decodeGoalExecutionResult(await ipcRenderer.invoke('goal:resume', goalId, fromStepId)),
  resolveStepDecision: async (goalId: string, action: 'retry' | 'skip' | 'stop') =>
    ipcRenderer.invoke('goal:resolveStepDecision', { goalId, action }) as Promise<{ success: boolean; code?: string }>,
  cancelGoal: (goalId: string) => ipcRenderer.invoke('goal:cancel', goalId),
  getGoalProgress: (goalId: string) => ipcRenderer.invoke('goal:getProgress', goalId),
  archiveGoal: (goalId: string) => ipcRenderer.invoke('goal:archive', goalId),
  listArchives: () => ipcRenderer.invoke('goal:listArchives'),
  updateGoalStatus: async (request: { goalId: string; status: string }) => ipcRenderer.invoke('goal:updateStatus', request) as Promise<{ ok: boolean; error?: string }>,
  updateGoalPriority: async (request: { goalId: string; priority: string }) => ipcRenderer.invoke('goal:updatePriority', request) as Promise<{ ok: boolean; error?: string }>,
  deleteGoal: async (goalId: string) => ipcRenderer.invoke('goal:delete', goalId) as Promise<{ ok: boolean; error?: string }>,

  onGoalStepStart: (callback: (data: GoalStepStartEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeGoalLiveEvent(data);
      if (decoded.ok && decoded.value.type === 'step-start') callback(decoded.value);
    };
    ipcRenderer.on('goal:step:start', handler);
    return () => { ipcRenderer.removeListener('goal:step:start', handler); };
  },
  onGoalStepComplete: (callback: (data: GoalStepCompleteEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeGoalLiveEvent(data);
      if (decoded.ok && decoded.value.type === 'step-complete') callback(decoded.value);
    };
    ipcRenderer.on('goal:step:complete', handler);
    return () => { ipcRenderer.removeListener('goal:step:complete', handler); };
  },
  onGoalStepFailed: (callback: (data: GoalStepFailedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeGoalLiveEvent(data);
      if (decoded.ok && decoded.value.type === 'step-failed') callback(decoded.value);
    };
    ipcRenderer.on('goal:step:failed', handler);
    return () => { ipcRenderer.removeListener('goal:step:failed', handler); };
  },
  onGoalProgress: (callback: (data: GoalProgressEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeGoalLiveEvent(data);
      if (decoded.ok && decoded.value.type === 'progress') callback(decoded.value);
    };
    ipcRenderer.on('goal:progress', handler);
    return () => { ipcRenderer.removeListener('goal:progress', handler); };
  },
  onGoalChanged: (callback: (data: GoalChangedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeGoalChangedEvent(data);
      if (decoded) callback(decoded);
    };
    ipcRenderer.on('goal:changed', handler);
    return () => { ipcRenderer.removeListener('goal:changed', handler); };
  },

  // ── Autonomous research engine ───────────────────────────
  autonomousStart: async (request: { goal: string; projectId?: string; sessionId?: string; strategyId?: string; structureId?: string }) => {
    const decoded = decodeAutonomousStartRequest({ version: AUTONOMOUS_CONTRACT_VERSION, ...request });
    if (!decoded) return { ok: false, error: 'invalid_request' };
    return ipcRenderer.invoke(AUTONOMOUS_CHANNELS.start, decoded) as Promise<{ ok: boolean; sessionId?: string; projectId?: string; error?: string }>;
  },
  autonomousControl: async (request: { sessionId: string; action: 'pause' | 'resume' | 'interrupt'; reason?: string }) => {
    const decoded = decodeAutonomousControlRequest({ version: AUTONOMOUS_CONTRACT_VERSION, ...request });
    if (!decoded) return { ok: false, code: 'invalid_request' };
    return ipcRenderer.invoke(AUTONOMOUS_CHANNELS.control, decoded) as Promise<{ ok: boolean; code?: string }>;
  },
  autonomousListSessions: async () => ipcRenderer.invoke(AUTONOMOUS_CHANNELS.listSessions) as Promise<{
    sessions: Array<{
      sessionId: string;
      goal: string;
      projectId?: string;
      executions: number;
      completedPhases: number;
      savedAt: number;
      state: 'running' | 'paused';
      failureReason?: string;
    }>;
  }>,
  onAutonomousEngineStarted: (callback: (data: AutonomousEngineStartedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeAutonomousLiveEvent(data);
      if (decoded && decoded.type === 'engine-started') callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.engineStarted, handler);
    return () => { ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.engineStarted, handler); };
  },
  onAutonomousPhaseStarted: (callback: (data: AutonomousPhaseStartedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeAutonomousLiveEvent(data);
      if (decoded && decoded.type === 'phase-started') callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.phaseStarted, handler);
    return () => { ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.phaseStarted, handler); };
  },
  onAutonomousStep: (callback: (data: AutonomousStepEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeAutonomousLiveEvent(data);
      if (decoded && (decoded.type === 'step-start' || decoded.type === 'step-complete' || decoded.type === 'step-failed')) callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.stepStart, handler);
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.stepComplete, handler);
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.stepFailed, handler);
    return () => {
      ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.stepStart, handler);
      ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.stepComplete, handler);
      ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.stepFailed, handler);
    };
  },
  onAutonomousReflection: (callback: (data: AutonomousReflectionEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeAutonomousLiveEvent(data);
      if (decoded && decoded.type === 'reflection') callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.reflection, handler);
    return () => { ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.reflection, handler); };
  },
  onAutonomousProgress: (callback: (data: AutonomousProgressEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeAutonomousLiveEvent(data);
      if (decoded && decoded.type === 'progress') callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.progress, handler);
    return () => { ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.progress, handler); };
  },
  onAutonomousCompleted: (callback: (data: AutonomousEngineCompletedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeAutonomousLiveEvent(data);
      if (decoded && decoded.type === 'engine-completed') callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.engineCompleted, handler);
    return () => { ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.engineCompleted, handler); };
  },
  onAutonomousFailed: (callback: (data: AutonomousEngineFailedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      const decoded = decodeAutonomousLiveEvent(raw);
      if (decoded && decoded.type === 'engine-failed') callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.engineFailed, handler);
    return () => ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.engineFailed, handler);
  },
  onAutonomousInterrupted: (callback: (data: AutonomousEngineInterruptedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeAutonomousLiveEvent(data);
      if (decoded && decoded.type === 'engine-interrupted') callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.engineInterrupted, handler);
    return () => { ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.engineInterrupted, handler); };
  },
  onAutonomousPaused: (callback: (data: AutonomousEnginePausedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeAutonomousLiveEvent(data);
      if (decoded && decoded.type === 'engine-paused') callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.enginePaused, handler);
    return () => { ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.enginePaused, handler); };
  },
  onAutonomousResumed: (callback: (data: AutonomousEngineResumedEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeAutonomousLiveEvent(data);
      if (decoded && decoded.type === 'engine-resumed') callback(decoded);
    };
    ipcRenderer.on(AUTONOMOUS_CHANNELS.live.engineResumed, handler);
    return () => { ipcRenderer.removeListener(AUTONOMOUS_CHANNELS.live.engineResumed, handler); };
  },
  autonomousResumeSession: async (sessionId: string) => {
    return ipcRenderer.invoke(AUTONOMOUS_CHANNELS.resumeSession, sessionId) as Promise<{ ok: boolean; goal?: string; error?: string }>;
  },
  strategyList: async () => ipcRenderer.invoke('strategy:list') as Promise<{ ok: boolean; strategies?: Array<Record<string, unknown>> }>,
  strategySave: async (strategy: Record<string, unknown>) => ipcRenderer.invoke('strategy:save', { strategy }) as Promise<{ ok: boolean; error?: string }>,
  strategyDelete: async (strategyId: string) => ipcRenderer.invoke('strategy:delete', { strategyId }) as Promise<{ ok: boolean; error?: string }>,
  strategySetDefault: async (strategyId: string) => ipcRenderer.invoke('strategy:setDefault', { strategyId }) as Promise<{ ok: boolean; error?: string }>,
  structureList: async () => ipcRenderer.invoke('structure:list') as Promise<{ ok: boolean; templates?: Array<Record<string, unknown>> }>,
  structureSave: async (template: Record<string, unknown>) => ipcRenderer.invoke('structure:save', { template }) as Promise<{ ok: boolean; error?: string }>,
  structureDelete: async (templateId: string) => ipcRenderer.invoke('structure:delete', { templateId }) as Promise<{ ok: boolean; error?: string }>,

  // ── Chat streaming ───────────────────────────────────────
  // O15: 对比回合的流式分片额外携带 profileId，渲染端据此把 token 路由到
  // 对应模型的气泡；普通回合不带该字段，行为与之前完全一致。
  onChatStreamChunk: (callback: (data: import('../engine/runtime/ChatRuntimeContract.js').ChatStreamChunkEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
      const decoded = decodeChatStreamChunkEvent(data);
      if (decoded.ok) callback(decoded.value);
    };
    ipcRenderer.on('chat:stream-chunk', handler);
    return () => { ipcRenderer.removeListener('chat:stream-chunk', handler); };
  },
  onAgentExecutionEvent: (callback: (payload: import('../engine/runtime/ChatRuntimeContract.js').AgentExecutionEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      const decoded = decodeAgentExecutionEvent(raw);
      if (decoded.ok) callback(decoded.value);
    };
    ipcRenderer.on('agent:execution-event', handler);
    return () => { ipcRenderer.removeListener('agent:execution-event', handler); };
  },
  replayAgentEvents: async (rawRequest: import('../engine/runtime/ChatRuntimeContract.js').AgentEventReplayRequest) => {
    const request = AgentEventReplayRequestSchema.safeParse(rawRequest);
    if (!request.success) return null;
    const response = AgentEventReplayResponseSchema.safeParse(
      await ipcRenderer.invoke('agent:execution-replay', request.data),
    );
    return response.success ? response.data : null;
  },

  // ── MCP Servers ────────────────────────────────────────
  listMCPServers: () => ipcRenderer.invoke('mcp:list'),
  addMCPServer: (_config: { id: string; name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean }) =>
    (void _config, Promise.resolve({ success: false, code: 'managed_mcp_required' })),
  removeMCPServer: (id: string) => ipcRenderer.invoke('mcp:remove', id),
  toggleMCPServer: (id: string, enabled: boolean) => ipcRenderer.invoke('mcp:toggle', id, enabled),
  testMCPServer: (_config: { command: string; args: string[]; env: Record<string, string> }) =>
    (void _config, Promise.resolve({ success: false, code: 'managed_mcp_required' })),

  // ── Skills ─────────────────────────────────────────────
  listSkills: () => ipcRenderer.invoke('skill:list'),
  getSkill: (id: string) => ipcRenderer.invoke('skill:get', id),
  setActiveSkill: (id: string | null) => ipcRenderer.invoke('skill:setActive', id),
  getActiveSkill: () => ipcRenderer.invoke('skill:getActive'),
  generateSkillFromConversation: async (request: { messages: Array<{ role: string; content: string }>; userIntent?: string }) =>
    ipcRenderer.invoke('skill:generateFromConversation', request) as Promise<{
      ok: boolean;
      error?: string;
      skill?: { id: string; name: string; description: string; systemPrompt: string; allowedTools: string[]; maxTurns: number; rationale: string };
    }>,
  deleteCustomSkill: (id: string) => ipcRenderer.invoke('skill:deleteCustom', id) as Promise<{ ok: boolean; error?: string }>,

  listPersonalization: async (rawRequest: PersonalizationListRequest) => {
    const request = PersonalizationListRequestSchema.safeParse(rawRequest);
    if (!request.success) throw new TypeError('Invalid personalization list request');
    const response = decodePersonalizationListResponse(
      await ipcRenderer.invoke('personalization:list', request.data),
    );
    if (!response.ok) throw new TypeError(`Personalization list failed: ${response.code}`);
    return response;
  },

  listPersonalizationTrash: async (rawRequest: PersonalizationTrashListRequest) => {
    const request = PersonalizationTrashListRequestSchema.safeParse(rawRequest);
    if (!request.success) throw new TypeError('Invalid personalization trash list request');
    const response = decodePersonalizationTrashListResponse(
      await ipcRenderer.invoke('personalization:trash:list', request.data),
    );
    if (!response.ok) throw new TypeError(`Personalization trash list failed: ${response.code}`);
    return response;
  },

  listPersonalizationIntegrityIssues: async (rawRequest: PersonalizationIntegrityListRequest) => {
    const request = PersonalizationIntegrityListRequestSchema.safeParse(rawRequest);
    if (!request.success) throw new TypeError('Invalid personalization integrity request');
    const response = decodePersonalizationIntegrityListResponse(
      await ipcRenderer.invoke('personalization:integrity:list', request.data),
    );
    if (!response.ok) throw new TypeError(`Personalization integrity list failed: ${response.code}`);
    return response;
  },

  recoverPersonalizationIntegrityIssue: async (rawRequest: PersonalizationIntegrityRecoverRequest) => {
    const request = PersonalizationIntegrityRecoverRequestSchema.safeParse(rawRequest);
    if (!request.success) return { ok: false as const, code: 'invalid_request' as const };
    return decodePersonalizationMutationResult(
      await ipcRenderer.invoke('personalization:integrity:recover', request.data),
    );
  },

  aiGenerateScenario: async (rawRequest: unknown) => (
    ipcRenderer.invoke('personalization:aiGenerateScenario', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      message?: string;
      scenario?: { name: string; description: string; triggerPhrases: string[]; deliverable: string };
      agents?: Array<{ name: string; role: string; systemPrompt: string; skillIds: string[]; toolIds: string[]; mcpIds: string[]; maxTurns: number }>;
      workflow?: Array<{ name: string; description: string; agent: string; skillIds: string[]; toolIds: string[]; mcpIds: string[]; maxTurns: number }>;
      rules?: string;
      paperStructure?: Array<{ title: string; instruction: string }> | null;
    }>
  ),
  aiGenerateAgent: async (rawRequest: unknown) => (
    ipcRenderer.invoke('personalization:aiGenerateAgent', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      message?: string;
      agent?: { name: string; description: string; role: string; systemPrompt: string; maxTurns: number };
    }>
  ),
  marketSearch: async (rawRequest: { kind: 'skill' | 'mcp'; query: string; source?: 'github' | 'skillsmp' | 'mcpmarket_cn' | 'mcpworld' }) => (
    ipcRenderer.invoke('market:search', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      source?: 'github' | 'skillsmp' | 'mcpmarket_cn' | 'mcpworld';
      items?: Array<{
        source: 'github' | 'skillsmp' | 'mcpmarket_cn' | 'mcpworld';
        owner: string;
        repo: string;
        name: string;
        description: string;
        stars: number;
        updatedAt: string;
        url: string;
        detailUrl?: string;
        installUrl?: string;
        filePath?: string;
        sourceId?: string;
        installable?: boolean;
        defaultBranch: string;
        topics: string[];
      }>;
      usingToken?: boolean;
    }>
  ),
  marketReadSkillDoc: async (rawRequest: { owner: string; repo: string; ref: string; source?: 'github' | 'skillsmp'; filePath?: string }) => (
    ipcRenderer.invoke('market:readSkillDoc', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      path?: string;
      content?: string;
    }>
  ),
  marketReadMcpDocs: async (rawRequest: { owner: string; repo: string; ref: string; source?: 'github' | 'mcpmarket_cn' | 'mcpworld'; sourceId?: string }) => (
    ipcRenderer.invoke('market:readMcpDocs', rawRequest) as Promise<{
      readme: { ok: boolean; code?: string; path?: string; content?: string };
      packageJson: { ok: boolean; npmPackage?: string };
    }>
  ),
  runScenarioLoopNow: async (rawRequest: { scenarioId: string; loopId: string }) => (
    ipcRenderer.invoke('scenario:loop:run-now', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      runCount?: number;
      error?: string;
    }>
  ),
  onScenarioApprovalRequired: (callback: (payload: { requestId: string; hookId: string; stepId: string; instruction: string; runId: string }) => void) => {
    const listener = (_event: unknown, payload: unknown) => {
      if (payload && typeof payload === 'object' && typeof (payload as { requestId?: unknown }).requestId === 'string') {
        callback(payload as { requestId: string; hookId: string; stepId: string; instruction: string; runId: string });
      }
    };
    ipcRenderer.on('scenario:approval:required', listener);
    return () => { ipcRenderer.removeListener('scenario:approval:required', listener); };
  },
  respondScenarioApproval: async (requestId: string, approve: boolean) => (
    ipcRenderer.invoke('scenario:approval:respond', { requestId, approve }) as Promise<{ ok: boolean; code?: string }>
  ),
  openReferenceFileDialog: async () => ipcRenderer.invoke('dialog:openReferenceFiles') as Promise<string[]>,
  importScenarioMaterials: async (rawRequest: unknown) => (
    ipcRenderer.invoke('scenario:importMaterials', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      error?: string;
      errors?: Array<{ name: string; error: string }>;
      materials?: Array<{ id: string; name: string; kind: string; storageRef: string; charCount: number; text: string }>;
    }>
  ),
  analyzeScenarioMaterials: async (rawRequest: unknown) => (
    ipcRenderer.invoke('scenario:analyzeMaterials', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      message?: string;
      error?: string;
      result?: {
        summary: {
          deliverableType: string;
          deliverableTypeLabel: string;
          structureTitles: string[];
          hardRuleCount: number;
          writingPrincipleCount: number;
          methods: string[];
          adjustable: string[];
          recommended: { agents: number; skills: number; mcps: number; rules: number };
        };
        materials: Array<{ name: string; kind: string; insights: { structureRules: string[]; writingPrinciples: string[]; methodSuggestions: string[]; hardRequirements: string[] } }>;
        draft: Record<string, unknown>;
      };
    }>
  ),
  scenarioConversationUnits: async (rawRequest: { projectId: string; scenarioId: string | null }) => (
    ipcRenderer.invoke('scenario:conversation:units', { projectId: rawRequest.projectId, scope: 'scenario', outcomeId: null, scenarioId: rawRequest.scenarioId }) as Promise<Array<{ id: string; title: string; messageCount: number; createdAt: number; updatedAt: number }>>
  ),
  scenarioConversationCreate: async (rawRequest: { projectId: string; scenarioId: string | null; title?: string }) => (
    ipcRenderer.invoke('scenario:conversation:create', { projectId: rawRequest.projectId, scope: 'scenario', outcomeId: null, scenarioId: rawRequest.scenarioId, title: rawRequest.title }) as Promise<{ id: string; title: string; createdAt: number } | null>
  ),
  scenarioConversationDelete: async (rawRequest: { projectId: string; conversationId: string }) => (
    ipcRenderer.invoke('scenario:conversation:delete', rawRequest) as Promise<boolean>
  ),
  scenarioConversationMessages: async (rawRequest: { projectId: string; conversationId: string }) => (
    ipcRenderer.invoke('scenario:conversation:messages', rawRequest) as Promise<Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; sources: unknown[]; createdAt: number }>>
  ),
  scenarioConversationAppend: async (rawRequest: { projectId: string; conversationId: string; role: 'user' | 'assistant' | 'system'; content: string }) => (
    ipcRenderer.invoke('scenario:conversation:append', { projectId: rawRequest.projectId, conversationId: rawRequest.conversationId, role: rawRequest.role, content: rawRequest.content }) as Promise<{ id: string; createdAt: number } | null>
  ),
  outcomesConversationUnits: async (rawRequest: { projectId: string; outcomeId: string }) => (
    ipcRenderer.invoke('outcomes:conversation:units', { projectId: rawRequest.projectId, scope: 'outcome', outcomeId: rawRequest.outcomeId, scenarioId: null }) as Promise<Array<{ id: string; title: string; messageCount: number; createdAt: number; updatedAt: number }>>
  ),
  outcomesConversationCreate: async (rawRequest: { projectId: string; outcomeId: string; title?: string }) => (
    ipcRenderer.invoke('outcomes:conversation:create', { projectId: rawRequest.projectId, scope: 'outcome', outcomeId: rawRequest.outcomeId, scenarioId: null, title: rawRequest.title }) as Promise<{ id: string; title: string; createdAt: number } | null>
  ),
  outcomesConversationDelete: async (rawRequest: { projectId: string; conversationId: string }) => (
    ipcRenderer.invoke('outcomes:conversation:delete', rawRequest) as Promise<boolean>
  ),
  outcomesConversationById: async (rawRequest: { projectId: string; conversationId: string }) => (
    ipcRenderer.invoke('outcomes:conversation:byId', rawRequest) as Promise<Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; sources: unknown[]; createdAt: number }>>
  ),

  topicChat: async (rawRequest: { sessionId: string; message: string }) => (
    ipcRenderer.invoke('topic:chat', rawRequest) as Promise<{
      ok: boolean; code?: string; message?: string; answer?: string;
      appliedBlocks?: string[]; session?: Record<string, unknown>; candidates?: Array<Record<string, unknown>>;
    }>
  ),
  onTopicStreamChunk: (handler: (chunk: { sessionId: string; content: string; reasoning?: string; isFinished: boolean }) => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload as { sessionId: string; content: string; reasoning?: string; isFinished: boolean });
    ipcRenderer.on('topic:stream-chunk', listener as never);
    return () => { ipcRenderer.removeListener('topic:stream-chunk', listener as never); };
  },
  getScenarioRunForProject: async (projectId: string) => (
    ipcRenderer.invoke('scenario:runStateForProject', projectId) as Promise<{
      ok: boolean;
      runId?: string;
      scenarioId?: string;
      scenarioName?: string;
      status?: 'running' | 'completed' | 'failed' | 'interrupted' | 'paused' | 'cancelled';
      steps?: Array<{
        stepId: string;
        name: string;
        status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'skipped';
      }>;
    }>
  ),
  compileScenarioHarness: async (rawRequest: { current: ScenarioDefinition; instruction: string; materialIds?: string[]; projectId?: string; scenarioId?: string; conversationId?: string; thinkingLevel?: string }) => (
    ipcRenderer.invoke('scenario:compileHarness', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      message?: string;
      error?: string;
      issues?: string[];
      scenario?: ScenarioDefinition;
      summary?: string;
      diff?: ScenarioHarnessDiffEntry[];
      assessment?: ScenarioHarnessAssessment;
      /** 主进程已在编译成功后直接持久化（渲染端无需再保存）。 */
      autosaved?: boolean;
      /** 全自动安装（2026-08-23 刘总授权）：本次编译中自动安装的技能/MCP。 */
      installedDefinitions?: Array<{ id: string; name: string; kind: 'skill' | 'mcp'; url: string }>;
    }>
  ),
  onScenarioCompileEvent: (handler: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => handler(payload);
    ipcRenderer.on('scenario:compile-event', listener as never);
    return () => { ipcRenderer.removeListener('scenario:compile-event', listener as never); };
  },
  onScenarioDraftUpdated: (handler: (update: { sessionId: string; scenario: ScenarioDefinition; summaries: readonly string[] }) => void) => {
    const listener = (_event: unknown, update: { sessionId: string; scenario: ScenarioDefinition; summaries: readonly string[] }) => handler(update);
    ipcRenderer.on('scenario:draft-updated', listener as never);
    return () => { ipcRenderer.removeListener('scenario:draft-updated', listener as never); };
  },
  onScenarioStreamChunk: (handler: (chunk: { sessionId: string; content: string; reasoning?: string; isFinished: boolean }) => void) => {
    const listener = (_event: unknown, chunk: { sessionId: string; content: string; reasoning?: string; isFinished: boolean }) => handler(chunk);
    ipcRenderer.on('scenario:stream-chunk', listener as never);
    return () => { ipcRenderer.removeListener('scenario:stream-chunk', listener as never); };
  },

  onFreeModelAutoRegisterProgress: (handler: (snapshot: { running: boolean; batchTotal: number; batchDone: number; stations: Array<Record<string, unknown>> }) => void): (() => void) => {
    const listener = (_event: unknown, snapshot: Parameters<typeof handler>[0]) => handler(snapshot);
    ipcRenderer.on('freeModel:autoRegisterProgress', listener as never);
    return () => { ipcRenderer.removeListener('freeModel:autoRegisterProgress', listener as never); };
  },

  refineScenarioConfig: async (rawRequest: unknown) => (
    ipcRenderer.invoke('scenario:aiRefine', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      patch?: unknown;
    }>
  ),
  aiParsePaperTemplate: async (rawRequest: unknown) => (
    ipcRenderer.invoke('personalization:parsePaperTemplate', rawRequest) as Promise<{
      ok: boolean;
      code?: string;
      message?: string;
      sections?: Array<{ title: string; instruction: string }>;
    }>
  ),
  rendererLog: async (line: string) => { try { await ipcRenderer.invoke('diag:rendererLog', String(line).slice(0, 600)); } catch { /* 诊断日志不阻塞 */ } },
  getPersonalization: async (rawRequest: PersonalizationGetRequest) => {
    const request = PersonalizationGetRequestSchema.safeParse(rawRequest);
    if (!request.success) return { ok: true as const, definition: null };
    return decodePersonalizationGetResponse(await ipcRenderer.invoke('personalization:get', request.data));
  },
  savePersonalization: async (rawRequest: PersonalizationSaveRequest) => {
    const request = PersonalizationSaveRequestSchema.safeParse(rawRequest);
    if (!request.success) return { ok: false as const, code: 'invalid_request' as const };
    return decodePersonalizationMutationResult(await ipcRenderer.invoke('personalization:save', request.data));
  },
  archivePersonalization: async (rawRequest: PersonalizationDeleteRequest) => {
    const request = PersonalizationDeleteRequestSchema.safeParse(rawRequest);
    if (!request.success) return { ok: false as const, code: 'invalid_request' as const };
    return decodePersonalizationMutationResult(await ipcRenderer.invoke('personalization:archive', request.data));
  },
  /** 永久删除定义及其全部版本历史；与归档不同，此操作不可恢复。 */
  deletePersonalization: async (rawRequest: PersonalizationDeleteRequest) => {
    const request = PersonalizationDeleteRequestSchema.safeParse(rawRequest);
    if (!request.success) return { ok: false as const, code: 'invalid_request' as const };
    return decodePersonalizationMutationResult(await ipcRenderer.invoke('personalization:delete', request.data));
  },
  forkPersonalization: async (rawRequest: PersonalizationForkRequest) => {
    const request = PersonalizationForkRequestSchema.safeParse(rawRequest);
    if (!request.success) return { ok: false as const, code: 'invalid_request' as const };
    return decodePersonalizationMutationResult(await ipcRenderer.invoke('personalization:fork', request.data));
  },
  restorePersonalization: async (rawRequest: PersonalizationRestoreRequest) => {
    const request = PersonalizationRestoreRequestSchema.safeParse(rawRequest);
    if (!request.success) return { ok: false as const, code: 'invalid_request' as const };
    return decodePersonalizationMutationResult(await ipcRenderer.invoke('personalization:restore', request.data));
  },
  restorePersonalizationFromTrash: async (rawRequest: PersonalizationTrashRestoreRequest) => {
    const request = PersonalizationTrashRestoreRequestSchema.safeParse(rawRequest);
    if (!request.success) return { ok: false as const, code: 'invalid_request' as const };
    return decodePersonalizationMutationResult(await ipcRenderer.invoke('personalization:trash:restore', request.data));
  },
  listPersonalizationVersions: async (rawRequest: PersonalizationVersionsRequest) => {
    const request = PersonalizationVersionsRequestSchema.safeParse(rawRequest);
    if (!request.success) return { ok: true as const, versions: [] };
    return decodePersonalizationVersionsResponse(await ipcRenderer.invoke('personalization:versions', request.data));
  },
  resolvePersonalization: async (rawRequest: PersonalizationResolveRequest) => {
    const request = PersonalizationResolveRequestSchema.safeParse(rawRequest);
    if (!request.success) {
      return { ok: false as const, code: 'definition_corrupt' as const, issues: ['Invalid personalization request'] };
    }
    return decodePersonalizationResolveResponse(await ipcRenderer.invoke('personalization:resolve', request.data));
  },

  // ── HITL Approval ──────────────────────────────────────
  applyPersonalizationExtension: async (rawRequest: PersonalizationExtensionIpcRequest) => {
    const request = PersonalizationExtensionIpcRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodePersonalizationExtensionResponse(null);
    return decodePersonalizationExtensionResponse(
      await ipcRenderer.invoke('personalization:extension:apply', request.data),
    );
  },

  activatePersonalizationMcp: async (rawRequest: McpActivationIpcRequest) => {
    const request = McpActivationIpcRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodeMcpActivationResponse(null);
    return decodeMcpActivationResponse(
      await ipcRenderer.invoke('personalization:mcp:activate', request.data),
    );
  },

  exportPersonalizationBundle: async (rawRequest: PersonalizationBundleExportIpcRequest) => {
    const request = PersonalizationBundleExportIpcRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodePersonalizationBundleIpcResponse(null);
    return decodePersonalizationBundleIpcResponse(
      await ipcRenderer.invoke('personalization:bundle:export', request.data),
    );
  },
  importPersonalizationBundle: async (rawRequest: PersonalizationBundleImportIpcRequest) => {
    const request = PersonalizationBundleImportIpcRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodePersonalizationBundleIpcResponse(null);
    return decodePersonalizationBundleIpcResponse(
      await ipcRenderer.invoke('personalization:bundle:import', request.data),
    );
  },
  listPersonalizationSecrets: async (rawRequest: PersonalizationSecretListRequest) => {
    const request = PersonalizationSecretListRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodePersonalizationSecretListResponse(null);
    return decodePersonalizationSecretListResponse(
      await ipcRenderer.invoke('personalization:secrets:list', request.data),
      request.data.operationId,
    );
  },
  setPersonalizationSecret: async (rawRequest: PersonalizationSecretSetRequest) => {
    const request = PersonalizationSecretSetRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodePersonalizationSecretSetResponse(null);
    return decodePersonalizationSecretSetResponse(
      await ipcRenderer.invoke('personalization:secrets:set', request.data),
      request.data.operationId,
    );
  },
  removePersonalizationSecret: async (rawRequest: PersonalizationSecretRemoveRequest) => {
    const request = PersonalizationSecretRemoveRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodePersonalizationSecretRemoveResponse(null);
    return decodePersonalizationSecretRemoveResponse(
      await ipcRenderer.invoke('personalization:secrets:remove', request.data),
      request.data.operationId,
    );
  },
  fundingTemplate: async (rawRequest: FundingTemplateIpcRequest) => {
    const request = FundingTemplateIpcRequestSchema.safeParse(rawRequest);
    if (!request.success) return decodeFundingTemplateRuntimeResponse(null);
    return decodeFundingTemplateRuntimeResponse(
      await ipcRenderer.invoke('fundingTemplate:invoke', request.data),
    );
  },

  onApprovalRequired: (callback: (request: ApprovalRequestView) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, rawRequest: unknown) => {
      const request = decodeApprovalRequestView(rawRequest);
      if (request) callback(request);
    };
    ipcRenderer.on('hitl:approval:required', handler);
    return () => { ipcRenderer.removeListener('hitl:approval:required', handler); };
  },
  respondApproval: async (requestId: string, approved: boolean) => {
    const request = decodeApprovalResponseRequest({
      requestId,
      decision: approved ? 'approve' : 'reject',
    });
    if (!request) return createApprovalMutationFailure();
    return decodeApprovalMutationResult(await ipcRenderer.invoke('hitl:approval:respond', request));
  },
  getPendingApprovals: async () => {
    const raw = await ipcRenderer.invoke('hitl:approvals:pending') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      const request = decodeApprovalRequestView(item);
      return request ? [request] : [];
    });
  },
  listHITLRules: async () => decodeApprovalRuleViews(await ipcRenderer.invoke('hitl:rules:list')),
  toggleHITLRule: async (ruleId: string, enabled: boolean) => {
    const request = decodeApprovalRuleToggleRequest({ ruleId, enabled });
    if (!request) return createApprovalMutationFailure();
    return decodeApprovalMutationResult(await ipcRenderer.invoke('hitl:rules:toggle', request));
  },

  // ── Terminal ───────────────────────────────────────────
  requestTerminalGrant: async () => decodeTerminalGrantResult(
    await ipcRenderer.invoke('terminal:requestGrant'),
  ),
  createTerminal: async (rawRequest: TerminalCreateRequest) => {
    const request = TerminalCreateRequestSchema.safeParse(rawRequest);
    if (!request.success) return createTerminalFailure();
    return decodeTerminalCreateResult(await ipcRenderer.invoke('terminal:create', request.data));
  },
  writeTerminal: async (rawRequest: TerminalWriteRequest) => {
    const request = TerminalWriteRequestSchema.safeParse(rawRequest);
    if (!request.success) return createTerminalFailure();
    return decodeTerminalOperationResult(await ipcRenderer.invoke('terminal:write', request.data));
  },
  resizeTerminal: async (rawRequest: TerminalResizeRequest) => {
    const request = TerminalResizeRequestSchema.safeParse(rawRequest);
    if (!request.success) return createTerminalFailure();
    return decodeTerminalOperationResult(await ipcRenderer.invoke('terminal:resize', request.data));
  },
  killTerminal: async (rawRequest: TerminalKillRequest) => {
    const request = TerminalKillRequestSchema.safeParse(rawRequest);
    if (!request.success) return createTerminalFailure();
    return decodeTerminalOperationResult(await ipcRenderer.invoke('terminal:kill', request.data));
  },

  onTerminalData: (callback: (data: TerminalDataEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      const data = TerminalDataEventSchema.safeParse(raw);
      if (data.success) callback(data.data);
    };
    ipcRenderer.on('terminal:data', handler);
    return () => { ipcRenderer.removeListener('terminal:data', handler); };
  },
  onTerminalExit: (callback: (data: TerminalExitEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      const data = TerminalExitEventSchema.safeParse(raw);
      if (data.success) callback(data.data);
    };
    ipcRenderer.on('terminal:exit', handler);
    return () => { ipcRenderer.removeListener('terminal:exit', handler); };
  },

};

contextBridge.exposeInMainWorld('metis', api);

// Type declaration for TypeScript in renderer
export type MetisAPI = typeof api;
