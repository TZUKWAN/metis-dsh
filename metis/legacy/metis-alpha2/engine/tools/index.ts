/**
 * Tool system exports and builtin registration.
 */

export { ToolRegistry } from './ToolRegistry.js';
export { ToolDispatcher } from './ToolDispatcher.js';
export type { ToolHandler } from './ToolDispatcher.js';
export { ResultStore } from './ResultStore.js';

import type { ToolSpec } from '../core/types.js';
import { ToolRegistry } from './ToolRegistry.js';
import { ToolDispatcher } from './ToolDispatcher.js';
import { buildBuiltinDecoders } from './ToolPresenter.js';
import { getFileToolSpecs, getFileToolHandlers } from './builtin/file-tools.js';
import { getSearchToolSpecs, getSearchToolHandlers } from './builtin/search-tools.js';
import { getShellToolSpecs, getShellToolHandlers } from './builtin/shell-tools.js';
import { getResearchToolSpecs, getResearchToolHandlers } from './builtin/research-tools.js';
import { getWebToolSpecs, getWebToolHandlers } from './builtin/web-tools.js';
import { PLUGIN_TOOLS, getPluginToolHandlers } from './builtin/PluginMarketplace.js';
import { MULTI_AGENT_TOOL, createMultiAgentHandler } from './builtin/MultiAgentTool.js';
import { getEvidenceToolSpecs, getEvidenceToolHandlers } from './builtin/evidence-tools.js';
import { getMemoryToolSpecs, getMemoryToolHandlers } from './builtin/MemoryTools.js';
import {
  LIST_PROJECT_SOURCES_TOOL,
  createProjectResearchToolHandlers,
} from './builtin/ProjectResearchTools.js';
import { TRUST_TOOL_SPECS, getTrustToolHandlers } from './builtin/trust-tools.js';
import { RESEARCH_CODING_TOOL_SPECS, createResearchCodingToolHandlers } from './builtin/research-coding-tools.js';
import { WRITING_TOOL_SPECS, getWritingToolHandlers } from './builtin/writing-tools.js';
import { STATISTICS_TOOL_SPECS, getStatisticsToolHandlers } from './builtin/statistics-tools.js';
import { JOURNAL_CATALOG_TOOL_SPECS, journalDirectorySearchHandler, journalDirectoryDetailHandler } from './builtin/journal-catalog-tools.js';
import { RESEARCH_NETWORK_TOOL_SPECS, getResearchNetworkToolHandlers } from './builtin/research-network-tools.js';
import { NOTES_TOOL_SPECS, getNotesToolHandlers } from './builtin/notes-tools.js';
import {
  ACADEMIC_TOOL_SPECS,
  SEARCH_PAPER_TEXT_TOOL,
  searchPaperTextHandler,
  arxivSearchHandler,
  importByArxivHandler,
  searchPapersHandler,
  importByDoiHandler,
  recommendPapersHandler,
  literatureReviewHandler,
  dailyPapersHandler,
  webImportHandler,
  fulltextSearchHandler,
  parseBibtexHandler,
  bibtexAuditHandler,
  latexCleanupHandler,
  figureAuditHandler,
  tableAuditHandler,
  latexIntegrityReportHandler,
  mathAuditHandler,
  sectionAuditHandler,
  sectionGuideHandler,
  formatCitationHandler,
  readPdfHandler,
  crossrefLookupHandler,
  openAlexLookupHandler,
  writingStageCheckHandler,
  styleCalibrationHandler,
  searchLibraryHandler,
  findLibraryDuplicatesHandler,
  deleteLibraryDuplicatesHandler,
  libraryStatsHandler,
  exportLibraryHandler,
  importPapersHandler,
  experimentStatsHandler,
  experimentCompareHandler,
  experimentExportHandler,
  collectionStatsHandler,
  noteStatsHandler,
  tagsAuditHandler,
  tagsMergeHandler,
  citationNetworkHandler,
  literatureTriageHandler,
  reviewSaveHandler,
  reviewListHandler,
  reviewGetHandler,
  researchStateHandler,
  researchSummaryHandler,
  interestProfileHandler,
  rankCandidatesHandler,
  figureReferenceCheckHandler,
  workspaceInitHandler,
  workspaceStatusHandler,
  findingsAddHandler,
  findingsListHandler,
  findingsExportHandler,
  experimentToFindingsHandler,
  claimToFindingsHandler,
  runExperimentScriptHandler,
  citationTriangulateHandler,
  citationPassportRecordHandler,
  citationPassportGetHandler,
  citationPassportListHandler,
  citationPassportAddSignalHandler,
  citationPassportScanHandler,
  retractionWatchUpdateHandler,
  retractionWatchLookupHandler,
  retractionWatchStatsHandler,
  journalIntegrityUpdateHandler,
  journalIntegrityLookupHandler,
  journalIntegrityStatsHandler,
} from './builtin/academic-tools.js';
import {
  browserNavigateHandler,
  browserBackHandler,
  browserForwardHandler,
  browserReloadHandler,
  browserClickHandler,
  browserTypeHandler,
  browserScrollHandler,
  browserScreenshotHandler,
  browserExtractHandler,
  browserCollectHandler,
} from './browser-tools.js';

// ── Current Affairs tools ────────────────────────────────────────

// current_affairs_research REMOVED from builtin registry (fail-closed).
// Engine tool context cannot route selectedSourceIds through main
// canonical repository+structured decoder.
// current_affairs_research REMOVED from builtin registry (fail-closed).
// Engine tool context cannot route selectedSourceIds through main
// canonical repository+structured decoder.
const CURRENT_AFFAIRS_SPECS: ToolSpec[] = [];



/**
 * Register all built-in tools (file + search + shell + academic + research + current_affairs) into a registry and dispatcher.
 * @param options.agentLoop — when provided, the multi-agent orchestration tool is registered.
 * @param options.store — when provided, the memory_remember/memory_recall tools get a live memory store.
 */
export function registerBuiltinTools(
  registry: ToolRegistry,
  dispatcher: ToolDispatcher,
  options?: {
    agentLoop?: import('../core/AgentLoop.js').AgentLoop;
    store?: import('../persistence/PersistenceStore.js').PersistenceStore;
    researchRepository?: import('../persistence/ResearchRepository.js').ResearchRepository;
  },
): void {
  const allSpecs: ToolSpec[] = [
    ...getFileToolSpecs(),
    ...getSearchToolSpecs(),
    ...getShellToolSpecs(),
    ...ACADEMIC_TOOL_SPECS,
    ...JOURNAL_CATALOG_TOOL_SPECS,
    SEARCH_PAPER_TEXT_TOOL,
    ...TRUST_TOOL_SPECS,
    ...WRITING_TOOL_SPECS,
    ...STATISTICS_TOOL_SPECS,
    ...RESEARCH_NETWORK_TOOL_SPECS,
    ...NOTES_TOOL_SPECS,
    ...getResearchToolSpecs(),
    ...getWebToolSpecs(),
    ...PLUGIN_TOOLS,
    ...getEvidenceToolSpecs(),
    ...getMemoryToolSpecs(),
    ...(options?.researchRepository ? [LIST_PROJECT_SOURCES_TOOL] : []),
    ...(options?.researchRepository ? RESEARCH_CODING_TOOL_SPECS : []),
    ...(options?.agentLoop ? [MULTI_AGENT_TOOL] : []),
    ...CURRENT_AFFAIRS_SPECS,
  ];

  const allHandlers = new Map<string, import('./ToolDispatcher.js').ToolHandler>([
    ...getFileToolHandlers(),
    ...getSearchToolHandlers(),
    ...getShellToolHandlers(),
    ...getResearchToolHandlers(),
    ...getWebToolHandlers(),
    ...getPluginToolHandlers(),
    ...getEvidenceToolHandlers(),
    ...getMemoryToolHandlers(options?.store),
    ...createProjectResearchToolHandlers(options?.researchRepository),
    ...createResearchCodingToolHandlers(options?.researchRepository),
    ...getTrustToolHandlers(),
    ...getWritingToolHandlers(),
    ...getStatisticsToolHandlers(),
    ...getResearchNetworkToolHandlers(),
    ...getNotesToolHandlers(),
    ['arxiv_search', arxivSearchHandler],
    ['import_by_arxiv', importByArxivHandler],
    ['search_papers', searchPapersHandler],
    ['search_paper_text', searchPaperTextHandler],
    ['import_by_doi', importByDoiHandler],
    ['recommend_papers', recommendPapersHandler],
    ['literature_review', literatureReviewHandler],
    ['daily_papers', dailyPapersHandler],
    ['web_import', webImportHandler],
    ['fulltext_search', fulltextSearchHandler],
    ['parse_bibtex', parseBibtexHandler],
    ['bibtex_audit', bibtexAuditHandler],
    ['latex_cleanup', latexCleanupHandler],
    ['figure_audit', figureAuditHandler],
    ['table_audit', tableAuditHandler],
    ['latex_integrity_report', latexIntegrityReportHandler],
    ['math_audit', mathAuditHandler],
    ['section_audit', sectionAuditHandler],
    ['section_guide', sectionGuideHandler],
    ['format_citation', formatCitationHandler],
    ['read_pdf', readPdfHandler],
    ['browser_navigate', browserNavigateHandler],
    ['browser_back', browserBackHandler],
    ['browser_forward', browserForwardHandler],
    ['browser_reload', browserReloadHandler],
    ['browser_click', browserClickHandler],
    ['browser_type', browserTypeHandler],
    ['browser_scroll', browserScrollHandler],
    ['browser_screenshot', browserScreenshotHandler],
    ['browser_extract', browserExtractHandler],
    ['browser_collect', browserCollectHandler],
    ['crossref_lookup', crossrefLookupHandler],
    ['openalex_lookup', openAlexLookupHandler],
    ['journal_directory_search', journalDirectorySearchHandler],
    ['journal_directory_detail', journalDirectoryDetailHandler],
    ['writing_stage_check', writingStageCheckHandler],
    ['style_calibration', styleCalibrationHandler],
    ['search_library', searchLibraryHandler],
    ['find_library_duplicates', findLibraryDuplicatesHandler],
    ['delete_library_duplicates', deleteLibraryDuplicatesHandler],
    ['library_stats', libraryStatsHandler],
    ['export_library', exportLibraryHandler],
    ['import_papers', importPapersHandler],
    ['experiment_stats', experimentStatsHandler],
    ['experiment_compare', experimentCompareHandler],
    ['experiment_export', experimentExportHandler],
    ['collection_stats', collectionStatsHandler],
    ['note_stats', noteStatsHandler],
    ['tags_audit', tagsAuditHandler],
    ['tags_merge', tagsMergeHandler],
    ['citation_network', citationNetworkHandler],
    ['literature_triage', literatureTriageHandler],
    ['review_save', reviewSaveHandler],
    ['review_list', reviewListHandler],
    ['review_get', reviewGetHandler],
    ['research_state', researchStateHandler],
    ['research_summary', researchSummaryHandler],
    ['interest_profile', interestProfileHandler],
    ['rank_candidates', rankCandidatesHandler],
    ['figure_reference_check', figureReferenceCheckHandler],
    ['workspace_init', workspaceInitHandler],
    ['workspace_status', workspaceStatusHandler],
    ['findings_add', findingsAddHandler],
    ['findings_list', findingsListHandler],
    ['findings_export', findingsExportHandler],
    ['experiment_to_findings', experimentToFindingsHandler],
    ['claim_to_findings', claimToFindingsHandler],
    ['run_experiment_script', runExperimentScriptHandler],
    ['citation_triangulate', citationTriangulateHandler],
    ['citation_passport_record', citationPassportRecordHandler],
    ['citation_passport_get', citationPassportGetHandler],
    ['citation_passport_list', citationPassportListHandler],
    ['citation_passport_add_signal', citationPassportAddSignalHandler],
    ['citation_passport_scan', citationPassportScanHandler],
    ['retraction_watch_update', retractionWatchUpdateHandler],
    ['retraction_watch_lookup', retractionWatchLookupHandler],
    ['retraction_watch_stats', retractionWatchStatsHandler],
    ['journal_integrity_update', journalIntegrityUpdateHandler],
    ['journal_integrity_lookup', journalIntegrityLookupHandler],
    ['journal_integrity_stats', journalIntegrityStatsHandler],
    // ['current_affairs_research', currentAffairsResearchHandler], // REMOVED — fail-closed
    ...(options?.agentLoop ? [['multi_agent_orchestrate', createMultiAgentHandler({ agentLoop: options.agentLoop })] as const] : []),
  ]);

  const builtinDecoders = buildBuiltinDecoders();
  for (const spec of allSpecs) {
    // Built-in presenters are bound to an internal manifest and cannot be
    // overridden by a public ToolSpec.decodeResult.
    registry.register({
      ...spec,
      decodeResult: builtinDecoders.get(spec.name),
    });
  }

  for (const [name, handler] of allHandlers) {
    dispatcher.registerHandler(name, handler);
  }
}
