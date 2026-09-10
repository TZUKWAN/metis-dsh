/**
 * submissionBridge.ts — Task 3 §5 preload domain split.
 * Mechanical extraction from electron/preload.ts; method bodies unchanged.
 */

import { ipcRenderer } from 'electron';

export const submissionBridge = {
    createSubmission: async (request: { title: string; journal: string; projectId?: string | null; artifactId?: string | null; status?: string; notes?: string }) =>
      ipcRenderer.invoke('submissions:create', request) as Promise<{ id: string } | null>,

    updateSubmissionStatus: async (id: string, status: string) => ipcRenderer.invoke('submissions:updateStatus', { id, status }) as Promise<{ id: string } | null>,

    addSubmissionComment: async (id: string, text: string) => ipcRenderer.invoke('submissions:addComment', { id, text }) as Promise<{ id: string } | null>,

    resolveSubmissionComment: async (request: { id: string; commentId: string; resolved: boolean; revisionNote?: string }) =>
      ipcRenderer.invoke('submissions:resolveComment', request) as Promise<{ id: string } | null>,

    deleteSubmission: async (id: string) => ipcRenderer.invoke('submissions:delete', id) as Promise<boolean>,

    buildResponseLetter: async (id: string) => ipcRenderer.invoke('submissions:responseLetter', id) as Promise<string | null>,
    // ── Submission domain（投稿生命周期：Series / Case / Events / 状态机）──

    // ── Submission domain（投稿生命周期：Series / Case / Events / 状态机）──
    listSubmissionSeries: async (projectId: string) =>
      ipcRenderer.invoke('submission:listSeries', projectId) as Promise<import('../../engine/submission/SubmissionRuntimeContract.js').SubmissionSeries[]>,

    listSubmissionCases: async (request: { projectId: string; status?: string; query?: string; includeClosed?: boolean }) =>
      ipcRenderer.invoke('submission:listCases', request) as Promise<import('../../engine/submission/SubmissionRuntimeContract.js').SubmissionCase[]>,

    getSubmissionCase: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:getCase', request) as Promise<import('../../engine/submission/SubmissionRuntimeContract.js').SubmissionCase | null>,

    createSubmissionCase: async (request: import('../../engine/submission/SubmissionRuntimeContract.js').SubmissionCaseCreateInput & { seriesId?: string | null }) =>
      // The main handler resolves with the repository shape { series, submissionCase };
      // duplicate-active is reported as { ok: false, code: 'duplicate_active', ... }.
      ipcRenderer.invoke('submission:createCase', request) as Promise<{ series: import('../../engine/submission/SubmissionRuntimeContract.js').SubmissionSeries; submissionCase: import('../../engine/submission/SubmissionRuntimeContract.js').SubmissionCase } | { ok: false; code: 'duplicate_active'; activeCaseId: string; activeJournal: string } | null>,

    updateSubmissionCase: async (request: { projectId: string; patch: Record<string, unknown> }) =>
      ipcRenderer.invoke('submission:updateCase', request) as Promise<import('../../engine/submission/SubmissionRuntimeContract.js').SubmissionCase | null>,

    changeSubmissionStatus: async (request: { projectId: string; change: { caseId: string; to: string; reason?: string; actor?: string; source?: string } }) =>
      ipcRenderer.invoke('submission:changeStatus', request) as Promise<import('../../engine/submission/SubmissionRuntimeContract.js').SubmissionCase | { ok: false; code: 'illegal_transition'; message: string } | null>,

    listSubmissionEvents: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:listEvents', request) as Promise<import('../../engine/submission/SubmissionRuntimeContract.js').SubmissionEvent[]>,

    addSubmissionEvent: async (request: { projectId: string; caseId: string; type: string; source?: string; sourceId?: string | null; actor?: string; description?: string; metadata?: Record<string, unknown> }) =>
      ipcRenderer.invoke('submission:addEvent', request) as Promise<import('../../engine/submission/SubmissionRuntimeContract.js').SubmissionEvent | null>,

    archiveSubmissionCase: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:archiveCase', request) as Promise<boolean>,

    matchSubmissionJournals: async (request: { projectId: string; caseId?: string; query: string; outcomeId?: string; criteria: import('../../engine/submission/SubmissionRuntimeContract.js').TargetingCriteria }) =>
      ipcRenderer.invoke('submission:matchJournals', request) as Promise<{
        ok: true; candidates: Array<{ name: string; issn: string | null; verifiedTiers: string[]; tierStatus: 'verified' | 'unknown'; recentPaperCount: number; latestYear: number; evidence: Array<{ title: string; year: number; doi?: string; source: string }>; meetsCriteria: boolean | null; criteriaNote: string; score: number }>; warnings: string[]; disclaimer: string;
      } | { ok: false; code: string; candidates: never[]; warnings: never[] } | null>,

    checkActiveSubmission: async (request: { projectId: string; sourceOutcomeId: string }) =>
      ipcRenderer.invoke('submission:checkActive', request) as Promise<import('../../engine/submission/SubmissionRuntimeContract.js').SubmissionCase | null>,
    // ── Submission P1（期刊档案 / 投稿要求 / 语料 / 范式 / 差距诊断 / 优化方案）──

    // ── Submission P1（期刊档案 / 投稿要求 / 语料 / 范式 / 差距诊断 / 优化方案）──
    identifySubmissionJournal: async (request: { projectId: string; caseId?: string; name?: string; issn?: string }) =>
      ipcRenderer.invoke('submission:journal:identify', request) as Promise<{ ok: true; profile: import('../../engine/submission/JournalProfileContract.js').JournalProfile } | { ok: false; code: string; message: string } | null>,

    fetchSubmissionJournalGuidelines: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:journal:fetchGuidelines', request) as Promise<{ ok: true; snapshot: import('../../engine/submission/JournalProfileContract.js').JournalProfileSnapshot; requirements: import('../../engine/submission/JournalProfileContract.js').JournalRequirement[]; sources: Array<{ url: string; title: string }>; extraction: 'llm' | 'deterministic' } | { ok: false; code: string; message: string } | null>,

    getSubmissionJournalProfile: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:journal:profile', request) as Promise<{
        profile: import('../../engine/submission/JournalProfileContract.js').JournalProfile;
        snapshot: import('../../engine/submission/JournalProfileContract.js').JournalProfileSnapshot | null;
        requirements: import('../../engine/submission/JournalProfileContract.js').JournalRequirement[] | null;
        observations: import('../../engine/submission/JournalProfileContract.js').JournalPatternObservation[] | null;
        corpus: import('../../engine/submission/JournalProfileContract.js').JournalCorpusItem[];
      } | null>,

    buildSubmissionJournalCorpus: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:journal:buildCorpus', request) as Promise<{ ok: true; items: import('../../engine/submission/JournalProfileContract.js').JournalCorpusItem[] } | { ok: false; code: string; message: string } | null>,

    analyzeSubmissionJournalPatterns: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:journal:analyzePatterns', request) as Promise<{ ok: true; observations: import('../../engine/submission/JournalProfileContract.js').JournalPatternObservation[]; corpusSize: number } | { ok: false; code: string; message: string } | null>,

    diffSubmissionJournalSnapshots: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:journal:diffSnapshots', request) as Promise<{ added: import('../../engine/submission/JournalProfileContract.js').JournalRequirement[]; removed: import('../../engine/submission/JournalProfileContract.js').JournalRequirement[]; changed: Array<{ ruleKey: string; before: string; after: string }> } | null>,

    diagnoseSubmissionCase: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:diagnose', request) as Promise<{ ok: true; items: import('../../engine/submission/JournalProfileContract.js').SubmissionGapItem[] } | { ok: false; code: string } | null>,

    createSubmissionOptimizationPlan: async (request: { projectId: string; caseId: string; gapItemIds?: string[] }) =>
      ipcRenderer.invoke('submission:plan:create', request) as Promise<{ ok: true; plan: import('../../engine/submission/JournalProfileContract.js').SubmissionOptimizationPlan; items: import('../../engine/submission/JournalProfileContract.js').SubmissionOptimizationItem[] } | { ok: false; code: string } | null>,

    getSubmissionOptimizationPlan: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:plan:latest', request) as Promise<{
        plan: import('../../engine/submission/JournalProfileContract.js').SubmissionOptimizationPlan;
        items: import('../../engine/submission/JournalProfileContract.js').SubmissionOptimizationItem[];
      } | null>,

    approveSubmissionOptimizationPlan: async (request: { projectId: string; planId: string; selectedItemIds?: string[] }) =>
      ipcRenderer.invoke('submission:plan:approve', request) as Promise<{ ok: true; plan: import('../../engine/submission/JournalProfileContract.js').SubmissionOptimizationPlan; items: import('../../engine/submission/JournalProfileContract.js').SubmissionOptimizationItem[] } | { ok: false; code: string } | null>,

    applySubmissionOptimizationPlan: async (request: { projectId: string; planId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:plan:apply', request) as Promise<{ ok: true; plan: import('../../engine/submission/JournalProfileContract.js').SubmissionOptimizationPlan; results: Array<{ itemId: string; title: string; status: 'applied' | 'skipped' | 'failed'; outcomeVersion: number | null; note: string }> } | { ok: false; code: string } | null>,

    verifySubmissionOptimizationPlan: async (request: { projectId: string; planId: string }) =>
      ipcRenderer.invoke('submission:plan:verify', request) as Promise<{ ok: true; verified: boolean; residualMustFix: unknown[]; plan: import('../../engine/submission/JournalProfileContract.js').SubmissionOptimizationPlan } | { ok: false; code: string } | null>,

    updateSubmissionGapItem: async (request: { projectId: string; caseId: string; itemId: string; patch: { status: import('../../engine/submission/JournalProfileContract.js').SubmissionGapStatus } }) =>
      ipcRenderer.invoke('submission:gap:update', request) as Promise<import('../../engine/submission/JournalProfileContract.js').SubmissionGapItem | null>,
    // ── Submission P4（Decision Letter 拆解 / 返修 / Response Letter）──

    // ── Submission P4（Decision Letter 拆解 / 返修 / Response Letter）──
    createSubmissionReviewRound: async (request: { projectId: string; caseId: string; decisionLetterText: string; deadline?: number | null }) =>
      ipcRenderer.invoke('submission:review:createRound', request) as Promise<{ ok: true; roundId: string; parsed: { decision: string; deadline: number | null; reviewerComments: unknown[]; editorComments: unknown[] } } | { ok: false; code: string } | null>,

    listSubmissionReviewRounds: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:review:list', request) as Promise<Array<import('../../engine/submission/SubmissionReviewContract.js').ReviewRound & { comments: import('../../engine/submission/SubmissionReviewContract.js').ReviewerComment[] }>>,

    updateSubmissionReviewComment: async (request: { projectId: string; commentId: string; patch: import('../../engine/submission/SubmissionReviewContract.js').ReviewCommentPatch }) =>
      ipcRenderer.invoke('submission:review:updateComment', request) as Promise<import('../../engine/submission/SubmissionReviewContract.js').ReviewerComment | null>,

    beginSubmissionRevision: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:review:beginRevision', request) as Promise<{ ok: true } | { ok: false; code: string } | null>,

    generateSubmissionResponseLetter: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:review:generateResponse', request) as Promise<{ ok: true; outcomeId: string; version: number; unresolvedCount: number } | { ok: false; code: string } | null>,
    // ── Submission P3（最终提交：Human Approval 门控 + 回执）──

    // ── Submission P3（最终提交：Human Approval 门控 + 回执）──
    confirmFinalSubmission: async (request: { projectId: string; caseId: string; submissionMethod: 'portal_web' | 'email' | 'offline_manual'; portalUrl?: string; remoteSubmissionId?: string; notes?: string; confirmed: true }) =>
      ipcRenderer.invoke('submission:submit', request) as Promise<{ ok: true; submissionCase: import('../../engine/submission/SubmissionRuntimeContract.js').SubmissionCase } | { ok: false; code: 'approval_required' | 'preflight_not_passed' | 'package_not_frozen' | 'case_not_found' | 'illegal_transition' | 'illegal_status' } | null>,
    // ── Submission P2（投稿预检 / 投稿包 / Cover Letter）──

    // ── Submission P2（投稿预检 / 投稿包 / Cover Letter）──
    runSubmissionPreflight: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:preflight:run', request) as Promise<{ ok: true; run: import('../../engine/submission/SubmissionPackageContract.js').SubmissionPreflightRun; checks: import('../../engine/submission/SubmissionPackageContract.js').SubmissionPreflightCheck[] } | { ok: false; code: string } | null>,

    getSubmissionPreflight: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:preflight:latest', request) as Promise<{
        run: import('../../engine/submission/SubmissionPackageContract.js').SubmissionPreflightRun;
        checks: import('../../engine/submission/SubmissionPackageContract.js').SubmissionPreflightCheck[];
      } | null>,

    assembleSubmissionPackage: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:package:assemble', request) as Promise<{ ok: true; package: import('../../engine/submission/SubmissionPackageContract.js').SubmissionPackage; files: import('../../engine/submission/SubmissionPackageContract.js').SubmissionPackageFile[] } | { ok: false; code: string } | null>,

    getSubmissionPackage: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:package:latest', request) as Promise<{
        package: import('../../engine/submission/SubmissionPackageContract.js').SubmissionPackage;
        files: import('../../engine/submission/SubmissionPackageContract.js').SubmissionPackageFile[];
      } | null>,

    attachSubmissionPackageOutcome: async (request: { projectId: string; packageId: string; outcomeId: string; type: import('../../engine/submission/SubmissionPackageContract.js').SubmissionPackageFileType; required?: boolean; note?: string }) =>
      ipcRenderer.invoke('submission:package:attachOutcome', request) as Promise<{ ok: true; file: import('../../engine/submission/SubmissionPackageContract.js').SubmissionPackageFile } | { ok: false; code: string } | null>,

    attachSubmissionPackageFile: async (request: { projectId: string; packageId: string; type: import('../../engine/submission/SubmissionPackageContract.js').SubmissionPackageFileType; filePath: string; required?: boolean }) =>
      ipcRenderer.invoke('submission:package:attachFile', request) as Promise<{ ok: true; file: import('../../engine/submission/SubmissionPackageContract.js').SubmissionPackageFile } | { ok: false; code: string } | null>,

    removeSubmissionPackageFile: async (request: { projectId: string; packageId: string; fileId: string }) =>
      ipcRenderer.invoke('submission:package:removeFile', request) as Promise<boolean>,

    exportSubmissionPackage: async (request: { projectId: string; packageId: string }) =>
      ipcRenderer.invoke('submission:package:export', request) as Promise<{ ok: true; dir: string; exported: Array<{ fileId: string; path: string; format: 'docx' | 'markdown' | 'copy' }>; failures: Array<{ fileId: string; code: string; message: string }> } | { ok: false; code: string } | null>,

    freezeSubmissionPackage: async (request: { projectId: string; packageId: string }) =>
      ipcRenderer.invoke('submission:package:freeze', request) as Promise<{ ok: true; package: import('../../engine/submission/SubmissionPackageContract.js').SubmissionPackage } | { ok: false; code: string; blockers?: import('../../engine/submission/SubmissionPackageContract.js').SubmissionPreflightCheck[] } | null>,

    validateSubmissionPackage: async (request: { projectId: string; packageId: string }) =>
      ipcRenderer.invoke('submission:package:validate', request) as Promise<{ ok: true; results: Array<{ fileId: string; type: import('../../engine/submission/SubmissionPackageContract.js').SubmissionPackageFileType; status: import('../../engine/submission/SubmissionPackageContract.js').SubmissionPackageFileValidationStatus; reason: string }>; summary: { valid: number; invalid: number; needsConfirmation: number; pending: number } } | { ok: false; code: string } | null>,

    generateSubmissionCoverLetter: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:coverLetter:generate', request) as Promise<{ ok: true; outcomeId: string; version: number; needsConfirmation: string[]; extraction: 'llm' | 'template' } | { ok: false; code: string } | null>,
    // ── Submission P3/P4（投稿通信：SMTP 外发 + IMAP 监听 + 关联确认）──

    // ── Submission P3/P4（投稿通信：SMTP 外发 + IMAP 监听 + 关联确认）──
    listSubmissionMailAccounts: async () =>
      ipcRenderer.invoke('submission:mail:accounts') as Promise<Array<{ id: string; label: string; user: string; host: string; createdAt: number; lastCheckedAt: number | null; lastOkAt: number | null }>>,

    syncSubmissionMail: async (request: { projectId: string; accountId: string; limit?: number }) =>
      ipcRenderer.invoke('submission:mail:sync', request) as Promise<{ ok: true; fetched: number; recorded: number; duplicates: number; pending: number } | { ok: false; code: string; message: string } | null>,

    listSubmissionCorrespondence: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:correspondence:listByCase', request) as Promise<import('../../engine/submission/SubmissionCorrespondenceContract.js').SubmissionCorrespondence[]>,

    listPendingSubmissionCorrespondence: async (request: { projectId: string }) =>
      ipcRenderer.invoke('submission:correspondence:listPending', request) as Promise<import('../../engine/submission/SubmissionCorrespondenceContract.js').SubmissionCorrespondence[]>,

    confirmSubmissionCorrespondenceMatch: async (request: { projectId: string; id: string; caseId?: string }) =>
      ipcRenderer.invoke('submission:correspondence:confirmMatch', request) as Promise<{ ok: true; record: import('../../engine/submission/SubmissionCorrespondenceContract.js').SubmissionCorrespondence } | { ok: false; code: string } | null>,

    rejectSubmissionCorrespondenceMatch: async (request: { projectId: string; id: string }) =>
      ipcRenderer.invoke('submission:correspondence:rejectMatch', request) as Promise<{ ok: true; record: import('../../engine/submission/SubmissionCorrespondenceContract.js').SubmissionCorrespondence } | { ok: false; code: string } | null>,

    createSubmissionRoundFromCorrespondence: async (request: { projectId: string; id: string }) =>
      ipcRenderer.invoke('submission:correspondence:createRound', request) as Promise<{ ok: true; roundId: string } | { ok: false; code: string; message?: string } | null>,
    // 返修截止日期同步到任务板（Goal）。

    // 返修截止日期同步到任务板（Goal）。
    syncSubmissionDeadlineToGoal: async (request: { projectId: string; caseId: string; roundId: string }) =>
      ipcRenderer.invoke('submission:review:syncDeadline', request) as Promise<{ ok: true; goalId: string } | { ok: false; code: string } | null>,
    // 后台邮件监听推送（新编辑来信，含决定信类高亮信息）。

    // ── Submission P3（投稿门户：Browser-assisted Submission）──
    openSubmissionPortal: async (request: { projectId: string; caseId: string; portalUrl?: string }) =>
      ipcRenderer.invoke('submission:portal:open', request) as Promise<{ ok: true; session: import('../../engine/submission/SubmissionPortalContract.js').PortalSession } | { ok: false; code: string; message: string } | null>,

    planSubmissionPortalFill: async (request: { projectId: string; caseId: string }) =>
      ipcRenderer.invoke('submission:portal:planFill', request) as Promise<{ ok: true; actions: import('../../engine/submission/SubmissionPortalContract.js').PortalFieldAction[] } | { ok: false; code: string; message: string } | null>,

    executeSubmissionPortalSteps: async (request: { projectId: string; caseId: string; actions: import('../../engine/submission/SubmissionPortalContract.js').PortalFieldAction[]; confirmed?: boolean }) =>
      ipcRenderer.invoke('submission:portal:execute', request) as Promise<{ ok: true; results: Array<{ fieldKey: string; status: 'done' | 'skipped'; detail: string }> } | { ok: false; code: string; message: string } | null>,

    confirmSubmissionPortalSubmitted: async (request: { projectId: string; caseId: string; remoteSubmissionId?: string; receiptNote?: string }) =>
      ipcRenderer.invoke('submission:portal:confirmSubmitted', request) as Promise<{ ok: true; case: import('../../engine/submission/SubmissionRuntimeContract.js').SubmissionCase } | { ok: false; code: string; message: string } | null>,

    markSubmissionPortalUncertain: async (request: { projectId: string; caseId: string; reason: string }) =>
      ipcRenderer.invoke('submission:portal:markUncertain', request) as Promise<{ ok: true } | { ok: false; code: string; message: string } | null>,
    // ── Literature watch (T25) ──

    // 投稿参谋（2026-09-01 刘总规格）：共享浏览器+成果上下文的编排对话。
    // ---- 投稿 Browser Workspace(2026-09-05,任务6)----
    submissionShortlistList: async (projectId: string) => (
      ipcRenderer.invoke('submission:shortlist:list', { projectId }) as Promise<Array<{ id: string; name: string; source: string; url: string; note: string; created_at: number }>>
    ),

    submissionShortlistAdd: async (request: { projectId: string; name: string; source?: string; url?: string; note?: string }) => (
      ipcRenderer.invoke('submission:shortlist:add', request) as Promise<{ ok: boolean }>
    ),

    submissionShortlistRemove: async (request: { projectId: string; name: string }) => (
      ipcRenderer.invoke('submission:shortlist:remove', request) as Promise<{ ok: boolean }>
    ),

    submissionAssistantChat: async (request: { projectId: string; outcomeId: string; instruction: string; thinkingLevel?: string; intent?: Record<string, unknown>; shortlist?: Array<{ name: string; source?: string }>; history?: Array<{ role: 'user' | 'assistant'; content: string }> }) =>
      ipcRenderer.invoke('submission:assistant:chat', request) as Promise<{ ok: boolean; answer?: string; error?: string }>,
    // 申报书面板「生成填写草稿」（2026-09-01）：已分析模板结构+素材→逐栏草稿 Markdown。
};
