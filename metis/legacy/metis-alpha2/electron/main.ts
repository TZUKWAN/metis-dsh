/**
 * Electron main process — Metis Research Workbench.
 *
 * Responsibilities:
 *  - Create BrowserWindow with preload
 *  - Initialize PersistenceStore (SQLite)
 *  - Initialize OpenAICompatProvider + AgentLoop from engine
 *  - Handle IPC from renderer (agent run, streaming chat, settings, session CRUD)
 *  - Encrypt/decrypt provider config via SecureStorage
 */

import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  dialog,
  net,
  safeStorage,
  screen,
  session as electronSession,
  shell,
  protocol,
  type IpcMainInvokeEvent,
} from 'electron';
import path from 'node:path';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { spawn, spawnSync, exec } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

// ── 主进程文件日志（2026-08-25 刘总要求；任务3重构为缓冲写入）──────────
// Start-Process 管道重定向下 Node console 是 64KB 块缓冲，过程日志会长期
// 滞留缓冲区无法用于实时诊断，因此保留 logs/main-app.log 实时 tail 目的地。
// 任务3（§11）：原实现逐条同步 appendFileSync，高频 Agent/Tool/Event 日志会
// 阻塞 main loop 且无滚动；现改为缓冲批量写 + 大小滚动 + 凭据 redaction，
// 数据目录归档（2026-08-29 刘总要求）在 DATA_DIR 解析后通过 rebind 启用。
let archiveDataDir: string | null = null;
const mainProcessLogger = new MainProcessLogger({
  tailLogPath: path.join(process.cwd(), 'logs', 'main-app.log'),
  archivePathForDate: (date) =>
    archiveDataDir === null
      ? null
      : path.join(archiveDataDir, 'logs', `main-${date.toISOString().slice(0, 10)}.log`),
});
mainProcessLogger.install();


// Windows occlusion tracking can throttle — or fully stall — input delivery to
// windows the OS reports as occluded. This is common on VMs / remote-desktop
// sessions and manifests as wheel/click events never reaching the renderer.
// Disabling the optimization costs nothing on normal desktops and restores
// reliable input everywhere. Must run before app ready.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
import {
  createLayoutAcceptanceMetadata,
  extractLayoutAcceptanceToken,
  isExpectedLayoutAcceptanceFrame,
  nextLayoutAcceptanceContentSize,
  parseLayoutAcceptanceWindowRequest,
  requireLayoutAcceptanceRequest,
} from './LayoutAcceptance.js';

// ESM-compatible __dirname (not available by default in ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import * as pty from 'node-pty';
import { PersistenceStore, setSharedStore } from '../engine/persistence/PersistenceStore.js';
import { BrowserService, type BrowserBounds } from './BrowserService.js';
import { CollabService } from './CollabService.js';
import { LiteratureSearchService } from './LiteratureSearchService.js';
import { RESEARCH_CAPABILITY_TASKS } from '../engine/evals/research-capability-suite.js';
import { extendSciSsciIssns } from '../engine/literature/CoreJournalLists.js';
import { detectStage } from '../engine/research/StageDetector.js';
import { configureJournalCatalogFetcher } from '../engine/research/JournalCatalog.js';
import { JobQueueService } from './JobQueueService.js';
import { ResearchJournalService } from './ResearchJournalService.js';
import { MethodLibraryService } from './MethodLibraryService.js';
import { SubmissionTrackerService } from './SubmissionTrackerService.js';
import { LiteratureWatchService } from './LiteratureWatchService.js';
import { ResearchAgendaService } from './ResearchAgendaService.js';
import { CloudSyncService } from './CloudSyncService.js';
import { AutonomousProfileService } from './AutonomousProfileService.js';
import { setBrowserControlBridge } from '../engine/tools/browser-tools.js';
import { BackupService, clearRestoreIntent, readRestoreIntent, writeRestoreIntent } from './BackupService.js';
import { PersistenceStartupError } from '../engine/persistence/errors.js';
import { WeChatBotService } from './WeChatBotService.js';
import { IlinkClient } from '../engine/im/IlinkClient.js';
import {
} from '../engine/export/ProjectArchiveExporter.js';
import { UpdateCheckerService } from './UpdateCheckerService.js';
import { AutoUpdaterService } from './AutoUpdaterService.js';
import { resolveUpdateChannel } from './UpdateChannelPolicy.js';
import { verifyAuthenticodeSignature } from './UpdateSignatureVerifier.js';
import {
  clearCrashMarker,
  collectStartupHealth,
  crashMarkerPath,
  readCrashMarkerState,
  writeCrashMarker,
} from './StartupHealthService.js';
import { buildDiagnosticBundle } from './DiagnosticBundleService.js';
import {
  resolveDataDir,
} from './StorageLocation.js';
import { ResearchRepository } from '../engine/persistence/ResearchRepository.js';
import { OutcomeRepository } from './OutcomeRepository.js';
import { TopicRepository } from './TopicRepository.js';
import { ArtifactPromptService } from './ArtifactPromptService.js';
import { OfficePromptProfileService } from './OfficePromptProfileService.js';
import { buildExperienceElicitationPrompt, buildTestRunOptions, type SkillStudioSource } from '../engine/skills/SkillStudio.js';
import { TopicService, TOPIC_SEARCH_TOOLS } from './TopicService.js';
import { SubmissionRepository } from './SubmissionRepository.js';
import {
  SUBMISSION_STATUSES,
  TargetingCriteriaSchema,
  SubmissionCaseCreateRequestSchema,
  SubmissionCaseUpdateRequestSchema,
  SubmissionStatusChangeRequestSchema,
} from '../engine/submission/SubmissionRuntimeContract.js';

import { aggregateVenueCandidates } from '../engine/submission/JournalTargeting.js';
import { buildVenueMatchQuery, filterRelevantPapers, outcomeContentToMatchText } from './SubmissionVenueMatching.js';
import { SUBMISSION_GAP_STATUSES } from '../engine/submission/JournalProfileContract.js';
import { JournalProfileRepository } from './JournalProfileRepository.js';
import { JournalProfileService } from './JournalProfileService.js';
import { JournalCorpusService } from './JournalCorpusService.js';
import { JournalPatternService } from './JournalPatternService.js';
import { SubmissionGapService, extractManuscriptPlainText } from './SubmissionGapService.js';
import { SubmissionOptimizationService } from './SubmissionOptimizationService.js';
import { SUBMISSION_PACKAGE_FILE_TYPES } from '../engine/submission/SubmissionPackageContract.js';
import { PortalFieldActionSchema } from '../engine/submission/SubmissionPortalContract.js';
import { ReviewCommentPatchSchema } from '../engine/submission/SubmissionReviewContract.js';
import { SubmissionPackageRepository } from './SubmissionPackageRepository.js';
import { SubmissionReviewRepository } from './SubmissionReviewRepository.js';
import { SubmissionReviewService } from './SubmissionReviewService.js';
import { SubmissionPreflightService } from './SubmissionPreflightService.js';
import { SubmissionPackageService } from './SubmissionPackageService.js';
import { CoverLetterService } from './CoverLetterService.js';
import { ImapFlow } from 'imapflow';
import { MailboxPoolStore } from './ModelDiscoveryStore.js';
import { SubmissionCorrespondenceRepository } from './SubmissionCorrespondenceRepository.js';
import { MailSendService } from './MailSendService.js';
import { SubmissionMailService } from './SubmissionMailService.js';
import { SubmissionPortalService, type PortalBrowser } from './SubmissionPortalService.js';
import { SubmissionDeadlineSync } from './SubmissionDeadlineSync.js';
import { SubmissionMailWatcher } from './SubmissionMailWatcher.js';
import type { ImapFlowConstructor } from '../engine/mail/MailboxPool.js';

const SUBMISSION_STATUS_SET: ReadonlySet<string> = new Set<string>(SUBMISSION_STATUSES);
type SubmissionStatusName = (typeof SUBMISSION_STATUSES)[number];
import { OutcomeMediaService } from './OutcomeMediaService.js';
import { GenofficeEmbeddedViewService } from './genofficeEmbedded/GenofficeEmbeddedViewService.js';
import { registerGenofficeDocsCompat, onEmbeddedThemeChanged } from './genofficeEmbedded/genofficeEmbeddedDocsCompat.js';
import { OutcomeImageService } from './OutcomeImageService.js';
import { OutcomeAssistantService } from './OutcomeAssistantService.js';
import { OutcomeProjectContextService, readOutcomeProjectMetisFromWorkspace, type OutcomeProjectMetisReadResult } from './OutcomeProjectContextService.js';
import { OutcomeWordDocxService, GENOFFICE_ENABLED } from './OutcomeWordDocxService.js';
import { parseWordTemplateStyle } from './WordTemplateStyleParser.js';
import { createSubmissionBrowserTools } from './SubmissionBrowserTools.js';
import { SubmissionAssistantService } from './SubmissionAssistantService.js';
import { parseGuidelineFormatting, type MutableFormattingDraft, type MutableFormattingSlot } from '../engine/outcomes/GuidelineFormatting.js';
import { buildFundingTemplateSeed } from '../engine/personalization/FundingTemplateSeed.js';
import { buildFindSkillsSeed } from '../engine/personalization/FindSkillsBuiltinDraft.js';
import type { WordFormattingConfig } from '../engine/outcomes/WordDocumentFormatting.js';

/** 字段级校验并写入排版配置槽；非法值返回 false 由调用方计数丢弃。 */
function setFormattingField(slot: MutableFormattingSlot, field: string, value: string | number): boolean {
  switch (field) {
    case 'fontFamily':
      if (typeof value !== 'string' || !value.trim() || value.length > 60) return false;
      slot.fontFamily = value.trim();
      return true;
    case 'fontSizePt':
    case 'lineSpacing':
    case 'firstLineIndentChars': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      if (field === 'fontSizePt' && (value < 5 || value > 72)) return false;
      if (field === 'lineSpacing' && (value < 0.5 || value > 4)) return false;
      if (field === 'firstLineIndentChars' && (value < 0 || value > 16)) return false;
      slot[field] = value;
      return true;
    }
    case 'align':
      if (value !== 'left' && value !== 'center' && value !== 'right' && value !== 'justify') return false;
      slot.align = value;
      return true;
    default:
      return false;
  }
}
import { OutcomePptGenerationService } from './OutcomePptGenerationService.js';
import { OutcomePptxService } from './OutcomePptxService.js';
import { GENOFFICE_PPTX_ORIGINAL_ARCHIVE_KEY } from './office/genofficePptxBridge.js';
import { OutcomeExternalEditorService } from './OutcomeExternalEditorService.js';
import { externalDocumentFromSavedBytes, externalEditorExtension, externalEditorKindForOutcome, isExternalEditorDocumentBytes, parseSpreadsheetWorkbook, validatePdfBytes } from './OutcomeExternalEditorBridge.js';
import { parseGenofficeReadyLine } from './genofficeStandaloneProtocol.js';
import { createBlankPdfBytes, createBlankSpreadsheetBytes } from './OutcomeBlankDocumentFactory.js';
import { buildGenofficeEnvironment, resolveGenofficeRoot } from './genofficeRuntimePaths.js';
import { AgentExecutionEventBridge } from './AgentExecutionEventBridge.js';
import { FreeModelService } from './FreeModelService.js';
import { OutcomeMediaSvgExportResultSchema } from '../engine/runtime/OutcomeRuntimeContract.js';
import { exportStandaloneSvg, roundTripStandaloneSvg } from './OutcomeSvgSecurity.js';
import {
  RuntimeShutdownCoordinator,
  registerRuntimeRunOrRollback,
  trackEphemeralOperation,
} from './RuntimeShutdownCoordinator.js';
import { ApprovalShutdownRegistry, ScenarioApprovalRegistry } from './ApprovalShutdownRegistry.js';
import { createScenarioLoopRunTracker } from './ScenarioLoopRunTracker.js';
import { MainProcessLogger } from './MainProcessLogger.js';
import { IpcRegistry } from './ipc/IpcRegistry.js';
import { registerTopicIpc } from './ipc/registerTopicIpc.js';
import type { DomainIpcContext } from './ipc/DomainIpcContext.js';
import { registerSystemIpc } from './ipc/registerSystemIpc.js';
import { registerProjectIpc } from './ipc/registerProjectIpc.js';
import { registerArtifactIpc } from './ipc/registerArtifactIpc.js';
import { registerExperimentIpc } from './ipc/registerExperimentIpc.js';
import { registerWeChatIpc } from './ipc/registerWeChatIpc.js';
import { registerFreeModelIpc } from './ipc/registerFreeModelIpc.js';
import { OpenAICompatProvider } from '../engine/providers/OpenAICompatProvider.js';
import { AgentLoop } from '../engine/core/AgentLoop.js';
import { OutcomeAssistantChatRequestSchema, OutcomeAssistantChatResultSchema, OutcomeCategoryCreateSchema, OutcomeCategoryDeleteSchema, OutcomeCategoryRenameSchema, OutcomeCreateRequestSchema, OutcomeExternalEditorCloseRequestSchema, OutcomeExternalEditorOpenRequestSchema, OutcomeExternalEditorOpenResultSchema, OutcomeExternalEditorStateRequestSchema, OutcomeExternalEditorStateSchema, OutcomeExternalEditorSyncRequestSchema, OutcomeExternalEditorSyncResultSchema, OutcomeFinalRequestSchema, OutcomeGetRequestSchema, OutcomeImageGenerateResultSchema, OutcomeImageSettingsGetResultSchema, OutcomeImageSettingsSaveResultSchema, OutcomeListRequestSchema, OutcomeMediaImportRequestSchema, OutcomeMediaReadRequestSchema, OutcomeMoveRequestSchema, OutcomePptxExportRequestSchema, OutcomePptxExportResultSchema, OutcomePptxImportCommitRequestSchema, OutcomePptxImportCommitResultSchema, OutcomePptxImportRequestSchema, OutcomePptxImportResultSchema, OutcomeRenameRequestSchema, OutcomeRestoreRequestSchema, OutcomeSaveRequestSchema, OutcomeVersionsRequestSchema, OutcomeWordDocxExportRequestSchema, OutcomeWordDocxExportResultSchema, OutcomeWordDocxImportCommitRequestSchema, OutcomeWordDocxImportCommitResultSchema, OutcomeWordDocxImportRequestSchema, OutcomeWordDocxImportResultSchema, PptGenerationExecuteRequestSchema, PptGenerationResultSchema, PptGenerationSkillSaveRequestSchema, PptGenerationSkillSchema, PptTemplateSaveRequestSchema, PptTemplateSchema, ScenarioScopedConversationCreateSchema, ScenarioScopedConversationRequestSchema, ScopedConversationMessageRequestSchema, ScopedConversationRequestSchema, ScopedConversationCreateSchema, ScopedConversationRefSchema, ScopedConversationAppendToSchema, OutcomeSourceLocateRequestSchema, OutcomeSourceLocateResultSchema, OutcomeTrashListRequestSchema, OutcomeTrashRequestSchema } from '../engine/runtime/OutcomeRuntimeContract.js';
import { PptDocumentSchema, decodePptTemplateDefinition, decodePptTemplatePages } from '../engine/runtime/OutcomeRuntimeContract.js';
import type { PptDocument, WordDocument } from '../engine/runtime/OutcomeRuntimeContract.js';
import { applyWordFormatting } from '../engine/outcomes/WordDocumentFormatting.js';
import { OutcomeTemplateDefaultGetRequestSchema, OutcomeTemplateDeleteRequestSchema, OutcomeTemplateListRequestSchema, OutcomeTemplateSaveRequestSchema, OutcomeTemplateUpdateRequestSchema, OutcomeDefaultTemplateSetRequestSchema, WordFormattingTemplateDefinitionSchema, type OutcomeTemplateKind } from '../engine/runtime/OutcomeRuntimeContract.js';
import { OutcomeTemplateService } from './OutcomeTemplateService.js';
import { ToolRegistry } from '../engine/tools/ToolRegistry.js';
import { ToolDispatcher } from '../engine/tools/ToolDispatcher.js';
import { registerBuiltinTools } from '../engine/tools/index.js';
import { createScenarioPatchRouter, SCENARIO_APPLY_UPDATE_TOOL_NAME, SCENARIO_PLAN_WORKFLOW_TOOL_NAME, SCENARIO_PLAN_SECTIONS_TOOL_NAME, newCompileSessionId } from '../engine/tools/builtin/scenario-patch-tool.js';
import {
  createScenarioMarketSearchRouter,
  createScenarioInstallRouter,
  type ScenarioInstallerBinding,
  type ScenarioMarketSearchFn,
} from '../engine/tools/builtin/scenario-acquisition-tools.js';

// 场景增量补丁路由器（2026-08-22）：模块级单例，跨 loop 重建与并发编译按 sessionId 隔离。
const scenarioPatchRouterSingleton = createScenarioPatchRouter(true);

// 场景能力获取服务持有者（2026-08-23）：marketService / personalizationExtensions
// 在工具注册之后才创建，这里用晚绑定持有者，初始化时注入。
const scenarioAcquisition: { search: ScenarioMarketSearchFn | null; install: ScenarioInstallerBinding } = {
  search: null,
  install: { apply: null, notifications: new Map() },
};
const scenarioMarketSearchRouterSingleton = createScenarioMarketSearchRouter(
  (kind, query, source) => (scenarioAcquisition.search ? scenarioAcquisition.search(kind, query, source) : Promise.resolve({ ok: false, code: 'unavailable' })),
);
const scenarioInstallRouterSingleton = createScenarioInstallRouter(scenarioAcquisition.install);
import { MULTI_AGENT_TOOL, createMultiAgentHandler } from '../engine/tools/builtin/MultiAgentTool.js';
import type { PersonalizationMcpToolRegistration } from './PersonalizationMcpToolBridge.js';
import { HookBus } from '../engine/core/HookBus.js';
import { ContextEngine } from '../engine/context/ContextEngine.js';
import { EvidenceLedger } from '../engine/evidence/EvidenceLedger.js';
import { ApprovalStore } from '../engine/hitl/HITLCore.js';
import { BehaviorRegistry } from '../engine/behavior/BehaviorRegistry.js';
import {
  decryptProviderConfig,
  getSecureStorage,
  initSecureStorage,
} from '../engine/core/SecureStorage.js';
import type { ProviderConfig } from '../engine/core/types.js';
import { MemoryManager } from '../engine/memory/MemoryManager.js';
import { LearningEngine } from '../engine/learning/LearningEngine.js';
import { WorkspaceAgentsManager } from '../engine/memory/WorkspaceAgentsManager.js';
import {
  decodeWorkspaceAgentsWriteRequest,
  decodeWorkspaceAgentsGetRequest,
} from '../engine/runtime/WorkspaceAgentsContract.js';
import { GoalEngine, type GoalExecutionOptions } from '../engine/goal/GoalEngine.js';
import type { Goal } from '../engine/goal/GoalPlanner.js';
import type { GoalPersistence } from '../engine/goal/GoalPersistence.js';
import { createGoalPersistence } from './GoalPersistenceStore.js';
import { WorkflowEngine } from '../engine/workflow/WorkflowEngine.js';
import { ResearchEventBus } from '../engine/research/ResearchEventBus.js';
import { ResearchStrategyStore } from '../engine/persistence/ResearchStrategyStore.js';
import {
  decodeStrategySaveRequest,
  decodeStrategyDeleteRequest,
  decodeStrategySetDefaultRequest,
  decodePaperStructureSaveRequest,
  decodePaperStructureDeleteRequest,
  type ResearchStrategy,
  type PaperStructureTemplate,
} from '../engine/runtime/ResearchStrategyContract.js';
import { AutonomousPlanner } from '../engine/research/AutonomousPlanner.js';
import { AutonomousResearchEngine } from '../engine/research/AutonomousResearchEngine.js';
import {
  applyAutonomousResearchEvent,
  beginAutonomousResearchRun,
  createAutonomousResearchArtifactSink,
  ensureAutonomousResearchProject,
} from '../engine/research/AutonomousResearchPersistence.js';
import { collectPdfCandidates } from '../engine/research/UnpaywallClient.js';
import { resolveDoi } from '../engine/research/DoiResolver.js';
import { searchWorks } from '../engine/research/CrossrefClient.js';
import {
  AUTONOMOUS_CONTRACT_VERSION,
  AUTONOMOUS_CHANNELS,
  decodeAutonomousStartRequest,
  decodeAutonomousControlRequest,
  decodeAutonomousLiveEvent,
} from '../engine/runtime/AutonomousRuntimeContract.js';
import { parseLatexLog } from '../engine/latex/LatexLogParser.js';
import type { WorkflowDefinition, WorkflowHooks, WorkflowRun } from '../engine/workflow/types.js';
import { MCPManager } from '../engine/mcp/MCPManager.js';
import { SkillRegistry, registerDefaultSkills } from '../engine/skills/SkillRegistry.js';
import { SkillExtractor, type ExtractedSkill } from '../engine/skills/SkillExtractor.js';
import { PersonalizationRepository } from '../engine/personalization/PersonalizationRepository.js';
import { isFundingTemplateBuiltinDraftReady } from '../engine/personalization/FundingTemplateBuiltinDraft.js';
import { PersonalizationRuntimeService } from './PersonalizationRuntimeService.js';
import { projectMetisRulesFromWorkspace } from './ProjectMetisRulesBridge.js';
import { EvidenceEnvelopeService } from './EvidenceEnvelopeService.js';
import { PersonalizationSkillInstaller } from './PersonalizationSkillInstaller.js';
import { PersonalizationMcpInstaller } from './PersonalizationMcpInstaller.js';
import { ManagedPersonalizationMcpRuntime } from './ManagedPersonalizationMcpRuntime.js';
import { PersonalizationMcpProbeRunner } from './PersonalizationMcpProbeRunner.js';
import { PersonalizationMcpActivationService } from './PersonalizationMcpActivationService.js';
import { GeneratedMcpActivationCoordinator } from './GeneratedMcpActivationCoordinator.js';
import { PersonalizationMcpToolBridge } from './PersonalizationMcpToolBridge.js';
import { McpBuilderService } from './McpBuilderService.js';
import {
  FilesystemMcpInstallationCompensator,
  PersonalizationExtensionService,
} from './PersonalizationExtensionService.js';
import {
  PersonalizationExtensionApplyRequestSchema,
  PersonalizationExtensionIpcRequestSchema,
  decodePersonalizationExtensionResponse,
  type PersonalizationExtensionApplyRequest,
  type PersonalizationExtensionIpcRequest,
} from '../engine/runtime/PersonalizationExtensionContract.js';
import { McpBuilderSpecificationSchema } from '../engine/runtime/McpInstallationContract.js';
import {
  McpActivationIpcRequestSchema,
  McpActivationRequestSchema,
  decodeMcpActivationResponse,
  type McpActivationIpcRequest,
  type McpActivationRequest,
} from '../engine/runtime/McpActivationContract.js';
import { PersonalizationBundleService } from './PersonalizationBundleService.js';
import { PersonalizationBundleRepositorySink } from './PersonalizationBundleRepositorySink.js';
import { PersonalizationBundleImportCoordinator } from './PersonalizationBundleImportCoordinator.js';
import { PersonalizationBundleSkillRehydrationService } from './PersonalizationBundleSkillRehydrationService.js';
import { PersonalizationBundleSkillAssetSource } from './PersonalizationBundleSkillAssetSource.js';
import { PersonalizationSecretVault } from './PersonalizationSecretVault.js';
import { MarketService } from './MarketService.js';
import { ScenarioMaterialService } from './ScenarioMaterialService.js';
import { ScenarioLoopScheduler } from '../engine/personalization/ScenarioLoopScheduler.js';
import {
  ScenarioDefinitionSchema,
  SYSTEM_FULL_ACCESS_POLICY,
  PERSONALIZATION_CONTRACT_VERSION,
  type PersonalizationDefinition,
  type ScenarioDefinition,
  type SkillDefinitionV2,
} from '../engine/runtime/PersonalizationRuntimeContract.js';
import { CapabilityVaultService } from './CapabilityVaultService.js';
import { ExternalReferenceService } from './ExternalReferenceService.js';
import type { GitHubFetcher } from '../engine/capabilities/CapabilityImporter.js';
import {
  buildScenarioPhasePrompt,
} from '../engine/personalization/ScenarioHarnessCompiler.js';
import { assessScenarioHarness, normalizeScenarioHarness } from '../engine/personalization/ScenarioHarness.js';
import { diffScenarioHarness } from '../engine/personalization/ScenarioHarnessCompiler.js';
import {
  SCENARIO_PHASE_ORDER,
  SCENARIO_PHASE_LABELS,
  checkPhaseGate,
  runAllPhaseGates,
  formatAuditIssues,
  type ScenarioPhase,
} from '../engine/personalization/ScenarioPhaseGates.js';
import {
  SCENARIO_MARKET_SEARCH_TOOL_NAME,
  SCENARIO_INSTALL_EXTENSION_TOOL_NAME,
} from '../engine/tools/builtin/scenario-acquisition-tools.js';
import { FundingTemplateRepository } from './FundingTemplateRepository.js';
import { FundingTemplateService } from './FundingTemplateService.js';
import { FundingTemplateToolService } from './FundingTemplateToolService.js';
import { FundingTemplateIpcService } from './FundingTemplateIpcService.js';
import { decodeFundingTemplateRuntimeResponse } from '../engine/runtime/FundingTemplateRuntimeContract.js';
import {
  PERSONALIZATION_BUNDLE_LIMITS,
  PersonalizationBundleSchema,
  PersonalizationBundleExportIpcRequestSchema,
  PersonalizationBundleImportIpcRequestSchema,
  PersonalizationBundleIpcResponseSchema,
} from '../engine/runtime/PersonalizationBundleContract.js';
import {
  PersonalizationSecretListRequestSchema,
  PersonalizationSecretRemoveRequestSchema,
  PersonalizationSecretSetRequestSchema,
  decodePersonalizationSecretListResponse,
  decodePersonalizationSecretRemoveResponse,
  decodePersonalizationSecretSetResponse,
} from '../engine/runtime/PersonalizationSecretContract.js';
import { EvalRunner, suiteSummary } from '../engine/evals/EvalRunner.js';
import { evaluateGate } from '../engine/evals/GateEvaluator.js';
import type { EvalTaskSpec } from '../engine/evals/types.js';
import {
  createChatTurnErrorResponse,
  runPersistedChatTurn,
  runEphemeralChatTurn,
} from './ChatTurnService.js';
import { applyStepControl, compileScenarioExecutionManifest, runPersistedScenarioWorkflow } from './ScenarioWorkflowService.js';
import { createScenarioLiteratureBridge, type ScenarioLiteratureBridge } from './ScenarioLiteratureBridge.js';
import { isAuthorizedRendererMainFrame } from './RendererAuthorization.js';
import { createSecureExternalOpenHandler } from './SecureExternalOpenHandler.js';
import {
  AgentChatRequestSchema,
  AgentEventReplayRequestSchema,
  AgentEventReplayResponseSchema,
  CHAT_RUNTIME_CONTRACT_VERSION,
  decodeGoalLiveEvent,
  decodeStoredHistoryEntry,
  decodeStoredHistory,
  RuntimeIdSchema,
} from '../engine/runtime/ChatRuntimeContract.js';
import { buildContextProvenance } from '../engine/runtime/ContextScopeContract.js';
import {
  AgentControlRequestSchema,
  InMemoryLiveSteeringQueue,
  LIVE_STEERING_CONTRACT_VERSION,
  decodeAgentControlResponse,
} from '../engine/runtime/LiveSteeringContract.js';
import {
  SCENARIO_CONTROL_CONTRACT_VERSION,
  ScenarioRunControlRequestSchema,
  decodeScenarioRunControlResponse,
} from '../engine/runtime/ScenarioControlContract.js';
import { terminateStoredScenarioRun } from '../engine/personalization/ScenarioRunCoordinator.js';
import {
  createGoalWorkflowRecovery,
  decodeGoalChangedEvent,
  decodeGoalCreateResponse,
  decodeGoalListResponse,
  decodeGoalPlanResponse,
  decodeGoalSummaryResponse,
  decodeGoalWorkflowResponse,
  GOAL_PLAN_LABEL,
  GOAL_PLAN_STEP_LABEL,
  GOAL_RUNTIME_LIMITS,
  GoalCreateRequestSchema,
  GoalIdRequestSchema,
  GoalRefineRequestSchema,
} from '../engine/runtime/GoalRuntimeContract.js';
import {
} from '../engine/runtime/ArtifactRuntimeContract.js';
import {
  createSessionListRecovery,
  decodeLegacySessionList,
  decodeSessionCreateRequest,
  decodeSessionDeleteRequest,
  decodeSessionListRequest,
  decodeSessionMutationResult,
  decodeSessionUpdateRequest,
} from '../engine/runtime/SessionRuntimeContract.js';
import {
  createFileCapabilityFailure,
  decodeFileCapabilityImportRequest,
  decodeFileCapabilitySelectionRequest,
  decodeFileCapabilitySelectionResult,
} from '../engine/runtime/FileCapabilityContract.js';
import {
  createLatexCompileRecovery,
  decodeLatexCompileRequest,
  decodeLatexCompileResponse,
  type LatexCompileResponse,
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
  ApprovalRequestViewSchema,
  createApprovalMutationFailure,
  decodeApprovalMutationResult,
  decodeApprovalResponseRequest,
  decodeApprovalRuleToggleRequest,
  decodeApprovalRuleViews,
  presentApprovalAction,
} from '../engine/runtime/ApprovalRuntimeContract.js';
import { FileCapabilityRegistry } from './FileCapabilityRegistry.js';
import { createFileCapabilityUseHandler } from './FileCapabilityHandler.js';
import {
  ExecutionCapabilityRegistry,
  type ExecutionOwnerIdentity,
} from './ExecutionCapabilityRegistry.js';
import { createSecureIpcHandler, decoded, rejected } from './SecureIpc.js';
import { SecureDownloadService } from './SecureDownloadService.js';
import { SecureExportService } from './SecureExportService.js';
import { buildResearchExport, type SecureExportPlan } from '../engine/export/ResearchExportBuilder.js';
import {
  buildExportSnapshot,
  resolveTrustedArtifactExportBinding,
} from './ResearchExportAdapter.js';
import {
  createExportFailure,
  decodeExportRequest,
  decodeExportResult,
  type ExportRequest,
} from '../engine/runtime/ExportRuntimeContract.js';
import {
  CA_RUNTIME_CONTRACT_VERSION,
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
} from '../engine/runtime/CurrentAffairsRuntimeContract.js';
import { loadOrCreateCurrentAffairsReceiptSecret } from './CurrentAffairsReceiptKeyStore.js';
import { CurrentAffairsApprovalStore } from '../engine/writing/CurrentAffairsApprovalStore.js';
import { CurrentAffairsArtifactService } from '../engine/writing/CurrentAffairsArtifactService.js';
import { CurrentAffairsSessionState } from '../engine/writing/CurrentAffairsSessionState.js';
import { CurrentAffairsRepositoryService } from '../engine/writing/CurrentAffairsRepositoryService.js';
import { adaptSource } from '../engine/writing/CurrentAffairsSourceAdapter.js';
import { ResearchRuntimeService } from './ResearchRuntimeService.js';
import { ResearchMediaService } from './ResearchMediaService.js';
import { CitationTruthReceiptService } from './CitationTruthReceiptService.js';
import { loadOrCreateCitationTruthSecret } from './CitationTruthKeyStore.js';
import {
  verifyArtifactForExport,
  verifyArtifactForPersistence,
} from './ResearchArtifactTrust.js';
import { ArtifactManifestSchema } from '../engine/artifacts/ArtifactManifest.js';
import {
  createResearchMediaAttachFailure,
  createResearchMediaPurgeFailure,
  decodeResearchMediaAttachRequest,
  decodeResearchMediaAttachResult,
  decodeResearchMediaPurgeRequest,
  decodeResearchMediaPurgeResult,
} from '../engine/runtime/ResearchMediaRuntimeContract.js';
import {
  TERMINAL_RUNTIME_LIMITS,
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
} from '../engine/runtime/TerminalRuntimeContract.js';
import {
  FirstRunSetupService,
  createFirstRunSecureStorage,
  type FirstRunSecureStorage,
  type PreparedSetupRuntime,
  type SetupRuntimeBuildContext,
} from './FirstRunSetupService.js';
import { ProviderProfileStore } from './ProviderProfileStore.js';
import {
  PROVIDER_PROFILE_CONTRACT_VERSION,
  createProviderProfileListRecovery,
  createProviderProfileMutationRecovery,
  decodeProviderProfileDeleteRequest,
  decodeProviderProfileListRequest,
  decodeProviderProfileSaveRequest,
  decodeProviderProfileSwitchRequest,
  decodeProviderProfileResetRequest,
  resolveProviderProfileRuntimeState,
  ProviderProfileIdSchema,
  type ProviderProfileBinding,
  type ProviderProfileMutationResponse,
} from '../engine/runtime/ProviderProfileContract.js';
import { OpenAISetupProbeTransport } from './OpenAISetupProbeTransport.js';
import {
  SETUP_RUNTIME_CONTRACT_VERSION,
  decodeSetupAbortRequest,
  decodeSetupProbeResponse,
  type SetupProbeResponse,
  decodeSetupRestoreRequest,
  decodeSetupRestoreResponse,
  decodeSetupSaveRequest,
  decodeSetupSaveResponse,
  decodeSettingsProviderProbeRequest,
  createSetupRecovery,
} from '../engine/runtime/SetupRuntimeContract.js';
import {
  createResearchMutationRecovery,
  createResearchSnapshotRecovery,
  decodeResearchArtifactVersionRequest,
  decodeResearchCheckpointRequest,
  decodeResearchCrudRequest,
  decodeResearchDecisionRequest,
  decodeResearchLinkRequest,
  decodeResearchRestoreRequest,
  decodeResearchReviewRequest,
  decodeResearchSnapshotRequest,
} from '../engine/runtime/ResearchRuntimeContract.js';
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
  decodeProjectMemoryContent,
  decodeProjectMemoryMutationResult,
  decodeProjectMemoryWriteRequest,
} from '../engine/runtime/MemoryRuntimeContract.js';
import {
  createSettingsMutationFailure,
  createSettingsViewRecovery,
  decodeSettingsMutationResult,
  decodeSettingsUpdateRequest,
  decodeSettingsView,
} from '../engine/runtime/SettingsRuntimeContract.js';
import {
  createEvalRunFailure,
  decodeEvalRunRequest,
  decodeEvalRunResult,
} from '../engine/runtime/EvalRuntimeContract.js';
import { createExperimentScriptAdapter, type ExperimentScriptAdapter } from './ExperimentScriptAdapter.js';
import { decodeExperimentList } from '../engine/runtime/ExperimentMetadataContract.js';


// ─── Globals ──────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let store: PersistenceStore | null = null;
let backupService: BackupService | null = null;
let backupTimer: NodeJS.Timeout | null = null;
let updateChecker: UpdateCheckerService | null = null;
let autoUpdaterService: AutoUpdaterService | null = null;
// Task 5 crash marker: set at boot from the stale marker file, surfaced in the
// startup health report.
let previousRunUnclean = false;
let previousCrashMarker: unknown = null;
// P0-8: orphan running runs retired at startup ('interrupted'/process_crash).
let reconciledOrphanRuns: number | null = null;
// Latest auto-update event, kept for the renderer to query on demand.
let lastUpdateEvent: { type: string; version?: string; percent?: number; message?: string; trust?: unknown } = { type: 'idle' };
let researchRepository: ResearchRepository | null = null;
let outcomeRepository: OutcomeRepository | null = null;
let topicRepositoryInstance: TopicRepository | null = null;
let artifactPromptService: ArtifactPromptService | null = null;
let officePromptProfileService: OfficePromptProfileService | null = null;
let topicServiceSingleton: TopicService | null = null;
function ensureTopicService(): TopicService {
  if (!topicServiceSingleton) {
    topicServiceSingleton = new TopicService({
      repository: () => topicRepositoryInstance,
      researchRepository: () => researchRepository,
      runTurn: async (options) => {
        if (!agentLoop) return { status: 'agent_unavailable', answer: '' };
        const response = await runEphemeralChatTurn({
          agentLoop,
          sessionId: options.sessionId,
          messages: options.messages,
          requestId: `topic_chat_${Date.now().toString(36)}`,
          skillPrompt: options.skillPrompt,
          allowedTools: options.allowedTools ? [...options.allowedTools] : [...TOPIC_SEARCH_TOOLS],
          maxTurns: options.maxTurns,
          signal: options.signal,
          projectId: options.projectId,
          acceptUnverified: true,
        });
        return { status: response.status, answer: response.answer, diagnostics: response.diagnostics as Array<{ code?: string; message?: string }> | undefined };
      },
    });
  }
  return topicServiceSingleton;
}
let outcomeTemplateService: OutcomeTemplateService | null = null;
let submissionRepository: import('./SubmissionRepository.js').SubmissionRepository | null = null;
let journalProfileRepository: JournalProfileRepository | null = null;
let submissionPackageRepository: SubmissionPackageRepository | null = null;
let submissionReviewRepository: SubmissionReviewRepository | null = null;
let submissionReviewService: SubmissionReviewService | null = null;
let submissionPreflightService: SubmissionPreflightService | null = null;
let submissionPackageService: SubmissionPackageService | null = null;
// 无 agentLoop 的基础实例（模板降级路径）；provider 就绪时通道内按项目运行时另建带 agentLoop 的实例。
let submissionCoverLetterService: CoverLetterService | null = null;
// ── Submission P3/P4 外联服务：邮件外发 / 邮件监听 / 投稿门户操作 ──
let submissionCorrespondenceRepository: SubmissionCorrespondenceRepository | null = null;
let submissionMailboxStore: MailboxPoolStore | null = null;
let mailSendService: MailSendService | null = null;
let submissionMailService: SubmissionMailService | null = null;
let submissionPortalService: SubmissionPortalService | null = null;
let submissionDeadlineSync: SubmissionDeadlineSync | null = null;
let submissionMailWatcher: SubmissionMailWatcher | null = null;
let outcomeMedia: OutcomeMediaService | null = null;
let outcomeImage: OutcomeImageService | null = null;
let researchRuntime: ResearchRuntimeService | null = null;
let researchMedia: ResearchMediaService | null = null;
let weChatBotService: WeChatBotService | null = null;
let startupReady = false;
let firstRunSetup: FirstRunSetupService | null = null;
let providerProfileStore: ProviderProfileStore | null = null;
let providerProfileStorage: FirstRunSecureStorage | null = null;
let freeModelService: FreeModelService | null = null;
let runtimeGeneration = 0;
type PptxImportSession = {
  projectId: string;
  filePath: string;
  fileName: string;
  // Single snapshot read at import time: media commit and archive persist must
  // never re-read the path, or a mid-import file change would tear the
  // document apart from its media (TOCTOU).
  bytes: Buffer;
  document: PptDocument;
  createdAt: number;
  outcomeId?: string;
  reservedOutcome: boolean;
  mediaIds: string[];
  committedDocument?: PptDocument;
};
type WordDocxImportSession = {
  projectId: string;
  filePath: string;
  fileName: string;
  bytes: Buffer;
  document: WordDocument;
  createdAt: number;
  outcomeId?: string;
  reservedOutcome: boolean;
  mediaIds: string[];
  committedDocument?: WordDocument;
};
const pptxImportSessions = new Map<string, PptxImportSession>();
const wordDocxImportSessions = new Map<string, WordDocxImportSession>();
async function discardPptxImportSession(token: string, session: PptxImportSession): Promise<void> {
  pptxImportSessions.delete(token);
  if (outcomeMedia && session.outcomeId && session.mediaIds.length > 0) await outcomeMedia.removeGenerated(session.projectId, session.outcomeId, session.mediaIds);
  if (outcomeRepository && session.outcomeId && session.reservedOutcome) outcomeRepository.deleteReserved(session.projectId, session.outcomeId);
}
async function discardWordDocxImportSession(token: string, session: WordDocxImportSession): Promise<void> {
  wordDocxImportSessions.delete(token);
  if (outcomeMedia && session.outcomeId && session.mediaIds.length > 0) await outcomeMedia.removeGenerated(session.projectId, session.outcomeId, session.mediaIds);
  if (outcomeRepository && session.outcomeId && session.reservedOutcome) outcomeRepository.deleteReserved(session.projectId, session.outcomeId);
}
function pruneImportSessions(): void {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [token, session] of pptxImportSessions) if (session.createdAt < cutoff) void discardPptxImportSession(token, session);
  for (const [token, session] of wordDocxImportSessions) if (session.createdAt < cutoff) void discardWordDocxImportSession(token, session);
}
function prunePptxImportSessions(): void {
  pruneImportSessions();
}
let agentLoop: AgentLoop | null = null;
let provider: OpenAICompatProvider | null = null;
let memoryManager: MemoryManager | null = null;
let learningEngine: LearningEngine | null = null;
let goalEngine: GoalEngine | null = null;
/** Lazily-created durable goal store (rebound to the same sqlite store). */
let goalPersistence: GoalPersistence | null = null;
let researchStrategyStoreInstance: ResearchStrategyStore | null = null;
function strategyStore(): ResearchStrategyStore | null {
  if (!researchStrategyStoreInstance && store) {
    researchStrategyStoreInstance = new ResearchStrategyStore(store);
  }
  return researchStrategyStoreInstance;
}
let autonomousEngine: AutonomousResearchEngine | null = null;
let researchEventBus: ResearchEventBus | null = null;
/** Active autonomous session id (single concurrent run for now). */
let activeAutonomousSessionId: string | null = null;
interface ActiveAutonomousRun {
  sessionId: string;
  completion: Promise<void>;
  resolveCompletion: () => void;
}
let activeAutonomousRun: ActiveAutonomousRun | null = null;
let mcpManager: MCPManager | null = null;
let skillRegistry: SkillRegistry | null = null;
let skillExtractor: SkillExtractor | null = null;
const CUSTOM_SKILLS_MEMORY_KEY = 'skills:custom';
let personalizationRepository: PersonalizationRepository | null = null;
let personalizationRuntime: PersonalizationRuntimeService | null = null;
let evidenceEnvelopes: EvidenceEnvelopeService | null = null;
let personalizationSkills: PersonalizationSkillInstaller | null = null;

/** Installed package assets must not outlive a deleted or expired skill definition. */
function uninstallSkillAssetsForDefinition(definition: PersonalizationDefinition): void {
  if (definition.kind !== 'skill' || definition.sourceMode === 'markdown') return;
  try {
    const outcome = personalizationSkills?.uninstall(definition.id);
    if (outcome && !outcome.ok && outcome.code !== 'not_found') {
      console.warn(`[personalization] skill asset cleanup incomplete for ${definition.id}: ${outcome.code}`);
    }
  } catch (cleanupError) {
    console.warn(`[personalization] skill asset cleanup failed for ${definition.id}`, cleanupError);
  }
}
let personalizationMcp: PersonalizationMcpInstaller | null = null;
let personalizationMcpRuntime: ManagedPersonalizationMcpRuntime | null = null;
let personalizationMcpBridge: PersonalizationMcpToolBridge | null = null;
let personalizationMcpActivation: PersonalizationMcpActivationService | null = null;
let personalizationGeneratedMcpActivation: GeneratedMcpActivationCoordinator | null = null;
let personalizationExtensions: PersonalizationExtensionService | null = null;
let personalizationBundles: PersonalizationBundleService | null = null;
let personalizationBundleSink: PersonalizationBundleRepositorySink | null = null;
let personalizationBundleCoordinator: PersonalizationBundleImportCoordinator | null = null;
let personalizationBundleSkillAssets: PersonalizationBundleSkillAssetSource | null = null;
let personalizationSecretVault: PersonalizationSecretVault | null = null;
let scenarioLoopScheduler: ScenarioLoopScheduler | null = null;
const activeScenarioLoopRuns = new Map<string, import('./ScenarioLoopRunTracker.js').ActiveScenarioLoopRun>();
let fundingTemplateRepository: FundingTemplateRepository | null = null;
let fundingTemplateService: FundingTemplateService | null = null;
let fundingTemplateTools: FundingTemplateToolService | null = null;
const activeFundingToolScopes = new Map<string, {
  ownerId: string;
  projectId: string;
  ownerWebContentsId: number;
}>();
const FUNDING_LOCAL_OWNER_ID = 'local-user' as const;
let approvalStore: ApprovalStore | null = null;
interface ActiveChatRun {
  ownerWebContentsId: number;
  controller: AbortController;
  nextSequence: number;
  completion: Promise<void>;
  resolveCompletion: () => void;
  executionEvents?: AgentExecutionEventBridge;
  /** Public Scenario control (scenario:control): only present while a persisted Scenario workflow runs. */
  scenarioPause?: AbortController;
  scenarioCancel?: AbortController;
}
const activeChatRuns = new Map<string, ActiveChatRun>();
const runtimeShutdown = new RuntimeShutdownCoordinator();

// ── IPC 注册台账（任务3：一个 channel 一个 owner）──────────────
// 非 packaged（开发/测试）模式下 strict：重复注册立即抛错，而不是叠加
// listener 静默轮流应答。已迁移域经由 domainIpcContext 注册；未迁移的
// handler 仍直调 ipcMain.handle，由 registry snapshot 对账逐步收敛。
const ipcRegistry = new IpcRegistry({ ipcMain, strict: !app.isPackaged });
const ipcDomainDisposers: Array<() => void> = [];
const domainIpcContext: DomainIpcContext = {
  registry: ipcRegistry,
  requireRendererMainFrame,
  runtimeShutdown,
  agentLoop: () => agentLoop,
  ensureTopicService,
  freeModelService: () => freeModelService,
  provider: () => provider,
  store: () => store,
  researchRepository: () => researchRepository,
  providerProfileStore: () => providerProfileStore,
  experimentScriptAdapter: () => experimentScriptAdapter,
  fileCapabilities: () => fileCapabilities,
  ensureWeChatBot,
  browserService: () => browserService,
  collabService: () => collabService,
  ensureCollabService,
  dataDir: () => DATA_DIR,
  userDataDir: () => USER_DATA_DIR,
  defaultDataDir: () => DEFAULT_DATA_DIR,
  backupService: () => backupService,
};
const hitlApprovalRegistry = new ApprovalShutdownRegistry(runtimeShutdown, 'hitl-approval');
const scenarioApprovalRegistry = new ScenarioApprovalRegistry(runtimeShutdown);
let shutdownPromise: Promise<void> | null = null;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

function bindHitlApprovalHandler(target: ApprovalStore): void {
  target.setHandler((request) => {
    const win = mainWindow;
    if (!win || win.isDestroyed() || runtimeShutdown.isDraining()) return Promise.resolve(false);
    return hitlApprovalRegistry.request(request.id, {
      timeoutMs: 300_000,
      present: (resolve) => {
        const presented = ApprovalRequestViewSchema.safeParse({
          requestId: request.id,
          action: presentApprovalAction(request.toolName),
          createdAt: request.createdAt,
        });
        if (!presented.success) {
          resolve(false);
          return;
        }
        try {
          win.webContents.send('hitl:approval:required', presented.data);
        } catch {
          resolve(false);
        }
      },
    });
  });
}

function registerChatRunForShutdown(
  sessionId: string,
  run: ActiveChatRun,
  promise: Promise<unknown>,
): (() => void) | null {
  return registerRuntimeRunOrRollback(
    runtimeShutdown,
    {
      id: `chat:${sessionId}`,
      promise,
      abort: () => run.controller.abort(),
    },
    () => {
      if (activeChatRuns.get(sessionId) === run) {
        activeChatRuns.delete(sessionId);
        liveSteeringQueue.clear(sessionId);
      }
      run.resolveCompletion();
    },
  );
}
/**
 * O15: 多模型对比回合的运行登记。key 为 `${sessionId}::${profileId}`，
 * 与 activeChatRuns 分离——同一会话的多个 profile 对比调用是合法并行，
 * 但同一 profile 的重复并发与「正常回合 + 对比回合」混跑都要拦住。
 */
interface ActiveCompareRun {
  ownerWebContentsId: number;
  controller: AbortController;
  completion: Promise<void>;
  resolveCompletion: () => void;
}
const activeCompareRuns = new Map<string, ActiveCompareRun>();
/** O15: 判断某会话是否已有对比回合在跑（供正常回合入口做互斥）。 */
function hasCompareRunForSession(sessionId: string): boolean {
  const prefix = `${sessionId}::`;
  for (const key of activeCompareRuns.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}
const liveSteeringQueue = new InMemoryLiveSteeringQueue();
let experimentScriptAdapter: ExperimentScriptAdapter | null = null;
let caReceiptSecret: Buffer | null = null; // Current Affairs HMAC signing key
let caRuntime: import('./CurrentAffairsRuntimeService.js').CurrentAffairsRuntimeService | null = null;
/** Maps ownerSessionId (webContentsId) → invoking BrowserWindow for native approval dialog targeting. */
const caOwnerWindows = new Map<string, BrowserWindow>();
const EXPERIMENT_SESSION_SECRET = randomBytes(32).toString('base64url');
let citationTruthReceipts: CitationTruthReceiptService | null = null;
let currentConfig: ProviderConfig | null = null;
let currentTheme: string = 'light';
let layoutAcceptanceWindowControlEnabled = false;
const fileCapabilities = new FileCapabilityRegistry();
let executionCapabilities: ExecutionCapabilityRegistry | null = null;
const secureDownloads = new SecureDownloadService({
  sourceResolver: async (paperId) => {
    const paper = store?.getPapers().find((item) => item.id === paperId);
    return paper?.pdfUrl ? { url: paper.pdfUrl } : null;
  },
});
const secureExports = new SecureExportService();
const exportPreviews = new Map<string, {
  request: ExportRequest;
  plan: SecureExportPlan;
  expiresAt: number;
}>();

// ─── PTY (Terminal) ────────────────────────────────────────
interface ActiveTerminalSession {
  terminal: pty.IPty;
  grantId: string;
  owner: ExecutionOwnerIdentity;
  sequence: number;
  killed: boolean;
}
const activeTerminals = new Map<string, ActiveTerminalSession>();

let requestCounter = 0;

// Lazy browser service (created on first use; needs the main window + store).
let browserService: BrowserService | null = null;
function ensureBrowserService(): BrowserService | null {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;
  if (!browserService) {
    browserService = new BrowserService({ window: win, dataDir: DATA_DIR, store: store ?? null });
    // Attach eagerly so headless flows (portal automation, mail link fetch,
    // navigate/extract before the user opens the browser tab) have a live
    // WebContentsView. The view stays hidden until browser:show.
    browserService.attach();
  }
  return browserService;
}

// 协同对话视图（第三方 AI 网页版）：独立持久分区，与研究浏览器互不干扰。
let collabService: CollabService | null = null;
function ensureCollabService(): CollabService | null {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;
  if (!collabService) {
    collabService = new CollabService({ window: win });
  }
  return collabService;
}

// 内置文献检索服务（无状态，直接实例化）。
const literatureSearchService = new LiteratureSearchService();

// Agent-visible browser bridge (kimi-bridge style control for chat/strategy runs).
setBrowserControlBridge({
  navigate: async (url) => {
    const service = ensureBrowserService();
    return service ? service.navigate(url) : { ok: false, error: 'browser_unavailable' };
  },
  back: () => ensureBrowserService()?.goBack(),
  forward: () => ensureBrowserService()?.goForward(),
  reload: () => ensureBrowserService()?.reload(),
  click: (x, y) => ensureBrowserService()?.click(x, y),
  type: (text) => ensureBrowserService()?.type(text),
  scroll: (deltaX, deltaY) => ensureBrowserService()?.scroll(deltaX, deltaY),
  screenshot: async () => {
    const service = ensureBrowserService();
    return service ? service.screenshot() : { ok: false, error: 'browser_unavailable' };
  },
  extract: async () => {
    const service = ensureBrowserService();
    return service ? service.extract() : { ok: false, error: 'browser_unavailable' };
  },
  collect: async () => {
    const service = ensureBrowserService();
    return service ? service.collect() : { ok: false, error: 'browser_unavailable' };
  },
});

// ── Storage location ──────────────────────────────────────────
// The data directory is user-configurable (Settings → 存储位置). Only a tiny
// pointer file lives in `userData`; everything else follows DATA_DIR. Any
// pending relocation runs here, before any database handle is opened.
// 任务3：数据目录日志归档由 MainProcessLogger 承担（DATA_DIR 解析后 rebind，
// 解析前的行留在 logger 内存 backlog，随首次 flush 一并落盘）。

const USER_DATA_DIR = app.getPath('userData');
const DEFAULT_DATA_DIR = path.join(USER_DATA_DIR, 'metis-data');
const resolvedLocation = resolveDataDir(USER_DATA_DIR, (message) => console.log(`[Main] ${message}`));
const DATA_DIR = resolvedLocation.dataDir;
if (resolvedLocation.migrated) {
  console.log('[Main] Data directory migrated to:', DATA_DIR);
} else if (resolvedLocation.migrationError) {
  console.error(
    `[Main] Data directory migration failed (${resolvedLocation.migrationError}) — continuing at:`,
    DATA_DIR,
  );
}

// 后台作业队列（T10）：PDF 全文抽取等长任务，断点可恢复。
const jobQueueService = new JobQueueService({ dataDir: DATA_DIR, store: null });
jobQueueService.registerIpc();

// 方法库（T4）：跑通的做法沉淀为可参数化重放的资产。
const methodLibrary = new MethodLibraryService(DATA_DIR);
methodLibrary.registerIpc();

// 投稿管理（T20）：状态跟踪 + 退修意见 + 修改说明信。
const submissionTracker = new SubmissionTrackerService(DATA_DIR);
submissionTracker.registerIpc();

// 文献订阅监控（T25）：关键词定期查新，新文献入库待审（不自动下载）。
const literatureWatch = new LiteratureWatchService(DATA_DIR);
literatureWatch.registerIpc();

// 研究议程（T24）：自主科研自动接续队列（每项目上限 + 总量上限 + 冷却 + 可见通知）。
const researchAgenda = new ResearchAgendaService(DATA_DIR);
researchAgenda.registerIpc();

// 自主科研独立配置 + 用户画像（自主改造 A/B）。
const autonomousProfile = new AutonomousProfileService(DATA_DIR);
autonomousProfile.registerIpc();

// 批量选题生成（B）：提示词 + 画像 + 约束 → N 个差异化选题，批量入队自主议程。
ipcMain.handle('autonomous:generateBatch', async (event, raw: unknown) => {
  try {
    requireRendererMainFrame(event);
    const input = raw as { prompt?: unknown; count?: unknown };
    const prompt = typeof input?.prompt === 'string' ? input.prompt.trim().slice(0, 2000) : '';
    const count = Math.min(5, Math.max(1, Math.trunc(Number(input?.count)) || autonomousProfile.getProfile().defaultBatchSize));
    if (!prompt) return { ok: false, error: 'empty_prompt' };
    const activeProvider = provider;
    const tracked = trackEphemeralOperation(runtimeShutdown, {
      id: `autonomous:generateBatch:${++requestCounter}`,
      rejection: { ok: false, error: 'application_shutting_down' },
    });
    if (!tracked.admitted) return tracked.rejection;
    try {
      if (!activeProvider) return { ok: false, error: 'provider_unavailable' };

    // 上下文：提示词 + 独立约束 + 用户画像（memory/learning）。
    const memoryContext = memoryManager?.buildMemoryContext(undefined) ?? '';
    const learningContext = learningEngine?.buildLearningContext(undefined) ?? '';
    const context = autonomousProfile.buildContext({ prompt, memoryContext, learningContext });

    // 排除已有项目主题（避免重复选题）。
    const existingTitles = researchRepository?.listProjects().map((project) => project.title).slice(0, 50) ?? [];

    const systemPrompt = [
      '你是人文社科科研选题专家。基于用户指令、约束与画像，生成互不相同的候选研究选题。',
      `要求生成 ${count} 个选题。每个选题必须与其他选题、与已有项目在研究问题上有实质差异。`,
      existingTitles.length > 0 ? `已有项目（避免重复）：${existingTitles.join('；')}` : '',
      '只输出一个 JSON 数组，不要 Markdown 代码块，格式：[{"title":"项目名（10-20字）","researchQuestion":"具体可研究的问题","rationale":"为什么值得做（结合用户画像/约束，30-60字）"}]',
    ].filter(Boolean).join('\n');

    const response = await activeProvider.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: context },
    ], undefined, { signal: tracked.signal });
    if (tracked.signal.aborted) return { ok: false, error: 'application_shutting_down' };
    const text = (response.content ?? '').trim().replace(/^```(?:json)?/u, '').replace(/```$/u, '').trim();
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start < 0 || end <= start) return { ok: false, error: 'parse_failed', raw: text.slice(0, 200) };
    let topics: Array<{ title?: unknown; researchQuestion?: unknown; rationale?: unknown }>;
    try {
      topics = JSON.parse(text.slice(start, end + 1)) as typeof topics;
    } catch {
      return { ok: false, error: 'parse_failed', raw: text.slice(0, 200) };
    }
    const valid = topics
      .filter((topic) => typeof topic?.title === 'string' && typeof topic?.researchQuestion === 'string' && (topic.title as string).trim())
      .slice(0, count)
      .map((topic, index) => ({
        title: (topic.title as string).trim().slice(0, 120),
        researchQuestion: (topic.researchQuestion as string).trim().slice(0, 1000),
        rationale: typeof topic.rationale === 'string' ? topic.rationale.trim().slice(0, 500) : '',
        key: `auto-${Date.now().toString(36)}-${index}`,
      }));
    if (valid.length === 0) return { ok: false, error: 'no_valid_topics' };
    // 每个选题的完整 goal = 用户上下文 + 选题本身。
    const entries = valid.map((topic) => ({
      key: topic.key,
      title: topic.title,
      goalPrompt: `${context}\n\n## 本次选题（与其他选题独立执行）\n题目：${topic.title}\n研究问题：${topic.researchQuestion}\n选题理由：${topic.rationale}`,
    }));
    const added = researchAgenda.enqueueAutonomousBatch(entries, 1);
    return {
      ok: true,
      added,
      topics: valid.map((topic) => ({ title: topic.title, researchQuestion: topic.researchQuestion, rationale: topic.rationale })),
    };
    } catch (err) {
      if (tracked.signal.aborted) return { ok: false, error: 'application_shutting_down' };
      return { ok: false, error: String((err as Error).message ?? err).slice(0, 200) };
    } finally {
      tracked.cleanup();
    }
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err).slice(0, 200) };
  }
});

// 自主条目的项目落库：创建新 research project（执行端在接续自主条目时调用）。
ipcMain.handle('autonomous:createProjectFor', (event, raw: unknown) => {
  try {
    requireRendererMainFrame(event);
    const input = raw as { title?: unknown; researchQuestion?: unknown };
    const title = typeof input?.title === 'string' ? input.title.trim().slice(0, 200) : '';
    if (!title || !researchRepository) return { ok: false, projectId: null };
    const now = Date.now();
    const projectId = `project-auto-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    researchRepository.createProject({
      id: projectId,
      title,
      originalIntent: '',
      researchQuestion: typeof input?.researchQuestion === 'string' ? input.researchQuestion.slice(0, 2000) : '',
      lifecycle: 'draft',
      methodology: '',
      discipline: '',
      metadata: { source: 'autonomous' },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      version: 1,
      source: 'autonomous',
      deletedAt: null,
    });
    return { ok: true, projectId };
  } catch {
    return { ok: false, projectId: null };
  }
});

// 自定义 ISSN 白名单导入（T1 补全路径）：用户可导入官方 JCR/CSSCI 目录。
const CUSTOM_ISSN_PATH = path.join(DATA_DIR, 'custom-issns.json');
function loadCustomIssns(): void {
  try {
    if (!fs.existsSync(CUSTOM_ISSN_PATH)) return;
    const list = JSON.parse(fs.readFileSync(CUSTOM_ISSN_PATH, 'utf8')) as string[];
    if (Array.isArray(list)) extendSciSsciIssns(list);
  } catch { /* 脏文件忽略 */ }
}
loadCustomIssns();
ipcMain.handle('settings:importIssnList', async (event) => {
  try {
    requireRendererMainFrame(event);
    const { dialog } = await import('electron');
    const picked = await dialog.showOpenDialog({
      title: '选择 ISSN 清单文件（每行一个 ISSN）',
      filters: [{ name: '文本/CSV', extensions: ['txt', 'csv', 'tsv'] }],
      properties: ['openFile'],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, added: 0 };
    const content = fs.readFileSync(picked.filePaths[0]!, 'utf8');
    const candidates = content.split(/[\r\n,;\t]+/u).map((line) => line.trim()).filter(Boolean);
    const added = extendSciSsciIssns(candidates);
    if (added > 0) {
      const previous = fs.existsSync(CUSTOM_ISSN_PATH)
        ? (JSON.parse(fs.readFileSync(CUSTOM_ISSN_PATH, 'utf8')) as string[])
        : [];
      fs.writeFileSync(CUSTOM_ISSN_PATH, JSON.stringify([...new Set([...previous, ...candidates])], null, 1), 'utf8');
    }
    return { ok: true, added, totalCandidates: candidates.length };
  } catch (err) {
    return { ok: false, added: 0, error: String((err as Error).message ?? err).slice(0, 160) };
  }
});

// 概念图谱（T28）：从项目真实数据（资料/编码/论断）组装节点与边。
ipcMain.handle('concept:getGraph', (event, rawProjectId: unknown) => {  try {
    requireRendererMainFrame(event);
    const projectId = typeof rawProjectId === 'string' ? rawProjectId : '';
    const repo = researchRepository;
    if (!projectId || !repo) return null;
    const sources = repo.listSources(projectId).slice(0, 60).map((source) => ({
      id: source.id, kind: 'source' as const, label: source.title.slice(0, 40),
    }));
    const codes = repo.listNoteCodes(projectId).slice(0, 80).map((code) => ({
      id: code.id, kind: 'code' as const, label: code.code.slice(0, 30), evidenceId: code.evidenceId,
    }));
    const claims = repo.listClaims(projectId).slice(0, 80).map((claim) => ({
      id: claim.id, kind: 'claim' as const, label: claim.statement.slice(0, 60),
    }));
    const links = repo.listClaimEvidenceLinks(projectId).map((link) => {
      const evidence = repo.getEvidence(link.evidenceId);
      const sourceId = evidence?.sourceId ?? null;
      return { claimId: link.claimId, evidenceId: link.evidenceId, sourceId };
    });
    // 边：论断—证据挂接的资料；若证据被编码过，同时连 编码—论断。
    const edges: Array<{ from: string; to: string; kind: 'supports' | 'coded' }> = [];
    for (const link of links) {
      if (link.sourceId) edges.push({ from: link.claimId, to: link.sourceId, kind: 'supports' });
      for (const code of codes) {
        if (code.evidenceId && code.evidenceId === link.evidenceId) {
          edges.push({ from: link.claimId, to: code.id, kind: 'coded' });
        }
      }
    }
    const nodes = [...sources.map(({ id, kind, label }) => ({ id, kind, label })),
      ...codes.map(({ id, kind, label }) => ({ id, kind, label })),
      ...claims];
    return { nodes, edges };
  } catch {
    return null;
  }
});

  // ── PDF bulk import (T26): native file picker for real paths ──
  ipcMain.handle('dialog:openPdf', async (event) => {
    try {
      requireRendererMainFrame(event);
      const { dialog } = await import('electron');
      const result = await dialog.showOpenDialog({
        title: '选择要导入的 PDF 文献',
        filters: [{ name: 'PDF 文献', extensions: ['pdf'] }],
        properties: ['openFile', 'multiSelections'],
      });
      return result.canceled ? [] : result.filePaths;
    } catch {
      return [];
    }
  });

// PDF 批量导入（T26 冷启动）：拷入 dataDir/papers + Crossref 元数据反查 + 入队全文抽取。
// 请求可带 projectId：有自定义目录时归档到 projectDir/pdfs（批2）。
ipcMain.handle('import:pdfFiles', async (event, raw: unknown, rawProjectId?: unknown) => {
  try {
    requireRendererMainFrame(event);
    const files = Array.isArray(raw) ? (raw as unknown[]).filter((f): f is string => typeof f === 'string') : [];
    if (files.length === 0 || !store) return { ok: true, imported: 0, enriched: 0 };
    let outDir = path.join(DATA_DIR, 'papers');
    try {
      if (typeof rawProjectId === 'string' && rawProjectId && researchRepository) {
        const project = researchRepository.getProject(rawProjectId, false);
        const projectDir = (project?.metadata as { projectDir?: string } | undefined)?.projectDir;
        if (projectDir) outDir = path.join(projectDir, 'pdfs');
      }
    } catch { /* 回退默认目录 */ }
    fs.mkdirSync(outDir, { recursive: true });
    let imported = 0;
    let enriched = 0;
    for (const source of files.slice(0, 50)) {
      if (!fs.existsSync(source) || !/\.pdf$/iu.test(source)) continue;
      const dest = path.join(outDir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${path.basename(source).replace(/[^\w.-]/gu, '_').slice(0, 120)}`);
      fs.copyFileSync(source, dest);
      const baseTitle = path.basename(source, '.pdf').replace(/[_-]+/gu, ' ').trim().slice(0, 300);
      let title = baseTitle || path.basename(source);
      let authors: string[] = [];
      let year = 0;
      let venue = '';
      let doi = '';
      // Crossref 题名反查（尽力而为，失败不阻塞导入）。
      try {
        const url = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(baseTitle)}&rows=1&select=title,author,issued,container-title,DOI`;
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Metis-Workbench/0.1 (mailto:metis-workbench@localhost)' },
          signal: AbortSignal.timeout(12_000),
        });
        if (response.ok) {
          const payload = await response.json() as { message?: { items?: Array<{ title?: string[]; author?: Array<{ given?: string; family?: string }>; issued?: { 'date-parts'?: number[][] }; 'container-title'?: string[]; DOI?: string }> } };
          const hit = payload.message?.items?.[0];
          if (hit && hit.title?.[0]) {
            title = hit.title[0]!;
            authors = (hit.author ?? []).map((a) => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean).slice(0, 12);
            year = hit.issued?.['date-parts']?.[0]?.[0] ?? 0;
            venue = hit['container-title']?.[0] ?? '';
            doi = hit.DOI ?? '';
            enriched += 1;
          }
        }
      } catch { /* 离线/超时：保留文件名题录 */ }
      const paperId = `paper-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      store.savePaper({
        id: paperId,
        title,
        authors,
        year,
        venue,
        abstract: '',
        doi,
        arxivId: '',
        pdfPath: dest,
        pdfUrl: '',
        tags: ['imported:pdf'],
        notes: '',
        readStatus: 'unread',
        rating: 0,
        addedAt: Date.now(),
      });
      jobQueueService.enqueueExtract(paperId, dest);
      imported += 1;
    }
    return { ok: true, imported, enriched };
  } catch (err) {
    return { ok: false, imported: 0, enriched: 0, error: String((err as Error).message ?? err).slice(0, 200) };
  }
});

// 研究日志（T27）：惰性依赖 repository/goalEngine/store，请求时取最新引用。
ipcMain.handle('research:resumeBrief', (event, rawProjectId: unknown) => {
  try {
    requireRendererMainFrame(event);
    const projectId = typeof rawProjectId === 'string' ? rawProjectId : '';
    if (!projectId) return null;
    const liveJournal = new ResearchJournalService(researchRepository, goalEngine, store);
    return liveJournal.buildResumeBrief(projectId);
  } catch {
    return null;
  }
});

// 科研阶段（T5）：存储于 project.metadata.stage，与 lifecycle 状态机正交。
ipcMain.handle('research:getStage', (event, rawProjectId: unknown) => {
  try {
    requireRendererMainFrame(event);
    const projectId = typeof rawProjectId === 'string' ? rawProjectId : '';
    if (!projectId || !researchRepository) return null;
    const project = researchRepository.getProject(projectId, false);
    return (project?.metadata as { stage?: string } | undefined)?.stage ?? null;
  } catch {
    return null;
  }
});
ipcMain.handle('research:setStage', (event, rawRequest: unknown) => {
  try {
    requireRendererMainFrame(event);
    const request = rawRequest as { projectId?: unknown; stage?: unknown };
    const projectId = typeof request?.projectId === 'string' ? request.projectId : '';
    const stage = typeof request?.stage === 'string' ? request.stage.slice(0, 32) : '';
    if (!projectId || !researchRepository) return { ok: false };
    const project = researchRepository.getProject(projectId, false);
    if (!project) return { ok: false };
    researchRepository.updateProject(projectId, {
      metadata: { ...project.metadata, ...(stage ? { stage } : {}) },
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

// ── 项目归档/恢复/删除（批1）────────────────────────────────
ipcMain.handle('research:archiveProject', (event, rawProjectId: unknown) => {
  try {
    requireRendererMainFrame(event);
    const projectId = typeof rawProjectId === 'string' ? rawProjectId : '';
    if (!projectId || !researchRepository) return { ok: false };
    const project = researchRepository.getProject(projectId, false);
    if (!project || project.lifecycle === 'archived') return { ok: false };
    // 归档前记住原生命周期，恢复时转回。
    researchRepository.updateProject(projectId, {
      lifecycle: 'archived',
      metadata: { ...project.metadata, preArchiveLifecycle: project.lifecycle },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err).slice(0, 160) };
  }
});
ipcMain.handle('research:restoreProject', (event, rawProjectId: unknown) => {
  try {
    requireRendererMainFrame(event);
    const projectId = typeof rawProjectId === 'string' ? rawProjectId : '';
    if (!projectId || !researchRepository) return { ok: false };
    const project = researchRepository.getProject(projectId, false);
    if (!project || project.lifecycle !== 'archived') return { ok: false };
    const prior = (project.metadata as { preArchiveLifecycle?: string }).preArchiveLifecycle;
    const target = prior === 'completed' || prior === 'reviewing' ? prior : 'draft';
    researchRepository.updateProject(projectId, {
      lifecycle: target,
      metadata: { ...project.metadata, preArchiveLifecycle: undefined },
    });
    return { ok: true, restoredLifecycle: target };
  } catch (err) {
    return { ok: false, error: String((err as Error).message ?? err).slice(0, 160) };
  }
});
ipcMain.handle('research:deleteProject', (event, rawProjectId: unknown) => {
  try {
    requireRendererMainFrame(event);
    const projectId = typeof rawProjectId === 'string' ? rawProjectId : '';
    if (!projectId || !researchRepository) return { ok: false };
    const removed = researchRepository.softDeleteProject(projectId);
    return { ok: removed };
  } catch {
    return { ok: false };
  }
});

// ── 项目自定义目录（批2）：PDF 归档位置，默认数据目录自动管理 ──
ipcMain.handle('dialog:openDirectory', async (event) => {
  try {
    requireRendererMainFrame(event);
    const { dialog } = await import('electron');
    const result = await dialog.showOpenDialog({
      title: '选择项目文件夹（PDF 将归档到其 pdfs 子目录）',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  } catch {
    return null;
  }
});
ipcMain.handle('research:setProjectDir', (event, rawRequest: unknown) => {
  try {
    requireRendererMainFrame(event);
    const request = rawRequest as { projectId?: unknown; projectDir?: unknown };
    const projectId = typeof request?.projectId === 'string' ? request.projectId : '';
    const projectDir = typeof request?.projectDir === 'string' ? request.projectDir.trim().slice(0, 500) : '';
    if (!projectId || !researchRepository) return { ok: false };
    const project = researchRepository.getProject(projectId, false);
    if (!project) return { ok: false };
    researchRepository.updateProject(projectId, {
      metadata: { ...project.metadata, ...(projectDir ? { projectDir } : { projectDir: undefined }) },
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
});

// ── AI 阶段自动判定（批3）：实时规则评分，用户不可手选 ──
ipcMain.handle('research:detectStage', (event, rawProjectId: unknown) => {
  try {
    requireRendererMainFrame(event);
    const projectId = typeof rawProjectId === 'string' ? rawProjectId : '';
    if (!projectId || !researchRepository || !store) return null;
    const project = researchRepository.getProject(projectId, false);
    if (!project) return null;
    const papers = store.getPapers().filter((paper) => paper.projectId === projectId);
    const goals = (goalEngine?.listGoals() ?? []).filter((goal) => goal.projectId === projectId);
    const artifacts = researchRepository.listArtifacts(projectId);
    const noteCodes = researchRepository.listNoteCodes(projectId);
    const runs = researchRepository.listRuns(projectId);
    const latestRun = runs.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
    const transcripts = store.raw.prepare(
      "SELECT COUNT(*) as c FROM notes WHERE project_id = ? AND tags LIKE '%type:transcript%'",
    ).get(projectId) as { c: number };
    const submissions = new SubmissionTrackerService(DATA_DIR).list(projectId).length;
    const result = detectStage({
      paperCount: papers.length,
      paperWithPdfCount: papers.filter((paper) => Boolean(paper.pdfPath)).length,
      completedTasks: goals.filter((goal) => goal.status === 'completed').length,
      openTasks: goals.filter((goal) => goal.status !== 'completed').length,
      artifactCount: artifacts.length,
      noteCodeCount: noteCodes.length,
      transcriptCount: transcripts.c,
      researchQuestionFilled: Boolean(project.researchQuestion.trim()),
      lastRunStatus: latestRun?.status ?? null,
      submissionCount: submissions,
    });
    return result;
  } catch {
    return null;
  }
});

// ── Custom app scheme for the production renderer ─────────────
// file:// URLs cannot load ESM bundles (Chromium blocks module scripts with a
// null origin + crossorigin attribute), so production serves dist/ over a
// privileged `metis://` scheme. Must be registered before app ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'metis-app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
process.env.METIS_DATA_DIR = DATA_DIR;

const PAPERS_DIR = path.join(DATA_DIR, 'papers');
const IMPORTS_DIR = path.join(DATA_DIR, 'imports');
const RESEARCH_MEDIA_DIR = path.join(DATA_DIR, 'research-media');
const OUTCOME_MEDIA_DIR = path.join(DATA_DIR, 'outcome-media');
const GENOFFICE_ROOT = resolveGenofficeRoot({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  envRoot: process.env.METIS_GENOFFICE_ROOT,
  devCandidates: [
    path.resolve(__dirname, '..', '..', '..', 'tools', 'genoffice'),
    path.resolve(process.cwd(), '..', 'tools', 'genoffice'),
  ],
});
const GENOFFICE_EDITOR_ROOTS = {
  word: path.join(GENOFFICE_ROOT, 'apps', 'docs'),
  ppt: path.join(GENOFFICE_ROOT, 'apps', 'slides'),
  spreadsheet: path.join(GENOFFICE_ROOT, 'apps', 'sheets'),
  pdf: path.join(GENOFFICE_ROOT, 'apps', 'pdf'),
} as const;
const GENOFFICE_EDITOR_ENTRIES = {
  word: path.join(GENOFFICE_EDITOR_ROOTS.word, 'out', 'main', 'index.js'),
  ppt: path.join(GENOFFICE_EDITOR_ROOTS.ppt, 'out', 'main', 'index.js'),
  spreadsheet: path.join(GENOFFICE_EDITOR_ROOTS.spreadsheet, 'out', 'main', 'index.js'),
  pdf: path.join(GENOFFICE_EDITOR_ROOTS.pdf, 'out', 'main', 'index.js'),
} as const;
// Packaged runs load the wrapper from resources/genoffice outside app.asar;
// afterPack pins a neighbouring package.json to "type": "module" because the
// compiled Electron bundle is ESM.
const GENOFFICE_STANDALONE_WRAPPER = app.isPackaged
  ? path.join(GENOFFICE_ROOT, 'wrapper', 'genofficeStandaloneWrapper.js')
  : path.join(__dirname, 'genofficeStandaloneWrapper.js');

async function launchGenofficeEditor(input: { kind: 'word' | 'ppt' | 'spreadsheet' | 'pdf'; filePath: string }): Promise<{ pid?: number; close: () => Promise<void> }> {
  const entry = GENOFFICE_EDITOR_ENTRIES[input.kind];
  const appRoot = GENOFFICE_EDITOR_ROOTS[input.kind];
  if (!fs.existsSync(entry) || !fs.existsSync(GENOFFICE_STANDALONE_WRAPPER)) {
    throw new Error('genoffice_unavailable');
  }
  const userData = path.join(DATA_DIR, 'genoffice-userdata', input.kind, path.basename(path.dirname(input.filePath)));
  fs.mkdirSync(userData, { recursive: true });
  const electronCli = app.isPackaged
    ? path.join(GENOFFICE_ROOT, 'electron', process.platform === 'win32' ? 'electron.exe' : 'electron')
    : path.join(GENOFFICE_ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'Electron');
  if (!fs.existsSync(electronCli)) throw new Error('genoffice_unavailable');
  const debugPort = Number(process.env.METIS_GENOFFICE_DEBUG_PORT);
  const debugArguments = process.env.METIS_GENOFFICE_DEBUG === '1'
    && Number.isInteger(debugPort) && debugPort >= 1024 && debugPort <= 65_535
    ? [`--remote-debugging-port=${debugPort}`]
    : [];
  const sidecarPath = app.isPackaged
    ? path.join(GENOFFICE_ROOT, 'apps', 'sheets', 'native', 'xlsx-engine', 'target', 'release')
    : path.join(__dirname, 'native', 'xlsx-engine', 'target', 'release');
  const childEnvironment = buildGenofficeEnvironment(process.env, {
    GENOFFICE_USER_DATA: userData,
    AI_OFFICE_USER_DATA: userData,
    XLSX_OPEN_PATH: input.kind === 'spreadsheet' ? input.filePath : '',
    XLSX_SIDECAR_PATH: input.kind === 'spreadsheet'
      ? path.join(sidecarPath, process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar')
      : '',
    GENOFFICE_DISABLE_ANALYTICS: '1',
    GENOFFICE_DISABLE_CLOUD: '1',
    METIS_GENOFFICE_DEBUG: process.env.METIS_GENOFFICE_DEBUG === '1' ? '1' : '',
    // The wrapper's debug-only file-path exposure reads the port from the
    // environment; CDP alone is passed as a CLI argument and is not enough.
    METIS_GENOFFICE_DEBUG_PORT: process.env.METIS_GENOFFICE_DEBUG === '1'
      && Number.isInteger(debugPort) && debugPort >= 1024 && debugPort <= 65_535
      ? String(debugPort)
      : '',
    // Metis Office 对齐：AI 用 METIS 当前连接（OpenAI 兼容 custom profile），
    // 外观主题跟随 METIS 当前深浅；两者都由 wrapper 读取，编辑器内不可单独改。
    ...(currentConfig && currentConfig.baseUrl && currentConfig.apiKey && currentConfig.model ? {
      METIS_AI_BASE_URL: currentConfig.baseUrl,
      METIS_AI_API_KEY: currentConfig.apiKey,
      METIS_AI_MODEL: currentConfig.model,
    } : {}),
    METIS_UI_THEME: currentTheme === 'dark' ? 'dark' : 'light',
  });
  const child = spawn(electronCli, [`--user-data-dir=${userData}`, ...debugArguments, GENOFFICE_STANDALONE_WRAPPER, entry, input.filePath], {
    cwd: appRoot,
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  child.stdout?.resume();
  // Keep the pipe drained even though user-facing errors are returned through
  // the bounded IPC contract. An editor with verbose diagnostics must not block
  // on a full stderr pipe while the METIS window remains open.
  let childStderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    childStderrTail = `${childStderrTail}${chunk}`.slice(-4000);
  });
  let closedByLauncher = false;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      reject(new Error('genoffice_open_timeout'));
    }, 30_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, '');
        buffer = buffer.slice(newline + 1);
        const ready = parseGenofficeReadyLine(line);
        const samePath = (left: string, right: string): boolean => process.platform === 'win32'
          ? path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase()
          : path.normalize(left) === path.normalize(right);
        if (ready && ready.editorReady === true && samePath(ready.entry, entry)
          && ready.filePath !== null && samePath(ready.filePath, input.filePath) && !settled) {
          settled = true;
          clearTimeout(timeout);
          resolve();
          break;
        }
        newline = buffer.indexOf('\n');
      }
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`genoffice_open_failed:${code ?? signal ?? 'unknown'}`));
    });
  });
  child.once('exit', (code, signal) => {
    // A non-zero exit is expected when METIS itself closed the session after a
    // successful sync (taskkill on Windows reports code 1); only unexpected
    // terminations carry the stderr tail into the log.
    if (code !== 0 && signal === null && !closedByLauncher) console.warn(`[GenOffice] ${input.kind} editor exited with code ${code}${childStderrTail ? `\n${childStderrTail}` : ''}`);
  });
  return {
    pid: child.pid,
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      closedByLauncher = true;
      if (process.platform === 'win32' && child.pid) {
        const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        if (result.error || result.status !== 0) throw new Error('genoffice_close_failed');
      } else {
        if (!child.kill()) throw new Error('genoffice_close_failed');
      }
      await new Promise<void>((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        const timer = setTimeout(() => reject(new Error('genoffice_close_timeout')), 10_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}
async function syncOutcomeFromGenoffice(projectId: string, outcomeId: string, token: string) {
  try {
    if (!outcomeRepository || !outcomeMedia || !outcomeExternalEditor) return OutcomeExternalEditorSyncResultSchema.parse({ ok: false, code: 'outcomes_unavailable', message: '成果或 GenOffice 编辑服务尚未初始化。' });
    const current = outcomeRepository.get(projectId, outcomeId);
    if (!current) return OutcomeExternalEditorSyncResultSchema.parse({ ok: false, code: 'outcome_not_found', message: '当前成果不存在或不属于当前项目。' });
    const opened = await outcomeExternalEditor.read({ token: token, projectId: projectId, outcomeId: outcomeId, currentVersion: current.outcome.currentVersion });
    if (opened.session.kind === 'word') {
      const imported = await new OutcomeWordDocxService({ engine: 'genoffice' }).importBufferV2(opened.bytes);
      const createdMedia: string[] = [];
      try {
        const document = await new OutcomeWordDocxService({ engine: 'genoffice' }).commitImportedMedia(opened.bytes, imported.document, async (image) => {
          const media = await outcomeMedia!.persistGenerated(projectId, outcomeId, image.bytes, image.mediaType, image.displayName);
          if (media) createdMedia.push(media.id);
          return media ? { id: media.id, mediaType: image.mediaType, displayName: media.displayName } : undefined;
        }, async (mediaIds) => outcomeMedia!.removeGenerated(projectId, outcomeId, mediaIds));
        const archive = await outcomeMedia.persistArchive(projectId, outcomeId, opened.bytes, 'docx', opened.session.filePath.split(/[\\/]/u).pop() ?? 'external.docx');
         if (!archive) throw new Error('genoffice_archive_persist_failed');
         createdMedia.push(archive.id); (document.page as Record<string, unknown>)._originalArchiveMediaId = archive.id;
          const saved = outcomeRepository.save({ projectId: projectId, outcomeId: outcomeId, baseVersion: opened.session.baseVersion, content: document, note: '通过 GenOffice 编辑器同步 Word', actor: 'human', sources: [] });
          let warning: string | undefined;
          try { await outcomeExternalEditor.close(token); } catch { warning = '版本已保存，但 GenOffice 会话未能清理；请稍后重试“放弃会话”。'; }
         return OutcomeExternalEditorSyncResultSchema.parse({ ok: true, detail: saved, ...(warning ? { warning } : {}) });
      } catch (error) {
        await outcomeMedia.removeGenerated(projectId, outcomeId, createdMedia);
        throw error;
      }
    }
    if (opened.session.kind === 'ppt') {
      const imported = await new OutcomePptxService({ engine: 'genoffice' }).importBufferV2(opened.bytes);
      const createdMedia: string[] = [];
      try {
        const document = await new OutcomePptxService({ engine: 'genoffice' }).commitImportedMediaBuffer(opened.bytes, imported.document, async (image) => {
          const media = await outcomeMedia!.persistGenerated(projectId, outcomeId, image.bytes, image.mediaType, image.displayName);
          if (media) createdMedia.push(media.id);
          return media ? { id: media.id, mediaType: image.mediaType, displayName: media.displayName } : undefined;
        });
        const archive = await outcomeMedia.persistArchive(projectId, outcomeId, opened.bytes, 'pptx', opened.session.filePath.split(/[\\/]/u).pop() ?? 'external.pptx');
         if (!archive) throw new Error('genoffice_archive_persist_failed');
         createdMedia.push(archive.id); document.theme[GENOFFICE_PPTX_ORIGINAL_ARCHIVE_KEY] = archive.id;
          const saved = outcomeRepository.save({ projectId: projectId, outcomeId: outcomeId, baseVersion: opened.session.baseVersion, content: document, note: '通过 GenOffice 编辑器同步 PPT', actor: 'human', sources: [] });
          let warning: string | undefined;
          try { await outcomeExternalEditor.close(token); } catch { warning = '版本已保存，但 GenOffice 会话未能清理；请稍后重试“放弃会话”。'; }
         return OutcomeExternalEditorSyncResultSchema.parse({ ok: true, detail: saved, ...(warning ? { warning } : {}) });
      } catch (error) {
        await outcomeMedia.removeGenerated(projectId, outcomeId, createdMedia);
        throw error;
      }
    }
    try {
      if (opened.session.kind === 'pdf') await validatePdfBytes(opened.bytes);
      else await parseSpreadsheetWorkbook(opened.bytes);
    } catch {
      return OutcomeExternalEditorSyncResultSchema.parse({ ok: false, code: 'genoffice_import_failed', message: 'GenOffice 保存文件没有通过真实文件结构校验，当前成果没有被修改。' });
    }
    const media = await outcomeMedia.persistExternalDocument(projectId, outcomeId, opened.bytes, opened.session.kind, opened.session.filePath.split(/[\\/]/u).pop() ?? (opened.session.kind === 'pdf' ? 'external.pdf' : 'external.xlsx'));
    if (!media) return OutcomeExternalEditorSyncResultSchema.parse({ ok: false, code: 'genoffice_import_failed', message: 'GenOffice 保存文件未通过真实文件完整性校验，当前成果没有被修改。' });
    try {
      const content = await externalDocumentFromSavedBytes(opened.session.kind, media, opened.bytes);
      const saved = outcomeRepository.save({ projectId: projectId, outcomeId: outcomeId, baseVersion: opened.session.baseVersion, content, note: `通过 GenOffice 编辑器同步${opened.session.kind === 'pdf' ? ' PDF' : ' Excel'}`, actor: 'human', sources: [] });
      let warning: string | undefined;
      try { await outcomeExternalEditor.close(token); } catch { warning = '版本已保存，但 GenOffice 会话未能清理；请稍后重试“放弃会话”。'; }
      return OutcomeExternalEditorSyncResultSchema.parse({ ok: true, detail: saved, ...(warning ? { warning } : {}) });
    } catch (error) {
      await outcomeMedia.removeGenerated(projectId, outcomeId, [media.id]);
      throw error;
    }
  } catch (error) {
    const code = String((error as Error).message ?? error);
     const known = ['external_editor_scope_denied', 'external_editor_version_conflict', 'external_editor_not_changed', 'external_editor_file_missing', 'external_editor_file_invalid', 'genoffice_close_failed', 'genoffice_close_timeout', 'genoffice_archive_persist_failed', 'pdf_structure_invalid', 'pdf_signature_invalid', 'spreadsheet_workbook_missing'].includes(code) ? code : 'outcome_save_failed';
    const message = known === 'external_editor_version_conflict' ? '成果版本已更新，GenOffice 草稿没有覆盖当前版本。请重新打开当前版本再同步。' : known === 'external_editor_not_changed' ? 'GenOffice 尚未保存该文件，当前成果没有被修改。' : 'GenOffice 文件同步没有完成，当前成果没有被修改。';
    return OutcomeExternalEditorSyncResultSchema.parse({ ok: false, code: known, message });
  }
}

const outcomeExternalEditor = new OutcomeExternalEditorService(
  path.join(DATA_DIR, 'external-editors'),
  launchGenofficeEditor,
  {
    // 会话彻底关闭后同步回收对应的内嵌视图（运行期才调用，无 TDZ 问题）。
    onClosed: (session) => {
      try { genofficeEmbeddedViews.closeByOutcome(session.outcomeId); } catch (error) {
        console.warn('[genoffice-embedded] close cleanup failed:', error instanceof Error ? error.message : error);
      }
    },
    // 编辑器关闭自动同步（2026-09-01 刘总要求）：独立窗口的 Metis Office 一关，
    // 有保存改动就直接入库新版本并通知页面，不再要求手点「同步回 METIS」。
    onEditorClosed: async (session, changed) => {
      const broadcast = (payload: Record<string, unknown>) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('outcomes:external-editor:auto-sync', { projectId: session.projectId, outcomeId: session.outcomeId, ...payload });
        }
      };
      if (!changed) {
        try { await outcomeExternalEditor.close(session.token); } catch (error) {
          console.warn('[genoffice-external] clean-close failed:', error instanceof Error ? error.message : error);
        }
        broadcast({ ok: true, changed: false, message: 'Metis Office 已关闭：内容没有修改，会话已自动结束。' });
        return;
      }
      console.log(`[genoffice-external] editor closed with changes — auto-syncing outcome=${session.outcomeId}`);
      const result = await syncOutcomeFromGenoffice(session.projectId, session.outcomeId, session.token);
      broadcast(result.ok
        ? { ok: true, changed: true, version: result.detail.outcome.currentVersion, title: result.detail.outcome.title, message: `检测到 Metis Office 已关闭，改动已自动同步为新版本 v${result.detail.outcome.currentVersion}。` }
        : { ok: false, changed: true, code: result.code, message: `Metis Office 已关闭，但自动同步没有完成：${result.message}（会话保留，可手动重试同步或放弃）` });
    },
  },
);
void outcomeExternalEditor.recoverStale().catch(() => undefined);
// 嵌入式 GenOffice：把编辑器渲染页装进主窗口的 WebContentsView，
// 几何对齐成果页编辑区；数据仍走外部会话管线（同一 token/文件）。
const genofficeEmbeddedViews = new GenofficeEmbeddedViewService({ genofficeRoot: GENOFFICE_ROOT });
// 兼容通道必须在 METIS 自身全部 handler 注册完成之后再挂载：
// compatHandle 只补空白通道，绝不覆盖主应用已有通道（如 project:list）。
const TERMINAL_WORKSPACE_DIR = path.join(DATA_DIR, 'terminal-workspace');
const DB_PATH = path.join(DATA_DIR, 'metis.db');
const CONFIG_PATH = path.join(DATA_DIR, 'provider-config.json');
const SETUP_CONFIG_PATH = path.join(DATA_DIR, 'provider-setup.json');
const THEME_PATH = path.join(DATA_DIR, 'theme.txt');

// WebDAV 云备份（T33）：用户自填服务器；启动时应用恢复暂存（DB_PATH 已就绪）。
const cloudSync = new CloudSyncService(DATA_DIR, DB_PATH);
cloudSync.registerIpc();
const layoutAcceptanceToken = extractLayoutAcceptanceToken(process.argv);
export const layoutAcceptanceEntryPath = path.resolve(__dirname, '../../dist/index.html');
const rendererEntryUrl = process.env.VITE_DEV_SERVER_URL
  ?? 'metis-app://renderer/index.html';
const RUNTIME_BUILD_ID = 'metis-alpha2-release';
const RUNTIME_STARTED_AT = Date.now();

function getRuntimeIdentity() {
  return {
    buildId: RUNTIME_BUILD_ID,
    appVersion: app.getVersion(),
    mode: process.env.VITE_DEV_SERVER_URL ? 'development' as const : 'packaged' as const,
    sourceRoot: path.resolve(__dirname, '../..'),
    mainEntry: __filename,
    rendererEntry: rendererEntryUrl,
    dataDir: DATA_DIR,
    electronVersion: process.versions.electron ?? '',
    startedAt: RUNTIME_STARTED_AT,
  };
}

export function getRendererEntryUrl(): string {
  return rendererEntryUrl;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function mimeForLocalFile(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const known: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.jsonl': 'application/x-ndjson',
    '.tex': 'application/x-tex',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
  };
  return known[extension] ?? 'application/octet-stream';
}

// Per-WebContents generation counter for SetupOwner revocation.
// Incremented on main-frame navigation/reload; cleared on destroy.
const webContentsGenerations = new Map<number, number>();

function setupOwnerFor(event: IpcMainInvokeEvent) {
  const frame = event.senderFrame;
  if (!frame?.processId || !frame?.routingId) {
    throw new Error("Setup owner requires a valid sender frame");
  }
  const wcId = event.sender.id;
  const generation = webContentsGenerations.get(wcId) ?? 0;
  return { webContentsId: wcId, processId: frame.processId, routingId: frame.routingId, generation };
}

function bumpWebContentsGeneration(wcId: number) {
  webContentsGenerations.set(wcId, (webContentsGenerations.get(wcId) ?? 0) + 1);
}

function cleanupActiveChatRuns(wcId: number) {
  for (const [sessionId, run] of activeChatRuns) {
    if (run.ownerWebContentsId !== wcId) continue;
    run.executionEvents?.dispose();
    run.controller.abort();
    liveSteeringQueue.clear(sessionId);
    activeChatRuns.delete(sessionId);
    activeFundingToolScopes.delete(sessionId);
  }
}

function cleanupWebContentsOwner(wcId: number) {
  webContentsGenerations.delete(wcId);
  firstRunSetup?.revokeWebContents(wcId);
  caRuntime?.clearOwner(String(wcId));
  caOwnerWindows.delete(String(wcId));
  cleanupActiveChatRuns(wcId);
  void personalizationMcpRuntime?.shutdownWebContents(wcId);
}


function sanitizeListUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url;
    return null; // reject file://, local paths, etc.
  } catch { return null; }
}

function getLayoutAcceptanceMetadata() {
  return createLayoutAcceptanceMetadata(
    layoutAcceptanceToken,
    app.getPath('userData'),
    layoutAcceptanceEntryPath,
  );
}

function requireLayoutAcceptanceMainFrame(event: IpcMainInvokeEvent): BrowserWindow {
  const liveMainWindow = getMainWindow();
  const window = BrowserWindow.fromWebContents(event.sender);
  const senderFrame = event.senderFrame;
  const senderWindowMatches = Boolean(
    window && window === liveMainWindow && !window.isDestroyed(),
  );
  requireLayoutAcceptanceRequest({
    token: layoutAcceptanceToken,
    controlEnabled: layoutAcceptanceWindowControlEnabled,
    senderWindowMatches,
    senderFrameMatches: Boolean(
      senderWindowMatches && senderFrame === window?.webContents.mainFrame,
    ),
    senderFrameUrl: senderFrame?.url ?? '',
    expectedEntryPath: layoutAcceptanceEntryPath,
  });
  return window!;
}

export function requireRendererMainFrame(event: IpcMainInvokeEvent): BrowserWindow {
  const liveMainWindow = getMainWindow();
  const liveEntryUrl = getRendererEntryUrl();
  const window = BrowserWindow.fromWebContents(event.sender);
  const senderFrame = event.senderFrame;
  const senderWindowMatches = Boolean(
    window && window === liveMainWindow && !window.isDestroyed(),
  );
  const authorized = isAuthorizedRendererMainFrame({
    senderWindowMatches,
    senderFrameMatches: Boolean(
      senderWindowMatches && senderFrame === window?.webContents.mainFrame,
    ),
    senderFrameUrl: senderFrame?.url ?? '',
    expectedEntryUrl: liveEntryUrl,
  });
  if (!authorized) throw new Error('Unauthorized IPC sender');
  return window!;
}

let scenarioApprovalSequence = 0;

async function resolveScenarioHookApproval(
  event: IpcMainInvokeEvent,
  input: { hookId: string; stepId: string; instruction: string; runId: string },
): Promise<boolean> {
  try {
    const approvalWindow = BrowserWindow.fromWebContents(event.sender);
    if (!approvalWindow || approvalWindow.isDestroyed()) return false;
    // 审批走 renderer 内界面（场景页可见、可键盘/自动化可靠驱动）；
    // 120 秒无响应或通道异常一律 fail-closed（拒绝）。
    const requestId = `scenario-approval-${Date.now().toString(36)}-${++scenarioApprovalSequence}`;
    return await scenarioApprovalRegistry.request(requestId, {
      timeoutMs: 120_000,
      present: (resolve) => {
        const onClosed = () => resolve(false);
        approvalWindow.once('closed', onClosed);
        try {
          approvalWindow.webContents.send('scenario:approval:required', {
            requestId,
            hookId: input.hookId,
            stepId: input.stepId,
            instruction: input.instruction,
            runId: input.runId,
          });
        } catch {
          approvalWindow.removeListener('closed', onClosed);
          resolve(false);
        }
        return () => approvalWindow.removeListener('closed', onClosed);
      },
    });
  } catch {
    return false;
  }
}

export function executionOwnerFor(event: IpcMainInvokeEvent): ExecutionOwnerIdentity {
  const frame = event.senderFrame;
  if (!frame) throw new Error('Execution owner is unavailable');
  return {
    webContentsId: event.sender.id,
    mainFrameProcessId: frame.processId,
    mainFrameRoutingId: frame.routingId,
  };
}

function managedMcpOwnerFor(event: IpcMainInvokeEvent) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) throw new Error('Managed MCP owner is unavailable');
  return {
    webContentsId: event.sender.id,
    processId: frame.processId,
    routingId: frame.routingId,
    generation: webContentsGenerations.get(event.sender.id) ?? 0,
  };
}

function canonicalPersonalizationJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPersonalizationJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalPersonalizationJson(record[key])}`).join(',')}}`;
}

function bindPersonalizationExtensionRequest(
  request: PersonalizationExtensionIpcRequest,
  event: IpcMainInvokeEvent,
): PersonalizationExtensionApplyRequest | undefined {
  const owner = executionOwnerFor(event);
  const operationId = request.operationId;
  const runManifestDigest = createHash('sha256')
    .update('metis:personalization-extension-ipc:v1\0')
    .update(canonicalPersonalizationJson({ owner, request }))
    .digest('hex');
  const evidenceContext = {
    sessionId: `personalization-${owner.webContentsId}`,
    projectId: 'global',
    operationId,
    runManifestDigest,
    observedAt: Date.now(),
  };
  const { operationId: _operationId, ...withoutOperationId } = request;
  const internal = request.mode === 'mcp_requirements'
    ? { ...withoutOperationId, operationId, evidenceContext }
    : { ...withoutOperationId, evidenceContext };
  void _operationId;
  const parsed = PersonalizationExtensionApplyRequestSchema.safeParse(internal);
  return parsed.success ? parsed.data : undefined;
}

function bindMcpActivationRequest(
  request: McpActivationIpcRequest,
  event: IpcMainInvokeEvent,
): McpActivationRequest | undefined {
  const owner = managedMcpOwnerFor(event);
  const runManifestDigest = createHash('sha256')
    .update('metis:personalization-mcp-activation-ipc:v1\0')
    .update(canonicalPersonalizationJson({ owner, request }))
    .digest('hex');
  const parsed = McpActivationRequestSchema.safeParse({
    contractVersion: 1,
    definitionId: request.definitionId,
    installationId: request.installationId,
    expectedRevision: request.expectedRevision,
    evidenceContext: {
      sessionId: `personalization-${owner.webContentsId}-${owner.generation}`,
      projectId: 'global',
      operationId: request.operationId,
      runManifestDigest,
      observedAt: Date.now(),
      owner,
    },
  });
  return parsed.success ? parsed.data : undefined;
}

function writePersonalizationBundleFile(destination: string, bytes: Uint8Array): void {
  const parent = path.dirname(path.resolve(destination));
  const parentStat = fs.lstatSync(parent);
  const parentReal = fs.realpathSync.native(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
    || (process.platform === 'win32' ? parentReal.toLowerCase() !== parent.toLowerCase() : parentReal !== parent)) {
    throw new Error('Unsafe bundle destination');
  }
  if (fs.existsSync(destination)) throw new Error('Bundle destination already exists');
  const temporary = path.join(parent, `.metis-bundle-${randomUUID()}.tmp`);
  let published = false;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination);
    published = true;
    if (process.platform !== 'win32') {
      const directory = fs.openSync(parent, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } finally {
    if (!published && fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function readPersonalizationBundleFile(source: string): Uint8Array {
  const resolved = fs.realpathSync.native(path.resolve(source));
  const lstat = fs.lstatSync(resolved);
  if (!lstat.isFile() || lstat.isSymbolicLink() || lstat.size <= 0
    || lstat.size > PERSONALIZATION_BUNDLE_LIMITS.encodedBytes) {
    throw new Error('Unsafe personalization bundle');
  }
  const fd = fs.openSync(resolved, 'r');
  try {
    const before = fs.fstatSync(fd);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
      throw new Error('Personalization bundle changed while being read');
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}

function nextTerminalId(): string {
  return `ts_${randomBytes(32).toString('base64url')}`;
}

function presentGoalPlan(goalId: string, workflow: WorkflowDefinition) {
  return decodeGoalPlanResponse({
    success: true,
    goalId,
    label: GOAL_PLAN_LABEL,
    steps: workflow.steps.map((step, index) => ({
      stepId: step.id,
      label: GOAL_PLAN_STEP_LABEL,
      ordinal: index + 1,
    })),
  });
}

function presentGoalSummary(
  goal: { id: string; description?: unknown; status: unknown; createdAt: number; projectId?: string },
  checkpoint?: { resumable: boolean; completedSteps: number; totalSteps: number },
) {
  // UX-GOAL-001: 看板/列表展示持久化的 goal.description，而不是统一占位
  // 标题。空值或损坏记录才回退到固定兜底文案。
  const rawDescription = typeof goal.description === 'string' ? goal.description.trim() : '';
  const label = rawDescription
    ? rawDescription.slice(0, GOAL_RUNTIME_LIMITS.labelChars)
    : 'Research goal';
  return {
    goalId: goal.id,
    label,
    status: goal.status,
    createdAt: goal.createdAt,
    ...(goal.projectId ? { projectId: goal.projectId } : {}),
    // O14: 附带 checkpoint 摘要，渲染端据此显示「从上次断点继续」。
    ...(checkpoint ? { checkpoint } : {}),
  };
}

/** O14: 读取 goal 的 checkpoint 摘要；无持久化 run 时返回 undefined。 */
function goalCheckpointSummary(goalId: string): { resumable: boolean; completedSteps: number; totalSteps: number } | undefined {
  if (!goalEngine) return undefined;
  const info = goalEngine.getCheckpointInfo(goalId);
  if (!info.hasCheckpoint) return undefined;
  return { resumable: info.resumable, completedSteps: info.completedSteps, totalSteps: info.totalSteps };
}

// ─── O17: 工作流可视化 presenter ──────────────────────────────

/** 契约文本上限，与 GoalRuntimeContract 的 WORKFLOW_VIEW_TEXT_LIMIT 对齐。 */
const WORKFLOW_VIEW_TEXT_LIMIT = 20_000;
// eslint-disable-next-line no-control-regex
const WORKFLOW_VIEW_UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

/** 契约化清洗：去控制字符（保留换行/回车）并截断到上限。 */
function workflowViewText(value: unknown, limit = WORKFLOW_VIEW_TEXT_LIMIT): string {
  if (typeof value !== 'string') return '';
  return value.replace(WORKFLOW_VIEW_UNSAFE, ' ').slice(0, limit);
}

function workflowViewId(value: unknown): string {
  return workflowViewText(value, 200).replace(/\s+/gu, ' ').trim();
}

/** 验收标准 → 人类可读摘要串（kind + 值/描述）。 */
function presentAcceptanceCriteria(criteria: readonly import('../engine/workflow/AcceptanceCriteria.js').AcceptanceCriterion[] | undefined): string[] | undefined {
  if (!criteria || criteria.length === 0) return undefined;
  return criteria.map((criterion) => {
    const note = criterion.description?.trim();
    const base = note ? `${note}` : criterion.kind;
    return workflowViewText(`${base} (${criterion.kind}: ${criterion.value})`, 500);
  });
}

/**
 * O17: 把 GoalEngine 的只读视图映射为契约形状。所有自由文本都在这里
 * 截断清洗，保证渲染端拿到的内容可直接安全渲染。
 */
function presentGoalWorkflow(
  goalId: string,
  view: { workflow: WorkflowDefinition; run: WorkflowRun | undefined },
) {
  const { workflow, run } = view;
  const stepIds = new Set(workflow.steps.map((step) => step.id));
  const dependencies: Record<string, string[]> = {};
  for (const [stepId, deps] of Object.entries(workflow.dependencies)) {
    if (!stepIds.has(stepId)) continue;
    dependencies[stepId] = deps.filter((dep) => stepIds.has(dep));
  }
  const KNOWN_STEP_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'skipped']);
  const stepResults: Record<string, {
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    output: string;
    retryCount: number;
    failureReasons?: string[];
    decisionRequired?: boolean;
  }> = {};
  for (const [stepId, result] of Object.entries(run?.stepResults ?? {})) {
    if (!stepIds.has(stepId)) continue;
    stepResults[stepId] = {
      status: (KNOWN_STEP_STATUSES.has(result.status) ? result.status : 'pending') as 'pending' | 'running' | 'completed' | 'failed' | 'skipped',
      output: workflowViewText(result.output),
      retryCount: Number.isFinite(result.retryCount) ? Math.max(0, Math.floor(result.retryCount)) : 0,
      ...(result.failureReasons?.length ? { failureReasons: result.failureReasons.map((reason) => workflowViewText(reason, 500)) } : {}),
      ...(result.decisionRequired ? { decisionRequired: true } : {}),
    };
  }
  return {
    success: true as const,
    goalId,
    workflow: {
      id: workflowViewId(workflow.id) || 'workflow',
      name: workflowViewText(workflow.name, 500),
      description: workflowViewText(workflow.description, 2000),
      version: workflowViewId(workflow.version) || '1',
      steps: workflow.steps.map((step) => ({
        id: step.id,
        name: workflowViewText(step.name, 500),
        description: workflowViewText(step.description, 2000),
        prompt: workflowViewText(step.prompt),
        tools: step.tools.map((tool) => workflowViewId(tool)).filter(Boolean),
        maxTurns: Number.isFinite(step.maxTurns) ? Math.max(0, Math.floor(step.maxTurns)) : 0,
        ...(presentAcceptanceCriteria(step.acceptanceCriteria) ? { acceptanceCriteria: presentAcceptanceCriteria(step.acceptanceCriteria) } : {}),
      })),
      dependencies,
    },
    stepResults,
  };
}

/**
 * O13: 解析 goal 执行的 provider 绑定。goal 所属项目存在覆盖时，用覆盖
 * profile 的配置（含解密 key）构建临时 AgentLoop，使该项目真正以独立模型
 * 执行；任何一步不可用都回退全局运行时，绑定如实记录实际生效来源。
 */
function resolveGoalProjectRules(goal: { projectId?: string }): GoalExecutionOptions['projectRules'] | undefined {
  if (!goal.projectId || !researchRepository?.getProject(goal.projectId, false)) return undefined;
  try {
    const view = new WorkspaceAgentsManager(DATA_DIR, goal.projectId).read();
    if (!view.exists || !view.content || view.externalConflict || view.version < 1 || !view.contentHash) return undefined;
    return {
      projectId: goal.projectId,
      version: view.version,
      contentHash: view.contentHash,
      markdown: view.content,
    };
  } catch (error) {
    console.warn('[Main] Goal project Metis.md unavailable; executing without a project-rules snapshot', {
      projectId: goal.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function resolveGlobalProviderRuntimeRef(): {
  global: { profileId: string | null; model: string; available: boolean };
  profiles: Array<{ id: string; model: string; available: boolean }>;
} {
  const listed = providerProfileStore?.list();
  const profiles = listed?.ok
    ? listed.value.profiles.map((profile) => ({ id: profile.id, model: profile.model, available: profile.apiKeyStored === true }))
    : [];
  const active = listed?.ok ? listed.value.profiles.find((profile) => profile.isActive) : undefined;
  const model = active?.model ?? currentConfig?.model ?? '';
  const profileId = active?.id ?? null;
  return {
    global: { profileId, model, available: Boolean(provider && model.trim()) },
    profiles,
  };
}

function resolveProjectOutcomeProvider(
  projectId: string,
): { status: 'ready'; binding: ProviderProfileBinding; agentLoop: AgentLoop } | { status: 'pending'; reason: string } {
  const runtime = resolveGlobalProviderRuntimeRef();
  const overrideState = researchRepository?.getProjectProviderOverrideState(projectId) ?? { status: 'invalid' as const };
  const resolution = resolveProviderProfileRuntimeState({
    ...runtime,
    projectOverride: overrideState,
  });
  if (resolution.status !== 'ready') return { status: 'pending', reason: resolution.reason };

  const binding = resolution.binding;
  const config = binding.profileId && providerProfileStore
    ? providerProfileStore.configFor(binding.profileId)
    : currentConfig ? { ok: true as const, value: currentConfig } : { ok: false as const };
  if (!config.ok || !config.value.apiKey) return { status: 'pending', reason: 'project_runtime_unavailable' };
  try {
    const providerForProject = createProvider({ ...config.value, model: binding.model });
    const loop = createAgentLoop(providerForProject, buildRuntimeRegistry(), approvalStore ?? undefined, [], { ...config.value, model: binding.model });
    return { status: 'ready', binding, agentLoop: loop.agentLoop };
  } catch {
    return { status: 'pending', reason: 'project_runtime_unavailable' };
  }
}

function resolveGoalExecutionOptions(goal: { projectId?: string }): GoalExecutionOptions {
  const runtime = resolveGlobalProviderRuntimeRef();
  const projectOverride = goal.projectId && researchRepository
    ? researchRepository.getProjectProviderOverrideState(goal.projectId)
    : { status: 'absent' as const };
  const resolution = resolveProviderProfileRuntimeState({ ...runtime, projectOverride });
  if (resolution.status !== 'ready') throw new Error(`project_provider_${resolution.reason}`);

  const projectRules = resolveGoalProjectRules(goal);
  const withProjectRules = (options: GoalExecutionOptions): GoalExecutionOptions => (
    projectRules ? { ...options, projectRules } : options
  );
  if (resolution.binding.source === 'global') {
    return withProjectRules({ providerBinding: resolution.binding });
  }

  const binding = resolution.binding;
  const config = binding.profileId && providerProfileStore
    ? providerProfileStore.configFor(binding.profileId)
    : currentConfig ? { ok: true as const, value: currentConfig } : { ok: false as const };
  if (!config.ok || !config.value.apiKey) throw new Error('project_provider_runtime_unavailable');
  const overrideConfig = { ...config.value, model: binding.model };
  try {
    const overrideProvider = createProvider(overrideConfig);
    const loop = createAgentLoop(overrideProvider, buildRuntimeRegistry(), approvalStore ?? undefined, [], overrideConfig);
    return withProjectRules({ providerBinding: binding, agentOverride: loop.agentLoop });
  } catch {
    throw new Error('project_provider_runtime_unavailable');
  }
}

/** Durable goal store bound to the shared sqlite PersistenceStore. */
function currentGoalPersistence(): GoalPersistence | undefined {
  if (store && !goalPersistence) {
    goalPersistence = createGoalPersistence(store);
  }
  return goalPersistence ?? undefined;
}

/**
 * Broadcast a goal state change to the renderer (chat cards and the kanban
 * board both refresh from this). Payload is contract-validated before send;
 * an invalid payload is dropped rather than risking a mis-shaped event.
 */
function broadcastGoalChanged(_sender: Electron.WebContents, goal: Goal, statusOverride?: Goal['status'] | 'cancelled') {
  try {
    const event = decodeGoalChangedEvent({
      goalId: goal.id,
      label: goal.description,
      status: statusOverride ?? goal.status,
      priority: goal.priority,
      createdAt: goal.createdAt,
      ...(goal.projectId ? { projectId: goal.projectId } : {}),
    });
    if (!event) return;
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('goal:changed', event);
      }
    }
  } catch {
    // Broadcast must never break the caller.
  }
}

// ─── Autonomous research helpers ──────────────────────────────

/**
 * Map an internal ResearchEvent (producer shape) to a live-event payload that
 * satisfies AutonomousLiveEventSchema (renderer-consumable). Adds the contract
 * version + monotonic sequence the renderer expects.
 */
function toLivePayload(
  evt: import('../engine/research/ResearchEventBus.js').ResearchEvent,
  sessionId: string,
  sequence: number,
): unknown {
  const base = { version: AUTONOMOUS_CONTRACT_VERSION, sessionId, sequence };
  switch (evt.type) {
    case 'engine-started':
      return { ...base, type: 'engine-started', goal: evt.goal, plan: evt.plan, method: evt.method };
    case 'phase-started':
      return { ...base, type: 'phase-started', phase: evt.phase, phaseIteration: evt.phaseIteration, phaseName: evt.phaseName };
    case 'step-start':
    case 'step-complete':
    case 'step-failed':
      return { ...base, type: evt.type, phase: evt.phase, stepId: evt.stepId, stepName: evt.stepName, output: evt.output, error: evt.error };
    case 'reflection':
      return {
        ...base, type: 'reflection', phase: evt.phase, decision: evt.decision,
        nextPhase: evt.nextPhase, qualityScore: evt.qualityScore, reasoning: evt.reasoning, revisionNote: evt.revisionNote,
      };
    case 'progress':
      return { ...base, type: 'progress', completedPhases: evt.completedPhases, totalPhases: evt.totalPhases, currentPhase: evt.currentPhase };
    case 'engine-completed':
      return { ...base, type: 'engine-completed', summary: evt.summary, artifactIds: evt.artifactIds };
    case 'engine-failed':
      return { ...base, type: 'engine-failed', reason: evt.reason, completedPhases: evt.completedPhases, recoverable: evt.recoverable };
    case 'engine-interrupted':
      return { ...base, type: 'engine-interrupted', reason: evt.reason };
    case 'engine-paused':
      return { ...base, type: 'engine-paused', reason: evt.reason };
    case 'engine-resumed':
      return { ...base, type: 'engine-resumed', completedPhases: evt.completedPhases };
    default:
      return null;
  }
}

function channelForEvent(evt: import('../engine/research/ResearchEventBus.js').ResearchEvent): string | null {
  const C = AUTONOMOUS_CHANNELS.live;
  switch (evt.type) {
    case 'engine-started': return C.engineStarted;
    case 'phase-started': return C.phaseStarted;
    case 'step-start': return C.stepStart;
    case 'step-complete': return C.stepComplete;
    case 'step-failed': return C.stepFailed;
    case 'reflection': return C.reflection;
    case 'progress': return C.progress;
    case 'engine-completed': return C.engineCompleted;
    case 'engine-failed': return C.engineFailed;
    case 'engine-interrupted': return C.engineInterrupted;
    case 'engine-paused': return C.enginePaused;
    case 'engine-resumed': return C.engineResumed;
    default: return null;
  }
}

/**
 * Subscribe the LearningEngine to the research event bus so autonomous output
 * feeds back into memory (the "hook extends learning scenarios" goal). This is
 * the closed loop: research produces knowledge → learning persists it → future
 * research/prompts benefit from it.
 */
function subscribeLearningToResearchBus(
  bus: ResearchEventBus,
  learning: import('../engine/learning/LearningEngine.js').LearningEngine | null,
): void {
  if (!learning) return;
  bus.subscribe((evt) => {
    try {
      if (evt.type === 'step-complete' && evt.output && evt.output.length > 40) {
        // Treat substantial step outputs as experience worth remembering.
        learning.rememberAutonomousOutput?.(evt.phase, evt.stepName, evt.output);
      }
      if (evt.type === 'reflection' && evt.decision === 'advance') {
        learning.rememberAutonomousDecision?.(evt.phase, evt.reasoning);
      }
    } catch { /* learning must never break the research bus */ }
  });
}

function presentPaper(
  paper: ReturnType<PersistenceStore['getPapers']>[number],
  owner: ExecutionOwnerIdentity,
): Omit<ReturnType<PersistenceStore['getPapers']>[number], 'pdfPath'> & {
  pdfCapability?: import('../engine/runtime/FileCapabilityContract.js').FileCapabilityDescriptor;
} {
  const { pdfPath, ...safePaper } = paper;
  // The renderer contract has no null projectId — drop unlinked papers' id.
  const summary = safePaper.projectId === null
    ? { ...safePaper, projectId: undefined }
    : safePaper;
  if (!pdfPath) return summary;
  const issued = fileCapabilities.issue({
    path: pdfPath,
    kind: 'file',
    mime: 'application/pdf',
    displayName: path.basename(pdfPath),
    operations: ['file', 'read', 'extract'],
  }, owner);
  return issued.success
    ? { ...summary, pdfCapability: issued.capability }
    : summary;
}

/**
 * Link a canonical library paper to a project-local research source. The
 * repository owns the many-to-many relation and keeps each project's evidence
 * chain isolated while the paper remains globally reusable.
 */
function linkPaperToProjectSource(
  paper: { id: string; title: string; authors: string[]; year: number; venue: string; doi?: string; arxivId?: string },
  projectId: string,
): boolean {
  if (!store || !researchRepository) return false;
  return researchRepository.linkLibraryPaperToProject({
    paperId: paper.id,
    projectId,
    title: paper.title,
    authors: paper.authors,
    year: paper.year,
    venue: paper.venue,
    ...(paper.doi ? { doi: paper.doi } : {}),
    ...(paper.arxivId ? { arxivId: paper.arxivId } : {}),
  }) !== undefined;
}

// 文献入库桥（2026-08-30 刘总问题 B 修复）：场景产物里的 JSON 题录过真实性闸后
// 写入 papers 并三写 sources+paper_project_links。懒加载单例——store 与
// researchRepository 初始化完成前返回 undefined，工作流侧自动跳过。
let scenarioLiteratureBridge: ScenarioLiteratureBridge | null = null;
function getScenarioLiteratureBridge(): ScenarioLiteratureBridge | undefined {
  if (!store || !researchRepository) return undefined;
  if (!scenarioLiteratureBridge) {
    scenarioLiteratureBridge = createScenarioLiteratureBridge({ store, researchRepository });
  }
  return scenarioLiteratureBridge;
}

async function isPdfFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile() || stat.size < 5) return false;
    const handle = await fs.promises.open(filePath, 'r');
    try {      const header = Buffer.alloc(5);
      await handle.read(header, 0, header.length, 0);
      return header.toString('ascii') === '%PDF-';
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function waitForNativeWindowResize(
  window: BrowserWindow,
  applySize: () => void,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      window.off('resize', onResize);
      setImmediate(resolve);
    };
    const onResize = () => finish();
    const deadline = setTimeout(finish, 2_000);
    window.once('resize', onResize);
    applySize();
  });
}

async function getAcceptanceRendererSize(
  window: BrowserWindow,
): Promise<{ width: number; height: number }> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve) => requestAnimationFrame(() =>
      requestAnimationFrame(() => resolve({
        width: window.innerWidth,
        height: window.innerHeight,
      }))
    ))
  `);
}

async function setAcceptanceContentSize(
  window: BrowserWindow,
  width: number,
  height: number,
): Promise<void> {
  let applied = { width, height };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await waitForNativeWindowResize(window, () => {
      window.setContentSize(applied.width, applied.height, false);
    });

    const measuredContent = window.getContentBounds();
    const measuredRenderer = await getAcceptanceRendererSize(window);
    const next = nextLayoutAcceptanceContentSize(
      { width, height },
      applied,
      measuredContent,
      measuredRenderer,
    );
    if (!next) return;
    applied = next;
  }

  const measuredContent = window.getContentBounds();
  const measuredRenderer = await getAcceptanceRendererSize(window);
  const display = screen.getDisplayMatching(window.getBounds());
  throw new Error(
    'Native content size did not converge: ' +
    `requested=${width}x${height}, ` +
    `content=${measuredContent.width}x${measuredContent.height}, ` +
    `renderer=${measuredRenderer.width}x${measuredRenderer.height}, ` +
    `outer=${window.getBounds().width}x${window.getBounds().height}, ` +
    `minWidth=${window.getMinimumSize()[0]}, ` +
    `scaleFactor=${display?.scaleFactor ?? 'unknown'}, ` +
    `zoomFactor=${window.webContents.getZoomFactor?.() ?? 'unknown'}`,
  );
}

// ─── Provider & Agent Creation ────────────────────────────────

function createProvider(config: ProviderConfig): OpenAICompatProvider {
  return new OpenAICompatProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    timeout: config.timeout,
    maxRetries: config.maxRetries,
    retryBackoffSeconds: config.retryBackoffSeconds,
    ...(config.vision ? { vision: true } : {}),
  });
}

function createAgentLoop(
  prov: OpenAICompatProvider,
  registry?: ToolRegistry,
  sharedApprovalStore?: ApprovalStore,
  additionalRegistrations: readonly PersonalizationMcpToolRegistration[] = [],
  config: ProviderConfig = currentConfig ?? {
    baseUrl: '',
    apiKey: '',
    model: '',
    timeout: 30_000,
    maxRetries: 2,
    retryBackoffSeconds: 1,
  },
): { agentLoop: AgentLoop; approvalStore: ApprovalStore } {
  const toolRegistry = registry ?? new ToolRegistry();
  const hooks = new HookBus();
  const dispatcher = new ToolDispatcher(toolRegistry, hooks);
  registerBuiltinTools(toolRegistry, dispatcher, {
    store: store ?? undefined,
    researchRepository: researchRepository ?? undefined,
  });
  fundingTemplateTools?.register(toolRegistry, dispatcher);
  // 投稿工作区共享浏览器工具（2026-09-01 刘总规格）：agent 操作的就是用户中栏
  // 看到的同一个 WebContentsView，不另开隐藏会话。
  try {
    const submissionBrowser = createSubmissionBrowserTools({
      navigate: async (url) => {
        const service = ensureBrowserService();
        if (!service) return { ok: false, error: 'browser_unavailable' };
        return service.navigate(url);
      },
      extract: async () => {
        const service = ensureBrowserService();
        if (!service) return { ok: false, error: 'browser_unavailable' };
        return service.extract();
      },
    });
    for (const spec of submissionBrowser.specs) {
      toolRegistry.register(spec);
      dispatcher.registerHandler(spec.name, submissionBrowser.handlers.find(([name]) => name === spec.name)![1]);
    }
  } catch (browserToolError) {
    console.warn('[Main] submission browser tools unavailable:', browserToolError instanceof Error ? browserToolError.message : browserToolError);
  }
  // NCPSSD 中文文献检索工具（2026-09-01 刘总指出中文源缺位）：场景检索步骤与
  // 投稿参谋可查国家哲学社会科学文献中心，默认限核心期刊。
  try {
    toolRegistry.register({
      name: 'ncpssd_search',
      description: '检索国家哲学社会科学文献中心（NCPSSD）的中文期刊论文，默认仅限核心期刊。返回题录（标题/作者/期刊/年份/摘要/链接）。中文人文社科文献优先使用本工具。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '中文检索词（主题/篇名关键词）' },
          limit: { type: 'number', description: '返回条数（5-25，默认 10）' },
          coreOnly: { type: 'boolean', description: '仅限核心期刊（默认 true）' },
        },
        required: ['query'],
      },
    });
    dispatcher.registerHandler('ncpssd_search', async (args) => {
      const query = String(args.query ?? '').trim();
      if (!query) return 'Error: query is required.';
      const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.max(5, Math.min(25, Math.floor(args.limit))) : 10;
      const coreOnly = args.coreOnly !== false;
      const result = await literatureSearchService.search({ query, sources: ['ncpssd'], pageSize: limit, coreOnly });
      if (!result.ok) return JSON.stringify({ ok: false, code: result.code, note: 'NCPSSD 检索失败；如实告知用户并尝试其他来源。' }, null, 2);
      const papers = result.results.map((paper) => ({
        title: paper.title, authors: paper.authors, year: paper.year, venue: paper.venue,
        abstract: (paper.abstract ?? '').slice(0, 300), url: paper.url, source: paper.source,
      }));
      return JSON.stringify({ query, coreOnly, total: papers.length, papers }, null, 2);
    });
  } catch (ncpssdToolError) {
    console.warn('[Main] ncpssd search tool unavailable:', ncpssdToolError instanceof Error ? ncpssdToolError.message : ncpssdToolError);
  }
  for (const registration of additionalRegistrations) {
    toolRegistry.register(registration.spec);
    dispatcher.registerHandler(registration.spec.name, registration.handler);
  }
  const evidenceLedger = new EvidenceLedger();
  const approvalStore = sharedApprovalStore ?? new ApprovalStore();
  const behaviorRegistry = new BehaviorRegistry();

  const caps = prov.capabilities();

  // Context compression: user-declared maxContextTokens overrides auto-detect;
  // 70% threshold triggers compression; LLM summarizer activates for old messages.
  const userMaxContext = config.maxContextTokens ?? 0;
  const effectiveMaxContext = userMaxContext > 0 ? userMaxContext : (caps.maxContextTokens > 0 ? caps.maxContextTokens : 32_000);

  const contextEngine = new ContextEngine({
    budget: {
      modelContextTokens: effectiveMaxContext,
      modelOutputTokens: caps.maxOutputTokens,
      contextThreshold: 0.7, // 70% — compress when context fills to 70%
      perToolChars: 2000,
      maxToolResultChars: 8000,
      maxTurns: 12,
    },
    overrideMaxContextTokens: effectiveMaxContext,
    summarizer: async (msgs) => {
      // Use the provider itself to summarize old messages.
      const systemPrompt = 'Summarize the following conversation history concisely, preserving key decisions, context, and any important data. Output only the summary, no preamble.';
      const response = await prov.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: msgs.map((m) => `${m.role}: ${m.content}`).join('\n').slice(0, 12000) },
      ], undefined, { temperature: 0.2, thinking: true });
      const summary = response.content.trim();
      if (!summary) throw new Error('Provider returned an empty context summary');
      return `[对话摘要]\n${summary}`;
    },
  });

  const agentLoop = new AgentLoop({
    provider: prov,
    registry: toolRegistry,
    dispatcher,
    hooks,
    contextEngine,
    evidenceLedger,
    approvalStore,
    behaviorRegistry,
    // Learning (C): record every tool outcome for reliability statistics.
    onToolResult: (outcome) => learningEngine?.recordToolOutcome(outcome),
  });

  // Register the multi-agent orchestration tool now that the AgentLoop exists.
  // It needs the loop to run specialist agents internally.
  toolRegistry.register(MULTI_AGENT_TOOL);
  dispatcher.registerHandler(MULTI_AGENT_TOOL.name, createMultiAgentHandler({ agentLoop }));

  // Scenario incremental-patch tool (2026-08-22): one shared, sessionId-scoped
  // router so every loop rebuild keeps the compiler's agentic authoring path.
  toolRegistry.register(scenarioPatchRouterSingleton.spec);
  dispatcher.registerHandler(scenarioPatchRouterSingleton.spec.name, scenarioPatchRouterSingleton.handler);
  // 设计轮大纲工具（2026-08-24 刘总方案 C）：工作流/章节大纲。
  toolRegistry.register(scenarioPatchRouterSingleton.planWorkflowSpec);
  dispatcher.registerHandler(scenarioPatchRouterSingleton.planWorkflowSpec.name, scenarioPatchRouterSingleton.planWorkflowHandler);
  toolRegistry.register(scenarioPatchRouterSingleton.planSectionsSpec);
  dispatcher.registerHandler(scenarioPatchRouterSingleton.planSectionsSpec.name, scenarioPatchRouterSingleton.planSectionsHandler);

  // 场景能力获取工具（2026-08-23 刘总要求）：编译循环内只读市场搜索 + 全自动安装。
  toolRegistry.register(scenarioMarketSearchRouterSingleton.spec);
  dispatcher.registerHandler(scenarioMarketSearchRouterSingleton.spec.name, scenarioMarketSearchRouterSingleton.handler);
  toolRegistry.register(scenarioInstallRouterSingleton.spec);
  dispatcher.registerHandler(scenarioInstallRouterSingleton.spec.name, scenarioInstallRouterSingleton.handler);

  return { agentLoop, approvalStore };
}

/** 任务7 能力系统(2026-09-05):Scenario Builder 专属工具——普通 Agent 不可见。 */
const COMPILER_ONLY_TOOL_NAMES = new Set([
  SCENARIO_MARKET_SEARCH_TOOL_NAME,
  SCENARIO_INSTALL_EXTENSION_TOOL_NAME,
  SCENARIO_PLAN_WORKFLOW_TOOL_NAME,
  SCENARIO_PLAN_SECTIONS_TOOL_NAME,
]);

function chatToolsExcludingCompilerTools(allNames: readonly string[]): string[] {
  return allNames.filter((name) => !COMPILER_ONLY_TOOL_NAMES.has(name));
}

function buildRuntimeRegistry(): ToolRegistry {
  return new ToolRegistry();
}

function builtinToolNames(): string[] {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry, new ToolDispatcher(registry));
  const names = registry.list().map((tool) => tool.name);
  return fundingTemplateTools
    ? [...names, ...fundingTemplateTools.getSpecs().map((tool) => tool.name)]
    : names;
}

// ─── Custom skill persistence (generated from conversations) ──

/** Persisted shape of a user-generated skill. */
interface PersistedCustomSkill {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  maxTurns: number;
  rationale: string;
  createdAt: number;
}

/** Register an extracted skill into the live SkillRegistry + persist it. */
function installSkill(extracted: ExtractedSkill): void {
  if (!skillRegistry) return;
  // Unregister first so re-generating updates in place (register throws on dup id).
  if (skillRegistry.has(extracted.id)) skillRegistry.unregister(extracted.id);
  skillRegistry.register({
    id: extracted.id,
    name: extracted.name,
    description: extracted.description,
    category: 'custom',
    systemPrompt: extracted.systemPrompt,
    allowedTools: extracted.allowedTools,
    maxTurns: extracted.maxTurns,
    tags: ['auto-generated'],
  });
  // Persist.
  if (store) {
    const custom = loadCustomSkills();
    const without = custom.filter((s) => s.id !== extracted.id);
    without.push({
      id: extracted.id,
      name: extracted.name,
      description: extracted.description,
      systemPrompt: extracted.systemPrompt,
      allowedTools: extracted.allowedTools,
      maxTurns: extracted.maxTurns,
      rationale: extracted.rationale,
      createdAt: Date.now(),
    });
    store.setMemory(CUSTOM_SKILLS_MEMORY_KEY, JSON.stringify(without), 'custom_skills');
  }
}

/** Load persisted custom skills (empty if none / store unavailable). */
function loadCustomSkills(): PersistedCustomSkill[] {
  if (!store) return [];
  try {
    const entry = store.getMemory(CUSTOM_SKILLS_MEMORY_KEY);
    if (!entry?.value) return [];
    const parsed = JSON.parse(entry.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** Reload all persisted custom skills into the live registry at startup. */
function loadAndInstallCustomSkills(): void {
  const custom = loadCustomSkills();
  for (const skill of custom) {
    if (!skillRegistry?.has(skill.id)) {
      skillRegistry?.register({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        category: 'custom',
        systemPrompt: skill.systemPrompt,
        allowedTools: skill.allowedTools,
        maxTurns: skill.maxTurns,
        tags: ['auto-generated'],
      });
    }
  }
}

/**
 * Exercise the same registration order used by createAgentLoop before a
 * funding-template built-in may be seeded. Merely constructing the service is
 * not proof that its tools can coexist in the real runtime registry.
 */
function auditFundingTemplateToolRegistration(
  service: FundingTemplateToolService,
): ReadonlySet<string> {
  const registry = new ToolRegistry();
  const dispatcher = new ToolDispatcher(registry);
  registerBuiltinTools(registry, dispatcher);
  service.register(registry, dispatcher);
  return new Set(registry.list().map((tool) => tool.name));
}

function providerProfileListFailure(
  operationId: string,
  result: { code: string },
) {
  return {
    ok: false as const,
    contractVersion: PROVIDER_PROFILE_CONTRACT_VERSION,
    operationId,
    code: result.code,
  };
}

function providerProfileMutationResponse(
  operationId: string,
  action: 'saved' | 'switched' | 'deleted' | 'reset',
  result: { ok: true; value: { revision: number; profile?: import('../engine/runtime/ProviderProfileContract.js').ProviderProfileSummary; activeId?: string | null } } | { ok: false; code: string; currentRevision?: number },
): ProviderProfileMutationResponse {
  if (!result.ok) {
    return {
      ok: false,
      contractVersion: PROVIDER_PROFILE_CONTRACT_VERSION,
      operationId,
      code: result.code as import('../engine/runtime/ProviderProfileContract.js').ProviderProfileErrorCode,
      ...(result.currentRevision === undefined ? {} : { currentRevision: result.currentRevision }),
    };
  }
  return {
    ok: true,
    contractVersion: PROVIDER_PROFILE_CONTRACT_VERSION,
    operationId,
    action,
    revision: result.value.revision,
    ...(result.value.profile === undefined ? {} : { profile: result.value.profile }),
    activeId: result.value.activeId ?? (result.value.profile?.isActive ? result.value.profile.id : null),
  };
}

function providerProfileRuntimeContext(
  config: ProviderConfig,
  reason: SetupRuntimeBuildContext['reason'],
): SetupRuntimeBuildContext {
  const maxContextTokens = config.maxContextTokens && config.maxContextTokens > 0
    ? config.maxContextTokens
    : 32_000;
  return {
    config,
    capabilities: {
      streaming: true,
      nativeToolCalling: false,
      structuredOutput: false,
      maxContextTokens: null,
      multimodal: config.vision === true,
    },
    strategy: {
      tier: 'standard',
      maxTurnsPerStep: 12,
      maxToolsPerTurn: 32,
      maxRetries: config.maxRetries,
      reviewEveryNTurns: 3,
      forceStructuredOutput: false,
      contextBudgetTokens: maxContextTokens,
      maxOutputTokens: 16_384,
      nativeToolCalling: false,
    },
    previousConfigVersion: runtimeGeneration,
    nextConfigVersion: runtimeGeneration + 1,
    reason,
    signal: new AbortController().signal,
  };
}

function deactivateProviderRuntime(reason: string): void {
  for (const [sessionId, run] of activeChatRuns) {
    run.executionEvents?.finish('cancelled');
    run.executionEvents?.dispose();
    run.controller.abort();
    liveSteeringQueue.clear(sessionId);
    activeChatRuns.delete(sessionId);
    activeFundingToolScopes.delete(sessionId);
  }
  if (activeAutonomousSessionId) autonomousEngine?.interrupt(activeAutonomousSessionId, reason);
  goalEngine?.cancelActiveGoals();
  activeAutonomousSessionId = null;
  provider = null;
  agentLoop = null;
  goalEngine = null;
  autonomousEngine = null;
  researchEventBus = null;
  currentConfig = null;
  runtimeGeneration += 1;
}

function prepareProviderRuntime(context: SetupRuntimeBuildContext): PreparedSetupRuntime {
  if (!store) throw new Error('Persistence is unavailable');
  const runtimeStore = store;
  const runtimeMemoryManager = memoryManager ?? new MemoryManager(runtimeStore, DATA_DIR);
  // WorkspaceAgentsManager now requires explicit projectId per request.
  const candidateConfig = { ...context.config } as ProviderConfig;
  const candidateProvider = createProvider(candidateConfig);
  const candidateLoop = createAgentLoop(
    candidateProvider,
    buildRuntimeRegistry(),
    approvalStore ?? undefined,
    [],
    candidateConfig,
  );
  const candidateGoalEngine = new GoalEngine(candidateLoop.agentLoop, runtimeMemoryManager, currentGoalPersistence());
  const candidateWorkflowEngine = new WorkflowEngine(candidateLoop.agentLoop);
  const candidateResearchEventBus = new ResearchEventBus();
  const candidateAutonomousEngine = new AutonomousResearchEngine({
    workflowEngine: candidateWorkflowEngine,
    planner: new AutonomousPlanner({ provider: candidateProvider }),
    eventBus: candidateResearchEventBus,
    liveSteering: liveSteeringQueue,
    store: runtimeStore,
    artifactSink: researchRepository
      ? createAutonomousResearchArtifactSink(researchRepository)
      : undefined,
  });
  let state: 'prepared' | 'committed' | 'discarded' = 'prepared';

  return {
    async commitAndAbortPrevious(): Promise<void> {
      if (state !== 'prepared' || context.signal.aborted) {
        throw new Error('Candidate runtime is unavailable');
      }
      // No old provider request may survive the configuration generation swap.
      for (const [sessionId, run] of activeChatRuns) {
        run.executionEvents?.finish('cancelled');
        run.executionEvents?.dispose();
        run.controller.abort();
        liveSteeringQueue.clear(sessionId);
        activeChatRuns.delete(sessionId);
        activeFundingToolScopes.delete(sessionId);
      }
      if (activeAutonomousSessionId) autonomousEngine?.interrupt(activeAutonomousSessionId, 'provider_reconfigured');
      goalEngine?.cancelActiveGoals();
      activeAutonomousSessionId = null;

      runtimeGeneration = context.nextConfigVersion;
      currentConfig = candidateConfig;
      provider = candidateProvider;
      agentLoop = candidateLoop.agentLoop;
      approvalStore = candidateLoop.approvalStore;
      bindHitlApprovalHandler(approvalStore);
      memoryManager = runtimeMemoryManager;
      goalEngine = candidateGoalEngine;
      researchEventBus = candidateResearchEventBus;
      autonomousEngine = candidateAutonomousEngine;
      learningEngine = new LearningEngine({ memory: runtimeMemoryManager, provider: candidateProvider, store: runtimeStore });
      subscribeLearningToResearchBus(candidateResearchEventBus, learningEngine);
      state = 'committed';
    },
    async discard(): Promise<void> {
      if (state === 'prepared') state = 'discarded';
    },
  };
}

// ─── Config Persistence ───────────────────────────────────────

function loadConfig(): ProviderConfig | null {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      console.log('[Main] loadConfig: Config file not found at', CONFIG_PATH);
      return null;
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const encrypted = JSON.parse(raw);

    // Detect InMemorySecureStorage format: base64 decodes to "metis:v1:key_N_TS"
    // This happens when config was saved while safeStorage was unavailable.
    // In that case, we cannot recover the original API key from the in-memory reference.
    if (encrypted.encryptedApiKey && typeof encrypted.encryptedApiKey === 'string') {
      try {
        const decoded = Buffer.from(encrypted.encryptedApiKey, 'base64').toString('utf-8');
        if (decoded.startsWith('metis:v1:key_')) {
          console.warn('[Main] loadConfig: Config was saved with InMemorySecureStorage (safeStorage was unavailable).');
          console.warn('[Main] loadConfig: The API key cannot be recovered. User must re-enter it in Settings.');
          console.warn('[Main] loadConfig: Returning config with empty apiKey so user sees their baseUrl/model.');
          const legacyTimeout = encrypted.timeout ?? 30000;
          return {
            baseUrl: encrypted.baseUrl ?? '',
            apiKey: '',
            model: encrypted.model ?? '',
            timeout: legacyTimeout > 0 && legacyTimeout < 1000 ? legacyTimeout * 1000 : legacyTimeout,
            maxRetries: encrypted.maxRetries ?? 2,
            retryBackoffSeconds: encrypted.retryBackoffSeconds ?? 1,
          };
        }
      } catch {
        // Not base64 decodable — proceed with normal decryption
      }
    }

    const config = decryptProviderConfig(encrypted);
    // 单位自愈：遗留配置可能以「秒」写 timeout（<1000 的值不可能是合理毫秒数）。
    if (config.timeout > 0 && config.timeout < 1000) {
      console.warn('[Main] loadConfig: timeout looks like seconds (' + config.timeout + '); normalizing to milliseconds.');
      config.timeout = config.timeout * 1000;
    }
    console.log('[Main] loadConfig: Successfully loaded config — baseUrl:', config.baseUrl, 'model:', config.model);
    return config;
  } catch (err) {
    console.error('[Main] loadConfig: Failed to load config:', (err as Error)?.message);
    return null;
  }
}

const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

interface PersistedSettings { theme: string; accent: string; providerVision: boolean; providerMaxContextTokens: number; setupSkipped: boolean; }

const ACCENT_THEMES = new Set(['gold', 'blue', 'green', 'gray']);
const CUSTOM_ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

/** Preset id or custom #RRGGBB hex. Anything else falls back to blue. */
function normalizeAccent(raw: unknown): string {
  if (typeof raw === 'string' && (ACCENT_THEMES.has(raw) || CUSTOM_ACCENT_RE.test(raw))) return raw;
  return 'blue';
}

function loadPersistedSettings(): PersistedSettings {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      return {
        theme: raw.theme || 'light',
        accent: normalizeAccent(raw.accent),
        providerVision: raw.providerVision === true,
        providerMaxContextTokens: Number(raw.providerMaxContextTokens) > 0 ? Number(raw.providerMaxContextTokens) : 0,
        setupSkipped: raw.setupSkipped === true,
      };
    }
  } catch { /* ignore */ }
  // Backward compat: read old theme.txt
  try {
    if (fs.existsSync(THEME_PATH)) {
      return { theme: fs.readFileSync(THEME_PATH, 'utf-8').trim() || 'light', accent: 'blue', providerVision: false, providerMaxContextTokens: 0, setupSkipped: false };
    }
  } catch { /* ignore */ }
  return { theme: 'light', accent: 'blue', providerVision: false, providerMaxContextTokens: 0, setupSkipped: false };
}

function loadTheme(): string { return loadPersistedSettings().theme; }
function loadAccent(): string { return loadPersistedSettings().accent; }
function loadProviderVision(): boolean { return loadPersistedSettings().providerVision; }
function loadProviderMaxContextTokens(): number { return loadPersistedSettings().providerMaxContextTokens; }
function loadSetupSkipped(): boolean { return loadPersistedSettings().setupSkipped; }

function saveSettings(theme: string, accent: string, providerVision: boolean, providerMaxContextTokens: number): boolean {
  try {
    // Merge so unrelated persisted keys (setupSkipped) survive a theme update.
    const merged = { ...loadPersistedSettings(), theme, accent, providerVision, providerMaxContextTokens };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged), 'utf-8');
    return true;
  } catch (err) {
    console.warn('Failed to save settings:', err);
    return false;
  }
}

/** Persist the user's explicit 「稍后配置」 choice so the first-run wizard does
 *  not reappear on every launch. Research execution stays provider-gated. */
function saveSetupSkipped(): boolean {
  try {
    const merged = { ...loadPersistedSettings(), setupSkipped: true };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged), 'utf-8');
    return true;
  } catch (err) {
    console.warn('Failed to persist setup-skip flag:', err);
    return false;
  }
}

function initProviderAndAgent(): void {
  const config = loadConfig();
  if (!config) {
    console.log('[Main] initProviderAndAgent: No saved config found.');
    return;
  }
  if (!config.apiKey) {
    console.warn('[Main] initProviderAndAgent: Config loaded but apiKey is empty — user must re-enter API key in Settings.');
    currentConfig = config;
    currentTheme = loadTheme();
    return;
  }
  currentConfig = config;
  // METIS-WX-2: multimodal support is a user-declared setting merged at init.
  currentConfig.vision = loadProviderVision();
  // User-declared context window (0 = auto-detect from model capabilities).
  currentConfig.maxContextTokens = loadProviderMaxContextTokens();
  provider = createProvider(config);
  currentTheme = loadTheme();
  console.log('[Main] initProviderAndAgent: Config loaded — baseUrl:', config.baseUrl, 'model:', config.model, 'store:', !!store);
  if (store) {
    memoryManager = new MemoryManager(store, DATA_DIR);
    // Autonomous learning (A memory / B prompt adaptation / C tool usage):
    // created alongside memory so tool outcomes can be tracked and persisted.
    learningEngine = new LearningEngine({ memory: memoryManager, provider, store });
    // Initialize MCP manager. Stored executables are never auto-started;
    // activation requires a separately consented execution capability.
    mcpManager = new MCPManager(store, new ToolRegistry());
    // Create agent loop with MCP-registered tools
    const registry = new ToolRegistry();
    if (mcpManager) {
      const mcpTools = mcpManager.getAllTools();
      for (const tool of mcpTools) {
        registry.register({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        });
      }
    }
    const loopResult = createAgentLoop(provider, registry, approvalStore ?? undefined);
    agentLoop = loopResult.agentLoop;
    approvalStore = loopResult.approvalStore;
    bindHitlApprovalHandler(approvalStore);
    console.log('[Main] initProviderAndAgent: agentLoop created:', !!agentLoop);
    if (agentLoop) {
      goalEngine = new GoalEngine(agentLoop, memoryManager, currentGoalPersistence());
      // Autonomous research engine: composes a dedicated WorkflowEngine (bound
      // to this agentLoop) + reflective planner + event bus. Live steering
      // reuses the global queue so pause/interrupt share the control channel.
      const autonomousWorkflowEngine = new WorkflowEngine(agentLoop);
      researchEventBus = new ResearchEventBus();
      const planner = new AutonomousPlanner({ provider });
      autonomousEngine = new AutonomousResearchEngine({
        workflowEngine: autonomousWorkflowEngine,
        planner,
        eventBus: researchEventBus,
        liveSteering: liveSteeringQueue,
        store: store ?? undefined,
        artifactSink: researchRepository
          ? createAutonomousResearchArtifactSink(researchRepository)
          : undefined,
      });
      // Hook closure: learning ingests durable knowledge from autonomous output.
      subscribeLearningToResearchBus(researchEventBus, learningEngine);
    }
  } else {
    console.warn('[Main] initProviderAndAgent: store is null, skipping agentLoop creation');
  }
}

// ─── Window Creation ──────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    // Automated product simulations run against the real renderer and IPC
    // stack but must not steal focus from the researcher's desktop. This flag
    // is intentionally process-local and is never enabled by normal launches.
    show: process.env.METIS_BACKGROUND_AUDIT !== '1',
    // The acceptance run needs to exercise the real narrow-shell bands, so it
    // may shrink the window below the product minimum of 1000px.
    minWidth: layoutAcceptanceToken ? 320 : 1000,
    minHeight: 700,
    title: 'Metis Research Workbench',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // needed for better-sqlite3
    },
    titleBarStyle: 'hiddenInset', // macOS unified title bar
  });

  // Renderer content never receives ambient navigation authority. Clean HTTPS
  // links may leave the app only through the validated IPC handler below.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  const fileCapabilityWebContentsId = mainWindow.webContents.id;
  const mainWcId = mainWindow.webContents.id;
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return; // Only main-frame navigation (not subframe) invalidates
    bumpWebContentsGeneration(mainWcId);
    firstRunSetup?.revokeWebContents(mainWcId);
    caRuntime?.clearOwner(String(mainWcId));
    caOwnerWindows.delete(String(mainWcId));
    cleanupActiveChatRuns(mainWcId);
  });
  mainWindow.webContents.on('render-process-gone', () => {
    cleanupWebContentsOwner(mainWcId);
  });
  mainWindow.webContents.once('destroyed', () => {
    fileCapabilities.clearWebContents(fileCapabilityWebContentsId);
    cleanupWebContentsOwner(mainWcId);
  });

  // Always clear the renderer cache before loading to ensure the latest
  // dist files are used after rebuilds (Electron caches file:// URLs).
  mainWindow.webContents.session.clearCache().catch(() => {});

  // In dev, load from Vite dev server; in prod, serve dist/ over metis-app://
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadURL('metis-app://renderer/index.html');
  }

  mainWindow.on('closed', () => {
    fileCapabilities.clear();
    exportPreviews.clear();
    for (const session of activeTerminals.values()) {
      session.killed = true;
      session.terminal.kill();
    }
    activeTerminals.clear();
    executionCapabilities?.clear();
    mainWindow = null;
  });
}

// ─── LaTeX Compilation Helpers ─────────────────────────────────


const execAsync = promisify(exec);

/** Compile LaTeX source using local pdflatex. */
async function compileLatexLocal(source: string, bib?: string): Promise<{
  status: string; pdfPath?: string; errors?: Array<{ line: number; message: string; severity: 'error' | 'warning' }>; error?: string;
}> {
  const pdflatexCheck = spawnSync('pdflatex', ['--version'], { encoding: 'utf8' });
  if (pdflatexCheck.error || pdflatexCheck.status !== 0) {
    return {
      status: 'noCompiler',
      error: 'pdflatex not found. Install TeX Live (or MiKTeX) and ensure pdflatex is in PATH.',
    };
  }

  const needsBib = /\\(bibliography|addbibresource)\{[^}]*\}/.test(source);
  const tmpDir = path.join(os.tmpdir(), `metis-latex-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const texPath = path.join(tmpDir, 'document.tex');
  fs.writeFileSync(texPath, source, 'utf8');
  if (needsBib && bib) {
    fs.writeFileSync(path.join(tmpDir, 'references.bib'), bib, 'utf8');
  }

  const runCommand = async (command: string): Promise<{ stdout: string; stderr: string }> => {
    const { stdout, stderr } = await execAsync(command, { cwd: tmpDir, timeout: 30000 });
    return { stdout, stderr };
  };

  let stdout = '';
  try {
    const r1 = await runCommand('pdflatex -interaction=nonstopmode -halt-on-error document.tex');
    stdout += r1.stdout;
    if (needsBib && bib) {
      try {
        const rb = await runCommand('bibtex document');
        stdout += rb.stdout;
      } catch (err) {
        stdout += err instanceof Error ? err.message : String(err);
      }
    }
    const r2 = await runCommand('pdflatex -interaction=nonstopmode -halt-on-error document.tex');
    stdout += r2.stdout;
  } catch (err) {
    stdout += err instanceof Error ? err.message : String(err);
  }

  const pdfPath = path.join(tmpDir, 'document.pdf');
  const pdfExists = fs.existsSync(pdfPath);

  const errors = parseLatexLog(stdout);

  if (pdfExists) {
    const outDir = path.join(DATA_DIR, 'latex-output');
    fs.mkdirSync(outDir, { recursive: true });
    const outPdf = path.join(outDir, `document-${Date.now()}.pdf`);
    fs.copyFileSync(pdfPath, outPdf);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { status: 'success', pdfPath: outPdf, errors };
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  return {
    status: 'error',
    errors,
    error: errors.length > 0 ? errors[0].message : 'Compilation failed — no PDF generated',
  };
}

// ─── IPC Handlers ─────────────────────────────────────────────

/**
 * Lazily construct the WeChat bot service (METIS-WX-1). Module-level so both
 * setupIPC() handlers and the startup resume path can reach it.
 */
function ensureWeChatBot(): WeChatBotService | null {
  if (weChatBotService) return weChatBotService;
  if (!store) return null;
  weChatBotService = new WeChatBotService({
    client: new IlinkClient({}),
    store: getSecureStorage(),
    statePath: path.join(DATA_DIR, 'bot-state.json'),
    mediaDir: path.join(DATA_DIR, 'wechat-media'),
    runTurn: async ({ sessionId, userText, projectId, signal, attachments, images }) => {
      if (!store || !agentLoop) return { ok: false, error: 'Metis 服务未就绪' };
      try {
        const history = store.getMessages(sessionId).map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
          ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
          ...(m.name ? { name: m.name } : {}),
        }));
        // Memory injection (F12 project isolation applies when a project is bound).
        let skillPrompt: string | undefined;
        try {
          const memoryContext = memoryManager?.buildMemoryContext(projectId ?? undefined);
          if (memoryContext && memoryContext.trim()) skillPrompt = memoryContext;
          // Autonomous learning (B + C): behavior preferences + tool reliability.
          const learningContext = learningEngine?.buildLearningContext(projectId ?? undefined);
          if (learningContext && learningContext.trim()) {
            skillPrompt = [skillPrompt, learningContext].filter(Boolean).join('\n\n');
          }
        } catch { /* memory must never break a turn */ }
        // WeChat media attachments (METIS-WX-2): point the agent at local files
        // so its file tools (read_pdf, etc.) can analyze them.
        if (attachments && attachments.length > 0) {
          const attachmentBlock = [
            '用户通过微信发送了以下附件（本地文件，可直接用工具读取分析）：',
            ...attachments.map((a) => `- ${a.name} (${a.mime}) → ${a.path}`),
          ].join('\n');
          skillPrompt = [attachmentBlock, skillPrompt].filter(Boolean).join('\n\n');
        }
        const response = await runPersistedChatTurn({
          agentLoop,
          store,
          sessionId,
          messages: [
            ...history,
            {
              role: 'user' as const,
              content: userText,
              ...(images && images.length > 0 ? { images } : {}),
            },
          ],
          requestId: `wx-${Date.now()}-${Math.floor(Math.random() * 1e6)}`.slice(0, 128),
          taskContractHash: '',
          promptStackHash: '',
          skillPrompt,
          projectId,
          signal,
          options: { mode: 'send' },
        });
        if (response.status === 'completed' && response.answer) {
          // Autonomous learning after the WeChat turn (fire and forget).
          if (learningEngine) {
            void (async () => {
              try {
                await learningEngine.ingestConversation(
                  [...history, { role: 'user' as const, content: userText }],
                  projectId ?? undefined,
                );
                learningEngine.applyFeedbackSignals(
                  [...history, { role: 'user' as const, content: userText }],
                  projectId ?? undefined,
                );
                learningEngine.persistToolStats();
              } catch { /* learning must never break a turn */ }
            })();
          }
          return { ok: true, answer: response.answer };
        }
        return {
          ok: false,
          error: response.diagnostics[0]?.message ?? `agent_${response.status}`,
        };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
    listProjects: () => (researchRepository?.listProjects() ?? []).map((p) => ({ id: p.id, title: p.title })),
    getModelName: () => currentConfig?.model ?? 'unknown',
    supportsVision: () => currentConfig?.vision === true,
  });
  return weChatBotService;
}

function setupIPC(): void {
  let evalSuiteRunning = false;

  // ── Store ───────────────────────────────────────────────
  ipcMain.handle('store:ready', () => store !== null);

  // METIS-OPT-4: the renderer waits for full startup before hydrating, so the
  // window can appear before heavy initialization finishes.
  ipcMain.handle('startup:status', () => ({ ready: startupReady, storeReady: store !== null }));
  ipcMain.handle('runtime:identity', (event) => {
    requireRendererMainFrame(event);
    return getRuntimeIdentity();
  });

  ipcMain.handle('setup:probe', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const decoded = decodeSettingsProviderProbeRequest(rawRequest);
      if (!decoded.ok) return decodeSetupProbeResponse(null);
      const req = decoded.value;

      // Build legacy SetupInput by resolving the key per keyMode
      let resolvedApiKey: string;
      if (req.keyMode === 'saved') {
        if (!currentConfig?.apiKey) {
          return { version: SETUP_RUNTIME_CONTRACT_VERSION, operationId: req.operationId, success: false, recovery: createSetupRecovery('setup_secure_storage_unavailable') } satisfies SetupProbeResponse;
        }
        resolvedApiKey = currentConfig.apiKey;
      } else {
        resolvedApiKey = req.newApiKey!;
      }

      const legacyRequest = {
        version: req.version,
        operationId: req.operationId,
        input: { baseUrl: req.baseUrl, apiKey: resolvedApiKey, model: req.model },
      };

      if (!firstRunSetup) return decodeSetupProbeResponse(null);
      return await firstRunSetup.probe(legacyRequest, { owner: setupOwnerFor(event) }, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('setup:progress', progress);
      });
    } catch {
      return decodeSetupProbeResponse(null);
    }
  });

  ipcMain.handle('setup:save', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeSetupSaveRequest(rawRequest);
      if (!request.ok || !firstRunSetup) return decodeSetupSaveResponse(null);
      const result = await firstRunSetup.save(request.value, { owner: setupOwnerFor(event) }, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('setup:progress', progress);
      });
      // First-run setup remains a secure bootstrap path. Once it succeeds, make
      // the same runtime configuration visible as the first encrypted profile.
      if (result.success && providerProfileStore && currentConfig) {
        await providerProfileStore.ensureActiveFromConfig(currentConfig);
      }
      return result;
    } catch {
      return decodeSetupSaveResponse(null);
    }
  });

  ipcMain.handle('setup:restore', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeSetupRestoreRequest(rawRequest);
      if (!request.ok || !firstRunSetup) return decodeSetupRestoreResponse(null);
      return await firstRunSetup.restore(request.value);
    } catch {
      return decodeSetupRestoreResponse(null);
    }
  });

  ipcMain.handle('setup:abort', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeSetupAbortRequest(rawRequest);
      if (!request.ok || !firstRunSetup) {
        return {
          version: SETUP_RUNTIME_CONTRACT_VERSION,
          operationId: 'setup-recovery',
          success: false,
          code: 'setup_operation_not_found',
        };
      }
      return firstRunSetup.abort(request.value);
    } catch {
      return {
        version: SETUP_RUNTIME_CONTRACT_VERSION,
        operationId: 'setup-recovery',
        success: false,
        code: 'setup_operation_not_found',
      };
    }
  });

  // Persistent six-object research workspace. Every channel authorizes the
  // current main frame, decodes one bounded request and returns presentation
  // DTOs only; persistence records never cross IPC.
  ipcMain.handle('research:crud', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const result = decodeResearchCrudRequest(rawRequest);
      return result.ok ? decoded(result.value) : rejected();
    },
    execute: (request) => researchRuntime?.handleCrud(request) ?? createResearchMutationRecovery(),
    present: (result) => result,
    recover: createResearchMutationRecovery,
  }));

  ipcMain.handle('research:link', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const result = decodeResearchLinkRequest(rawRequest);
      return result.ok ? decoded(result.value) : rejected();
    },
    execute: (request) => researchRuntime?.handleLink(request) ?? createResearchMutationRecovery(),
    present: (result) => result,
    recover: createResearchMutationRecovery,
  }));

  ipcMain.handle('research:review', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const result = decodeResearchReviewRequest(rawRequest);
      return result.ok ? decoded(result.value) : rejected();
    },
    execute: (request) => researchRuntime?.handleReview(request) ?? createResearchMutationRecovery(),
    present: (result) => result,
    recover: createResearchMutationRecovery,
  }));

  ipcMain.handle('research:restore', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const result = decodeResearchRestoreRequest(rawRequest);
      return result.ok ? decoded(result.value) : rejected();
    },
    execute: (request) => researchRuntime?.handleRestore(request) ?? createResearchMutationRecovery(),
    present: (result) => result,
    recover: createResearchMutationRecovery,
  }));

  ipcMain.handle('research:version', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const result = decodeResearchArtifactVersionRequest(rawRequest);
      return result.ok ? decoded(result.value) : rejected();
    },
    execute: (request) => researchRuntime?.handleVersion(request) ?? createResearchMutationRecovery(),
    present: (result) => result,
    recover: createResearchMutationRecovery,
  }));

  ipcMain.handle('research:checkpoint', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const result = decodeResearchCheckpointRequest(rawRequest);
      return result.ok ? decoded(result.value) : rejected();
    },
    execute: (request) => researchRuntime?.handleCheckpoint(request) ?? createResearchMutationRecovery(),
    present: (result) => result,
    recover: createResearchMutationRecovery,
  }));

  ipcMain.handle('research:decision', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const result = decodeResearchDecisionRequest(rawRequest);
      return result.ok ? decoded(result.value) : rejected();
    },
    execute: (request) => researchRuntime?.handleDecision(request) ?? createResearchMutationRecovery(),
    present: (result) => result,
    recover: createResearchMutationRecovery,
  }));

  ipcMain.handle('research:snapshot', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const result = decodeResearchSnapshotRequest(rawRequest);
      return result.ok ? decoded(result.value) : rejected();
    },
    execute: (request) => researchRuntime?.getSnapshot(request.projectId) ?? createResearchSnapshotRecovery(),
    present: (result) => result,
    recover: createResearchSnapshotRecovery,
  }));

  ipcMain.handle('research:mediaAttach', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const request = decodeResearchMediaAttachRequest(rawRequest);
      return request ? decoded(request) : rejected();
    },
    execute: (request, event) => researchMedia?.attach(request, executionOwnerFor(event))
      ?? createResearchMediaAttachFailure(),
    present: decodeResearchMediaAttachResult,
    recover: createResearchMediaAttachFailure,
  }));

  ipcMain.handle('research:mediaPurge', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const request = decodeResearchMediaPurgeRequest(rawRequest);
      return request ? decoded(request) : rejected();
    },
    execute: (request) => researchMedia?.purge(request) ?? createResearchMediaPurgeFailure(),
    present: decodeResearchMediaPurgeResult,
    recover: createResearchMediaPurgeFailure,
  }));


  // ── Submission domain: 投稿事务（Series / Case / Events / 状态机） ──
  ipcMain.handle('submission:listSeries', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p = z.string().min(1).safeParse(raw); return p.success && submissionRepository ? submissionRepository.listSeries(p.data) : []; } catch { return []; } });
  ipcMain.handle('submission:listCases', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), status: z.string().optional(), query: z.string().max(200).optional(), includeClosed: z.boolean().optional() }).safeParse(raw);
      if (!p.success || !submissionRepository) return [];
      const status = SUBMISSION_STATUS_SET.has(p.data.status ?? '') ? (p.data.status as SubmissionStatusName) : undefined;
      return submissionRepository.listCases(p.data.projectId, { status, query: p.data.query, includeClosed: p.data.includeClosed });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('submission_duplicate_active')) throw error;
      return [];
    }
  });
  ipcMain.handle('submission:getCase', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw); return p.success && submissionRepository ? submissionRepository.getCase(p.data.projectId, p.data.caseId) ?? null : null; } catch { return null; } });
  ipcMain.handle('submission:createCase', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = SubmissionCaseCreateRequestSchema.safeParse(raw);
      if (!p.success || !submissionRepository) {
        console.error('[submission:createCase] rejected:', p.success ? 'repository_unavailable' : JSON.stringify(p.error.issues));
        return null;
      }
      return submissionRepository.createCase(p.data);
    } catch (error) {
      // 一稿多投风险：结构化返回，不静默吞掉。
      if (error instanceof Error && error.message.startsWith('submission_duplicate_active')) {
        const [, caseId, journal] = error.message.split(':');
        return { ok: false as const, code: 'duplicate_active' as const, activeCaseId: caseId ?? '', activeJournal: journal ?? '' };
      }
      console.error('[submission:createCase] failed:', error instanceof Error ? error.stack : error);
      return null;
    }
  });
  ipcMain.handle('submission:updateCase', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p = z.object({ projectId: z.string().min(1), patch: SubmissionCaseUpdateRequestSchema }).safeParse(raw); if (!p.success || !submissionRepository) return null; return submissionRepository.updateCase(p.data.projectId, p.data.patch) ?? null; } catch { return null; } });
  ipcMain.handle('submission:changeStatus', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), change: SubmissionStatusChangeRequestSchema }).safeParse(raw);
      if (!p.success || !submissionRepository) return null;
      // 最终提交是外部副作用，必须走 submission:submit（Human Approval 门控 + 回执），
      // 不允许经通用状态通道直接推到已提交/已重投。
      if (p.data.change.to === 'SUBMITTED' || p.data.change.to === 'RESUBMITTED') {
        return { ok: false as const, code: 'use_submit_flow' as const, message: '正式提交/重投必须通过「确认投稿」流程完成（需人工确认与投稿回执）。' };
      }
      return submissionRepository.changeStatus(p.data.projectId, p.data.change) ?? null;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Illegal submission status transition')) {
        return { ok: false as const, code: 'illegal_transition' as const, message: error.message };
      }
      return null;
    }
  });
  ipcMain.handle('submission:listEvents', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw); return p.success && submissionRepository ? submissionRepository.listEvents(p.data.projectId, p.data.caseId) : []; } catch { return []; } });
  ipcMain.handle('submission:addEvent', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1), type: z.string().min(1).max(60), source: z.enum(['human', 'system', 'browser', 'email', 'agent']).default('human'), sourceId: z.string().max(300).nullable().optional(), actor: z.string().max(120).optional(), description: z.string().max(2000).optional(), metadata: z.record(z.string(), z.unknown()).optional() }).safeParse(raw);
      if (!p.success || !submissionRepository) return null;
      return submissionRepository.addEvent(p.data.projectId, { caseId: p.data.caseId, type: p.data.type, source: p.data.source, sourceId: p.data.sourceId ?? null, actor: p.data.actor, description: p.data.description, metadata: p.data.metadata }) ?? null;
    } catch { return null; }
  });
  ipcMain.handle('submission:archiveCase', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw); return p.success && submissionRepository ? submissionRepository.archiveCase(p.data.projectId, p.data.caseId) : false; } catch { return false; } });
  ipcMain.handle('submission:checkActive', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p = z.object({ projectId: z.string().min(1), sourceOutcomeId: z.string().min(1) }).safeParse(raw); return p.success && submissionRepository ? submissionRepository.findActiveCase(p.data.projectId, p.data.sourceOutcomeId) ?? null : null; } catch { return null; } });

  ipcMain.handle('submission:matchJournals', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({
        projectId: z.string().min(1),
        caseId: z.string().min(1).optional(),
        query: z.string().min(2).max(200),
        outcomeId: z.string().min(1).optional(),
        criteria: TargetingCriteriaSchema,
      }).safeParse(raw);
      if (!p.success || !literatureSearchService) return null;
      const { criteria } = p.data;
      // 匹配策略修正（2026-09-01 刘总报告：匹配结果与论文毫无关系）：
      // ①查询词从论文正文关键词构造（标题只是兜底，且剥离“交付物/工作流”等
      //   元信息噪声）——成果标题是工作流名，不是论文主题；
      // ②搜到的每篇论文标题必须与关键词集合有实质重叠才进入聚合，
      //   零相关的候选宁可返回空，也不再拿不相干论文凑数。
      let contentText = '';
      if (p.data.outcomeId && outcomeRepository) {
        try {
          const detail = outcomeRepository.get(p.data.projectId, p.data.outcomeId);
          if (detail) contentText = outcomeContentToMatchText(detail.version.content);
        } catch { /* 成果读取失败退回标题查询 */ }
      }
      const { query, keywords } = buildVenueMatchQuery(contentText, p.data.query);
      if (!query.trim()) {
        return { ok: true as const, candidates: [], warnings: [], disclaimer: '论文内容里没有提取到可用的主题关键词，无法匹配；请在稿件里补充主题内容，或改用“指定期刊”模式。' };
      }
      const wantsChinese = criteria.categories.some((c) => ['cssci', 'cscd', 'pku_core', 'cn_general'].includes(c));
      const sources = wantsChinese ? ['ncpssd' as const, 'openalex' as const] : ['openalex' as const];
      const search = await literatureSearchService.search({ query, sources, pageSize: 25, coreOnly: false });
      if (!search.ok) return { ok: false as const, code: search.code, candidates: [], warnings: [] };
      const relevant = filterRelevantPapers(search.results.map((item) => ({ title: item.title, year: item.year, venue: item.venue, doi: item.doi, issn: item.issn, source: item.source })), keywords);
      const candidates = aggregateVenueCandidates({
        papers: relevant.map((item) => ({ title: item.title, year: item.year, venue: item.venue, doi: item.doi, issn: item.issn, source: item.source })),
        criteria,
        limit: 20,
      });
      // 留痕：匹配完成写事件（仅摘要计数，不塞全文）。
      if (p.data.caseId && submissionRepository) {
        try {
          submissionRepository.addEvent(p.data.projectId, {
            caseId: p.data.caseId, type: 'note_added', source: 'agent', actor: 'journal-matcher',
            description: `期刊匹配完成：候选 ${candidates.length} 个（满足条件 ${candidates.filter((item) => item.meetsCriteria === true).length} 个）`,
            metadata: { top: candidates.slice(0, 5).map((item) => ({ name: item.name, meets: item.meetsCriteria, count: item.recentPaperCount })) },
          });
        } catch { /* 留痕失败不影响匹配结果 */ }
      }
      return {
        ok: true as const,
        candidates,
        warnings: search.warnings,
        disclaimer: keywords.length > 0
          ? `候选按论文主题（关键词：${keywords.slice(0, 5).join('、')}）过滤——仅保留标题与之相关的近期论文（${relevant.length}/${search.results.length} 篇）；索引层级由本地白名单核验。`
          : '候选基于近期主题相关论文的发表期刊聚合；索引层级由本地白名单核验。',
      };
    } catch (error) {
      console.warn('[Submission] journal match failed:', (error as Error)?.message);
      return null;
    }
  });

  // ── Submission P1: 期刊档案 / 投稿要求 / 语料 / 范式 / 差距诊断 / 优化方案 ──
  // agentLoop 接线照 OutcomeAssistantService：每次调用按当前项目 provider 运行时解析；
  // provider 未配置时可降级的通道自动退化为确定性路径，plan:apply 返回 provider_not_configured。
  const submissionJournalProfileForCase = (projectId: string, caseId: string) => {
    const submissionCase = submissionRepository?.getCase(projectId, caseId);
    if (!submissionCase?.targetJournalId) return null;
    return journalProfileRepository?.getProfile(projectId, submissionCase.targetJournalId) ?? null;
  };
  const submissionManuscriptAbstract = (text: string): string => {
    const match = /(?:^|\n)\s*(?:abstract|摘\s*要)\s*[:：]?\s*/iu.exec(text);
    if (!match) return '';
    const rest = text.slice(match.index + match[0].length, match.index + match[0].length + 3000);
    const end = rest.search(/\n\s*(?:keywords?|key words|关键词|关键字|introduction|引\s*言)\s*[:：]?\s*/iu);
    return (end > 50 ? rest.slice(0, end) : rest).trim().slice(0, 2000);
  };
  const submissionManuscriptKeywords = (text: string): string[] => {
    const match = /(?:^|\n)\s*(?:keywords?|key words|关键词|关键字)\s*[:：]?\s*/iu.exec(text);
    if (!match) return [];
    const line = text.slice(match.index + match[0].length).split('\n')[0] ?? '';
    return line.split(/[,;，；、|]/u).map((item) => item.trim()).filter(Boolean).slice(0, 12);
  };

  ipcMain.handle('submission:journal:identify', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({
        projectId: z.string().min(1),
        caseId: z.string().min(1).optional(),
        name: z.string().max(300).optional(),
        issn: z.string().max(20).optional(),
      }).safeParse(raw);
      if (!p.success || !journalProfileRepository) return null;
      const result = await new JournalProfileService({ repository: journalProfileRepository })
        .identifyJournal({ projectId: p.data.projectId, name: p.data.name, issn: p.data.issn });
      // 核验成功且带 caseId：把档案写回 case 并留痕（不改变状态机状态）。
      if (result.ok && p.data.caseId && submissionRepository) {
        try {
          submissionRepository.updateCase(p.data.projectId, {
            caseId: p.data.caseId,
            targetJournalId: result.profile.id,
            targetJournalName: result.profile.canonicalName,
          }, 'system');
          submissionRepository.addEvent(p.data.projectId, {
            caseId: p.data.caseId, type: 'journal_identified', source: 'system', actor: 'journal-profile',
            description: `期刊身份核验完成：${result.profile.canonicalName}${result.profile.issn ? `（ISSN ${result.profile.issn}）` : ''}`,
            metadata: { profileId: result.profile.id, issn: result.profile.issn },
          });
        } catch { /* 写回/留痕失败不影响核验结果 */ }
      }
      return result;
    } catch { return null; }
  });

  ipcMain.handle('submission:journal:fetchGuidelines', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !submissionRepository) return null;
      const profile = submissionJournalProfileForCase(p.data.projectId, p.data.caseId);
      if (!profile) return { ok: false as const, code: 'journal_profile_not_found' as const, message: '该投稿案件尚未关联已核验的期刊档案，请先完成期刊核验。' };
      const runtime = resolveProjectOutcomeProvider(p.data.projectId);
      const result = await new JournalProfileService({
        repository: journalProfileRepository,
        ...(runtime.status === 'ready' ? { agentLoop: runtime.agentLoop, providerProfileBinding: runtime.binding } : {}),
      }).fetchGuidelines({ projectId: p.data.projectId, profileId: profile.id, caseId: p.data.caseId });
      // 成功后留痕；状态推进留给 UI 显式调用 submission:changeStatus。
      if (result.ok) {
        try {
          submissionRepository.addEvent(p.data.projectId, {
            caseId: p.data.caseId, type: 'profile_completed', source: 'system', actor: 'journal-profile',
            description: `期刊官方投稿要求抓取完成：${result.requirements.length} 条要求（${result.extraction === 'llm' ? '模型抽取' : '确定性抽取'}）。`,
            metadata: { profileId: profile.id, snapshotId: result.snapshot.id, requirementCount: result.requirements.length, extraction: result.extraction },
          });
        } catch { /* 留痕失败不影响结果 */ }
      }
      return result;
    } catch { return null; }
  });

  ipcMain.handle('submission:journal:profile', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !journalProfileRepository) return null;
      const profile = submissionJournalProfileForCase(p.data.projectId, p.data.caseId);
      if (!profile) return null;
      const snapshot = journalProfileRepository.latestSnapshot(profile.id) ?? null;
      return {
        profile,
        snapshot,
        requirements: snapshot ? journalProfileRepository.listRequirements(snapshot.id) : null,
        observations: snapshot ? journalProfileRepository.listPatternObservations(snapshot.id) : null,
        corpus: journalProfileRepository.listCorpusItems(profile.id),
      };
    } catch { return null; }
  });

  ipcMain.handle('submission:journal:buildCorpus', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !submissionRepository || !outcomeRepository) return null;
      const profile = submissionJournalProfileForCase(p.data.projectId, p.data.caseId);
      if (!profile) return { ok: false as const, code: 'journal_profile_not_found' as const, message: '该投稿案件尚未关联已核验的期刊档案，请先完成期刊核验。' };
      const submissionCase = submissionRepository.getCase(p.data.projectId, p.data.caseId)!;
      const outcomeId = submissionCase.workingOutcomeId ?? submissionCase.sourceOutcomeId;
      const detail = outcomeId ? outcomeRepository.get(p.data.projectId, outcomeId) : undefined;
      if (!detail) return { ok: false as const, code: 'manuscript_not_found' as const, message: '投稿案件没有可用的稿件成果（工作稿/源成果均缺失）。' };
      const text = extractManuscriptPlainText(detail.version.content);
      const abstract = submissionManuscriptAbstract(text);
      const keywords = submissionManuscriptKeywords(text);
      const snapshot = journalProfileRepository.latestSnapshot(profile.id) ?? null;
      const result = await new JournalCorpusService({ repository: journalProfileRepository, literatureSearch: literatureSearchService })
        .buildCorpus({
          projectId: p.data.projectId,
          profileId: profile.id,
          snapshotId: snapshot?.id ?? null,
          manuscript: {
            title: detail.outcome.title,
            ...(abstract ? { abstract } : {}),
            ...(keywords.length > 0 ? { keywords } : {}),
          },
        });
      if (result.ok) {
        try {
          submissionRepository.addEvent(p.data.projectId, {
            caseId: p.data.caseId, type: 'corpus_built', source: 'system', actor: 'journal-corpus',
            description: `期刊写作范式语料构建完成：新增 ${result.items.length} 篇。`,
            metadata: { profileId: profile.id, count: result.items.length },
          });
        } catch { /* 留痕失败不影响结果 */ }
      }
      return result;
    } catch { return null; }
  });

  ipcMain.handle('submission:journal:analyzePatterns', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !submissionRepository) return null;
      const profile = submissionJournalProfileForCase(p.data.projectId, p.data.caseId);
      if (!profile) return { ok: false as const, code: 'journal_profile_not_found' as const, message: '该投稿案件尚未关联已核验的期刊档案，请先完成期刊核验。' };
      const snapshot = journalProfileRepository.latestSnapshot(profile.id);
      if (!snapshot) return { ok: false as const, code: 'journal_snapshot_not_found' as const, message: '该期刊档案尚无研究快照，请先抓取投稿要求。' };
      const runtime = resolveProjectOutcomeProvider(p.data.projectId);
      const result = await new JournalPatternService({
        repository: journalProfileRepository,
        ...(runtime.status === 'ready' ? { agentLoop: runtime.agentLoop, providerProfileBinding: runtime.binding } : {}),
      }).analyzePatterns({ projectId: p.data.projectId, snapshotId: snapshot.id });
      if (result.ok) {
        try {
          submissionRepository.addEvent(p.data.projectId, {
            caseId: p.data.caseId, type: 'patterns_analyzed', source: 'system', actor: 'journal-pattern',
            description: `期刊写作范式分析完成：${result.observations.length} 条观察（语料 ${result.corpusSize} 篇）。`,
            metadata: { profileId: profile.id, snapshotId: snapshot.id, observationCount: result.observations.length, corpusSize: result.corpusSize },
          });
        } catch { /* 留痕失败不影响结果 */ }
      }
      return result;
    } catch { return null; }
  });

  ipcMain.handle('submission:journal:diffSnapshots', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !store) return null;
      const profile = submissionJournalProfileForCase(p.data.projectId, p.data.caseId);
      if (!profile) return null;
      const rows = store.raw.prepare(
        'SELECT id FROM journal_profile_snapshots WHERE profile_id = ? ORDER BY retrieved_at DESC, created_at DESC LIMIT 2',
      ).all(profile.id) as Array<{ id: string }>;
      if (rows.length < 2) return null;
      return new JournalProfileService({ repository: journalProfileRepository }).diffSnapshots(rows[1]!.id, rows[0]!.id);
    } catch { return null; }
  });

  ipcMain.handle('submission:diagnose', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !submissionRepository || !outcomeRepository) return null;
      const runtime = resolveProjectOutcomeProvider(p.data.projectId);
      return await new SubmissionGapService({
        submissionRepository,
        journalRepository: journalProfileRepository,
        outcomeRepository,
        ...(runtime.status === 'ready' ? { agentLoop: runtime.agentLoop } : {}),
      }).diagnose(p.data);
    } catch { return null; }
  });

  ipcMain.handle('submission:plan:create', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1), gapItemIds: z.array(z.string().min(1)).max(100).optional() }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !submissionRepository || !outcomeRepository) return null;
      return await new SubmissionOptimizationService({
        submissionRepository,
        journalRepository: journalProfileRepository,
        outcomeRepository,
        gapService: new SubmissionGapService({ submissionRepository, journalRepository: journalProfileRepository, outcomeRepository }),
      }).createPlanFromGaps(p.data);
    } catch { return null; }
  });

  ipcMain.handle('submission:plan:latest', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !submissionRepository) return null;
      if (!submissionRepository.getCase(p.data.projectId, p.data.caseId)) return null;
      const plan = journalProfileRepository.latestPlanForCase(p.data.caseId);
      if (!plan) return null;
      return { plan, items: journalProfileRepository.listPlanItems(plan.id) };
    } catch { return null; }
  });

  ipcMain.handle('submission:plan:approve', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), planId: z.string().min(1), selectedItemIds: z.array(z.string().min(1)).max(200).optional() }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !submissionRepository || !outcomeRepository) return null;
      // 越权防护：方案所属 case 必须属于当前项目。
      const plan = journalProfileRepository.getPlan(p.data.planId);
      if (!plan || !submissionRepository.getCase(p.data.projectId, plan.caseId)) {
        return { ok: false as const, code: 'plan_not_found' as const };
      }
      return await new SubmissionOptimizationService({
        submissionRepository,
        journalRepository: journalProfileRepository,
        outcomeRepository,
        gapService: new SubmissionGapService({ submissionRepository, journalRepository: journalProfileRepository, outcomeRepository }),
      }).approvePlan(p.data);
    } catch { return null; }
  });

  ipcMain.handle('submission:plan:apply', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), planId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !submissionRepository || !outcomeRepository) return null;
      // 自动修改依赖成果助手（LLM）；provider 未配置时结构化拒绝，不产生半执行状态。
      const runtime = resolveProjectOutcomeProvider(p.data.projectId);
      if (runtime.status !== 'ready') return { ok: false as const, code: 'provider_not_configured' as const };
      const assistant = new OutcomeAssistantService({
        repository: outcomeRepository,
        agentLoop: runtime.agentLoop,
        modelName: runtime.binding.model,
        providerProfileBinding: runtime.binding,
        projectContext: new OutcomeProjectContextService(outcomeRepository, { read: readOutcomeProjectMetis }),
        resolveBehaviorPrompt: (promptId, outcomeId) => officePromptProfileService?.resolveForBasePrompt(promptId, outcomeId ?? null) ?? artifactPromptService?.resolve(promptId) ?? null,
        getGlobalPrompt: (officeKind, outcomeId) => officePromptProfileService?.resolveGlobal(officeKind, outcomeId ?? null) ?? null,
      });
      return await new SubmissionOptimizationService({
        submissionRepository,
        journalRepository: journalProfileRepository,
        outcomeRepository,
        gapService: new SubmissionGapService({ submissionRepository, journalRepository: journalProfileRepository, outcomeRepository, agentLoop: runtime.agentLoop }),
        assistant,
      }).applyPlan(p.data);
    } catch { return null; }
  });

  ipcMain.handle('submission:plan:verify', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), planId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !submissionRepository || !outcomeRepository) return null;
      const plan = journalProfileRepository.getPlan(p.data.planId);
      if (!plan || !submissionRepository.getCase(p.data.projectId, plan.caseId)) {
        return { ok: false as const, code: 'plan_not_found' as const };
      }
      return await new SubmissionOptimizationService({
        submissionRepository,
        journalRepository: journalProfileRepository,
        outcomeRepository,
        gapService: new SubmissionGapService({ submissionRepository, journalRepository: journalProfileRepository, outcomeRepository }),
      }).verifyPlan(p.data);
    } catch { return null; }
  });

  ipcMain.handle('submission:gap:update', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({
        projectId: z.string().min(1),
        caseId: z.string().min(1),
        itemId: z.string().min(1),
        // patch 只放行 status 字段（UI 侧用于确认/忽略/重开差距项）。
        patch: z.strictObject({ status: z.enum(SUBMISSION_GAP_STATUSES) }),
      }).safeParse(raw);
      if (!p.success || !journalProfileRepository || !submissionRepository) return null;
      if (!submissionRepository.getCase(p.data.projectId, p.data.caseId)) return null;
      return journalProfileRepository.updateGapItem(p.data.caseId, p.data.itemId, { status: p.data.patch.status }) ?? null;
    } catch { return null; }
  });

  // ── Submission P2: 投稿预检 / 投稿包 / Cover Letter ──
  // 归属校验分层：case 级操作由服务内 getCase(projectId, caseId) 把关；
  // package 级写操作由 SubmissionPackageService.ownedPackage（经 case 反查项目）把关；
  // 查询类与 removeFile（不经服务）在本层显式做项目归属校验。
  const submissionOwnedPackage = (projectId: string, packageId: string) => {
    const pkg = submissionPackageRepository?.getPackage(packageId);
    if (!pkg || !submissionRepository?.getCase(projectId, pkg.caseId)) return null;
    return pkg;
  };

  ipcMain.handle('submission:preflight:run', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionPreflightService) return null;
      return await submissionPreflightService.run(p.data);
    } catch { return null; }
  });

  ipcMain.handle('submission:preflight:latest', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionPackageRepository || !submissionRepository) return null;
      if (!submissionRepository.getCase(p.data.projectId, p.data.caseId)) return null;
      const run = submissionPackageRepository.latestPreflightRun(p.data.caseId);
      if (!run) return null;
      return { run, checks: submissionPackageRepository.listPreflightChecks(run.id) };
    } catch { return null; }
  });

  ipcMain.handle('submission:package:assemble', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionPackageService) return null;
      return await submissionPackageService.assemble(p.data);
    } catch { return null; }
  });

  ipcMain.handle('submission:package:latest', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionPackageRepository || !submissionRepository) return null;
      if (!submissionRepository.getCase(p.data.projectId, p.data.caseId)) return null;
      const pkg = submissionPackageRepository.latestPackageForCase(p.data.caseId);
      if (!pkg) return null;
      return { package: pkg, files: submissionPackageRepository.listPackageFiles(pkg.id) };
    } catch { return null; }
  });

  ipcMain.handle('submission:package:attachOutcome', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.strictObject({
        projectId: z.string().min(1),
        packageId: z.string().min(1),
        outcomeId: z.string().min(1),
        type: z.enum(SUBMISSION_PACKAGE_FILE_TYPES),
        required: z.boolean().optional(),
        note: z.string().max(20000).optional(),
      }).safeParse(raw);
      if (!p.success || !submissionPackageService) return null;
      return await submissionPackageService.attachOutcome(p.data);
    } catch { return null; }
  });

  ipcMain.handle('submission:package:attachFile', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.strictObject({
        projectId: z.string().min(1),
        packageId: z.string().min(1),
        type: z.enum(SUBMISSION_PACKAGE_FILE_TYPES),
        filePath: z.string().min(1).max(2000),
        required: z.boolean().optional(),
      }).safeParse(raw);
      if (!p.success || !submissionPackageService) return null;
      // filePath 必须是已存在常规文件的绝对路径；拒绝目录与相对路径（选择对话框由 UI 复用现有通道）。
      const filePath = p.data.filePath;
      if (!path.isAbsolute(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return { ok: false as const, code: 'file_not_found' as const };
      }
      return await submissionPackageService.attachFile(p.data);
    } catch { return null; }
  });

  ipcMain.handle('submission:package:removeFile', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), packageId: z.string().min(1), fileId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionPackageRepository) return false;
      // 项目归属校验：package 所属 case 必须属于该项目；frozen 由仓储层硬边界拒绝。
      if (!submissionOwnedPackage(p.data.projectId, p.data.packageId)) return false;
      return submissionPackageRepository.removePackageFile(p.data.packageId, p.data.fileId);
    } catch { return false; }
  });

  ipcMain.handle('submission:package:export', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), packageId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionPackageService) return null;
      return await submissionPackageService.exportToDisk(p.data);
    } catch { return null; }
  });

  ipcMain.handle('submission:package:freeze', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), packageId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionPackageService) return null;
      // preflight 门控（最近一次预检必须 passed）在服务内执行并返回真实 blockers。
      return await submissionPackageService.freeze(p.data);
    } catch { return null; }
  });

  ipcMain.handle('submission:package:validate', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), packageId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionPackageService) return null;
      return await submissionPackageService.validate(p.data);
    } catch { return null; }
  });

  ipcMain.handle('submission:coverLetter:generate', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionCoverLetterService || !submissionRepository || !journalProfileRepository || !outcomeRepository) return null;
      // provider 就绪时按当前项目运行时解析 agentLoop 走 LLM 成稿（照 P1 fetchGuidelines 写法）；
      // 未配置时用无 agentLoop 的基础实例，服务内如实降级为模板骨架（extraction: 'template'）。
      const runtime = resolveProjectOutcomeProvider(p.data.projectId);
      const service = runtime.status === 'ready'
        ? new CoverLetterService({
            submissionRepository,
            journalRepository: journalProfileRepository,
            outcomeRepository,
            ...(submissionPackageRepository ? { packageRepository: submissionPackageRepository } : {}),
            agentLoop: runtime.agentLoop,
            providerProfileBinding: runtime.binding,
          })
        : submissionCoverLetterService;
      return await service.generate(p.data);
    } catch { return null; }
  });

  // ── Submission P4: Decision Letter 拆解 / 返修工作台 / Response Letter ──
  ipcMain.handle('submission:review:createRound', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({
        projectId: z.string().min(1), caseId: z.string().min(1),
        decisionLetterText: z.string().min(1).max(200_000),
        deadline: z.number().int().nonnegative().nullable().optional(),
      }).safeParse(raw);
      if (!p.success || !submissionReviewService) return null;
      return submissionReviewService.createRoundFromLetter(p.data);
    } catch { return null; }
  });

  ipcMain.handle('submission:review:list', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionReviewService || !submissionRepository) return [];
      if (!submissionRepository.getCase(p.data.projectId, p.data.caseId)) return [];
      return submissionReviewService.listRounds(p.data.projectId, p.data.caseId);
    } catch { return []; }
  });

  ipcMain.handle('submission:review:updateComment', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), commentId: z.string().min(1), patch: ReviewCommentPatchSchema }).safeParse(raw);
      if (!p.success || !submissionReviewRepository) return null;
      return submissionReviewRepository.updateComment(p.data.projectId, p.data.commentId, p.data.patch) ?? null;
    } catch { return null; }
  });

  ipcMain.handle('submission:review:beginRevision', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionReviewService) return { ok: false as const, code: 'unavailable' };
      return await submissionReviewService.beginRevision(p.data);
    } catch { return null; }
  });

  ipcMain.handle('submission:review:generateResponse', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionReviewService) return null;
      return await submissionReviewService.generateResponseLetter(p.data);
    } catch { return null; }
  });

  // ── Submission P3: 最终提交（强制 Human Approval 门控 + 回执）──
  // 直接经 submission:changeStatus 推到 SUBMITTED / RESUBMITTED 一律拒绝，
  // 必须走本通道：confirmed=true + 预检通过 + 材料包已冻结才放行。
  ipcMain.handle('submission:submit', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.strictObject({
        projectId: z.string().min(1),
        caseId: z.string().min(1),
        submissionMethod: z.enum(['portal_web', 'email', 'offline_manual']),
        portalUrl: z.string().max(2000).optional(),
        remoteSubmissionId: z.string().max(300).optional(),
        notes: z.string().max(5000).optional(),
        confirmed: z.literal(true),
      }).safeParse(raw);
      if (!p.success || !submissionRepository || !submissionPackageRepository) {
        return p.success && !p.data.confirmed ? { ok: false as const, code: 'approval_required' as const } : null;
      }
      const { projectId, caseId } = p.data;
      const submissionCase = submissionRepository.getCase(projectId, caseId);
      if (!submissionCase) return { ok: false as const, code: 'case_not_found' as const };
      // 预检门控：最近一次预检必须存在且无必须处理项。
      const run = submissionPackageRepository.latestPreflightRun(caseId);
      if (!run || !run.passed) return { ok: false as const, code: 'preflight_not_passed' as const };
      // 材料包门控：必须已冻结（正式提交前冻结 Package）。
      const pkg = submissionPackageRepository.latestPackageForCase(caseId);
      if (!pkg || pkg.status !== 'frozen') return { ok: false as const, code: 'package_not_frozen' as const };
      // 回执信息：remoteSubmissionId 是外部副作用的幂等凭证（人工从投稿系统回填）。
      submissionRepository.updateCase(projectId, {
        caseId,
        submissionMethod: p.data.submissionMethod,
        ...(p.data.portalUrl !== undefined ? { submissionPortalUrl: p.data.portalUrl } : {}),
        ...(p.data.remoteSubmissionId !== undefined ? { remoteSubmissionId: p.data.remoteSubmissionId } : {}),
        ...(p.data.notes !== undefined ? { notes: p.data.notes } : {}),
      }, 'human');
      // 状态链：READY_TO_SUBMIT → SUBMITTING → SUBMITTED；READY_TO_RESUBMIT → RESUBMITTED。
      const before = submissionRepository.getCase(projectId, caseId)!;
      if (before.status === 'READY_TO_SUBMIT') {
        if (!submissionRepository.changeStatus(projectId, { caseId, to: 'SUBMITTING', reason: '进入提交流程（人工确认）', source: 'human', actor: 'human' })) {
          return { ok: false as const, code: 'illegal_transition' as const };
        }
        if (!submissionRepository.changeStatus(projectId, { caseId, to: 'SUBMITTED', reason: `投稿回执：${p.data.remoteSubmissionId ?? '（无编号）'}`, source: 'human', actor: 'human' })) {
          return { ok: false as const, code: 'illegal_transition' as const };
        }
      } else if (before.status === 'READY_TO_RESUBMIT') {
        if (!submissionRepository.changeStatus(projectId, { caseId, to: 'RESUBMITTED', reason: '重新提交（人工确认）', source: 'human', actor: 'human' })) {
          return { ok: false as const, code: 'illegal_transition' as const };
        }
      } else if (before.status !== 'SUBMITTING' && before.status !== 'SUBMISSION_STATE_UNCERTAIN') {
        return { ok: false as const, code: 'illegal_status' as const };
      }
      const current = submissionRepository.getCase(projectId, caseId)!;
      submissionRepository.addEvent(projectId, {
        caseId, type: 'submission_receipt', source: 'human', actor: 'human',
        description: `投稿确认完成：${current.targetJournalName} · ${p.data.submissionMethod === 'email' ? '邮件投稿' : '网页投稿'}${p.data.remoteSubmissionId ? ` · 编号 ${p.data.remoteSubmissionId}` : ''}`,
        metadata: { method: p.data.submissionMethod, portalUrl: p.data.portalUrl ?? '', remoteSubmissionId: p.data.remoteSubmissionId ?? '', packageId: pkg.id },
      });
      return { ok: true as const, submissionCase: current };
    } catch { return null; }
  });

  // ── Submission P3/P4: 投稿通信（邮件外发/监听）与投稿门户操作 ──
  // 邮箱账户安全投影：绝不向渲染端暴露 encryptedSecret。
  ipcMain.handle('submission:mail:accounts', (event) => {
    try {
      requireRendererMainFrame(event);
      return (submissionMailboxStore?.list() ?? []).map((account) => ({
        id: account.id, label: account.label, user: account.user, host: account.host,
        createdAt: account.createdAt, lastCheckedAt: account.lastCheckedAt, lastOkAt: account.lastOkAt,
      }));
    } catch { return []; }
  });
  ipcMain.handle('submission:mail:preview', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.strictObject({
        accountId: z.string().min(1),
        to: z.string().max(4000), cc: z.string().max(4000).optional(), bcc: z.string().max(4000).optional(),
        subject: z.string().max(4000), bodyText: z.string().max(200_000),
        attachments: z.array(z.strictObject({ filename: z.string().min(1).max(500), path: z.string().max(4000).optional(), contentBase64: z.string().max(40_000_000).optional() })).max(20).optional(),
      }).safeParse(raw);
      if (!p.success || !mailSendService) return null;
      return mailSendService.previewSend({
        accountId: p.data.accountId, to: p.data.to, cc: p.data.cc, bcc: p.data.bcc,
        subject: p.data.subject, bodyText: p.data.bodyText,
        attachments: (p.data.attachments ?? []).map((a) => ({
          filename: a.filename,
          ...(a.path ? { path: a.path } : {}),
          ...(a.contentBase64 ? { content: Buffer.from(a.contentBase64, 'base64') } : {}),
        })),
      });
    } catch { return null; }
  });
  // 外发必须带 confirmed:true（人类确认）+ operationId（幂等键，重试不重发）。
  ipcMain.handle('submission:mail:send', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.strictObject({
        projectId: z.string().min(1), caseId: z.string().min(1).optional(),
        accountId: z.string().min(1), operationId: z.string().min(1).max(200),
        to: z.string().max(4000), cc: z.string().max(4000).optional(), bcc: z.string().max(4000).optional(),
        subject: z.string().max(4000), bodyText: z.string().max(200_000),
        attachments: z.array(z.strictObject({ filename: z.string().min(1).max(500), path: z.string().max(4000).optional(), contentBase64: z.string().max(40_000_000).optional() })).max(20).optional(),
        confirmed: z.literal(true),
      }).safeParse(raw);
      if (!p.success || !mailSendService) return null;
      return await mailSendService.sendMail({
        projectId: p.data.projectId, caseId: p.data.caseId, accountId: p.data.accountId,
        operationId: p.data.operationId, to: p.data.to, cc: p.data.cc, bcc: p.data.bcc,
        subject: p.data.subject, bodyText: p.data.bodyText,
        attachments: (p.data.attachments ?? []).map((a) => ({
          filename: a.filename,
          ...(a.path ? { path: a.path } : {}),
          ...(a.contentBase64 ? { content: Buffer.from(a.contentBase64, 'base64') } : {}),
        })),
      });
    } catch { return null; }
  });
  ipcMain.handle('submission:mail:sync', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), accountId: z.string().min(1), limit: z.number().int().min(1).max(50).optional() }).safeParse(raw);
      if (!p.success || !submissionMailService) return null;
      return await submissionMailService.syncAccount(p.data);
    } catch { return null; }
  });
  ipcMain.handle('submission:correspondence:listByCase', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionCorrespondenceRepository) return [];
      return submissionCorrespondenceRepository.listByCase(p.data.projectId, p.data.caseId);
    } catch { return []; }
  });
  ipcMain.handle('submission:correspondence:listPending', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionCorrespondenceRepository) return [];
      return submissionCorrespondenceRepository.listPending(p.data.projectId);
    } catch { return []; }
  });
  ipcMain.handle('submission:correspondence:confirmMatch', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), id: z.string().min(1), caseId: z.string().min(1).optional() }).safeParse(raw);
      if (!p.success || !submissionMailService) return null;
      return submissionMailService.confirmMatch(p.data);
    } catch { return null; }
  });
  ipcMain.handle('submission:correspondence:rejectMatch', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), id: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionMailService) return null;
      return submissionMailService.rejectMatch(p.data);
    } catch { return null; }
  });
  // 从已确认关联的 Decision/Revision 邮件一键建审稿轮次（服务内部再校验分类与确认状态）。
  ipcMain.handle('submission:correspondence:createRound', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), id: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionMailService) return null;
      return submissionMailService.createRoundFromCorrespondence(p.data);
    } catch { return null; }
  });
  // 返修截止日期同步到任务板（Goal）。幂等：已绑定的轮次返回 already_synced。
  ipcMain.handle('submission:review:syncDeadline', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), caseId: z.string().min(1), roundId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionDeadlineSync) return { ok: false as const, code: 'service_unavailable' };
      return submissionDeadlineSync.syncRoundToGoal(p.data);
    } catch { return { ok: false as const, code: 'service_unavailable' }; }
  });
  // ── 投稿门户（Browser-assisted Submission）：法律/财务/声明/最终提交永不由 Agent 执行 ──
  ipcMain.handle('submission:portal:open', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), caseId: z.string().min(1), portalUrl: z.string().max(2000).optional() }).safeParse(raw);
      if (!p.success || !submissionPortalService) return null;
      return await submissionPortalService.openPortal(p.data);
    } catch { return null; }
  });
  ipcMain.handle('submission:portal:planFill', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.object({ projectId: z.string().min(1), caseId: z.string().min(1) }).safeParse(raw);
      if (!p.success || !submissionPortalService) return null;
      return await submissionPortalService.planFill(p.data);
    } catch { return null; }
  });
  ipcMain.handle('submission:portal:execute', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.strictObject({
        projectId: z.string().min(1), caseId: z.string().min(1),
        actions: z.array(PortalFieldActionSchema).max(50),
        confirmed: z.boolean().optional(),
      }).safeParse(raw);
      if (!p.success || !submissionPortalService) return null;
      return await submissionPortalService.executeAutoSteps(p.data);
    } catch { return null; }
  });
  ipcMain.handle('submission:portal:confirmSubmitted', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.strictObject({
        projectId: z.string().min(1), caseId: z.string().min(1),
        remoteSubmissionId: z.string().max(300).optional(), receiptNote: z.string().max(5000).optional(),
      }).safeParse(raw);
      if (!p.success || !submissionPortalService) return null;
      return submissionPortalService.confirmSubmitted(p.data);
    } catch { return null; }
  });
  ipcMain.handle('submission:portal:markUncertain', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = z.strictObject({ projectId: z.string().min(1), caseId: z.string().min(1), reason: z.string().min(1).max(2000) }).safeParse(raw);
      if (!p.success || !submissionPortalService) return null;
      return submissionPortalService.markUncertain(p.data);
    } catch { return null; }
  });

  // ── Outcomes workbench: project-owned formal deliverables ──
  ipcMain.handle('outcomes:categories:list', (event) => { try { requireRendererMainFrame(event); return outcomeRepository?.listCategories() ?? []; } catch { return []; } });
  ipcMain.handle('outcomes:categories:create', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=OutcomeCategoryCreateSchema.safeParse(raw); return p.success && outcomeRepository ? outcomeRepository.createCategory(p.data.name) : null; } catch { return null; } });
  ipcMain.handle('outcomes:categories:rename', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=OutcomeCategoryRenameSchema.safeParse(raw); return p.success && outcomeRepository ? outcomeRepository.renameCategory(p.data.categoryId,p.data.name) ?? null : null; } catch { return null; } });
  ipcMain.handle('outcomes:categories:delete', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=OutcomeCategoryDeleteSchema.safeParse(raw); return Boolean(p.success && outcomeRepository?.deleteCategory(p.data.categoryId)); } catch { return false; } });
  ipcMain.handle('outcomes:list', async (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=OutcomeListRequestSchema.safeParse(raw); if (!p.success || !outcomeRepository) return []; await purgeExpiredOutcomeTrash(); return outcomeRepository.list(p.data.projectId,p.data.query); } catch { return []; } });
  ipcMain.handle('outcomes:get', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=OutcomeGetRequestSchema.safeParse(raw); return p.success && outcomeRepository ? outcomeRepository.get(p.data.projectId,p.data.outcomeId,p.data.version) ?? null : null; } catch { return null; } });
  ipcMain.handle('outcomes:versions', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=OutcomeVersionsRequestSchema.safeParse(raw); return p.success && outcomeRepository ? outcomeRepository.versions(p.data.projectId,p.data.outcomeId) : []; } catch { return []; } });
  ipcMain.handle('outcomes:external-editor:open', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = OutcomeExternalEditorOpenRequestSchema.safeParse(raw);
      if (!parsed.success) return OutcomeExternalEditorOpenResultSchema.parse({ ok: false, code: 'invalid_request', message: 'GenOffice 编辑请求无效。' });
      if (!outcomeRepository || !outcomeMedia || !outcomeExternalEditor) return OutcomeExternalEditorOpenResultSchema.parse({ ok: false, code: 'outcomes_unavailable', message: '成果或 GenOffice 编辑服务尚未初始化。' });
      const detail = outcomeRepository.get(parsed.data.projectId, parsed.data.outcomeId, parsed.data.version);
      if (!detail) return OutcomeExternalEditorOpenResultSchema.parse({ ok: false, code: 'outcome_not_found', message: '当前成果不存在或不属于当前项目。' });
      if (parsed.data.version !== undefined && parsed.data.version !== detail.outcome.currentVersion) {
        return OutcomeExternalEditorOpenResultSchema.parse({ ok: false, code: 'external_editor_version_conflict', message: '只能在 GenOffice 中编辑当前成果版本；历史版本不可直接覆盖当前版本。' });
      }
      const kind = externalEditorKindForOutcome(detail.outcome.kind);
      if (!kind) return OutcomeExternalEditorOpenResultSchema.parse({ ok: false, code: 'outcome_kind_mismatch', message: '当前成果类型没有对应的 GenOffice 编辑器。' });
      const fileNameBase = detail.outcome.title.replace(/[\\/:*?"<>|]+/gu, '-').trim() || 'outcome';
      let bytes: Buffer;
      let fileName = `${fileNameBase}${externalEditorExtension(kind)}`;
      if (kind === 'word') {
        const exported = await new OutcomeWordDocxService({
          resolveManagedImage: async (mediaId) => outcomeMedia!.readImageForWordDocxExport(parsed.data.projectId, parsed.data.outcomeId, mediaId),
          resolveOriginalArchive: async (mediaId) => outcomeMedia!.readArchive(parsed.data.projectId, parsed.data.outcomeId, mediaId),
        }).exportManagedDocument(detail.version.content as WordDocument);
        bytes = Buffer.from(exported.bytes);
      } else if (kind === 'ppt') {
        const exported = await new OutcomePptxService({
          resolveManagedImage: async (reference) => outcomeMedia!.readImageForPptxExport(parsed.data.projectId, parsed.data.outcomeId, reference),
          resolveOriginalArchive: async (mediaId) => outcomeMedia!.readArchive(parsed.data.projectId, parsed.data.outcomeId, mediaId),
        }).exportManagedDocument(detail.version.content as PptDocument);
        bytes = Buffer.from(exported.bytes);
      } else {
        const content = detail.version.content;
        if (content.type !== (kind === 'spreadsheet' ? 'spreadsheet' : 'pdf') || !content.media) return OutcomeExternalEditorOpenResultSchema.parse({ ok: false, code: 'outcome_kind_mismatch', message: '当前成果没有可交给 GenOffice 的真实文件媒体。' });
        const stored = await outcomeMedia.readBytes(parsed.data.projectId, parsed.data.outcomeId, content.media.id);
        if (!stored || !isExternalEditorDocumentBytes(kind, stored.bytes)) return OutcomeExternalEditorOpenResultSchema.parse({ ok: false, code: 'outcome_kind_mismatch', message: '当前成果媒体不存在、完整性校验失败或文件类型不匹配。' });
        bytes = stored.bytes;
        const originalExtension = path.extname(stored.displayName).toLowerCase();
        if ((kind === 'spreadsheet' && (originalExtension === '.xlsx' || originalExtension === '.xlsm')) || (kind === 'pdf' && originalExtension === '.pdf')) fileName = `${fileNameBase}${originalExtension}`;
      }
      if (parsed.data.embedded === true) {
        // 内嵌模式：会话照常建，但不 spawn 子进程——由主窗口内的
        // WebContentsView 承载 GenOffice 渲染页。
        const session = await outcomeExternalEditor.create({ projectId: parsed.data.projectId, outcomeId: parsed.data.outcomeId, baseVersion: detail.version.version, kind, fileName, bytes, skipLaunch: true });
        const ownerWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
        if (!ownerWindow) return OutcomeExternalEditorOpenResultSchema.parse({ ok: false, code: 'genoffice_open_failed', message: '主窗口尚未就绪，无法在页面内打开 GenOffice 编辑器。' });
        const embedded = await genofficeEmbeddedViews.open({
          token: session.token,
          kind,
          projectId: parsed.data.projectId,
          outcomeId: parsed.data.outcomeId,
          filePath: session.filePath,
          fileName: path.basename(session.filePath),
          ownerWindow,
          ...(process.env.METIS_GENOFFICE_DEBUG === '1' && Number.isInteger(Number(process.env.METIS_GENOFFICE_DEBUG_PORT)) ? { debugPort: Number(process.env.METIS_GENOFFICE_DEBUG_PORT) } : {}),
        });
        return OutcomeExternalEditorOpenResultSchema.parse({ ok: true, session: { token: session.token, kind: session.kind, fileName: path.basename(session.filePath) }, webContentsId: embedded.viewId });
      }
      const session = await outcomeExternalEditor.create({ projectId: parsed.data.projectId, outcomeId: parsed.data.outcomeId, baseVersion: detail.version.version, kind, fileName, bytes });
      return OutcomeExternalEditorOpenResultSchema.parse({ ok: true, session: { token: session.token, kind: session.kind, fileName: path.basename(session.filePath) } });
    } catch (error) {
      const message = String((error as Error).message ?? error);
      return OutcomeExternalEditorOpenResultSchema.parse({ ok: false, code: message.startsWith('genoffice_') ? 'genoffice_open_failed' : 'genoffice_unavailable', message: message === 'genoffice_unavailable' ? 'GenOffice 构建产物不可用，请先完成 GenOffice 构建。' : 'GenOffice 编辑器没有成功打开当前成果。' });
    }
  });
  ipcMain.handle('outcomes:external-editor:sync', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = OutcomeExternalEditorSyncRequestSchema.safeParse(raw);
      if (!parsed.success) return OutcomeExternalEditorSyncResultSchema.parse({ ok: false, code: 'invalid_request', message: 'GenOffice 同步请求无效。' });
      return await syncOutcomeFromGenoffice(parsed.data.projectId, parsed.data.outcomeId, parsed.data.token);
    } catch {
      return OutcomeExternalEditorSyncResultSchema.parse({ ok: false, code: 'invalid_request', message: 'GenOffice 同步请求无效。' });
    }
  });
  ipcMain.handle('outcomes:external-editor:close', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = OutcomeExternalEditorCloseRequestSchema.safeParse(raw);
      if (!parsed.success) return false;
      const session = outcomeExternalEditor.session(parsed.data.token);
      if (!session || session.projectId !== parsed.data.projectId || session.outcomeId !== parsed.data.outcomeId) return false;
      await outcomeExternalEditor.close(parsed.data.token);
      return true;
    } catch { return false; }
  });
  ipcMain.handle('outcomes:external-editor:state', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = OutcomeExternalEditorStateRequestSchema.safeParse(raw);
      if (!parsed.success) return OutcomeExternalEditorStateSchema.parse({ exists: false, changed: false, session: null });
      const state = await outcomeExternalEditor.stateFor(parsed.data.projectId, parsed.data.outcomeId);
      return OutcomeExternalEditorStateSchema.parse({
        exists: state.exists,
        changed: state.changed,
        session: state.session ? { token: state.session.token, kind: state.session.kind, fileName: path.basename(state.session.filePath) } : null,
      });
    } catch {
      return OutcomeExternalEditorStateSchema.parse({ exists: false, changed: false, session: null });
    }
  });
  // ── 嵌入式 GenOffice 视图控制（几何 / 显隐 / 焦点）──
  ipcMain.handle('genoffice-embedded:set-bounds', (event, raw: unknown) => {
    try {
      const p = z.object({ webContentsId: z.number().int().positive(), rect: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }) }).safeParse(raw);
      if (!p.success) return false;
      const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      if (!window) return false;
      genofficeEmbeddedViews.setBounds(window, p.data.webContentsId, p.data.rect);
      return true;
    } catch { return false; }
  });
  ipcMain.handle('genoffice-embedded:set-visible', (event, raw: unknown) => {
    try {
      const p = z.object({ webContentsId: z.number().int().positive(), visible: z.boolean() }).safeParse(raw);
      if (!p.success || !mainWindow || mainWindow.isDestroyed()) return false;
      if (p.data.visible) genofficeEmbeddedViews.show(mainWindow, p.data.webContentsId);
      else genofficeEmbeddedViews.hide(p.data.webContentsId);
      return true;
    } catch { return false; }
  });
  ipcMain.handle('genoffice-embedded:focus', (event, raw: unknown) => {
    try {
      const p = z.object({ webContentsId: z.number().int().positive() }).safeParse(raw);
      if (!p.success) return false;
      genofficeEmbeddedViews.focus(p.data.webContentsId);
      return true;
    } catch { return false; }
  });
  ipcMain.handle('outcomes:create', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = OutcomeCreateRequestSchema.safeParse(raw);
      if (!p.success || !outcomeRepository) return null;
      const pptxSession = p.data.importToken ? pptxImportSessions.get(p.data.importToken) : undefined;
      const wordSession = p.data.importToken ? wordDocxImportSessions.get(p.data.importToken) : undefined;
      const session = pptxSession ?? wordSession;
      if (p.data.importToken && (!session || session.projectId !== p.data.projectId || session.outcomeId !== p.data.outcomeId)) return null;
      const createdMedia: string[] = [];
      let reservedOutcomeId: string | undefined;
      try {
        let createRequest = p.data;
        if (p.data.applyDefaultTemplate && !p.data.importToken && outcomeTemplateService) {
          const defaultKind: OutcomeTemplateKind | undefined = p.data.kind === 'word' ? 'word_formatting' : p.data.kind === 'ppt' ? 'ppt' : undefined;
          const defaultTemplate = defaultKind ? outcomeTemplateService.getDefault(defaultKind) : null;
          if (defaultTemplate) {
            if (p.data.kind === 'word' && defaultKind === 'word_formatting') {
              const parsed = WordFormattingTemplateDefinitionSchema.safeParse(defaultTemplate.definition);
              if (parsed.success && p.data.content.type === 'word') {
                const formatted = applyWordFormatting(p.data.content, parsed.data.config).document;
                createRequest = { ...p.data, content: { ...formatted, header: parsed.data.header, footer: parsed.data.footer, page: { ...formatted.page, pageNumber: parsed.data.pageNumber } } };
              }
            } else if (p.data.kind === 'ppt' && defaultKind === 'ppt' && p.data.content.type === 'ppt') {
              const decoded = decodePptTemplateDefinition(defaultTemplate.definition, p.data.content.ratio);
              if (decoded) {
                const ratio = decoded.ratio ?? p.data.content.ratio;
                const pages = decoded.pages ?? decodePptTemplatePages(p.data.content.pages, ratio);
                const theme = decoded.theme ?? p.data.content.theme;
                const candidate = pages
                  ? PptDocumentSchema.safeParse({ ...p.data.content, ratio, theme, pages, templateId: defaultTemplate.id })
                  : { success: false as const };
                if (candidate.success) createRequest = { ...p.data, content: candidate.data };
              }
            }
          }
        }
        let finalRequest = createRequest;
        if (!p.data.importToken && (p.data.kind === 'spreadsheet' || p.data.kind === 'pdf') && outcomeMedia) {
          reservedOutcomeId = p.data.outcomeId ?? `out-${randomUUID()}`;
          outcomeRepository.reserve({ projectId: p.data.projectId, outcomeId: reservedOutcomeId, categoryId: p.data.categoryId, title: p.data.title, kind: p.data.kind });
          const bytes = p.data.kind === 'spreadsheet' ? await createBlankSpreadsheetBytes() : createBlankPdfBytes();
          const media = await outcomeMedia.persistExternalDocument(p.data.projectId, reservedOutcomeId, bytes, p.data.kind, `${p.data.title}.${p.data.kind === 'spreadsheet' ? 'xlsx' : 'pdf'}`);
          if (!media) throw new Error('outcome_blank_media_failed');
          createdMedia.push(media.id);
          finalRequest = {
            ...createRequest,
            outcomeId: reservedOutcomeId,
            content: p.data.kind === 'spreadsheet'
              ? { type: 'spreadsheet', media, originalArchiveMediaId: media.id, workbook: { sheetNames: ['Sheet1'], activeSheet: 'Sheet1', activeCell: null, cells: {} } }
              : { type: 'pdf', media, originalArchiveMediaId: media.id, pageCount: 1, activePage: null },
          };
        }
        const created = outcomeRepository.create(finalRequest);
        if (p.data.importToken) {
          if (pptxSession) pptxImportSessions.delete(p.data.importToken);
          if (wordSession) wordDocxImportSessions.delete(p.data.importToken);
        }
        return created;
      } catch (error) {
        if (createdMedia.length > 0 && reservedOutcomeId) await outcomeMedia?.removeGenerated(p.data.projectId, reservedOutcomeId, createdMedia);
        if (reservedOutcomeId) outcomeRepository.deleteReserved(p.data.projectId, reservedOutcomeId);
        if (p.data.importToken && pptxSession) await discardPptxImportSession(p.data.importToken, pptxSession);
        if (p.data.importToken && wordSession) await discardWordDocxImportSession(p.data.importToken, wordSession);
        throw error;
      }
    } catch { return null; }
  });
  ipcMain.handle('outcomes:save', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = OutcomeSaveRequestSchema.safeParse(raw);
      if (!p.success || !outcomeRepository) return null;
      const pptxSession = p.data.importToken ? pptxImportSessions.get(p.data.importToken) : undefined;
      const wordSession = p.data.importToken ? wordDocxImportSessions.get(p.data.importToken) : undefined;
      const session = pptxSession ?? wordSession;
      if (p.data.importToken && (!session || session.projectId !== p.data.projectId || session.outcomeId !== p.data.outcomeId)) return null;
      try {
        const saved = outcomeRepository.save(p.data);
        if (p.data.importToken) {
          if (pptxSession) pptxImportSessions.delete(p.data.importToken);
          if (wordSession) wordDocxImportSessions.delete(p.data.importToken);
        }
        return saved;
      } catch (error) {
        if (p.data.importToken && pptxSession) await discardPptxImportSession(p.data.importToken, pptxSession);
        if (p.data.importToken && wordSession) await discardWordDocxImportSession(p.data.importToken, wordSession);
        throw error;
      }
    } catch { return null; }
  });
  ipcMain.handle('outcomes:restore', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=OutcomeRestoreRequestSchema.safeParse(raw); return p.success && outcomeRepository ? outcomeRepository.restore(p.data.projectId,p.data.outcomeId,p.data.version,p.data.note) : null; } catch { return null; } });
  ipcMain.handle('outcomes:rename', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=OutcomeRenameRequestSchema.safeParse(raw); return p.success && outcomeRepository ? outcomeRepository.rename(p.data.projectId,p.data.outcomeId,p.data.title) ?? null : null; } catch { return null; } });
  ipcMain.handle('outcomes:move', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=OutcomeMoveRequestSchema.safeParse(raw); return p.success && outcomeRepository ? outcomeRepository.move(p.data.projectId,p.data.outcomeId,p.data.categoryId) ?? null : null; } catch { return null; } });
  ipcMain.handle('outcomes:markFinal', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=OutcomeFinalRequestSchema.safeParse(raw); return p.success && outcomeRepository ? outcomeRepository.markFinal(p.data.projectId,p.data.outcomeId,p.data.version) ?? null : null; } catch { return null; } });
  // ── 成果回收站（2026-08-24 刘总需求）：软删除进回收站，7 天无操作自动彻底删除（含磁盘媒体文件）──
  // 到期清理由列表类调用惰性触发，与个性化定义的保留期策略一致。
  const purgeExpiredOutcomeTrash = async (): Promise<void> => {
    if (!outcomeRepository) return;
    let purged: Array<{ projectId: string; outcomeId: string; storedNames: string[] }>;
    try { purged = outcomeRepository.purgeExpired(); } catch { return; }
    for (const item of purged) { try { await outcomeMedia?.purgeFiles(item.projectId, item.storedNames); } catch { /* best-effort：数据库行已删，文件缺失不阻断 */ } }
  };
  ipcMain.handle('outcomes:archive', async (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=OutcomeTrashRequestSchema.safeParse(raw); if (!p.success || !outcomeRepository) return false; if ((await outcomeExternalEditor.closeFor(p.data.projectId, p.data.outcomeId)) === 'dirty') return false; return outcomeRepository.archive(p.data.projectId,p.data.outcomeId); } catch { return false; } });
  ipcMain.handle('outcomes:trash:list', async (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=OutcomeTrashListRequestSchema.safeParse(raw); if (!p.success || !outcomeRepository) return []; await purgeExpiredOutcomeTrash(); return outcomeRepository.listArchived(p.data.projectId); } catch { return []; } });
  ipcMain.handle('outcomes:trash:restore', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=OutcomeTrashRequestSchema.safeParse(raw); return p.success && outcomeRepository ? outcomeRepository.restoreArchived(p.data.projectId,p.data.outcomeId) : false; } catch { return false; } });
  ipcMain.handle('outcomes:delete', async (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=OutcomeTrashRequestSchema.safeParse(raw); if (!p.success || !outcomeRepository) return false; if ((await outcomeExternalEditor.closeFor(p.data.projectId, p.data.outcomeId)) === 'dirty') return false; const storedNames = outcomeRepository.deletePermanent(p.data.projectId,p.data.outcomeId); if (!storedNames) return false; try { await outcomeMedia?.purgeFiles(p.data.projectId, storedNames); } catch { /* best-effort */ } return true; } catch { return false; } });
  ipcMain.handle('outcomes:conversation:list', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=ScopedConversationRequestSchema.safeParse(raw); return p.success && outcomeRepository ? outcomeRepository.listConversation(p.data) : []; } catch { return []; } });
  ipcMain.handle('outcomes:conversation:append', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=ScopedConversationMessageRequestSchema.safeParse(raw); return p.success && outcomeRepository ? outcomeRepository.appendConversation(p.data) : null; } catch { return null; } });
  ipcMain.handle('outcomes:conversation:units', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=ScopedConversationRequestSchema.safeParse(raw); return p.success && outcomeRepository ? outcomeRepository.listConversations(p.data) : []; } catch { return []; } });
  ipcMain.handle('outcomes:conversation:create', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=ScopedConversationCreateSchema.safeParse(raw); return p.success && outcomeRepository ? outcomeRepository.createConversation({ ...p.data, scope: 'outcome' }) : null; } catch { return null; } });
  ipcMain.handle('outcomes:conversation:delete', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=ScopedConversationRefSchema.safeParse(raw); return p.success && outcomeRepository ? outcomeRepository.deleteConversation(p.data) : false; } catch { return false; } });
  ipcMain.handle('outcomes:conversation:byId', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=ScopedConversationRefSchema.safeParse(raw); return p.success && outcomeRepository ? outcomeRepository.listMessagesByConversation(p.data) : []; } catch { return []; } });
  ipcMain.handle('outcomes:conversation:appendTo', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=ScopedConversationAppendToSchema.safeParse(raw); return p.success && outcomeRepository ? outcomeRepository.appendToConversation(p.data) : null; } catch { return null; } });
  ipcMain.handle('scenario:conversation:units', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=ScenarioScopedConversationRequestSchema.safeParse(raw); if (!p.success || !outcomeRepository) return []; return outcomeRepository.listConversations({ ...p.data, scope: 'scenario', outcomeId: null }); } catch { return []; } });
  ipcMain.handle('scenario:conversation:create', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=ScenarioScopedConversationCreateSchema.safeParse(raw); if (!p.success || !outcomeRepository) return null; return outcomeRepository.createConversation({ ...p.data, scope: 'scenario', outcomeId: null }); } catch { return null; } });
  ipcMain.handle('scenario:conversation:delete', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=ScopedConversationRefSchema.safeParse(raw); return p.success && outcomeRepository ? outcomeRepository.deleteConversation(p.data) : false; } catch { return false; } });
  ipcMain.handle('scenario:conversation:messages', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=ScopedConversationRefSchema.safeParse(raw); return p.success && outcomeRepository ? outcomeRepository.listMessagesByConversation(p.data) : []; } catch { return []; } });
  ipcMain.handle('scenario:conversation:append', (event, raw: unknown) => { try { requireRendererMainFrame(event); const p=ScopedConversationAppendToSchema.safeParse(raw); if (!p.success || !outcomeRepository) return null; return outcomeRepository.appendToConversation(p.data); } catch { return null; } });

  // ── 选题 Topic(2026-09-04 刘总要求:选题一级功能)──
  // 任务3：域 registrar 迁移——channel/contract/恢复形状不变，注册走 IpcRegistry。
  ipcDomainDisposers.push(registerTopicIpc(domainIpcContext));
  // ---- 免费模型中心 IPC（2026-08-23）----
  // 任务3：域 registrar 迁移——channel/contract/恢复形状不变，注册走 IpcRegistry。
  ipcDomainDisposers.push(registerFreeModelIpc(domainIpcContext));

  // 每日免费模型扫描调度（2026-08-23）：启动后 120 秒检查，超过 20 小时未扫描则后台补扫（含探活）。
  setTimeout(() => {
    void freeModelService?.scanIfStale(20).then((ran) => {
      if (ran) console.log('[freeModel] daily background scan completed');
    }).catch(() => {});
  }, 120_000);

  ipcMain.handle('outcomes:assistant:chat', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return OutcomeAssistantChatResultSchema.parse({
        status: 'error', code: 'assistant_unavailable', message: '成果助手当前不可用。', answer: '', sources: [],
        diagnostics: [{ code: 'assistant_unavailable', message: '未授权的渲染进程请求成果助手。' }],
      });
    }
    if (runtimeShutdown.isDraining()) {
      return OutcomeAssistantChatResultSchema.parse({
        status: 'error', code: 'assistant_unavailable', message: '应用正在关闭，成果助手暂不可用。', answer: '', sources: [],
        diagnostics: [{ code: 'application_shutting_down', message: '应用正在关闭。' }],
      });
    }
    const parsed = OutcomeAssistantChatRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return OutcomeAssistantChatResultSchema.parse({
        status: 'error', code: 'invalid_request', message: '成果助手请求无效。', answer: '', sources: [],
        diagnostics: [{ code: 'invalid_request', message: '成果助手请求未通过契约校验。' }],
      });
    }
    const requestRepository = outcomeRepository;
    const requestAgentLoop = agentLoop;
    const requestProvider = provider;
    const requestRuntimeGeneration = runtimeGeneration;
    if (!requestRepository) {
      return OutcomeAssistantChatResultSchema.parse({
        status: 'error', code: 'assistant_unavailable', message: '成果助手尚未初始化，请重新打开应用后重试。', answer: '', sources: [],
        diagnostics: [{ code: 'assistant_unavailable', message: '成果仓库尚未初始化。' }],
      });
    }
    const projectRuntime = resolveProjectOutcomeProvider(parsed.data.projectId);
    if (projectRuntime.status !== 'ready') {
      return OutcomeAssistantChatResultSchema.parse({
        status: 'error', code: 'assistant_provider_unavailable', message: '当前项目没有可用的模型运行时；项目级 Provider 覆盖未降级到全局模型。', answer: '', sources: [],
        diagnostics: [{ code: 'assistant_provider_unavailable', message: `项目 Provider 运行时不可用：${projectRuntime.reason}。` }],
      });
    }
    const requestOutcomeLoop = projectRuntime.agentLoop;
    const tracked = trackEphemeralOperation(runtimeShutdown, {
      id: `outcome-assistant:${randomUUID()}`,
      rejection: OutcomeAssistantChatResultSchema.parse({
        status: 'error', code: 'application_shutting_down', message: '应用正在关闭，成果助手暂不可用。', answer: '', sources: [],
        diagnostics: [{ code: 'application_shutting_down', message: '应用正在关闭。' }],
      }),
    });
    if (!tracked.admitted) return tracked.rejection;
    try {
      return await new OutcomeAssistantService({
        repository: requestRepository,
        agentLoop: requestOutcomeLoop,
        modelName: projectRuntime.binding.model,
        providerProfileBinding: projectRuntime.binding,
        projectContext: new OutcomeProjectContextService(requestRepository, { read: readOutcomeProjectMetis }),
        signal: tracked.signal,
        isRuntimeCurrent: () => runtimeGeneration === requestRuntimeGeneration
          && agentLoop === requestAgentLoop
          && provider === requestProvider,
      }).chat(parsed.data);
    } finally {
      tracked.cleanup();
    }
  });
  ipcMain.handle('outcomes:source:locate', (event, raw: unknown) => {
    try { requireRendererMainFrame(event); } catch {
      return OutcomeSourceLocateResultSchema.parse({ ok: false, code: 'invalid_request' });
    }
    const parsed = OutcomeSourceLocateRequestSchema.safeParse(raw);
    if (!parsed.success || !outcomeRepository) {
      return OutcomeSourceLocateResultSchema.parse({ ok: false, code: 'invalid_request' });
    }
    try {
      return outcomeRepository.locateSource({ projectId: parsed.data.projectId, source: parsed.data.source });
    } catch {
      return OutcomeSourceLocateResultSchema.parse({ ok: false, code: 'source_not_found' });
    }
  });
  ipcMain.handle('outcomes:template:listByKind', (event, raw: unknown) => {
    try { requireRendererMainFrame(event); const p = OutcomeTemplateListRequestSchema.safeParse(raw); return p.success ? outcomeTemplateService?.list(p.data.kind) ?? [] : []; } catch { return []; }
  });
  ipcMain.handle('outcomes:template:saveUnified', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = OutcomeTemplateSaveRequestSchema.safeParse(raw);
      if (!p.success || !outcomeTemplateService) return null;
      if (p.data.kind === 'word_formatting' && !WordFormattingTemplateDefinitionSchema.safeParse(p.data.definition).success) return null;
      return outcomeTemplateService.save(p.data);
    } catch { return null; }
  });
  ipcMain.handle('outcomes:template:update', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = OutcomeTemplateUpdateRequestSchema.safeParse(raw);
      if (!p.success || !outcomeTemplateService) return null;
      if (p.data.kind === 'word_formatting' && p.data.definition !== undefined && !WordFormattingTemplateDefinitionSchema.safeParse(p.data.definition).success) return null;
      return outcomeTemplateService.update(p.data);
    } catch { return null; }
  });
  ipcMain.handle('outcomes:template:delete', (event, raw: unknown) => {
    try { requireRendererMainFrame(event); const p = OutcomeTemplateDeleteRequestSchema.safeParse(raw); if (!p.success || !outcomeTemplateService) return false; outcomeTemplateService.delete(p.data); return true; } catch { return false; }
  });
  ipcMain.handle('outcomes:template-defaults:get', (event, raw: unknown) => {
    try { requireRendererMainFrame(event); const p = OutcomeTemplateDefaultGetRequestSchema.safeParse(raw); return p.success ? outcomeTemplateService?.getDefault(p.data.kind) ?? null : null; } catch { return null; }
  });
  ipcMain.handle('outcomes:template-defaults:set', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = OutcomeDefaultTemplateSetRequestSchema.safeParse(raw);
      if (!p.success || !outcomeTemplateService) return false;
      outcomeTemplateService.setDefault(p.data.kind, p.data.templateId);
      return true;
    } catch { return false; }
  });
  ipcMain.handle('outcomes:template:save', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const p = PptTemplateSaveRequestSchema.safeParse(raw);
      if (!p.success || !outcomeTemplateService) return null;
      return outcomeTemplateService.save({ kind: 'ppt', name: p.data.name, definition: p.data.definition });
    } catch { return null; }
  });
  ipcMain.handle('outcomes:template:list', (event) => {
    try { requireRendererMainFrame(event); return outcomeTemplateService?.list('ppt') ?? []; } catch { return []; }
  });
  ipcMain.handle('outcomes:generation-skill:save',(event,raw:unknown)=>{try{requireRendererMainFrame(event);const p=PptGenerationSkillSaveRequestSchema.safeParse(raw);if(!p.success||!store)return null;const now=Date.now();const value=PptGenerationSkillSchema.parse({id:'ppt-skill-'+randomUUID(),...p.data});store.raw.prepare('INSERT INTO outcome_templates (id,name,kind,definition_json,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(value.id,value.name,'ppt_generation_skill',JSON.stringify(value),now,now);return value;}catch{return null;}});
  ipcMain.handle('outcomes:generation-skill:list',(event)=>{try{requireRendererMainFrame(event);return (store?.raw.prepare("SELECT definition_json FROM outcome_templates WHERE kind = 'ppt_generation_skill' ORDER BY updated_at DESC").all() as Array<{definition_json:string}>??[]).flatMap(row=>{try{const p=PptGenerationSkillSchema.safeParse(JSON.parse(row.definition_json));return p.success?[p.data]:[];}catch{return[];}});}catch{return[];}});
  ipcMain.handle('outcomes:ppt:generation:execute', async (event, raw: unknown) => {
    try { requireRendererMainFrame(event); } catch {
      return PptGenerationResultSchema.parse({ status: 'error', code: 'generation_unavailable', message: 'PPT 生成服务当前不可用。', answer: '', sources: [], diagnostics: [{ code: 'generation_unavailable', message: '未授权的渲染进程请求 PPT 生成。' }] });
    }
    if (runtimeShutdown.isDraining()) return PptGenerationResultSchema.parse({ status: 'error', code: 'generation_unavailable', message: '应用正在关闭，PPT 生成暂不可用。', answer: '', sources: [], diagnostics: [{ code: 'application_shutting_down', message: '应用正在关闭。' }] });
    const parsed = PptGenerationExecuteRequestSchema.safeParse(raw);
    if (!parsed.success) return PptGenerationResultSchema.parse({ status: 'error', code: 'invalid_request', message: 'PPT 生成请求无效。', answer: '', sources: [], diagnostics: [{ code: 'invalid_request', message: '请求未通过 PPT Generation Skill 契约校验。' }] });
    const requestRepository = outcomeRepository;
    const requestAgentLoop = agentLoop;
    const requestProvider = provider;
    const requestStore = store;
    const requestRuntimeGeneration = runtimeGeneration;
    if (!requestRepository || !requestStore) return PptGenerationResultSchema.parse({ status: 'error', code: 'generation_unavailable', message: 'PPT 生成服务尚未初始化，请重新打开应用后重试。', answer: '', sources: [], diagnostics: [{ code: 'generation_unavailable', message: '成果仓库或存储尚未初始化。' }] });
    const projectRuntime = resolveProjectOutcomeProvider(parsed.data.projectId);
    if (projectRuntime.status !== 'ready') return PptGenerationResultSchema.parse({ status: 'error', code: 'generation_provider_unavailable', message: '当前项目没有可用的模型运行时；项目级 Provider 覆盖未降级到全局模型。', answer: '', sources: [], diagnostics: [{ code: 'generation_provider_unavailable', message: `项目 Provider 运行时不可用：${projectRuntime.reason}。` }] });
    const skillRow = requestStore.raw.prepare("SELECT definition_json FROM outcome_templates WHERE id = ? AND kind = 'ppt_generation_skill'").get(parsed.data.generationSkillId) as { definition_json: string } | undefined;
    let skill: ReturnType<typeof PptGenerationSkillSchema.parse>;
    try { if (!skillRow) throw new Error('missing'); skill = PptGenerationSkillSchema.parse(JSON.parse(skillRow.definition_json)); } catch {
      return PptGenerationResultSchema.parse({ status: 'error', code: 'generation_skill_not_found', message: '所选 PPT 生成技能不存在或内容无效。', answer: '', sources: [], diagnostics: [{ code: 'generation_skill_not_found', message: '主进程未能加载所选 PPT 生成技能。' }] });
    }
    let template: ReturnType<typeof PptTemplateSchema.parse> | null = null;
    if (parsed.data.templateId) {
      const templateRow = requestStore.raw.prepare("SELECT id,name,definition_json,created_at,updated_at FROM outcome_templates WHERE id = ? AND kind = 'ppt'").get(parsed.data.templateId) as { id: string; name: string; definition_json: string; created_at: number; updated_at: number } | undefined;
      try { if (!templateRow) throw new Error('missing'); template = PptTemplateSchema.parse({ id: templateRow.id, name: templateRow.name, definition: JSON.parse(templateRow.definition_json), createdAt: templateRow.created_at, updatedAt: templateRow.updated_at }); } catch {
        return PptGenerationResultSchema.parse({ status: 'error', code: 'template_not_found', message: '所选 PPT 模板不存在或内容无效。', answer: '', sources: [], diagnostics: [{ code: 'template_not_found', message: '主进程未能加载所选 PPT 模板。' }] });
      }
    }
    const tracked = trackEphemeralOperation(runtimeShutdown, {
      id: `outcome-ppt:${randomUUID()}`,
      rejection: PptGenerationResultSchema.parse({
        status: 'error', code: 'application_shutting_down', message: '应用正在关闭，PPT 生成暂不可用。', answer: '', sources: [],
        diagnostics: [{ code: 'application_shutting_down', message: '应用正在关闭。' }],
      }),
    });
    if (!tracked.admitted) return tracked.rejection;
    try {
      return await new OutcomePptGenerationService({
        repository: requestRepository,
        agentLoop: projectRuntime.agentLoop,
        modelName: projectRuntime.binding.model,
        providerProfileBinding: projectRuntime.binding,
        projectContext: new OutcomeProjectContextService(requestRepository, { read: readOutcomeProjectMetis }),
        skill,
        template,
        signal: tracked.signal,
        resolveBehaviorPrompt: (promptId, outcomeId) => officePromptProfileService?.resolveForBasePrompt(promptId, outcomeId ?? null) ?? artifactPromptService?.resolve(promptId) ?? null,
        getGlobalPrompt: (officeKind, outcomeId) => officePromptProfileService?.resolveGlobal(officeKind, outcomeId ?? null) ?? null,
        isRuntimeCurrent: () => runtimeGeneration === requestRuntimeGeneration
          && agentLoop === requestAgentLoop
          && provider === requestProvider,
      }).execute(parsed.data);
    } finally {
      tracked.cleanup();
    }
  });
  ipcMain.handle('outcomes:media:import',async(event,raw:unknown)=>{try{const window=requireRendererMainFrame(event);const p=OutcomeMediaImportRequestSchema.safeParse(raw);if(!p.success||!outcomeMedia)return null;const selected=await dialog.showOpenDialog(window,{properties:['openFile'],filters:[{name:'成果文件',extensions:['pdf','xlsx','xlsm','png','jpg','jpeg','svg']}]});return selected.canceled||!selected.filePaths[0]?null:await outcomeMedia.importFromDialog(p.data.projectId,p.data.outcomeId,selected.filePaths[0]);}catch{return null;}});
  ipcMain.handle('outcomes:media:read',async(event,raw:unknown)=>{try{requireRendererMainFrame(event);const p=OutcomeMediaReadRequestSchema.safeParse(raw);return p.success&&outcomeMedia?await outcomeMedia.readDataUrl(p.data.projectId,p.data.outcomeId,p.data.mediaId)??null:null;}catch{return null;}});
  // Standalone SVG export: re-validates ownership and the safe-SVG contract at
  // every boundary, then writes a defensive byte copy through the roundtrip check.
  ipcMain.handle('outcomes:media:export-svg', async (event, raw: unknown) => {
    try {
      const window = requireRendererMainFrame(event);
      const parsed = OutcomeMediaReadRequestSchema.safeParse(raw);
      if (!parsed.success) return OutcomeMediaSvgExportResultSchema.parse({ ok: false, code: 'invalid_request', message: 'SVG 导出请求无效。' });
      if (!outcomeRepository || !outcomeMedia) return OutcomeMediaSvgExportResultSchema.parse({ ok: false, code: 'outcomes_unavailable', message: '成果媒体服务尚未初始化。' });
      if (!outcomeRepository.has(parsed.data.projectId, parsed.data.outcomeId)) return OutcomeMediaSvgExportResultSchema.parse({ ok: false, code: 'outcome_not_found', message: '当前成果不存在或不属于当前项目。' });
      const bytes = await outcomeMedia.readStandaloneSvg(parsed.data.projectId, parsed.data.outcomeId, parsed.data.mediaId);
      if (!bytes) return OutcomeMediaSvgExportResultSchema.parse({ ok: false, code: 'svg_not_exportable', message: '该媒体不存在、不属于当前成果或不是可导出的安全 SVG。' });
      let exported;
      try { exported = exportStandaloneSvg(bytes); } catch { return OutcomeMediaSvgExportResultSchema.parse({ ok: false, code: 'svg_not_exportable', message: '该媒体未通过安全 SVG 导出校验。' }); }
      const selected = await dialog.showSaveDialog(window, { defaultPath: 'image.svg', filters: [{ name: 'SVG 图像', extensions: ['svg'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] });
      if (selected.canceled || !selected.filePath) return OutcomeMediaSvgExportResultSchema.parse({ ok: false, code: 'cancelled', message: '已取消 SVG 导出。' });
      const filePath = /\.svg$/iu.test(selected.filePath) ? selected.filePath : `${selected.filePath}.svg`;
      try {
        await fs.promises.writeFile(filePath, roundTripStandaloneSvg(exported));
        return OutcomeMediaSvgExportResultSchema.parse({ ok: true, fileName: path.basename(filePath) });
      } catch { return OutcomeMediaSvgExportResultSchema.parse({ ok: false, code: 'svg_write_failed', message: 'SVG 文件写入失败。' }); }
    } catch { return OutcomeMediaSvgExportResultSchema.parse({ ok: false, code: 'svg_write_failed', message: 'SVG 导出没有完成。' }); }
  });
  // DOCX import is preview-only until the renderer explicitly commits media and saves a version.
  ipcMain.handle('outcomes:word:templateStyle:parse', async (event) => {
    try {
      const window = requireRendererMainFrame(event);
      const selected = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Word 模板', extensions: ['docx'] }] });
      if (selected.canceled || !selected.filePaths[0]) return { ok: false as const, code: 'cancelled' };
      const filePath = selected.filePaths[0]!;
      const bytes = await fs.promises.readFile(filePath);
      if (bytes.length > 20 * 1024 * 1024) return { ok: false as const, code: 'file_too_large', message: '模板文件超过 20MB 上限。' };
      const parsed = parseWordTemplateStyle(bytes);
      return { ok: true as const, fileName: path.basename(filePath), config: parsed.config, recognized: parsed.recognized, unrecognized: parsed.unrecognized };
    } catch (error) {
      return { ok: false as const, code: 'parse_failed', message: `无法解析该模板：${error instanceof Error ? error.message : String(error)}` };
    }
  });
  // 「从投稿要求生成排版」（2026-09-01）：确定性规则引擎优先，AI 只兜底引擎判不清的句子，
  // 且每条 AI 规则的 evidence 必须是原文逐字片段（空白归一化），否则丢弃——防模型编造排版要求。
  ipcMain.handle('outcomes:word:formattingFromText', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsedInput = z.object({ text: z.string().min(20).max(20_000) }).safeParse(raw);
      if (!parsedInput.success) return { ok: false as const, code: 'invalid_request', message: '请提供 20-20000 字的投稿要求/排版规范文本。' };
      const text = parsedInput.data.text;
      const deterministic = parseGuidelineFormatting(text);
      if (!agentLoop) {
        return { ok: true as const, source: 'deterministic', config: deterministic.config, matched: deterministic.matched.map((item) => item.rule), unclear: deterministic.unclear };
      }
      const deterministicFields = new Set<string>(['page']);
      if (deterministic.config.page) for (const key of Object.keys(deterministic.config.page)) deterministicFields.add(`page.${key}`);
      if (deterministic.config.body) for (const key of Object.keys(deterministic.config.body)) deterministicFields.add(`body.${key}`);
      for (const [level, style] of Object.entries(deterministic.config.headings ?? {})) {
        for (const key of Object.keys(style ?? {})) deterministicFields.add(`headings.${level}.${key}`);
      }
      const aiPrompt = [
        '你是学术论文排版规范解析助手。下面是期刊投稿要求/论文格式规范的原文。请把其中可执行的排版规则解析为 JSON 数组。',
        '要求：',
        '1. 只输出 JSON 数组，不要解释或 Markdown 围栏。',
        '2. 每个元素结构：{ "target": "body|heading1|heading2|heading3|heading4|heading5|heading6|page", "field": "fontFamily|fontSizePt|align|lineSpacing|firstLineIndentChars|marginTopCm|marginBottomCm|marginLeftCm|marginRightCm|paper", "value": 字符串或数字, "evidence": "支撑该规则的原文逐字片段" }。',
        '3. field 与 value 对应关系：fontFamily=字体名(字符串)；fontSizePt=字号磅值(5-72数字，中文字号换算：初号42 小初36 一号26 小一24 二号22 小二18 三号16 小三15 四号14 小四12 五号10.5 小五9 六号7.5 小六6.5 七号5.5 八号5)；align=left|center|right|justify；lineSpacing=行距倍数(0.5-4数字)；firstLineIndentChars=首行缩进字符数；marginXXXCm=页边距厘米值；paper=A4|Letter。',
        '4. evidence 必须是原文中逐字存在的片段（可含标点），找不到原文依据的规则不要输出。普通内容要求（如摘要字数、参考文献格式）不是排版规则，不要输出。',
        `原文：\n${text}`,
      ].join('\n');
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `outcomes:formattingFromText:${Date.now().toString(36)}`,
        rejection: { ok: false as const, code: 'application_shutting_down' },
      });
      if (!tracked.admitted) return tracked.rejection;
      try {
        const answer = await runEphemeralChatTurn({
          agentLoop,
          sessionId: `word-formatting-${Date.now().toString(36)}`,
          messages: [{ role: 'user', content: '请按系统指令解析该排版规范。' }],
          requestId: `word_formatting_${Date.now().toString(36)}`,
          maxTurns: 1,
          allowedTools: [],
          skillPrompt: aiPrompt,
          signal: tracked.signal,
        });
        if (answer.status !== 'completed') {
          return { ok: true as const, source: 'deterministic', config: deterministic.config, matched: deterministic.matched.map((item) => item.rule), unclear: deterministic.unclear, note: `AI 兜底未完成（${answer.status}），结果仅含确定性规则。` };
        }
        const normalizedText = text.replace(/\s+/gu, ' ');
        const merged = JSON.parse(JSON.stringify(deterministic.config)) as MutableFormattingDraft;
        const matchedRules = deterministic.matched.map((item) => item.rule);
        let aiAccepted = 0;
        let aiRejected = 0;
        try {
          const jsonText = answer.answer.slice(answer.answer.indexOf('['), answer.answer.lastIndexOf(']') + 1);
          const rules = z.array(z.strictObject({
            target: z.enum(['body', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'page']),
            field: z.enum(['fontFamily', 'fontSizePt', 'align', 'lineSpacing', 'firstLineIndentChars', 'marginTopCm', 'marginBottomCm', 'marginLeftCm', 'marginRightCm', 'paper']),
            value: z.union([z.string(), z.number()]),
            evidence: z.string(),
          })).parse(JSON.parse(jsonText));
          for (const rule of rules) {
            const evidence = rule.evidence.replace(/\s+/gu, ' ').trim();
            if (!evidence || !normalizedText.includes(evidence)) { aiRejected += 1; continue; }
            const key = rule.target === 'page' ? `page.${rule.field}` : rule.target === 'body' ? `body.${rule.field}` : `headings.${rule.target.slice('heading'.length)}.${rule.field}`;
            if (deterministicFields.has(key)) continue; // 确定性引擎已有的字段不覆盖
            const level = rule.target.startsWith('heading') ? Number(rule.target.slice('heading'.length)) : 0;
            if (rule.target === 'page') {
              merged.page ??= {};
              if (rule.field === 'paper' && (rule.value === 'A4' || rule.value === 'Letter')) merged.page.paper = rule.value;
              else if (rule.field.endsWith('Cm') && typeof rule.value === 'number' && rule.value > 0 && rule.value <= 10) merged.page[rule.field] = rule.value;
              else { aiRejected += 1; continue; }
            } else if (rule.target === 'body') {
              merged.body ??= {};
              if (!setFormattingField(merged.body, rule.field, rule.value)) { aiRejected += 1; continue; }
            } else if (level >= 1 && level <= 6) {
              merged.headings ??= {};
              const slot = { ...(merged.headings[level as 1 | 2 | 3 | 4 | 5 | 6] ?? {}) };
              if (!setFormattingField(slot, rule.field, rule.value)) { aiRejected += 1; continue; }
              merged.headings[level as 1 | 2 | 3 | 4 | 5 | 6] = slot;
            } else { aiRejected += 1; continue; }
            deterministicFields.add(key);
            matchedRules.push(`${rule.target === 'body' ? '正文' : rule.target === 'page' ? '页面' : `${level} 级标题`}：${rule.field}=${String(rule.value)}（AI 解析）`);
            aiAccepted += 1;
          }
        } catch {
          return { ok: true as const, source: 'deterministic', config: merged, matched: matchedRules, unclear: deterministic.unclear, note: 'AI 兜底输出未通过契约校验，结果仅含确定性规则。' };
        }
        return { ok: true as const, source: aiAccepted > 0 ? 'ai_assisted' : 'deterministic', config: merged as unknown as WordFormattingConfig, matched: matchedRules, unclear: deterministic.unclear, note: aiRejected > 0 ? `${aiRejected} 条 AI 规则因缺少原文依据或数值越界被丢弃。` : undefined };
      } finally {
        tracked.cleanup();
      }
    } catch (error) {
      return { ok: false as const, code: 'parse_failed', message: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('outcomes:word:docx:import', async (event, raw: unknown) => {
    try {
      const window = requireRendererMainFrame(event);
      pruneImportSessions();
      const parsed = OutcomeWordDocxImportRequestSchema.safeParse(raw);
      if (!parsed.success) return OutcomeWordDocxImportResultSchema.parse({ ok: false, code: 'invalid_request', message: 'DOCX 导入请求无效。', warnings: [] });
      if (!outcomeRepository) return OutcomeWordDocxImportResultSchema.parse({ ok: false, code: 'outcomes_unavailable', message: '成果运行服务尚未初始化。', warnings: [] });
      try { outcomeRepository.list(parsed.data.projectId, ''); } catch { return OutcomeWordDocxImportResultSchema.parse({ ok: false, code: 'project_not_found', message: '当前项目不存在或不可用。', warnings: [] }); }
      const selected = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Word 文档', extensions: ['docx'] }] });
      if (selected.canceled || !selected.filePaths[0]) return OutcomeWordDocxImportResultSchema.parse({ ok: false, code: 'cancelled', message: '已取消 DOCX 导入。', warnings: [] });
      try {
        const filePath = selected.filePaths[0];
        const bytes = await fs.promises.readFile(filePath);
        const imported = await new OutcomeWordDocxService().importBufferV2(bytes);
        const importToken = `docx-import-${randomUUID()}`;
        wordDocxImportSessions.set(importToken, { projectId: parsed.data.projectId, filePath, fileName: path.basename(filePath), bytes, document: imported.document, createdAt: Date.now(), reservedOutcome: false, mediaIds: [] });
        return OutcomeWordDocxImportResultSchema.parse({ ok: true, fileName: path.basename(filePath), importToken, document: imported.document, preview: imported.preview, warnings: imported.warnings });
      } catch {
        return OutcomeWordDocxImportResultSchema.parse({ ok: false, code: 'docx_read_failed', message: '无法读取该 DOCX；文件可能损坏或含有当前版本不支持的压缩/OOXML 结构。', warnings: [] });
      }
    } catch { return OutcomeWordDocxImportResultSchema.parse({ ok: false, code: 'docx_read_failed', message: 'DOCX 导入没有完成。', warnings: [] }); }
  });
  ipcMain.handle('outcomes:word:docx:import:commitMedia', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = OutcomeWordDocxImportCommitRequestSchema.safeParse(raw);
      if (!parsed.success) return OutcomeWordDocxImportCommitResultSchema.parse({ ok: false, code: 'invalid_request', message: 'DOCX 导入媒体提交请求无效。' });
      if (!outcomeRepository || !outcomeMedia) return OutcomeWordDocxImportCommitResultSchema.parse({ ok: false, code: 'outcomes_unavailable', message: '成果媒体服务尚未初始化。' });
      const session = wordDocxImportSessions.get(parsed.data.importToken);
      if (!session || session.projectId !== parsed.data.projectId || JSON.stringify(session.document) !== JSON.stringify(parsed.data.document) || (session.outcomeId && parsed.data.outcomeId && session.outcomeId !== parsed.data.outcomeId)) return OutcomeWordDocxImportCommitResultSchema.parse({ ok: false, code: 'invalid_request', message: 'DOCX 导入令牌无效、已过期、文档已被篡改或已绑定其他成果。' });
      if (parsed.data.outcomeId && !outcomeRepository.has(parsed.data.projectId, parsed.data.outcomeId)) return OutcomeWordDocxImportCommitResultSchema.parse({ ok: false, code: 'outcome_not_found', message: '当前成果不存在或不属于当前项目。' });
      const outcomeId = parsed.data.outcomeId ?? session.outcomeId ?? `out-${randomUUID()}`;
      if (session.committedDocument && session.outcomeId === outcomeId) return OutcomeWordDocxImportCommitResultSchema.parse({ ok: true, document: session.committedDocument, outcomeId });
      const reserved = !parsed.data.outcomeId && !session.outcomeId;
      if (reserved) {
        outcomeRepository.reserve({ projectId: parsed.data.projectId, outcomeId, categoryId: null, title: session.fileName.replace(/\.docx$/iu, '').trim() || '导入 Word 文档', kind: 'word' });
        session.reservedOutcome = true;
      }
      const createdMedia: string[] = [];
      try {
        const committed = await new OutcomeWordDocxService().commitImportedMedia(session.bytes, parsed.data.document, async (image) => {
          const media = await outcomeMedia!.persistGenerated(parsed.data.projectId, outcomeId, image.bytes, image.mediaType, image.displayName);
          if (media) createdMedia.push(media.id);
          return media ? { id: media.id, mediaType: image.mediaType, displayName: media.displayName } : undefined;
        }, async (mediaIds) => outcomeMedia!.removeGenerated(parsed.data.projectId, outcomeId, mediaIds));
        session.mediaIds.push(...createdMedia);
        session.outcomeId = outcomeId;
        session.committedDocument = committed;
        // GenOffice byte-preserving anchor: keep the original package and pin
        // its media id on the document so later exports re-align against it.
        if (GENOFFICE_ENABLED && outcomeMedia) {
          const archiveMedia = await outcomeMedia.persistArchive(parsed.data.projectId, outcomeId, session.bytes, 'docx', path.basename(session.filePath)).catch(() => undefined);
          if (archiveMedia) {
            createdMedia.push(archiveMedia.id);
            session.mediaIds.push(archiveMedia.id);
            (committed.page as Record<string, unknown>)._originalArchiveMediaId = archiveMedia.id;
            session.committedDocument = committed;
          }
        }
        return OutcomeWordDocxImportCommitResultSchema.parse({ ok: true, document: committed, outcomeId });
      } catch {
        await outcomeMedia.removeGenerated(parsed.data.projectId, outcomeId, createdMedia);
        if (reserved) outcomeRepository.deleteReserved(parsed.data.projectId, outcomeId);
        return OutcomeWordDocxImportCommitResultSchema.parse({ ok: false, code: 'docx_media_commit_failed', message: 'DOCX 图片未能写入当前成果的私有媒体区；当前成果没有被修改。' });
      }
    } catch { return OutcomeWordDocxImportCommitResultSchema.parse({ ok: false, code: 'docx_media_commit_failed', message: 'DOCX 导入媒体提交没有完成。' }); }
  });
  ipcMain.handle('outcomes:word:docx:export', async (event, raw: unknown) => {
    try {
      const window = requireRendererMainFrame(event);
      const parsed = OutcomeWordDocxExportRequestSchema.safeParse(raw);
      if (!parsed.success) return OutcomeWordDocxExportResultSchema.parse({ ok: false, code: 'invalid_request', message: 'DOCX 导出请求无效。', warnings: [] });
      if (!outcomeRepository) return OutcomeWordDocxExportResultSchema.parse({ ok: false, code: 'outcomes_unavailable', message: '成果运行服务尚未初始化。', warnings: [] });
      let detail: ReturnType<OutcomeRepository['get']>;
      try { detail = outcomeRepository.get(parsed.data.projectId, parsed.data.outcomeId, parsed.data.version); } catch { return OutcomeWordDocxExportResultSchema.parse({ ok: false, code: 'project_not_found', message: '当前项目不存在或不可用。', warnings: [] }); }
      if (!detail) return OutcomeWordDocxExportResultSchema.parse({ ok: false, code: 'outcome_not_found', message: '未找到要导出的成果版本。', warnings: [] });
      if (detail.version.content.type !== 'word') return OutcomeWordDocxExportResultSchema.parse({ ok: false, code: 'outcome_not_word', message: '只有 Word 成果可以导出为 DOCX。', warnings: [] });
      const baseName = detail.outcome.title.replace(/[\\/:*?"<>|]+/gu, '-').trim() || 'outcome';
      // E2E seam: when explicitly set, exports bypass the native save dialog and
      // write into the given directory so automation can assert the real bytes.
      const e2eExportDir = process.env.METIS_E2E_EXPORT_DIR;
      const selected = e2eExportDir
        ? { canceled: false as const, filePath: path.join(e2eExportDir, `${baseName}.docx`) }
        : await dialog.showSaveDialog(window, { defaultPath: `${baseName}.docx`, filters: [{ name: 'Word 文档', extensions: ['docx'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] });
      if (selected.canceled || !selected.filePath) return OutcomeWordDocxExportResultSchema.parse({ ok: false, code: 'cancelled', message: '已取消 DOCX 导出。', warnings: [] });
      const filePath = /\.docx$/iu.test(selected.filePath) ? selected.filePath : `${selected.filePath}.docx`;
      try {
        const scopedMedia = outcomeMedia;
        const exported = await new OutcomeWordDocxService({
          resolveManagedImage: async (mediaId) => scopedMedia?.readImageForWordDocxExport(
            parsed.data.projectId,
            parsed.data.outcomeId,
            mediaId,
          ),
          resolveOriginalArchive: async (mediaId) => scopedMedia?.readArchive(
            parsed.data.projectId,
            parsed.data.outcomeId,
            mediaId,
          ),
        }).exportFile(filePath, detail.version.content);
        return OutcomeWordDocxExportResultSchema.parse({ ok: true, fileName: path.basename(filePath), warnings: exported.warnings });
      } catch { return OutcomeWordDocxExportResultSchema.parse({ ok: false, code: 'docx_write_failed', message: 'DOCX 文件写入失败。', warnings: [] }); }
    } catch { return OutcomeWordDocxExportResultSchema.parse({ ok: false, code: 'docx_write_failed', message: 'DOCX 导出没有完成。', warnings: [] }); }
  });
  // 生成物预览栏「导出为 Word」（2026-08-31 刘总要求）：预览内容（Markdown）
  // 经结构化转换从零构建 DOCX，不依赖既有成果/模板归档。返回诚实状态文案。
  ipcMain.handle('outcomes:word:docx:exportMarkdown', async (event, raw: unknown) => {
    try {
      const window = requireRendererMainFrame(event);
      const request = raw as { title?: unknown; markdown?: unknown };
      const title = typeof request?.title === 'string' && request.title.trim() ? request.title.trim() : '生成物';
      const markdown = typeof request?.markdown === 'string' ? request.markdown : '';
      if (!markdown.trim()) return { ok: false, code: 'empty_markdown', message: '预览内容为空，没有可导出的正文。' };
      const { markdownToWordDocument } = await import('../engine/export/MarkdownToWordDocument.js');
      const document = markdownToWordDocument(markdown);
      if (document.blocks.length === 0) return { ok: false, code: 'empty_document', message: '预览内容没有可转换的正文结构。' };
      const baseName = title.replace(/[\\/:*?"<>|]+/gu, '-').trim().slice(0, 120) || 'artifact';
      const e2eExportDir = process.env.METIS_E2E_EXPORT_DIR;
      const selected = e2eExportDir
        ? { canceled: false as const, filePath: path.join(e2eExportDir, `${baseName}.docx`) }
        : await dialog.showSaveDialog(window, { defaultPath: `${baseName}.docx`, filters: [{ name: 'Word 文档', extensions: ['docx'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] });
      if (selected.canceled || !selected.filePath) return { ok: false, code: 'cancelled', message: '已取消导出。' };
      const filePath = /\.docx$/iu.test(selected.filePath) ? selected.filePath : `${selected.filePath}.docx`;
      try {
        const exported = await new OutcomeWordDocxService({}).exportFile(filePath, document);
        return { ok: true, fileName: path.basename(filePath), warnings: exported.warnings };
      } catch (writeError) {
        return { ok: false, code: 'docx_write_failed', message: `DOCX 文件写入失败：${writeError instanceof Error ? writeError.message : String(writeError)}` };
      }
    } catch (error) {
      return { ok: false, code: 'docx_export_failed', message: `DOCX 导出没有完成：${error instanceof Error ? error.message : String(error)}` };
    }
  });
  // PPTX import is deliberately DB-free. The short-lived token keeps the
  // selected package in the main process until an explicit renderer save.
  ipcMain.handle('outcomes:pptx:import', async (event, raw: unknown) => {
    try {
      const window = requireRendererMainFrame(event);
      prunePptxImportSessions();
      const parsed = OutcomePptxImportRequestSchema.safeParse(raw);
      if (!parsed.success) return OutcomePptxImportResultSchema.parse({ ok: false, code: 'invalid_request', message: 'PPTX 导入请求无效。', warnings: [] });
      if (!outcomeRepository) return OutcomePptxImportResultSchema.parse({ ok: false, code: 'outcomes_unavailable', message: '成果运行服务尚未初始化。', warnings: [] });
      try { outcomeRepository.list(parsed.data.projectId, ''); } catch { return OutcomePptxImportResultSchema.parse({ ok: false, code: 'project_not_found', message: '当前项目不存在或不可用。', warnings: [] }); }
      const selected = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'PowerPoint 演示文稿', extensions: ['pptx'] }] });
      if (selected.canceled || !selected.filePaths[0]) return OutcomePptxImportResultSchema.parse({ ok: false, code: 'cancelled', message: '已取消 PPTX 导入。', warnings: [] });
      try {
        const filePath = selected.filePaths[0];
        const bytes = await fs.promises.readFile(filePath);
        const imported = await new OutcomePptxService().importBufferV2(bytes);
        const importToken = `pptx-import-${randomUUID()}`;
        pptxImportSessions.set(importToken, { projectId: parsed.data.projectId, filePath, fileName: path.basename(filePath), bytes, document: imported.document, createdAt: Date.now(), reservedOutcome: false, mediaIds: [] });
        return OutcomePptxImportResultSchema.parse({ ok: true, fileName: path.basename(filePath), importToken, document: imported.document, warnings: imported.warnings });
      } catch { return OutcomePptxImportResultSchema.parse({ ok: false, code: 'pptx_read_failed', message: '无法读取该 PPTX；文件可能损坏或含有当前版本不支持的压缩/PresentationML 结构。', warnings: [] }); }
    } catch { return OutcomePptxImportResultSchema.parse({ ok: false, code: 'pptx_read_failed', message: 'PPTX 导入没有完成。', warnings: [] }); }
  });
  ipcMain.handle('outcomes:pptx:import:commitMedia', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = OutcomePptxImportCommitRequestSchema.safeParse(raw);
      if (!parsed.success) return OutcomePptxImportCommitResultSchema.parse({ ok: false, code: 'invalid_request', message: 'PPTX 导入媒体提交请求无效。' });
      if (!outcomeRepository || !outcomeMedia) return OutcomePptxImportCommitResultSchema.parse({ ok: false, code: 'outcomes_unavailable', message: '成果媒体服务尚未初始化。' });
      const session = pptxImportSessions.get(parsed.data.importToken);
      if (!session || session.projectId !== parsed.data.projectId || JSON.stringify(session.document) !== JSON.stringify(parsed.data.document) || (session.outcomeId && parsed.data.outcomeId && session.outcomeId !== parsed.data.outcomeId)) return OutcomePptxImportCommitResultSchema.parse({ ok: false, code: 'invalid_request', message: 'PPTX 导入令牌无效、已过期、文档已被篡改或已绑定其他成果。' });
      if (parsed.data.outcomeId && !outcomeRepository.has(parsed.data.projectId, parsed.data.outcomeId)) return OutcomePptxImportCommitResultSchema.parse({ ok: false, code: 'outcome_not_found', message: '当前成果不存在或不属于当前项目。' });
      const outcomeId = parsed.data.outcomeId ?? session.outcomeId ?? `out-${randomUUID()}`;
      if (session.committedDocument && session.outcomeId === outcomeId) return OutcomePptxImportCommitResultSchema.parse({ ok: true, document: session.committedDocument, outcomeId });
      const reserved = !parsed.data.outcomeId && !session.outcomeId;
      if (reserved) { outcomeRepository.reserve({ projectId: parsed.data.projectId, outcomeId, categoryId: null, title: session.fileName.replace(/\.pptx$/iu, '').trim() || '导入 PPT 演示文稿', kind: 'ppt' }); session.reservedOutcome = true; }
      const createdMedia: string[] = [];
      try {
        const committed = await new OutcomePptxService().commitImportedMediaBuffer(session.bytes, parsed.data.document, async (image) => {
          const media = await outcomeMedia!.persistGenerated(parsed.data.projectId, outcomeId, image.bytes, image.mediaType, image.displayName);
          if (media) createdMedia.push(media.id);
          return media ? { id: media.id, mediaType: image.mediaType, displayName: media.displayName } : undefined;
        });
        session.mediaIds.push(...createdMedia);
        session.outcomeId = outcomeId;
        session.committedDocument = committed;
        const archiveMedia = await outcomeMedia.persistArchive(parsed.data.projectId, outcomeId, session.bytes, 'pptx', session.fileName).catch(() => undefined);
        if (archiveMedia) {
          session.mediaIds.push(archiveMedia.id);
          committed.theme = { ...committed.theme, [GENOFFICE_PPTX_ORIGINAL_ARCHIVE_KEY]: archiveMedia.id };
          session.committedDocument = committed;
        }
        return OutcomePptxImportCommitResultSchema.parse({ ok: true, document: committed, outcomeId });
      } catch {
        await outcomeMedia.removeGenerated(parsed.data.projectId, outcomeId, createdMedia);
        if (reserved) outcomeRepository.deleteReserved(parsed.data.projectId, outcomeId);
        return OutcomePptxImportCommitResultSchema.parse({ ok: false, code: 'pptx_media_commit_failed', message: 'PPTX 图片未能写入当前成果的私有媒体区；当前成果没有被修改。' });
      }
    } catch { return OutcomePptxImportCommitResultSchema.parse({ ok: false, code: 'pptx_media_commit_failed', message: 'PPTX 导入媒体提交没有完成。' }); }
  });
  ipcMain.handle('outcomes:pptx:export', async (event, raw: unknown) => {
    try {
      const window = requireRendererMainFrame(event);
      const parsed = OutcomePptxExportRequestSchema.safeParse(raw);
      if (!parsed.success) return OutcomePptxExportResultSchema.parse({ ok: false, code: 'invalid_request', message: 'PPTX 导出请求无效。', warnings: [] });
      if (!outcomeRepository) return OutcomePptxExportResultSchema.parse({ ok: false, code: 'outcomes_unavailable', message: '成果运行服务尚未初始化。', warnings: [] });
      let detail: ReturnType<OutcomeRepository['get']>;
      try { detail = outcomeRepository.get(parsed.data.projectId, parsed.data.outcomeId, parsed.data.version); } catch { return OutcomePptxExportResultSchema.parse({ ok: false, code: 'project_not_found', message: '当前项目不存在或不可用。', warnings: [] }); }
      if (!detail) return OutcomePptxExportResultSchema.parse({ ok: false, code: 'outcome_not_found', message: '未找到要导出的成果版本。', warnings: [] });
      if (detail.version.content.type !== 'ppt') return OutcomePptxExportResultSchema.parse({ ok: false, code: 'outcome_not_ppt', message: '只有 PPT 成果可以导出为 PPTX。', warnings: [] });
      const baseName = detail.outcome.title.replace(/[\\/:*?"<>|]+/gu, '-').trim() || 'presentation';
      const e2eExportDir = process.env.METIS_E2E_EXPORT_DIR;
      const selected = e2eExportDir
        ? { canceled: false as const, filePath: path.join(e2eExportDir, `${baseName}.pptx`) }
        : await dialog.showSaveDialog(window, { defaultPath: `${baseName}.pptx`, filters: [{ name: 'PowerPoint 演示文稿', extensions: ['pptx'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] });
      if (selected.canceled || !selected.filePath) return OutcomePptxExportResultSchema.parse({ ok: false, code: 'cancelled', message: '已取消 PPTX 导出。', warnings: [] });
      const filePath = /\.pptx$/iu.test(selected.filePath) ? selected.filePath : `${selected.filePath}.pptx`;
      try {
        const scopedMedia = outcomeMedia;
        const exported = await new OutcomePptxService({
          resolveManagedImage: async (reference) => scopedMedia?.readImageForPptxExport(parsed.data.projectId, parsed.data.outcomeId, reference),
          resolveOriginalArchive: async (mediaId) => scopedMedia?.readArchive(parsed.data.projectId, parsed.data.outcomeId, mediaId),
        }).exportFile(filePath, detail.version.content);
        return OutcomePptxExportResultSchema.parse({ ok: true, fileName: path.basename(filePath), warnings: exported.warnings });
      } catch { return OutcomePptxExportResultSchema.parse({ ok: false, code: 'pptx_write_failed', message: 'PPTX 文件写入失败。', warnings: [] }); }
    } catch { return OutcomePptxExportResultSchema.parse({ ok: false, code: 'pptx_write_failed', message: 'PPTX 导出没有完成。', warnings: [] }); }
  });
  ipcMain.handle('outcomes:image-settings:get',(event)=>{try{requireRendererMainFrame(event);return outcomeImage?.getSettings() ?? OutcomeImageSettingsGetResultSchema.parse({ok:false,code:'storage_unavailable'});}catch{return OutcomeImageSettingsGetResultSchema.parse({ok:false,code:'settings_read_failed'});}});
  ipcMain.handle('outcomes:image-settings:set',(event,raw:unknown)=>{try{requireRendererMainFrame(event);if(!outcomeImage)return OutcomeImageSettingsSaveResultSchema.parse({ok:false,code:'storage_unavailable'});return outcomeImage.saveSettings(raw);}catch{return OutcomeImageSettingsSaveResultSchema.parse({ok:false,code:'settings_write_failed'});}});
  ipcMain.handle('outcomes:image:generate',async(event,raw:unknown)=>{try{requireRendererMainFrame(event);if(!outcomeImage)return OutcomeImageGenerateResultSchema.parse({ok:false,code:'image_generation_unconfigured'});return await outcomeImage.generate(raw);}catch{return OutcomeImageGenerateResultSchema.parse({ok:false,code:'image_generation_provider_failed'});}});

  // ── Current Affairs Export ─────────────────────────────────
  ipcMain.handle('ca:research', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const req = CurrentAffairsResearchRequestSchema.safeParse(rawRequest);
      if (!req.success || !caRuntime) return decodeCurrentAffairsResearchResponse(null);
      const { version: _v, operationId, ...rest } = req.data;
      void _v;
      const owner = String(event.sender.id);
      const result = await caRuntime.research(owner, rest);
      return decodeCurrentAffairsResearchResponse({ ...result, version: CA_RUNTIME_CONTRACT_VERSION, operationId });
    } catch { return decodeCurrentAffairsResearchResponse(null); }
  });

  ipcMain.handle('ca:approve', async (event, rawRequest: unknown) => {
    try {
      const invokingWindow = requireRendererMainFrame(event);
      const req = CurrentAffairsApproveRequestSchema.safeParse(rawRequest);
      if (!req.success || !caRuntime) return decodeCurrentAffairsApproveResponse(null);
      const { version: _v, operationId, ...rest } = req.data;
      void _v;
      const owner = String(event.sender.id);
      caOwnerWindows.set(owner, invokingWindow);
      const result = await caRuntime.approve(owner, rest);
      return decodeCurrentAffairsApproveResponse({ ...result, version: CA_RUNTIME_CONTRACT_VERSION, operationId });
    } catch { return decodeCurrentAffairsApproveResponse(null); }
  });

  ipcMain.handle('ca:export', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const req = CurrentAffairsExportRequestSchema.safeParse(rawRequest);
      if (!req.success || !caRuntime) return decodeCurrentAffairsExportResponse(null);
      const { version: _v, operationId, ...rest } = req.data;
      void _v;
      const owner = String(event.sender.id);
      const result = await caRuntime.export(owner, rest);
      return decodeCurrentAffairsExportResponse({ ...result, version: CA_RUNTIME_CONTRACT_VERSION, operationId });
    } catch { return decodeCurrentAffairsExportResponse(null); }
  });

  ipcMain.handle('ca:cancel', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const req = CurrentAffairsCancelRequestSchema.safeParse(rawRequest);
      if (!req.success || !caRuntime) return decodeCurrentAffairsCancelResponse(null);
      const { version: _v, operationId } = req.data;
      void _v;
      const owner = String(event.sender.id);
      let result: ReturnType<typeof caRuntime.cancel>;
      if (req.data.action === 'revoke_approval') {
        result = caRuntime.cancel(owner, {
          action: 'revoke_approval', projectId: req.data.projectId, workflowId: req.data.workflowId,
          receiptId: req.data.receiptId, receiptNonce: req.data.receiptNonce,
          contentDigest: req.data.contentDigest, sourceSnapshotDigest: req.data.sourceSnapshotDigest,
          profileId: req.data.profileId, manifestVersion: req.data.manifestVersion,
        });
      } else {
        result = caRuntime.cancel(owner, { action: 'discard_draft', projectId: req.data.projectId, workflowId: req.data.workflowId });
      }
      return decodeCurrentAffairsCancelResponse({ ...result, version: CA_RUNTIME_CONTRACT_VERSION, operationId });
    } catch { return decodeCurrentAffairsCancelResponse(null); }
  });

  ipcMain.handle('ca:list-sources', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const req = CurrentAffairsListSourcesRequestSchema.safeParse(rawRequest);
      if (!req.success || !researchRepository) return decodeCurrentAffairsListSourcesResponse(null);
      const { projectId } = req.data;
      const now = Date.now();
      const maxSourceAgeDays = 365;
      const srcList = researchRepository.listSources?.(projectId) ?? [];
      const sources = srcList
        .filter(s => s.deletedAt === null) // strict null check, not truthiness
        .filter(s => (s.projectId ?? '') === projectId)
        .map(s => {
          try {
            const adapted = adaptSource(s);
            const base = {
              sourceId: s.id, projectId: s.projectId ?? '', title: s.title,
              kind: adapted?.kind ?? null,
              authors: s.authors ?? [],
              url: sanitizeListUrl(s.externalUrl ?? adapted?.url ?? null),
              contentDigest: s.sourceVersionHash ?? null,
              correctionState: adapted?.correctionState ?? null,
              updatedAt: s.updatedAt,
              publishedAt: adapted?.publishedAt ?? null,
              fetchedAt: adapted?.fetchedAt ?? s.createdAt,
              deleted: false,
            };
            // Main-derived authoritative eligibility (renderer must not recreate)
            const hasHash = !!(base.contentDigest && /^[a-f0-9]{64}$/i.test(base.contentDigest));
            const validKind = adapted !== null && base.kind !== null;
            const cleanCorrection = base.correctionState === 'clean' || base.correctionState === 'corrected';
            const notRetracted = base.correctionState !== 'retracted';
            const fresh = base.fetchedAt !== null && (now - base.fetchedAt) / 86400000 <= maxSourceAgeDays;
            const eligible = hasHash && validKind && cleanCorrection && notRetracted && fresh;

            let reviewStatus: string;
            let reason: string;
            if (!adapted) { reviewStatus = 'untagged'; reason = '缺少 current-affairs:* 标签'; }
            else if (!hasHash) { reviewStatus = 'no_digest'; reason = '缺少 contentDigest'; }
            else if (base.correctionState === 'retracted') { reviewStatus = 'retracted'; reason = '已 retracted'; }
            else if (!cleanCorrection) { reviewStatus = `pending_${base.correctionState}`; reason = `待审核 (${base.correctionState})`; }
            else if (!fresh) { reviewStatus = 'stale'; reason = `来源超过 ${maxSourceAgeDays} 天`; }
            else { reviewStatus = base.correctionState ?? 'clean'; reason = ''; }

            return { ...base, eligible, reviewStatus, reason };
          } catch {
            return null;
          }
        })
        .filter((s): s is NonNullable<typeof s> => s !== null);
      return { ok: true as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sources };
    } catch { return decodeCurrentAffairsListSourcesResponse(null); }
  });

  ipcMain.handle('ca:review-source', async (event, rawRequest: unknown) => {
    const invokingWindow = requireRendererMainFrame(event);
    const req = SourceReviewRequestSchema.safeParse(rawRequest);
    if (!req.success || !researchRepository) return decodeSourceReviewResponse(null);
    try {
      // Verify hash is valid (no magic wildcard)
      if (!/^[a-f0-9]{64}$/i.test(req.data.expectedSourceVersionHash)) {
        return { ok: false as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sourceId: req.data.sourceId, code: 'hash_mismatch' as const };
      }
      const reviewedBy = String(event.sender.id);

      // Native confirmation with canonical repo fields — must have invoking window
      if (!invokingWindow || invokingWindow.isDestroyed()) {
        return { ok: false as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sourceId: req.data.sourceId, code: 'review_failed' as const };
      }
      const src = researchRepository.getSource(req.data.sourceId);
      if (!src || src.deletedAt !== null) {
        return { ok: false as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sourceId: req.data.sourceId, code: src ? 'deleted' as const : 'source_not_found' as const };
      }
      try {
        const canonicalTitle = src.title;
        const canonicalHash = src.sourceVersionHash ?? '(none)';
        const canonicalTime = new Date(src.updatedAt).toISOString();
        const { response } = await dialog.showMessageBox(invokingWindow, {
          type: 'question', title: 'Review Source',
          message: `Review "${canonicalTitle}" as ${req.data.caKind}?`,
          detail: `Canonical hash: ${canonicalHash}\nUpdated: ${canonicalTime}\nCorrection state: ${req.data.correctionState}`,
          buttons: ['Confirm Review', 'Cancel'], defaultId: 1,
        });
        if (response !== 0) {
          return { ok: false as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sourceId: req.data.sourceId, code: 'review_failed' as const };
        }
      } catch {
        return { ok: false as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sourceId: req.data.sourceId, code: 'review_failed' as const };
      }

      const result = researchRepository.reviewCurrentAffairsSource(
        req.data.sourceId,
        {
          projectId: req.data.projectId,
          sourceVersionHash: req.data.expectedSourceVersionHash,
          updatedAt: req.data.expectedUpdatedAt,
        },
        {
          caKind: req.data.caKind,
          correctionState: req.data.correctionState,
          reviewedBy,
          note: req.data.note ?? '',
        },
      );
      if (!result.ok) {
        const codeMap: Record<string, 'source_not_found' | 'cross_project' | 'deleted' | 'hash_mismatch' | 'timestamp_mismatch' | 'review_failed'> = {
          not_found: 'source_not_found',
          source_deleted: 'deleted',
          project_mismatch: 'cross_project',
          hash_mismatch: 'hash_mismatch',
          stale: 'timestamp_mismatch',
        };
        return { ok: false as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sourceId: req.data.sourceId, code: codeMap[result.code] ?? 'review_failed' };
      }
      // Re-read to get metadata.caReviewDigest (FIX498 authoritative) — NEVER fallback
      const reread = researchRepository.getSource(req.data.sourceId);
      const metadata = (reread?.metadata ?? {}) as Record<string, unknown>;
      if (typeof metadata.caReviewDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(metadata.caReviewDigest)) {
        return { ok: false as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sourceId: req.data.sourceId, code: 'review_failed' as const };
      }
      return { ok: true as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sourceId: req.data.sourceId, reviewed: true as const, correctionState: req.data.correctionState, reviewDigest: metadata.caReviewDigest };
    } catch { return { ok: false as const, version: CA_RUNTIME_CONTRACT_VERSION, operationId: req.data.operationId, sourceId: req.data.sourceId, code: 'review_failed' as const }; }
  });

  // ── Session ─────────────────────────────────────────────
  ipcMain.handle('session:create', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const decoded = decodeSessionCreateRequest(rawRequest);
      if (!decoded.ok || !store) return decodeSessionMutationResult(null);
      store.createSession(decoded.value.sessionId, undefined, decoded.value.projectId);
      return decodeSessionMutationResult({ success: true, code: 'created' });
    } catch {
      return decodeSessionMutationResult(null);
    }
  });

  ipcMain.handle('session:list', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const decoded = decodeSessionListRequest(rawRequest);
      if (!decoded.ok || !store) return createSessionListRecovery();
      // 多对话架构(2026-09-04):按 projectId 过滤,归档默认隐藏。
      const filter = decoded.value.projectId
        ? { projectId: decoded.value.projectId, includeArchived: decoded.value.includeArchived === true }
        : decoded.value.includeArchived === true
          ? { includeArchived: true }
          : undefined;
      return decodeLegacySessionList(store.listSessions(200, 0, filter));
    } catch {
      return createSessionListRecovery();
    }
  });

  ipcMain.handle('session:delete', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const decoded = decodeSessionDeleteRequest(rawRequest);
      if (!decoded.ok || !store) return decodeSessionMutationResult(null);
      if (!store.getSession(decoded.value.sessionId)) {
        return decodeSessionMutationResult({ success: false, code: 'not_found' });
      }
      store.deleteSession(decoded.value.sessionId);
      return decodeSessionMutationResult({ success: true, code: 'deleted' });
    } catch {
      return decodeSessionMutationResult(null);
    }
  });

  ipcMain.handle('session:update', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const decoded = decodeSessionUpdateRequest(rawRequest);
      if (!decoded.ok || !store) return decodeSessionMutationResult(null);
      if (!store.getSession(decoded.value.sessionId)) {
        return decodeSessionMutationResult({ success: false, code: 'not_found' });
      }
      const { scenarioId, activeArtifactIds, ...legacyPatch } = decoded.value.patch;
      // 多对话架构(2026-09-04):scenarioId/activeArtifactIds 走正式列;title/archived 维持 metadata 兼容通道。
      const metadataPatch = legacyPatch as Record<string, unknown>;
      if (scenarioId === undefined && activeArtifactIds === undefined) {
        store.updateSession(decoded.value.sessionId, { metadata: metadataPatch });
      } else {
        store.updateSession(decoded.value.sessionId, {
          metadata: metadataPatch,
          ...(scenarioId !== undefined ? { scenarioId } : {}),
          ...(activeArtifactIds !== undefined ? { activeArtifactIds } : {}),
        });
      }
      return decodeSessionMutationResult({ success: true, code: 'updated' });
    } catch {
      return decodeSessionMutationResult(null);
    }
  });

  // ── Artifacts ───────────────────────────────────────────
  // 任务3：域 registrar 迁移——channel/contract/恢复形状不变，注册走 IpcRegistry。
  ipcDomainDisposers.push(registerArtifactIpc(domainIpcContext));

  // ── Messages ────────────────────────────────────────────
  ipcMain.handle('messages:get', (event, rawSessionId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const sessionId = RuntimeIdSchema.parse(rawSessionId);
      const rows = (store?.getMessages(sessionId, undefined, { includeMetadata: true }) ?? []).map(({ role, content, metadata }) => ({
        role,
        content,
        ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
      }));
      return decodeStoredHistory(rows);
    } catch {
      return decodeStoredHistory(null);
    }
  });

  ipcMain.handle('messages:append', (event, rawSessionId: unknown, rawRole: unknown, rawContent: unknown) => {
    try {
      requireRendererMainFrame(event);
      const sessionId = RuntimeIdSchema.parse(rawSessionId);
      const decoded = decodeStoredHistoryEntry({ role: rawRole, content: rawContent });
      if (decoded.kind === 'recovery' || !store) return -1;
      return store.appendMessage(sessionId, rawRole as string, rawContent as string);
    } catch {
      return -1;
    }
  });

  // ── Eval Suite Execution (real) ─────────────────────────
  ipcMain.handle('eval:runSuite', async (event, rawRequest: unknown) => {
    let window: BrowserWindow;
    try {
      window = requireRendererMainFrame(event);
    } catch {
      return createEvalRunFailure();
    }
    const request = decodeEvalRunRequest(rawRequest);
    if (!request || !agentLoop) return createEvalRunFailure();
    if (evalSuiteRunning) return createEvalRunFailure('eval_already_running');

    const consent = await dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Run diagnostic evaluation',
      message: 'This diagnostic suite will call the configured model and may use controlled research tools.',
      detail: 'It can consume provider quota. Results are diagnostic evidence, not a product release approval.',
      buttons: ['Run evaluation', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (consent.response !== 0) {
      return decodeEvalRunResult({ status: 'cancelled', code: 'eval_user_cancelled' });
    }
    evalSuiteRunning = true;

    // Pre-defined eval tasks that exercise core engine capabilities
    const tasks: EvalTaskSpec[] = [
      ...RESEARCH_CAPABILITY_TASKS,
      {
        id: 'basic-completion',
        prompt: 'Respond with exactly the word "hello" and nothing else.',
        maxTurns: 3,
        requirements: ['hello'],
      },
      {
        id: 'tool-use-reasoning',
        prompt: 'Use the read_file tool to read a file, then summarize what you found.',
        maxTurns: 5,
        allowedTools: ['read_file'],
      },
      {
        id: 'constraint-check',
        prompt: 'Say "done" without using any tools.',
        maxTurns: 3,
        forbiddenTools: ['read_file', 'write_file', 'execute_command'],
        requirements: ['done'],
      },
    ];

    try {
      const runner = new EvalRunner(agentLoop);
      const suiteResult = await runner.runSuite(tasks, { suite: 'metis-core', model: provider?.capabilities().model ?? 'unknown', profile: request.profile });
      const summary = suiteSummary(suiteResult);
      const gate = evaluateGate(suiteResult, request.profile);

      // Persist the run
      store?.saveEvalRun({
        id: `eval-${Date.now()}`,
        suiteName: suiteResult.metadata.suite,
        status: gate.passed ? 'passed' : 'failed',
        successRate: summary.successRate,
        taskCount: summary.taskCount,
        passedCount: summary.passed,
        resultsJson: JSON.stringify(suiteResult.results),
        createdAt: suiteResult.metadata.timestamp,
      });

      return decodeEvalRunResult({
        status: 'completed',
        summary: {
          taskCount: summary.taskCount,
          passed: summary.passed,
          failed: summary.failed,
          successRate: summary.successRate,
        },
        gate: {
          passed: gate.passed,
          profile: request.profile,
          failureCount: gate.failures.length,
          failedTaskIds: gate.failedTasks,
        },
        results: suiteResult.results.map((r) => ({
          taskId: r.taskId,
          success: r.success,
          status: r.success ? 'passed' : r.status === 'cancelled' ? 'cancelled' : 'failed',
          turnsUsed: r.turnsUsed,
          toolCalls: r.toolCalls,
          latencyMs: r.latencyMs,
          toolFailures: r.toolFailures,
          qualityFailures: r.qualityFailures,
          issueCount: r.errors.length,
        })),
      });
    } catch {
      return createEvalRunFailure('eval_execution_failed');
    } finally {
      evalSuiteRunning = false;
    }
  });

  // ── LaTeX Compile ───────────────────────────────────────
  ipcMain.handle('latex:compile', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: (rawArgs) => {
      const request = decodeLatexCompileRequest({
        source: rawArgs[0],
        bibliography: rawArgs[1],
      });
      return request.ok ? decoded(request.value) : rejected();
    },
    execute: async (request, event): Promise<LatexCompileResponse> => {
      const result = await compileLatexLocal(request.source, request.bibliography);
      const issues = (result.errors ?? []).slice(0, 500).map((issue) => ({
        line: Number.isInteger(issue.line) && issue.line >= 0 ? issue.line : 0,
        severity: issue.severity,
        code: issue.severity === 'error'
          ? 'latex_compile_error' as const
          : 'latex_compile_warning' as const,
      }));
      if (result.status === 'success' && result.pdfPath) {
        const issued = fileCapabilities.issue({
          path: result.pdfPath,
          kind: 'file',
          mime: 'application/pdf',
          operations: ['file', 'folder', 'read', 'extract'],
        }, executionOwnerFor(event));
        if (issued.success) {
          return decodeLatexCompileResponse({ status: 'success', pdf: issued.capability, issues });
        }
      }
      if (result.status === 'noCompiler') {
        return decodeLatexCompileResponse({
          status: 'noCompiler',
          code: 'latex_compiler_unavailable',
          issues,
        });
      }
      return decodeLatexCompileResponse({
        status: 'error',
        code: 'latex_compile_unavailable',
        issues,
      });
    },
    present: (result) => result,
    recover: createLatexCompileRecovery,
  }));

  ipcMain.handle('fileCapability:use', createFileCapabilityUseHandler({
    getMainWindow,
    getRendererEntryUrl,
    registry: fileCapabilities,
  }));

  // ── Shell ───────────────────────────────────────────────
  ipcMain.handle('fileCapability:select', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const request = decodeFileCapabilitySelectionRequest(rawRequest);
      return request ? decoded(request) : rejected();
    },
    execute: async (request, event) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window.isDestroyed()) return createFileCapabilityFailure();
      const selectingSkillDirectory = request.purpose === 'personalization-skill-directory'
        || request.purpose === 'personalization-mcp-directory';
      const filters = selectingSkillDirectory
        ? undefined
        : request.purpose === 'analysis-dataset'
        ? [
            { name: 'Research data', extensions: ['csv', 'tsv', 'json', 'jsonl', 'xlsx', 'xls', 'sav', 'dta'] },
            { name: 'All files', extensions: ['*'] },
          ]
        : request.purpose === 'personalization-skill-package'
          ? [
              { name: 'Metis skill packages', extensions: ['zip'] },
              { name: 'All files', extensions: ['*'] },
            ]
        : request.purpose === 'funding-template'
            ? [
                { name: 'Funding application templates', extensions: ['pdf', 'docx'] },
              ]
        : [
            { name: 'Research files', extensions: ['pdf', 'docx', 'txt', 'md', 'tex', 'csv', 'json', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg', 'webp', 'mp3', 'wav'] },
            { name: 'All files', extensions: ['*'] },
          ];
      const selected = await dialog.showOpenDialog(window, selectingSkillDirectory
        ? { properties: ['openDirectory'] }
        : { properties: ['openFile'], filters });
      const selectedPath = selected.canceled ? undefined : selected.filePaths[0];
      if (!selectedPath) return createFileCapabilityFailure();
      const issued = fileCapabilities.issue({
        path: selectedPath,
        kind: selectingSkillDirectory ? 'folder' : 'file',
        mime: selectingSkillDirectory ? 'inode/directory' : mimeForLocalFile(selectedPath),
        operations: selectingSkillDirectory
          ? ['folder']
          : request.purpose === 'personalization-skill-package'
            ? ['file']
            : ['file', 'folder', 'read', 'extract'],
        purpose: request.purpose,
      }, executionOwnerFor(event));
      return issued.success ? issued : createFileCapabilityFailure();
    },
    present: decodeFileCapabilitySelectionResult,
    recover: createFileCapabilityFailure,
  }));

  ipcMain.handle('fileCapability:import', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const request = decodeFileCapabilityImportRequest(rawRequest);
      return request ? decoded(request) : rejected();
    },
    execute: async (request, event) => {
      if (request.purpose === 'personalization-skill-directory' || request.purpose === 'personalization-mcp-directory') {
        return createFileCapabilityFailure();
      }
      await fs.promises.mkdir(IMPORTS_DIR, { recursive: true });
      const token = randomUUID();
      const finalPath = path.join(IMPORTS_DIR, `${token}-${request.displayName}`);
      const temporaryPath = `${finalPath}.partial`;
      try {
        if (
          path.extname(request.displayName).toLowerCase() === '.pdf'
          && Buffer.from(request.data.subarray(0, 5)).toString('ascii') !== '%PDF-'
        ) {
          return createFileCapabilityFailure();
        }
        await fs.promises.writeFile(temporaryPath, request.data, { flag: 'wx', mode: 0o600 });
        await fs.promises.rename(temporaryPath, finalPath);
        const issued = fileCapabilities.issue({
          path: finalPath,
          kind: 'file',
          mime: mimeForLocalFile(finalPath),
          displayName: request.displayName,
          operations: ['file', 'folder', 'read', 'extract'],
          purpose: request.purpose,
        }, executionOwnerFor(event));
        if (issued.success) return issued;
        await fs.promises.rm(finalPath, { force: true });
        return createFileCapabilityFailure();
      } catch {
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
        return createFileCapabilityFailure();
      }
    },
    present: decodeFileCapabilitySelectionResult,
    recover: createFileCapabilityFailure,
  }));

  ipcMain.handle('export:selectDestination', async (event) => {
    try {
      const window = requireRendererMainFrame(event);
      const selected = await dialog.showOpenDialog(window, {
        properties: ['openDirectory', 'createDirectory'],
      });
      const directory = selected.canceled ? undefined : selected.filePaths[0];
      if (!directory) return createFileCapabilityFailure();
      const issued = fileCapabilities.issue({
        path: directory,
        kind: 'folder',
        mime: 'inode/directory',
        operations: ['folder'],
        displayName: path.basename(directory) || 'Export destination',
      }, executionOwnerFor(event));
      return issued.success ? issued : createFileCapabilityFailure();
    } catch {
      return createFileCapabilityFailure();
    }
  });

  ipcMain.handle('export:preview', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      const decodedRequest = decodeExportRequest(rawRequest);
      const repository = researchRepository;
      const media = researchMedia;
      const receipts = citationTruthReceipts;
      if (!decodedRequest.ok || !repository || !media || !receipts) return createExportFailure();
      const request = decodedRequest.value;
      const destination = fileCapabilities.resolve({
        capabilityId: request.destinationCapabilityId,
        operation: 'folder',
      }, owner);
      if (!destination.ok) {
        return createExportFailure({ code: 'export_destination_unavailable', severity: 'error' });
      }
      const snapshot = repository.snapshotProject(request.projectId);
      if (!snapshot) {
        return createExportFailure({ code: 'export_snapshot_unavailable', severity: 'error' });
      }
      const binding = resolveTrustedArtifactExportBinding(
        snapshot,
        request.artifactId,
        request.artifactVersion,
      );
      if (!binding) {
        return createExportFailure({
          code: 'export_artifact_binding_mismatch',
          severity: 'error',
        });
      }
      const artifactImages = await media.loadArtifactMedia(snapshot, binding);
      if (!artifactImages) {
        return createExportFailure({
          code: 'export_artifact_binding_mismatch',
          severity: 'error',
        });
      }
      const selectedVersion = snapshot.artifactVersions.find((candidate) => (
        candidate.artifactId === binding.artifactId
        && candidate.version === binding.artifactVersion
      ));
      const selectedManifest = selectedVersion
        ? ArtifactManifestSchema.safeParse(selectedVersion.manifest)
        : null;
      const releaseTrust = selectedVersion && selectedManifest?.success
        ? await verifyArtifactForExport(
            repository,
            receipts,
            selectedManifest.data,
            selectedVersion.content,
          )
        : null;
      if (!releaseTrust) {
        return createExportFailure({ code: 'export_gate_blocked', severity: 'error' });
      }
      const trustedRequest = {
        ...request,
        artifactManifestDigest: binding.artifactManifestDigest,
      };
      const built = buildResearchExport(
        trustedRequest,
        buildExportSnapshot(snapshot, binding, artifactImages, releaseTrust),
      );
      if (!built.ok) return built.failure;
      const preview = secureExports.preview(built.plan);
      if (!preview.success) return preview;
      const now = Date.now();
      for (const [id, item] of exportPreviews) {
        if (item.expiresAt <= now) exportPreviews.delete(id);
      }
      if (exportPreviews.size >= 32) {
        const oldest = exportPreviews.keys().next().value as string | undefined;
        if (oldest) exportPreviews.delete(oldest);
      }
      exportPreviews.set(request.exportId, {
        request,
        plan: built.plan,
        expiresAt: now + 5 * 60_000,
      });
      return decodeExportResult(preview);
    } catch {
      return createExportFailure();
    }
  });

  ipcMain.handle('export:execute', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      const decodedRequest = decodeExportRequest(rawRequest);
      if (!decodedRequest.ok) return createExportFailure();
      const request = decodedRequest.value;
      const preview = exportPreviews.get(request.exportId);
      exportPreviews.delete(request.exportId);
      if (
        !preview
        || preview.expiresAt <= Date.now()
        || JSON.stringify(preview.request) !== JSON.stringify(request)
      ) {
        return createExportFailure({ code: 'export_invalid_request', severity: 'error' });
      }
      const repository = researchRepository;
      const media = researchMedia;
      const receipts = citationTruthReceipts;
      if (!repository || !media || !receipts) {
        return createExportFailure({ code: 'export_snapshot_unavailable', severity: 'error' });
      }
      const currentSnapshot = repository.snapshotProject(request.projectId);
      if (!currentSnapshot) {
        return createExportFailure({ code: 'export_snapshot_unavailable', severity: 'error' });
      }
      const currentBinding = resolveTrustedArtifactExportBinding(
        currentSnapshot,
        request.artifactId,
        request.artifactVersion,
      );
      if (
        !currentBinding
        || currentBinding.artifactManifestDigest !== preview.plan.artifactManifestDigest
      ) {
        return createExportFailure({
          code: 'export_artifact_binding_mismatch',
          severity: 'error',
        });
      }
      const currentImages = await media.loadArtifactMedia(currentSnapshot, currentBinding);
      if (!currentImages) {
        return createExportFailure({
          code: 'export_artifact_binding_mismatch',
          severity: 'error',
        });
      }
      const currentVersion = currentSnapshot.artifactVersions.find((candidate) => (
        candidate.artifactId === currentBinding.artifactId
        && candidate.version === currentBinding.artifactVersion
      ));
      const currentManifest = currentVersion
        ? ArtifactManifestSchema.safeParse(currentVersion.manifest)
        : null;
      const currentTrust = currentVersion && currentManifest?.success
        ? await verifyArtifactForExport(
            repository,
            receipts,
            currentManifest.data,
            currentVersion.content,
          )
        : null;
      if (!currentTrust) {
        return createExportFailure({ code: 'export_gate_blocked', severity: 'error' });
      }
      const currentBuild = buildResearchExport({
        ...request,
        artifactManifestDigest: currentBinding.artifactManifestDigest,
      }, buildExportSnapshot(currentSnapshot, currentBinding, currentImages, currentTrust));
      if (!currentBuild.ok) return currentBuild.failure;
      const destination = fileCapabilities.resolve({
        capabilityId: request.destinationCapabilityId,
        operation: 'folder',
      }, owner);
      if (!destination.ok) {
        return createExportFailure({ code: 'export_destination_unavailable', severity: 'error' });
      }
      const result = await secureExports.write(currentBuild.plan, {
        resolvedDirectory: destination.resolvedPath,
      });
      return decodeExportResult(result.publicResult);
    } catch {
      return createExportFailure({ code: 'export_write_failed', severity: 'error' });
    }
  });

  ipcMain.handle('shell:openExternal', createSecureExternalOpenHandler({
    authorize: requireRendererMainFrame,
    openExternal: (url) => shell.openExternal(url),
  }));

  // ── Settings ────────────────────────────────────────────
  ipcMain.handle('settings:get', (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return createSettingsViewRecovery();
    }
    if (!currentConfig && layoutAcceptanceToken) {
      // Layout acceptance runs against a disposable credential-free profile.
      // It needs the normal project shell, but it must not mint a provider or
      // read a real API key. This fixed view is reachable only when the main
      // process was explicitly launched with the acceptance token.
      return decodeSettingsView({
        configured: true,
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'layout-acceptance-model',
        hasApiKey: true,
        needsReauth: false,
        theme: currentTheme,
        accent: loadAccent(),
        providerVision: loadProviderVision(),
        providerMaxContextTokens: loadProviderMaxContextTokens(),
        setupSkipped: true,
      });
    }
    if (!currentConfig) {
      return decodeSettingsView({
        configured: false,
        hasApiKey: false,
        needsReauth: false,
        theme: currentTheme,
        accent: loadAccent(),
        providerVision: loadProviderVision(),
        providerMaxContextTokens: loadProviderMaxContextTokens(),
        setupSkipped: loadSetupSkipped(),
      });
    }
    return decodeSettingsView({
      configured: true,
      baseUrl: currentConfig.baseUrl,
      model: currentConfig.model,
      hasApiKey: !!currentConfig.apiKey,
      needsReauth: !currentConfig.apiKey,
      theme: currentTheme,
      accent: loadAccent(),
      providerVision: loadProviderVision(),
      providerMaxContextTokens: loadProviderMaxContextTokens(),
      setupSkipped: loadSetupSkipped(),
    });
  });

  // ── First-run setup skip persistence ─────────────────────
  ipcMain.handle('settings:markSetupSkipped', (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
    return { ok: saveSetupSkipped() };
  });

  // ── Update check ─────────────────────────────────────────
  ipcMain.handle('update:check', async (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return { hasUpdate: false, currentVersion: app.getVersion(), error: 'unauthorized_renderer' };
    }
    if (!updateChecker) updateChecker = new UpdateCheckerService();
    return updateChecker.check(app.getVersion());
  });

  // ── Auto update control ──────────────────────────────────
  ipcMain.handle('update:status', (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return { error: 'unauthorized_renderer' };
    }
    return {
      ...lastUpdateEvent,
      currentVersion: app.getVersion(),
      channel: autoUpdaterService?.channel ?? null,
      trust: autoUpdaterService?.getTrustState() ?? null,
    };
  });
  ipcMain.handle('update:download', async (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return { error: 'unauthorized_renderer' };
    }
    await autoUpdaterService?.download();
    return lastUpdateEvent;
  });
  ipcMain.handle('update:install', (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return { error: 'unauthorized_renderer' };
    }
    const installAccepted = autoUpdaterService ? autoUpdaterService.quitAndInstall() : false;
    return installAccepted
      ? { installing: true }
      : { installing: false, blocked: 'update_install_blocked_by_trust_policy' };
  });

  // ── Startup health & diagnostic bundle (Task 5) ─────────────
  const collectMetisStartupHealth = () => {
    // P0-8: reconciliation already retired crash-era 'running' rows at boot;
    // probe what is STILL running now (a live turn is legitimate).
    const stillRunningNow = (() => {
      try {
        return (store?.raw.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'running'").get() as { n: number } | undefined)?.n ?? 0;
      } catch { return null; }
    })();
    const providerConfigured = (() => {
      try {
        const listed = providerProfileStore?.list() as unknown as { value?: { profiles?: unknown[] } } | undefined;
        const profiles = listed?.value?.profiles;
        return Array.isArray(profiles) ? profiles.length > 0 : null;
      } catch { return null; }
    })();
    const mcpSummary = (() => {
      try {
        const status = mcpManager?.getStatus();
        return status ? `${status.filter((s) => s.connected).length}/${status.length} MCP servers connected` : null;
      } catch { return null; }
    })();
    return collectStartupHealth({
      appVersion: app.getVersion(),
      buildId: 'metis-alpha2-release',
      dataDir: DATA_DIR,
      dbPath: DB_PATH,
      backupDir: path.join(DATA_DIR, 'backups'),
      storeReady: store !== null,
      providerConfigured,
      genofficeReady: null,
      browserReady: null,
      mcpSummary,
      orphanRunningRuns: stillRunningNow,
      reconciledOrphanRuns,
      crashMarker: { previousRunUnclean, marker: previousCrashMarker },
      lastMigration: store?.getLastMigrationResult()
        ? {
            fromVersion: store.getLastMigrationResult()!.fromVersion,
            toVersion: store.getLastMigrationResult()!.toVersion,
            failed: store.getLastMigrationResult()!.failed,
          }
        : null,
      storeHealth: store?.getStartupHealthReport()
        ? {
            ok: store.getStartupHealthReport()!.ok,
            checks: store.getStartupHealthReport()!.checks,
            schemaVersion: store.getStartupHealthReport()!.schemaVersion,
            migrationVersion: store.getStartupHealthReport()!.migrationVersion,
          }
        : null,
    });
  };
  ipcMain.handle('diagnostics:healthReport', (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return { error: 'unauthorized_renderer' };
    }
    return collectMetisStartupHealth();
  });
  ipcMain.handle('diagnostics:exportBundle', async (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
    const health = collectMetisStartupHealth();
    const bundle = await buildDiagnosticBundle({
      appVersion: app.getVersion(),
      buildId: 'metis-alpha2-release',
      dataDir: DATA_DIR,
      settingsPath: SETTINGS_PATH,
      logDir: path.join(DATA_DIR, 'logs'),
      crashMarkerPath: crashMarkerPath(DATA_DIR),
      health,
      schemaInfo: {
        schemaVersion: store?.getStartupHealthReport()?.schemaVersion ?? null,
        migrationVersion: store?.getLastMigrationResult()?.toVersion ?? null,
      },
      featureReadiness: {
        persistence: store ? 'ready' : 'unavailable',
        mcp: mcpManager ? 'initialized' : 'unavailable',
        updater: autoUpdaterService ? `channel:${autoUpdaterService.channel}` : 'unavailable',
      },
    });
    return bundle.ok
      ? { ok: true, path: bundle.zipPath, sha256: bundle.sha256, entries: bundle.entries.length }
      : bundle;
  });

  // 任务3：域 registrar 迁移——channel/contract/恢复形状不变，注册走 IpcRegistry。
  ipcDomainDisposers.push(registerSystemIpc(domainIpcContext));

  // ── Complete project archive (METIS-F10) ───────────────────
  // 任务3：域 registrar 迁移——channel/contract/恢复形状不变，注册走 IpcRegistry。
  ipcDomainDisposers.push(registerProjectIpc(domainIpcContext));


  // ── Research browser (embedded WebContentsView) ──────────────
  ipcMain.handle('browser:show', (event, rawBounds: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      const bounds = parseBrowserBounds(rawBounds);
      if (!bounds) return { ok: false, error: 'browser_invalid_bounds' };
      // 与协同对话视图互斥：同一时间只显示一个嵌入视图。
      collabService?.hide();
      service.show(bounds);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:hide', (event) => {
    try {
      requireRendererMainFrame(event);
      browserService?.hide();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:setBounds', (event, rawBounds: unknown) => {
    try {
      requireRendererMainFrame(event);
      const bounds = parseBrowserBounds(rawBounds);
      if (!bounds || !browserService) return { ok: false, error: 'browser_invalid_bounds' };
      browserService.setBounds(bounds);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:navigate', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      // 任务2 上下文隔离：渲染端可显式声明该次导航归属的项目（对象参数）；
      // 旧字符串参数与未声明归属的导航都记为「归属未知」（null）。
      if (typeof raw === 'object' && raw !== null) {
        const payload = raw as { url?: unknown; projectId?: unknown };
        const url = typeof payload.url === 'string' ? payload.url : '';
        const projectId = typeof payload.projectId === 'string' && payload.projectId.trim() ? payload.projectId.trim() : null;
        service.setActiveOwnership(projectId);
        return await service.navigate(url);
      }
      service.setActiveOwnership(null);
      const url = typeof raw === 'string' ? raw : '';
      return await service.navigate(url);
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:back', (event) => { try { requireRendererMainFrame(event); browserService?.goBack(); return { ok: true }; } catch { return { ok: false, error: 'browser_denied' }; } });
  ipcMain.handle('browser:forward', (event) => { try { requireRendererMainFrame(event); browserService?.goForward(); return { ok: true }; } catch { return { ok: false, error: 'browser_denied' }; } });
  ipcMain.handle('browser:reload', (event) => { try { requireRendererMainFrame(event); browserService?.reload(); return { ok: true }; } catch { return { ok: false, error: 'browser_denied' }; } });
  ipcMain.handle('browser:stop', (event) => { try { requireRendererMainFrame(event); browserService?.stop(); return { ok: true }; } catch { return { ok: false, error: 'browser_denied' }; } });

  ipcMain.handle('browser:focusRenderer', (event) => {
    try {
      requireRendererMainFrame(event);
      event.sender.focus();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  // ── 协同对话（第三方 AI 网页版 WebContentsView） ─────────────
  ipcMain.handle('collab:show', (event, rawBounds: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureCollabService();
      if (!service) return { ok: false, error: 'collab_unavailable' };
      const bounds = parseBrowserBounds(rawBounds);
      if (!bounds) return { ok: false, error: 'collab_invalid_bounds' };
      // 与研究浏览器视图互斥：同一时间只显示一个嵌入视图。
      browserService?.hide();
      service.show(bounds);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('collab:hide', (event) => {
    try {
      requireRendererMainFrame(event);
      collabService?.hide();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('collab:setBounds', (event, rawBounds: unknown) => {
    try {
      requireRendererMainFrame(event);
      const bounds = parseBrowserBounds(rawBounds);
      if (!bounds || !collabService) return { ok: false, error: 'collab_invalid_bounds' };
      collabService.setBounds(bounds);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('collab:navigate', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureCollabService();
      if (!service) return { ok: false, error: 'collab_unavailable' };
      const url = typeof raw === 'string' ? raw : '';
      return await service.navigate(url);
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  // ── Chatbot Context Bridge（2026-09-05 刘总规格书） ─────────────
  // METIS → Chatbot：剪贴板内容粘贴进第三方 AI 页面（自动填入路径）。
  ipcMain.handle('collab:paste', (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureCollabService();
      if (!service) return { ok: false, error: 'collab_unavailable' };
      return service.pasteFromClipboard();
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  // Chatbot → METIS：捕获选区原文（只读；失败如实返回，渲染层走剪贴板 fallback）。
  ipcMain.handle('collab:captureSelection', async (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureCollabService();
      if (!service) return { ok: false, error: 'collab_unavailable' };
      return await service.getSelectedText();
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });


  // 当前第三方 AI 页面状态（确认卡展示真实来源 URL）。
  ipcMain.handle('collab:getState', (event) => {
    try {
      requireRendererMainFrame(event);
      return { ok: true, state: collabService?.getState() ?? { url: '', title: '' } };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  // 外部模型引用（外部参考·非证据）：确认卡通过后由渲染层显式提交。
  ipcMain.handle('externalRef:add', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!store) return { ok: false, issues: ['store_unavailable'] };
      const service = new ExternalReferenceService(store.raw);
      const result = service.add(raw);
      if (!result.ok) return { ok: false, issues: result.issues };
      return { ok: true, reference: result.reference, duplicate: result.duplicate };
    } catch (err) {
      return { ok: false, issues: [String((err as Error).message ?? err)] };
    }
  });

  ipcMain.handle('externalRef:list', (event, rawQuery: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!store) return { ok: false, error: 'store_unavailable' };
      const service = new ExternalReferenceService(store.raw);
      const query = (typeof rawQuery === 'object' && rawQuery !== null ? rawQuery : {}) as {
        projectId?: unknown; sessionId?: unknown; limit?: unknown; global?: unknown;
      };
      // 任务2 上下文隔离：读取必须显式声明 scope。空 scope 不再返回全局最近
      // 数据（跨 Topic/Project 串线的根因）；管理页浏览必须显式传 global:true。
      const limit = typeof query.limit === 'number' && Number.isFinite(query.limit) ? Math.floor(query.limit) : undefined;
      if (query.global === true) {
        return { ok: true, references: service.listGlobal(limit) };
      }
      const scopeProjectId = typeof query.projectId === 'string' ? query.projectId : undefined;
      const scopeSessionId = typeof query.sessionId === 'string' ? query.sessionId : undefined;
      if (!scopeProjectId && !scopeSessionId) {
        return { ok: false, error: 'scope_required' };
      }
      return {
        ok: true,
        references: service.listForScope({
          ...(scopeProjectId ? { projectId: scopeProjectId } : {}),
          ...(scopeSessionId ? { sessionId: scopeSessionId } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('externalRef:remove', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!store) return { ok: false, error: 'store_unavailable' };
      const service = new ExternalReferenceService(store.raw);
      const id = typeof rawId === 'string' ? rawId : '';
      if (!id) return { ok: false, error: 'invalid_request' };
      return { ok: service.remove(id) };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  // ── 内置文献检索（NCPSSD 中文 + OpenAlex 英文，LIT-SEARCH-01） ──
  ipcMain.handle('literature:search', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (typeof rawRequest !== 'object' || rawRequest === null) {
        return { ok: false, code: 'literature_invalid_request', recovery: 'retry_with_valid_query' };
      }
      const request = rawRequest as { query?: unknown; sources?: unknown; page?: unknown; pageSize?: unknown; coreOnly?: unknown };
      const sources = Array.isArray(request.sources)
        ? request.sources.filter((source): source is 'ncpssd' | 'openalex' => source === 'ncpssd' || source === 'openalex')
        : [];
      return await literatureSearchService.search({
        query: typeof request.query === 'string' ? request.query : '',
        sources,
        page: typeof request.page === 'number' ? request.page : 1,
        pageSize: typeof request.pageSize === 'number' ? request.pageSize : 10,
        coreOnly: request.coreOnly !== false,
      });
    } catch {
      return { ok: false, code: 'literature_source_unavailable', recovery: 'retry_later_or_change_source' };
    }
  });

  ipcMain.handle('browser:state', (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      return service ? { ok: true, state: service.getState() } : { ok: false, error: 'browser_unavailable' };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:click', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      const { x, y } = (raw as { x?: number; y?: number }) ?? {};
      if (typeof x !== 'number' || typeof y !== 'number') return { ok: false, error: 'browser_invalid_point' };
      service.click(x, y);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:type', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      const text = typeof raw === 'string' ? raw.slice(0, 4000) : '';
      if (!text) return { ok: false, error: 'browser_invalid_text' };
      service.type(text);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:key', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      const keyCode = typeof raw === 'string' ? raw : '';
      if (!keyCode) return { ok: false, error: 'browser_invalid_key' };
      service.key(keyCode);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:scroll', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      const { deltaX, deltaY } = (raw as { deltaX?: number; deltaY?: number }) ?? {};
      service.scroll(Number(deltaX) || 0, Number(deltaY) || 0);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:screenshot', async (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      return await service.screenshot();
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:extract', async (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      return await service.extract();
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:collect', async (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      return await service.collect();
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:listDownloads', (event) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      return { ok: true, downloads: service.listPendingDownloads() };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:acceptDownload', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const service = ensureBrowserService();
      if (!service) return { ok: false, error: 'browser_unavailable' };
      const request = (raw as { id?: string; projectId?: string | null }) ?? {};
      if (!request.id) return { ok: false, error: 'download_not_found' };
      // 项目自定义目录优先（批2）：PDF 归档到 projectDir/pdfs。
      let projectDir: string | null = null;
      try {
        if (request.projectId && researchRepository) {
          const project = researchRepository.getProject(request.projectId, false);
          projectDir = (project?.metadata as { projectDir?: string } | undefined)?.projectDir ?? null;
        }
      } catch { /* 目录读取失败回退默认 */ }
      const outcome = await service.acceptDownload({ id: request.id, projectId: request.projectId ?? null, projectDir });
      // PDF 归档成功后自动入队全文抽取（T2：AI 可读全文的入口）。
      if (outcome.ok && outcome.paperId && outcome.savedPath) {
        jobQueueService.enqueueExtract(outcome.paperId, outcome.savedPath);
      }
      return outcome;
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });

  ipcMain.handle('browser:cancelDownload', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const id = typeof raw === 'string' ? raw : '';
      if (!id || !browserService) return { ok: false, error: 'download_not_found' };
      browserService.cancelDownload(id);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error).message ?? err) };
    }
  });


  // ── WeChat Bot (METIS-WX-1, iLink protocol — same as ZCode) ──
  // 任务3：域 registrar 迁移——channel/contract/恢复形状不变，注册走 IpcRegistry。
  ipcDomainDisposers.push(registerWeChatIpc(domainIpcContext));


  ipcMain.handle('settings:set', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeSettingsUpdateRequest(rawRequest);
      if (!request) return createSettingsMutationFailure('secure_setup_required');

      const vision = request.providerVision ?? loadProviderVision();
      const maxContext = request.providerMaxContextTokens ?? loadProviderMaxContextTokens();
      const theme = request.theme ?? currentTheme;
      const accent = request.accent ?? loadAccent();
      const ok = saveSettings(theme, accent, vision, maxContext);
      if (!ok) return createSettingsMutationFailure('settings_update_unavailable');
      currentTheme = theme;
      if (currentConfig) currentConfig.maxContextTokens = maxContext > 0 ? maxContext : undefined;
      return decodeSettingsMutationResult({ success: true, code: 'settings_saved' });
    } catch {
      return createSettingsMutationFailure();
    }
  });

  // ── Secure named provider profiles ────────────────────────
  // API keys are encrypted in the main-process-only profile store. Every
  // response is projected through a strict public DTO; neither plaintext nor
  // ciphertext can reach the renderer.
  ipcMain.handle('providerProfiles:list', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const request = decodeProviderProfileListRequest(rawRequest);
      return request.ok ? decoded(request.value) : rejected();
    },
    execute: (request) => ({ request, result: providerProfileStore?.list() ?? { ok: false as const, code: 'runtime_unavailable' as const } }),
    present: ({ request, result }) => {
      if (!result.ok) return providerProfileListFailure(request.operationId, result);
      return {
        ok: true as const,
        contractVersion: PROVIDER_PROFILE_CONTRACT_VERSION,
        operationId: request.operationId,
        revision: result.value.revision,
        profiles: result.value.profiles,
      };
    },
    recover: () => createProviderProfileListRecovery(),
  }));

  ipcMain.handle('providerProfiles:save', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const request = decodeProviderProfileSaveRequest(rawRequest);
      return request.ok ? decoded(request.value) : rejected();
    },
    execute: async (request) => {
      if (!providerProfileStore || !store) return { request, result: { ok: false as const, code: 'runtime_unavailable' as const } };
      const before = providerProfileStore.list();
      if (!before.ok) return { request, result: before };
      const previousProfile = request.id ? before.value.profiles.find((profile) => profile.id === request.id) : undefined;
      const previousConfig = previousProfile ? providerProfileStore.configFor(previousProfile.id) : undefined;
      if (previousConfig && !previousConfig.ok) return { request, result: previousConfig };
      const candidateConfig = providerProfileStore.configForSave(request);
      if (!candidateConfig.ok) return { request, result: candidateConfig };

      let candidate: PreparedSetupRuntime;
      try {
        candidate = prepareProviderRuntime(providerProfileRuntimeContext(candidateConfig.value, 'save'));
      } catch {
        return { request, result: { ok: false as const, code: 'runtime_rebuild_failed' as const } };
      }

      const saved = await providerProfileStore.save(request);
      if (!saved.ok) {
        await candidate.discard();
        return { request, result: saved };
      }
      if (!saved.value.profile.isActive) {
        await candidate.discard();
        return { request, result: saved };
      }
      try {
        await candidate.commitAndAbortPrevious();
        return { request, result: saved };
      } catch {
        await candidate.discard();
        // The profile record is rolled back only if no concurrent revision
        // superseded it. Runtime and disk therefore remain one transaction.
        const rolledBack = await providerProfileStore.restoreAfterFailedSave({
          id: previousProfile?.id ?? null,
          name: previousProfile?.name ?? '',
          config: previousConfig?.ok ? previousConfig.value : null,
          activeId: before.value.profiles.find((profile) => profile.isActive)?.id ?? null,
        }, saved.value.revision);
        return {
          request,
          result: rolledBack.ok
            ? { ok: false as const, code: 'runtime_rebuild_failed' as const }
            : { ok: false as const, code: 'io_error' as const },
        };
      }
    },
    present: ({ request, result }) => providerProfileMutationResponse(request.operationId, 'saved', result),
    recover: () => createProviderProfileMutationRecovery(),
  }));

  ipcMain.handle('providerProfiles:switch', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const request = decodeProviderProfileSwitchRequest(rawRequest);
      return request.ok ? decoded(request.value) : rejected();
    },
    execute: async (request) => {
      if (!providerProfileStore || !store) return { request, result: { ok: false as const, code: 'runtime_unavailable' as const } };
      const config = providerProfileStore.configFor(request.id);
      if (!config.ok) return { request, result: config };
      try {
        const candidate = prepareProviderRuntime(providerProfileRuntimeContext(config.value, 'restore'));
        const persisted = await providerProfileStore.activate(request);
        if (!persisted.ok) {
          await candidate.discard();
          return { request, result: persisted };
        }
        await candidate.commitAndAbortPrevious();
        return { request, result: persisted };
      } catch {
        return { request, result: { ok: false as const, code: 'runtime_rebuild_failed' as const } };
      }
    },
    present: ({ request, result }) => providerProfileMutationResponse(request.operationId, 'switched', result),
    recover: () => createProviderProfileMutationRecovery(),
  }));

  ipcMain.handle('providerProfiles:delete', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const request = decodeProviderProfileDeleteRequest(rawRequest);
      return request.ok ? decoded(request.value) : rejected();
    },
    execute: async (request) => {
      if (!providerProfileStore) return { request, result: { ok: false as const, code: 'runtime_unavailable' as const } };
      const listed = providerProfileStore.list();
      const targetWasActive = listed.ok && listed.value.profiles.some((profile) => profile.id === request.id && profile.isActive);
      const result = await providerProfileStore.delete(request);
      if (result.ok && targetWasActive && result.value.activeId) {
        const replacement = providerProfileStore.configFor(result.value.activeId);
        if (!replacement.ok) return { request, result: { ok: false as const, code: 'runtime_rebuild_failed' as const } };
        try {
          const candidate = prepareProviderRuntime(providerProfileRuntimeContext(replacement.value, 'restore'));
          await candidate.commitAndAbortPrevious();
        } catch {
          return { request, result: { ok: false as const, code: 'runtime_rebuild_failed' as const } };
        }
      }
      return { request, result };
    },
    present: ({ request, result }) => providerProfileMutationResponse(request.operationId, 'deleted', result),
    recover: () => createProviderProfileMutationRecovery(),
  }));

  ipcMain.handle('providerProfiles:reset', createSecureIpcHandler({
    authorize: requireRendererMainFrame,
    decode: ([rawRequest]) => {
      const request = decodeProviderProfileResetRequest(rawRequest);
      return request.ok ? decoded(request.value) : rejected();
    },
    execute: async (request) => {
      if (!providerProfileStore) return { request, result: { ok: false as const, code: 'runtime_unavailable' as const } };
      const result = await providerProfileStore.reset(request.expectedRevision);
      if (result.ok) deactivateProviderRuntime('provider_profiles_reset');
      return { request, result };
    },
    present: ({ request, result }) => providerProfileMutationResponse(request.operationId, 'reset', result),
    recover: () => createProviderProfileMutationRecovery(),
  }));

  // ── Agent Chat (streaming mode) ─────────────────────────
  ipcMain.handle('agent:execution-replay', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!store) return null;
      const request = AgentEventReplayRequestSchema.safeParse(rawRequest);
      if (!request.success) return null;
      const { version, sessionId, runId, afterSequence, limit } = request.data;
      const run = store.getAgentRun(runId, sessionId);
      if (!run) return null;
      const events = store.getAgentEventsAfter(sessionId, runId, afterSequence, limit);
      const retentionGap = run.eventsPruned && (
        events.length === 0
          ? run.lastSequence > afterSequence
          : events[0]!.sequence > afterSequence + 1
      );
      return AgentEventReplayResponseSchema.parse({
        version,
        sessionId,
        runId,
        afterSequence,
        events,
        retentionGap,
      });
    } catch {
      return null;
    }
  });

  ipcMain.handle('agent:chat', async (
    event,
    rawSessionId: unknown,
    rawMessages: unknown,
    rawSkillId?: unknown,
    rawOptions?: unknown,
  ) => {
    const generatedRequestId = `chat_${++requestCounter}`;
    try {
      requireRendererMainFrame(event);
    } catch {
      return createChatTurnErrorResponse(generatedRequestId, 'error', 'unauthorized_renderer');
    }
    const request = AgentChatRequestSchema.safeParse({
      version: CHAT_RUNTIME_CONTRACT_VERSION,
      turnId: typeof rawOptions === 'object' && rawOptions !== null
        ? (rawOptions as { turnId?: unknown }).turnId ?? generatedRequestId
        : generatedRequestId,
      sessionId: rawSessionId,
      messages: rawMessages,
      skillId: rawSkillId,
      scenarioId: typeof rawOptions === 'object' && rawOptions !== null
        ? (rawOptions as { scenarioId?: unknown }).scenarioId
        : undefined,
      projectId: typeof rawOptions === 'object' && rawOptions !== null
        ? (rawOptions as { projectId?: unknown }).projectId
        : undefined,
      mode: typeof rawOptions === 'object' && rawOptions !== null
        ? (rawOptions as { mode?: unknown }).mode
        : undefined,
    });
    if (!request.success) {
      return createChatTurnErrorResponse(generatedRequestId, 'error', 'invalid_chat_request');
    }
    if (runtimeShutdown.isDraining()) {
      return createChatTurnErrorResponse(request.data.turnId, 'error', 'application_shutting_down');
    }
    const { turnId: requestId, sessionId, messages, skillId, scenarioId, projectId, mode } = request.data;
    if (!agentLoop || !provider || !store) {
      console.error('[Main] agent chat is unavailable');
      return createChatTurnErrorResponse(requestId, 'error', 'agent_not_initialized');
    }
    const requestRuntimeGeneration = runtimeGeneration;
    const requestAgentLoop = agentLoop;
    const requestProvider = provider;
    const requestConfig = currentConfig ? { ...currentConfig } : null;

    // Resolve skill prompt if skillId provided
    let skillPrompt: string | undefined;

    // 研究阶段上下文（T5/T27）：AI 感知项目当前阶段与上次进展，回答贴合阶段。
    try {
      if (projectId && researchRepository) {
        const project = researchRepository.getProject(projectId, false);
        const stage = (project?.metadata as { stage?: string } | undefined)?.stage;
        const brief = new ResearchJournalService(researchRepository, goalEngine, store).buildResumeBrief(projectId);
        const stageBlock: string[] = [];
        if (stage) stageBlock.push(`[研究阶段] ${stage}（选题topic/文献literature/设计design/数据data/分析analysis/写作writing/投稿submission/修订revision；请按该阶段调整协助方式）`);
        if (brief && brief.lastActivityAt) stageBlock.push(`[上次进展] ${brief.summaryText}`);
        if (stageBlock.length > 0) {
          skillPrompt = [stageBlock.join('\n'), skillPrompt].filter(Boolean).join('\n\n');
        }
      }
    } catch { /* 阶段上下文必须不破坏对话 */ }

    if (skillId && skillRegistry) {
      const skill = skillRegistry.get(skillId);
      if (skill) {
        skillPrompt = skill.systemPrompt;
      }
    }

    let allowedTools: string[] | undefined;
    let maxTurns: number | undefined;
    let taskContractHash: string | undefined;
    let promptStackHash: string | undefined;
    // 系统默认权限 = Full Access：用户不管理权限；无场景的普通对话同样全权执行。
    let fullAccess: import('../engine/runtime/PersonalizationRuntimeContract.js').FullAccessPolicy
      = SYSTEM_FULL_ACCESS_POLICY;
    let resolvedManifest: import('../engine/runtime/PersonalizationRuntimeContract.js').ResolvedRunManifest | undefined;
    let resolvedSystemPrompt: string | undefined;
    if (personalizationRuntime && scenarioId) {
      const effectiveProjectId = projectId ?? 'global';
      let projectRulesId: string | undefined;
      let projectRule: import('../engine/runtime/PersonalizationRuntimeContract.js').MetisRulesDefinition | undefined;
      if (effectiveProjectId !== 'global') {
        const workspaceManager = ensureWorkspaceManager(effectiveProjectId);
        if (!workspaceManager) {
          return createChatTurnErrorResponse(requestId, 'error', 'personalization_resolution_failed');
        }
        const projection = projectMetisRulesFromWorkspace(
          { ...workspaceManager.read(), projectId: effectiveProjectId },
          effectiveProjectId,
        );
        if (!projection.ok) {
          return createChatTurnErrorResponse(requestId, 'error', 'personalization_resolution_failed');
        }
        projectRulesId = projection.projectRulesId;
        projectRule = projection.definition;
      }
      // projectRulesId 为 null（新项目还没有 Project Metis.md）时必须省略字段：
      // strict schema 对显式 null 会拒绝，导致 resolveForAgent 守卫返回 undefined。
      const resolved = personalizationRuntime.resolveForAgent({
        contractVersion: 1,
        sessionId: sessionId.replace(/:/gu, '-'),
        projectId: effectiveProjectId,
        ...(scenarioId ? { scenarioId } : {}),
        ...(projectRulesId ? { projectRulesId } : {}),
      }, projectRule);
      if (!resolved?.ok) {
        // resolveForAgent can return undefined for guard-clause rejections;
        // stringify defensively and surface the request shape for diagnosis.
        const detail = resolved ? JSON.stringify(resolved).slice(0, 200) : 'undefined (guard-clause rejection)';
        console.warn(`[AgentChat] scenario resolveForAgent failed: ${detail} | sessionId=${sessionId} projectId=${effectiveProjectId} scenarioId=${scenarioId ?? 'null'} projectRulesId=${projectRulesId ?? 'null'}`);
        return createChatTurnErrorResponse(requestId, 'error', 'personalization_resolution_failed');
      }
      console.log(`[AgentChat] scenario resolved: workflow=${resolved.manifest.workflow.length} hooks=${resolved.manifest.hooks?.length ?? 0} agents=${resolved.manifest.agentIds.length} systemPromptChars=${resolved.systemPrompt.length}`);
      skillPrompt = [resolved.systemPrompt, skillPrompt].filter(Boolean).join('\n\n');
      allowedTools = resolved.manifest.allowedTools;
      maxTurns = resolved.manifest.maxTurns;
      taskContractHash = resolved.manifest.manifestDigest;
      promptStackHash = resolved.manifest.manifestDigest;
      fullAccess = resolved.manifest.fullAccess;
      resolvedManifest = resolved.manifest;
      resolvedSystemPrompt = resolved.systemPrompt;
    } else if (scenarioId) {
      return createChatTurnErrorResponse(requestId, 'error', 'personalization_unavailable');
    }
    // 任务7 能力系统(2026-09-05 刘总要求):普通聊天(无场景解析)对 Scenario Builder
    // 专属工具零可见——显式排除编译/安装工具,防止普通 Agent 触发市场安装。
    if (!resolvedManifest) {
      allowedTools = chatToolsExcludingCompilerTools(builtinToolNames());
    }

    const fundingToolScope = {
      ownerId: FUNDING_LOCAL_OWNER_ID,
      projectId: projectId ?? 'global',
      ownerWebContentsId: event.sender.id,
    };
    const scopeInstruction = allowedTools?.some((tool) => tool.startsWith('funding_template_'))
      ? [
          'Funding-template tools are read-only and bound by Electron main to this run scope.',
          `Use ownerId=${fundingToolScope.ownerId} and projectId=${fundingToolScope.projectId} exactly; never infer or replace them.`,
        ].join('\n')
      : undefined;
    const scenarioCompilation = compileScenarioExecutionManifest(resolvedManifest, {
      executionInstructions: scopeInstruction ? [scopeInstruction] : [],
    });
    if (!scenarioCompilation.ok) {
      console.warn('[AgentChat] scenario compilation failed:', scenarioCompilation.code);
      return createChatTurnErrorResponse(requestId, 'error', scenarioCompilation.code);
    }
    resolvedManifest = scenarioCompilation.manifest;
    if (resolvedManifest) {
      taskContractHash = resolvedManifest.manifestDigest;
      promptStackHash = resolvedManifest.manifestDigest;
    }
    if (scenarioCompilation.useCoordinator
      && (!resolvedManifest || !resolvedSystemPrompt || !personalizationRepository)) {
      console.warn('[AgentChat] scenario coordinator unavailable: manifest/systemPrompt/repository missing');
      return createChatTurnErrorResponse(requestId, 'error', 'scenario_workflow_unavailable');
    }
    console.log(`[AgentChat] scenario compilation done: useCoordinator=${scenarioCompilation.useCoordinator}`);
    console.log(`[AgentChat] runner branch: coordinator=${scenarioCompilation.useCoordinator} manifest=${Boolean(resolvedManifest)} systemPrompt=${Boolean(resolvedSystemPrompt)} repository=${Boolean(personalizationRepository)}`);

    if (activeChatRuns.has(sessionId) || hasCompareRunForSession(sessionId)) {
      console.warn('[AgentChat] rejected: agent_run_active');
      return createChatTurnErrorResponse(requestId, 'error', 'agent_run_active');
    }
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const activeRun: ActiveChatRun = {
      ownerWebContentsId: event.sender.id,
      controller: new AbortController(),
      nextSequence: 0,
      completion,
      resolveCompletion,
    };
    liveSteeringQueue.clear(sessionId);
    activeChatRuns.set(sessionId, activeRun);
    const unregisterChatRun = registerChatRunForShutdown(sessionId, activeRun, activeRun.completion);
    if (!unregisterChatRun) {
      activeFundingToolScopes.delete(sessionId);
      return createChatTurnErrorResponse(requestId, 'error', 'application_shutting_down');
    }
    activeFundingToolScopes.set(sessionId, fundingToolScope);
    if (scopeInstruction) {
      skillPrompt = [skillPrompt, scopeInstruction].filter(Boolean).join('\n\n');
      resolvedSystemPrompt = [resolvedSystemPrompt, scopeInstruction].filter(Boolean).join('\n\n');
    }

    // Inject the project memory context (key decisions, project memory, user
    // preferences) so the agent carries cross-session continuity. Previously
    // MemoryManager.recordKeyDecision was wired but buildMemoryContext was not
    // consumed by any prompt — decisions were recorded but never fed back.
    let injectedMemoryContext = '';
    let injectedLearningContext = '';
    try {
      // METIS-F12: scope the injected memory to the active project when known.
      const memoryContext = memoryManager?.buildMemoryContext(projectId);
      if (memoryContext && memoryContext.trim()) {
        injectedMemoryContext = memoryContext;
        skillPrompt = [skillPrompt, memoryContext].filter(Boolean).join('\n\n');
        resolvedSystemPrompt = [resolvedSystemPrompt, memoryContext].filter(Boolean).join('\n\n');
      }
      // Autonomous learning (B + C): behavior preferences learned from user
      // feedback and tool reliability stats derived from history.
      const learningContext = learningEngine?.buildLearningContext(projectId);
      if (learningContext && learningContext.trim()) {
        injectedLearningContext = learningContext;
        skillPrompt = [skillPrompt, learningContext].filter(Boolean).join('\n\n');
        resolvedSystemPrompt = [resolvedSystemPrompt, learningContext].filter(Boolean).join('\n\n');
      }
    } catch {
      // Memory injection must never break a chat turn.
    }

    // 任务2 Context Provenance：轻量记录本次请求装入了哪些 scope 的上下文
    //（项目/会话/场景、规则 digest、注入片段 digest），供事后诊断上下文串线；
    // 不保存隐藏推理链。记录失败绝不破坏对话。
    try {
      store?.recordContextProvenance({
        runId: requestId,
        sessionId,
        ...(projectId ? { projectId } : {}),
        provenance: buildContextProvenance({
          ...(projectId ? { projectId } : {}),
          sessionId,
          ...(resolvedManifest?.scenarioId ? { scenarioId: resolvedManifest.scenarioId } : {}),
          ...(resolvedManifest?.manifestDigest ? { ruleRevisions: [resolvedManifest.manifestDigest] } : {}),
          injectedParts: [
            ...(injectedMemoryContext ? [{ kind: 'memory', content: injectedMemoryContext }] : []),
            ...(injectedLearningContext ? [{ kind: 'learning', content: injectedLearningContext }] : []),
            ...(skillPrompt ? [{ kind: 'systemPrompt', content: skillPrompt }] : []),
          ],
        }),
      });
    } catch { /* provenance 必须不破坏对话 */ }

    let mcpToolRun: import('./PersonalizationMcpToolBridge.js').PersonalizationMcpToolRun | undefined;
    try {
      let runAgentLoop = requestAgentLoop;
      const availableTools = new Set(builtinToolNames());
      if (resolvedManifest?.mcpIds.length) {
        // 用户生成/市场生成的 stdio 配置（user: 前缀）没有安装记录、未激活、
        // 不提供工具。只从交给 MCP 桥的视图中剔除（manifest 本体保持原样，
        // 其 digest 覆盖原始内容），避免阻塞整个场景运行。
        const runtimeMcpIds = resolvedManifest.mcpIds.filter((id) => !id.startsWith('user:'));
        if (runtimeMcpIds.length !== resolvedManifest.mcpIds.length) {
          console.warn('[AgentChat] skipping inactive user-authored MCP definitions:', JSON.stringify(resolvedManifest.mcpIds.filter((id) => id.startsWith('user:'))));
        }
        if (!runtimeMcpIds.length) {
          // 没有可运行的已安装 MCP；直接使用内置工具继续。
        } else if (!personalizationMcpBridge) {
          console.warn('[AgentChat] rejected: personalization_mcp_unavailable');
          return createChatTurnErrorResponse(requestId, 'error', 'personalization_mcp_unavailable');
        } else {
          const prepared = await personalizationMcpBridge.prepare({
            manifest: { ...resolvedManifest, mcpIds: runtimeMcpIds },
            owner: managedMcpOwnerFor(event),
            sessionId: resolvedManifest.sessionId,
            projectId: resolvedManifest.projectId,
            reservedToolNames: [...availableTools],
            signal: activeRun.controller.signal,
          });
          if (!prepared.ok) {
            console.warn('[AgentChat] rejected: personalization_mcp_', prepared.code);
            return createChatTurnErrorResponse(requestId, 'error', `personalization_mcp_${prepared.code}`);
          }
          mcpToolRun = prepared.run;
          for (const name of mcpToolRun.toolNames) availableTools.add(name);
          runAgentLoop = createAgentLoop(
            requestProvider,
            new ToolRegistry(),
            approvalStore ?? undefined,
            mcpToolRun.registrations,
          ).agentLoop;
        }
      }
      if (resolvedManifest?.allowedTools.some((tool) => !availableTools.has(tool))) {
        const missing = resolvedManifest.allowedTools.filter((tool) => !availableTools.has(tool));
        console.warn('[AgentChat] rejected: personalization_tool_unavailable, missing:', JSON.stringify(missing));
        return createChatTurnErrorResponse(requestId, 'error', 'personalization_tool_unavailable');
      }
      const preferredAgentLoops = new Map<string, AgentLoop>();
      const agentLoopForModel = (modelPreference: string): AgentLoop => {
        const model = modelPreference.trim();
        if (!model || model === requestProvider.model || !requestConfig) return runAgentLoop;
        const existing = preferredAgentLoops.get(model);
        if (existing) return existing;
        const preferredProvider = createProvider({ ...requestConfig, model });
        const preferredLoop = createAgentLoop(
          preferredProvider,
          new ToolRegistry(),
          approvalStore ?? undefined,
          mcpToolRun?.registrations ?? [],
        ).agentLoop;
        preferredAgentLoops.set(model, preferredLoop);
        return preferredLoop;
      };
      const executionEvents = new AgentExecutionEventBridge({
        sessionId,
        turnId: requestId,
        publish: (payload) => {
          // A reconfigured/cancelled run is removed before its old provider
          // can return. Never let a stale hook publish into a newer turn.
          if (activeChatRuns.get(sessionId) !== activeRun || event.sender.isDestroyed()) return;
          store?.appendAgentEvent(payload);
          // 2026-09-05 僵尸 run 修复：终态 lifecycle 事件在这里同步写 run 终态。
          // 场景工作流等路径的 await 可能永远不返回到 runPersistedChatTurn 的
          // 收尾（挂起的调用不检查取消信号），只有这一层能保证 agent_runs
          // 不再永远停留在 running。重复写终态是幂等 UPDATE，无害。
          if (payload.event.type === 'lifecycle') {
            const statusForPhase: Record<string, string> = {
              completed: 'completed',
              interrupted: 'interrupted',
              cancelled: 'cancelled',
              failed: 'error',
            };
            const runStatus = statusForPhase[payload.event.phase];
            if (runStatus) {
              store?.finishAgentRun({
                runId: payload.runId,
                sessionId: payload.sessionId,
                status: runStatus,
                terminalReason: payload.event.summary,
              });
            }
          }
          event.sender.send('agent:execution-event', payload);
        },
      });
      activeRun.executionEvents = executionEvents;
      executionEvents.attach(runAgentLoop);
      // Stream the model's tokens (and reasoning, when the model emits it) to
      // the requesting renderer. Registered on the loop that actually runs so
      // MCP-expanded loops stream too; unregistered when the turn settles.
      const forwardModelStream = (
        ctx: import('../engine/core/HookBus.js').HookContext,
      ): import('../engine/core/HookBus.js').HookContext => {
        const payload = ctx as unknown as {
          sessionId?: unknown; content?: unknown; reasoning?: unknown; isFinished?: unknown;
        };
        try {
          if (event.sender.isDestroyed()) return ctx;
          event.sender.send('chat:stream-chunk', {
            turnId: requestId,
            sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : sessionId,
            content: typeof payload.content === 'string' ? payload.content : '',
            reasoning: typeof payload.reasoning === 'string' ? payload.reasoning : undefined,
            isFinished: payload.isFinished === true,
          });
        } catch { /* stream forwarding must never break the turn */ }
        return ctx;
      };
      // 场景工作流运行不向聊天流转发模型 token 流（2026-08-30 刘总要求）：
      // 31 步工作流每步产出动辄数万字，整段流进聊天正是「过程性内容占满
      // 聊天」的最后一环。步骤进度由执行事件桥（agent-execution-*）与每步
      // 完成后的摘要消息承载；普通聊天与 Goal 轮保留原有流式体验。
      const isScenarioWorkflowRun = scenarioCompilation?.useCoordinator === true;
      if (!isScenarioWorkflowRun) {
        runAgentLoop.registerHook('model.stream_chunk', forwardModelStream, { name: 'chat-stream-forward' });
      }
      console.log('[AgentChat] dispatching scenario workflow runner');
      try {
        // Public Scenario pause/cancel admission: dedicated controllers keep the
        // public control contract separate from the plain interrupt signal.
        activeRun.scenarioPause = new AbortController();
        activeRun.scenarioCancel = new AbortController();
        const scenarioRuntime = scenarioCompilation.useCoordinator
          && resolvedManifest
          && resolvedSystemPrompt
          && personalizationRepository
          ? { manifest: resolvedManifest, repository: personalizationRepository }
          : null;
        // 场景运行 → 任务看板接通（2026-08-28 刘总要求）：仅真实进入
        // 持久化场景协调器的执行才创建卡片，避免普通对话被误标为场景任务。
        let scenarioRunGoalId: string | null = null;
        if (scenarioRuntime) {
          try {
            const runScenarioId = scenarioRuntime.manifest.scenarioId;
            const runScenarioName = scenarioRuntime.repository.get(runScenarioId)?.name ?? runScenarioId;
            const runGoal = goalEngine?.createGoal(
              `场景工作流：${runScenarioName}`,
              undefined,
              scenarioRuntime.manifest.projectId ?? projectId,
            );
            scenarioRunGoalId = runGoal?.id ?? null;
            if (scenarioRunGoalId) {
              goalEngine?.setStatus(scenarioRunGoalId, 'running');
              if (runGoal) broadcastGoalChanged(event.sender, runGoal, 'running');
            }
          } catch { /* 任务卡片创建失败不阻断运行 */ }
        }
        const response = scenarioRuntime
          ? await runPersistedScenarioWorkflow({
              agentLoop: runAgentLoop,
              agentLoopForModel,
              store,
              repository: scenarioRuntime.repository,
              sessionId,
              messages,
              requestId,
              manifest: scenarioRuntime.manifest,
              mode,
              signal: activeRun.controller.signal,
              pauseSignal: activeRun.scenarioPause.signal,
              cancelSignal: activeRun.scenarioCancel.signal,
              liveSteering: liveSteeringQueue,
              projectId: scenarioRuntime.manifest.projectId ?? projectId,
              researchRepository: researchRepository ?? undefined,
              literatureBridge: getScenarioLiteratureBridge(),
              isCurrentRuntime: () => runtimeGeneration === requestRuntimeGeneration,
              // 场景 Hook（场景重构 P4）：审批默认拒绝，异常时 fail closed；
              // 审批窗口实现位于 IPC 处理器外，避免交互分支污染 agent:chat 安全边界。
              hookApproval: (input) => resolveScenarioHookApproval(event, input),
              hookEvent: (hookEvent) => {
                console.log(`[ScenarioHook] ${hookEvent.event} ${hookEvent.action} hook=${hookEvent.hookId} step=${hookEvent.stepId ?? '-'} run=${hookEvent.runId}`);
              },
            })
          : await runPersistedChatTurn({
              agentLoop: runAgentLoop,
              store,
              sessionId,
              messages,
              requestId,
              skillPrompt,
              allowedTools,
              maxTurns,
              taskContractHash,
              promptStackHash,
              fullAccess,
              signal: activeRun.controller.signal,
              liveSteering: liveSteeringQueue,
              options: { mode },
              projectId,
              isCurrentRuntime: () => runtimeGeneration === requestRuntimeGeneration,
              beforeFinish: (status) => executionEvents.finish(status),
            });

        executionEvents.finish(response.status);
        if (scenarioRunGoalId) {
          try {
            const finalStatus = response.status === 'completed'
              ? 'completed'
              : response.status === 'cancelled'
                ? 'cancelled'
                : response.status === 'interrupted'
                  ? 'paused'
                  : 'failed';
            goalEngine?.setStatus(scenarioRunGoalId, finalStatus);
            const finalGoal = goalEngine?.getGoal(scenarioRunGoalId);
            if (finalGoal) broadcastGoalChanged(event.sender, finalGoal);
          } catch { /* 状态同步失败不影响返回 */ }
        }
        // 场景运行成果自动落库（2026-08-28 刘总要求；2026-08-31 修正）：工作流
        // 成功跑完后，把最终产出写为该项目的正式成果（已存在则追加新版本），
        // 保证生成物在科研项目的工作流/成果视图中可见，而不是只留在会话流里。
        // 2026-08-31 修正点：①数据源从「聊天最后一条消息」换成最终交付包正文
        // （response.answer 在 bundle 场景即 primary 全文）——此前聊天里只有
        // 摘要，建出来的成果是摘要段落堆；②按双换行切段换成 Markdown 结构化
        // 转换（标题层级/列表/表格/引用保真），成果真正排版成形。
        // 2026-09-01 刘总建议（来源标记）：场景产出统一挂「科研产出」保留分类，
        // 成果页按分类分区展示，一眼可辨哪些是工作流产出；旧的无分类成果补挂标记。
        if (scenarioRuntime && response.status === 'completed' && projectId && outcomeRepository && store) {
          try {
            const SCENARIO_CATEGORY_ID = 'cat-scenario-output';
            if (!store.raw.prepare('SELECT id FROM outcome_categories WHERE id = ?').get(SCENARIO_CATEGORY_ID)) {
              store.raw.prepare(
                'INSERT INTO outcome_categories (id, name, sort_order, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
              ).run(SCENARIO_CATEGORY_ID, '科研产出', Date.now(), Date.now());
            }
            const history = store.getMessages(sessionId);
            const finalMessage = [...history].reverse().find((m) => m.role === 'assistant' && m.content.trim().length > 0);
            const deliverableMarkdown = (typeof response.answer === 'string' && response.answer.trim())
              ? response.answer
              : (finalMessage?.content ?? '');
            if (deliverableMarkdown.trim()) {
              const { markdownToWordDocument } = await import('../engine/export/MarkdownToWordDocument.js');
              const deliverableContent = markdownToWordDocument(deliverableMarkdown);
              if (deliverableContent.blocks.length === 0) throw new Error('deliverable_blocks_empty');
              const runScenarioId = scenarioRuntime.manifest.scenarioId;
              const runScenarioName = scenarioRuntime.repository.get(runScenarioId)?.name ?? runScenarioId;
              const deliverableTitle = `${runScenarioName} 交付物`.slice(0, 200);
              const existing = outcomeRepository.list(projectId).find((item) => item.title === deliverableTitle);
              if (existing) {
                if (!existing.categoryId) {
                  outcomeRepository.move(projectId, existing.id, SCENARIO_CATEGORY_ID);
                  console.log(`[ScenarioRun] outcome ${existing.id} retagged to 科研产出`);
                }
                const detail = outcomeRepository.get(projectId, existing.id);
                if (detail) {
                  const saved = outcomeRepository.save({
                    projectId,
                    outcomeId: existing.id,
                    baseVersion: detail.outcome.currentVersion,
                    content: deliverableContent,
                    note: `场景工作流产出 ${new Date().toLocaleString('zh-CN')}`,
                    actor: 'ai',
                    sources: [],
                  });
                  console.log(`[ScenarioRun] deliverable appended to outcome ${existing.id}: v${saved.version.version}`);
                }
              } else {
                const created = outcomeRepository.create({
                  projectId,
                  categoryId: SCENARIO_CATEGORY_ID,
                  title: deliverableTitle,
                  kind: 'word',
                  content: deliverableContent,
                  note: '场景工作流产出（自动创建）',
                  actor: 'ai',
                });
                console.log(`[ScenarioRun] deliverable outcome created: ${created.outcome.id}`);
              }
            }
          } catch (deliverableError) {
            console.warn('[ScenarioRun] deliverable persistence failed:', deliverableError instanceof Error ? deliverableError.message : deliverableError);
          }
        }
        return response;
      } finally {
        if (!isScenarioWorkflowRun) {
          runAgentLoop.unregisterHook('model.stream_chunk', 'chat-stream-forward');
        }
        executionEvents.dispose();
        if (activeRun.executionEvents === executionEvents) activeRun.executionEvents = undefined;
      }
    } catch (error) {
      console.error('[Main] agent chat failed:', error);
      return createChatTurnErrorResponse(requestId, 'error', 'agent_chat_failed');
    } finally {
      await mcpToolRun?.close();
      // Autonomous learning after each turn (never blocks the response):
      // A — extract durable knowledge into memory; B — persist feedback
      // signals as behavior preferences; C — flush tool reliability stats.
      if (learningEngine) {
        void (async () => {
          try {
            await learningEngine.ingestConversation(messages, projectId);
            learningEngine.applyFeedbackSignals(messages, projectId);
            learningEngine.persistToolStats();
          } catch { /* learning must never break a chat turn */ }
        })();
      }
      if (activeChatRuns.get(sessionId) === activeRun) {
        activeChatRuns.delete(sessionId);
        liveSteeringQueue.clear(sessionId);
      }
      activeFundingToolScopes.delete(sessionId);
      activeRun.resolveCompletion();
    }
  });

  // ── O15: 多模型同会话对比（指定 profile 的临时回合） ─────────
  // 渲染端在「多模型对比」模式下对选中的每个 profile 并行调用一次本处理器；
  // 这里用 ProviderProfileStore.configFor(profileId) 解密出完整配置，构建
  // 临时 provider + AgentLoop 跑一轮。与 agent:chat 的差异：
  //   - 不在主进程落库（对比的 N 个并行调用若各自落库会把用户消息写 N 遍，
  //     持久化由渲染端统一做一次）；
  //   - 不参与 scenario / 个性化清单 / MCP 工具扩展（对比的目标是同一提示下
  //     不同模型的原始回答，变量越少越公平）；
  //   - 流式分片额外带 profileId，渲染端按模型路由到各自的气泡。
  ipcMain.handle('agent:chatWithProfile', async (
    event,
    rawProfileId: unknown,
    rawSessionId: unknown,
    rawMessages: unknown,
    rawSkillId?: unknown,
    rawOptions?: unknown,
  ) => {
    const requestId = `chatcmp_${++requestCounter}`;
    try {
      requireRendererMainFrame(event);
    } catch {
      return createChatTurnErrorResponse(requestId, 'error', 'unauthorized_renderer');
    }
    if (runtimeShutdown.isDraining()) {
      return createChatTurnErrorResponse(requestId, 'error', 'application_shutting_down');
    }
    if (!providerProfileStore || !store) {
      console.error('[Main] profile chat is unavailable');
      return createChatTurnErrorResponse(requestId, 'error', 'agent_not_initialized');
    }
    const profileIdParsed = ProviderProfileIdSchema.safeParse(rawProfileId);
    if (!profileIdParsed.success) {
      return createChatTurnErrorResponse(requestId, 'error', 'invalid_chat_request');
    }
    const profileId = profileIdParsed.data;

    const request = AgentChatRequestSchema.safeParse({
      version: CHAT_RUNTIME_CONTRACT_VERSION,
      turnId: requestId,
      sessionId: rawSessionId,
      messages: rawMessages,
      skillId: rawSkillId,
      projectId: typeof rawOptions === 'object' && rawOptions !== null
        ? (rawOptions as { projectId?: unknown }).projectId
        : undefined,
      mode: typeof rawOptions === 'object' && rawOptions !== null
        ? (rawOptions as { mode?: unknown }).mode
        : undefined,
    });
    if (!request.success) {
      return createChatTurnErrorResponse(requestId, 'error', 'invalid_chat_request');
    }
    const { sessionId, messages, skillId, projectId } = request.data;

    // 与正常回合同会话互斥；同一 profile 的重复并发也要拦住。
    if (activeChatRuns.has(sessionId)) {
      return createChatTurnErrorResponse(requestId, 'error', 'agent_run_active');
    }
    const runKey = `${sessionId}::${profileId}`;
    if (activeCompareRuns.has(runKey)) {
      return createChatTurnErrorResponse(requestId, 'error', 'agent_run_active');
    }

    const configResult = providerProfileStore.configFor(profileId);
    if (!configResult.ok || !configResult.value.apiKey) {
      return createChatTurnErrorResponse(requestId, 'error', 'profile_unavailable');
    }
    const profileConfig = configResult.value;

    // 与正常聊天一致：指定了 skill 时注入其系统提示。
    let skillPrompt: string | undefined;
    if (skillId && skillRegistry) {
      const skill = skillRegistry.get(skillId);
      if (skill) {
        skillPrompt = skill.systemPrompt;
      }
    }

    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const compareRun: ActiveCompareRun = {
      ownerWebContentsId: event.sender.id,
      controller: new AbortController(),
      completion,
      resolveCompletion,
    };
    activeCompareRuns.set(runKey, compareRun);
    const unregisterCompareRun = registerRuntimeRunOrRollback(
      runtimeShutdown,
      {
        id: `compare:${runKey}`,
        promise: compareRun.completion,
        abort: () => compareRun.controller.abort(),
      },
      () => {
        if (activeCompareRuns.get(runKey) === compareRun) {
          activeCompareRuns.delete(runKey);
        }
        compareRun.resolveCompletion();
      },
    );
    if (!unregisterCompareRun) {
      return createChatTurnErrorResponse(requestId, 'error', 'application_shutting_down');
    }
    try {
      const compareProvider = createProvider(profileConfig);
      const compareLoop = createAgentLoop(
        compareProvider,
        buildRuntimeRegistry(),
        approvalStore ?? undefined,
        [],
        profileConfig,
      ).agentLoop;
      // 流式转发：与正常回合同一个通道，但额外带 profileId 供渲染端按模型
      // 分气泡；转发失败绝不能打断回合。
      const forwardCompareStream = (
        ctx: import('../engine/core/HookBus.js').HookContext,
      ): import('../engine/core/HookBus.js').HookContext => {
        const payload = ctx as unknown as {
          sessionId?: unknown; content?: unknown; reasoning?: unknown; isFinished?: unknown;
        };
        try {
          if (event.sender.isDestroyed()) return ctx;
          event.sender.send('chat:stream-chunk', {
            turnId: requestId,
            sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : sessionId,
            content: typeof payload.content === 'string' ? payload.content : '',
            reasoning: typeof payload.reasoning === 'string' ? payload.reasoning : undefined,
            isFinished: payload.isFinished === true,
            profileId,
          });
        } catch { /* stream forwarding must never break the turn */ }
        return ctx;
      };
      compareLoop.registerHook('model.stream_chunk', forwardCompareStream, { name: 'chat-compare-stream-forward' });
      try {
        return await runEphemeralChatTurn({
          agentLoop: compareLoop,
          sessionId,
          messages,
          requestId,
          skillPrompt,
          signal: compareRun.controller.signal,
          projectId,
        });
      } finally {
        compareLoop.unregisterHook('model.stream_chunk', 'chat-compare-stream-forward');
      }
    } catch {
      console.error('[Main] profile chat failed');
      return createChatTurnErrorResponse(requestId, 'error', 'agent_chat_failed');
    } finally {
      if (activeCompareRuns.get(runKey) === compareRun) {
        activeCompareRuns.delete(runKey);
      }
      compareRun.resolveCompletion();
    }
  });

  // 步骤卡控制（2026-09-01 刘总方案二期）：对已完成/中断运行的某一步做
  // 「指导重做 / 跳过」。纯函数改记录（completed 记录不可变 → 派生续作分支），
  // 落库后由前端补发「继续」触发恢复；运行中的会话拒绝操作（防竞态）。
  ipcMain.handle('scenario:stepControl', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = (typeof rawRequest === 'object' && rawRequest !== null ? rawRequest : {}) as {
        sessionId?: unknown; stepId?: unknown; action?: unknown; guidance?: unknown;
      };
      const sessionId = typeof request.sessionId === 'string' ? request.sessionId : '';
      const stepId = typeof request.stepId === 'string' ? request.stepId.slice(0, 160) : '';
      const action = request.action === 'redo' || request.action === 'skip' ? request.action : null;
      const guidance = typeof request.guidance === 'string' ? request.guidance.slice(0, 2_000) : undefined;
      if (!sessionId || !stepId || !action || !personalizationRepository) {
        return { ok: false as const, code: 'invalid_request', message: 'sessionId/stepId/action are required' };
      }
      const activeRun = activeChatRuns.get(sessionId);
      if (activeRun && (activeRun.scenarioPause?.signal.aborted === false || activeRun.scenarioCancel && !activeRun.scenarioCancel.signal.aborted)) {
        return { ok: false as const, code: 'run_in_progress', message: '场景正在执行，等当前步骤完成后再操作' };
      }
      const record = personalizationRepository.getRecoverableScenarioRun(sessionId)
        ?? personalizationRepository.listScenarioRunRecords(sessionId)[0];
      if (!record) return { ok: false as const, code: 'no_run_record', message: '该会话没有场景运行记录' };
      const result = applyStepControl(record, { action, stepId, ...(guidance !== undefined ? { guidance } : {}) });
      if (!result.ok) return result;
      personalizationRepository.saveScenarioRunRecord(result.record);
      console.log(`[ScenarioRun] step control ${action} applied: session=${sessionId.slice(0, 40)} step=${stepId} run=${result.record.runId}`);
      return { ok: true as const, runId: result.record.runId, message: result.message };
    } catch (error) {
      console.warn('[scenario:stepControl] failed:', error instanceof Error ? error.message : error);
      return { ok: false as const, code: 'step_control_failed', message: error instanceof Error ? error.message : 'unknown' };
    }
  });

  ipcMain.handle('agent:control', (event, rawRequest: unknown) => {
    let operationId = 'control-recovery';
    try {
      requireRendererMainFrame(event);
      if (typeof rawRequest === 'object' && rawRequest !== null) {
        const candidate = (rawRequest as { operationId?: unknown }).operationId;
        if (typeof candidate === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(candidate)) {
          operationId = candidate;
        }
      }
      const request = AgentControlRequestSchema.safeParse(rawRequest);
      if (!request.success) {
        return decodeAgentControlResponse({
          ok: false,
          contractVersion: LIVE_STEERING_CONTRACT_VERSION,
          operationId,
          code: 'invalid_request',
        }, operationId);
      }
      operationId = request.data.operationId;
      const run = activeChatRuns.get(request.data.sessionId);
      if (!run) {
        // 无痕失败禁令（2026-08-29 刘总报告「中断后无法继续」）：应用重启后
        // 内存运行注册表清空而数据库状态仍为 running，前端会误走实时引导；
        // 这里必须留下可查日志。
        console.warn(`[Main] agent:control ${request.data.action} rejected: no_active_run session=${request.data.sessionId}`);
        return decodeAgentControlResponse({
          ok: false,
          contractVersion: LIVE_STEERING_CONTRACT_VERSION,
          operationId,
          code: 'no_active_run',
        }, operationId);
      }
      if (run.ownerWebContentsId !== event.sender.id) {
        console.warn(`[Main] agent:control ${request.data.action} rejected: owner_mismatch session=${request.data.sessionId}`);
        return decodeAgentControlResponse({
          ok: false,
          contractVersion: LIVE_STEERING_CONTRACT_VERSION,
          operationId,
          code: 'owner_mismatch',
        }, operationId);
      }
      const sequence = run.nextSequence + 1;
      try {
        liveSteeringQueue.enqueue(request.data.action === 'instruction'
          ? {
              type: 'instruction',
              id: `steer-${randomUUID()}`,
              sessionId: request.data.sessionId,
              sequence,
              createdAt: Date.now(),
              content: request.data.content,
            }
          : {
              type: 'interrupt',
              id: `interrupt-${randomUUID()}`,
              sessionId: request.data.sessionId,
              sequence,
              createdAt: Date.now(),
              reason: request.data.reason,
            });
      } catch {
        return decodeAgentControlResponse({
          ok: false,
          contractVersion: LIVE_STEERING_CONTRACT_VERSION,
          operationId,
          code: 'queue_unavailable',
        }, operationId);
      }
      run.nextSequence = sequence;
      if (request.data.action === 'instruction') {
        try {
          store?.appendMessage(request.data.sessionId, 'user', request.data.content);
        } catch (error) {
          console.error('[Main] live steering persistence failed', error);
        }
      } else {
        run.controller.abort();
      }
      return decodeAgentControlResponse({
        ok: true,
        contractVersion: LIVE_STEERING_CONTRACT_VERSION,
        operationId,
        action: request.data.action,
        sequence,
      }, operationId);
    } catch {
      return decodeAgentControlResponse({
        ok: false,
        contractVersion: LIVE_STEERING_CONTRACT_VERSION,
        operationId,
        code: 'queue_unavailable',
      }, operationId);
    }
  });

  // ── Public Scenario run control (pause / cancel) ─────────
  // pause: durable paused checkpoint, the next turn resumes it.
  // cancel: terminal cancelled; late provider results cannot revive the run.
  ipcMain.handle('scenario:control', (event, rawRequest: unknown) => {
    let operationId = 'scenario-control-recovery';
    try {
      requireRendererMainFrame(event);
      if (typeof rawRequest === 'object' && rawRequest !== null) {
        const candidate = (rawRequest as { operationId?: unknown }).operationId;
        if (typeof candidate === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(candidate)) {
          operationId = candidate;
        }
      }
      const request = ScenarioRunControlRequestSchema.safeParse(rawRequest);
      if (!request.success) {
        return decodeScenarioRunControlResponse({
          ok: false,
          contractVersion: SCENARIO_CONTROL_CONTRACT_VERSION,
          operationId,
          code: 'invalid_request',
        }, operationId);
      }
      operationId = request.data.operationId;
      // Shutdown admission follows the trackEphemeralOperation pattern: control
      // requests arriving while the runtime drains are rejected, never half-applied.
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `scenario:control:${operationId}`,
        rejection: decodeScenarioRunControlResponse({
          ok: false,
          contractVersion: SCENARIO_CONTROL_CONTRACT_VERSION,
          operationId,
          code: 'application_shutting_down',
        }, operationId),
      });
      if (!tracked.admitted) return tracked.rejection;
      try {
        const run = activeChatRuns.get(request.data.sessionId);
        if (run && run.ownerWebContentsId !== event.sender.id) {
          return decodeScenarioRunControlResponse({
            ok: false,
            contractVersion: SCENARIO_CONTROL_CONTRACT_VERSION,
            operationId,
            code: 'owner_mismatch',
          }, operationId);
        }
        if (request.data.action === 'pause') {
          if (run?.scenarioPause) {
            run.scenarioPause.abort();
            return decodeScenarioRunControlResponse({
              ok: true,
              contractVersion: SCENARIO_CONTROL_CONTRACT_VERSION,
              operationId,
              action: 'pause',
              code: 'pause_requested',
            }, operationId);
          }
          const recoverable = personalizationRepository?.getRecoverableScenarioRun(request.data.sessionId);
          if (recoverable?.status === 'paused') {
            return decodeScenarioRunControlResponse({
              ok: true,
              contractVersion: SCENARIO_CONTROL_CONTRACT_VERSION,
              operationId,
              action: 'pause',
              code: 'already_paused',
            }, operationId);
          }
          return decodeScenarioRunControlResponse({
            ok: false,
            contractVersion: SCENARIO_CONTROL_CONTRACT_VERSION,
            operationId,
            code: 'no_active_run',
          }, operationId);
        }
        if (run?.scenarioCancel) {
          run.scenarioCancel.abort();
          return decodeScenarioRunControlResponse({
            ok: true,
            contractVersion: SCENARIO_CONTROL_CONTRACT_VERSION,
            operationId,
            action: 'cancel',
            code: 'cancel_requested',
          }, operationId);
        }
        // No active run: cancel still applies to a persisted non-terminal
        // checkpoint (paused / crash-interrupted), keeping cancelled terminal.
        const recoverable = personalizationRepository?.getRecoverableScenarioRun(request.data.sessionId);
        if (recoverable) {
          const terminated = terminateStoredScenarioRun(recoverable, 'cancelled');
          if (terminated.ok && personalizationRepository) {
            personalizationRepository.saveScenarioRunRecord(terminated.record);
            return decodeScenarioRunControlResponse({
              ok: true,
              contractVersion: SCENARIO_CONTROL_CONTRACT_VERSION,
              operationId,
              action: 'cancel',
              code: 'cancel_requested',
            }, operationId);
          }
          return decodeScenarioRunControlResponse({
            ok: false,
            contractVersion: SCENARIO_CONTROL_CONTRACT_VERSION,
            operationId,
            code: 'scenario_control_unavailable',
          }, operationId);
        }
        return decodeScenarioRunControlResponse({
          ok: false,
          contractVersion: SCENARIO_CONTROL_CONTRACT_VERSION,
          operationId,
          code: 'no_cancellable_run',
        }, operationId);
      } finally {
        tracked.cleanup();
      }
    } catch {
      return decodeScenarioRunControlResponse({
        ok: false,
        contractVersion: SCENARIO_CONTROL_CONTRACT_VERSION,
        operationId,
        code: 'scenario_control_unavailable',
      }, operationId);
    }
  });

  // ── Acceptance ───────────────────────────────────────────
  ipcMain.handle('acceptance:environment', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window !== mainWindow || window.isDestroyed()) {
      throw new Error('Layout acceptance environment request did not originate from the main window');
    }
    if (!event.senderFrame || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Layout acceptance environment request did not originate from the main frame');
    }
    if (
      layoutAcceptanceToken &&
      !isExpectedLayoutAcceptanceFrame(event.senderFrame.url, layoutAcceptanceEntryPath)
    ) {
      throw new Error('Layout acceptance environment request did not originate from the current dist entry');
    }
    return getLayoutAcceptanceMetadata();
  });

  if (layoutAcceptanceToken) {
    layoutAcceptanceWindowControlEnabled = true;
    ipcMain.handle('acceptance:window:setSize', async (event, rawRequest: unknown) => {
      const window = requireLayoutAcceptanceMainFrame(event);
      const request = parseLayoutAcceptanceWindowRequest(rawRequest);

      if (window.isMaximized() || window.isFullScreen()) {
        window.restore();
      }
      if (request.mode === 'content') {
        await setAcceptanceContentSize(
          window,
          request.width,
          request.height,
        );
      } else {
        await waitForNativeWindowResize(window, () => {
          window.setSize(request.width, request.height, false);
        });
      }

      const outerBounds = window.getBounds();
      const contentBounds = window.getContentBounds();
      const display = screen.getDisplayMatching(outerBounds);
      return {
        mode: request.mode,
        requested: {
          width: request.width,
          height: request.height,
        },
        outerBounds,
        contentBounds,
        zoomFactor: window.webContents.getZoomFactor(),
        display: {
          id: String(display.id),
          scaleFactor: display.scaleFactor,
          bounds: display.bounds,
          workArea: display.workArea,
        },
        maximized: window.isMaximized(),
        fullScreen: window.isFullScreen(),
      };
    });
    ipcMain.handle('acceptance:window:release', (event) => {
      requireLayoutAcceptanceMainFrame(event);
      layoutAcceptanceWindowControlEnabled = false;
      ipcMain.removeHandler('acceptance:window:setSize');
      ipcMain.removeHandler('acceptance:window:release');
      return { released: true };
    });
  }

  // ── Agent Status ────────────────────────────────────────
  ipcMain.handle('agent:status', () => {
    if (!provider) {
      return { provider: 'not_configured' };
    }
    const caps = provider.capabilities();
    return {
      provider: 'ready',
      model: caps.model,
      streaming: caps.streaming,
      nativeToolCalling: caps.nativeToolCalling,
      maxContextTokens: caps.maxContextTokens,
      maxOutputTokens: caps.maxOutputTokens,
      agentLoopReady: agentLoop !== null,
    };
  });

  // ── Papers ──────────────────────────────────────────────
  ipcMain.handle('paper:list', (event) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      return decodeLibraryPaperList((store?.getPapers() ?? []).map((paper) => presentPaper(paper, owner)));
    } catch {
      return [];
    }
  });
  ipcMain.handle('paper:attachPdf', async (event, rawRequest: unknown) => {
    try {
      const window = requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      const request = decodePaperIdRequest(rawRequest);
      if (!request.ok || !store) return createPaperAttachmentFailure();
      const paper = store.getPapers().find((item) => item.id === request.value.paperId);
      if (!paper) return createPaperAttachmentFailure();
      const selected = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      const filePath = selected.canceled ? undefined : selected.filePaths[0];
      if (!filePath || !(await isPdfFile(filePath))) return createPaperAttachmentFailure();
      store.savePaper({ ...paper, pdfPath: filePath, pdfText: '' });
      const issued = fileCapabilities.issue({
        path: filePath,
        kind: 'file',
        mime: 'application/pdf',
        operations: ['file', 'read', 'extract'],
      }, owner);
      return issued.success
        ? decodePaperAttachmentResult({ success: true, pdfCapability: issued.capability })
        : createPaperAttachmentFailure();
    } catch {
      return createPaperAttachmentFailure();
    }
  });
  ipcMain.handle('paper:detachPdf', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodePaperIdRequest(rawRequest);
      if (!request.ok || !store) return createPaperMutationFailure();
      const paper = store.getPapers().find((item) => item.id === request.value.paperId);
      if (!paper) return createPaperMutationFailure();
      store.savePaper({ ...paper, pdfPath: undefined, pdfText: '' });
      return decodePaperMutationResult({ success: true, code: 'detached' });
    } catch {
      return createPaperMutationFailure();
    }
  });
  ipcMain.handle('paper:save', (event, rawPaper: unknown) => {
    try {
      requireRendererMainFrame(event);
      const paper = decodeLibraryPaperSaveRequest(rawPaper);
      if (!store || !paper) return createLibraryMutationFailure();
      const existing = store.getPapers().find((item) => item.id === paper.id);
      store.savePaper({
        id: paper.id,
        title: paper.title,
        authors: paper.authors,
        year: paper.year,
        venue: paper.venue,
        abstract: paper.abstract,
        ...(paper.doi === undefined ? {} : { doi: paper.doi }),
        ...(paper.arxivId === undefined ? {} : { arxivId: paper.arxivId }),
        ...(existing?.pdfPath === undefined ? {} : { pdfPath: existing.pdfPath }),
        ...(paper.pdfUrl === undefined ? {} : { pdfUrl: paper.pdfUrl }),
        ...(paper.pdfText === undefined ? {} : { pdfText: paper.pdfText }),
        ...(paper.citationCount === undefined ? {} : { citationCount: paper.citationCount }),
        tags: paper.tags,
        notes: paper.notes,
        readStatus: paper.readStatus,
        rating: paper.rating,
        ...(existing?.projectId === undefined ? {} : { projectId: existing.projectId }),
        addedAt: paper.addedAt,
      });
      return decodeLibraryMutationResult({ success: true, code: 'saved' });
    } catch {
      return createLibraryMutationFailure();
    }
  });
  ipcMain.handle('paper:delete', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeLibraryDeleteRequest({ id: rawId });
      if (!request || !store) return createLibraryMutationFailure();
      store.deletePaper(request.id);
      return decodeLibraryMutationResult({ success: true, code: 'deleted' });
    } catch {
      return createLibraryMutationFailure();
    }
  });
  ipcMain.handle('paper:linkToProject', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { paperId?: unknown; projectId?: unknown; link?: unknown };
      const paperId = typeof request?.paperId === 'string' ? request.paperId : '';
      if (!paperId || !store) return { ok: false, error: 'invalid_request' };
      const paper = store.getPapers().find((item) => item.id === paperId);
      if (!paper) return { ok: false, error: 'not_found' };
      const projectId = typeof request?.projectId === 'string' ? request.projectId : '';
      if (!projectId) return { ok: false, error: 'invalid_request' };
      const link = request?.link !== false;
      if (!link) {
        if (!researchRepository) return { ok: false, error: 'repository_unavailable' };
        const removed = researchRepository.unlinkLibraryPaperFromProject(paperId, projectId);
        return removed ? { ok: true } : { ok: false, error: 'not_linked' };
      }
      const linked = linkPaperToProjectSource({
        id: paper.id,
        title: paper.title,
        authors: paper.authors,
        year: paper.year,
        venue: paper.venue,
        doi: paper.doi,
        arxivId: paper.arxivId,
      }, projectId);
      return linked ? { ok: true } : { ok: false, error: 'project_not_found' };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });
  ipcMain.handle('paper:downloadPdf', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      const request = decodePaperIdRequest(rawRequest);
      if (!request.ok || !store) return createPaperDownloadFailure();
      const paper = store.getPapers().find((item) => item.id === request.value.paperId);
      if (!paper) return createPaperDownloadFailure();
      const title = paper.title
        // eslint-disable-next-line no-control-regex -- filesystem display names must reject control characters
        .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 180) || 'paper';

      // O3: multi-source PDF fallback. Collect ordered candidates
      // (Unpaywall → arXiv → existing pdfUrl) and try each until one succeeds.
      const candidates = await collectPdfCandidates({
        doi: paper.doi || undefined,
        arxivId: paper.arxivId || undefined,
        pdfUrl: paper.pdfUrl || undefined,
      });
      if (candidates.length === 0) return createPaperDownloadFailure();

      let downloaded: { ok: true; resolvedPath: string; publicResult: { displayName: string; byteLength: number; sha256: string } } | { ok: false } = { ok: false };
      // O3: transparent per-source attempt log (JabRef Event Log style).
      const attemptLog: Array<{ url: string; ok: boolean }> = [];
      for (const candidateUrl of candidates) {
        const attempt = await secureDownloads.download({
          mode: 'clean-url' as const,
          url: candidateUrl,
          resource: 'pdf',
          maxBytes: 128 * 1024 * 1024,
          timeoutMs: 60_000,
          maxRedirects: 4,
        }, {
          directory: PAPERS_DIR,
          displayName: `${title}.pdf`,
        });
        attemptLog.push({ url: candidateUrl, ok: attempt.ok });
        if (attempt.ok) {
          downloaded = attempt;
          break;
        }
      }
      if (!downloaded.ok) {
        // Surface which sources were tried so the user can diagnose (e.g. an
        // anti-leech rejection on one origin but not another).
        console.warn(`[paper:downloadPdf] all ${attemptLog.length} source(s) failed for ${paper.id}:`,
          attemptLog.map((a) => `${a.url} → ${a.ok ? 'ok' : 'failed'}`).join('; '));
        return createPaperDownloadFailure();
      }
      store.savePaper({ ...paper, pdfPath: downloaded.resolvedPath, pdfText: '' });
      const issued = fileCapabilities.issue({
        path: downloaded.resolvedPath,
        kind: 'file',
        mime: 'application/pdf',
        displayName: downloaded.publicResult.displayName,
        operations: ['file', 'read', 'extract'],
      }, owner);
      if (!issued.success) return createPaperDownloadFailure();
      return decodePaperDownloadResult({
        success: true,
        code: 'paper_download_complete',
        pdfCapability: issued.capability,
        displayName: downloaded.publicResult.displayName,
        byteLength: downloaded.publicResult.byteLength,
        sha256: downloaded.publicResult.sha256,
      });
    } catch {
      return createPaperDownloadFailure();
    }
  });

  // O4: re-match a collected paper's metadata from a user-supplied DOI or title.
  // Used by the "补全元数据" affordance when collection yielded no DOI/PDF.
  ipcMain.handle('paper:reconcile', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { paperId?: string; doi?: string; title?: string };
      if (!request || typeof request !== 'object' || !request.paperId || !store) {
        return { ok: false, error: 'invalid_request' };
      }
      const paper = store.getPapers().find((item) => item.id === request.paperId);
      if (!paper) return { ok: false, error: 'paper_not_found' };

      const doiInput = (request.doi ?? '').trim().replace(/^https?:\/\/doi\.org\//i, '').replace(/^doi:\s*/i, '');
      const titleInput = (request.title ?? '').trim();

      let resolvedDoi: string | undefined;
      if (doiInput && /^10\./.test(doiInput)) {
        resolvedDoi = doiInput;
      } else if (titleInput.length >= 5) {
        // Search CrossRef by title and accept a high-overlap match.
        const { works } = await searchWorks({ query: titleInput, limit: 3 });
        const target = new Set(titleInput.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
        for (const w of works) {
          const cand = new Set(w.title.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
          let overlap = 0;
          for (const tok of target) if (cand.has(tok)) overlap++;
          if (overlap / Math.max(1, Math.min(target.size, cand.size)) >= 0.6 && w.doi) {
            resolvedDoi = w.doi;
            break;
          }
        }
      }
      if (!resolvedDoi) return { ok: false, error: 'no_match' };

      const meta = await resolveDoi(resolvedDoi);
      const merged = {
        ...paper,
        doi: resolvedDoi,
        title: meta?.title?.trim() || paper.title,
        authors: meta?.authors?.length ? meta.authors : paper.authors,
        year: meta?.year ?? paper.year,
        venue: meta?.venue ?? paper.venue,
        abstract: meta?.abstract ?? paper.abstract,
      };
      store.savePaper(merged);
      return {
        ok: true,
        paper: {
          title: merged.title,
          authors: merged.authors,
          year: merged.year,
          venue: merged.venue,
          doi: merged.doi,
          abstract: merged.abstract,
        },
      };
    } catch (error) {
      return { ok: false, error: String((error as Error).message ?? error) };
    }
  });

  // ── Collections ─────────────────────────────────────────
  ipcMain.handle('collection:list', (event) => {
    try {
      requireRendererMainFrame(event);
      return decodeLibraryCollectionList(store?.getCollections() ?? []);
    } catch {
      return [];
    }
  });
  ipcMain.handle('collection:save', (event, rawCollection: unknown) => {
    try {
      requireRendererMainFrame(event);
      const collection = decodeLibraryCollection(rawCollection);
      if (!collection || !store) return createLibraryMutationFailure();
      store.saveCollection(collection);
      return decodeLibraryMutationResult({ success: true, code: 'saved' });
    } catch {
      return createLibraryMutationFailure();
    }
  });
  ipcMain.handle('collection:delete', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeLibraryDeleteRequest({ id: rawId });
      if (!request || !store) return createLibraryMutationFailure();
      store.deleteCollection(request.id);
      return decodeLibraryMutationResult({ success: true, code: 'deleted' });
    } catch {
      return createLibraryMutationFailure();
    }
  });

  // ── Notes ───────────────────────────────────────────────
  ipcMain.handle('note:list', (event) => {
    try {
      requireRendererMainFrame(event);
      return decodeLibraryNoteList(store?.getNotes() ?? []);
    } catch {
      return [];
    }
  });
  ipcMain.handle('note:save', (event, rawNote: unknown) => {
    try {
      requireRendererMainFrame(event);
      const note = decodeLibraryNote(rawNote);
      if (!note || !store) return createLibraryMutationFailure();
      store.saveNote({
        id: note.id,
        scope: note.scope,
        projectId: note.projectId,
        title: note.title,
        content: note.content,
        tags: note.tags,
        linkedPaperIds: note.linkedPaperIds,
        linkedNoteIds: note.linkedNoteIds,
        updatedAt: note.updatedAt,
      });
      return decodeLibraryMutationResult({ success: true, code: 'saved' });
    } catch {
      return createLibraryMutationFailure();
    }
  });
  ipcMain.handle('note:delete', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeLibraryDeleteRequest({ id: rawId });
      if (!request || !store) return createLibraryMutationFailure();
      store.deleteNote(request.id);
      return decodeLibraryMutationResult({ success: true, code: 'deleted' });
    } catch {
      return createLibraryMutationFailure();
    }
  });

  // ── Experiments metadata CRUD (GLM-102: safe DTO, no path leak) ──
  // 任务3：域 registrar 迁移——channel/contract/恢复形状不变，注册走 IpcRegistry。
  ipcDomainDisposers.push(registerExperimentIpc(domainIpcContext));

  // ── Bulk Load ───────────────────────────────────────────
  // Papers ship without pdfText (the largest field) so startup hydration stays
  // fast even for large libraries; full details load on demand via
  // data:loadPaperDetail. All renderer consumers already treat pdfText as
  // optional (?? '' / conditional rendering).
  ipcMain.handle('data:loadAll', (event) => {
    try {
      requireRendererMainFrame(event);
      const owner = executionOwnerFor(event);
      const data = store?.getAllData() ?? { papers: [], notes: [], experiments: [], collections: [] };
      return {
        papers: data.papers.map((paper) => {
          const { pdfText: _pdfText, ...summary } = paper;
          void _pdfText;
          return presentPaper(summary, owner);
        }),
        notes: data.notes,
        experiments: decodeExperimentList(store?.getExperimentMetadata() ?? []),
        collections: data.collections,
      };
    } catch {
      return { papers: [], notes: [], experiments: [], collections: [] };
    }
  });

  ipcMain.handle('data:loadPaperDetail', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { paperId?: string };
      const paper = request?.paperId ? store?.getPaper(request.paperId) : undefined;
      if (!paper) return { found: false };
      const owner = executionOwnerFor(event);
      return { found: true, paper: presentPaper(paper, owner) };
    } catch {
      return { found: false };
    }
  });

  // ── Full-text paper search ──────────────────────────────
  // The renderer only ever receives lightweight summaries (pdfText is stripped
  // from loadAll), so paper-body search runs here and the full text never
  // leaves the main process. Returns capped results with a match snippet.
  ipcMain.handle('papers:searchFullText', (event, rawQuery: unknown, rawLimit: unknown) => {
    try {
      requireRendererMainFrame(event);
      const query = typeof rawQuery === 'string' ? rawQuery.trim().toLowerCase() : '';
      const limit = typeof rawLimit === 'number'
        ? Math.max(1, Math.min(50, Math.floor(rawLimit)))
        : 20;
      if (query.length < 2) return { results: [] };
      if (!store) return { results: [] };
      // Prefer FTS5 index when available (10-100x faster on large libraries);
      // fall back to SQL LIKE otherwise.
      let rows: Array<{ id: string; title: string; abstract: string | null; pdf_text: string | null }>;
      const ftsAvailable = store.raw.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'papers_fts'",
      ).get();
      if (ftsAvailable) {
        // Rebuild the index before searching (contentless FTS5 — no triggers).
        store.reindexPapersFts();
        // FTS5: wrap each term in quotes for exact phrase matching.
        const ftsQuery = query.split(/\s+/).filter(Boolean).map((term) => `"${term}"`).join(' ');
        rows = store.raw.prepare(`
          SELECT p.id, p.title, p.abstract, p.pdf_text FROM papers p
          JOIN papers_fts ON papers_fts.rowid = p.rowid
          WHERE papers_fts MATCH ?
          ORDER BY p.added_at DESC LIMIT ?
        `).all(ftsQuery, limit + 1) as typeof rows;
      } else {
        const pattern = `%${query}%`;
        rows = store.raw.prepare(`
          SELECT id, title, abstract, pdf_text FROM papers
          WHERE title LIKE ? OR abstract LIKE ? OR pdf_text LIKE ?
          ORDER BY added_at DESC LIMIT ?
        `).all(pattern, pattern, pattern, limit + 1) as typeof rows;
      }
      const results: Array<{ id: string; title: string; snippet: string }> = [];
      for (const row of rows) {
        if (results.length >= limit) break;
        const raw = [row.title, row.abstract ?? '', row.pdf_text ?? ''].join('\n');
        const index = raw.toLowerCase().indexOf(query);
        if (index === -1) continue;
        const start = Math.max(0, index - 60);
        const end = Math.min(raw.length, index + query.length + 80);
        let snippet = raw.slice(start, end).replace(/\s+/g, ' ').trim();
        if (start > 0) snippet = `…${snippet}`;
        if (end < raw.length) snippet = `${snippet}…`;
        results.push({ id: row.id, title: row.title, snippet });
      }
      return { results, hasMore: rows.length > limit };
    } catch {
      return { results: [] };
    }
  });

  // ── AI explanation of a selected PDF passage ─────────────
  // One-shot Q&A (no agent loop, no tools, no persistence): the PDF reader
  // asks the provider to explain / translate / summarize a selection, then
  // the user may save the result as an annotation via the normal evidence flow.
  ipcMain.handle('papers:aiExplain', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { passage?: unknown; paperTitle?: unknown; action?: unknown };
      const passage = typeof request?.passage === 'string' ? request.passage.trim() : '';
      const action = request?.action === 'translate' || request?.action === 'summarize'
        ? request.action
        : 'explain';
      const paperTitle = typeof request?.paperTitle === 'string' ? request.paperTitle : '';
      if (!passage || passage.length > 6000) return { ok: false, error: 'invalid_passage' };
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `papers:aiExplain:${++requestCounter}`,
        rejection: { ok: false, error: 'application_shutting_down' },
      });
      if (!tracked.admitted) return tracked.rejection;
      try {
        if (!provider) return { ok: false, error: 'provider_unavailable' };
      const systemPrompts: Record<string, string> = {
        explain: '你是一名科研阅读助手。用中文简明解释用户选中的论文片段：说明它的含义、要点和在研究中的作用。直接回答，不要重复原文。',
        translate: '你是一名学术翻译。把用户选中的论文片段完整准确地翻译成中文，保留专业术语。只输出译文。',
        summarize: '你是一名科研阅读助手。用中文概括用户选中的论文片段的核心内容（1-3 句）。只输出概括。',
      };
      const response = await provider.complete([
        { role: 'system', content: systemPrompts[action]! },
        { role: 'user', content: paperTitle ? `论文标题：${paperTitle}\n\n片段：\n${passage}` : passage },
      ], undefined, { temperature: 0.3, signal: tracked.signal });
      if (tracked.signal.aborted) return { ok: false, error: 'application_shutting_down' };
      return { ok: true, text: response.content };
      } catch (err) {
        if (tracked.signal.aborted) return { ok: false, error: 'application_shutting_down' };
        throw err;
      } finally {
        tracked.cleanup();
      }
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? 'unknown' };
    }
  });

  // ── AI literature synthesis / comparison over multiple papers ──
  // Packs selected papers (title/authors/year/venue/abstract) into one prompt
  // and asks for a structured literature review or a comparison analysis.
  ipcMain.handle('papers:aiSynthesis', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as {
        mode?: unknown;
        papers?: unknown;
      };
      const mode = request?.mode === 'compare' || request?.mode === 'report' ? request.mode : 'synthesis';
      const papersInput = Array.isArray(request?.papers) ? request.papers : [];
      const papers = papersInput
        .slice(0, 10)
        .map((raw) => {
          const item = raw as Record<string, unknown>;
          return {
            title: typeof item.title === 'string' ? item.title : '',
            authors: Array.isArray(item.authors) ? item.authors.filter((a): a is string => typeof a === 'string').slice(0, 5) : [],
            year: typeof item.year === 'number' ? item.year : 0,
            venue: typeof item.venue === 'string' ? item.venue : '',
            abstract: typeof item.abstract === 'string' ? item.abstract.slice(0, 1500) : '',
          };
        })
        .filter((p) => p.title);
      if (papers.length < 2) return { ok: false, error: 'need_at_least_two_papers' };
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `papers:aiSynthesis:${++requestCounter}`,
        rejection: { ok: false, error: 'application_shutting_down' },
      });
      if (!tracked.admitted) return tracked.rejection;
      try {
        if (!provider) return { ok: false, error: 'provider_unavailable' };
      const paperBlocks = papers.map((p, i) => [
        `[${i + 1}] ${p.title}`,
        `作者：${p.authors.join(', ') || '未知'}；年份：${p.year || '未知'}；来源：${p.venue || '未知'}`,
        p.abstract ? `摘要：${p.abstract}` : '',
      ].filter(Boolean).join('\n')).join('\n\n');
      const systemPrompt = mode === 'compare'
        ? '你是一名学术分析助手。对用户选中的多篇论文做结构化对比分析：研究问题、方法、数据、结论、创新点逐一对比，最后指出各自的优势与局限。用中文、Markdown 表格或小标题组织。'
        : mode === 'report'
          ? '你是一名科研阅读助手。用户本周读完了以下论文，请生成一份中文阅读报告：归纳本周阅读的主题脉络、各篇论文的核心贡献、以及建议的后续阅读方向。结构清晰，用 Markdown。'
          : '你是一名学术写作助手。基于用户选中的多篇论文，生成一段中文文献综述草稿：按主题聚类、梳理方法演进、指出共识与分歧、最后点出研究空白。引用格式用（作者, 年份）。直接输出综述正文。';
      const response = await provider.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `以下是选中的 ${papers.length} 篇论文：\n\n${paperBlocks}` },
      ], undefined, { temperature: 0.4, signal: tracked.signal });
      if (tracked.signal.aborted) return { ok: false, error: 'application_shutting_down' };
      return { ok: true, text: response.content };
      } catch (err) {
        if (tracked.signal.aborted) return { ok: false, error: 'application_shutting_down' };
        throw err;
      } finally {
        tracked.cleanup();
      }
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? 'unknown' };
    }
  });

  // ── AI polish of a selected LaTeX passage ────────────────
  // One-shot polish/rewrite/expand for the LaTeX editor selection. Keeps
  // LaTeX commands intact and returns only the rewritten text.
  ipcMain.handle('latex:aiPolish', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { text?: unknown; action?: unknown };
      const text = typeof request?.text === 'string' ? request.text.trim() : '';
      const action = request?.action === 'rewrite' || request?.action === 'expand'
        ? request.action
        : 'polish';
      if (!text || text.length > 6000) return { ok: false, error: 'invalid_text' };
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `latex:aiPolish:${++requestCounter}`,
        rejection: { ok: false, error: 'application_shutting_down' },
      });
      if (!tracked.admitted) return tracked.rejection;
      try {
        if (!provider) return { ok: false, error: 'provider_unavailable' };
      const systemPrompts: Record<string, string> = {
        polish: '你是一名学术论文润色助手。润色用户给出的段落：改进语法、用词、流畅度与学术表达，保持原意与 LaTeX 命令（如 \\cite、\\ref、环境）不变。只输出润色后的文本。',
        rewrite: '你是一名学术写作助手。重写用户给出的段落，使其更简洁清晰，保持原意与 LaTeX 命令不变。只输出重写后的文本。',
        expand: '你是一名学术写作助手。扩写用户给出的段落，补充论据与细节，保持学术语气与 LaTeX 命令不变。只输出扩写后的文本。',
      };
      const response = await provider.complete([
        { role: 'system', content: systemPrompts[action]! },
        { role: 'user', content: text },
      ], undefined, { temperature: 0.3, signal: tracked.signal });
      if (tracked.signal.aborted) return { ok: false, error: 'application_shutting_down' };
      return { ok: true, text: response.content };
      } catch (err) {
        if (tracked.signal.aborted) return { ok: false, error: 'application_shutting_down' };
        throw err;
      } finally {
        tracked.cleanup();
      }
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? 'unknown' };
    }
  });

  // ── Memory ──────────────────────────────────────────────
  ipcMain.handle('memory:getProject', (event) => {
    try {
      requireRendererMainFrame(event);
      return decodeProjectMemoryContent(memoryManager?.loadProjectMemory() ?? '');
    } catch {
      return '';
    }
  });
  ipcMain.handle('memory:setProject', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeProjectMemoryWriteRequest(rawRequest);
      if (!request || !memoryManager) return createProjectMemoryMutationFailure();
      memoryManager.saveProjectMemory(request.content);
      return decodeProjectMemoryMutationResult({ success: true, code: 'saved' });
    } catch {
      return createProjectMemoryMutationFailure();
    }
  });

  // O12: white-box visibility into the AI's automatic memories (key_decision /
  // preference / fact). Lets the user see, audit, and delete what the engine
  // remembered — closing the black-box gap vs LobeChat's editable memory.
  ipcMain.handle('memory:listByCategory', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { category?: string; projectId?: string };
      const category = typeof request?.category === 'string' ? request.category : '';
      const projectId = typeof request?.projectId === 'string' ? request.projectId : undefined;
      if (!category || !memoryManager) return [];
      return memoryManager.getByCategory(category, projectId).map((entry) => ({
        key: entry.key,
        value: entry.value,
        category: entry.category,
        updatedAt: entry.updatedAt,
      }));
    } catch {
      return [];
    }
  });

  ipcMain.handle('memory:deleteByKey', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { key?: string; projectId?: string };
      const key = typeof request?.key === 'string' ? request.key : '';
      const projectId = typeof request?.projectId === 'string' ? request.projectId : undefined;
      if (!key || !memoryManager) return { ok: false, error: 'invalid_request' };
      memoryManager.delete(key, projectId);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String((error as Error).message ?? error) };
    }
  });

  // ── Project Metis.md (CAS-protected; legacy AGENTS.md migration) ──
  // Manager registry keyed by strictly-validated projectId.
  // On startup: scan existing projects from DATA_DIR/projects/.
  const workspaceAgentsByProject = new Map<string, WorkspaceAgentsManager>();
  function ensureWorkspaceManager(projectId: string): WorkspaceAgentsManager | null {
    // Always re-validate against the repository on every call.
    // Projects can be deleted between get/set invocations — cached managers
    // for deleted or missing projects must be evicted immediately.
    if (!researchRepository) return null;
    const entity = researchRepository.getProject(projectId);
    if (!entity || entity.deletedAt) {
      workspaceAgentsByProject.delete(projectId);
      return null;
    }
    const existing = workspaceAgentsByProject.get(projectId);
    if (existing) return existing;
    const mgr = new WorkspaceAgentsManager(DATA_DIR, projectId);
    workspaceAgentsByProject.set(projectId, mgr);
    return mgr;
  }

  /**
   * Outcome assistants may only receive the current project's authoritative
   * Metis.md projection.  This runs wholly in main, reuses the same
   * project-ownership check as the workspace IPC, and rejects conflicted or
   * malformed workspace views rather than passing raw files to the model.
   */
  function readOutcomeProjectMetis(projectId: string): OutcomeProjectMetisReadResult {
    return readOutcomeProjectMetisFromWorkspace(ensureWorkspaceManager(projectId), projectId);
  }
  // Scan for existing projects at startup
  try {
    const projectsRoot = path.join(DATA_DIR, 'projects');
    if (fs.existsSync(projectsRoot)) {
      for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(entry.name)) {
          ensureWorkspaceManager(entry.name);
        }
      }
    }
  } catch { /* non-critical — will discover projects on first access */ }

  ipcMain.handle('workspace:agents:get', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const decoded = decodeWorkspaceAgentsGetRequest(rawRequest);
      if (!decoded) return { exists: false, content: '', version: 0, contentHash: '', projectId: '' };
      // Always re-validate through ensureWorkspaceManager — must not
      // bypass the repository check via a stale cache hit.
      const mgr = ensureWorkspaceManager(decoded.projectId);
      if (!mgr) return { exists: false, content: '', version: 0, contentHash: '', projectId: decoded.projectId };
      return { ...mgr.read(), projectId: decoded.projectId };
    } catch {
      return { exists: false, content: '', version: 0, contentHash: '', projectId: '' };
    }
  });
  ipcMain.handle('workspace:agents:set', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const decoded = decodeWorkspaceAgentsWriteRequest(rawRequest);
      if (!decoded) return { success: false, code: 'content_invalid' };
      const mgr = ensureWorkspaceManager(decoded.projectId);
      if (!mgr) return { success: false, code: 'project_not_found' as const };
      return mgr.write(decoded.content, decoded.expectedVersion);
    } catch {
      return { success: false, code: 'io_error' };
    }
  });
  // ── Goal Engine ─────────────────────────────────────────
  ipcMain.handle('goal:create', (event, rawDescription: unknown, rawContext?: unknown, rawProjectId?: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!goalEngine) return decodeGoalCreateResponse(null);
      const request = GoalCreateRequestSchema.parse({
        description: rawDescription,
        context: rawContext,
        projectId: typeof rawProjectId === 'string' ? rawProjectId : undefined,
      });
      const goal = goalEngine.createGoal(request.description, request.context, request.projectId);
      broadcastGoalChanged(event.sender, goal);
      return decodeGoalCreateResponse({
        success: true,
        goalId: goal.id,
        status: goal.status,
      });
    } catch {
      return decodeGoalCreateResponse(null);
    }
  });
  ipcMain.handle('goal:get', (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!goalEngine) return decodeGoalSummaryResponse(null);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      const goal = goalEngine.getGoal(goalId);
      return goal
        ? decodeGoalSummaryResponse({ success: true, goal: presentGoalSummary(goal, goalCheckpointSummary(goal.id)) })
        : decodeGoalSummaryResponse(null);
    } catch {
      return decodeGoalSummaryResponse(null);
    }
  });
  // O17: 工作流可视化——返回 goal 的 WorkflowDefinition（契约化截断）与最新
  // run 的步骤状态，供渲染端 WorkflowGraph 只读渲染 DAG 节点图。
  ipcMain.handle('goal:getWorkflow', (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!goalEngine) return createGoalWorkflowRecovery();
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      const view = goalEngine.getWorkflowView(goalId);
      if (!view) return createGoalWorkflowRecovery();
      return decodeGoalWorkflowResponse(presentGoalWorkflow(goalId, view));
    } catch {
      return createGoalWorkflowRecovery();
    }
  });
  // 渲染端路由诊断（2026-08-29）：进入文件日志，终结"发送走了哪条路"的猜测。
  ipcMain.handle('diag:rendererLog', (event, rawLine: unknown) => {
    try { requireRendererMainFrame(event); } catch { return null; }
    console.log(`[Renderer] ${typeof rawLine === 'string' ? rawLine.slice(0, 600) : String(rawLine)}`);
    return null;
  });
  ipcMain.handle('goal:list', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!goalEngine) return decodeGoalListResponse(null);
      return decodeGoalListResponse({
        success: true,
        goals: goalEngine.listGoals().map((goal) => presentGoalSummary(goal, goalCheckpointSummary(goal.id))),
      });
    } catch {
      return decodeGoalListResponse(null);
    }
  });
  ipcMain.handle('goal:generatePlan', async (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!goalEngine) return decodeGoalPlanResponse(null);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `goal:generatePlan:${goalId}:${++requestCounter}`,
        rejection: decodeGoalPlanResponse({ success: false, code: 'application_shutting_down', label: GOAL_PLAN_LABEL, steps: [] }),
      });
      if (!tracked.admitted) return tracked.rejection;
      try {
        const result = await goalEngine.generatePlan(goalId, { signal: tracked.signal });
        if (tracked.signal.aborted) return decodeGoalPlanResponse({ success: false, code: 'application_shutting_down', label: GOAL_PLAN_LABEL, steps: [] });
        const goal = goalEngine.getGoal(goalId);
        if (goal) broadcastGoalChanged(event.sender, goal);
        return presentGoalPlan(goalId, result.workflow);
      } catch (error) {
        if (tracked.signal.aborted) return decodeGoalPlanResponse({ success: false, code: 'application_shutting_down', label: GOAL_PLAN_LABEL, steps: [] });
        throw error;
      } finally {
        tracked.cleanup();
      }
    } catch {
      return decodeGoalPlanResponse(null);
    }
  });
  ipcMain.handle('goal:refinePlan', async (event, rawGoalId: unknown, rawFeedback: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!goalEngine) return decodeGoalPlanResponse(null);
      const request = GoalRefineRequestSchema.parse({
        goalId: rawGoalId,
        feedback: rawFeedback,
      });
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `goal:refinePlan:${request.goalId}:${++requestCounter}`,
        rejection: decodeGoalPlanResponse({ success: false, code: 'application_shutting_down', label: GOAL_PLAN_LABEL, steps: [] }),
      });
      if (!tracked.admitted) return tracked.rejection;
      try {
        const result = await goalEngine.refinePlan(request.goalId, request.feedback, { signal: tracked.signal });
        if (tracked.signal.aborted) return decodeGoalPlanResponse({ success: false, code: 'application_shutting_down', label: GOAL_PLAN_LABEL, steps: [] });
        const goal = goalEngine.getGoal(request.goalId);
        if (goal) broadcastGoalChanged(event.sender, goal);
        return presentGoalPlan(request.goalId, result.workflow);
      } catch (error) {
        if (tracked.signal.aborted) return decodeGoalPlanResponse({ success: false, code: 'application_shutting_down', label: GOAL_PLAN_LABEL, steps: [] });
        throw error;
      } finally {
        tracked.cleanup();
      }
    } catch {
      return decodeGoalPlanResponse(null);
    }
  });
  ipcMain.handle('goal:updatePlan', async (event, rawGoalId: unknown, rawWorkflow: unknown) => {
    try {
      requireRendererMainFrame(event);
      const goalId = RuntimeIdSchema.parse(rawGoalId);
      // O17: the renderer builds a WorkflowDefinition-shaped object; decode it
      // leniently (structure is validated by GoalPlanner.validatePlan below).
      if (!goalEngine || typeof rawWorkflow !== 'object' || rawWorkflow === null) {
        return { valid: false, errors: ['goal_plan_update_unavailable'], warnings: [] };
      }
      const workflow = rawWorkflow as WorkflowDefinition;
      const result = goalEngine.updatePlan(goalId, workflow);
      if (result.valid) {
        const goal = goalEngine.getGoal(goalId);
        if (goal) broadcastGoalChanged(event.sender, goal);
      }
      return { valid: result.valid, errors: result.errors, warnings: result.warnings };
    } catch {
      return { valid: false, errors: ['goal_plan_update_unavailable'], warnings: [] };
    }
  });
  ipcMain.handle('goal:execute', async (event, rawGoalId: unknown) => {
    if (runtimeShutdown.isDraining()) return { success: false, code: 'application_shutting_down' };
    let goalId: string;
    try {
      requireRendererMainFrame(event);
      goalId = RuntimeIdSchema.parse(rawGoalId);
    } catch {
      return { success: false, code: 'goal_execution_unavailable' };
    }
    if (!goalEngine) return { success: false, code: 'goal_execution_unavailable' };
    let sequence = 0;
    const sendGoalEvent = (channel: string, payload: unknown) => {
      const decoded = decodeGoalLiveEvent(payload);
      if (decoded.ok) event.sender.send(channel, decoded.value);
    };
    const hooks: WorkflowHooks = {
      onStepStart: (step) => {
        sendGoalEvent('goal:step:start', {
          version: CHAT_RUNTIME_CONTRACT_VERSION,
          type: 'step-start',
          goalId,
          sequence: sequence++,
          stepId: step.id,
          stepName: 'Research step',
        });
      },
      onStepComplete: (step) => {
        sendGoalEvent('goal:step:complete', {
          version: CHAT_RUNTIME_CONTRACT_VERSION,
          type: 'step-complete',
          goalId,
          sequence: sequence++,
          stepId: step.id,
          stepName: 'Research step',
          output: '',
        });
      },
      onStepFailed: (step) => {
        sendGoalEvent('goal:step:failed', {
          version: CHAT_RUNTIME_CONTRACT_VERSION,
          type: 'step-failed',
          goalId,
          sequence: sequence++,
          stepId: step.id,
          stepName: 'Research step',
          error: 'goal_step_failed',
        });
      },
      onProgress: (completed, total) => {
        sendGoalEvent('goal:progress', {
          version: CHAT_RUNTIME_CONTRACT_VERSION,
          type: 'progress',
          goalId,
          sequence: sequence++,
          completed,
          total,
          currentStep: 'Research step',
        });
      },
    };
    try {
      // O13: 解析项目级 provider 覆盖（无覆盖时返回全局绑定）。
      const executeTarget = goalEngine.getGoal(goalId);
      const executionOptions = executeTarget ? resolveGoalExecutionOptions(executeTarget) : undefined;
      const run = await goalEngine.executeGoal(goalId, hooks, executionOptions);
      const goal = goalEngine.getGoal(goalId);
      if (goal) broadcastGoalChanged(event.sender, goal);
      if (run.status === 'completed') return { success: true, code: 'completed' };
      if (run.status === 'paused') return { success: false, code: 'paused' };
      if (run.status === 'cancelled') return { success: false, code: 'cancelled' };
      return { success: false, code: 'failed' };
    } catch (error) {
      console.error('[goal:execute] execution failed', error);
      return { success: false, code: 'goal_execution_unavailable' };
    }
  });
  ipcMain.handle('goal:pause', (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      if (!goalEngine) return { success: false, code: 'goal_execution_unavailable' };
      const paused = goalEngine.pauseGoal(goalId);
      const goal = goalEngine.getGoal(goalId);
      if (goal) broadcastGoalChanged(event.sender, goal);
      return paused
        ? { success: true, code: 'pause_requested' }
        : { success: false, code: 'goal_execution_unavailable' };
    } catch {
      return { success: false };
    }
  });
  ipcMain.handle('goal:resume', async (event, rawGoalId: unknown, rawFromStepId?: unknown) => {
    if (runtimeShutdown.isDraining()) return { success: false, code: 'application_shutting_down' };
    try {
      requireRendererMainFrame(event);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      const fromStepId = rawFromStepId === undefined
        ? undefined
        : RuntimeIdSchema.parse(rawFromStepId);
      if (!goalEngine) return { success: false, code: 'goal_execution_unavailable' };
      // O13/O14: resume 同样解析项目级 provider 覆盖；fromStepId 省略时
      // 由 GoalEngine 从 checkpoint 推导恢复点。
      const resumeTarget = goalEngine.getGoal(goalId);
      const executionOptions = resumeTarget ? resolveGoalExecutionOptions(resumeTarget) : undefined;
      const run = await goalEngine.resumeGoal(goalId, fromStepId, undefined, executionOptions);
      const goal = goalEngine.getGoal(goalId);
      if (goal) broadcastGoalChanged(event.sender, goal);
      if (run.status === 'completed') return { success: true, code: 'completed' };
      if (run.status === 'paused') return { success: false, code: 'paused' };
      if (run.status === 'cancelled') return { success: false, code: 'cancelled' };
      return { success: false, code: 'failed' };
    } catch (error) {
      console.error('[goal:resume] resume failed', error);
      // 已取消/已完成的目标是终态，恢复永远不可能成功——必须把这个事实
      // 如实返回给渲染端，而不是笼统的 unavailable（那会让用户一直重试）。
      const message = String((error as Error)?.message ?? error);
      if (message.includes('was cancelled and cannot be resumed')) {
        return { success: false, code: 'goal_cancelled' };
      }
      if (message.includes('not found')) {
        return { success: false, code: 'goal_not_found' };
      }
      return { success: false, code: 'goal_execution_unavailable' };
    }
  });
  // O7: human decision on an escalated step (retry / skip / stop).
  ipcMain.handle('goal:resolveStepDecision', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { goalId?: string; action?: string };
      const goalId = typeof request?.goalId === 'string' ? request.goalId : '';
      const action = request?.action;
      if (!goalId || (action !== 'retry' && action !== 'skip' && action !== 'stop') || !goalEngine) {
        return { success: false, code: 'invalid_request' };
      }
      const goal = goalEngine.getGoal(goalId);
      const executionOptions = goal ? resolveGoalExecutionOptions(goal) : undefined;
      await goalEngine.resolveStepDecision(goalId, action, undefined, executionOptions);
      const updated = goalEngine.getGoal(goalId);
      if (updated) broadcastGoalChanged(event.sender, updated);
      return { success: true };
    } catch {
      return { success: false, code: 'goal_execution_unavailable' };
    }
  });
  ipcMain.handle('goal:cancel', (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      if (!goalEngine) return { success: false, code: 'goal_execution_unavailable' };
      const cancelled = goalEngine.cancelGoal(goalId);
      const goal = goalEngine.getGoal(goalId);
      if (goal) broadcastGoalChanged(event.sender, goal);
      return cancelled
        ? { success: true, code: 'cancelled' }
        : { success: false, code: 'goal_not_found' };
    } catch {
      return { success: false };
    }
  });
  ipcMain.handle('goal:getProgress', (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      return goalEngine?.getProgress(goalId);
    } catch {
      return undefined;
    }
  });
  ipcMain.handle('goal:archive', async (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const { goalId } = GoalIdRequestSchema.parse({ goalId: rawGoalId });
      if (!goalEngine) return { success: false };
      await goalEngine.archiveGoal(goalId);
      return { success: true };
    } catch {
      return { success: false };
    }
  });
  ipcMain.handle('goal:listArchives', (event) => {
    try {
      requireRendererMainFrame(event);
      return goalEngine?.getArchives() ?? [];
    } catch {
      return [];
    }
  });

  // ── Kanban status/priority transitions ──────────────────
  ipcMain.handle('goal:updateStatus', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { goalId?: unknown; status?: unknown };
      const goalId = typeof request?.goalId === 'string' ? request.goalId : '';
      const status = typeof request?.status === 'string' ? request.status : '';
      const valid = new Set(['draft', 'planning', 'ready', 'running', 'paused', 'completed', 'failed']);
      if (!goalId || !valid.has(status) || !goalEngine) return { ok: false, error: 'invalid_request' };
      const updated = goalEngine.setStatus(goalId, status as Goal['status']);
      if (updated) {
        const goal = goalEngine.getGoal(goalId);
        if (goal) broadcastGoalChanged(event.sender, goal);
      }
      return updated ? { ok: true } : { ok: false, error: 'not_found' };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('goal:updatePriority', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = rawRequest as { goalId?: unknown; priority?: unknown };
      const goalId = typeof request?.goalId === 'string' ? request.goalId : '';
      const priority = typeof request?.priority === 'string' ? request.priority : '';
      const valid = new Set(['low', 'medium', 'high', 'urgent']);
      if (!goalId || !valid.has(priority) || !goalEngine) return { ok: false, error: 'invalid_request' };
      const updated = goalEngine.setPriority(goalId, priority as Goal['priority']);
      if (updated) {
        const goal = goalEngine.getGoal(goalId);
        if (goal) broadcastGoalChanged(event.sender, goal);
      }
      return updated ? { ok: true } : { ok: false, error: 'not_found' };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle('goal:delete', (event, rawGoalId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const goalId = typeof rawGoalId === 'string' ? rawGoalId : '';
      if (!goalId || !goalEngine) return { ok: false, error: 'invalid_request' };
      const goal = goalEngine.getGoal(goalId);
      const deleted = goalEngine.deleteGoal(goalId);
      if (deleted && goal) {
        // Deletion is presented to open cards as a cancellation so chat cards
        // never dangle; the board reloads and the card disappears.
        broadcastGoalChanged(event.sender, goal, 'cancelled');
      }
      return deleted ? { ok: true } : { ok: false, error: 'not_found' };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });

  // ── Autonomous Research Engine ─────────────────────────
  // Full-autonomy loop (idea → experiment → analysis → paper) with live event
  // streaming and live-steering pause/interrupt. Mirrors the goal IPC shape.

  /**
   * Start (or resume) an autonomous run and stream every bus event to the
   * requesting renderer. `goal` null means "resume from checkpoint". The run
   * is fire-and-forget; the session id is returned to the caller immediately.
   */
  function spawnAutonomousRun(
    sender: Electron.WebContents,
    sessionId: string,
    goal: string | null,
    projectId?: string,
    strategy?: ResearchStrategy,
    structure?: PaperStructureTemplate,
  ): boolean {
    let sequence = 0;
    // One subscription per run: forward every bus event to the renderer after
    // schema validation. Unsubscribed when the run resolves.
    const unsubscribe = researchEventBus!.subscribe((evt) => {
      if (projectId && researchRepository) {
        try { applyAutonomousResearchEvent(researchRepository, projectId, evt); } catch { /* UI streaming must continue */ }
      }
      if (sender.isDestroyed()) return;
      const livePayload = toLivePayload(evt, sessionId, sequence++);
      const decoded = decodeAutonomousLiveEvent(livePayload);
      if (decoded) {
        const channel = channelForEvent(evt);
        if (channel) sender.send(channel, decoded);
      }
    });
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const runRecord: ActiveAutonomousRun = { sessionId, completion, resolveCompletion };
    activeAutonomousRun = runRecord;
    const unregisterAutonomousRun = registerRuntimeRunOrRollback(
      runtimeShutdown,
      {
        id: `autonomous:${sessionId}`,
        promise: completion,
        abort: () => { autonomousEngine?.interrupt(sessionId, 'application_shutdown'); },
      },
      () => {
        unsubscribe();
        if (activeAutonomousSessionId === sessionId) activeAutonomousSessionId = null;
        if (activeAutonomousRun === runRecord) activeAutonomousRun = null;
        runRecord.resolveCompletion();
      },
    );
    if (!unregisterAutonomousRun) return false;
    void (async () => {
      try {
        if (goal !== null) {
          if (strategy) {
            await autonomousEngine!.runWithStrategy(goal, sessionId, strategy, { projectId, structure });
          } else {
            await autonomousEngine!.run(goal, sessionId, projectId);
          }
        } else {
          await autonomousEngine!.resume(sessionId);
        }
      } catch (err) {
        console.error('[Main] autonomous run failed:', err);
        researchEventBus?.emit({
          type: 'engine-failed',
          sessionId,
          reason: `自主科研运行发生未预期异常：${err instanceof Error ? err.message : String(err)}`.slice(0, 20_000),
          completedPhases: 0,
          recoverable: true,
        });
      } finally {
        unsubscribe();
        if (activeAutonomousSessionId === sessionId) activeAutonomousSessionId = null;
        if (activeAutonomousRun === runRecord) activeAutonomousRun = null;
        runRecord.resolveCompletion();
      }
    })();
    return true;
  }

  ipcMain.handle(AUTONOMOUS_CHANNELS.start, async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
    if (runtimeShutdown.isDraining()) return { ok: false, error: 'application_shutting_down' };
    const request = decodeAutonomousStartRequest(rawRequest);
    if (!request) return { ok: false, error: 'invalid_request' };
    if (!autonomousEngine || !researchEventBus) return { ok: false, error: 'engine_unavailable' };
    if (activeAutonomousSessionId) return { ok: false, error: 'session_active' };

    // Strategy-driven runs execute the user-defined research workflow instead
    // of the default four-stage pipeline.
    let strategy: ResearchStrategy | undefined;
    let structure: PaperStructureTemplate | undefined;
    if (request.strategyId) {
      if (!strategyStore() || !store) return { ok: false, error: 'strategy_unavailable' };
      strategy = strategyStore()!.getStrategy(request.strategyId);
      if (!strategy) return { ok: false, error: 'strategy_not_found' };
    }
    if (request.structureId) {
      if (!strategyStore() || !store) return { ok: false, error: 'structure_unavailable' };
      structure = strategyStore()!.getStructure(request.structureId);
      if (!structure) return { ok: false, error: 'structure_not_found' };
    }

    const sessionId = request.sessionId ?? `auto_${Date.now().toString(36)}`;
    if (!researchRepository) return { ok: false, error: 'research_repository_unavailable' };
    if (researchRepository.getRun(sessionId, true)) return { ok: false, error: 'session_exists' };
    let resolvedProjectId: string;
    try {
      const resolution = ensureAutonomousResearchProject(researchRepository, {
        goal: request.goal,
        requestedProjectId: request.projectId,
      });
      if (!resolution) {
        return { ok: false, error: request.projectId ? 'project_not_found' : 'project_creation_failed' };
      }
      resolvedProjectId = resolution.projectId;
      beginAutonomousResearchRun(researchRepository, {
        sessionId,
        projectId: resolvedProjectId,
        goal: request.goal,
      });
    } catch {
      return { ok: false, error: 'project_creation_failed' };
    }
    activeAutonomousSessionId = sessionId;
    if (!spawnAutonomousRun(event.sender, sessionId, request.goal, resolvedProjectId, strategy, structure)) {
      return { ok: false, error: 'application_shutting_down' };
    }

    return { ok: true, sessionId, projectId: resolvedProjectId };
  });

  // ── Research strategy & paper structure management ─────────
  ipcMain.handle('strategy:list', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!strategyStore() || !store) return { ok: false, strategies: [] };
      return { ok: true, strategies: strategyStore()!.listStrategies() };
    } catch {
      return { ok: false, strategies: [] };
    }
  });
  ipcMain.handle('strategy:save', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeStrategySaveRequest(rawRequest);
      if (!request || !strategyStore() || !store) return { ok: false, error: 'invalid_request' };
      strategyStore()!.saveStrategy({ ...request.strategy, updatedAt: Date.now() });
      return { ok: true };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });
  ipcMain.handle('strategy:delete', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeStrategyDeleteRequest(rawRequest);
      if (!request || !strategyStore() || !store) return { ok: false, error: 'invalid_request' };
      strategyStore()!.deleteStrategy(request.strategyId);
      return { ok: true };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });
  ipcMain.handle('strategy:setDefault', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeStrategySetDefaultRequest(rawRequest);
      if (!request || !strategyStore() || !store) return { ok: false, error: 'invalid_request' };
      const strategy = strategyStore()!.getStrategy(request.strategyId);
      if (!strategy) return { ok: false, error: 'not_found' };
      for (const existing of strategyStore()!.listStrategies()) {
        if (existing.id === strategy.id) continue;
        strategyStore()!.saveStrategy({ ...existing, isDefault: false, updatedAt: Date.now() });
      }
      strategyStore()!.saveStrategy({ ...strategy, isDefault: true, updatedAt: Date.now() });
      return { ok: true };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });
  ipcMain.handle('structure:list', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!strategyStore() || !store) return { ok: false, templates: [] };
      return { ok: true, templates: strategyStore()!.listStructures() };
    } catch {
      return { ok: false, templates: [] };
    }
  });
  ipcMain.handle('structure:save', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodePaperStructureSaveRequest(rawRequest);
      if (!request || !strategyStore() || !store) return { ok: false, error: 'invalid_request' };
      strategyStore()!.saveStructure({ ...request.template, updatedAt: Date.now() });
      return { ok: true };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });
  ipcMain.handle('structure:delete', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodePaperStructureDeleteRequest(rawRequest);
      if (!request || !strategyStore() || !store) return { ok: false, error: 'invalid_request' };
      strategyStore()!.deleteStructure(request.templateId);
      return { ok: true };
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
  });

  ipcMain.handle(AUTONOMOUS_CHANNELS.control, async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeAutonomousControlRequest(rawRequest);
      if (!request) return { ok: false, code: 'invalid_request' };
      if (!autonomousEngine || !researchEventBus) {
        return { ok: false, code: 'invalid_request' };
      }
      if (request.action === 'interrupt') {
        const stopped = autonomousEngine.interrupt(request.sessionId, request.reason ?? 'user_interrupt');
        return { ok: stopped, code: stopped ? 'applied' : 'no_active_session' };
      }
      if (request.action === 'pause') {
        // Real cooperative pause: mark the session so the loop stops at the
        // next phase boundary, and nudge the live-steering queue so a running
        // phase can also stop at its next step boundary.
        const paused = autonomousEngine.pause(request.sessionId);
        if (!paused) return { ok: false, code: 'no_active_session' };
        try {
          liveSteeringQueue.enqueue({
            type: 'interrupt',
            id: `auto_interrupt_${Date.now()}`,
            sessionId: request.sessionId,
            sequence: Date.now(),
            createdAt: Date.now(),
            reason: request.reason ?? 'user_pause',
          });
        } catch { /* steering nudge is best-effort */ }
        return { ok: true, code: 'applied' };
      }
      if (request.action === 'resume') {
        // Resume a paused session from its persisted checkpoint. A paused
        // session is no longer in memory (activeAutonomousSessionId is null),
        // so this branch intentionally bypasses the active-session guard.
        if (activeAutonomousSessionId) return { ok: false, code: 'no_active_session' };
        const checkpoint = autonomousEngine.loadCheckpoint(request.sessionId);
        if (!checkpoint) return { ok: false, code: 'not_found' };
        activeAutonomousSessionId = request.sessionId;
        if (!spawnAutonomousRun(event.sender, request.sessionId, null, checkpoint.projectId)) {
          return { ok: false, code: 'application_shutting_down' };
        }
        return { ok: true, code: 'applied' };
      }
      return { ok: false, code: 'invalid_request' };
    } catch {
      return { ok: false, code: 'invalid_request' };
    }
  });

  ipcMain.handle(AUTONOMOUS_CHANNELS.listSessions, (event) => {
    try {
      requireRendererMainFrame(event);
      if (!autonomousEngine || !store) return { sessions: [] };
      // Checkpoints are stored as memory rows under the autonomous_checkpoint category.
      const rows = store.getMemoryByCategory('autonomous_checkpoint');
      return {
        sessions: rows.map((r) => {
          try {
            const data = JSON.parse(r.value) as Record<string, unknown>;
            const sessionId = r.key.replace('autonomous:session:', '');
            const goal = typeof data.goal === 'string' ? data.goal : '';
            if (!sessionId || !goal) return null;
            const run = researchRepository?.getRun(sessionId, true);
            if (run && (run.status === 'completed' || run.status === 'cancelled')) return null;
            return {
              sessionId,
              goal,
              projectId: typeof data.projectId === 'string' ? data.projectId : run?.projectId,
              executions: typeof data.executions === 'number' ? data.executions : 0,
              completedPhases: Array.isArray(data.history) ? data.history.length : 0,
              savedAt: typeof data.savedAt === 'number' ? data.savedAt : r.updatedAt,
              state: data.state === 'running' ? 'running' : 'paused',
              failureReason: typeof data.failureReason === 'string' ? data.failureReason : undefined,
            };
          } catch { return null; }
        }).filter((session): session is NonNullable<typeof session> => session !== null),
      };
    } catch {
      return { sessions: [] };
    }
  });

  ipcMain.handle(AUTONOMOUS_CHANNELS.resumeSession, async (event, rawSessionId: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (runtimeShutdown.isDraining()) return { ok: false, error: 'application_shutting_down' };
      const sessionId = typeof rawSessionId === 'string' ? rawSessionId : '';
      if (!sessionId || !autonomousEngine || !researchEventBus) return { ok: false, error: 'invalid_request' };
      const checkpoint = autonomousEngine.loadCheckpoint(sessionId);
      if (!checkpoint) return { ok: false, error: 'no_checkpoint' };
      if (activeAutonomousSessionId) return { ok: false, error: 'session_active' };
      // Real mid-loop resume from the persisted checkpoint (completed phases
      // are not re-executed).
      activeAutonomousSessionId = sessionId;
      if (!spawnAutonomousRun(event.sender, sessionId, null, checkpoint.projectId)) {
        return { ok: false, error: 'application_shutting_down' };
      }
      return { ok: true, goal: checkpoint.goal };
    } catch {
      return { ok: false, error: 'invalid_request' };
    }
  });

  // ── Skills ──────────────────────────────────────────────
  ipcMain.handle('skill:list', (event) => {
    try {
      requireRendererMainFrame(event);
      return skillRegistry?.list().map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        category: skill.category,
        allowedTools: skill.allowedTools ?? [],
        maxTurns: skill.maxTurns,
      })) ?? [];
    } catch {
      return [];
    }
  });
  ipcMain.handle('skill:get', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const skill = skillRegistry?.get(RuntimeIdSchema.parse(rawId));
      return skill ? {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        category: skill.category,
      } : undefined;
    } catch {
      return undefined;
    }
  });
  ipcMain.handle('skill:setActive', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!skillRegistry) return { success: false, error: 'skill_registry_unavailable' };
      if (rawId === null) {
        skillRegistry.clearActiveSkillPrompt();
        return { success: true, active: null };
      }
      const id = RuntimeIdSchema.parse(rawId);
      const skill = skillRegistry.get(id);
      if (!skill) return { success: false, error: 'skill_unavailable' };
      skillRegistry.setActiveSkillPrompt(skill.systemPrompt);
      return { success: true, active: id };
    } catch {
      return { success: false, error: 'skill_unavailable' };
    }
  });
  ipcMain.handle('skill:getActive', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!skillRegistry) return { active: null };
      const prompt = skillRegistry.getActiveSkillPrompt();
      return { active: prompt ? 'active' : null };
    } catch {
      return { active: null };
    }
  });

  // Generate a reusable skill from a selected conversation. The AI distills the
  // conversation into a structured skill, which is then registered into the
  // live SkillRegistry AND persisted so it survives restarts.
  ipcMain.handle('skill:generateFromConversation', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      return { ok: false, error: 'unauthorized_renderer' };
    }
    if (!skillExtractor || !skillRegistry) {
      return { ok: false, error: 'skill_engine_unavailable' };
    }
    const request = rawRequest as { messages?: unknown; userIntent?: unknown };
    const rawMessages = Array.isArray(request?.messages) ? request.messages : [];
    // Coerce to ChatMessage-like shape (role + content only).
    const messages = rawMessages
      .filter((m): m is { role: string; content: string } =>
        typeof m === 'object' && m !== null && typeof (m as { content?: unknown }).content === 'string')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    if (messages.length === 0) return { ok: false, error: 'no_messages' };

    const userIntent = typeof request?.userIntent === 'string' ? request.userIntent : undefined;
    const knownTools = builtinToolNames();

    const extracted = await skillExtractor.extract({ messages, userIntent, knownTools });
    if (!extracted) return { ok: false, error: 'conversation_too_short' };

    // Install into the live registry (unregister first if id exists, so
    // re-generating a skill updates it in place).
    installSkill(extracted);

    return {
      ok: true,
      skill: {
        id: extracted.id,
        name: extracted.name,
        description: extracted.description,
        systemPrompt: extracted.systemPrompt,
        allowedTools: extracted.allowedTools,
        maxTurns: extracted.maxTurns,
        rationale: extracted.rationale,
      },
    };
  });

  ipcMain.handle('skill:deleteCustom', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const id = typeof rawId === 'string' ? rawId : '';
      if (!id || !skillRegistry || !store) return { ok: false, error: 'invalid' };
      skillRegistry.unregister(id);
      // Remove from persisted custom skills.
      const custom = loadCustomSkills();
      const filtered = custom.filter((s) => s.id !== id);
      if (filtered.length !== custom.length) {
        store.setMemory(CUSTOM_SKILLS_MEMORY_KEY, JSON.stringify(filtered), 'custom_skills');
      }
      return { ok: true };
    } catch {
      return { ok: false, error: 'delete_failed' };
    }
  });

  // ── Capability Vault（任务7 7B/7D：入库不注入，绑定才加载）──────────
  // 来源拉取仅锁定 GitHub 官方域（api.github.com / raw.githubusercontent.com），
  // 可选 GITHUB_TOKEN/GH_TOKEN 提升匿名限流；任何失败如实上抛。
  const vaultGitHubFetcher: GitHubFetcher = async (url) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:'
      || (parsed.hostname !== 'api.github.com' && parsed.hostname !== 'raw.githubusercontent.com')) {
      throw new Error(`blocked_non_github_host: ${parsed.hostname}`);
    }
    const headers: Record<string, string> = {
      'User-Agent': 'METIS-CapabilityVault',
      'Accept': 'application/vnd.github+json',
    };
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(parsed, { headers });
    if (!response.ok) throw new Error(`github_${response.status}`);
    return response.text();
  };
  // vault 条目 id（含冒号/斜杠）→ 合法 PersonalizationId（user:vault-<净化尾段>）。
  const vaultDefinitionIdFor = (vaultSkillId: string): string => {
    const tail = vaultSkillId.replace(/^skill:vault:/, '').replace(/[^A-Za-z0-9._/-]/g, '-').slice(0, 120);
    return `user:vault-${tail}`;
  };
  const ensureCapabilityVaultService = (): CapabilityVaultService | null => {
    if (!store) return null;
    return new CapabilityVaultService(store.raw);
  };

  ipcMain.handle('capability:vault:sources', (event) => {
    try {
      requireRendererMainFrame(event);
      const vault = ensureCapabilityVaultService();
      if (!vault) return { ok: false, error: 'store_unavailable' };
      return { ok: true, sources: vault.listSources() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'sources_failed' };
    }
  });

  ipcMain.handle('capability:vault:stats', (event) => {
    try {
      requireRendererMainFrame(event);
      const vault = ensureCapabilityVaultService();
      if (!vault) return { ok: false, error: 'store_unavailable' };
      return { ok: true, stats: vault.stats() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'stats_failed' };
    }
  });

  ipcMain.handle('capability:vault:importSource', async (event, rawSourceId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const sourceId = typeof rawSourceId === 'string' ? rawSourceId : '';
      const vault = ensureCapabilityVaultService();
      if (!vault || !sourceId) return { ok: false, imported: 0, excluded: 0, error: 'invalid_request' };
      return await vault.importSource(sourceId, vaultGitHubFetcher);
    } catch (error) {
      return { ok: false, imported: 0, excluded: 0, error: error instanceof Error ? error.message : 'import_failed' };
    }
  });

  ipcMain.handle('capability:vault:list', (event, rawQuery: unknown) => {
    try {
      requireRendererMainFrame(event);
      const vault = ensureCapabilityVaultService();
      if (!vault) return { ok: false, error: 'store_unavailable' };
      const query = (typeof rawQuery === 'object' && rawQuery !== null ? rawQuery : {}) as {
        keyword?: unknown; sourceId?: unknown; kind?: unknown; stage?: unknown; limit?: unknown;
      };
      const entries = vault.search({
        keyword: typeof query.keyword === 'string' ? query.keyword : undefined,
        sourceId: typeof query.sourceId === 'string' ? query.sourceId : undefined,
        kind: query.kind === 'skill' || query.kind === 'mcp' ? query.kind : undefined,
        stage: typeof query.stage === 'string' ? query.stage : undefined,
        limit: typeof query.limit === 'number' && Number.isFinite(query.limit) ? Math.floor(query.limit) : undefined,
      });
      return { ok: true, entries };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'list_failed' };
    }
  });

  ipcMain.handle('capability:vault:getDetail', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const vault = ensureCapabilityVaultService();
      const id = typeof rawId === 'string' ? rawId : '';
      if (!vault || !id) return { ok: false, error: 'invalid_request' };
      const entry = vault.getDetail(id);
      return entry ? { ok: true, entry } : { ok: false, error: 'not_found' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'detail_failed' };
    }
  });

  ipcMain.handle('capability:vault:install', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const vault = ensureCapabilityVaultService();
      const id = typeof rawId === 'string' ? rawId : '';
      if (!vault || !id) return { ok: false, code: 'not_found' };
      return vault.install(id, (input) => {
        const repository = personalizationRepository;
        if (!repository) return { ok: false, error: 'personalization_unavailable' };
        const now = Date.now();
        const definitionId = vaultDefinitionIdFor(input.id);
        const existing = repository.get(definitionId);
        const tags = Array.from(new Set(
          input.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0),
        )).slice(0, 8);
        const definition: SkillDefinitionV2 = {
          contractVersion: PERSONALIZATION_CONTRACT_VERSION,
          id: definitionId,
          name: input.name.slice(0, 120),
          description: input.description.slice(0, 2000),
          enabled: true,
          tags,
          revision: existing ? existing.revision + 1 : 1,
          provenance: {
            origin: 'user',
            author: 'Capability Vault',
            version: '1.0.0',
            license: null,
            sourceUrl: null,
            sourceRevision: null,
            installedDigest: null,
            parentId: null,
            parentVersion: null,
            locallyModified: false,
            createdAt: existing ? existing.provenance.createdAt : now,
            updatedAt: now,
          },
          kind: 'skill',
          sourceMode: 'markdown',
          markdown: '',
          systemPrompt: input.systemPrompt,
          toolIds: [],
          mcpIds: [],
          maxTurns: 30,
          inputSchema: null,
          outputSchema: null,
          packageEntry: null,
        };
        const saved = repository.save({
          contractVersion: PERSONALIZATION_CONTRACT_VERSION,
          definition,
          expectedRevision: existing ? existing.revision : 0,
        });
        if (!saved.ok || saved.code !== 'saved') return { ok: false, error: saved.code };
        return { ok: true, definitionId: saved.definition.id };
      });
    } catch (error) {
      return { ok: false, code: 'install_failed', message: error instanceof Error ? error.message : undefined };
    }
  });

  ipcMain.handle('capability:vault:uninstall', (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const vault = ensureCapabilityVaultService();
      const id = typeof rawId === 'string' ? rawId : '';
      if (!vault || !id) return { ok: false, error: 'invalid_request' };
      // 先取关联定义再清链：卸载后同步停用个人化技能定义（仍可手动重开）。
      const detail = vault.getDetail(id);
      const removed = vault.uninstall(id);
      if (removed && detail?.installedDefinitionId && personalizationRepository) {
        const existing = personalizationRepository.get(detail.installedDefinitionId);
        if (existing) {
          personalizationRepository.save({
            contractVersion: PERSONALIZATION_CONTRACT_VERSION,
            definition: {
              ...existing,
              enabled: false,
              revision: existing.revision + 1,
              provenance: { ...existing.provenance, updatedAt: Date.now() },
            },
            expectedRevision: existing.revision,
          });
        }
      }
      return { ok: true, removed };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'uninstall_failed' };
    }
  });

  // ── MCP Servers ─────────────────────────────────────────
  ipcMain.handle('fundingTemplate:invoke', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const repository = fundingTemplateRepository;
      const service = fundingTemplateService;
      if (!repository || !service || !researchRepository) {
        return decodeFundingTemplateRuntimeResponse(null);
      }
      const owner = executionOwnerFor(event);
      const ipc = new FundingTemplateIpcService({
        repository,
        service,
        projectExists: (projectId) => Boolean(researchRepository?.getProject(projectId)),
        consumeFundingFile: (capabilityId) => {
          const resolved = fileCapabilities.consume(
            { capabilityId, operation: 'file' },
            owner,
            'funding-template',
          );
          return resolved.ok
            ? { filePath: resolved.resolvedPath, trustedRoot: path.dirname(resolved.resolvedPath) }
            : null;
        },
      });
      return decodeFundingTemplateRuntimeResponse(
        await ipc.handle(FUNDING_LOCAL_OWNER_ID, rawRequest),
      );
    } catch {
      return decodeFundingTemplateRuntimeResponse(null);
    }
  });

/** 把申报书模板包压缩为逐栏结构文本（栏目树 + 要求 + 限字 + 填写槽）。 */
function buildFundingTemplateDigest(pkg: { source?: { sourceFormat?: string; pageCount?: number }; sections: Array<{ sectionId: string; normalizedTitle: string; level: number; order: number; required: { value: unknown } }>; instructions: Array<{ sectionId: string | null; normalizedText: string; maxLength: { value: unknown; unit: unknown } | null }>; contentSlots: Array<{ sectionId: string | null; normalizedLabel: string; maxLength: { value: unknown; unit: unknown } | null }> }): string {
  const sectionLines: string[] = [];
  const sectionsById = new Map(pkg.sections.map((section) => [section.sectionId, section]));
  const orderedSections = [...pkg.sections].sort((left, right) => left.order - right.order);
  for (const section of orderedSections) {
    const indent = '  '.repeat(Math.max(0, section.level - 1));
    sectionLines.push(`${indent}- ${section.normalizedTitle}${section.required.value === true ? '（必填）' : ''}`);
    for (const instruction of pkg.instructions.filter((item) => item.sectionId === section.sectionId)) {
      const limit = instruction.maxLength ? `（限 ${String(instruction.maxLength.value)} ${instruction.maxLength.unit === 'words' ? '词' : '字'}）` : '';
      sectionLines.push(`${indent}  · 要求：${instruction.normalizedText}${limit}`);
    }
  }
  for (const slot of pkg.contentSlots) {
    const section = slot.sectionId ? sectionsById.get(slot.sectionId) : null;
    const limit = slot.maxLength ? `（限 ${String(slot.maxLength.value)} ${slot.maxLength.unit === 'words' ? '词' : '字'}）` : '';
    sectionLines.push(`${section ? `  - 填写槽：${section.normalizedTitle} / ` : '- 填写槽：'}${slot.normalizedLabel}${limit}`);
  }
  return [
    `申报书结构（来源格式 ${pkg.source?.sourceFormat ?? '未知'}，共 ${pkg.source?.pageCount ?? '?'} 页）：`,
    ...sectionLines,
  ].join('\n');
}

  // 「申报书填写草稿」（2026-09-01）：读取已分析的申报书模板结构（栏目/要求/限字），
  // 结合刘总提供的素材生成逐栏填写草稿（Markdown）。生成不落库，导出与保存由前端决定。
  ipcMain.handle('fundingTemplate:draftOutline', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsedInput = z.object({
        projectId: z.string().min(1),
        templateId: z.string().min(1).max(160),
        materialText: z.string().max(20_000).optional(),
      }).safeParse(raw);
      if (!parsedInput.success) return { ok: false as const, code: 'invalid_request', message: '申报书草稿请求无效。' };
      if (!fundingTemplateService) return { ok: false as const, code: 'unavailable', message: '申报书模板服务尚未就绪。' };
      const active = fundingTemplateService.getActive(FUNDING_LOCAL_OWNER_ID, parsedInput.data.projectId, parsedInput.data.templateId);
      if (!active.ok) return { ok: false as const, code: active.code, message: '未能读取已分析的申报书模板（请先在上方导入并分析模板）。' };
      const pkg = active.value;
      if (!agentLoop) return { ok: false as const, code: 'agent_not_initialized', message: 'AI 服务尚未初始化。' };

      const templateDigest = buildFundingTemplateDigest(pkg);

      const systemPrompt = [
        '你是基金申报书填写助手。根据申报书的栏目结构和你拿到的申请材料，为每个栏目起草填写内容。',
        '要求：',
        '1. 输出 Markdown：每个一级/二级栏目一个标题，标题下给出该栏的填写草稿正文。',
        '2. 草稿必须优先使用材料中真实可查的内容（成果、经历、数据）；材料没有覆盖的栏目，写出结构化的填写框架和「待补充：…」清单，不要编造事实、数字、论文或经费。',
        '3. 尊重每栏的限字要求，在草稿末尾用（约 N 字）标注预估字数。',
        '4. 语言风格与正式申报书一致（学术、凝练、第一人称复数或按规定），不写自我说明。',
      ].join('\n');
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `fundingTemplate:draftOutline:${Date.now().toString(36)}`,
        rejection: { ok: false as const, code: 'application_shutting_down' },
      });
      if (!tracked.admitted) return tracked.rejection;
      try {
        const userContent = [
          templateDigest,
          parsedInput.data.materialText ? `\n申请材料（仅供参考，仅使用其中真实存在的内容）：\n${parsedInput.data.materialText}` : '\n（未提供申请材料：所有栏目只给填写框架与待补充清单。）',
        ].join('\n');
        const answer = await runEphemeralChatTurn({
          agentLoop,
          sessionId: `funding-draft-${Date.now().toString(36)}`,
          messages: [{ role: 'user', content: userContent }],
          requestId: `funding_draft_${Date.now().toString(36)}`,
          maxTurns: 1,
          allowedTools: [],
          skillPrompt: systemPrompt,
          signal: tracked.signal,
        });
        if (answer.status !== 'completed' || !answer.answer.trim()) {
          return { ok: false as const, code: 'generation_failed', message: `草稿生成未完成（${answer.status}）。` };
        }
        return { ok: true as const, markdown: answer.answer };
      } finally {
        tracked.cleanup();
      }
    } catch (error) {
      return { ok: false as const, code: 'draft_failed', message: error instanceof Error ? error.message : String(error) };
    }
  });
  // 「助手内上传申报书模板」（2026-09-01 刘总要求）：场景配置助手里直接选
  // PDF/DOCX → 安全观察+分析入库（固定模板 ID 形成版本链）→ 返回栏目结构摘要，
  // 供编译指令按申报书栏目组织交付物。
  ipcMain.handle('fundingTemplate:analyzeForAssistant', async (event, raw: unknown) => {
    try {
      const window = requireRendererMainFrame(event);
      if (!fundingTemplateService || !fundingTemplateRepository) return { ok: false as const, message: '申报书模板服务尚未就绪。' };
      const parsedInput = z.object({ projectId: z.string().min(1) }).safeParse(raw);
      if (!parsedInput.success) return { ok: false as const, message: '请求无效。' };
      const selected = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: '申报书模板', extensions: ['pdf', 'docx'] }] });
      if (selected.canceled || !selected.filePaths[0]) return { ok: false as const, message: '已取消上传。' };
      const filePath = selected.filePaths[0]!;
      const templateId = 'user:funding-template';
      const existing = fundingTemplateRepository.getTemplate(FUNDING_LOCAL_OWNER_ID, parsedInput.data.projectId, templateId, true);
      let expectedTemplateRevision = 0;
      let expectedActiveVersion: number | null = null;
      let expectedActiveDigest: string | null = null;
      if (existing.ok) {
        const record = existing.value;
        const activePkg = record.versions.find((candidate) => candidate.version === record.activeVersion);
        expectedTemplateRevision = record.revision;
        expectedActiveVersion = record.activeVersion;
        expectedActiveDigest = activePkg ? activePkg.packageDigest : null;
      } else if (existing.code !== 'not_found') {
        return { ok: false as const, message: `模板库读取失败（${existing.code}）。` };
      }
      const imported = await fundingTemplateService.importOrReanalyze({
        ownerId: FUNDING_LOCAL_OWNER_ID,
        projectId: parsedInput.data.projectId,
        templateId,
        filePath,
        trustedRoot: path.dirname(filePath),
        expectedTemplateRevision,
        expectedActiveVersion,
        expectedActiveDigest,
      });
      if (!imported.ok) {
        const labels: Record<string, string> = {
          invalid_request: '请求无效', not_found: '模板不存在', archived: '模板已归档，请先恢复',
          cas_conflict: '模板版本已变化，请重试', source_unchanged: '文件与已保存版本相同，无需重新上传',
          observation_failed: '无法安全读取模板结构', docx_layout_unobservable: '模板结构无法解析',
          analysis_failed: '模板分析失败', package_invalid: '模板包完整性校验失败',
          sensitive_content: '检测到不应保存的敏感内容', repository_busy: '模板库正忙',
          repository_corrupt: '模板库损坏', persist_failed: '模板保存失败', invalid_package: '模板包无效',
        };
        return { ok: false as const, message: `模板分析未完成：${labels[imported.code] ?? imported.code}` };
      }
      const active = fundingTemplateService.getActive(FUNDING_LOCAL_OWNER_ID, parsedInput.data.projectId, templateId);
      if (!active.ok) return { ok: false as const, message: '模板已保存，但读取栏目结构失败。' };
      const summary = buildFundingTemplateDigest(active.value);
      return { ok: true as const, templateId, summary };
    } catch (error) {
      return { ok: false as const, message: `模板分析失败：${error instanceof Error ? error.message : String(error)}` };
    }
  });
  // 投稿参谋（2026-09-01 刘总规格）：Artifact+Browser+Intent 三上下文编排对话。
  // ── 投稿短名单持久化（任务6 补齐 2026-09-08）：schema/桥已在，handler 此前缺失 ──
  ipcMain.handle('submission:shortlist:list', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ projectId: z.string().min(1) }).safeParse(rawRequest);
      if (!parsed.success || !store) return [];
      return store.raw.prepare('SELECT id, name, source, url, note, created_at FROM submission_shortlists WHERE project_id = ? ORDER BY created_at DESC')
        .all(parsed.data.projectId) as Array<{ id: string; name: string; source: string; url: string; note: string; created_at: number }>;
    } catch { return []; }
  });
  ipcMain.handle('submission:shortlist:add', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({
        projectId: z.string().min(1),
        name: z.string().min(1).max(300),
        source: z.string().max(120).optional(),
        url: z.string().max(2000).optional(),
        note: z.string().max(2000).optional(),
      }).safeParse(rawRequest);
      if (!parsed.success || !store) return { ok: false };
      const existing = store.raw.prepare('SELECT id FROM submission_shortlists WHERE project_id = ? AND name = ?')
        .get(parsed.data.projectId, parsed.data.name);
      if (existing) return { ok: true };
      store.raw.prepare('INSERT INTO submission_shortlists (id, project_id, name, source, url, note, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(`sl-${randomUUID()}`, parsed.data.projectId, parsed.data.name, parsed.data.source ?? '', parsed.data.url ?? '', parsed.data.note ?? '', Date.now());
      return { ok: true };
    } catch { return { ok: false }; }
  });
  ipcMain.handle('submission:shortlist:remove', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ projectId: z.string().min(1), name: z.string().min(1) }).safeParse(rawRequest);
      if (!parsed.success || !store) return { ok: false };
      const info = store.raw.prepare('DELETE FROM submission_shortlists WHERE project_id = ? AND name = ?')
        .run(parsed.data.projectId, parsed.data.name);
      return { ok: info.changes > 0 };
    } catch { return { ok: false }; }
  });
  ipcMain.handle('submission:assistant:chat', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!agentLoop) return { ok: false as const, answer: '', error: '模型连接尚未配置或尚未就绪。请先在「设置 → 模型连接」完成配置，再使用投稿参谋。' };
      if (!outcomeRepository) return { ok: false as const, answer: '', error: '成果服务尚未就绪，请稍后重试。' };
      const parsedInput = z.object({
        projectId: z.string().min(1),
        outcomeId: z.string().min(1),
        instruction: z.string().min(1).max(20_000),
        thinkingLevel: z.string().optional(),
        intent: z.record(z.string(), z.unknown()).optional(),
        shortlist: z.array(z.object({ name: z.string(), source: z.string().optional() })).max(24).optional(),
        // 任务6(2026-09-05):参谋对话记忆——前端回传最近对话,避免每轮失忆。
        history: z.array(z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().max(20_000),
        })).max(16).optional(),
      }).safeParse(raw);
      if (!parsedInput.success) return { ok: false as const, answer: '', error: '请求无效。' };
      const service = new SubmissionAssistantService({
        agentLoop,
        browser: {
          navigate: async (url) => {
            const service = ensureBrowserService();
            if (!service) return { ok: false, error: 'browser_unavailable' };
            return service.navigate(url);
          },
          extract: async () => {
            const service = ensureBrowserService();
            if (!service) return { ok: false, error: 'browser_unavailable' };
            return service.extract();
          },
          // 任务2 上下文隔离：参谋注入浏览器上下文前按项目归属校验。
          extractScoped: async (projectId) => {
            const service = ensureBrowserService();
            if (!service) return { ok: false, error: 'browser_unavailable' };
            return service.extractScoped(projectId ?? null);
          },
        },
        loadOutcome: (projectId, outcomeId) => {
          const repository = outcomeRepository;
          if (!repository) return null;
          const detail = repository.get(projectId, outcomeId);
          return detail ? { title: detail.outcome.title, content: detail.version.content } : null;
        },
      });
      return await service.chat({ ...parsedInput.data, thinkingLevel: parsedInput.data.thinkingLevel });
    } catch (error) {
      return { ok: false as const, answer: '', error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('personalization:list', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.list(rawRequest) ?? { ok: false, code: 'unavailable' };
    } catch {
      return { ok: false, code: 'unavailable' };
    }
  });
  ipcMain.handle('personalization:trash:list', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.listTrash(rawRequest) ?? { ok: false, code: 'unavailable' };
    } catch {
      return { ok: false, code: 'unavailable' };
    }
  });
  ipcMain.handle('personalization:integrity:list', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.listIntegrityIssues(rawRequest) ?? { ok: false, code: 'unavailable' };
    } catch {
      return { ok: false, code: 'unavailable' };
    }
  });
  ipcMain.handle('personalization:integrity:recover', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.recoverIntegrityIssue(rawRequest) ?? { ok: false, code: 'io_error' };
    } catch {
      return { ok: false, code: 'io_error' };
    }
  });
  ipcMain.handle('personalization:get', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.get(rawRequest) ?? { ok: true, definition: null };
    } catch {
      return { ok: true, definition: null };
    }
  });
  // ── 项目默认场景(2026-09-04 多对话架构):正式持久化于 project.metadata.defaultScenarioId;
  // 仅作为「新建对话默认推荐值」,不锁定项目;legacy localStorage 键在首次读取时迁移进来。──
  // ── 成果提示词工程(2026-09-05 刘总要求,任务4)──
  ipcMain.handle('outcomePrompt:list', (event) => {
    try { requireRendererMainFrame(event); return artifactPromptService?.listViews() ?? []; } catch { return []; }
  });
  ipcMain.handle('outcomePrompt:get', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ promptId: z.string().min(1).max(80) }).safeParse(raw);
      if (!parsed.success) return null;
      return artifactPromptService?.getView(parsed.data.promptId) ?? null;
    } catch { return null; }
  });
  ipcMain.handle('outcomePrompt:saveOverride', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({
        promptId: z.string().min(1).max(80),
        content: z.string().max(20_000),
        enabled: z.boolean().optional(),
        note: z.string().max(300).optional(),
      }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'invalid_request' };
      return artifactPromptService?.saveOverride({ ...parsed.data, source: 'manual' as const }) ?? { ok: false, code: 'persistence_unavailable' };
    } catch { return { ok: false, code: 'save_failed' }; }
  });
  ipcMain.handle('outcomePrompt:setEnabled', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ promptId: z.string().min(1).max(80), enabled: z.boolean() }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'invalid_request' };
      return artifactPromptService?.setEnabled(parsed.data.promptId, parsed.data.enabled) ?? { ok: false, code: 'persistence_unavailable' };
    } catch { return { ok: false, code: 'failed' }; }
  });
  ipcMain.handle('outcomePrompt:reset', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ promptId: z.string().min(1).max(80) }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'invalid_request' };
      return artifactPromptService?.resetOverride(parsed.data.promptId) ?? { ok: false, code: 'persistence_unavailable' };
    } catch { return { ok: false, code: 'failed' }; }
  });
  ipcMain.handle('outcomePrompt:listRevisions', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ promptId: z.string().min(1).max(80) }).safeParse(raw);
      if (!parsed.success) return [];
      return artifactPromptService?.listRevisions(parsed.data.promptId) ?? [];
    } catch { return []; }
  });
  ipcMain.handle('outcomePrompt:restoreRevision', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ promptId: z.string().min(1).max(80), revisionId: z.string().min(1).max(80) }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'invalid_request' };
      return artifactPromptService?.restoreRevision(parsed.data.promptId, parsed.data.revisionId) ?? { ok: false, code: 'persistence_unavailable' };
    } catch { return { ok: false, code: 'failed' }; }
  });
  ipcMain.handle('outcomePrompt:export', (event) => {
    try { requireRendererMainFrame(event); return artifactPromptService?.exportPack() ?? null; } catch { return null; }
  });
  ipcMain.handle('outcomePrompt:import', (event, raw: unknown) => {
    try { requireRendererMainFrame(event); return artifactPromptService?.importPack(raw) ?? { ok: false, code: 'persistence_unavailable' }; } catch { return { ok: false, code: 'failed' }; }
  });
  // ── METIS Office Prompt Profiles(2026-09-05 刘总要求,任务5)──
  // ── Skill Studio(2026-09-05 刘总要求,任务7):经验→结构化技能 → 沙箱测试 ──
  ipcMain.handle('skillStudio:generate', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({
        experience: z.string().min(1).max(20_000),
        source: z.enum(['from_scratch', 'from_experience', 'from_files', 'from_session']),
      }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'invalid_request' };
      if (!agentLoop) return { ok: false, code: 'agent_unavailable' };
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `skillStudio:generate:${Date.now().toString(36)}`,
        rejection: { ok: false as const, code: 'application_shutting_down' },
      });
      if (!tracked.admitted) return tracked.rejection;
      const elicitation = buildExperienceElicitationPrompt(parsed.data.experience, parsed.data.source as SkillStudioSource);
      const answer = await runEphemeralChatTurn({
        agentLoop,
        sessionId: `skill-studio-${Date.now().toString(36)}`,
        requestId: `skill_studio_${Date.now().toString(36)}`,
        skillPrompt: elicitation.system,
        messages: [{ role: 'user', content: elicitation.user }],
        maxTurns: 1,
        allowedTools: [],
        acceptUnverified: true,
        signal: tracked.signal,
      });
      if (answer.status !== 'completed') return { ok: false as const, code: 'generation_failed', message: 'AI 萃取未完成,可重试;已有描述已保留。' };
      const jsonText = answer.answer.slice(answer.answer.indexOf('{'), answer.answer.lastIndexOf('}') + 1);
      try {
        const parsedSkill = JSON.parse(jsonText) as Record<string, unknown>;
        return { ok: true as const, skill: parsedSkill };
      } catch {
        return { ok: false as const, code: 'parse_failed', message: 'AI 输出无法解析,可重试。' };
      }
    } catch (error) {
      return { ok: false as const, code: 'failed', message: error instanceof Error ? error.message.slice(0, 200) : undefined };
    }
  });
  ipcMain.handle('skillStudio:testRun', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({
        systemPrompt: z.string().min(1).max(100_000),
        allowedTools: z.array(z.string().max(80)).max(24),
        message: z.string().min(1).max(16_000),
      }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'invalid_request' };
      if (!agentLoop) return { ok: false, code: 'agent_unavailable' };
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `skillStudio:testRun:${Date.now().toString(36)}`,
        rejection: { ok: false as const, code: 'application_shutting_down' },
      });
      if (!tracked.admitted) return tracked.rejection;
      // Test Run 沙箱(任务7 文档十九节):只暴露当前 Skill + 测试明确需要的 Native Tool,
      // 结束即释放(临时会话,不落库,无场景绑定)。
      const options = buildTestRunOptions({
        systemPrompt: parsed.data.systemPrompt,
        allowedTools: parsed.data.allowedTools,
        message: parsed.data.message,
      });
      const answer = await runEphemeralChatTurn({
        agentLoop,
        sessionId: options.sessionId,
        requestId: `skill_studio_test_${Date.now().toString(36)}`,
        skillPrompt: options.skillPrompt,
        messages: [{ role: 'user', content: options.message }],
        maxTurns: options.maxTurns,
        allowedTools: options.allowedTools,
        acceptUnverified: true,
        signal: tracked.signal,
      });
      return { ok: answer.status === 'completed', status: answer.status, answer: answer.answer.slice(0, 40_000) };
    } catch (error) {
      return { ok: false, code: 'failed', message: error instanceof Error ? error.message.slice(0, 200) : undefined };
    }
  });
  ipcMain.handle('officePrompt:capabilities', (event) => {
    try { requireRendererMainFrame(event); return officePromptProfileService?.listCapabilitySummaries() ?? []; } catch { return []; }
  });
  ipcMain.handle('officePrompt:profiles', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ officeKind: z.string().min(1).max(40) }).safeParse(raw);
      if (!parsed.success) return [];
      return officePromptProfileService?.listProfiles(parsed.data.officeKind) ?? [];
    } catch { return []; }
  });
  ipcMain.handle('officePrompt:createProfile', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ officeKind: z.string().min(1).max(40), name: z.string().max(120), description: z.string().max(500).optional(), fromProfileId: z.string().max(80).optional() }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'invalid_request' };
      return officePromptProfileService?.createProfile(parsed.data) ?? { ok: false, code: 'persistence_unavailable' };
    } catch { return { ok: false, code: 'failed' }; }
  });
  ipcMain.handle('officePrompt:updateProfile', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ profileId: z.string().min(1).max(80), name: z.string().max(120).optional(), description: z.string().max(500).optional() }).safeParse(raw);
      if (!parsed.success) return null;
      return officePromptProfileService?.updateProfile(parsed.data.profileId, parsed.data) ?? null;
    } catch { return null; }
  });
  ipcMain.handle('officePrompt:deleteProfile', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ profileId: z.string().min(1).max(80) }).safeParse(raw);
      if (!parsed.success) return false;
      return officePromptProfileService?.deleteProfile(parsed.data.profileId) ?? false;
    } catch { return false; }
  });
  ipcMain.handle('officePrompt:deletedProfiles', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ officeKind: z.string().min(1) }).safeParse(rawRequest);
      return parsed.success && officePromptProfileService ? officePromptProfileService.listDeletedProfiles(parsed.data.officeKind) : [];
    } catch { return []; }
  });
  ipcMain.handle('officePrompt:restoreProfile', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ profileId: z.string().min(1).max(80) }).safeParse(raw);
      if (!parsed.success) return null;
      return officePromptProfileService?.restoreProfile(parsed.data.profileId) ?? null;
    } catch { return null; }
  });
  ipcMain.handle('officePrompt:setSlot', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ profileId: z.string().min(1).max(80), slotId: z.string().min(1).max(80), content: z.string().max(20_000) }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'invalid_request' };
      return officePromptProfileService?.setSlot(parsed.data.profileId, parsed.data.slotId, parsed.data.content) ?? { ok: false, code: 'persistence_unavailable' };
    } catch { return { ok: false, code: 'failed' }; }
  });
  ipcMain.handle('officePrompt:setDefault', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ officeKind: z.string().min(1).max(40), profileId: z.string().min(1).max(80) }).safeParse(raw);
      if (!parsed.success) return { ok: false, code: 'invalid_request' };
      return officePromptProfileService?.setDefaultProfile(parsed.data.officeKind, parsed.data.profileId) ?? { ok: false, code: 'persistence_unavailable' };
    } catch { return { ok: false, code: 'failed' }; }
  });
  ipcMain.handle('officePrompt:getBinding', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ outcomeId: z.string().min(1) }).safeParse(rawRequest);
      return parsed.success && officePromptProfileService ? officePromptProfileService.getOutcomeBinding(parsed.data.outcomeId) : null;
    } catch { return null; }
  });
  ipcMain.handle('officePrompt:bindOutcome', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ outcomeId: z.string().min(1).max(160), profileId: z.string().max(80).nullable() }).safeParse(raw);
      if (!parsed.success) return { ok: false };
      if (!officePromptProfileService) return { ok: false };
      if (parsed.data.profileId) return officePromptProfileService.bindOutcome(parsed.data.outcomeId, parsed.data.profileId);
      officePromptProfileService.unbindOutcome(parsed.data.outcomeId);
      return { ok: true };
    } catch { return { ok: false }; }
  });
  ipcMain.handle('officePrompt:resolveSlot', (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ officeKind: z.string().min(1).max(40), outcomeId: z.string().max(160).nullable().optional(), slotId: z.string().min(1).max(80) }).safeParse(raw);
      if (!parsed.success) return null;
      return { content: officePromptProfileService?.resolveSlot(parsed.data.officeKind, parsed.data.outcomeId ?? null, parsed.data.slotId) ?? null };
    } catch { return null; }
  });
  ipcMain.handle('outcomePrompt:assist', async (event, raw: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ promptId: z.string().min(1).max(80), instruction: z.string().min(1).max(4000) }).safeParse(raw);
      if (!parsed.success) return { ok: false as const, code: 'invalid_request' };
      if (!agentLoop) return { ok: false as const, code: 'agent_unavailable' };
      const definition = artifactPromptService?.getView(parsed.data.promptId);
      if (!definition) return { ok: false as const, code: 'unknown_prompt' };
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `outcomePrompt:assist:${Date.now().toString(36)}`,
        rejection: { ok: false as const, code: 'application_shutting_down' },
      });
      if (!tracked.admitted) return tracked.rejection;
      const answer = await runEphemeralChatTurn({
        agentLoop,
        sessionId: `outcome-prompt-assist-${Date.now().toString(36)}`,
        requestId: `outcome_prompt_assist_${Date.now().toString(36)}`,
        messages: [{ role: 'user', content: [
          `当前「${definition.definition.name}」提示词:`,
          '<<<CURRENT',
          definition.effectiveContent,
          'CURRENT>>>',
          `用户要求:${parsed.data.instruction}`,
          '请输出修改后的完整提示词(只输出提示词正文,不要解释、不要代码围栏)。保持提示词与「' + definition.definition.scopeNote + '」的范围一致,不要包含工具协议或 JSON 输出契约。',
        ].join('\n') }],
        maxTurns: 1,
        allowedTools: [],
        acceptUnverified: true,
        signal: tracked.signal,
      });
      if (answer.status !== 'completed') return { ok: false as const, code: answer.status, message: 'AI 建议生成未完成,可重试。' };
      let suggestion = answer.answer.trim();
      const fence = suggestion.match(/```[\s\S]*?```/u);
      if (fence) suggestion = fence[0].replace(/```(?:json|text)?\s*/u, '').replace(/\s*```$/u, '').trim();
      return { ok: true as const, suggestion };
    } catch (error) {
      return { ok: false as const, code: 'assist_failed', message: error instanceof Error ? error.message.slice(0, 200) : undefined };
    }
  });
  ipcMain.handle('projects:getDefaultScenario', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ projectId: z.string().min(1).max(160) }).safeParse(rawRequest);
      if (!parsed.success || !researchRepository) return { scenarioId: null };
      const project = researchRepository.getProject(parsed.data.projectId, false);
      const value = project && typeof project.metadata === 'object' && project.metadata ? project.metadata.defaultScenarioId : null;
      return { scenarioId: typeof value === 'string' && value ? value : null };
    } catch { return { scenarioId: null }; }
  });
  ipcMain.handle('projects:setDefaultScenario', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ projectId: z.string().min(1).max(160), scenarioId: z.string().max(160).nullable() }).safeParse(rawRequest);
      if (!parsed.success || !researchRepository) return { ok: false };
      const project = researchRepository.getProject(parsed.data.projectId, false);
      if (!project) return { ok: false };
      const metadata = typeof project.metadata === 'object' && project.metadata ? { ...project.metadata } : {};
      if (parsed.data.scenarioId) metadata.defaultScenarioId = parsed.data.scenarioId;
      else delete metadata.defaultScenarioId;
      return { ok: researchRepository.updateProject(parsed.data.projectId, { metadata }) !== null };
    } catch { return { ok: false }; }
  });
  ipcMain.handle('officePrompt:setGlobal', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ profileId: z.string().min(1), content: z.string().max(20_000) }).safeParse(rawRequest);
      return parsed.success && officePromptProfileService ? officePromptProfileService.setGlobalPrompt(parsed.data.profileId, parsed.data.content) : null;
    } catch { return null; }
  });
  ipcMain.handle('officePrompt:getGlobal', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ officeKind: z.string().min(1), outcomeId: z.string().nullable().optional() }).safeParse(rawRequest);
      return parsed.success && officePromptProfileService ? officePromptProfileService.resolveGlobal(parsed.data.officeKind, parsed.data.outcomeId ?? null) : null;
    } catch { return null; }
  });
  ipcMain.handle('projects:updateMetadata', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsed = z.object({ projectId: z.string().min(1), key: z.string().min(1).max(60), value: z.unknown() }).safeParse(rawRequest);
      if (!parsed.success || !researchRepository) return { ok: false };
      const project = researchRepository.getProject(parsed.data.projectId, false);
      if (!project) return { ok: false };
      const metadata = typeof project.metadata === 'object' && project.metadata ? { ...project.metadata, [parsed.data.key]: parsed.data.value } : { [parsed.data.key]: parsed.data.value };
      // ResearchRepository 的 update 通道（项目元数据原子写入）。
      return { ok: researchRepository.updateProject(parsed.data.projectId, { metadata }) !== null };
    } catch { return { ok: false }; }
  });
  ipcMain.handle('personalization:save', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.save(rawRequest) ?? { ok: false, code: 'io_error' };
    } catch {
      return { ok: false, code: 'invalid_request' };
    }
  });

  ipcMain.handle('personalization:archive', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.archive(rawRequest) ?? { ok: false, code: 'io_error' };
    } catch {
      return { ok: false, code: 'invalid_request' };
    }
  });
  ipcMain.handle('personalization:delete', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.deletePermanent(rawRequest, uninstallSkillAssetsForDefinition)
        ?? { ok: false as const, code: 'io_error' as const };
    } catch {
      return { ok: false, code: 'invalid_request' };
    }
  });
  ipcMain.handle('personalization:fork', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.fork(rawRequest) ?? { ok: false, code: 'io_error' };
    } catch {
      return { ok: false, code: 'invalid_request' };
    }
  });
  ipcMain.handle('personalization:restore', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.restore(rawRequest) ?? { ok: false, code: 'io_error' };
    } catch {
      return { ok: false, code: 'invalid_request' };
    }
  });
  ipcMain.handle('personalization:trash:restore', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.restoreFromTrash(rawRequest) ?? { ok: false, code: 'io_error' };
    } catch {
      return { ok: false, code: 'invalid_request' };
    }
  });

  ipcMain.handle('personalization:versions', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.versions(rawRequest) ?? { ok: true as const, versions: [] };
    } catch {
      return { ok: true as const, versions: [] };
    }
  });
  ipcMain.handle('personalization:resolve', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      return personalizationRuntime?.resolve(rawRequest) ?? {
        ok: false,
        code: 'definition_corrupt',
        issues: ['Personalization persistence is unavailable'],
      };
    } catch {
      return { ok: false, code: 'definition_corrupt', issues: ['Invalid personalization request'] };
    }
  });

  // ── AI 辅助创建场景：描述需求 → 生成场景 + 智能体 + 工作流 ──
  const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
  function parseAiScenarioGeneration(answer: string): {
    scenario: { name: string; description: string; triggerPhrases: string[]; deliverable: string };
    agents: Array<{ name: string; role: string; systemPrompt: string; skillIds: string[]; toolIds: string[]; mcpIds: string[]; maxTurns: number }>;
    workflow: Array<{ name: string; description: string; agent: string; skillIds: string[]; toolIds: string[]; mcpIds: string[]; maxTurns: number }>;
    rules: string;
    paperStructure: Array<{ title: string; instruction: string }> | null;
  } | null {
    const cleaned = answer.replace(/```(?:json)?/gu, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
    if (!isRecord(parsed)) return null;
    const scenario = isRecord(parsed.scenario) ? parsed.scenario : null;
    const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
    const workflow = Array.isArray(parsed.workflow) ? parsed.workflow : [];
    if (!scenario || agents.length === 0 || agents.length > 4 || workflow.length > 12) return null;
    const str = (value: unknown, maximum: number): string => (
      typeof value === 'string' ? value.trim().slice(0, maximum) : ''
    );
    const strList = (value: unknown): string[] => (
      Array.isArray(value)
        ? value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean).slice(0, 64)
        : []
    );
    const turns = (value: unknown): number => (
      typeof value === 'number' && Number.isFinite(value)
        ? Math.min(100, Math.max(1, Math.floor(value)))
        : 12
    );
    const normalizedAgents = agents
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        name: str(item.name, 30),
        role: str(item.role, 100),
        systemPrompt: str(item.systemPrompt, 600),
        skillIds: strList(item.skillIds),
        toolIds: strList(item.toolIds),
        mcpIds: strList(item.mcpIds),
        maxTurns: turns(item.maxTurns),
      }))
      .filter((item) => item.name)
      .slice(0, 4);
    if (normalizedAgents.length === 0) return null;
    const agentNames = new Set(normalizedAgents.map((item) => item.name));
    const normalizedWorkflow = workflow
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        name: str(item.name, 100),
        description: str(item.description, 150),
        agent: str(item.agent, 30),
        skillIds: strList(item.skillIds),
        toolIds: strList(item.toolIds),
        mcpIds: strList(item.mcpIds),
        maxTurns: turns(item.maxTurns),
      }))
      .filter((step) => step.name && agentNames.has(step.agent))
      .slice(0, 12);
    const rules = typeof parsed.rules === 'string' ? parsed.rules.trim().slice(0, 1500) : '';
    const rawStructure = Array.isArray(parsed.paperStructure) ? parsed.paperStructure : [];
    const paperStructure = rawStructure
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        title: str(item.title, 80),
        instruction: str(item.instruction, 250) || str(item.style, 120),
      }))
      .filter((section) => section.title)
      .slice(0, 16);
    return {
      scenario: {
        name: str(scenario.name, 40) || (normalizedAgents[0]?.name ?? '研究场景'),
        description: str(scenario.description, 200),
        triggerPhrases: strList(scenario.triggerPhrases).slice(0, 12),
        deliverable: str(scenario.deliverable, 200),
      },
      agents: normalizedAgents,
      workflow: normalizedWorkflow,
      rules,
      paperStructure: paperStructure.length > 0 ? paperStructure : null,
    };
  }

  ipcMain.handle('personalization:aiGenerateScenario', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!isRecord(rawRequest)) return { ok: false, code: 'invalid_request' };
      const description = typeof rawRequest.description === 'string' ? rawRequest.description.trim() : '';
      if (description.length < 2 || description.length > 2000) {
        return { ok: false, code: 'invalid_request' };
      }
      const rawDefinitions = Array.isArray(rawRequest.definitions) ? rawRequest.definitions : [];
      const definitions = rawDefinitions
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => ({
          id: typeof item.id === 'string' ? item.id : '',
          kind: typeof item.kind === 'string' ? item.kind : 'unknown',
          name: typeof item.name === 'string' ? item.name : '',
          description: typeof item.description === 'string' ? item.description : '',
        }))
        .filter((item) => item.id && item.name)
        .slice(0, 500);
      if (!agentLoop) return { ok: false, code: 'agent_not_initialized' };
      const catalog = definitions.length > 0
        ? definitions.map((d) => `- ${d.kind}「${d.name}」 id=${d.id}${d.description ? `：${d.description}` : ''}`).join('\n')
        : '（暂无现有定义）';
      const systemPrompt = [
        '你是一个人文社科研究场景设计助手。用户用一句话描述他想要的研究场景，你需要输出一个可直接落地的场景设计。',
        '要求：',
        '1. 只输出一个 JSON 对象，不要输出任何解释、前后缀或 Markdown 代码围栏。',
        '2. JSON 结构：',
        '   { "scenario": { "name": "场景名称(不超过40字)", "description": "场景说明(不超过200字)", "triggerPhrases": ["触发词1","触发词2"], "deliverable": "最终交付物描述(可选，不超过200字)" },',
        '     "agents": [ { "name": "智能体名称(不超过30字)", "role": "角色", "systemPrompt": "系统指令(不超过600字)", "skillIds": ["已有技能id"], "toolIds": ["工具id"], "mcpIds": ["已有MCP id"], "maxTurns": 12 } ],',
        '     "workflow": [ { "name": "步骤名称", "description": "步骤说明(不超过150字)", "agent": "智能体名称(必须是 agents 中的名称)", "skillIds": [], "toolIds": [], "mcpIds": [], "maxTurns": 12 } ],',
        '     "rules": "场景记忆 Metis.md 文档（Markdown，不超过1500字）：写明该场景的研究目标、资料与证据边界、输出规范与工作习惯，供场景内智能体遵守",',
        '     "paperStructure": [ { "title": "章节标题(如：引言)", "instruction": "该章节写作指引与文风要求(不超过250字)" } ] }',
        '3. agents 数量 1-2 个；workflow 步骤 2-6 个，按执行顺序排列。',
        '4. paperStructure 必须覆盖：引言 + 2-4 个主体章节 + 结论；每个章节给出针对性写作指引（该写什么、怎么论证、文风如何）。',
        '5. skillIds/mcpIds 只能从下面“现有定义清单”中选择，没有合适的不填。toolIds 只能使用已注册工具：read_file、write_file、web_search、compare_items、list_sources、extract_evidence、link_evidence、draft_claim、save_artifact。',
        '6. systemPrompt 用中文，写明该智能体在这个场景中的职责、行为边界与输出要求。',
        `现有定义清单：\n${catalog}`,
      ].join('\n');
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `personalization:aiGenerateScenario:${++requestCounter}`,
        rejection: { ok: false, code: 'application_shutting_down' },
      });
      if (!tracked.admitted) return tracked.rejection;
      try {
        const answer = await runEphemeralChatTurn({
          agentLoop,
          sessionId: `ai-scenario-${Date.now().toString(36)}`,
          messages: [{ role: 'user', content: `用户需求：${description}` }],
          requestId: `ai_gen_${++requestCounter}`,
          skillPrompt: systemPrompt,
          signal: tracked.signal,
        });
        if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
        if (answer.status !== 'completed' || !answer.answer.trim()) {
          const diag = answer.diagnostics?.[0];
          return { ok: false, code: 'generation_failed', message: [diag?.code, diag?.message].filter(Boolean).join(': ') || answer.status };
        }
        const parsed = parseAiScenarioGeneration(answer.answer);
        if (!parsed) return { ok: false, code: 'parse_failed' };
        return { ok: true, ...parsed };
      } catch (error) {
        if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
        return { ok: false, code: 'generation_failed', message: String((error as Error).message ?? error).slice(0, 200) };
      } finally {
        tracked.cleanup();
      }
    } catch {
      return { ok: false, code: 'generation_failed' };
    }
  });

  // ── AI 辅助创建智能体：描述需求 → 生成单个智能体定义草稿 ──
  function parseAiAgentGeneration(answer: string): {
    name: string;
    description: string;
    role: string;
    systemPrompt: string;
    maxTurns: number;
  } | null {
    const cleaned = answer.replace(/```(?:json)?/gu, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
    if (!isRecord(parsed)) return null;
    const str = (value: unknown, maximum: number): string => (
      typeof value === 'string' ? value.trim().slice(0, maximum) : ''
    );
    const name = str(parsed.name, 200);
    const role = str(parsed.role, 200);
    const systemPrompt = str(parsed.systemPrompt, 4000);
    if (!name || !role || !systemPrompt) return null;
    const maxTurns = typeof parsed.maxTurns === 'number' && Number.isFinite(parsed.maxTurns)
      ? Math.min(100, Math.max(1, Math.floor(parsed.maxTurns)))
      : 20;
    return { name, description: str(parsed.description, 2000), role, systemPrompt, maxTurns };
  }

  ipcMain.handle('personalization:aiGenerateAgent', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!isRecord(rawRequest)) return { ok: false, code: 'invalid_request' };
      const description = typeof rawRequest.description === 'string' ? rawRequest.description.trim() : '';
      if (description.length < 2 || description.length > 2000) {
        return { ok: false, code: 'invalid_request' };
      }
      if (!agentLoop) return { ok: false, code: 'agent_not_initialized' };
      const systemPrompt = [
        '你是一个研究智能体设计助手。用户用一句话描述他想要的智能体，你需要输出该智能体的定义草稿。',
        '要求：',
        '1. 只输出一个 JSON 对象，不要输出任何解释、前后缀或 Markdown 代码围栏。',
        '2. JSON 结构：',
        '   { "name": "智能体名称(不超过30字)", "description": "一句话说明(不超过120字)", "role": "角色(不超过40字)", "systemPrompt": "系统指令(600字以内，中文)", "maxTurns": 20 }',
        '3. systemPrompt 写明该智能体的职责、工作步骤、行为边界与输出要求，可直接投入使用。',
        '4. 名称与角色用中文，具体、可辨识（例如「文献综述专家」而非「助手」）。',
      ].join('\n');
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `personalization:aiGenerateAgent:${++requestCounter}`,
        rejection: { ok: false, code: 'application_shutting_down' },
      });
      if (!tracked.admitted) return tracked.rejection;
      try {
        const answer = await runEphemeralChatTurn({
          agentLoop,
          sessionId: `ai-agent-${Date.now().toString(36)}`,
          messages: [{ role: 'user', content: `用户需求：${description}` }],
          requestId: `ai_gen_${++requestCounter}`,
          skillPrompt: systemPrompt,
          signal: tracked.signal,
        });
        if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
        if (answer.status !== 'completed' || !answer.answer.trim()) {
          const diag = answer.diagnostics?.[0];
          return { ok: false, code: 'generation_failed', message: [diag?.code, diag?.message].filter(Boolean).join(': ') || answer.status };
        }
        const parsed = parseAiAgentGeneration(answer.answer);
        if (!parsed) return { ok: false, code: 'parse_failed' };
        return { ok: true, agent: parsed };
      } catch (error) {
        if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
        return { ok: false, code: 'generation_failed', message: String((error as Error).message ?? error).slice(0, 200) };
      } finally {
        tracked.cleanup();
      }
    } catch {
      return { ok: false, code: 'generation_failed' };
    }
  });

  // ── 市场：技能/MCP 检索（GitHub 源，令牌走加密凭据库）──
  const marketService = new MarketService(() => personalizationSecretVault);
  // 场景编译循环的市场搜索注入（2026-08-23）：只读，来源白名单由工具侧控制。
  // 任务7 Capability Vault（2026-09-05 刘总要求）：检索本地优先——先查已装入
  // Personalization 库的定义（可直接返回 definition id 供绑定），无命中再降级外部市场。
  scenarioAcquisition.search = async (kind, query, source) => {
    try {
      if (personalizationRepository) {
        const localKind = kind === 'skill' || kind === 'mcp' ? kind : undefined;
        const definitions = personalizationRepository.list(localKind, false);
        const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
        const matched = definitions.filter((definition) => {
          const haystack = `${definition.name}
${definition.description}`.toLowerCase();
          return terms.some((term) => haystack.includes(term));
        }).slice(0, 8);
        if (matched.length > 0) {
          return {
            ok: true as const,
            source: 'local-vault',
            results: matched.map((definition) => ({
              kind: 'name' as const,
              name: definition.name,
              owner: 'local',
              repo: definition.id,
              description: definition.description.slice(0, 300),
              url: '',
              installUrl: '',
              installable: false,
              defaultBranch: '',
              stars: 0,
              source: `local:${kind}`,
              localDefinitionId: definition.id,
            })),
          };
        }
      }
    } catch { /* 本地 Vault 检索失败降级外部市场 */ }
    return marketService.search(kind, query, source as Parameters<MarketService['search']>[2]);
  };
  ipcMain.handle('market:search', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!isRecord(rawRequest)) return { ok: false, code: 'invalid_request' };
      const kind = rawRequest.kind === 'mcp' ? 'mcp' : 'skill';
      const query = typeof rawRequest.query === 'string' ? rawRequest.query : '';
      const source = rawRequest.source === 'skillsmp'
        ? 'skillsmp'
        : rawRequest.source === 'mcpmarket_cn'
          ? 'mcpmarket_cn'
          : 'github';
      return await marketService.search(kind, query, source);
    } catch {
      return { ok: false, code: 'network_error' };
    }
  });
  ipcMain.handle('market:readSkillDoc', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!isRecord(rawRequest)) return { ok: false, code: 'invalid_request' };
      const owner = typeof rawRequest.owner === 'string' ? rawRequest.owner : '';
      const repo = typeof rawRequest.repo === 'string' ? rawRequest.repo : '';
      const ref = typeof rawRequest.ref === 'string' ? rawRequest.ref : 'main';
      const source = rawRequest.source === 'skillsmp' ? 'skillsmp' : 'github';
      const filePath = typeof rawRequest.filePath === 'string' ? rawRequest.filePath : undefined;
      return await marketService.readSkillDoc(owner, repo, ref, source, filePath);
    } catch {
      return { ok: false, code: 'network_error' };
    }
  });
  ipcMain.handle('market:readMcpDocs', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!isRecord(rawRequest)) return { ok: false, code: 'invalid_request' };
      const owner = typeof rawRequest.owner === 'string' ? rawRequest.owner : '';
      const repo = typeof rawRequest.repo === 'string' ? rawRequest.repo : '';
      const ref = typeof rawRequest.ref === 'string' ? rawRequest.ref : 'main';
      const source = rawRequest.source === 'mcpmarket_cn' ? 'mcpmarket_cn' : 'github';
      const sourceId = typeof rawRequest.sourceId === 'string' ? rawRequest.sourceId : undefined;
      return await marketService.readMcpDocs(owner, repo, ref, source, sourceId);
    } catch {
      return { ok: false, code: 'network_error' };
    }
  });

  // ── 项目参考材料库（2026-09-01 刘总要求）：上传 / 列表 / 删除 / 改大类 ──
  ipcMain.handle('scenario:material:importDialog', async (event, rawRequest: unknown) => {
    try {
      const window = requireRendererMainFrame(event);
      const parsedInput = z.object({
        projectId: z.string().min(1),
        category: z.enum(['references', 'data', 'code', 'notes', 'template_spec', 'other']).optional(),
      }).safeParse(rawRequest);
      if (!parsedInput.success) return { ok: false as const, error: '请求无效。' };
      const selected = await dialog.showOpenDialog(window, {
        title: '上传参考材料（txt/md/csv/json/docx/pdf/pptx/xlsx/py/R/do/sav/dta…）',
        filters: [
          { name: '参考材料', extensions: ['txt', 'md', 'markdown', 'csv', 'json', 'docx', 'pdf', 'pptx', 'xlsx', 'xlsm', 'py', 'r', 'do', 'sav', 'dta', 'rds'] },
          { name: '全部文件', extensions: ['*'] },
        ],
        properties: ['openFile', 'multiSelections'],
      });
      if (selected.canceled || selected.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
      const { getPdfReader } = await import('../engine/research/PdfReader.js');
      const reader = getPdfReader();
      const imported: Array<{ id: string; name: string; category: string; charCount: number; binaryArchive?: string }> = [];
      const errors: Array<{ name: string; error: string }> = [];
      for (const filePath of selected.filePaths.slice(0, 12)) {
        const fileName = filePath.split(/[/]/).pop() ?? filePath;
        try {
          const material = await scenarioMaterials.importMaterial(filePath, {
            category: parsedInput.data.category,
            projectId: parsedInput.data.projectId,
            extractPdf: (target) => reader.extractText(target),
          });
          imported.push({ id: material.id, name: material.name, category: parsedInput.data.category ?? 'other', charCount: material.charCount });
        } catch (err) {
          const rawMessage = String((err as Error).message ?? err);
          const friendly = rawMessage.startsWith('ppt_legacy_unsupported')
            ? '旧版 .ppt 请先转存为 .pptx'
            : rawMessage === 'material_too_short'
              ? '文件内容过短'
              : rawMessage === 'unsupported_material_type'
                ? '不支持的文件类型'
                : rawMessage.slice(0, 120);
          errors.push({ name: fileName, error: friendly });
        }
      }
      return { ok: true as const, imported, errors };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('scenario:material:list', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsedInput = z.object({ projectId: z.string().min(1).optional() }).safeParse(rawRequest);
      if (!parsedInput.success) return { ok: false as const, error: '请求无效。' };
      return { ok: true as const, materials: scenarioMaterials.listMaterials(parsedInput.data.projectId) };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('scenario:material:delete', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsedInput = z.object({ id: z.string().min(1).max(120) }).safeParse(rawRequest);
      if (!parsedInput.success) return { ok: false as const, error: '请求无效。' };
      const deleted = scenarioMaterials.deleteMaterial(parsedInput.data.id);
      return { ok: true as const, deleted };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('scenario:material:setCategory', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const parsedInput = z.object({ id: z.string().min(1).max(120), category: z.enum(['references', 'data', 'code', 'notes', 'template_spec', 'other']) }).safeParse(rawRequest);
      if (!parsedInput.success) return { ok: false as const, error: '请求无效。' };
      const updated = scenarioMaterials.setMaterialCategory(parsedInput.data.id, parsedInput.data.category);
      return updated ? { ok: true as const } : { ok: false as const, error: '材料不存在。' };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // ── 场景参考材料与 AI 场景生成（场景重构 P1）──
  const scenarioMaterials = new ScenarioMaterialService(DATA_DIR);
  ipcMain.handle('scenario:importMaterials', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!isRecord(rawRequest) || !Array.isArray(rawRequest.files)) return { ok: false, code: 'invalid_request' };
      const { getPdfReader } = await import('../engine/research/PdfReader.js');
      const reader = getPdfReader();
      const imported: Array<{ id: string; name: string; kind: string; storageRef: string; charCount: number; text: string }> = [];
      const errors: Array<{ name: string; error: string }> = [];
      for (const file of rawRequest.files.slice(0, 8)) {
        if (!isRecord(file) || typeof file.path !== 'string' || !file.path) continue;
        const name = typeof file.name === 'string' ? file.name : undefined;
        try {
          const material = await scenarioMaterials.importMaterial(file.path, {
            name,
            extractPdf: (filePath: string) => reader.extractText(filePath),
          });
          imported.push({ ...material, text: scenarioMaterials.loadMaterialText(material.id) ?? '' });
        } catch (err) {
          errors.push({ name: name ?? file.path.split('/').pop() ?? 'file', error: String((err as Error).message ?? err).slice(0, 120) });
        }
      }
      if (imported.length === 0) return { ok: false, code: 'import_failed', errors };
      return { ok: true, materials: imported, errors };
    } catch (err) {
      return { ok: false, code: 'import_failed', error: String((err as Error).message ?? err).slice(0, 200) };
    }
  });

  ipcMain.handle('scenario:analyzeMaterials', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!isRecord(rawRequest)) return { ok: false, code: 'invalid_request' };
      const prompt = typeof rawRequest.prompt === 'string' ? rawRequest.prompt.trim() : '';
      const materialIds = Array.isArray(rawRequest.materialIds)
        ? rawRequest.materialIds.filter((id): id is string => typeof id === 'string')
        : [];
      const importedMaterials = Array.isArray(rawRequest.importedMaterials)
        ? rawRequest.importedMaterials.filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.text === 'string')
        : [];
      if (!prompt && materialIds.length === 0 && importedMaterials.length === 0) return { ok: false, code: 'invalid_request' };
      if (!agentLoop) return { ok: false, code: 'agent_not_initialized' };
      const materials: Array<{ name: string; text: string }> = [];
      for (const id of materialIds.slice(0, 32)) {
        const text = scenarioMaterials.loadMaterialText(id);
        if (text) materials.push({ name: id, text });
      }
      for (const item of importedMaterials.slice(0, 8)) {
        materials.push({ name: typeof item.name === 'string' ? item.name : '材料', text: String(item.text).slice(0, 500_000) });
      }
      const catalogInput = Array.isArray(rawRequest.definitions)
        ? rawRequest.definitions.filter((item): item is Record<string, unknown> => isRecord(item))
        : [];
      const catalog = catalogInput
        .map((item) => {
          const kind = typeof item.kind === 'string' ? item.kind : '';
          const name = typeof item.name === 'string' ? item.name : '';
          const id = typeof item.id === 'string' ? item.id : '';
          return kind && name ? '- ' + kind + '「' + name + '」 id=' + id : '';
        })
        .filter(Boolean)
        .slice(0, 500)
        .join('\n');
      const prompts = scenarioMaterials.buildAnalysisPrompts(prompt, materials, catalog);
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `scenario:analyzeMaterials:${++requestCounter}`,
        rejection: { ok: false, code: 'application_shutting_down' },
      });
      if (!tracked.admitted) return tracked.rejection;
      try {
        const answer = await runEphemeralChatTurn({
          agentLoop,
          sessionId: 'ai-scenario-materials-' + Date.now().toString(36),
          messages: [{ role: 'user', content: prompts.user }],
          requestId: 'ai_scmat_' + ++requestCounter,
          skillPrompt: prompts.system,
          signal: tracked.signal,
        });
        if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
        if (answer.status !== 'completed' || !answer.answer.trim()) {
          const diag = answer.diagnostics?.[0];
          return { ok: false, code: 'generation_failed', message: [diag?.code, diag?.message].filter(Boolean).join(': ') || answer.status };
        }
        const result = scenarioMaterials.parseAnalysisResponse(answer.answer);
        if (!result) return { ok: false, code: 'parse_failed' };
        return { ok: true, result };
      } catch (error) {
        if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
        return { ok: false, code: 'generation_failed', error: String((error as Error).message ?? error).slice(0, 200) };
      } finally {
        tracked.cleanup();
      }
    } catch (err) {
      return { ok: false, code: 'generation_failed', error: String((err as Error).message ?? err).slice(0, 200) };
    }
  });

  // 项目工作台进度条数据源（2026-08-28 刘总要求：显示场景工作流的每个步骤
  // 与当前所处步骤，而不是静态的 Goal 判定百分比）。
  ipcMain.handle('scenario:runStateForProject', (event, rawProjectId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const projectId = typeof rawProjectId === 'string' ? rawProjectId : '';
      if (!projectId || !personalizationRepository) return { ok: false };
      const run = personalizationRepository.latestScenarioRunForProject(projectId);
      if (!run) return { ok: false };
      const nameById = new Map<string, string>(
        run.manifestSnapshot.workflow.map((step) => [step.id, step.name]),
      );
      const scenarioId = run.manifestSnapshot.scenarioId;
      // The run manifest is already authenticated and contains the immutable
      // workflow snapshot, so a newer quarantined definition must not erase a
      // real project's progress view. Prefer the live verified name when it is
      // available and otherwise retain the signed scenario identifier.
      const scenarioName = personalizationRepository.get(scenarioId)?.name ?? scenarioId;
      return {
        ok: true,
        runId: run.runId,
        scenarioId,
        scenarioName,
        status: run.status,
        steps: run.steps.map((step) => ({
          stepId: step.stepId,
          name: nameById.get(step.stepId) ?? step.stepId,
          status: step.status,
          // 步骤提示词随运行状态下发（2026-08-29 刘总要求：任务清单可展开查看）。
          prompt: run.manifestSnapshot.workflow.find((workflowStep) => workflowStep.id === step.stepId)?.prompt ?? undefined,
        })),
        // 看板编辑提示词需要按 stepId 定位（同一次下发，避免二次查询）。
        stepsPromptById: Object.fromEntries(
          run.manifestSnapshot.workflow.map((workflowStep) => [workflowStep.id, workflowStep.prompt ?? '']),
        ),
      };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('scenario:compileHarness', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!isRecord(rawRequest)) return { ok: false, code: 'invalid_request' };
      const current = ScenarioDefinitionSchema.safeParse(rawRequest.current);
      const instruction = typeof rawRequest.instruction === 'string' ? rawRequest.instruction.trim() : '';
      if (!current.success || instruction.length < 2 || instruction.length > 100_000) {
        return { ok: false, code: 'invalid_request' };
      }
      if (!agentLoop) return { ok: false, code: 'agent_not_initialized' };
      // 对话历史持久化目标（渲染端在发起时给定；缺省则本轮不落库）。
      const persistProjectId = typeof rawRequest.projectId === 'string' ? rawRequest.projectId : '';
      const persistScenarioId = typeof rawRequest.scenarioId === 'string' ? rawRequest.scenarioId : '';
      const persistConversationId = typeof rawRequest.conversationId === 'string' ? rawRequest.conversationId : '';
      // ── 对话上下文延续（2026-08-30 刘总要求：所有对话关闭后继续都要接得上）──
      // 场景配置助手此前每轮模型调用只带本轮指令，历史仅落库不回读——重开
      // 助手后「按我们刚才讨论的改」模型看不到任何讨论。把最近若干条历史
      // 拼进本轮指令前缀（草稿状态仍由 current 传递，不依赖聊天历史）。
      // 落库始终用原始指令，避免拼接版被重复存进历史。
      let effectiveInstruction = instruction;
      // 思考强度（2026-09-01 刘总要求）：助手选择器随请求传入；provider 暂无
      // 原生推理参数，以提示词级注入引导推理深度（如实生效于模型行为层）。
      const thinkingLevel = typeof rawRequest.thinkingLevel === 'string' && ['fast', 'standard', 'deep'].includes(rawRequest.thinkingLevel)
        ? rawRequest.thinkingLevel
        : '';
      if (thinkingLevel === 'deep') effectiveInstruction = `【思考强度：深度思考】请先充分展开多角度推理、权衡备选方案后再输出结果。

${effectiveInstruction}`;
      else if (thinkingLevel === 'fast') effectiveInstruction = `【思考强度：快速】请压缩推理过程，直接给出简洁结果。

${effectiveInstruction}`;
      if (persistProjectId && persistConversationId && outcomeRepository) {
        try {
          const history = outcomeRepository.listMessagesByConversation({ projectId: persistProjectId, conversationId: persistConversationId });
          const recent = history.slice(-12);
          if (recent.length > 0) {
            const transcript = recent
              .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${message.content.slice(0, 1_500)}`)
              .join('\n');
            effectiveInstruction = `【此前对话记录（供参考，最近 ${recent.length} 条）】\n${transcript}\n\n【本轮指令】\n${instruction}`;
          }
        } catch (historyError) {
          console.warn('[scenario:compileHarness] 对话历史拼接失败（不影响编译）:', historyError instanceof Error ? historyError.message : historyError);
        }
      }
      const definitions = personalizationRepository?.list(undefined, true) ?? [];
      const materialIds = Array.isArray(rawRequest.materialIds)
        ? rawRequest.materialIds.filter((id): id is string => typeof id === 'string').slice(0, 16)
        : [];
      const materialContext = materialIds.flatMap((id) => {
        const text = scenarioMaterials.loadMaterialText(id);
        return text ? [{ name: id, text }] : [];
      });
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `scenario:compileHarness:${++requestCounter}`,
        rejection: { ok: false, code: 'application_shutting_down' },
      });
      if (!tracked.admitted) return tracked.rejection;
      // 历史可找回（2026-08-25 刘总要求）：编译开始即落库用户指令——
      // 哪怕本轮失败或被中断，历史记录里也能看到这轮指令。
      const persistUserInstruction = () => {
        if (!persistProjectId || !persistScenarioId || !persistConversationId || !outcomeRepository) return;
        try {
          outcomeRepository.appendToConversation({ projectId: persistProjectId, conversationId: persistConversationId, role: 'user', content: instruction.slice(0, 40_000), sources: [] });
        } catch (persistError) {
          console.warn('[scenario:compileHarness] 用户指令落库失败（不影响编译）:', persistError instanceof Error ? persistError.message : persistError);
        }
      };
      const persistAssistantMessage = (content: string) => {
        if (!persistProjectId || !persistScenarioId || !persistConversationId || !outcomeRepository) return;
        try {
          outcomeRepository.appendToConversation({ projectId: persistProjectId, conversationId: persistConversationId, role: 'assistant', content: content.slice(0, 40_000), sources: [] });
        } catch (persistError) {
          console.warn('[scenario:compileHarness] 助手消息落库失败（不影响编译）:', persistError instanceof Error ? persistError.message : persistError);
        }
      };
      persistUserInstruction();
      // 过程可视化（2026-08-22 刘总要求）：把 AgentLoop 的实时执行事件
      // （生命周期/模型动作/工具调用）推送到渲染端，场景助手可显示思考与工具阶段。
      const compileSessionId = newCompileSessionId();
      // 增量构建（2026-08-22 刘总架构要求）：一个部分一个部分地填写，
      // 模型经 scenario_apply_update 工具分步修改草稿，每步即时校验。
      scenarioPatchRouterSingleton.open(compileSessionId, current.data);
      // 增量可见（2026-08-23 刘总要求）：每步 patch 成功后把草稿快照实时推送到
      // 渲染端，右侧编辑器随构建过程逐块成型，而不是结束后一次性填入。
      // 回调严格绑定到本次编译；并发会话不能相互替换或清理监听器。
      const draftUpdatedListener = (update: { sessionId: string; scenario: ScenarioDefinition; summaries: readonly string[] }) => {
        try {
          if (!event.sender.isDestroyed()) event.sender.send('scenario:draft-updated', update);
        } catch { /* 推送失败绝不中断编译 */ }
        checkpointCompileDraft();
      };
      scenarioPatchRouterSingleton.setDraftUpdatedListener(compileSessionId, draftUpdatedListener);
      // 过程检查点（2026-08-29 刘总要求：编译产物绝不许再整体丢失）：每累计
      // 8 个成功写入就把草稿落一次库。最终自动保存万一失败、甚至进程被杀，
      // 已生成内容最多丢最后 8 个写入，而不是像昨晚那样全部蒸发。
      let lastDraftCheckpointApplied = 0;
      const checkpointCompileDraft = () => {
        try {
          const repository = personalizationRepository;
          if (!repository) return;
          const session = scenarioPatchRouterSingleton.activeSession(compileSessionId);
          const draft = session?.getDraft();
          const applied = session?.appliedCount ?? 0;
          if (!draft || applied - lastDraftCheckpointApplied < 8) return;
          const persisted = repository.get(current.data.id, true);
          if (!persisted || persisted.provenance.origin === 'builtin') return;
          const saved = repository.save({
            contractVersion: 1,
            definition: {
              ...draft,
              revision: persisted.revision + 1,
              provenance: { ...draft.provenance, locallyModified: true, updatedAt: Date.now() },
            } as ScenarioDefinition,
            expectedRevision: persisted.revision,
          });
          if (saved.ok && saved.code === 'saved') {
            lastDraftCheckpointApplied = applied;
            console.warn(`[scenario:compileHarness] 过程检查点已落库：applied=${applied} rev=${saved.definition.revision}`);
          }
        } catch (checkpointError) {
          // 检查点是尽力而为：失败不阻断编译，最终保存仍是权威提交。
          console.warn('[scenario:compileHarness] 过程检查点失败（不阻断编译）：', checkpointError instanceof Error ? checkpointError.message : checkpointError);
        }
      };
      const executionBridge = new AgentExecutionEventBridge({
        sessionId: compileSessionId,
        turnId: `scenario_harness_${requestCounter + 1}`,
        publish: (payload) => {
          try {
            if (!event.sender.isDestroyed()) event.sender.send('scenario:compile-event', payload);
          } catch { /* 事件推送绝不中断编译本身 */ }
        },
      });
      executionBridge.attach(agentLoop);
      // token 级流式：把模型的增量输出/推理实时转发到渲染端。
      const scenarioStreamHookName = `scenario-stream-forward:${compileSessionId}`;
      const forwardScenarioStream = (ctx: import('../engine/core/HookBus.js').HookContext): import('../engine/core/HookBus.js').HookContext => {
        const payload = ctx as unknown as { sessionId?: unknown; content?: unknown; reasoning?: unknown; isFinished?: unknown };
        if (payload.sessionId !== compileSessionId) return ctx;
        try {
          if (!event.sender.isDestroyed()) {
            event.sender.send('scenario:stream-chunk', {
              sessionId: compileSessionId,
              content: typeof payload.content === 'string' ? payload.content : '',
              reasoning: typeof payload.reasoning === 'string' ? payload.reasoning : undefined,
              isFinished: payload.isFinished === true,
            });
          }
        } catch { /* 流转发绝不中断编译 */ }
        return ctx;
      };
      agentLoop.registerHook('model.stream_chunk', forwardScenarioStream, { name: scenarioStreamHookName });
      // 全自动安装追踪：通知按 compileSessionId 隔离，不能被并发编译覆盖。
      // 在 try 之前注册，确保任一早期失败都能由 finally 精确清理。
      const installedDefinitions: Array<{ id: string; name: string; kind: 'skill' | 'mcp'; url: string }> = [];
      const installationNotificationListener = (update: {
        sessionId: string;
        installedId: string;
        installedName: string;
        kind: 'skill' | 'mcp';
        url: string;
      }) => {
        installedDefinitions.push({ id: update.installedId, name: update.installedName, kind: update.kind, url: update.url });
        try {
          if (!event.sender.isDestroyed()) {
            event.sender.send('scenario:compile-event', {
              event: { type: 'lifecycle', phase: 'action', summary: `已自动安装${update.kind === 'skill' ? '技能' : 'MCP'}「${update.installedName}」，可绑定到工作流步骤。` },
            });
          }
        } catch { /* 推送失败不影响编译 */ }
      };
      scenarioAcquisition.install.notifications.set(compileSessionId, installationNotificationListener);
      try {
        // ── 阶段化编译循环（2026-08-23 刘总方案 v2）────────────────────────
        // 五个阶段依次执行；每阶段先检索后写入，阶段末跑确定性验收门，
        // 不达标就地返工（最多 2 次重试）。每次 patch 成功即时推送渲染端。
        const MAX_PHASE_RETRIES = 2;
        const MAX_AUDIT_REPAIRS = 2;
        const COMPILE_TOOLS = [
          SCENARIO_APPLY_UPDATE_TOOL_NAME, 'web_search', 'web_fetch',
          SCENARIO_MARKET_SEARCH_TOOL_NAME, SCENARIO_INSTALL_EXTENSION_TOOL_NAME,
        ];
        const patchSession = scenarioPatchRouterSingleton.activeSession(compileSessionId)!;
        const publishPhaseEvent = (phase: ScenarioPhase, summary: string) => {
          try {
            if (!event.sender.isDestroyed()) {
              event.sender.send('scenario:compile-event', { event: { type: 'lifecycle', phase: 'started', summary } });
            }
          } catch { /* 推送失败不影响编译 */ }
        };

        // 两段式阶段驱动（2026-08-24 刘总方案 C）：设计轮出大纲 → 主进程
        // 逐条驱动填写轮；每轮极小、写完立即上屏。无大纲工具的阶段保持
        // 单轮综合模式；门控失败走综合修复轮。
        const PHASE_PLAN_TOOL: Partial<Record<ScenarioPhase, string>> = {
          deliverable: SCENARIO_PLAN_SECTIONS_TOOL_NAME,
          workflow: SCENARIO_PLAN_WORKFLOW_TOOL_NAME,
        };
        const isLoopInterrupt = (answer: { status: string; diagnostics?: Array<{ code?: string; message?: string }> }) => {
          const diag = answer.diagnostics?.[0];
          return answer.status === 'interrupted' && `${diag?.code ?? ''}${diag?.message ?? ''}`.includes('loop');
        };

        for (let phaseIndex = 0; phaseIndex < SCENARIO_PHASE_ORDER.length; phaseIndex += 1) {
          const phase = SCENARIO_PHASE_ORDER[phaseIndex]!;
          const label = `${phaseIndex + 1}/${SCENARIO_PHASE_ORDER.length} ${SCENARIO_PHASE_LABELS[phase]}`;
          const prompts = buildScenarioPhasePrompt({
            phase,
            instruction: effectiveInstruction,
            current: current.data,
            definitions,
            materialContext,
          });
          const planTool = PHASE_PLAN_TOOL[phase];

          // ── 工作流阶段前置（2026-08-25 刘总要求）：先写工作流总 Prompt，
          // 再出大纲、逐步骤新增——总 Prompt 为后续步骤提供全局约束。
          if (phase === 'workflow') {
            const currentPromptText = (patchSession.getDraft() ?? normalizeScenarioHarness(current.data)).workflowPrompt?.trim() ?? '';
            if (currentPromptText.length === 0) {
              publishPhaseEvent(phase, `阶段 ${label}：正在撰写工作流总 Prompt…`);
              const wpPrompt = buildScenarioPhasePrompt({
                phase,
                instruction: effectiveInstruction,
                current: current.data,
                definitions,
                materialContext,
                fillTarget: { kind: 'workflow_prompt', id: 'workflowPrompt', name: '工作流总 Prompt' },
              });
              const appliedBeforeWp = patchSession.appliedCount;
              let wpAnswer = await runEphemeralChatTurn({
                agentLoop,
                sessionId: compileSessionId,
                messages: [{ role: 'user', content: wpPrompt.user }],
                requestId: `scenario_harness_${++requestCounter}`,
                skillPrompt: wpPrompt.system,
                allowedTools: [SCENARIO_APPLY_UPDATE_TOOL_NAME],
                maxTurns: 8,
                acceptUnverified: true,
                signal: tracked.signal,
              });
              if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
              if (wpAnswer.status !== 'completed') {
                console.warn(`[scenario:compileHarness] ${label} 总 Prompt 首写失败（${wpAnswer.status}），重试一次。`);
                wpAnswer = await runEphemeralChatTurn({
                  agentLoop,
                  sessionId: compileSessionId,
                  messages: [{ role: 'user', content: wpPrompt.user }],
                  requestId: `scenario_harness_${++requestCounter}`,
                  skillPrompt: wpPrompt.system,
                  allowedTools: [SCENARIO_APPLY_UPDATE_TOOL_NAME],
                  maxTurns: 8,
                  acceptUnverified: true,
                  signal: tracked.signal,
                });
                if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
              }
              console.warn(`[scenario:compileHarness] ${label} 总 Prompt 撰写 status=${wpAnswer.status} appliedPatches=${patchSession.appliedCount}（+${patchSession.appliedCount - appliedBeforeWp}）`);
              // 总 Prompt 失败不致命：阶段 4 的规则门会兜底要求补写。
            } else {
              console.warn(`[scenario:compileHarness] ${label} 工作流总 Prompt 已存在，跳过前置撰写。`);
            }
          }

          // ── 设计轮（仅首轮；只出大纲，骨架立即上屏）──
          let planTargets: Array<{ id: string; name: string; fillKind: 'step' | 'substep' | 'section'; contextLines: readonly string[] }> = [];
          if (planTool) {
            publishPhaseEvent(phase, `阶段 ${label}：正在设计${phase === 'workflow' ? '步骤' : '章节'}大纲…`);
            const planPrompt = buildScenarioPhasePrompt({
              phase,
              instruction: effectiveInstruction,
              current: current.data,
              definitions,
              materialContext,
              planMode: phase === 'workflow' ? 'workflow' : 'sections',
            });
            const planAnswer = await runEphemeralChatTurn({
              agentLoop,
              sessionId: compileSessionId,
              messages: [{ role: 'user', content: planPrompt.user }],
              requestId: `scenario_harness_${++requestCounter}`,
              skillPrompt: planPrompt.system,
              allowedTools: [planTool],
              maxTurns: 6,
              acceptUnverified: true,
              signal: tracked.signal,
            });
            if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
            if (phase === 'workflow') {
              // 工作流大纲已按 parent→subStep 顺序扁平化（含 kind），逐条驱动填写。
              planTargets = patchSession.getPlannedWorkflow().map((item) => ({
                id: item.id,
                name: item.name,
                fillKind: item.kind === 'substep' ? 'substep' as const : 'step' as const,
                contextLines: [],
              }));
            } else {
              // 交付物大纲（2026-09-04 升级）：递归登记的每一个节点（章节/小节/
              // 摘要/参考文献等）都成为独立填写目标，并携带父/相邻部分上下文。
              const plannedSections = patchSession.getPlannedSections();
              planTargets = plannedSections.map((item, index) => {
                const parent = item.depth > 0
                  ? [...plannedSections.slice(0, index)].reverse().find((candidate) => candidate.depth === item.depth - 1)?.title
                  : undefined;
                const prev = index > 0 ? plannedSections[index - 1]?.title : undefined;
                const next = plannedSections[index + 1]?.title;
                const contextLines = [
                  parent ? `上级部分：「${parent}」` : '',
                  prev ? `前一部分：「${prev}」` : '',
                  next ? `后一部分：「${next}」` : '',
                  `该部分类型：${item.kind}`,
                ].filter(Boolean);
                return { id: item.id, name: item.title, fillKind: 'section' as const, contextLines };
              });
            }
            console.warn(`[scenario:compileHarness] ${label} 设计轮 status=${planAnswer.status} 大纲数=${planTargets.length}`);
            // 设计轮失败不致命：无大纲则退回综合模式。
          }

          // ── 总体成文要求前置轮（2026-09-04 刘总要求 Phase 4）：骨架确定后、
          // 逐节点填写前，先写 deliverable.globalInstructions 作为全局约束。──
          if (phase === 'deliverable' && planTargets.length > 0) {
            const draftForGlobal = patchSession.getDraft() ?? normalizeScenarioHarness(current.data);
            if (!draftForGlobal.deliverable?.globalInstructions?.trim()) {
              publishPhaseEvent(phase, `阶段 ${label}：正在撰写总体成文要求…`);
              const giPrompt = buildScenarioPhasePrompt({
                phase,
                instruction: effectiveInstruction,
                current: current.data,
                definitions,
                materialContext,
                fillTarget: { kind: 'deliverable_global_instructions', id: 'globalInstructions', name: '总体成文要求（deliverable.globalInstructions）' },
              });
              const appliedBeforeGi = patchSession.appliedCount;
              let giAnswer = await runEphemeralChatTurn({
                agentLoop,
                sessionId: compileSessionId,
                messages: [{ role: 'user', content: giPrompt.user }],
                requestId: `scenario_harness_${++requestCounter}`,
                skillPrompt: giPrompt.system,
                allowedTools: [SCENARIO_APPLY_UPDATE_TOOL_NAME],
                maxTurns: 8,
                acceptUnverified: true,
                signal: tracked.signal,
              });
              if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
              if (giAnswer.status !== 'completed' && patchSession.appliedCount === appliedBeforeGi) {
                giAnswer = await runEphemeralChatTurn({
                  agentLoop,
                  sessionId: compileSessionId,
                  messages: [{ role: 'user', content: giPrompt.user }],
                  requestId: `scenario_harness_${++requestCounter}`,
                  skillPrompt: giPrompt.system,
                  allowedTools: [SCENARIO_APPLY_UPDATE_TOOL_NAME],
                  maxTurns: 8,
                  acceptUnverified: true,
                  signal: tracked.signal,
                });
                if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
              }
              console.warn(`[scenario:compileHarness] ${label} 总体成文要求 status=${giAnswer.status} appliedPatches=${patchSession.appliedCount}（+${patchSession.appliedCount - appliedBeforeGi}）`);
              // 失败不致命：交付物完整性门与最终自检会兜底要求补写。
            }
          }

          // ── 填写轮：逐条驱动，每轮只填一个步骤/子步骤/交付物节点 ──
          if (planTargets.length > 0) {
            for (const target of planTargets) {
              publishPhaseEvent(phase, `阶段 ${label}：正在填写「${target.name}」…`);
              const fillPrompt = buildScenarioPhasePrompt({
                phase,
                instruction: effectiveInstruction,
                current: current.data,
                definitions,
                materialContext,
                fillTarget: { kind: target.fillKind, id: target.id, name: target.name, contextLines: target.contextLines },
              });
              const appliedBeforeFill = patchSession.appliedCount;
              let fillAnswer = await runEphemeralChatTurn({
                agentLoop,
                sessionId: compileSessionId,
                messages: [{ role: 'user', content: fillPrompt.user }],
                requestId: `scenario_harness_${++requestCounter}`,
                skillPrompt: fillPrompt.system,
                allowedTools: [SCENARIO_APPLY_UPDATE_TOOL_NAME],
                maxTurns: 8,
                acceptUnverified: true,
                signal: tracked.signal,
              });
              if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
              // 兜底 B4：loop detected 中断但该目标已写入 → 放行继续。
              if (isLoopInterrupt(fillAnswer) && patchSession.appliedCount > appliedBeforeFill) {
                console.warn(`[scenario:compileHarness] ${label} 填写「${target.name}」触发循环中断但已有写入，放行继续。`);
                continue;
              }
              if (fillAnswer.status !== 'completed') {
                // 单目标失败重试一次；再失败则记录并继续（最终门控兜底）。
                console.warn(`[scenario:compileHarness] ${label} 填写「${target.name}」失败（${fillAnswer.status}），重试一次。`);
                fillAnswer = await runEphemeralChatTurn({
                  agentLoop,
                  sessionId: compileSessionId,
                  messages: [{ role: 'user', content: fillPrompt.user }],
                  requestId: `scenario_harness_${++requestCounter}`,
                  skillPrompt: fillPrompt.system,
                  allowedTools: [SCENARIO_APPLY_UPDATE_TOOL_NAME],
                  maxTurns: 8,
                  acceptUnverified: true,
                  signal: tracked.signal,
                });
                if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
                if (fillAnswer.status !== 'completed') {
                  console.warn(`[scenario:compileHarness] ${label} 填写「${target.name}」重试仍失败（${fillAnswer.status}），交由阶段门控兜底。`);
                }
              }
              console.warn(`[scenario:compileHarness] ${label} 填写「${target.name}」完成 appliedPatches=${patchSession.appliedCount}（+${patchSession.appliedCount - appliedBeforeFill}）`);
            }
          }

          // ── 能力获取轮（2026-08-28 刘总要求；2026-08-29 条件化提速）：
          // 填写轮只允许 apply_update，市场搜索/安装工具唯一入口是填写过门后
          // 被跳过的综合轮——这导致编译出的场景永远没有 Skill/MCP。但固定
          // 补一轮对"填写轮已绑定目录资源"的场景是纯浪费。现改为仅当草稿
          // 完全没有任何 Skill/MCP 绑定时才执行这一轮。
          if (phase === 'workflow') {
            const draftForCapability = patchSession.getDraft() ?? normalizeScenarioHarness(current.data);
            const hasAnyBinding = draftForCapability.skillIds.length > 0 || draftForCapability.mcpIds.length > 0
              || draftForCapability.workflow.some((step) => step.skillIds.length > 0 || step.mcpIds.length > 0);
            if (hasAnyBinding) {
              console.warn(`[scenario:compileHarness] ${label} 草稿已含 Skill/MCP 绑定，跳过能力获取轮。`);
            } else {
              publishPhaseEvent(phase, `阶段 ${label}：正在为各步骤检索并安装合适的 Skill/MCP…`);
              const capabilityPrompt = buildScenarioPhasePrompt({
                phase,
                instruction: effectiveInstruction,
                current: draftForCapability,
                definitions,
                materialContext,
                capabilityPass: true,
              });
              const capabilityAnswer = await runEphemeralChatTurn({
                agentLoop,
                sessionId: compileSessionId,
                messages: [{ role: 'user', content: capabilityPrompt.user }],
                requestId: `scenario_harness_${++requestCounter}`,
                skillPrompt: capabilityPrompt.system,
                allowedTools: COMPILE_TOOLS,
                maxTurns: 12,
                acceptUnverified: true,
                signal: tracked.signal,
              });
              if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
              console.warn(`[scenario:compileHarness] ${label} 能力获取轮 status=${capabilityAnswer.status} installed=${installedDefinitions.length}`);
            }
          }

          // ── 综合轮 + 门控重试（无大纲阶段的首选路径；有大纲阶段作为修复路径）──
          // 填写轮已使门控达标时直接进入下一阶段，不跑综合轮（省一轮）。
          if (planTargets.length > 0) {
            const gateAfterFills = checkPhaseGate(phase, patchSession.getDraft() ?? normalizeScenarioHarness(current.data));
            if (gateAfterFills.ok) {
              console.warn(`[scenario:compileHarness] ${label} 填写轮完成且门控达标，跳过综合轮。`);
              continue;
            }
            console.warn(`[scenario:compileHarness] ${label} 填写轮后门控未达标（${JSON.stringify(gateAfterFills.issues.slice(0, 4))}），进入综合修复轮。`);
          }
          let phaseMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [{ role: 'user', content: prompts.user }];
          for (let attempt = 0; attempt <= MAX_PHASE_RETRIES; attempt += 1) {
            publishPhaseEvent(phase, `阶段 ${label}：正在检索资料并写入…`);
            const appliedBefore = patchSession.appliedCount;
            const answer = await runEphemeralChatTurn({
              agentLoop,
              sessionId: compileSessionId,
              messages: phaseMessages,
              requestId: `scenario_harness_${++requestCounter}`,
              skillPrompt: prompts.system,
              allowedTools: COMPILE_TOOLS,
              maxTurns: phase === 'basics' || phase === 'output_plan' ? 6 : 10,
              acceptUnverified: true,
              signal: tracked.signal,
            });
            if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
            // 兜底 B4：loop 中断但本阶段内容已达标 → 放行。
            if (isLoopInterrupt(answer)) {
              const gateOnInterrupt = checkPhaseGate(phase, patchSession.getDraft() ?? normalizeScenarioHarness(current.data));
              if (gateOnInterrupt.ok) {
                console.warn(`[scenario:compileHarness] ${label} 综合轮循环中断但门控已达标，放行。`);
                break;
              }
            }
            if (answer.status !== 'completed') {
              const diag = answer.diagnostics?.[0];
              const failText = [diag?.code, diag?.message].filter(Boolean).join(': ') || answer.status;
              persistAssistantMessage(`场景编译未完成（${SCENARIO_PHASE_LABELS[phase]} 阶段执行中断）：${failText}`);
              return { ok: false, code: 'generation_failed', message: failText };
            }
            const wroteThisAttempt = patchSession.appliedCount > appliedBefore;
            const draftNow = patchSession.getDraft() ?? normalizeScenarioHarness(current.data);
            const gate = checkPhaseGate(phase, draftNow);
            // 门控语义（2026-08-24 刘总指出）：目标是“内容达标”而非“必须有写入”。
            if (!wroteThisAttempt && gate.ok) {
              console.warn(`[scenario:compileHarness] ${label} attempt=${attempt + 1} 无写入但现状已达标，视为通过。`);
              break;
            }
            // 诊断日志（2026-08-24）：真实记录每次尝试的写入计数、门控结果与模型回答头部。
            console.warn(`[scenario:compileHarness] ${label} attempt=${attempt + 1}/${MAX_PHASE_RETRIES + 1}`
              + ` appliedPatches=${patchSession.appliedCount}`
              + ` status=${answer.status}`
              + ` answerHead=${JSON.stringify(answer.answer.slice(0, 300))}`
              + ` gateIssues=${JSON.stringify(gate.issues.slice(0, 8))}`);
            if (gate.ok) break;
            if (attempt < MAX_PHASE_RETRIES) {
              phaseMessages = [
                { role: 'user', content: prompts.user },
                { role: 'assistant', content: answer.answer.slice(0, 40_000) },
                { role: 'user', content: [
                  `本阶段（${SCENARIO_PHASE_LABELS[phase]}）验收未通过，请先用 web_search/web_fetch 补足所需资料，再用 scenario_apply_update 精确修复以下问题：`,
                  ...gate.issues.slice(0, 24).map((issue, index) => (index + 1) + '. ' + issue.slice(0, 400)),
                ].join('\n') },
              ];
              continue;
            }
            persistAssistantMessage(`场景编译未完成（阶段验收未通过）：阶段 ${label} 在 ${MAX_PHASE_RETRIES + 1} 次尝试后仍未通过验收。${gate.issues.slice(0, 4).map((issue) => issue.slice(0, 120)).join(' ｜ ')}`);
            return {
              ok: false,
              code: 'phase_gate_failed',
              issues: gate.issues,
              message: `阶段 ${label} 在 ${MAX_PHASE_RETRIES + 1} 次尝试后仍未通过验收：${gate.issues.slice(0, 4).map((issue) => issue.slice(0, 120)).join(' ｜ ')}`,
            };
          }
        }
        // ── Final 自检审计（2026-08-23 刘总要求）：空缺扫描 + schema + 质量审计，
        // 缺陷合并回喂修复，最多 MAX_AUDIT_REPAIRS 轮。
        let compilation: { scenario: ScenarioDefinition; summary: string; diff: ReturnType<typeof diffScenarioHarness>; assessment: ReturnType<typeof assessScenarioHarness> } | null = null;
        for (let repair = 0; repair <= MAX_AUDIT_REPAIRS; repair += 1) {
          const draft = patchSession.getDraft();
          if (!draft) {
            persistAssistantMessage('场景编译未完成：编译器未产出任何场景草稿。');
            return { ok: false, code: 'generation_failed', message: '编译器未产出任何场景草稿。', issues: [] };
          }
          const finalGate = patchSession.validateFinal();
          const allGates = runAllPhaseGates(draft);
          const auditIssues = finalGate.ok ? formatAuditIssues(allGates, []) : formatAuditIssues(allGates, finalGate.issues);
          if (finalGate.ok && auditIssues.length === 0) {
            const normalizedDraft = normalizeScenarioHarness(finalGate.scenario);
            compilation = {
              scenario: normalizedDraft,
              summary: patchSession.getSummaries().at(-1) || '已按阶段完成场景构建并通过自检。',
              diff: diffScenarioHarness(normalizeScenarioHarness(current.data), normalizedDraft),
              assessment: assessScenarioHarness(normalizedDraft, definitions),
            };
            break;
          }
          if (repair < MAX_AUDIT_REPAIRS) {
            const auditPrompts = buildScenarioPhasePrompt({ phase: 'workflow', instruction: effectiveInstruction, current: current.data, definitions, materialContext });
            await runEphemeralChatTurn({
              agentLoop,
              sessionId: compileSessionId,
              messages: [{ role: 'user', content: [
                '最终自检发现以下缺陷，请逐项用 scenario_apply_update 修复（不要改动其他已合格内容）：',
                ...auditIssues.slice(0, 32).map((issue) => issue.slice(0, 400)),
                '全部修复后回复 {"summary":"..."}。',
              ].join('\n') }],
              requestId: `scenario_harness_${++requestCounter}`,
              skillPrompt: auditPrompts.system,
              allowedTools: [SCENARIO_APPLY_UPDATE_TOOL_NAME],
              maxTurns: 12,
              acceptUnverified: true,
              signal: tracked.signal,
            });
            continue;
          }
          // 兜底（2026-08-28 刘总要求：场景构建绝不让成果作废）：草稿在写入点
          // 已按 schema 净化，自检残留的只是质量提示——照常保存并把提示带给
          // 用户继续完善，而不是把整轮编译成果丢弃。
          const fallbackRaw = patchSession.getDraft();
          if (!fallbackRaw) {
            persistAssistantMessage('场景编译未完成：编译器未产出任何场景草稿。');
            return { ok: false, code: 'generation_failed', message: '编译器未产出任何场景草稿。', issues: [] };
          }
          // DELIVERABLE COMPLETENESS PASS（2026-09-04 刘总要求）：交付物完整性
          // blocking（purpose/instructions/requirements/lengthTarget/globalInstructions
          // 缺失或为占位文本）不允许伪装成"场景生成完成"。保留当前草稿（随结果
          // 返回为未保存草稿；过程检查点也已落库），返回明确失败状态与缺失清单。
          const deliverableGateResult = allGates.find((entry) => entry.phase === 'deliverable')?.result;
          if (deliverableGateResult && !deliverableGateResult.ok) {
            const incompleteDraft = normalizeScenarioHarness(fallbackRaw);
            const missingSummary = deliverableGateResult.issues.slice(0, 3).map((issueText) => issueText.slice(0, 120)).join(' ｜ ');
            const message = `场景编译未完成：交付物蓝图仍缺少必需的内容规范（${missingSummary}）。已完成部分已保留为未保存草稿，请重新发起构建继续补全，系统不会将缺失字段的场景标记为完成。`;
            console.warn(`[scenario:compileHarness] deliverable completeness failed after repairs: ${deliverableGateResult.issues.length} issue(s)`);
            persistAssistantMessage(message);
            return { ok: false, code: 'deliverable_incomplete', issues: deliverableGateResult.issues, message, scenario: incompleteDraft, installedDefinitions };
          }
          const fallbackDraft = normalizeScenarioHarness(fallbackRaw);
          compilation = {
            scenario: fallbackDraft,
            summary: '已按阶段完成场景构建并通过写入校验；自检提示（不阻塞使用）：' + auditIssues.slice(0, 3).map((issue) => issue.slice(0, 120)).join(' ｜ '),
            diff: diffScenarioHarness(normalizeScenarioHarness(current.data), fallbackDraft),
            assessment: assessScenarioHarness(fallbackDraft, definitions),
          };
          break;
        }
        if (!compilation) {
          persistAssistantMessage('场景编译未完成：编译未能产出合格场景。');
          return { ok: false, code: 'generation_failed', issues: [], message: '编译未能产出合格场景。' };
        }
        // 编译结果必须先通过主进程的原子版本提交，才可以报告为成功。渲染端
        // 草稿只用于展示与重试，不能成为跨重启持久化的替代品。
        const buildToSave = (base: ScenarioDefinition): ScenarioDefinition => ({
          ...compilation.scenario,
          revision: base.revision + 1,
          provenance: { ...compilation.scenario.provenance, locallyModified: true, updatedAt: Date.now() },
        } as ScenarioDefinition);
        let saveResult: ReturnType<PersonalizationRepository['save']> | undefined;
        try {
          saveResult = personalizationRepository?.save({
            contractVersion: 1,
            definition: buildToSave(current.data),
            expectedRevision: current.data.revision,
          });
        } catch (saveError) {
          console.warn('[scenario:compileHarness] 主进程自动保存异常：', saveError instanceof Error ? saveError.message : saveError);
        }
        // 新建即编译自愈（2026-08-29 刘总要求：创建后立即编译不允许“未能安全保存”）。
        // revision_conflict 通常意味着渲染端快照落后于持久化版本（创建保存刚落库，
        // 或本轮等待期间发生过一次保存）：以数据库当前修订为基准重试一次；写入的
        // 内容仍是本轮编译产物。若场景行尚不存在（创建保存未落库），直接创建 rev1。
        if (saveResult && !saveResult.ok && (saveResult.code === 'revision_conflict' || saveResult.code === 'not_found')) {
          const persisted = personalizationRepository?.get(compilation.scenario.id, true);
          if (persisted && persisted.provenance.origin !== 'builtin') {
            try {
              saveResult = personalizationRepository?.save({
                contractVersion: 1,
                definition: buildToSave({ ...current.data, revision: persisted.revision }),
                expectedRevision: persisted.revision,
              });
              console.warn(`[scenario:compileHarness] 保存冲突自愈重试：以持久化 rev${persisted.revision} 为基准 → ${saveResult?.ok ? '成功' : saveResult?.code}`);
            } catch (saveError) {
              console.warn('[scenario:compileHarness] 自愈重试异常：', saveError instanceof Error ? saveError.message : saveError);
            }
          } else if (!persisted) {
            try {
              saveResult = personalizationRepository?.save({
                contractVersion: 1,
                definition: { ...compilation.scenario, revision: 1, provenance: { ...compilation.scenario.provenance, locallyModified: true, updatedAt: Date.now() } } as ScenarioDefinition,
                expectedRevision: 0,
              });
              console.warn(`[scenario:compileHarness] 场景行缺失自愈：直接创建 → ${saveResult?.ok ? '成功' : saveResult?.code}`);
            } catch (saveError) {
              console.warn('[scenario:compileHarness] 创建自愈异常：', saveError instanceof Error ? saveError.message : saveError);
            }
          }
        }
        if (!saveResult?.ok || saveResult.code !== 'saved' || saveResult.definition.kind !== 'scenario') {
          const code = saveResult?.ok ? 'io_error' : (saveResult?.code ?? 'io_error');
          const detail = saveResult && !saveResult.ok && 'issues' in saveResult && Array.isArray(saveResult.issues)
            ? `；原因：${saveResult.issues.slice(0, 3).join('；')}`
            : '';
          const message = `场景内容已生成，但未能安全保存（${code}${detail}）。过程检查点已保留大部分内容，请重试保存补全。`;
          console.warn(`[scenario:compileHarness] 主进程自动保存未成功：${code}${detail}`);
          persistAssistantMessage(message);
          return { ok: false, code, message, scenario: compilation.scenario, installedDefinitions };
        }
        const finalScenario = saveResult.definition;
        console.warn(`[scenario:compileHarness] 主进程自动保存成功：${finalScenario.id} rev${finalScenario.revision}`);
        persistAssistantMessage((compilation.summary || '已更新场景草稿。') + '（已自动保存。）');
        return { ok: true, ...compilation, scenario: finalScenario, autosaved: true, installedDefinitions };
      } catch (error) {
        if (tracked.signal.aborted) {
          persistAssistantMessage('场景编译未完成：应用正在关闭，编译被中断。可重新发起构建。');
          return { ok: false, code: 'application_shutting_down' };
        }
        const errorMessage = String((error as Error).message ?? error).slice(0, 200);
        persistAssistantMessage('场景编译未完成：' + errorMessage);
        return { ok: false, code: 'generation_failed', error: errorMessage };
      } finally {
        agentLoop.unregisterHook('model.stream_chunk', scenarioStreamHookName);
        scenarioPatchRouterSingleton.removeDraftUpdatedListener(compileSessionId, draftUpdatedListener);
        scenarioPatchRouterSingleton.close(compileSessionId);
        if (scenarioAcquisition.install.notifications.get(compileSessionId) === installationNotificationListener) {
          scenarioAcquisition.install.notifications.delete(compileSessionId);
        }
        scenarioInstallRouterSingleton.clearSessionCounter(compileSessionId);
        executionBridge.dispose();
        tracked.cleanup();
      }
    } catch (error) {
      return { ok: false, code: 'generation_failed', error: String((error as Error).message ?? error).slice(0, 200) };
    }
  });

  ipcMain.handle('scenario:aiRefine', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!isRecord(rawRequest)) return { ok: false, code: 'invalid_request' };
      const targetKind = rawRequest.targetKind;
      if (targetKind !== 'section' && targetKind !== 'writingRules' && targetKind !== 'methodPolicy' && targetKind !== 'adaptivity') {
        return { ok: false, code: 'invalid_request' };
      }
      const instruction = typeof rawRequest.instruction === 'string' ? rawRequest.instruction : '';
      const currentValue = typeof rawRequest.currentValue === 'string' ? rawRequest.currentValue : '';
      if (instruction.trim().length < 2 || currentValue.length > 20_000) return { ok: false, code: 'invalid_request' };
      if (!agentLoop) return { ok: false, code: 'agent_not_initialized' };
      let materialsText = '';
      const materialIds = Array.isArray(rawRequest.materialIds)
        ? rawRequest.materialIds.filter((id): id is string => typeof id === 'string')
        : [];
      for (const id of materialIds.slice(0, 8)) {
        const text = scenarioMaterials.loadMaterialText(id);
        if (text) materialsText += '\n\n【' + id + '】\n' + text.slice(0, 20_000);
      }
      const prompts = scenarioMaterials.buildRefinePrompts({
        targetKind,
        targetTitle: typeof rawRequest.targetTitle === 'string' ? rawRequest.targetTitle : '',
        currentValue,
        instruction,
        materialsText: materialsText || undefined,
      });
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `scenario:aiRefine:${++requestCounter}`,
        rejection: { ok: false, code: 'application_shutting_down' },
      });
      if (!tracked.admitted) return tracked.rejection;
      try {
        const answer = await runEphemeralChatTurn({
          agentLoop,
          sessionId: 'ai-scenario-refine-' + Date.now().toString(36),
          messages: [{ role: 'user', content: prompts.user }],
          requestId: 'ai_scref_' + ++requestCounter,
          skillPrompt: prompts.system,
          signal: tracked.signal,
        });
        if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
        if (answer.status !== 'completed' || !answer.answer.trim()) {
          return { ok: false, code: 'generation_failed' };
        }
        const cleaned = answer.answer.trim().replace(/```(?:json)?/gu, '');
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start < 0 || end <= start) return { ok: false, code: 'parse_failed' };
        let patch: unknown;
        try {
          patch = JSON.parse(cleaned.slice(start, end + 1));
        } catch {
          return { ok: false, code: 'parse_failed' };
        }
        return { ok: true, patch };
      } catch (error) {
        if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
        return { ok: false, code: 'generation_failed', error: String((error as Error).message ?? error).slice(0, 200) };
      } finally {
        tracked.cleanup();
      }
    } catch (err) {
      return { ok: false, code: 'generation_failed', error: String((err as Error).message ?? err).slice(0, 200) };
    }
  });

  // ── 论文结构模板识别：粘贴模板（如国社科申请书）→ AI 解析为逐节写作指引 ──
  ipcMain.handle('personalization:parsePaperTemplate', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (!isRecord(rawRequest)) return { ok: false, code: 'invalid_request' };
      const text = typeof rawRequest.text === 'string' ? rawRequest.text.trim() : '';
      if (text.length < 10 || text.length > 20_000) {
        return { ok: false, code: 'invalid_request' };
      }
      if (!agentLoop) return { ok: false, code: 'agent_not_initialized' };
      const systemPrompt = [
        '你是论文结构模板解析助手。用户粘贴一份研究模板（如国家社科基金申请书、论文写作规范、学位论文结构），你需要把它解析为可编辑的章节结构。',
        '要求：',
        '1. 只输出一个 JSON 对象：{ "sections": [ { "title": "章节标题", "instruction": "该章节的写作指引：写什么内容、如何论证、文风要求（不超过250字）" } ] }。',
        '2. 章节按模板出现的顺序排列；模板中未明确列出的必要章节（如引言、结论）应补充进去。',
        '3. 章节数量 3-12 个；instruction 用中文，具体到该章节的写作任务与质量要求。',
        '4. 不要输出任何解释、前后缀或 Markdown 代码围栏。',
      ].join('\n');
      const tracked = trackEphemeralOperation(runtimeShutdown, {
        id: `personalization:parsePaperTemplate:${++requestCounter}`,
        rejection: { ok: false, code: 'application_shutting_down' },
      });
      if (!tracked.admitted) return tracked.rejection;
      try {
        const answer = await runEphemeralChatTurn({
          agentLoop,
          sessionId: `ai-template-${Date.now().toString(36)}`,
          messages: [{ role: 'user', content: `模板内容：\n${text}` }],
          requestId: `ai_tpl_${++requestCounter}`,
          skillPrompt: systemPrompt,
          signal: tracked.signal,
        });
        if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
        if (answer.status !== 'completed' || !answer.answer.trim()) {
          const diag = answer.diagnostics?.[0];
          return { ok: false, code: 'generation_failed', message: [diag?.code, diag?.message].filter(Boolean).join(': ') || answer.status };
        }
        const cleaned = answer.answer.replace(/```(?:json)?/gu, '').trim();
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start < 0 || end <= start) return { ok: false, code: 'parse_failed' };
        let parsed: unknown;
        try {
          parsed = JSON.parse(cleaned.slice(start, end + 1));
        } catch {
          return { ok: false, code: 'parse_failed' };
        }
        if (!isRecord(parsed) || !Array.isArray(parsed.sections)) return { ok: false, code: 'parse_failed' };
        const str = (value: unknown, maximum: number): string => (
          typeof value === 'string' ? value.trim().slice(0, maximum) : ''
        );
        const sections = parsed.sections
          .filter((item): item is Record<string, unknown> => isRecord(item))
          .map((item) => ({
            title: str(item.title, 80),
            instruction: str(item.instruction, 250) || str(item.style, 120),
          }))
          .filter((section) => section.title)
          .slice(0, 16);
        if (sections.length < 3) return { ok: false, code: 'parse_failed' };
        return { ok: true, sections };
      } catch (error) {
        if (tracked.signal.aborted) return { ok: false, code: 'application_shutting_down' };
        return { ok: false, code: 'generation_failed', message: String((error as Error).message ?? error).slice(0, 200) };
      } finally {
        tracked.cleanup();
      }
    } catch {
      return { ok: false, code: 'generation_failed' };
    }
  });

  ipcMain.handle('personalization:extension:apply', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const publicRequest = PersonalizationExtensionIpcRequestSchema.safeParse(rawRequest);
      if (!publicRequest.success || !personalizationExtensions) {
        return decodePersonalizationExtensionResponse(null);
      }
      const request = bindPersonalizationExtensionRequest(publicRequest.data, event);
      if (!request) return decodePersonalizationExtensionResponse(null);
      const owner = executionOwnerFor(event);
      if (request.mode === 'mcp_requirements' && request.runProbe) {
        if (!personalizationGeneratedMcpActivation) return decodePersonalizationExtensionResponse(null);
        const prepared = await personalizationExtensions.prepareGeneratedMcp(request);
        if (!prepared.ok) return decodePersonalizationExtensionResponse(prepared.response);
        const activated = await personalizationGeneratedMcpActivation.activate({
          operationId: request.evidenceContext.operationId,
          expectedRevision: request.expectedRevision,
          pendingDefinition: prepared.definition,
          installation: prepared.installation,
          evidenceContext: { ...request.evidenceContext, owner },
        });
        if (!activated.ok) {
          return decodePersonalizationExtensionResponse({
            ok: false,
            mode: 'mcp_requirements',
            code: 'mcp_builder_failed',
            detailCode: activated.code,
            compensated: activated.compensated,
          });
        }
        return decodePersonalizationExtensionResponse({
          ok: true,
          mode: 'mcp_requirements',
          definition: activated.definition,
          evidence: activated.evidence,
          skillInstallation: null,
          mcpInstallation: activated.installation,
        });
      }
      const result = await personalizationExtensions.apply(request, {
        resolveLocalSkillSource: (capabilityId) => {
          const resolution = fileCapabilities.consumeMatching(capabilityId, owner, [
            {
              purpose: 'personalization-skill-package',
              kind: 'file',
              operation: 'file',
            },
            {
              purpose: 'personalization-skill-directory',
              kind: 'folder',
              operation: 'folder',
            },
          ]);
          return resolution.ok ? resolution.resolvedPath : undefined;
        },
        resolveLocalMcpSource: (capabilityId) => {
          const resolution = fileCapabilities.consumeMatching(capabilityId, owner, [{
            purpose: 'personalization-mcp-directory',
            kind: 'folder',
            operation: 'folder',
          }]);
          return resolution.ok ? resolution.resolvedPath : undefined;
        },
      });
      return decodePersonalizationExtensionResponse(result);
    } catch {
      return decodePersonalizationExtensionResponse(null);
    }
  });

  ipcMain.handle('personalization:mcp:activate', async (event, rawRequest: unknown) => {
    const publicRequest = McpActivationIpcRequestSchema.safeParse(rawRequest);
    try {
      requireRendererMainFrame(event);
      if (!publicRequest.success || !personalizationMcpActivation) {
        return decodeMcpActivationResponse(null);
      }
      const request = bindMcpActivationRequest(publicRequest.data, event);
      if (!request) return decodeMcpActivationResponse(null);
      return decodeMcpActivationResponse(
        await personalizationMcpActivation.activate(request),
      );
    } catch {
      return decodeMcpActivationResponse(null);
    }
  });

  ipcMain.handle('personalization:bundle:export', async (event, rawRequest: unknown) => {
    const parsed = PersonalizationBundleExportIpcRequestSchema.safeParse(rawRequest);
    const operationId = parsed.success ? parsed.data.operationId : '00000000-0000-4000-8000-000000000000';
    try {
      const invokingWindow = requireRendererMainFrame(event);
      if (!parsed.success) return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'invalid_request' });
      if (!personalizationBundles || !personalizationRepository || !personalizationBundleSkillAssets) {
        return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'service_unavailable' });
      }
      const exported = await personalizationBundles.exportBundle({
        rootDefinitionIds: parsed.data.rootDefinitionIds,
        assetMode: 'include_files',
        createdBy: 'Local Metis user',
      }, { get: (id) => personalizationRepository?.get(id, true) }, personalizationBundleSkillAssets);
      const selected = await dialog.showSaveDialog(invokingWindow, {
        title: 'Export Metis personalization bundle',
        defaultPath: `metis-personalization-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'Metis personalization bundle', extensions: ['json'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (selected.canceled || !selected.filePath) {
        return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'cancelled' });
      }
      try { writePersonalizationBundleFile(selected.filePath, exported.bytes); } catch {
        return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'write_failed' });
      }
      return PersonalizationBundleIpcResponseSchema.parse({
        ok: true,
        operationId,
        action: 'exported',
        bundleDigest: exported.bundle.manifest.bundleDigest,
        definitionCount: exported.bundle.manifest.definitions.length,
      });
    } catch {
      return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'export_failed' });
    }
  });

  ipcMain.handle('personalization:bundle:import', async (event, rawRequest: unknown) => {
    const parsed = PersonalizationBundleImportIpcRequestSchema.safeParse(rawRequest);
    const operationId = parsed.success ? parsed.data.operationId : '00000000-0000-4000-8000-000000000000';
    try {
      const invokingWindow = requireRendererMainFrame(event);
      if (!parsed.success) return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'invalid_request' });
      if (!personalizationBundleCoordinator) {
        return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'service_unavailable' });
      }
      const selected = await dialog.showOpenDialog(invokingWindow, {
        title: 'Import Metis personalization bundle',
        properties: ['openFile'],
        filters: [{ name: 'Metis personalization bundle', extensions: ['json'] }],
      });
      const source = selected.canceled ? undefined : selected.filePaths[0];
      if (!source) return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'cancelled' });
      let bytes: Uint8Array;
      try { bytes = readPersonalizationBundleFile(source); } catch {
        return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'read_failed' });
      }
      const imported = await personalizationBundleCoordinator.importBundle(bytes);
      if (!imported.ok) return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'import_failed' });
      let definitionCount: number;
      try {
        definitionCount = PersonalizationBundleSchema.parse(
          JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown,
        ).manifest.definitions.length;
      } catch {
        return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'import_failed' });
      }
      return PersonalizationBundleIpcResponseSchema.parse({
        ok: true,
        operationId,
        action: 'imported',
        bundleDigest: imported.bundleDigest,
        definitionCount,
      });
    } catch {
      return PersonalizationBundleIpcResponseSchema.parse({ ok: false, operationId, code: 'import_failed' });
    }
  });

  ipcMain.handle('personalization:secrets:list', (event, rawRequest: unknown) => {
    const parsed = PersonalizationSecretListRequestSchema.safeParse(rawRequest);
    const operationId = parsed.success ? parsed.data.operationId : undefined;
    try {
      requireRendererMainFrame(event);
      if (!parsed.success) return decodePersonalizationSecretListResponse(null, operationId);
      if (!personalizationSecretVault) {
        return decodePersonalizationSecretListResponse({
          ok: false,
          contractVersion: 1,
          operationId: parsed.data.operationId,
          code: 'storage_unavailable',
        }, parsed.data.operationId);
      }
      return decodePersonalizationSecretListResponse(
        personalizationSecretVault.list(parsed.data),
        parsed.data.operationId,
      );
    } catch {
      return decodePersonalizationSecretListResponse(null, operationId);
    }
  });

  ipcMain.handle('personalization:secrets:set', async (event, rawRequest: unknown) => {
    const parsed = PersonalizationSecretSetRequestSchema.safeParse(rawRequest);
    const operationId = parsed.success ? parsed.data.operationId : undefined;
    try {
      requireRendererMainFrame(event);
      if (!parsed.success) return decodePersonalizationSecretSetResponse(null, operationId);
      if (!personalizationSecretVault) {
        return decodePersonalizationSecretSetResponse({
          ok: false,
          contractVersion: 1,
          operationId: parsed.data.operationId,
          code: 'storage_unavailable',
        }, parsed.data.operationId);
      }
      return decodePersonalizationSecretSetResponse(
        await personalizationSecretVault.set(parsed.data),
        parsed.data.operationId,
      );
    } catch {
      return decodePersonalizationSecretSetResponse(null, operationId);
    }
  });

  ipcMain.handle('personalization:secrets:remove', async (event, rawRequest: unknown) => {
    const parsed = PersonalizationSecretRemoveRequestSchema.safeParse(rawRequest);
    const operationId = parsed.success ? parsed.data.operationId : undefined;
    try {
      requireRendererMainFrame(event);
      if (!parsed.success) return decodePersonalizationSecretRemoveResponse(null, operationId);
      if (!personalizationSecretVault) {
        return decodePersonalizationSecretRemoveResponse({
          ok: false,
          contractVersion: 1,
          operationId: parsed.data.operationId,
          code: 'storage_unavailable',
        }, parsed.data.operationId);
      }
      return decodePersonalizationSecretRemoveResponse(
        await personalizationSecretVault.remove(parsed.data),
        parsed.data.operationId,
      );
    } catch {
      return decodePersonalizationSecretRemoveResponse(null, operationId);
    }
  });

  ipcMain.handle('mcp:list', (event) => {
    try {
      requireRendererMainFrame(event);
      return mcpManager?.getStatus().map(({ id, name, connected, toolCount }) => ({
        id,
        name,
        connected,
        toolCount,
      })) ?? [];
    } catch {
      return [];
    }
  });
  ipcMain.handle('mcp:add', async (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      // Fixed response below.
    }
    return { success: false, code: 'managed_mcp_required' };
  });
  ipcMain.handle('mcp:remove', async (event, rawId: unknown) => {
    try {
      requireRendererMainFrame(event);
      const id = RuntimeIdSchema.parse(rawId);
      if (!mcpManager) return { success: false };
      await mcpManager.removeServer(id);
      return { success: true };
    } catch {
      return { success: false };
    }
  });
  ipcMain.handle('mcp:toggle', async (event, rawId: unknown, rawEnabled: unknown) => {
    try {
      requireRendererMainFrame(event);
      const id = RuntimeIdSchema.parse(rawId);
      if (!mcpManager || typeof rawEnabled !== 'boolean') return { success: false };
      if (rawEnabled) return { success: false, code: 'execution_consent_required' };
      const status = await mcpManager.toggleServer(id, false);
      return { success: true, ...status };
    } catch {
      return { success: false };
    }
  });
  ipcMain.handle('mcp:test', async (event) => {
    try {
      requireRendererMainFrame(event);
    } catch {
      // Fixed response below.
    }
    return { success: false, code: 'managed_mcp_required' };
  });

  // ── HITL Approval ───────────────────────────────────────
  ipcMain.handle('hitl:approval:respond', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (runtimeShutdown.isDraining()) return createApprovalMutationFailure();
      const request = decodeApprovalResponseRequest(rawRequest);
      if (!request || !hitlApprovalRegistry.resolve(request.requestId, request.decision === 'approve')) {
        return createApprovalMutationFailure();
      }
      return decodeApprovalMutationResult({ success: true });
    } catch {
      return createApprovalMutationFailure();
    }
  });

  // Set up approval handler that sends requests to renderer via IPC. The
  // provider runtime may be initialized after setupIPC, so binding is repeated
  // at each runtime-store assignment above.
  if (approvalStore) bindHitlApprovalHandler(approvalStore);

  ipcMain.handle('hitl:rules:list', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!approvalStore) return [];
      return decodeApprovalRuleViews(approvalStore.getRules().map((rule) => ({
        id: rule.id,
        name: rule.name,
        description: rule.description,
        enabled: rule.enabled,
      })));
    } catch {
      return [];
    }
  });

  ipcMain.handle('hitl:rules:toggle', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = decodeApprovalRuleToggleRequest(rawRequest);
      if (!request || !approvalStore) return createApprovalMutationFailure();
      return approvalStore.setRuleEnabled(request.ruleId, request.enabled)
        ? decodeApprovalMutationResult({ success: true })
        : createApprovalMutationFailure();
    } catch {
      return createApprovalMutationFailure();
    }
  });

  ipcMain.handle('hitl:approvals:pending', (event) => {
    try {
      requireRendererMainFrame(event);
      if (!approvalStore) return [];
      return approvalStore.getPending().flatMap((request) => {
        const presented = ApprovalRequestViewSchema.safeParse({
          requestId: request.id,
          action: presentApprovalAction(request.toolName),
          createdAt: request.createdAt,
        });
        return presented.success ? [presented.data] : [];
      });
    } catch {
      return [];
    }
  });

  // Legacy dialog:selectScript removed (GLM-102). Script selection is now
  // handled entirely by experiment:attachScript through secure adapter path.

  // ── Terminal (node-pty) ────────────────────────────────
  ipcMain.handle('terminal:requestGrant', async (event) => {
    try {
      const window = requireRendererMainFrame(event);
      if (!executionCapabilities) return createTerminalFailure();
      const consent = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Open controlled terminal',
        message: 'The terminal can run commands in the Metis managed workspace.',
        detail: 'Only continue if you intend to use an interactive shell. The renderer cannot choose the executable, environment, or working directory.',
        buttons: ['Open terminal', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (consent.response !== 0) return createTerminalFailure();
      const executablePath = process.platform === 'win32'
        ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : '/bin/bash';
      const issued = executionCapabilities.issue({
        operation: 'terminal-session',
        lifetime: 'session',
        owner: executionOwnerFor(event),
        userConsentAt: Date.now(),
        executablePath,
        fixedArgs: process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : ['--noprofile', '--norc'],
        cwd: TERMINAL_WORKSPACE_DIR,
      });
      return issued.success
        ? decodeTerminalGrantResult({
            success: true,
            code: 'terminal_grant_issued',
            grant: issued.grant,
          })
        : createTerminalFailure();
    } catch {
      return createTerminalFailure();
    }
  });

  ipcMain.handle('terminal:create', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = TerminalCreateRequestSchema.safeParse(rawRequest);
      if (!request.success || !executionCapabilities) return createTerminalFailure();
      const owner = executionOwnerFor(event);
      const authorized = executionCapabilities.authorize({
        grantId: request.data.executionGrantId,
        operation: 'terminal-session',
        action: 'execute',
      }, owner);
      if (!authorized.ok || authorized.action !== 'execute') return createTerminalFailure();
      const terminalId = nextTerminalId();
      const terminal = pty.spawn(authorized.plan.executablePath, authorized.plan.args, {
        name: 'xterm-256color',
        cols: request.data.cols,
        rows: request.data.rows,
        cwd: authorized.plan.cwd,
        env: authorized.plan.env,
      });
      const session: ActiveTerminalSession = {
        terminal,
        grantId: authorized.grant.grantId,
        owner,
        sequence: 0,
        killed: false,
      };
      activeTerminals.set(terminalId, session);

      terminal.onData((rawData: string) => {
        const current = activeTerminals.get(terminalId);
        const window = mainWindow;
        if (!current || !window || window.isDestroyed() || window.webContents.id !== owner.webContentsId) return;
        const data = rawData.replaceAll('\u0000', '');
        for (let offset = 0; offset < data.length; offset += TERMINAL_RUNTIME_LIMITS.eventChars) {
          const eventPayload = TerminalDataEventSchema.safeParse({
            terminalId,
            sequence: current.sequence++,
            data: data.slice(offset, offset + TERMINAL_RUNTIME_LIMITS.eventChars),
          });
          if (eventPayload.success) window.webContents.send('terminal:data', eventPayload.data);
        }
      });

      terminal.onExit(({ exitCode }: { exitCode: number }) => {
        const current = activeTerminals.get(terminalId);
        activeTerminals.delete(terminalId);
        executionCapabilities?.revoke(authorized.grant.grantId);
        const window = mainWindow;
        if (!current || !window || window.isDestroyed() || window.webContents.id !== owner.webContentsId) return;
        const eventPayload = TerminalExitEventSchema.safeParse({
          terminalId,
          sequence: current.sequence++,
          exitCode,
          reason: current.killed ? 'killed' : 'exit',
        });
        if (eventPayload.success) window.webContents.send('terminal:exit', eventPayload.data);
      });

      return decodeTerminalCreateResult({
        success: true,
        code: 'terminal_session_created',
        terminalId,
        sessionAccessGrantId: authorized.grant.grantId,
      });
    } catch {
      return createTerminalFailure();
    }
  });

  ipcMain.handle('terminal:write', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = TerminalWriteRequestSchema.safeParse(rawRequest);
      if (!request.success || !executionCapabilities) return createTerminalFailure();
      const owner = executionOwnerFor(event);
      const session = activeTerminals.get(request.data.terminalId);
      const authorized = executionCapabilities.authorize({
        grantId: request.data.sessionAccessGrantId,
        operation: 'terminal-session',
        action: 'session-access',
      }, owner);
      if (!session || !authorized.ok || authorized.action !== 'session-access' || session.grantId !== request.data.sessionAccessGrantId) {
        return createTerminalFailure();
      }
      session.terminal.write(request.data.data);
      return decodeTerminalOperationResult({ success: true, code: 'terminal_operation_complete' });
    } catch {
      return createTerminalFailure();
    }
  });

  ipcMain.handle('terminal:resize', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = TerminalResizeRequestSchema.safeParse(rawRequest);
      if (!request.success || !executionCapabilities) return createTerminalFailure();
      const owner = executionOwnerFor(event);
      const session = activeTerminals.get(request.data.terminalId);
      const authorized = executionCapabilities.authorize({
        grantId: request.data.sessionAccessGrantId,
        operation: 'terminal-session',
        action: 'session-access',
      }, owner);
      if (!session || !authorized.ok || authorized.action !== 'session-access' || session.grantId !== request.data.sessionAccessGrantId) {
        return createTerminalFailure();
      }
      session.terminal.resize(request.data.cols, request.data.rows);
      return decodeTerminalOperationResult({ success: true, code: 'terminal_operation_complete' });
    } catch {
      return createTerminalFailure();
    }
  });

  ipcMain.handle('terminal:kill', (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      const request = TerminalKillRequestSchema.safeParse(rawRequest);
      if (!request.success || !executionCapabilities) return createTerminalFailure();
      const owner = executionOwnerFor(event);
      const session = activeTerminals.get(request.data.terminalId);
      const authorized = executionCapabilities.authorize({
        grantId: request.data.sessionAccessGrantId,
        operation: 'terminal-session',
        action: 'session-access',
      }, owner);
      if (!session || !authorized.ok || authorized.action !== 'session-access' || session.grantId !== request.data.sessionAccessGrantId) {
        return createTerminalFailure();
      }
      session.killed = true;
      session.terminal.kill();
      return decodeTerminalOperationResult({ success: true, code: 'terminal_operation_complete' });
    } catch {
      return createTerminalFailure();
    }
  });
}

// ─── App Lifecycle ────────────────────────────────────────────


function parseBrowserBounds(raw: unknown): BrowserBounds | null {
  const r = raw as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
  if (!r) return null;
  const x = Number(r.x);
  const y = Number(r.y);
  const width = Number(r.width);
  const height = Number(r.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n)) || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

// Enforce a single application instance per userData directory. Without this,
// launching the app again opens a second instance that contends for the same
// disk cache (producing "Unable to move the cache: access denied") and the
// same SQLite database (risking concurrent-write corruption). The second
// instance exits immediately; the first instance window is restored/focused.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.show();
  }
});

/**
 * Journal-directory tools (LetPub / Wanwei Shukan) fetch through Chromium's
 * network stack so they follow proxy rules; some catalog sites are only
 * reachable via the user's local proxy. Direct net.fetch first, then retry
 * once through an env-proxy-pinned session when the primary attempt fails.
 */
function setupJournalCatalogFetcher(): void {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
  let proxiedCatalogSession: Electron.Session | null = null;
  configureJournalCatalogFetcher(async (url, init) => {
    try {
      return await net.fetch(url, init ?? {});
    } catch (primaryError) {
      if (!proxyUrl) throw primaryError;
      proxiedCatalogSession ??= electronSession.fromPartition('journal-catalog-proxy');
      await proxiedCatalogSession.setProxy({
        mode: 'fixed_servers',
        proxyRules: proxyUrl.replace(/^https?:\/\//u, ''),
      });
      return proxiedCatalogSession.fetch(url, init ?? {});
    }
  });
}


/**
 * 任务1（P0/P6）：数据库迁移 / 完整性启动失败的唯一受控出口。
 * 写诊断文件、给出用户可读的受控恢复对话框（不打 SQL 堆栈），然后退出——
 * 绝不带着不可信的数据库继续启动。若失败发生在一次 restore 之后（存在
 * restore intent），先提供「回滚到恢复前备份」。
 */
async function handlePersistenceStartupFailure(error: PersistenceStartupError, dbPath: string, dataDir: string): Promise<void> {
  const diagnostics = {
    at: new Date().toISOString(),
    code: error.detail.code,
    failedVersion: error.detail.failedVersion ?? null,
    userMessage: error.userMessage,
    message: error.message,
    stack: error.stack ?? '',
    report: error.detail.report ?? null,
    dbPath,
    dataDir,
  };
  let diagnosticsPath = '';
  try {
    const logsDir = path.join(dataDir, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    diagnosticsPath = path.join(logsDir, `db-startup-failure-${Date.now()}.json`);
    fs.writeFileSync(diagnosticsPath, JSON.stringify(diagnostics, null, 2), 'utf8');
  } catch { /* 诊断文件写不进去不阻塞对话框 */ }

  // Restore 之后的启动失败：优先提供回滚到恢复前快照。
  const intent = readRestoreIntent(dbPath);
  if (intent) {
    const rollbackChoice = await dialog.showMessageBox({
      type: 'error',
      title: 'METIS',
      buttons: ['回滚到恢复前备份', '退出'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      message: '数据库完整性检查失败（刚完成的恢复未通过校验），原数据未被继续修改。',
      detail: `${error.userMessage}\n\n选择「回滚到恢复前备份」将恢复本次还原之前的状态并重启应用。`,
    });
    if (rollbackChoice.response === 0) {
      const rolled = BackupService.rollbackFromIntent(intent);
      if (rolled.ok) {
        app.relaunch();
        app.exit(0);
        return;
      }
    } else {
      app.exit(1);
      return;
    }
  }

  const choice = await dialog.showMessageBox({
    type: 'error',
    title: 'METIS',
    buttons: ['打开备份目录', '复制诊断信息', '退出'],
    defaultId: 2,
    cancelId: 2,
    noLink: true,
    message: error.userMessage,
    detail: diagnosticsPath ? `诊断信息已写入：${diagnosticsPath}` : error.message,
  });
  if (choice.response === 0) {
    void shell.openPath(path.join(dataDir, 'backups'));
  } else if (choice.response === 1) {
    clipboard.writeText(JSON.stringify(diagnostics, null, 2));
  }
  app.exit(1);
}


app.whenReady().then(async () => {
  // 任务3：数据目录日志归档绑定（替代旧 initMainLogFile 的 stream 初始化）。
  archiveDataDir = DATA_DIR;
  mainProcessLogger.rebindArchiveTarget();
  if (!gotSingleInstanceLock) return;
  setupJournalCatalogFetcher();

  // Serve the production renderer bundle over metis-app:// (ESM modules cannot
  // load from file:// under Chromium's null-origin CORS rules). Every request
  // is confined to the dist/ directory.
  const distRoot = path.join(__dirname, '../../dist');
  // Module scripts require an exact JavaScript MIME type — net.fetch over
  // file:// does not guarantee one, so responses are built explicitly.
  const webMimeTypes: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon',
  };
  protocol.handle('metis-app', (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const resolved = path.resolve(distRoot, `.${pathname}`);
    if (!resolved.startsWith(distRoot + path.sep) && resolved !== distRoot) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return new Response('Not found', { status: 404 });
    }
    const mime = webMimeTypes[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream';
    return new Response(fs.readFileSync(resolved), { headers: { 'Content-Type': mime } });
  });

  // Ensure data directory
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(TERMINAL_WORKSPACE_DIR, { recursive: true });
  // Task 5 crash marker: a stale marker means the previous run did not exit
  // cleanly. Record it for the health report, then mark this boot.
  try {
    const staleMarker = readCrashMarkerState(DATA_DIR, true);
    previousRunUnclean = staleMarker.previousRunUnclean;
    previousCrashMarker = staleMarker.marker;
  } catch { /* marker handling never blocks startup */ }
  writeCrashMarker(DATA_DIR, {
    bootId: `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  // P0-8 startup reconciliation: rows still 'running' belong to a dead
  // process (single-instance lock guarantees no concurrent writer). Retire
  // them NOW — before any renderer can query run state — so no UI ever shows
  // a zombie "running" task after a crash. The count feeds the health report.
  reconciledOrphanRuns = null;
  try {
    const recoveredAt = Date.now();
    const storeProbe = new PersistenceStore(DB_PATH);
    reconciledOrphanRuns = storeProbe.reconcileOrphanRunningRuns(recoveredAt);
    storeProbe.close();
    if (reconciledOrphanRuns > 0) {
      console.warn(`[Main] reconciled ${reconciledOrphanRuns} orphan running run(s) from a previous session`);
    }
  } catch (error) {
    console.warn('[Main] orphan-run reconciliation skipped:', (error as Error)?.message);
    reconciledOrphanRuns = null;
  }
  executionCapabilities = new ExecutionCapabilityRegistry({
    allowedCwdRoots: [DATA_DIR],
    allowedEnvironmentKeys: ['ELECTRON_RUN_AS_NODE'],
  });

  // Initialize secure storage with Electron's safeStorage (must be after app.whenReady).
  // Provider profiles never use the generic in-memory fallback: the store below
  // accepts only the explicitly OS-protected adapter.
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    initSecureStorage(safeStorage);
  } else {
    console.warn('[Main] Electron safeStorage not available — provider profiles remain unavailable.');
  }
  providerProfileStorage = createFirstRunSecureStorage(safeStorage);
  try {
    providerProfileStore = new ProviderProfileStore(DATA_DIR, providerProfileStorage);
  } catch {
    providerProfileStore = null;
    providerProfileStorage = null;
  }
  // Background auto-update, channel-aware. Alpha builds may download and
  // (user-)install unsigned artifacts with the unsigned state disclosed;
  // stable builds verify the Authenticode signature of the downloaded
  // artifact and refuse to install unsigned updates (fail-safe). Non-fatal:
  // failures only emit an error event and never block startup.
  try {
    autoUpdaterService = new AutoUpdaterService({
      channel: resolveUpdateChannel({
        isPackaged: app.isPackaged,
        appVersion: app.getVersion(),
        envOverride: process.env.METIS_UPDATE_CHANNEL ?? null,
      }),
      verifySignature: (updateFilePath) => verifyAuthenticodeSignature(updateFilePath),
    });
    autoUpdaterService.on('event', (event: { type: string; version?: string; percent?: number; message?: string }) => {
      lastUpdateEvent = event;
    });
    autoUpdaterService.init();
  } catch {
    autoUpdaterService = null;
  }
  const citationTruthSecret = loadOrCreateCitationTruthSecret(DATA_DIR, safeStorage);
  citationTruthReceipts = citationTruthSecret
    ? new CitationTruthReceiptService(citationTruthSecret)
    : null;
  evidenceEnvelopes = citationTruthSecret
    ? new EvidenceEnvelopeService(citationTruthSecret)
    : null;
  try {
    personalizationSecretVault = new PersonalizationSecretVault(DATA_DIR, safeStorage);
  } catch (error) {
    personalizationSecretVault = null;
    console.warn('[Main] Personalization secret vault unavailable:', (error as Error)?.message);
  }

  // Load or create Current Affairs receipt signing secret
  caReceiptSecret = loadOrCreateCurrentAffairsReceiptSecret(DATA_DIR, safeStorage);

  // Initialize CA Runtime Service (DI wiring)
  // Validate + create artifact root under trusted DATA_DIR (fail-closed, no recursive traversal)
  const caArtifactRoot = path.join(DATA_DIR, 'ca-artifacts');
  if (!fs.existsSync(DATA_DIR)) throw new Error('[Main] DATA_DIR missing — cannot create CA artifact root');
  const dataDirStat = fs.lstatSync(DATA_DIR);
  if (dataDirStat.isSymbolicLink()) throw new Error('[Main] DATA_DIR is a symlink — rejecting');
  if (!fs.existsSync(caArtifactRoot)) {
    fs.mkdirSync(caArtifactRoot); // non-recursive: parent must exist
  }
  const artifactRootStat = fs.lstatSync(caArtifactRoot);
  if (artifactRootStat.isSymbolicLink()) throw new Error('[Main] CA artifact root is a symlink — rejecting');
  if (!artifactRootStat.isDirectory()) throw new Error('[Main] CA artifact root is not a directory — rejecting');

  const sharedGetSource = (id: string) => { try { const repo = researchRepository; if (!repo) return undefined; const src = repo.getSource(id); const adapted = src ? adaptSource(src) : undefined; return adapted ?? undefined; } catch { return undefined; } };
  const caApprovalStore = new CurrentAffairsApprovalStore({ now: () => Date.now(), signingSecret: caReceiptSecret ?? undefined });
  const caArtifactService = new CurrentAffairsArtifactService(caArtifactRoot);
  const caSessionState = new CurrentAffairsSessionState({ now: () => Date.now() });
  const caRepoService = new CurrentAffairsRepositoryService({
    getSource: sharedGetSource,
    now: () => Date.now(),
  });
  const { CurrentAffairsRuntimeService } = await import('./CurrentAffairsRuntimeService.js');
  caRuntime = new CurrentAffairsRuntimeService({
    repository: caRepoService, approvalStore: caApprovalStore, artifactService: caArtifactService,
    sessionState: caSessionState, receiptSecret: caReceiptSecret,
    now: () => Date.now(),
    getSource: sharedGetSource,
    confirmApproval: async (ctx) => {
      const win = caOwnerWindows.get(ctx.ownerSessionId);
      if (!win || win.isDestroyed()) { caOwnerWindows.delete(ctx.ownerSessionId); return false; }
      // Full Access removes per-action permission prompts. This callback still
      // fail-closes on owner/window loss; the runtime performs repository and
      // digest re-verification both before and after this automatic checkpoint,
      // then issues the same signed, replay-protected receipt as before.
      return true;
    },
  });
  if (!citationTruthReceipts) {
    console.warn('[Main] Citation truth key unavailable; verified deliverables and formal export are disabled.');
  }
  if (!evidenceEnvelopes) {
    console.warn('[Main] Evidence-envelope signer unavailable; third-party Skill and MCP results are disabled.');
  }

  // Initialize persistence — graceful degradation ONLY for environment failures
  // (e.g. the native module ABI). Migration/integrity failures carry the typed
  // PersistenceStartupError and fail closed with a controlled recovery dialog;
  // the app never keeps running on an untrusted database (task 1 §六).
  try {
    // T33 + 任务1（§八）：云端暂存的恢复在 store 创建【之前】替换 DB 文件——
    // 此时尚无任何 service 持有 store 引用，不存在热重绑 stale handle；
    // 替换后的库直接进入 PersistenceStore 启动管线（baseline → migrations →
    // health checks），损坏的云端备份会触发受控恢复对话框。
    const stagedRestore = cloudSync.applyStagedRestoreIfNeeded();
    if (stagedRestore.applied && stagedRestore.rollbackPath) {
      // 有回滚快照才写 intent；全新安装（无既有库可回滚）无需记录。
      writeRestoreIntent(DB_PATH, {
        backupPath: 'cloud-staged-restore',
        rollbackPath: stagedRestore.rollbackPath,
        dbPath: DB_PATH,
        requestedAt: Date.now(),
      });
      console.log('[Main] cloud staged restore applied before store init; intent recorded.');
    } else if (stagedRestore.applied) {
      console.log('[Main] cloud staged restore applied on fresh install (no rollback snapshot needed).');
    }
    // 任务1（P6）：存在 restore intent 即代表本次启动是恢复后的首次启动；
    // 数据库通过启动健康检查则提交（清除 intent），否则在失败分支提供回滚。
    const pendingRestoreIntent = readRestoreIntent(DB_PATH);
    try {
      store = new PersistenceStore(DB_PATH);
    } catch (error) {
      if (error instanceof PersistenceStartupError) {
        await handlePersistenceStartupFailure(error, DB_PATH, DATA_DIR);
        return; // app.exit 已在对话框动作后调度
      }
      throw error;
    }
    if (pendingRestoreIntent) {
      clearRestoreIntent(DB_PATH);
      console.log('[Main] restored database passed startup health checks; restore intent cleared.');
    }
    setSharedStore(store);
    outcomeTemplateService = new OutcomeTemplateService(store);
    jobQueueService.attachStore(store);
    literatureWatch.attachStore(store);
    literatureWatch.start();
    // Rolling automatic backups: snapshot on startup, then every 6 hours.
    // Failures are non-fatal and only logged — backups must never block the app.
    try {
      backupService = new BackupService(store, path.join(DATA_DIR, 'backups'), DB_PATH);
      void backupService.runBackup().catch(() => { /* best-effort */ });
      backupTimer = setInterval(() => {
        void backupService?.runBackup().catch(() => { /* best-effort */ });
      }, 6 * 60 * 60 * 1000);
    } catch {
      backupService = null;
    }
    // 任务1（P6）：backup:list / backup:restore 由任务3的域 registrar
    // （electron/ipc/registerSystemIpc.ts）注册；restoreFrom 现在是受控
    // 重启语义（校验 → 回滚快照 → intent → 原子替换 → 完整重启 → 启动
    // 健康检查 → 清 intent），绝不热重绑 store。
    // Persistent RAG index: load previously persisted documents so the
    // in-memory TF-IDF index survives restarts, then index the current library.
    try {
      void (async () => {
        const { getRagEngine } = await import('../engine/research/RagEngine.js');
        const engine = getRagEngine();
        const ragPath = path.join(DATA_DIR, 'manifest', 'rag-index.json');
        try {
          const persisted = fs.existsSync(ragPath) ? fs.readFileSync(ragPath, 'utf8') : '';
          if (persisted) engine.loadSerializedDocuments(persisted);
        } catch {
          // Corrupt or missing index is non-fatal; rebuild from the library.
        }
        const papers = (store?.getPapers() ?? []) as Parameters<typeof engine.indexPapersWithFullText>[0];
        if (papers.length > 0) engine.indexPapersWithFullText(papers);
        try {
          fs.mkdirSync(path.dirname(ragPath), { recursive: true });
          fs.writeFileSync(ragPath, engine.serializeDocuments(), 'utf8');
        } catch {
          // Persistence is best-effort; the in-memory index still works.
        }
      })();
    } catch {
      // RAG init must never block startup.
    }
    try {
      fundingTemplateRepository = new FundingTemplateRepository(DATA_DIR);
      fundingTemplateService = new FundingTemplateService(fundingTemplateRepository);
      const candidateFundingTemplateTools = new FundingTemplateToolService(fundingTemplateRepository, {
        resolveScope: (context) => {
          const scope = activeFundingToolScopes.get(context.sessionId);
          return scope ? { ownerId: scope.ownerId, projectId: scope.projectId } : null;
        },
      });
      const auditedToolIds = auditFundingTemplateToolRegistration(candidateFundingTemplateTools);
      if (!isFundingTemplateBuiltinDraftReady(auditedToolIds)) {
        throw new Error('Funding template ToolRegistry audit did not register both required tools');
      }
      fundingTemplateTools = candidateFundingTemplateTools;
    } catch (error) {
      fundingTemplateRepository = null;
      fundingTemplateService = null;
      fundingTemplateTools = null;
      console.warn('[Main] Funding template services unavailable:', (error as Error)?.message);
    }
    personalizationRepository = new PersonalizationRepository(store.raw, citationTruthSecret ?? undefined);
    // 内置个人化定义播种（2026-09-01）：基金申报书模板分析等 builtin skill/agent/场景
    // 首次真正进入生产目录。seedBuiltins 幂等（digest 未变跳过），funding-template
    // 草稿仅在三个只读工具全部通过注册审计后才会以 enabled 状态落库。
    try {
      // find-skills 元技能（刘总 2026-09 要求预装）：无工具依赖，始终播种。
      const seeded = [
        ...buildFundingTemplateSeed(new Set(builtinToolNames())),
        ...buildFindSkillsSeed(),
      ];
      personalizationRepository.seedBuiltins(seeded);
      if (seeded.length > 0) console.log(`[Main] seeded ${seeded.length} builtin personalization definition(s)`);
    } catch (seedError) {
      console.warn('[Main] builtin personalization seeding failed:', seedError instanceof Error ? seedError.message : seedError);
    }
    // digest 算法升级的一次性重签（2026-08-30 刘总报告「继续后从头重跑」）：
    // 旧算法把每次 resolve 的 createdAt 时间戳算进 manifestDigest，历史
    // checkpoint 的 digest 与新 resolve 永远不相等、resume 永远退化为
    // start。启动时幂等重签非终态记录，让刘总的既有进度能被「继续」接上。
    try {
      const reminted = personalizationRepository.remintScenarioRunManifestDigests();
      if (reminted > 0) console.log(`[Main] reminted ${reminted} scenario run manifest digest(s) for the createdAt-free digest algorithm`);
    } catch (remintError) {
      console.warn('[Main] scenario run digest remint failed:', remintError instanceof Error ? remintError.message : remintError);
    }
    personalizationRuntime = new PersonalizationRuntimeService(
      personalizationRepository,
      citationTruthSecret ?? undefined,
      {
        // Expired trash entries leave no orphaned installed assets behind.
        onPurgeExpired: (definitions) => definitions.forEach(uninstallSkillAssetsForDefinition),
      },
    );
    // ── 场景循环调度器（场景重构 P4）：周期性执行启用的场景 Loop ──
    // runner/persist 抽出为共用函数：后台调度到期与用户「立即运行」走同一条真实链路。
    const scenarioLoopHookApproval = async (input: {
      hookId: string;
      stepId: string;
      instruction: string;
      runId: string;
    }): Promise<boolean> => {
      try {
        const approvalWindow = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
        if (!approvalWindow) return false;
        const requestId = `scenario-loop-approval-${Date.now().toString(36)}-${++scenarioApprovalSequence}`;
        return await scenarioApprovalRegistry.request(requestId, {
          timeoutMs: 120_000,
          present: (resolve) => {
            void dialog.showMessageBox(approvalWindow, {
              type: 'question',
              buttons: ['批准执行', '拒绝'],
              defaultId: 1,
              cancelId: 1,
              title: '场景循环步骤审批',
              message: `步骤「${input.stepId}」请求执行审批`,
              detail: input.instruction || '该循环场景配置了审批钩子（approval hook）。',
              noLink: true,
            }).then(({ response: choice }) => resolve(choice === 0)).catch(() => resolve(false));
          },
        });
      } catch {
        return false;
      }
    };
    const runScenarioLoopOnce = async (due: {
      scenarioId: string;
      loop: import('../engine/runtime/PersonalizationRuntimeContract.js').ScenarioLoop;
    }, signal?: AbortSignal): Promise<{ ok: boolean; code?: string; status?: string }> => {
      if (runtimeShutdown.isDraining()) return { ok: false, code: 'application_shutting_down' };
      if (!agentLoop || !store) return { ok: false, code: 'agent_not_initialized' };
      const sessionId = `scenario-loop-${due.loop.id}`.replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 120);
      const resolved = personalizationRuntime?.resolve({
        contractVersion: 1,
        sessionId,
        projectId: 'scenario-loops',
        scenarioId: due.scenarioId,
      });
      const manifest = resolved && resolved.ok ? resolved.manifest : null;
      if (!manifest || manifest.workflow.length === 0) {
        console.warn(`[ScenarioLoop] scenario ${due.scenarioId} has no executable workflow; loop ${due.loop.id} skipped`);
        return { ok: false, code: 'no_executable_workflow' };
      }
      try {
        const response = await runPersistedScenarioWorkflow({
          agentLoop,
          store,
          repository: personalizationRepository!,
          sessionId: manifest.sessionId,
          messages: [{ role: 'user', content: due.loop.instruction || `执行场景循环「${due.loop.name}」` }],
          requestId: `scenario-loop-${Date.now().toString(36)}`,
          manifest,
          mode: 'send',
          signal,
          projectId: manifest.projectId,
          researchRepository: researchRepository ?? undefined,
          literatureBridge: getScenarioLiteratureBridge(),
          hookEvent: (hookEvent) => {
            console.log(`[ScenarioLoopHook] ${hookEvent.event} ${hookEvent.action} hook=${hookEvent.hookId} loop=${due.loop.id}`);
          },
          hookApproval: scenarioLoopHookApproval,
        });
        const completed = response.status === 'completed';
        if (!completed) {
          console.warn(`[ScenarioLoop] loop ${due.loop.id} run ended with status ${response.status}`);
        }
        return completed
          ? { ok: true, status: response.status }
          : { ok: false, code: `scenario_${response.status}`, status: response.status };
      } catch (error) {
        console.warn('[ScenarioLoop] run failed:', (error as Error)?.message);
        return { ok: false, code: 'run_failed' };
      }
    };
    const persistScenarioLoopState = async (
      scenarioId: string,
      loop: import('../engine/runtime/PersonalizationRuntimeContract.js').ScenarioLoop,
      scenarioRevision: number,
    ): Promise<boolean> => {
      const repository = personalizationRepository;
      if (!repository) return false;
      try {
        const scenario = repository.get(scenarioId);
        if (!scenario || scenario.kind !== 'scenario' || scenario.revision !== scenarioRevision) return false;
        const next = {
          ...scenario,
          loops: (scenario.loops ?? []).map((candidate) => (
            candidate.id === loop.id ? { ...loop } : candidate
          )),
          revision: scenario.revision + 1,
          provenance: { ...scenario.provenance, updatedAt: Date.now() },
        };
        const result = repository.save({ contractVersion: 1, definition: next, expectedRevision: scenarioRevision });
        return result.ok;
      } catch {
        return false;
      }
    };
    const runScenarioLoopTracked = createScenarioLoopRunTracker({
      activeRuns: activeScenarioLoopRuns,
      runtimeShutdown,
    });
    try {
      scenarioLoopScheduler = new ScenarioLoopScheduler({
        listScenarios: () => {
          try {
            return (personalizationRepository?.list('scenario', false) ?? [])
              .filter((definition): definition is import('../engine/runtime/PersonalizationRuntimeContract.js').ScenarioDefinition => definition.kind === 'scenario');
          } catch {
            return [];
          }
        },
        onLoopDue: async (due) => {
          const run = await runScenarioLoopTracked(due, 'scheduler', (signal) => runScenarioLoopOnce(due, signal));
          return run.ok;
        },
        persistLoopState: persistScenarioLoopState,
      });
      scenarioLoopScheduler.start();
    } catch (error) {
      scenarioLoopScheduler = null;
      console.warn('[Main] Scenario loop scheduler unavailable:', (error as Error)?.message);
    }
    // ── Loop「立即运行」：不等到期，用户在场景工作台手动触发一次真实运行 ──
    // ── 场景审批响应：renderer 审批界面的批准/拒绝回传（fail-closed 由超时兜底） ──
  ipcMain.handle('scenario:approval:respond', async (event, rawRequest: unknown) => {
    try {
      requireRendererMainFrame(event);
      if (runtimeShutdown.isDraining()) return { ok: false, code: 'application_shutting_down' };
      if (typeof rawRequest !== 'object' || rawRequest === null || Array.isArray(rawRequest)) {
        return { ok: false, code: 'invalid_request' };
      }
      const request = rawRequest as Record<string, unknown>;
      const requestId = typeof request.requestId === 'string' ? request.requestId : '';
      const approve = request.approve === true;
      if (!requestId || !scenarioApprovalRegistry.resolve(requestId, approve)) {
        return { ok: false, code: 'not_found' };
      }
      return { ok: true };
    } catch {
      return { ok: false, code: 'unauthorized' };
    }
  });

  ipcMain.handle('scenario:loop:run-now', async (event, rawRequest: unknown) => {      try {
        requireRendererMainFrame(event);
        if (runtimeShutdown.isDraining()) return { ok: false, code: 'application_shutting_down' };
        if (typeof rawRequest !== 'object' || rawRequest === null || Array.isArray(rawRequest)) {
          return { ok: false, code: 'invalid_request' };
        }
        const request = rawRequest as Record<string, unknown>;
        const scenarioId = typeof request.scenarioId === 'string' ? request.scenarioId : '';
        const loopId = typeof request.loopId === 'string' ? request.loopId : '';
        if (!scenarioId || !loopId) return { ok: false, code: 'invalid_request' };
        const repository = personalizationRepository;
        if (!repository) return { ok: false, code: 'unavailable' };
        const scenario = repository.get(scenarioId);
        if (!scenario || scenario.kind !== 'scenario') return { ok: false, code: 'not_found' };
        const loop = (scenario.loops ?? []).find((candidate) => candidate.id === loopId);
        if (!loop) return { ok: false, code: 'loop_not_found' };
        const run = await runScenarioLoopTracked(
          { scenarioId, loop },
          'run-now',
          (signal) => runScenarioLoopOnce({ scenarioId, loop }, signal),
        );
        if (!run.ok) {
          return { ok: false, code: run.code ?? 'run_failed', status: run.status };
        }
        const nextRunCount = loop.runCount + 1;
        const persisted = await persistScenarioLoopState(
          scenarioId,
          { ...loop, runCount: nextRunCount, lastRunAt: Date.now() },
          scenario.revision,
        );
        return persisted
          ? { ok: true, runCount: nextRunCount }
          : { ok: true, code: 'persist_conflict', runCount: nextRunCount };
      } catch (err) {
        return { ok: false, code: 'run_failed', error: String((err as Error).message ?? err).slice(0, 200) };
      }
    });
    try {
      personalizationBundles = new PersonalizationBundleService(path.join(DATA_DIR, 'personalization-bundles'));
      personalizationBundleSink = new PersonalizationBundleRepositorySink(personalizationRepository);
    } catch (error) {
      personalizationBundles = null;
      personalizationBundleSink = null;
      console.warn('[Main] Personalization bundle service unavailable:', (error as Error)?.message);
    }
    // ── Personalization extension services ──────────────────────────
    // Each capability gets its own fault boundary so one failure never
    // degrades unrelated personalization services (pattern used elsewhere).
    const skillRoot = path.join(DATA_DIR, 'personalization-skills');
    const mcpRoot = path.join(DATA_DIR, 'personalization-mcp');
    try {
      personalizationSkills = new PersonalizationSkillInstaller(skillRoot);
    } catch (error) {
      personalizationSkills = null;
      console.warn('[Main] Personalization skill installer unavailable:', (error as Error)?.message);
    }
    try {
      personalizationMcp = new PersonalizationMcpInstaller(mcpRoot);
    } catch (error) {
      personalizationMcp = null;
      console.warn('[Main] Personalization MCP installer unavailable:', (error as Error)?.message);
    }
    // MCP builder needs a live provider and evidence signing; kept isolated
    // from the installers above so a provider gap cannot disable them.
    const extensionEvidence = evidenceEnvelopes;
    let mcpBuilder: McpBuilderService | null = null;
    let mcpProbeRunner: PersonalizationMcpProbeRunner | null = null;
    try {
      if (!extensionEvidence) throw new Error('Evidence signing is unavailable');
      if (!personalizationMcp) throw new Error('MCP installer is unavailable');
      mcpBuilder = new McpBuilderService(personalizationMcp, {
        createSpecification: async (input) => {
          const activeProvider = provider;
          if (!activeProvider) throw new Error('Provider is unavailable');
          const response = await activeProvider.complete([
            {
              role: 'system',
              content: [
                'Return one JSON object only. Do not use Markdown fences.',
                'Convert the requirement into the Metis MCP Builder DSL.',
                'The root keys must be exactly: contractVersion, packageId, version, name, description, tools, environment.',
                'Only echo, constant_json, and http_json implementations are allowed. Never include credentials; use environment secret references.',
                `The packageId must be exactly ${input.requestedPackageId}.`,
              ].join('\n'),
            },
            { role: 'user', content: input.requirement },
          ], undefined, { temperature: 0, response_format: { type: 'json_object' } });
          const raw = JSON.parse(response.content) as unknown;
          return McpBuilderSpecificationSchema.parse(raw);
        },
      });
      mcpProbeRunner = new PersonalizationMcpProbeRunner({
        resolve: (reference, context) => personalizationSecretVault?.resolve(reference, context),
      });
    } catch (error) {
      mcpBuilder = null;
      mcpProbeRunner = null;
      console.warn('[Main] Personalization MCP builder unavailable:', (error as Error)?.message);
    }
    // Activation + generated activation recovery (each recovery is verified).
    if (personalizationMcp && extensionEvidence && mcpProbeRunner) {
      try {
        const activation = new PersonalizationMcpActivationService(mcpRoot, {
          installer: personalizationMcp,
          runner: mcpProbeRunner,
          store: personalizationRepository,
          evidence: extensionEvidence,
        });
        const recovered = await activation.recoverPending();
        if (!recovered.ok) throw new Error('Pending MCP activation recovery did not complete');
        const generatedActivation = new GeneratedMcpActivationCoordinator(mcpRoot, {
          installer: personalizationMcp,
          store: personalizationRepository,
          activator: activation,
        });
        const generatedRecovered = await generatedActivation.recoverPending();
        if (!generatedRecovered.ok) throw new Error('Pending generated MCP activation recovery did not complete');
        personalizationMcpActivation = activation;
        personalizationGeneratedMcpActivation = generatedActivation;
      } catch (error) {
        personalizationMcpActivation = null;
        personalizationGeneratedMcpActivation = null;
        console.warn('[Main] Personalization MCP activation unavailable:', (error as Error)?.message);
      }
    }
    // Extension service needs every port; skipped (not cascaded) if any is missing.
    if (personalizationSkills && personalizationMcp && mcpBuilder && extensionEvidence) {
      try {
        personalizationExtensions = new PersonalizationExtensionService({
          definitions: {
            get: (id) => personalizationRepository?.get(id, true),
            save: (request) => personalizationRepository?.save(request) ?? { ok: false, code: 'io_error' },
          },
          evidence: extensionEvidence,
          skills: personalizationSkills,
          mcp: personalizationMcp,
          mcpBuilder,
          mcpProbeRunner: mcpProbeRunner ?? undefined,
          mcpCompensator: new FilesystemMcpInstallationCompensator(mcpRoot),
        });
        // 场景编译循环的全自动安装注入（2026-08-23 刘总授权）。
        scenarioAcquisition.install.apply = (request) => personalizationExtensions!.apply(request);
      } catch (error) {
        personalizationExtensions = null;
        scenarioAcquisition.install.apply = null;
        console.warn('[Main] Personalization extension service unavailable:', (error as Error)?.message);
      }
    }
    // Portable bundle coordinator (needs bundles sink + skill installer).
    try {
      if (!personalizationBundles || !personalizationBundleSink || !personalizationSkills) {
        throw new Error('Base personalization bundle services are unavailable');
      }
      const bundleAssetRoot = path.join(DATA_DIR, 'personalization-bundles');
      const rehydrationStagingRoot = path.join(DATA_DIR, 'personalization-bundle-skill-staging');
      const receiptRoot = path.join(DATA_DIR, 'personalization-bundle-receipts');
      const skillRehydrator = new PersonalizationBundleSkillRehydrationService(
        bundleAssetRoot,
        rehydrationStagingRoot,
        personalizationSkills,
      );
      personalizationBundleSkillAssets = new PersonalizationBundleSkillAssetSource(
        personalizationRepository,
        personalizationSkills,
      );
      personalizationBundleCoordinator = new PersonalizationBundleImportCoordinator({
        bundleService: personalizationBundles,
        definitionSink: personalizationBundleSink,
        skillRehydrator,
        skillCompensator: personalizationSkills,
        bundleAssetRoot,
        receiptRoot,
      });
    } catch (error) {
      personalizationBundleCoordinator = null;
      personalizationBundleSkillAssets = null;
      console.warn('[Main] Portable personalization bundles unavailable:', (error as Error)?.message);
    }
    // Managed MCP runtime + tool bridge.
    if (personalizationMcp && extensionEvidence) {
      try {
        personalizationMcpRuntime = new ManagedPersonalizationMcpRuntime(
          personalizationMcp,
          { resolve: (reference, context) => personalizationSecretVault?.resolve(reference, context) },
          extensionEvidence,
          {
            runtimeSnapshotRoot: path.join(DATA_DIR, 'personalization-mcp-runtime'),
            recoverStaleSnapshots: true,
          },
        );
        personalizationMcpBridge = new PersonalizationMcpToolBridge({
          runtime: personalizationMcpRuntime,
          definitions: personalizationRepository,
          descriptors: personalizationMcp,
          evidenceSink: {
            record: (envelope) => extensionEvidence.verify(envelope)
              && Boolean(personalizationRepository?.recordEvidenceEnvelope(envelope)),
          },
        });
      } catch (error) {
        personalizationMcpRuntime = null;
        personalizationMcpBridge = null;
        console.warn('[Main] Personalization MCP runtime unavailable:', (error as Error)?.message);
      }
    }
    outcomeRepository = new OutcomeRepository(store.raw);
    topicRepositoryInstance = new TopicRepository(store.raw);
    artifactPromptService = new ArtifactPromptService(store.raw);
    officePromptProfileService = new OfficePromptProfileService(store.raw);
    officePromptProfileService.ensureBuiltinProfiles();
    submissionRepository = new SubmissionRepository(store.raw);
    journalProfileRepository = new JournalProfileRepository(store.raw);
    // ── Submission P2 服务（投稿预检 / 投稿包 / Cover Letter）──
    submissionPackageRepository = new SubmissionPackageRepository(store.raw);
    submissionPreflightService = new SubmissionPreflightService({
      submissionRepository,
      journalRepository: journalProfileRepository,
      outcomeRepository,
      packageRepository: submissionPackageRepository,
    });
    submissionPackageService = new SubmissionPackageService({
      submissionRepository,
      packageRepository: submissionPackageRepository,
      outcomeRepository,
      journalRepository: journalProfileRepository,
      docxService: new OutcomeWordDocxService(),
      preflightService: submissionPreflightService,
      userDataDir: USER_DATA_DIR,
    });
    submissionCoverLetterService = new CoverLetterService({
      submissionRepository,
      journalRepository: journalProfileRepository,
      outcomeRepository,
      packageRepository: submissionPackageRepository,
      resolveBehaviorPrompt: (promptId, outcomeId) => officePromptProfileService?.resolveForBasePrompt(promptId, outcomeId ?? null) ?? artifactPromptService?.resolve(promptId) ?? null,
    });
    // ── Submission P4 服务（审稿轮次 / Decision Letter 拆解 / Response Letter）──
    submissionReviewRepository = new SubmissionReviewRepository(store.raw);
    submissionReviewService = new SubmissionReviewService({
      submissionRepository,
      reviewRepository: submissionReviewRepository,
      outcomeRepository,
    });
    // 旧版 submissions.json（如存在）一次性迁移进 SQLite 投稿域；幂等，可重复执行。
    try {
      const legacyPath = path.join(DATA_DIR, 'submissions.json');
      const migrated = submissionRepository.migrateLegacyFile(legacyPath, (p) => fs.readFileSync(p, 'utf8'));
      if (migrated > 0) console.log(`[Submission] migrated ${migrated} legacy submission record(s) from submissions.json`);
    } catch (error) {
      console.warn('[Submission] legacy migration skipped:', (error as Error)?.message);
    }
  const firstRunStorageForFreeModels = createFirstRunSecureStorage(safeStorage);
  freeModelService = new FreeModelService({
    dataDir: DATA_DIR,
    decryptProfileKey: (profileId) => {
      try {
        if (!providerProfileStore) return null;
        const config = providerProfileStore.configFor(profileId);
        return config.ok ? config.value.apiKey : null;
      } catch { return null; }
    },
    providerProfileStore: providerProfileStore!,
    encryptSecret: (plain) => firstRunStorageForFreeModels.encrypt(plain),
    decryptSecret: (cipher) => firstRunStorageForFreeModels.decrypt(cipher),
    deleteProfile: async (id, revision) => {
      if (!providerProfileStore) return false;
      const removed = await providerProfileStore.delete({
        contractVersion: 1,
        operationId: randomUUID(),
        id,
        expectedRevision: revision,
      });
      return removed.ok;
    },
    emitAutoRegisterProgress: (snapshot) => {
      for (const win of BrowserWindow.getAllWindows()) {
        try { if (!win.isDestroyed()) win.webContents.send('freeModel:autoRegisterProgress', snapshot); } catch { /* 窗口销毁竞态 */ }
      }
    },
  });
    // ── Submission P3/P4 外联服务：通信记录 / SMTP 外发 / IMAP 监听 / 投稿门户 ──
    // 放在 FreeModelService 之后：复用其同款 firstRunSecureStorage 解密邮箱授权码。
    submissionCorrespondenceRepository = new SubmissionCorrespondenceRepository(store.raw);
    // 与 FreeModelService 内部的 MailboxPoolStore 读同一个 JSON 文件（磁盘为单一事实源，
    // 每次操作实时读盘，双实例无状态漂移）。Submission 不依赖 FreeModelService 本体。
    submissionMailboxStore = new MailboxPoolStore(DATA_DIR);
    const decryptMailboxSecret = (cipher: string): string | null => {
      try {
        return firstRunStorageForFreeModels.decrypt(cipher);
      } catch {
        return null;
      }
    };
    mailSendService = new MailSendService({
      mailboxStore: submissionMailboxStore,
      decryptSecret: decryptMailboxSecret,
      correspondenceRepository: submissionCorrespondenceRepository,
      submissionRepository,
    });
    submissionMailService = new SubmissionMailService({
      mailboxStore: submissionMailboxStore,
      decryptSecret: decryptMailboxSecret,
      correspondenceRepository: submissionCorrespondenceRepository,
      submissionRepository,
      reviewService: submissionReviewService,
      imapClientCtor: ImapFlow as unknown as ImapFlowConstructor,
    });
    // 门户浏览器是懒加载委托：首次调用才创建 BrowserService（依赖主窗口就绪）。
    const portalBrowser: PortalBrowser = {
      navigate: (url: string) => {
        const svc = ensureBrowserService();
        return svc ? svc.navigate(url) : Promise.resolve({ ok: false, error: 'browser_unavailable' });
      },
      extract: () => {
        const svc = ensureBrowserService();
        return svc ? svc.extract() : Promise.resolve({ ok: false, error: 'browser_unavailable' });
      },
      evaluateInView: (fn: string) => {
        const svc = ensureBrowserService();
        return svc ? svc.evaluateInView(fn) : Promise.resolve({ ok: false, error: 'browser_unavailable' });
      },
      enumerateFormFields: () => {
        const svc = ensureBrowserService();
        return svc ? svc.enumerateFormFields() : Promise.resolve({ ok: false, error: 'browser_unavailable' });
      },
    };
    submissionPortalService = new SubmissionPortalService({
      browserService: portalBrowser,
      submissionRepository,
      journalProfileRepository,
    });
    // 返修截止日期 → Goal/TaskBoard 同步（复用 goalEngine 底层，见 goal:create）。
    submissionDeadlineSync = new SubmissionDeadlineSync({
      reviewRepository: submissionReviewRepository!,
      submissionRepository: submissionRepository!,
      createGoal: (description, context, projectId) => {
        try {
          return goalEngine?.createGoal(description, context, projectId) ?? null;
        } catch {
          return null;
        }
      },
    });
    // 投稿邮件后台监听：周期同步全部（项目 × 邮箱账户），新邮件推送渲染端。
    submissionMailWatcher = new SubmissionMailWatcher({
      listTargets: () => {
        const store = submissionMailboxStore!;
        const repo = submissionRepository!;
        const corrRepo = submissionCorrespondenceRepository!;
        const accounts = store.list();
        if (accounts.length === 0) return [];
        const projectIds = new Set<string>();
        for (const record of corrRepo.listPendingAll()) projectIds.add(record.projectId);
        for (const series of repo.listAllSeries()) projectIds.add(series.projectId);
        if (projectIds.size === 0) {
          // 没有任何投稿记录时不同步——避免对纯 FreeModel 邮箱做无谓轮询。
          return [];
        }
        return SubmissionMailWatcher.allProjectAccounts([...projectIds], accounts);
      },
      sync: async (target) => {
        const service = submissionMailService;
        if (!service) return { ok: false };
        const result = await service.syncAccount(target);
        if (!result.ok) return { ok: false };
        return { ok: true, newRecords: result.newRecords };
      },
      notify: (notification) => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) win.webContents.send('submission:mail:changed', notification);
      },
      logger: console,
    });
    submissionMailWatcher.start();
    outcomeMedia = new OutcomeMediaService(store.raw, OUTCOME_MEDIA_DIR);
    outcomeImage = new OutcomeImageService({
      db: store.raw,
      repository: outcomeRepository,
      media: outcomeMedia,
      secretVault: personalizationSecretVault,
      resolveBehaviorPrompt: (promptId, outcomeId) => officePromptProfileService?.resolveForBasePrompt(promptId, outcomeId ?? null) ?? artifactPromptService?.resolve(promptId) ?? null,
    });
    researchRepository = new ResearchRepository(store.raw, (manifest, content) => {
      if (!researchRepository || !citationTruthReceipts) {
        return { receiptVerified: false, profileEnforced: false };
      }
      return verifyArtifactForPersistence(
        researchRepository,
        citationTruthReceipts,
        manifest,
        content,
      );
    });
    researchMedia = new ResearchMediaService({
      repository: researchRepository,
      fileCapabilities,
      managedRoot: RESEARCH_MEDIA_DIR,
    });
    researchRuntime = new ResearchRuntimeService(
      researchRepository,
      researchMedia,
      citationTruthReceipts ?? undefined,
    );
    // Initialize experiment script adapter (GLM-102)
    try {
      experimentScriptAdapter = createExperimentScriptAdapter({
        db: store.raw,
        resourcesPath: process.resourcesPath,
        processSecret: EXPERIMENT_SESSION_SECRET,
      });
      console.log('[Main] ExperimentScriptAdapter initialized.');
    } catch (err: unknown) {
      experimentScriptAdapter = null;
      console.warn('[Main] ExperimentScriptAdapter failed:', (err as Error)?.message);
    }
    console.log('[Main] PersistenceStore initialized.');
    // Resume a previously bound WeChat bot (polling starts only if bound).
    try {
      ensureWeChatBot?.()?.start();
    } catch (err: unknown) {
      console.warn('[Main] WeChat bot resume failed:', (err as Error)?.message);
    }
  } catch (err: unknown) {
    personalizationRepository = null;
    personalizationRuntime = null;
    personalizationSkills = null;
    personalizationMcp = null;
    personalizationMcpRuntime = null;
    personalizationMcpBridge = null;
    personalizationMcpActivation = null;
    personalizationGeneratedMcpActivation = null;
    personalizationExtensions = null;
    scenarioAcquisition.install.apply = null;
    personalizationBundles = null;
    personalizationBundleSink = null;
    personalizationBundleCoordinator = null;
    personalizationBundleSkillAssets = null;
    fundingTemplateRepository = null;
    fundingTemplateService = null;
    fundingTemplateTools = null;
    researchRepository = null;
    researchRuntime = null;
    researchMedia = null;
    console.warn('[Main] PersistenceStore failed to load (SQLite native module not available). Running without persistence.');
    console.warn('[Main] Error:', (err as Error)?.message);
    // store remains null — IPC handlers check for null
  }

  // Initialize memory manager
  if (store) {
    memoryManager = new MemoryManager(store, DATA_DIR);
  }

  // Initialize MCP manager (before agent so tools can be registered)
  if (store) {
    mcpManager = new MCPManager(store, new ToolRegistry());
  }

  // Initialize skill registry with default skills + reload any custom skills
  // the user generated in a previous session (persisted in the memory store).
  skillRegistry = registerDefaultSkills();
  skillExtractor = new SkillExtractor(provider ?? undefined);
  loadAndInstallCustomSkills();



  // Setup IPC before loading the renderer, then create the initial window.
  setupIPC();
  console.info('[METIS_RUNTIME_IDENTITY]', JSON.stringify(getRuntimeIdentity()));
  // 嵌入式 GenOffice 兼容通道：必须在 setupIPC() 之后注册——compatHandle 只补
  // METIS 尚未认领的空白通道，绝不覆盖主应用已有通道（如 project:list）。
  registerGenofficeDocsCompat({
    getSessionByWebContents: (webContentsId) => genofficeEmbeddedViews.getSessionByWebContents(webContentsId),
    readFileBytes: async (session) => {
      const { readEmbeddedSessionFile } = await import('./genofficeEmbedded/genofficeEmbeddedFileIo.js');
      return readEmbeddedSessionFile(session.filePath);
    },
    writeSessionFile: async (session, bytes) => {
      const { writeEmbeddedSessionFile } = await import('./genofficeEmbedded/genofficeEmbeddedFileIo.js');
      await writeEmbeddedSessionFile(session.filePath, bytes);
    },
  });
  onEmbeddedThemeChanged((value) => {
    genofficeEmbeddedViews.broadcastTheme(value);
  });
  // METIS-OPT-4: show the window immediately; heavy personalization
  // initialization below continues in the background. The renderer waits on
  // store:ready before hydrating, so early UI never sees a half-initialized
  // main process.
  createWindow();

  // Restore the OS-protected first-run configuration and atomically prepare the
  // provider runtime before the renderer loads. Legacy configuration remains a
  // migration fallback only when no new setup envelope is ready.
  let setupRestored = false;
  try {
    firstRunSetup = new FirstRunSetupService({
      configPath: SETUP_CONFIG_PATH,
      secureStorage: createFirstRunSecureStorage(safeStorage),
      probeTransport: new OpenAISetupProbeTransport(),
      runtimeRebuilder: {
        prepare: async (context) => prepareProviderRuntime(context),
      },
    });
    const restored = await firstRunSetup.restore({
      version: SETUP_RUNTIME_CONTRACT_VERSION,
      operationId: 'startup-restore',
    });
    setupRestored = restored.state === 'ready';
  } catch {
    firstRunSetup?.dispose();
    firstRunSetup = null;
  }
  currentTheme = loadTheme();
  if (!setupRestored) initProviderAndAgent();

  // The profile envelope becomes the authoritative multi-model source after a
  // successful migration. A failure intentionally leaves the existing setup
  // runtime untouched and exposes only a fixed unavailable state to the UI.
  if (providerProfileStore) {
    const initialized = await providerProfileStore.initialize(currentConfig);
    if (!initialized.ok) {
      providerProfileStore = null;
      providerProfileStorage = null;
    } else {
      const profiles = providerProfileStore.list();
      const active = profiles.ok ? profiles.value.profiles.find((profile) => profile.isActive) : undefined;
      if (!active) {
        // A safe envelope with no active profile is an explicit user reset;
        // never resurrect a legacy setup configuration on restart.
        deactivateProviderRuntime('provider_profiles_unconfigured');
      } else {
        const activeConfig = providerProfileStore.configFor(active.id);
        if (activeConfig.ok) {
          try {
            const candidate = prepareProviderRuntime(providerProfileRuntimeContext(activeConfig.value, 'restore'));
            await candidate.commitAndAbortPrevious();
            // 如实日志（2026-09-05 排障教训）：此前启动只打 legacy config 的
            // baseUrl，误导排障方向；实际请求走的是这里 restore 的 active profile。
            console.log('[Main] active provider profile restored —', active.name, '·', activeConfig.value.baseUrl, '· model:', activeConfig.value.model, '· timeout(ms):', activeConfig.value.timeout ?? '(provider default)');
          } catch {
            // The profile file remains authoritative; an unusable active profile
            // does not silently fall back to an older configuration source.
            deactivateProviderRuntime('provider_profile_restore_failed');
          }
        } else {
          deactivateProviderRuntime('provider_profile_restore_failed');
        }
      }
    }
  }
  startupReady = true;

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

async function completeApplicationShutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    goalEngine?.suspendActiveGoalsForShutdown();
    const [chatDrain, goalDrain] = await Promise.all([
      runtimeShutdown.drain(SHUTDOWN_DRAIN_TIMEOUT_MS),
      goalEngine?.drainActiveRuns(SHUTDOWN_DRAIN_TIMEOUT_MS) ?? Promise.resolve({ timedOut: false, pending: [] }),
    ]);
    if (chatDrain.timedOut || goalDrain.timedOut) {
      // 任务3：pending 进入诊断——结构化写出未完结操作 id，供排障审计。
      console.warn('[Main][shutdown-diagnostic] drain timed out; pending operations:', JSON.stringify({ chat: chatDrain, goal: goalDrain }));
    }

    if (backupTimer) {
      clearInterval(backupTimer);
      backupTimer = null;
    }
    scenarioLoopScheduler?.stop();
    scenarioLoopScheduler = null;
    if (activeAutonomousSessionId) {
      autonomousEngine?.interrupt(activeAutonomousSessionId, 'application_shutdown');
    }
    if (activeAutonomousRun) {
      const autonomousDrain = activeAutonomousRun.completion;
      await Promise.race([
        autonomousDrain,
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS)),
      ]);
    }
    if (weChatBotService) {
      await weChatBotService.stop().catch(() => undefined);
      weChatBotService = null;
    }
     await outcomeExternalEditor.shutdownAll().catch(() => undefined);
    genofficeEmbeddedViews.shutdownAll();
    fileCapabilities.clear();
    exportPreviews.clear();
    for (const session of activeTerminals.values()) {
      session.killed = true;
      session.terminal.kill();
    }
    activeTerminals.clear();
    executionCapabilities?.clear();
    experimentScriptAdapter?.dispose();
    firstRunSetup?.dispose();
    firstRunSetup = null;
    await mcpManager?.disconnectAll().catch(() => undefined);
    await personalizationMcpRuntime?.shutdownAll().catch(() => undefined);
    store?.close();
    store = null;
    researchRepository = null;
    researchRuntime = null;
    researchMedia = null;
    // 任务3：最后一步——冲刷并关闭日志目的地，恢复原始 console。
    // 后续（before-quit 兜底）日志仍走原始 console，不影响退出。
    mainProcessLogger.dispose();
  })();
  return shutdownPromise;
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (shutdownPromise) return;
  event.preventDefault();
  void completeApplicationShutdown().then(() => {
    clearCrashMarker(DATA_DIR);
    app.quit();
  }).catch((error) => {
    console.error('[Main] shutdown cleanup failed', error);
    clearCrashMarker(DATA_DIR);
    app.quit();
  });
});
