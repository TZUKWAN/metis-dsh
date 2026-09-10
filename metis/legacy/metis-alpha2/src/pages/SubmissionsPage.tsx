/**
 * SubmissionsPage — 投稿驾驶舱（P0）。
 *
 * 三区：左栏投稿事务列表（按项目过滤 + 搜索 + 状态过滤）；
 * 中栏当前 Submission Case 详情（生命周期阶段、成果链接、状态推进、Timeline）；
 * 新建投稿弹窗（从成果出发：匹配期刊 / 指定期刊）。
 * 所有数据来自 submission:* IPC（SQLite 持久化），状态变更走持久状态机。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../i18n';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import {
  SUBMISSION_STATUS_TRANSITIONS,
  SUBMISSION_VENUE_CATEGORIES,
  submissionLifecycleStage,
  type SubmissionCase,
  type SubmissionStatus,
  type SubmissionVenueCategory,
  type TargetingCriteria,
} from '../../engine/submission/SubmissionRuntimeContract.js';
import type { JournalCandidate } from '../../engine/submission/JournalTargeting.js';
import type {
  JournalCorpusItem,
  JournalPatternObservation,
  JournalProfile,
  JournalProfileSnapshot,
  JournalRequirement,
  SubmissionGapItem,
  SubmissionOptimizationItem,
  SubmissionOptimizationPlan,
} from '../../engine/submission/JournalProfileContract.js';
import {
  SUBMISSION_PACKAGE_FILE_TYPES,
  type SubmissionPackage,
  type SubmissionPackageFile,
  type SubmissionPackageFileType,
  type SubmissionPreflightCheck,
  type SubmissionPreflightRun,
} from '../../engine/submission/SubmissionPackageContract.js';
import type { ReviewRound, ReviewerComment } from '../../engine/submission/SubmissionReviewContract.js';
import type { SubmissionCorrespondence } from '../../engine/submission/SubmissionCorrespondenceContract.js';
import {
  isPortalActionAutomatable,
  type PortalFieldAction,
  type PortalSession,
} from '../../engine/submission/SubmissionPortalContract.js';
import './SubmissionsPage.css';

/**
 * P1 期刊研究 preload API 的渲染端视图。
 * 由 electron/preload.ts 提供；window.metis 的权威类型来自 preload 导出，
 * 此处以结构化方式声明签名，preload 落地前后均可通过类型检查。
 */
interface SubmissionJournalApi {
  identifySubmissionJournal?: (args: { projectId: string; caseId?: string; name?: string; issn?: string }) =>
    Promise<{ ok: true; profile: JournalProfile } | { ok: false; code: string }>;
  fetchSubmissionJournalGuidelines?: (args: { projectId: string; caseId: string }) =>
    Promise<{ ok: true; snapshot: JournalProfileSnapshot; requirements: JournalRequirement[]; extraction: 'llm' | 'deterministic' } | { ok: false; code: string }>;
  getSubmissionJournalProfile?: (args: { projectId: string; caseId: string }) =>
    Promise<{
      profile: JournalProfile | null; snapshot: JournalProfileSnapshot | null;
      requirements: JournalRequirement[] | null; observations: JournalPatternObservation[] | null; corpus: JournalCorpusItem[] | null;
    } | null>;
  buildSubmissionJournalCorpus?: (args: { projectId: string; caseId: string }) =>
    Promise<{ ok: true; items: JournalCorpusItem[] } | { ok: false; code: string }>;
  analyzeSubmissionJournalPatterns?: (args: { projectId: string; caseId: string }) =>
    Promise<{ ok: true; observations: JournalPatternObservation[] } | { ok: false; code: string }>;
  diffSubmissionJournalSnapshots?: (args: { projectId: string; caseId: string }) =>
    Promise<{
      added: JournalRequirement[]; removed: JournalRequirement[];
      changed: Array<{ ruleKey: string; before: JournalRequirement | null; after: JournalRequirement | null }>;
    } | null>;
  diagnoseSubmissionCase?: (args: { projectId: string; caseId: string }) =>
    Promise<{ ok: true; items: SubmissionGapItem[] } | { ok: false; code: string }>;
  createSubmissionOptimizationPlan?: (args: { projectId: string; caseId: string; gapItemIds?: string[] }) =>
    Promise<{ ok: true; plan: SubmissionOptimizationPlan; items: SubmissionOptimizationItem[] } | { ok: false; code: string }>;
  getSubmissionOptimizationPlan?: (args: { projectId: string; caseId: string }) =>
    Promise<{ plan: SubmissionOptimizationPlan; items: SubmissionOptimizationItem[] } | null>;
  approveSubmissionOptimizationPlan?: (args: { projectId: string; planId: string; selectedItemIds?: string[] }) =>
    Promise<{ ok: true } | { ok: false; code: string }>;
  applySubmissionOptimizationPlan?: (args: { projectId: string; planId: string; caseId: string }) =>
    Promise<{ ok: true } | { ok: false; code: string }>;
  verifySubmissionOptimizationPlan?: (args: { projectId: string; planId: string }) =>
    Promise<{ ok: true; passed?: boolean; remaining?: SubmissionGapItem[] } | { ok: false; code: string }>;
  updateSubmissionGapItem?: (args: { projectId: string; caseId: string; itemId: string; patch: { status: string } }) =>
    Promise<{ ok: true } | { ok: false; code: string } | null>;
  runSubmissionPreflight?: (args: { projectId: string; caseId: string }) =>
    Promise<{ ok: true; run: SubmissionPreflightRun; checks: SubmissionPreflightCheck[] } | { ok: false; code: string }>;
  getSubmissionPreflight?: (args: { projectId: string; caseId: string }) =>
    Promise<{ run: SubmissionPreflightRun; checks: SubmissionPreflightCheck[] } | null>;
  assembleSubmissionPackage?: (args: { projectId: string; caseId: string }) =>
    Promise<{ ok: true; package: SubmissionPackage; files: SubmissionPackageFile[] } | { ok: false; code: string }>;
  getSubmissionPackage?: (args: { projectId: string; caseId: string }) =>
    Promise<{ package: SubmissionPackage; files: SubmissionPackageFile[] } | null>;
  attachSubmissionPackageOutcome?: (args: { projectId: string; packageId: string; outcomeId: string; type: SubmissionPackageFileType; required?: boolean; note?: string }) =>
    Promise<{ ok: true; file: SubmissionPackageFile } | { ok: false; code: string } | null>;
  removeSubmissionPackageFile?: (args: { projectId: string; packageId: string; fileId: string }) => Promise<boolean>;
  exportSubmissionPackage?: (args: { projectId: string; packageId: string }) =>
    Promise<{ ok: true; dir: string; exported: Array<{ fileId: string; path: string; format: 'docx' | 'markdown' | 'copy' }>; failures: Array<{ fileId: string; code: string; message: string }> } | { ok: false; code: string } | null>;
  freezeSubmissionPackage?: (args: { projectId: string; packageId: string }) =>
    Promise<{ ok: true; package: SubmissionPackage } | { ok: false; code: string; blockers?: SubmissionPreflightCheck[] } | null>;
  validateSubmissionPackage?: (args: { projectId: string; packageId: string }) =>
    Promise<{ ok: true; results: Array<{ fileId: string; validationStatus: string }> } | { ok: false; code: string } | null>;
  generateSubmissionCoverLetter?: (args: { projectId: string; caseId: string }) =>
    Promise<{ ok: true; outcomeId: string; version: number; needsConfirmation: string[]; extraction: 'llm' | 'template' } | { ok: false; code: string }>;
  createSubmissionReviewRound?: (args: { projectId: string; caseId: string; decisionLetterText: string }) =>
    Promise<{ ok: true; roundId: string; parsed: { decision: string; deadline: number | null; reviewerComments: unknown[]; editorComments: unknown[] } } | { ok: false; code: string }>;
  listSubmissionReviewRounds?: (args: { projectId: string; caseId: string }) =>
    Promise<Array<ReviewRound & { comments: ReviewerComment[] }>>;
  updateSubmissionReviewComment?: (args: { projectId: string; commentId: string; patch: { status?: string; responseText?: string } }) =>
    Promise<ReviewerComment | null>;
  beginSubmissionRevision?: (args: { projectId: string; caseId: string }) =>
    Promise<{ ok: true } | { ok: false; code: string }>;
  generateSubmissionResponseLetter?: (args: { projectId: string; caseId: string }) =>
    Promise<{ ok: true; outcomeId: string; version: number; unresolvedCount: number } | { ok: false; code: string }>;
  confirmFinalSubmission?: (args: {
    projectId: string; caseId: string;
    submissionMethod: 'portal_web' | 'email' | 'offline_manual';
    portalUrl?: string; remoteSubmissionId?: string; notes?: string; confirmed: true;
  }) => Promise<{ ok: true; submissionCase: SubmissionCase } | { ok: false; code: string } | null>;
}

function journalApi(): SubmissionJournalApi | undefined {
  return window.metis as unknown as SubmissionJournalApi | undefined;
}

interface OutcomeSummaryLite { id: string; title: string; kind: string; currentVersion: number }

const STAGE_ORDER = ['targeting', 'profiling', 'diagnosis', 'optimization', 'precheck', 'materials', 'submitting', 'tracking', 'revision', 'accepted'] as const;

export default function SubmissionsPage({ onNavigateToOutcomes }: { onNavigateToOutcomes?: () => void } = {}) {
  const { t, locale } = useTranslation();
  const projectId = useResearchWorkspaceStore((s) => s.activeProjectId);
  const [cases, setCases] = useState<SubmissionCase[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<Array<{ id: string; type: string; description: string; source: string; createdAt: number }>>([]);
  const [filter, setFilter] = useState<'all' | 'active' | 'closed'>('active');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  // CASE C 换刊：从被拒 Case 一键进入选刊流程（沿用同一 Submission Series）。
  const [createIntent, setCreateIntent] = useState<{ mode: 'match' | 'specify'; seriesId: string | null }>({ mode: 'specify', seriesId: null });
  const [matchState, setMatchState] = useState<{ caseId: string; status: 'idle' | 'loading' | 'done' | 'failed'; candidates: JournalCandidate[]; disclaimer: string }>({ caseId: '', status: 'idle', candidates: [], disclaimer: '' });

  const selected = useMemo(() => cases.find((item) => item.id === selectedId) ?? null, [cases, selectedId]);

  const loadCases = useCallback(async () => {
    const rows = projectId && window.metis?.listSubmissionCases
      ? await window.metis.listSubmissionCases({ projectId, query, includeClosed: filter !== 'active' })
      : [];
    setCases(rows);
    setSelectedId((current) => (rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null));
  }, [projectId, filter, query]);

  const loadEvents = useCallback(async () => {
    const rows = projectId && selectedId && window.metis?.listSubmissionEvents
      ? await window.metis.listSubmissionEvents({ projectId, caseId: selectedId })
      : [];
    setEvents(rows);
  }, [projectId, selectedId]);

  const refresh = useCallback(async () => { await loadCases(); await loadEvents(); }, [loadCases, loadEvents]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const rows = projectId && window.metis?.listSubmissionCases
        ? await window.metis.listSubmissionCases({ projectId, query, includeClosed: filter !== 'active' })
        : [];
      if (!alive) return;
      setCases(rows);
      setSelectedId((current) => (rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null));
    })();
    return () => { alive = false; };
  }, [projectId, filter, query]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const rows = projectId && selectedId && window.metis?.listSubmissionEvents
        ? await window.metis.listSubmissionEvents({ projectId, caseId: selectedId })
        : [];
      if (alive) setEvents(rows);
    })();
    return () => { alive = false; };
  }, [projectId, selectedId]);

  // 后台邮件监听推送：新编辑来信到达时刷新列表与事件（决定信类由通知里带分类）。
  useEffect(() => {
    const unsubscribe = window.metis?.onSubmissionMailChanged?.(() => {
      setNotice(t('submissionHub.mailWatcherArrived'));
      void refresh();
    });
    return () => { unsubscribe?.(); };
    // refresh 随 projectId/filter/query 变化重建，订阅保持不变（闭包经 refresh ref 更新）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  // 备注/下一状态草稿按选中 Case 派生（渲染期调整，避免同步 setState effect）。
  const [notesDraftState, setNotesDraftState] = useState<{ id: string; value: string }>({ id: '', value: '' });
  const [nextStatusState, setNextStatusState] = useState<{ id: string; value: string }>({ id: '', value: '' });
  const notesDraft = selected && notesDraftState.id === selected.id ? notesDraftState.value : selected?.notes ?? '';
  const nextStatus = selected && nextStatusState.id === selected.id ? nextStatusState.value : '';

  async function advanceStatus(): Promise<void> {
    if (!projectId || !selected || !nextStatus || !window.metis?.changeSubmissionStatus) return;
    const result = await window.metis.changeSubmissionStatus({
      projectId,
      change: { caseId: selected.id, to: nextStatus, reason: '', source: 'human' },
    });
    if (result && 'ok' in result && result.ok === false && result.code === 'illegal_transition') {
      setNotice(t('submissionHub.illegalTransition'));
      return;
    }
    setNextStatusState({ id: '', value: '' });
    await refresh();
  }

  async function saveNotes(): Promise<void> {
    if (!projectId || !selected || !window.metis?.updateSubmissionCase) return;
    const updated = await window.metis.updateSubmissionCase({ projectId, patch: { caseId: selected.id, notes: notesDraft } });
    if (updated) { setNotice(t('submissionHub.updated')); await loadCases(); }
  }

  async function runMatch(): Promise<void> {
    if (!projectId || !selected || !window.metis?.matchSubmissionJournals) return;
    const criteria = selected.targetingCriteria ?? { categories: ['en_general' as SubmissionVenueCategory], language: 'any' as const, notes: '' };
    setMatchState({ caseId: selected.id, status: 'loading', candidates: [], disclaimer: '' });
    const result = await window.metis.matchSubmissionJournals({
      projectId,
      caseId: selected.id,
      query: selected.title,
      // 匹配查询词改为从源成果正文提取（标题常是工作流名，不是论文主题）
      outcomeId: selected.sourceOutcomeId ?? undefined,
      criteria,
    });
    if (!result || result.ok === false) {
      setMatchState({ caseId: selected.id, status: 'failed', candidates: [], disclaimer: '' });
      return;
    }
    setMatchState({ caseId: selected.id, status: 'done', candidates: result.candidates, disclaimer: result.disclaimer });
    await loadEvents();
  }

  async function selectJournal(candidateName: string): Promise<void> {
    if (!projectId || !selected || !window.metis?.updateSubmissionCase || !window.metis?.changeSubmissionStatus) return;
    const updated = await window.metis.updateSubmissionCase({ projectId, patch: { caseId: selected.id, targetJournalName: candidateName } });
    if (!updated) return;
    setNotice(t('submissionHub.selectedJournal'));
    if (selected.status === 'TARGETING') {
      const changed = await window.metis.changeSubmissionStatus({ projectId, change: { caseId: selected.id, to: 'JOURNAL_SELECTED', reason: `选定期刊：${candidateName}`, source: 'human' } });
      if (changed && 'ok' in changed && changed.ok === false) setNotice(t('submissionHub.illegalTransition'));
    }
    await refresh();
  }

  const stage = selected ? submissionLifecycleStage(selected.status as SubmissionStatus) : null;
  const stageIndex = stage && stage !== 'closed' ? STAGE_ORDER.indexOf(stage) : -1;
  const stageLabels = t('submissionHub.stages').split('|');
  const allowedNext = selected ? SUBMISSION_STATUS_TRANSITIONS[selected.status as SubmissionStatus] ?? [] : [];
  // 期刊研究区：已选期刊（JOURNAL_SELECTED，profiling 阶段）及之后各阶段均可展开查看。
  const showJournalResearch = Boolean(selected && stage && stage !== 'targeting' && stage !== 'closed');
  const showPackageSection = Boolean(selected && stage && ['precheck', 'materials', 'submitting', 'tracking', 'revision', 'accepted'].includes(stage));
  // 投稿通信（邮件）：材料准备起至录用全程可见。
  const showMailSection = Boolean(selected && stage && ['materials', 'submitting', 'tracking', 'revision', 'accepted'].includes(stage));
  // 投稿门户（半自动填单）：仅投稿执行窗口期可见。
  const showPortalSection = Boolean(selected && stage && ['materials', 'submitting', 'tracking'].includes(stage));

  return (
    <div className="submissions-page" role="region" aria-label={t('submissionHub.title')}>
      <aside className="submissions-list" aria-label={t('submissionHub.listTitle')}>
        <header className="submissions-list__header">
          <h2>{t('submissionHub.title')}</h2>
          <button type="button" className="submissions-new" data-testid="submissions-new" onClick={() => setCreateOpen(true)}>{t('submissionHub.newCase')}</button>
        </header>
        <div className="submissions-list__filters">
          <div className="submissions-filter" role="tablist">
            {(['active', 'all', 'closed'] as const).map((mode) => (
              <button key={mode} type="button" role="tab" aria-selected={filter === mode}
                className={filter === mode ? 'active' : ''}
                onClick={() => setFilter(mode)}>{t(`submissionHub.filter${mode === 'active' ? 'Active' : mode === 'all' ? 'All' : 'Closed'}`)}</button>
            ))}
          </div>
          <input className="submissions-search" value={query} placeholder={t('submissionHub.searchPlaceholder')}
            aria-label={t('submissionHub.searchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="submissions-list__scroll">
          {cases.length === 0 && <p className="submissions-empty">{t('submissionHub.empty')}</p>}
          {cases.map((item) => (
            <button key={item.id} type="button"
              className={`submissions-case-item ${item.id === selectedId ? 'selected' : ''}`}
              data-testid="submissions-case-item"
              onClick={() => setSelectedId(item.id)}>
              <strong>{item.title || t('submissionHub.noJournal')}</strong>
              <span>{item.targetJournalName || t('submissionHub.noJournal')}</span>
              <small>{t(`submissionHub.statusLabels.${item.status}`)} · {new Date(item.updatedAt).toLocaleString()}</small>
            </button>
          ))}
        </div>
      </aside>

      <section className="submissions-detail" aria-label={t('submissionHub.caseTitle')}>
        {!selected ? (
          <div className="submissions-empty-state"><p>{t('submissionHub.empty')}</p>
            {onNavigateToOutcomes && <button type="button" className="submissions-primary" onClick={onNavigateToOutcomes}>{t('nav.outcomes')}</button>}
          </div>
        ) : (
          <>
            {notice && <p className="submissions-notice" role="status">{notice}</p>}
            <header className="submissions-detail__head">
              <div>
                <h2>{selected.title || t('submissionHub.noJournal')}</h2>
                <p>{selected.targetJournalName || t('submissionHub.noJournal')} · {t(`submissionHub.statusLabels.${selected.status}`)}</p>
              </div>
            </header>

            <div className="submissions-stages" aria-label={t('submissionHub.stage')}>
              {STAGE_ORDER.map((name, index) => (
                <span key={name}
                  className={`submissions-stage ${stage === 'closed' ? '' : index <= stageIndex ? 'done' : ''} ${stage === name ? 'current' : ''}`}>
                  {stageLabels[index] ?? name}
                </span>
              ))}
              {stage === 'closed' && <span className="submissions-stage current">{t('submissionHub.stageClosed')}</span>}
            </div>

            <dl className="submissions-facts">
              <div><dt>{t('submissionHub.journal')}</dt><dd>{selected.targetJournalName || t('submissionHub.noJournal')}</dd></div>
              <div><dt>{t('submissionHub.status')}</dt><dd>{t(`submissionHub.statusLabels.${selected.status}`)}</dd></div>
              <div><dt>{t('submissionHub.sourceOutcome')}</dt><dd>{selected.sourceOutcomeId ? `${selected.sourceOutcomeId.slice(0, 18)}… v${selected.sourceOutcomeVersion ?? '?'}` : t('submissionHub.notSet')}</dd></div>
              <div><dt>{t('submissionHub.workingOutcome')}</dt><dd>{selected.workingOutcomeId ? `${selected.workingOutcomeId.slice(0, 18)}… v${selected.workingOutcomeVersion ?? '?'}` : t('submissionHub.notSet')}</dd></div>
              <div><dt>{t('submissionHub.submittedVersion')}</dt><dd>{selected.submittedOutcomeVersion ? `v${selected.submittedOutcomeVersion}` : t('submissionHub.notSet')}</dd></div>
              <div><dt>{t('submissionHub.createArticleType')}</dt><dd>{selected.articleType ? t(`submissionHub.articleTypes.${selected.articleType}`) : t('submissionHub.articleTypes.none')}</dd></div>
            </dl>

            {selected.status === 'TARGETING' && (
              <div className="submissions-targeting" data-testid="submissions-targeting">
                <h3>{t('submissionHub.targetingTitle')}</h3>
                <div className="submissions-criteria">
                  {(selected.targetingCriteria?.categories ?? []).map((category) => (
                    <span key={category} className="submissions-tier">{t(`submissionHub.venueCategories.${category}`)}</span>
                  ))}
                  {!selected.targetingCriteria && <span className="submissions-tier">{t('submissionHub.notSet')}</span>}
                </div>
                <button type="button" className="submissions-primary" disabled={matchState.caseId === selected.id && matchState.status === 'loading'}
                  onClick={() => void runMatch()}>
                  {matchState.caseId === selected.id && matchState.status === 'loading' ? t('submissionHub.matching') : t('submissionHub.startMatch')}
                </button>
                {matchState.caseId === selected.id && matchState.status === 'failed' && <p className="submissions-notice" role="alert">{t('submissionHub.matchFailed')}</p>}
                {matchState.caseId === selected.id && matchState.status === 'done' && (
                  <div className="submissions-candidates">
                    {matchState.disclaimer && <p className="submissions-disclaimer">{matchState.disclaimer}</p>}
                    {matchState.candidates.length === 0 && <p className="submissions-empty">{t('submissionHub.matchEmpty')}</p>}
                    {matchState.candidates.map((candidate) => (
                      <div key={candidate.name} className="submissions-candidate" data-testid="submissions-candidate">
                        <div className="submissions-candidate__head">
                          <strong>{candidate.name}</strong>
                          <span className={`submissions-tier ${candidate.meetsCriteria === true ? 'ok' : candidate.meetsCriteria === false ? 'bad' : ''}`}>
                            {candidate.meetsCriteria === true ? t('submissionHub.meetsYes') : candidate.meetsCriteria === false ? t('submissionHub.meetsNo') : t('submissionHub.meetsUnknown')}
                          </span>
                        </div>
                        <div className="submissions-candidate__tiers">
                          {candidate.verifiedTiers.length > 0
                            ? candidate.verifiedTiers.map((tier) => <span key={tier} className="submissions-tier ok">{tier}</span>)
                            : <span className="submissions-tier">{candidate.criteriaNote}</span>}
                        </div>
                        <div className="submissions-candidate__evidence">
                          <small>{t('submissionHub.recentPapers')} × {candidate.recentPaperCount}（{candidate.latestYear}）</small>
                          <ul>{candidate.evidence.map((item, index) => (
                            <li key={index}><span>{item.title}（{item.year}，{item.source}）</span></li>
                          ))}</ul>
                        </div>
                        <button type="button" className="submissions-secondary" onClick={() => void selectJournal(candidate.name)}>{t('submissionHub.selectJournal')}</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {showJournalResearch && projectId && selected && (
              <JournalResearchSection
                projectId={projectId}
                caseItem={selected}
                onRefresh={refresh}
              />
            )}

            {showPackageSection && projectId && selected && (
              <SubmissionPackageSection
                key={selected.id}
                projectId={projectId}
                caseItem={selected}
                onRefresh={refresh}
              />
            )}

            {showMailSection && projectId && selected && (
              <SubmissionCorrespondenceSection
                key={`mail-${selected.id}`}
                projectId={projectId}
                caseItem={selected}
                onRefresh={refresh}
              />
            )}

            {showPortalSection && projectId && selected && (
              <SubmissionPortalSection
                key={`portal-${selected.id}`}
                projectId={projectId}
                caseItem={selected}
                onRefresh={refresh}
              />
            )}

            {projectId && selected && stage === 'revision' && (
              <SubmissionRevisionSection
                key={`rev-${selected.id}`}
                projectId={projectId}
                caseItem={selected}
                onRefresh={refresh}
              />
            )}

            <div className="submissions-advance">
              <label>
                <span>{t('submissionHub.chooseNextStatus')}</span>
                <select value={nextStatus} aria-label={t('submissionHub.chooseNextStatus')}
                  onChange={(event) => setNextStatusState({ id: selected.id, value: event.target.value })}>
                  <option value="">—</option>
                  {allowedNext.filter((status) => status !== selected.status).map((status) => (
                    <option key={status} value={status}>{t(`submissionHub.statusLabels.${status}`)}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="submissions-primary" disabled={!nextStatus}
                onClick={() => void advanceStatus()}>{t('submissionHub.confirmAdvance')}</button>
            </div>

            <label className="submissions-notes">
              <span>{t('submissionHub.notes')}</span>
              <textarea value={notesDraft} rows={3} aria-label={t('submissionHub.notes')}
                onChange={(event) => setNotesDraftState({ id: selected.id, value: event.target.value })} />
            </label>
            <button type="button" className="submissions-secondary" onClick={() => void saveNotes()}>{t('submissionHub.saveNotes')}</button>

            {(selected.status === 'REJECTED' || selected.status === 'DESK_REJECTED') && (
              <div className="submissions-retarget">
                <p><small>{t('submissionHub.retargetHint')}</small></p>
                <button type="button" className="submissions-primary" data-testid="submissions-retarget"
                  onClick={() => { setCreateIntent({ mode: 'match', seriesId: selected.seriesId }); setCreateOpen(true); }}>
                  {t('submissionHub.retargetNewJournal')}
                </button>
              </div>
            )}

            <h3 className="submissions-events-title">{t('submissionHub.events')}</h3>            <ol className="submissions-timeline" aria-label={t('submissionHub.timeline')}>
              {events.length === 0 && <li className="submissions-empty">{t('submissionHub.noEvents')}</li>}
              {events.map((item) => (
                <li key={item.id}>
                  <span className="submissions-timeline__time">{new Date(item.createdAt).toLocaleString()}</span>
                  <span className="submissions-timeline__desc">{item.description || item.type}</span>
                  <span className="submissions-timeline__source">{item.source}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>

      {createOpen && (
        <CreateCaseDialog
          projectId={projectId}
          initialMode={createIntent.mode}
          seriesId={createIntent.seriesId}
          onClose={() => { setCreateOpen(false); setCreateIntent({ mode: 'specify', seriesId: null }); }}
          onCreated={async (caseId) => {
            setCreateOpen(false);
            setCreateIntent({ mode: 'specify', seriesId: null });
            setNotice(t('submissionHub.created'));
            await loadCases();
            setSelectedId(caseId);
          }}
        />
      )}
      <span className="submissions-locale" hidden>{locale}</span>
    </div>
  );
}

const VENUE_CATEGORY_KEYS: SubmissionVenueCategory[] = [...SUBMISSION_VENUE_CATEGORIES];

const GAP_SEVERITY_ORDER = ['must_fix', 'strongly_recommended', 'optional'] as const;

type BusyAction = '' | 'fetch' | 'diff' | 'corpus' | 'patterns' | 'diagnose' | 'plan' | 'apply' | 'verify';

interface SnapshotDiff {
  added: JournalRequirement[];
  removed: JournalRequirement[];
  changed: Array<{ ruleKey: string; before: JournalRequirement | null; after: JournalRequirement | null }>;
}

/**
 * 期刊研究区（P1）：期刊身份卡、官方投稿要求、规范更新检查、
 * 近期论文语料、写作范式观察，以及其后的稿件诊断与优化方案。
 * 官方要求（硬约束）与语料归纳的经验范式（软范式）在 UI 上严格分区、标注证据等级。
 */
function JournalResearchSection({ projectId, caseItem, onRefresh }: {
  projectId: string;
  caseItem: SubmissionCase;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [profile, setProfile] = useState<JournalProfile | null>(null);
  const [requirements, setRequirements] = useState<JournalRequirement[]>([]);
  const [observations, setObservations] = useState<JournalPatternObservation[]>([]);
  const [corpus, setCorpus] = useState<JournalCorpusItem[]>([]);
  const [gapItems, setGapItems] = useState<SubmissionGapItem[]>([]);
  const [plan, setPlan] = useState<SubmissionOptimizationPlan | null>(null);
  const [planItems, setPlanItems] = useState<SubmissionOptimizationItem[]>([]);
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<BusyAction>('');
  const [info, setInfo] = useState('');
  const [error, setError] = useState('');
  const [diff, setDiff] = useState<SnapshotDiff | null>(null);
  const [diffChecked, setDiffChecked] = useState(false);
  const [applySummary, setApplySummary] = useState<{ applied: number; skipped: number; failed: number } | null>(null);
  const [verifyMessage, setVerifyMessage] = useState('');

  const stage = submissionLifecycleStage(caseItem.status as SubmissionStatus);

  const errorText = useCallback((code: string): string => {
    const key = `submissionHub.journalErrors.${code}`;
    const value = t(key);
    return value === key ? t('submissionHub.journalActionFailed', { code }) : value;
  }, [t]);

  const loadAll = useCallback(async () => {
    const api = journalApi();
    if (!api) return;
    if (api.getSubmissionJournalProfile) {
      let data = await api.getSubmissionJournalProfile({ projectId, caseId: caseItem.id });
      if (!data && api.identifySubmissionJournal && caseItem.targetJournalName) {
        const identified = await api.identifySubmissionJournal({ projectId, caseId: caseItem.id, name: caseItem.targetJournalName });
        if (identified && 'ok' in identified && identified.ok) {
          data = await api.getSubmissionJournalProfile({ projectId, caseId: caseItem.id });
        }
      }
      if (data) {
        setProfile(data.profile ?? null);
        setRequirements(data.requirements ?? []);
        setObservations(data.observations ?? []);
        setCorpus(data.corpus ?? []);
      }
    }
    if (api.getSubmissionOptimizationPlan) {
      const planData = await api.getSubmissionOptimizationPlan({ projectId, caseId: caseItem.id });
      setPlan(planData?.plan ?? null);
      setPlanItems(planData?.items ?? []);
    }
  }, [projectId, caseItem.id, caseItem.targetJournalName]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const api = journalApi();
      if (!api) return;
      if (api.getSubmissionJournalProfile) {
        let data = await api.getSubmissionJournalProfile({ projectId, caseId: caseItem.id });
        if (!data && api.identifySubmissionJournal && caseItem.targetJournalName) {
          const identified = await api.identifySubmissionJournal({ projectId, caseId: caseItem.id, name: caseItem.targetJournalName });
          if (identified && 'ok' in identified && identified.ok) {
            data = await api.getSubmissionJournalProfile({ projectId, caseId: caseItem.id });
          }
        }
        if (!alive) return;
        if (data) {
          setProfile(data.profile ?? null);
          setRequirements(data.requirements ?? []);
          setObservations(data.observations ?? []);
          setCorpus(data.corpus ?? []);
        }
      }
      if (api.getSubmissionOptimizationPlan) {
        const planData = await api.getSubmissionOptimizationPlan({ projectId, caseId: caseItem.id });
        if (!alive) return;
        setPlan(planData?.plan ?? null);
        setPlanItems(planData?.items ?? []);
      }
    })();
    return () => { alive = false; };
  }, [projectId, caseItem.id, caseItem.targetJournalName]);

  const groupedRequirements = useMemo(() => {
    const map = new Map<string, JournalRequirement[]>();
    for (const requirement of requirements) {
      const list = map.get(requirement.ruleKey) ?? [];
      list.push(requirement);
      map.set(requirement.ruleKey, list);
    }
    return [...map.entries()];
  }, [requirements]);

  const visibleGapItems = useMemo(() => gapItems.filter((item) => item.status !== 'dismissed'), [gapItems]);
  const showDiagnosis = stage !== 'profiling' || gapItems.length > 0;

  async function fetchGuidelines(): Promise<void> {
    const api = journalApi();
    if (!api?.fetchSubmissionJournalGuidelines || busy) return;
    setBusy('fetch'); setError(''); setInfo('');
    const result = await api.fetchSubmissionJournalGuidelines({ projectId, caseId: caseItem.id });
    if (result && 'ok' in result && result.ok) {
      setRequirements(result.requirements);
      const extraction = result.extraction === 'llm' ? t('submissionHub.extractionLlm') : t('submissionHub.extractionDeterministic');
      setInfo(`${t('submissionHub.guidelinesFetched', { count: result.requirements.length })}（${extraction}）`);
      await loadAll();
    } else {
      setError(errorText(result && 'code' in result ? result.code : 'unknown'));
    }
    setBusy('');
  }

  async function checkUpdates(): Promise<void> {
    const api = journalApi();
    if (!api?.diffSubmissionJournalSnapshots || busy) return;
    setBusy('diff'); setError('');
    const result = await api.diffSubmissionJournalSnapshots({ projectId, caseId: caseItem.id });
    setDiff(result ?? null);
    setDiffChecked(true);
    setBusy('');
  }

  async function buildCorpus(): Promise<void> {
    const api = journalApi();
    if (!api?.buildSubmissionJournalCorpus || busy) return;
    setBusy('corpus'); setError('');
    const result = await api.buildSubmissionJournalCorpus({ projectId, caseId: caseItem.id });
    if (result && 'ok' in result && result.ok) setCorpus(result.items);
    else setError(errorText(result && 'code' in result ? result.code : 'unknown'));
    setBusy('');
  }

  async function analyzePatterns(): Promise<void> {
    const api = journalApi();
    if (!api?.analyzeSubmissionJournalPatterns || busy) return;
    setBusy('patterns'); setError('');
    const result = await api.analyzeSubmissionJournalPatterns({ projectId, caseId: caseItem.id });
    if (result && 'ok' in result && result.ok) setObservations(result.observations);
    else setError(errorText(result && 'code' in result ? result.code : 'unknown'));
    setBusy('');
  }

  async function runDiagnosis(): Promise<void> {
    const api = journalApi();
    if (!api?.diagnoseSubmissionCase || busy) return;
    setBusy('diagnose'); setError('');
    const result = await api.diagnoseSubmissionCase({ projectId, caseId: caseItem.id });
    if (result && 'ok' in result && result.ok) setGapItems(result.items);
    else setError(errorText(result && 'code' in result ? result.code : 'unknown'));
    setBusy('');
  }

  async function dismissGap(itemId: string): Promise<void> {
    const api = journalApi();
    if (!api?.updateSubmissionGapItem) return;
    await api.updateSubmissionGapItem({ projectId, caseId: caseItem.id, itemId, patch: { status: 'dismissed' } });
    setGapItems((current) => current.map((item) => (item.id === itemId ? { ...item, status: 'dismissed' } : item)));
  }

  async function createPlan(): Promise<void> {
    const api = journalApi();
    if (!api?.createSubmissionOptimizationPlan || busy) return;
    setBusy('plan'); setError('');
    const gapItemIds = visibleGapItems.map((item) => item.id);
    const result = await api.createSubmissionOptimizationPlan({ projectId, caseId: caseItem.id, ...(gapItemIds.length > 0 ? { gapItemIds } : {}) });
    if (result && 'ok' in result && result.ok) {
      setPlan(result.plan);
      setPlanItems(result.items);
      setSelectedItemIds([]);
    } else {
      setError(errorText(result && 'code' in result ? result.code : 'unknown'));
    }
    setBusy('');
  }

  async function approveAndApply(): Promise<void> {
    const api = journalApi();
    if (!api?.approveSubmissionOptimizationPlan || !api.applySubmissionOptimizationPlan || !plan || busy) return;
    setBusy('apply'); setError(''); setApplySummary(null); setVerifyMessage('');
    const approved = await api.approveSubmissionOptimizationPlan({ projectId, planId: plan.id, selectedItemIds });
    if (approved && 'ok' in approved && approved.ok === false) {
      setError(errorText(approved.code));
      setBusy('');
      return;
    }
    const applied = await api.applySubmissionOptimizationPlan({ projectId, planId: plan.id, caseId: caseItem.id });
    if (applied && 'ok' in applied && applied.ok === false) {
      setError(errorText(applied.code));
      setBusy('');
      return;
    }
    if (api.getSubmissionOptimizationPlan) {
      const planData = await api.getSubmissionOptimizationPlan({ projectId, caseId: caseItem.id });
      if (planData) {
        setPlan(planData.plan);
        setPlanItems(planData.items);
        setApplySummary({
          applied: planData.items.filter((item) => item.status === 'applied').length,
          skipped: planData.items.filter((item) => item.status === 'skipped').length,
          failed: planData.items.filter((item) => item.status === 'failed').length,
        });
      }
    }
    setBusy('');
  }

  async function reverify(): Promise<void> {
    const api = journalApi();
    if (!api?.verifySubmissionOptimizationPlan || !plan || busy) return;
    setBusy('verify'); setError(''); setVerifyMessage('');
    const result = await api.verifySubmissionOptimizationPlan({ projectId, planId: plan.id });
    if (result && 'ok' in result && result.ok) {
      const remaining = result.remaining ?? [];
      setVerifyMessage(result.passed === true || remaining.length === 0
        ? t('submissionHub.verifyPassed')
        : t('submissionHub.verifyRemaining', { count: remaining.length }));
    } else {
      setError(errorText(result && 'code' in result ? result.code : 'unknown'));
    }
    setBusy('');
  }

  async function quickAdvance(to: SubmissionStatus): Promise<void> {
    if (!window.metis?.changeSubmissionStatus || busy) return;
    const result = await window.metis.changeSubmissionStatus({
      projectId,
      change: { caseId: caseItem.id, to, reason: '', source: 'human' },
    });
    if (result && 'ok' in result && result.ok === false) {
      setError(t('submissionHub.illegalTransition'));
      return;
    }
    await onRefresh();
  }

  const diffChangeCount = diff ? diff.added.length + diff.removed.length + diff.changed.length : 0;
  const planApprovable = plan && (plan.status === 'draft' || plan.status === 'approved');
  const planApplied = plan && (plan.status === 'applied' || plan.status === 'verified');

  return (
    <div className="submissions-journal" data-testid="submissions-journal-research">
      <details open={stage === 'profiling'}>
        <summary><h3>{t('submissionHub.journalResearchTitle')}</h3></summary>

        {error && <p className="submissions-notice" role="alert">{error}</p>}
        {info && <p className="submissions-notice" role="status">{info}</p>}

        <dl className="submissions-facts" aria-label={t('submissionHub.journalIdentity')}>
          <div><dt>{t('submissionHub.journal')}</dt><dd>{profile?.canonicalName || caseItem.targetJournalName || t('submissionHub.noJournal')}</dd></div>
          <div><dt>{t('submissionHub.issn')}</dt><dd>{profile?.issn || t('submissionHub.notSet')}</dd></div>
          <div><dt>{t('submissionHub.publisher')}</dt><dd>{profile?.publisher || t('submissionHub.notSet')}</dd></div>
          <div><dt>{t('submissionHub.homepage')}</dt><dd>
            {profile?.homepageUrl
              ? <a href={profile.homepageUrl} target="_blank" rel="noreferrer">{profile.homepageUrl}</a>
              : t('submissionHub.notSet')}
          </dd></div>
          <div><dt>{t('submissionHub.journalPortal')}</dt><dd>
            {profile?.submissionPortalUrl
              ? <a href={profile.submissionPortalUrl} target="_blank" rel="noreferrer">{t(`submissionHub.platformLabels.${profile.platform}`)}</a>
              : t(`submissionHub.platformLabels.${profile?.platform ?? 'unknown'}`)}
          </dd></div>
        </dl>

        <div className="submissions-journal__actions">
          {caseItem.status === 'JOURNAL_SELECTED' && (
            <button type="button" className="submissions-primary" disabled={busy !== ''}
              onClick={() => void quickAdvance('PROFILING')}>{t('submissionHub.advanceToProfiling')}</button>
          )}
          {caseItem.status === 'PROFILING' && (
            <button type="button" className="submissions-primary" disabled={busy !== ''}
              onClick={() => void quickAdvance('PROFILE_READY')}>{t('submissionHub.profilingDone')}</button>
          )}
          <button type="button" className="submissions-secondary" disabled={busy !== ''}
            onClick={() => void fetchGuidelines()}>
            {busy === 'fetch' ? t('submissionHub.fetchingGuidelines') : t('submissionHub.fetchGuidelines')}
          </button>
          <button type="button" className="submissions-secondary" disabled={busy !== ''}
            onClick={() => void checkUpdates()}>
            {busy === 'diff' ? t('submissionHub.checkingUpdates') : t('submissionHub.checkUpdates')}
          </button>
          <button type="button" className="submissions-secondary" disabled={busy !== ''}
            onClick={() => void buildCorpus()}>
            {busy === 'corpus' ? t('submissionHub.findingPapers') : t('submissionHub.findRecentPapers')}
          </button>
          <button type="button" className="submissions-secondary" disabled={busy !== ''}
            onClick={() => void analyzePatterns()}>
            {busy === 'patterns' ? t('submissionHub.analyzingPatterns') : t('submissionHub.analyzePatterns')}
          </button>
        </div>

        {diffChecked && (
          <div className="submissions-journal__diff" data-testid="submissions-journal-diff">
            {diffChangeCount === 0
              ? <p className="submissions-empty">{t('submissionHub.noChanges')}</p>
              : (
                <>
                  <p><strong>{t('submissionHub.changesFound', { count: diffChangeCount })}</strong></p>
                  <ul>
                    {diff?.added.map((item) => (
                      <li key={`added-${item.id}`}><span className="submissions-tier ok">{t('submissionHub.changeAdded')}</span> {t(`submissionHub.ruleKeys.${item.ruleKey}`)}：{item.valueText}</li>
                    ))}
                    {diff?.removed.map((item) => (
                      <li key={`removed-${item.id}`}><span className="submissions-tier bad">{t('submissionHub.changeRemoved')}</span> {t(`submissionHub.ruleKeys.${item.ruleKey}`)}：{item.valueText}</li>
                    ))}
                    {diff?.changed.map((item, index) => (
                      <li key={`changed-${item.ruleKey}-${index}`}><span className="submissions-tier">{t('submissionHub.changeChanged')}</span> {t(`submissionHub.ruleKeys.${item.ruleKey}`)}：{item.before?.valueText ?? ''} → {item.after?.valueText ?? ''}</li>
                    ))}
                  </ul>
                </>
              )}
          </div>
        )}

        <div className="submissions-journal__requirements">
          {requirements.length === 0 && <p className="submissions-empty">{t('submissionHub.guidelinesEmpty')}</p>}
          {groupedRequirements.map(([ruleKey, items]) => (
            <section key={ruleKey} className="submissions-journal__group">
              <h4>{t(`submissionHub.ruleKeys.${ruleKey}`)}</h4>
              {items.map((item) => (
                <article key={item.id} className="submissions-journal__item" data-testid="submissions-requirement">
                  <p>{item.valueText}</p>
                  <div className="submissions-journal__meta">
                    {item.sourceUrl && (
                      <span>{t('submissionHub.requirementSource')}：<a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.sourceTitle || item.sourceUrl}</a></span>
                    )}
                    <span>{t('submissionHub.confidence')}：{t(`submissionHub.confidenceLevels.${item.confidence}`)}</span>
                    <span>{t('submissionHub.retrievedAt')}：{new Date(item.retrievedAt).toLocaleString()}</span>
                  </div>
                  {item.evidenceSnippet && (
                    <details className="submissions-journal__evidence">
                      <summary>{t('submissionHub.evidenceSnippet')}</summary>
                      <blockquote>{item.evidenceSnippet}</blockquote>
                    </details>
                  )}
                </article>
              ))}
            </section>
          ))}
        </div>

        <div className="submissions-journal__corpus">
          {corpus.length === 0
            ? <p className="submissions-empty">{t('submissionHub.corpusEmpty')}</p>
            : (
              <ul>
                {corpus.map((item) => (
                  <li key={item.id} data-testid="submissions-corpus-item">
                    <span>
                      {item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.title}</a> : item.title}
                      {item.year != null && `（${item.year}）`}
                    </span>
                    <small>
                      {item.source}
                      {item.similarityScore != null && ` · ${t('submissionHub.corpusSimilarity', { score: Math.round(item.similarityScore * 100) })}`}
                    </small>
                    {item.fulltextAvailable && <span className="submissions-tier ok">{t('submissionHub.fulltextYes')}</span>}
                  </li>
                ))}
              </ul>
            )}
        </div>

        <div className="submissions-journal__patterns">
          {observations.length === 0
            ? <p className="submissions-empty">{t('submissionHub.patternsEmpty')}</p>
            : observations.map((item) => (
              <article key={item.id} className="submissions-journal__item" data-testid="submissions-pattern">
                <div className="submissions-journal__meta">
                  <strong className="submissions-badge">{t('submissionHub.patternDisclaimer')}</strong>
                  <span className="submissions-tier">{t(`submissionHub.patternKeys.${item.patternKey}`)}</span>
                </div>
                <p>{item.observation}</p>
                <div className="submissions-journal__meta">
                  <span>{t('submissionHub.sampleSize', { count: item.sampleSize })}</span>
                  <span>{t(`submissionHub.patternEvidenceLevels.${item.evidenceLevel}`)}</span>
                  <span>{t('submissionHub.confidence')}：{t(`submissionHub.confidenceLevels.${item.confidence}`)}</span>
                </div>
              </article>
            ))}
        </div>
      </details>

      {showDiagnosis && (
        <section className="submissions-diagnosis" data-testid="submissions-diagnosis">
          <h3>{t('submissionHub.diagnosisTitle')}</h3>
          <div className="submissions-journal__actions">
            {caseItem.status === 'PROFILE_READY' && (
              <button type="button" className="submissions-primary" disabled={busy !== ''}
                onClick={() => void quickAdvance('DIAGNOSING')}>{t('submissionHub.startDiagnosis')}</button>
            )}
            {caseItem.status !== 'PROFILE_READY' && (
              <button type="button" className="submissions-primary" disabled={busy !== ''}
                onClick={() => void runDiagnosis()}>
                {busy === 'diagnose' ? t('submissionHub.diagnosing') : t('submissionHub.startDiagnosis')}
              </button>
            )}
            {visibleGapItems.length > 0 && (
              <button type="button" className="submissions-secondary" disabled={busy !== ''}
                onClick={() => void createPlan()}>
                {busy === 'plan' ? t('submissionHub.creatingPlan') : t('submissionHub.createPlan')}
              </button>
            )}
          </div>
          {visibleGapItems.length === 0 && <p className="submissions-empty">{t('submissionHub.gapEmpty')}</p>}
          {GAP_SEVERITY_ORDER.map((severity) => {
            const items = visibleGapItems.filter((item) => item.severity === severity);
            if (items.length === 0) return null;
            return (
              <section key={severity} className="submissions-journal__group">
                <h4>{t(`submissionHub.severityLabels.${severity}`)}</h4>
                {items.map((item) => (
                  <article key={item.id} className="submissions-journal__item" data-testid="submissions-gap-item">
                    <div className="submissions-journal__meta">
                      <strong>{item.title}</strong>
                      {item.requiresResearcherJudgment && <span className="submissions-badge warn">{t('submissionHub.requiresJudgment')}</span>}
                    </div>
                    <p>{item.problem}</p>
                    {item.evidence && <p><small>{t('submissionHub.gapEvidence')}：{item.evidence}</small></p>}
                    {item.affectedLocation && <p><small>{t('submissionHub.gapLocation')}：{item.affectedLocation}</small></p>}
                    {item.recommendedAction && <p><small>{t('submissionHub.gapAction')}：{item.recommendedAction}</small></p>}
                    <button type="button" className="submissions-secondary" onClick={() => void dismissGap(item.id)}>{t('submissionHub.dismissGap')}</button>
                  </article>
                ))}
              </section>
            );
          })}
        </section>
      )}

      {plan && (
        <section className="submissions-plan" data-testid="submissions-plan">
          <h3>{t('submissionHub.planTitle')}</h3>
          {planItems.map((item) => (
            <article key={item.id} className="submissions-journal__item" data-testid="submissions-plan-item">
              <label className="submissions-plan__select">
                <input type="checkbox" checked={selectedItemIds.includes(item.id)}
                  disabled={item.status === 'applied' || item.status === 'skipped'}
                  onChange={(event) => setSelectedItemIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />
                <strong>{item.title}</strong>
              </label>
              <div className="submissions-journal__meta">
                <span className="submissions-tier">{t(`submissionHub.planItemStatus.${item.status}`)}</span>
                {item.involvesResearcherJudgment && <span className="submissions-badge warn">{t('submissionHub.involvesJudgment')}</span>}
              </div>
              {item.action && <p>{item.action}</p>}
              {item.risk && <p><small>{t('submissionHub.planItemRisk')}：{item.risk}</small></p>}
            </article>
          ))}
          <div className="submissions-journal__actions">
            {planApprovable && (
              <button type="button" className="submissions-primary" disabled={busy !== ''}
                onClick={() => void approveAndApply()}>
                {busy === 'apply' ? t('submissionHub.applyingPlan') : t('submissionHub.approveAndApply')}
              </button>
            )}
            {planApplied && (
              <button type="button" className="submissions-secondary" disabled={busy !== ''}
                onClick={() => void reverify()}>
                {busy === 'verify' ? t('submissionHub.verifying') : t('submissionHub.reverify')}
              </button>
            )}
          </div>
          {applySummary && (
            <p className="submissions-notice" role="status">
              {t('submissionHub.applyResult', applySummary)}
            </p>
          )}
          {verifyMessage && <p className="submissions-notice" role="status">{verifyMessage}</p>}
        </section>
      )}
    </div>
  );
}

const PREFLIGHT_GROUP_OF: Record<string, 'manuscript' | 'blind' | 'statement' | 'files' | 'other'> = {
  word_count: 'manuscript', abstract: 'manuscript', keywords: 'manuscript', section_structure: 'manuscript',
  reference_style: 'manuscript', figures_tables: 'manuscript', ai_policy: 'manuscript', other: 'other',
  blind_author_names: 'blind', blind_affiliation: 'blind', blind_acknowledgement: 'blind',
  statement_funding: 'statement', statement_coi: 'statement', statement_ethics: 'statement', statement_data_availability: 'statement',
  file_main_manuscript: 'files', file_title_page: 'files', file_cover_letter: 'files', file_supplementary: 'files',
};

/**
 * 投稿检查与材料区（P2）：预检清单（通过/提醒/必须处理三级）→ 投稿材料包
 * （组装/挂接成果/校验/导出/冻结，冻结后不可改）→ Cover Letter 生成。
 * 冻结前置条件是预检无必须处理项；事实性内容一律标注「需要研究者确认」。
 */
function SubmissionPackageSection({ projectId, caseItem, onRefresh }: {
  projectId: string;
  caseItem: SubmissionCase;
  onRefresh: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const api = journalApi();
  const [busy, setBusy] = useState<'' | 'preflight' | 'assemble' | 'export' | 'freeze' | 'validate' | 'letter'>('');
  const [message, setMessage] = useState('');
  const [preflight, setPreflight] = useState<{ run: SubmissionPreflightRun; checks: SubmissionPreflightCheck[] } | null>(null);
  const [pkg, setPkg] = useState<{ package: SubmissionPackage; files: SubmissionPackageFile[] } | null>(null);
  const [outcomes, setOutcomes] = useState<Array<{ id: string; title: string; currentVersion: number }>>([]);
  const [attachOutcomeId, setAttachOutcomeId] = useState('');
  const [attachType, setAttachType] = useState<SubmissionPackageFileType>('title_page');
  const [letter, setLetter] = useState<{ title: string; version: number; needsConfirmation: string[]; extraction: 'llm' | 'template' } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!api) return;
      const pf = await api.getSubmissionPreflight?.({ projectId, caseId: caseItem.id });
      if (alive && pf) setPreflight(pf);
      const latest = await api.getSubmissionPackage?.({ projectId, caseId: caseItem.id });
      if (alive && latest) setPkg(latest);
      if (alive && window.metis?.listOutcomes) {
        const rows = await window.metis.listOutcomes({ projectId, query: '' });
        if (alive) setOutcomes(rows.map((row: { id: string; title: string; currentVersion: number }) => ({ id: row.id, title: row.title, currentVersion: row.currentVersion })));
      }
    })();
    return () => { alive = false; };
  }, [projectId, caseItem.id, api]);

  async function runPreflight(): Promise<void> {
    if (!api?.runSubmissionPreflight || busy) return;
    setBusy('preflight'); setMessage('');
    const result = await api.runSubmissionPreflight({ projectId, caseId: caseItem.id });
    if (result.ok) setPreflight({ run: result.run, checks: result.checks });
    else setMessage(t('submissionHub.journalActionFailed', { code: result.code }));
    setBusy('');
  }

  async function advanceToReady(): Promise<void> {
    if (!window.metis?.changeSubmissionStatus || busy) return;
    setBusy('preflight'); setMessage('');
    const changed = await window.metis.changeSubmissionStatus({
      projectId, change: { caseId: caseItem.id, to: 'READY_TO_SUBMIT', reason: '投稿检查通过', source: 'human' },
    });
    if (changed && !('ok' in changed)) await onRefresh();
    else setMessage(t('submissionHub.journalActionFailed', { code: 'illegal_transition' }));
    setBusy('');
  }

  async function assemble(): Promise<void> {
    if (!api?.assembleSubmissionPackage || busy) return;
    setBusy('assemble'); setMessage('');
    const result = await api.assembleSubmissionPackage({ projectId, caseId: caseItem.id });
    if (result.ok) setPkg({ package: result.package, files: result.files });
    else setMessage(t('submissionHub.journalActionFailed', { code: result.code }));
    setBusy('');
  }

  async function attachOutcomeFile(): Promise<void> {
    if (!api?.attachSubmissionPackageOutcome || !pkg || !attachOutcomeId || busy) return;
    setBusy('assemble'); setMessage('');
    const result = await api.attachSubmissionPackageOutcome({ projectId, packageId: pkg.package.id, outcomeId: attachOutcomeId, type: attachType, required: false });
    if (result?.ok) setPkg({ package: pkg.package, files: [...pkg.files.filter((file) => file.id !== result.file.id), result.file] });
    else setMessage(t('submissionHub.journalActionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
    setBusy('');
  }

  async function removeFile(fileId: string): Promise<void> {
    if (!api?.removeSubmissionPackageFile || !pkg || pkg.package.status === 'frozen') return;
    const okRemoved = await api.removeSubmissionPackageFile({ projectId, packageId: pkg.package.id, fileId });
    if (okRemoved) setPkg({ package: pkg.package, files: pkg.files.filter((file) => file.id !== fileId) });
  }

  async function exportPackage(): Promise<void> {
    if (!api?.exportSubmissionPackage || !pkg || busy) return;
    setBusy('export'); setMessage('');
    const result = await api.exportSubmissionPackage({ projectId, packageId: pkg.package.id });
    if (result?.ok) {
      const parts = [t('submissionHub.exportDone', { count: result.exported.length, dir: result.dir })];
      if (result.failures.length > 0) parts.push(t('submissionHub.exportFailed', { count: result.failures.length }));
      setMessage(parts.join(' '));
    } else setMessage(t('submissionHub.journalActionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
    setBusy('');
  }

  async function validatePackage(): Promise<void> {
    if (!api?.validateSubmissionPackage || !pkg || busy) return;
    setBusy('validate'); setMessage('');
    const result = await api.validateSubmissionPackage({ projectId, packageId: pkg.package.id });
    if (result?.ok) {
      const byId = new Map(result.results.map((row) => [row.fileId, row.validationStatus]));
      setPkg({ package: pkg.package, files: pkg.files.map((file) => ({ ...file, validationStatus: byId.get(file.id) ?? file.validationStatus }) as SubmissionPackageFile) });
    } else setMessage(t('submissionHub.journalActionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
    setBusy('');
  }

  async function freeze(): Promise<void> {
    if (!api?.freezeSubmissionPackage || !pkg || busy) return;
    setBusy('freeze'); setMessage('');
    const result = await api.freezeSubmissionPackage({ projectId, packageId: pkg.package.id });
    if (result?.ok) setPkg({ package: result.package, files: pkg.files });
    else if (result && 'blockers' in result) setMessage(t('submissionHub.freezeBlocked'));
    else setMessage(t('submissionHub.journalActionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
    setBusy('');
  }

  async function generateLetter(): Promise<void> {
    if (!api?.generateSubmissionCoverLetter || busy) return;
    setBusy('letter'); setMessage('');
    const result = await api.generateSubmissionCoverLetter({ projectId, caseId: caseItem.id });
    if (result.ok) {
      const target = outcomes.find((row) => row.id === result.outcomeId);
      setLetter({ title: target?.title ?? `Cover Letter｜${caseItem.targetJournalName}`, version: result.version, needsConfirmation: result.needsConfirmation, extraction: result.extraction });
      await onRefresh();
    } else setMessage(t('submissionHub.journalActionFailed', { code: result.code }));
    setBusy('');
  }

  const frozen = pkg?.package.status === 'frozen';
  const preflightGroups: Array<{ key: 'manuscript' | 'blind' | 'statement' | 'files' | 'other'; items: SubmissionPreflightCheck[] }> = [];
  if (preflight) {
    for (const group of ['manuscript', 'blind', 'statement', 'files', 'other'] as const) {
      const items = preflight.checks.filter((check) => (PREFLIGHT_GROUP_OF[check.checkKey] ?? 'other') === group);
      if (items.length > 0) preflightGroups.push({ key: group, items });
    }
  }
  const blockedCount = preflight?.run.blockCount ?? 0;

  return (
    <div className="submissions-journal submissions-package" data-testid="submission-package-section">
      <h3>{t('submissionHub.preflightTitle')}</h3>
      <button type="button" className="submissions-secondary" disabled={busy !== ''} onClick={() => void runPreflight()}>
        {busy === 'preflight' && preflight === null ? t('submissionHub.runningPreflight') : t('submissionHub.runPreflight')}
      </button>
      {!preflight && <p className="submissions-empty">{t('submissionHub.preflightNone')}</p>}
      {preflight && (
        <div className="submissions-preflight">
          <p className={blockedCount > 0 ? 'submissions-badge warn' : 'submissions-badge'}>
            {blockedCount > 0
              ? t('submissionHub.preflightSummary', { block: blockedCount, warn: preflight.run.warnCount })
              : t('submissionHub.preflightPassed')}
          </p>
          {blockedCount > 0 && <p className="submissions-gap__problem">{t('submissionHub.preflightBlockedHint')}</p>}
          {preflightGroups.map((group) => (
            <div key={group.key} className="submissions-requirements-group">
              <strong>{t(`submissionHub.preflightGroups.${group.key}`)}</strong>
              <ul>
                {group.items.map((check) => (
                  <li key={check.id} className={`submissions-preflight__item level-${check.level}`}>
                    <span className={`submissions-tier ${check.level === 'pass' ? 'ok' : check.level === 'block' ? 'bad' : 'warn'}`}>
                      {t(`submissionHub.checkLevel.${check.level}`)}
                    </span>
                    <span>{check.label}</span>
                    <small>{check.detail}</small>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <button type="button" className="submissions-primary" disabled={blockedCount > 0 || busy !== ''}
            onClick={() => void advanceToReady()}>{t('submissionHub.readyToSubmit')}</button>
        </div>
      )}

      <h3>{t('submissionHub.packageTitle')}</h3>
      <button type="button" className="submissions-secondary" disabled={busy !== ''} onClick={() => void assemble()}>
        {busy === 'assemble' ? t('submissionHub.assembling') : t('submissionHub.assemblePackage')}
      </button>
      {!pkg && <p className="submissions-empty">{t('submissionHub.packageNone')}</p>}
      {pkg && (
        <div className="submissions-package__body">
          {frozen && <p className="submissions-badge ok">{t('submissionHub.frozenBadge', { round: pkg.package.round })}</p>}
          <ul className="submissions-package-files">
            {pkg.files.map((file) => (
              <li key={file.id}>
                <span className="submissions-tier">{t(`submissionHub.fileTypeLabels.${file.type}`)}</span>
                <span>{file.filename}</span>
                {file.required && <span className="submissions-badge warn">{t('submissionHub.requiredFile')}</span>}
                <span className={`submissions-tier ${file.validationStatus === 'valid' ? 'ok' : file.validationStatus === 'invalid' ? 'bad' : ''}`}>
                  {t(`submissionHub.validationLabels.${file.validationStatus}`)}
                </span>
                {!frozen && <button type="button" className="submissions-secondary" onClick={() => void removeFile(file.id)}>{t('submissionHub.removeFile')}</button>}
              </li>
            ))}
          </ul>
          {!frozen && (
            <div className="submissions-package-attach">
              <label>
                <span>{t('submissionHub.attachTypeLabel')}</span>
                <select value={attachType} onChange={(event) => setAttachType(event.target.value as SubmissionPackageFileType)}>
                  {SUBMISSION_PACKAGE_FILE_TYPES.filter((type) => type !== 'main_manuscript').map((type) => (
                    <option key={type} value={type}>{t(`submissionHub.fileTypeLabels.${type}`)}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t('submissionHub.attachOutcome')}</span>
                <select value={attachOutcomeId} onChange={(event) => setAttachOutcomeId(event.target.value)}>
                  <option value="">{t('submissionHub.attachOutcomePlaceholder')}</option>
                  {outcomes.map((outcome) => (
                    <option key={outcome.id} value={outcome.id}>{outcome.title}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="submissions-secondary" disabled={!attachOutcomeId || busy !== ''}
                onClick={() => void attachOutcomeFile()}>{t('submissionHub.attachOutcome')}</button>
            </div>
          )}
          <div className="submissions-package-actions">
            <button type="button" className="submissions-secondary" disabled={busy !== ''} onClick={() => void validatePackage()}>{t('submissionHub.validatePackage')}</button>
            <button type="button" className="submissions-secondary" disabled={busy !== ''} onClick={() => void exportPackage()}>
              {busy === 'export' ? t('submissionHub.exporting') : t('submissionHub.exportPackage')}
            </button>
            {!frozen && (
              <button type="button" className="submissions-primary" disabled={busy !== ''} onClick={() => void freeze()}>
                {busy === 'freeze' ? t('submissionHub.freezing') : t('submissionHub.freezePackage')}
              </button>
            )}
          </div>
        </div>
      )}

      <h3>{t('submissionHub.coverLetterTitle')}</h3>
      <button type="button" className="submissions-secondary" disabled={busy !== ''} onClick={() => void generateLetter()}>
        {busy === 'letter' ? t('submissionHub.generatingLetter') : letter ? t('submissionHub.regenerateCoverLetter') : t('submissionHub.generateCoverLetter')}
      </button>
      {letter && (
        <div className="submissions-cover-letter">
          <p className="submissions-notice">{t('submissionHub.coverLetterDone', { title: letter.title, version: letter.version })}</p>
          {letter.extraction === 'template' && <p><small>{t('submissionHub.coverLetterTemplateNote')}</small></p>}
          {letter.needsConfirmation.length > 0 && (
            <div className="submissions-badge warn">
              <span>{t('submissionHub.coverLetterNeedsConfirmation')}</span>
              <ul>{letter.needsConfirmation.map((item, index) => <li key={index}>{item}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {(caseItem.status === 'READY_TO_SUBMIT' || caseItem.status === 'READY_TO_RESUBMIT') && pkg?.package.status === 'frozen' && (
        <FinalSubmitConfirm projectId={projectId} caseItem={caseItem} preflightPassed={(preflight?.run.passed ?? false)} onRefresh={onRefresh} />
      )}

      {message && <p className="submissions-notice" role="status">{message}</p>}
    </div>
  );
}

/**
 * 最终提交确认（P3）：Human Approval 门控。只有材料包已冻结且预检通过才渲染，
 * 提交必须由研究者本人勾选声明并点击确认；系统记录投稿方式与回执编号。
 */
function FinalSubmitConfirm({ projectId, caseItem, preflightPassed, onRefresh }: {
  projectId: string;
  caseItem: SubmissionCase;
  preflightPassed: boolean;
  onRefresh: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const api = journalApi();
  const [method, setMethod] = useState<'portal_web' | 'email' | 'offline_manual'>('portal_web');
  const [portalUrl, setPortalUrl] = useState('');
  const [remoteId, setRemoteId] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function confirm(): Promise<void> {
    if (!api?.confirmFinalSubmission || busy || !agreed) return;
    setBusy(true); setResult(null);
    const response = await api.confirmFinalSubmission({
      projectId, caseId: caseItem.id,
      submissionMethod: method,
      ...(portalUrl.trim() ? { portalUrl: portalUrl.trim() } : {}),
      ...(remoteId.trim() ? { remoteSubmissionId: remoteId.trim() } : {}),
      confirmed: true,
    });
    if (response?.ok) {
      const idSuffix = caseItem.remoteSubmissionId ? ` · ${t('submissionHub.remoteIdLabel')} ${response.submissionCase.remoteSubmissionId}` : '';
      setResult({ ok: true, text: t('submissionHub.submitDone', { journal: response.submissionCase.targetJournalName, id: idSuffix }) });
      await onRefresh();
    } else {
      const code = response && 'code' in response ? String(response.code) : 'failed';
      const textByCode: Record<string, string> = {
        preflight_not_passed: t('submissionHub.submitBlockedPreflight'),
        package_not_frozen: t('submissionHub.submitBlockedPackage'),
        illegal_status: t('submissionHub.submitBlockedStatus'),
        illegal_transition: t('submissionHub.submitBlockedStatus'),
        approval_required: t('submissionHub.confirmStatement'),
        use_submit_flow: t('submissionHub.submitNeedsFlow'),
      };
      setResult({ ok: false, text: textByCode[code] ?? t('submissionHub.journalActionFailed', { code }) });
    }
    setBusy(false);
  }

  return (
    <div className="submissions-final-submit" data-testid="final-submit">
      <h3>{t('submissionHub.submitTitle')}</h3>
      <label>
        <span>{t('submissionHub.methodLabel')}</span>
        <select value={method} onChange={(event) => setMethod(event.target.value as typeof method)}>
          <option value="portal_web">{t('submissionHub.methodPortalWeb')}</option>
          <option value="email">{t('submissionHub.methodEmail')}</option>
          <option value="offline_manual">{t('submissionHub.methodOfflineManual')}</option>
        </select>
      </label>
      <input placeholder={t('submissionHub.portalUrlLabel')} value={portalUrl} onChange={(event) => setPortalUrl(event.target.value)} />
      <input placeholder={t('submissionHub.remoteIdLabel')} value={remoteId} onChange={(event) => setRemoteId(event.target.value)} />
      <label className="submissions-confirm-statement">
        <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
        <span>{t('submissionHub.confirmStatement')}</span>
      </label>
      {!preflightPassed && <p className="submissions-gap__problem">{t('submissionHub.submitBlockedPreflight')}</p>}
      <button type="button" className="submissions-primary" disabled={!agreed || !preflightPassed || busy} onClick={() => void confirm()}>
        {busy ? t('submissionHub.confirming') : t('submissionHub.confirmSubmit')}
      </button>
      {result && <p className={result.ok ? 'submissions-notice' : 'submissions-gap__problem'} role="status">{result.text}</p>}
    </div>
  );
}

/**
 * 返修工作台（P4）：粘贴 Decision Letter → 确定性拆解（原文逐字保留）→
 * 逐条意见处理（回复文本/状态）→ 汇总 Response to Reviewers 成果。
 */
function SubmissionRevisionSection({ projectId, caseItem, onRefresh }: {
  projectId: string;
  caseItem: SubmissionCase;
  onRefresh: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const api = journalApi();
  const [letterText, setLetterText] = useState('');
  const [rounds, setRounds] = useState<Array<ReviewRound & { comments: ReviewerComment[] }>>([]);
  const [busy, setBusy] = useState<'' | 'parse' | 'revision' | 'response'>('');
  const [message, setMessage] = useState('');
  const [draftResponses, setDraftResponses] = useState<Record<string, string>>({});
  const [selectedCommentId, setSelectedCommentId] = useState('');
  const [goalMessage, setGoalMessage] = useState('');
  // 倒计时基准时间：渲染期不许调用 Date.now（react-hooks/purity），用状态快照。
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    // 每小时刷新一次倒计时基准（初始值已在 useState 初始化器里同步取）。
    const timer = setInterval(() => setNowMs(Date.now()), 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const rows = await api?.listSubmissionReviewRounds?.({ projectId, caseId: caseItem.id });
      if (alive && rows) setRounds(rows);
    })();
    return () => { alive = false; };
  }, [projectId, caseItem.id, api]);

  const allComments = rounds.flatMap((round) => round.comments);
  const selectedComment = allComments.find((comment) => comment.id === selectedCommentId) ?? null;
  const latestRoundWithDeadline = rounds.find((round) => round.deadline !== null) ?? null;

  /** 距返修截止的自然语言倒计时（过期如实显示已过期）。 */
  function deadlineCountdown(deadline: number): string {
    if (!nowMs) return '';
    const days = Math.ceil((deadline - nowMs) / 86_400_000);
    if (days > 0) return t('submissionHub.daysLeft', { days });
    if (days === 0) return t('submissionHub.dueToday');
    return t('submissionHub.overdueBy', { days: -days });
  }

  /** 把最新轮次的返修截止日期同步到任务板（Goal）。幂等。 */
  async function syncDeadline(): Promise<void> {
    const target = latestRoundWithDeadline;
    if (!target || busy) return;
    setBusy('response'); setGoalMessage('');
    const result = await window.metis?.syncSubmissionDeadlineToGoal?.({ projectId, caseId: caseItem.id, roundId: target.id });
    if (result?.ok) setGoalMessage(t('submissionHub.goalSynced'));
    else setGoalMessage(t('submissionHub.journalActionFailed', { code: result && !result.ok ? result.code : 'failed' }));
    setBusy('');
  }

  async function parseLetter(): Promise<void> {
    if (!api?.createSubmissionReviewRound || busy) return;
    if (!letterText.trim()) { setMessage(t('submissionHub.letterEmpty')); return; }
    setBusy('parse'); setMessage('');
    const result = await api.createSubmissionReviewRound({ projectId, caseId: caseItem.id, decisionLetterText: letterText });
    if (result?.ok) {
      const rows = await api.listSubmissionReviewRounds?.({ projectId, caseId: caseItem.id });
      if (rows) setRounds(rows);
      const count = result.parsed.reviewerComments.length + result.parsed.editorComments.length;
      setMessage(result.parsed.decision === 'unclear'
        ? t('submissionHub.parsedUnclear')
        : `${t('submissionHub.parsedOk', { decision: result.parsed.decision, count })}${result.parsed.deadline ? ` ${t('submissionHub.deadlineAt', { date: new Date(result.parsed.deadline).toLocaleDateString() })}` : ` ${t('submissionHub.noDeadline')}`}`);
      setLetterText('');
    } else {
      setMessage(t('submissionHub.journalActionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
    }
    setBusy('');
  }

  async function beginRevision(): Promise<void> {
    if (!api?.beginSubmissionRevision || busy) return;
    setBusy('revision'); setMessage('');
    const result = await api.beginSubmissionRevision({ projectId, caseId: caseItem.id });
    if (result?.ok) await onRefresh();
    else setMessage(t('submissionHub.journalActionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
    setBusy('');
  }

  async function saveResponse(commentId: string): Promise<void> {
    const text = draftResponses[commentId];
    if (!api?.updateSubmissionReviewComment || !text?.trim()) return;
    const updated = await api.updateSubmissionReviewComment({ projectId, commentId, patch: { responseText: text, status: 'addressed' } });
    if (updated) {
      setRounds((current) => current.map((round) => ({
        ...round,
        comments: round.comments.map((comment) => (comment.id === updated.id ? updated : comment)),
      })));
      setDraftResponses((current) => ({ ...current, [commentId]: '' }));
    }
  }

  async function generateResponse(): Promise<void> {
    if (!api?.generateSubmissionResponseLetter || busy) return;
    setBusy('response'); setMessage('');
    const result = await api.generateSubmissionResponseLetter({ projectId, caseId: caseItem.id });
    if (result?.ok) setMessage(t('submissionHub.responseDone', { version: result.version, unresolved: result.unresolvedCount }));
    else setMessage(t('submissionHub.journalActionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
    setBusy('');
  }

  return (
    <div className="submissions-journal submissions-revision" data-testid="submission-revision-section">
      <h3>{t('submissionHub.revisionTitle')}</h3>
      {latestRoundWithDeadline?.deadline && (
        <p className="submissions-deadline" role="status">
          {`${t('submissionHub.deadlineAt', { date: new Date(latestRoundWithDeadline.deadline).toLocaleDateString() })} · ${deadlineCountdown(latestRoundWithDeadline.deadline)}`}
          <button type="button" className="submissions-secondary" disabled={busy !== ''} onClick={() => void syncDeadline()}>
            {t('submissionHub.syncToTaskBoard')}
          </button>
        </p>
      )}
      {/* 返修工作台：左 意见树 / 中 选中意见与回复 / 右 返修动作 */}
      <div className="submissions-revision__grid">
        <div className="submissions-revision__col submissions-revision__tree" aria-label={t('submissionHub.revisionComments')}>
          <details open={rounds.length === 0}>
            <summary>{t('submissionHub.pasteLetter')}</summary>
            <p><small>{t('submissionHub.pasteLetterHint')}</small></p>
            <textarea aria-label={t('submissionHub.pasteLetter')} rows={8} value={letterText} onChange={(event) => setLetterText(event.target.value)} />
            <button type="button" className="submissions-secondary" disabled={busy !== ''} onClick={() => void parseLetter()}>
              {busy === 'parse' ? t('submissionHub.parsing') : t('submissionHub.parseLetter')}
            </button>
          </details>
          {rounds.length === 0 && <p className="submissions-empty">{t('submissionHub.noRounds')}</p>}
          {rounds.map((round) => (
            <div key={round.id} className="submissions-journal__group">
              <strong>{`#${round.roundNo} · ${t(`submissionHub.decisionLabels.${round.decision}`)}`}{round.deadline ? ` · ${deadlineCountdown(round.deadline)}` : ''}</strong>
              <ul>
                {round.comments.map((comment) => (
                  <li key={comment.id}>
                    <button type="button" className={`submissions-comment-link${comment.id === selectedCommentId ? ' active' : ''}`}
                      onClick={() => setSelectedCommentId(comment.id)}>
                      <span className="submissions-tier">{comment.reviewerLabel || 'Reviewer'}</span>
                      {' '}
                      <span className={`submissions-tier ${comment.status === 'addressed' ? 'ok' : ''}`}>{t(`submissionHub.commentStatusLabels.${comment.status}`)}</span>
                      <span className="submissions-comment-snippet">{comment.originalText.slice(0, 60)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="submissions-revision__col" aria-label={t('submissionHub.originalComment')}>
          {!selectedComment && <p className="submissions-empty">{t('submissionHub.selectComment')}</p>}
          {selectedComment && (
            <>
              <div className="submissions-journal__meta">
                <span className="submissions-tier">{selectedComment.reviewerLabel || 'Reviewer'}</span>
                <span className={`submissions-tier ${selectedComment.status === 'addressed' ? 'ok' : ''}`}>{t(`submissionHub.commentStatusLabels.${selectedComment.status}`)}</span>
              </div>
              <blockquote>{selectedComment.originalText}</blockquote>
              {selectedComment.responseText
                ? <p><strong>Response:</strong> {selectedComment.responseText}</p>
                : (
                  <div className="submissions-response-edit">
                    <textarea aria-label={t('submissionHub.saveResponse')} rows={5} placeholder={t('submissionHub.responsePlaceholder')}
                      value={draftResponses[selectedComment.id] ?? ''} readOnly={false}
                      onChange={(event) => setDraftResponses((current) => ({ ...current, [selectedComment.id]: event.target.value }))} />
                    <button type="button" className="submissions-secondary" onClick={() => void saveResponse(selectedComment.id)}>{t('submissionHub.saveResponse')}</button>
                  </div>
                )}
            </>
          )}
        </div>
        <div className="submissions-revision__col" aria-label={t('submissionHub.revisionAssistant')}>
          {caseItem.status === 'REVISION_REQUIRED' && (
            <button type="button" className="submissions-primary" disabled={busy !== ''} onClick={() => void beginRevision()}>
              {busy === 'revision' ? t('submissionHub.working') : t('submissionHub.beginRevision')}
            </button>
          )}
          <button type="button" className="submissions-secondary" disabled={busy !== '' || rounds.length === 0} onClick={() => void generateResponse()}>
            {busy === 'response' ? t('submissionHub.generatingResponse') : t('submissionHub.generateResponse')}
          </button>
          {goalMessage && <p><small>{goalMessage}</small></p>}
        </div>
      </div>
      {message && <p className="submissions-notice" role="status">{message}</p>}
    </div>
  );
}

/** 邮箱账户的渲染端视图（不含授权码，与 preload 返回一致）。 */
interface MailAccountLite { id: string; label: string; user: string; host: string }

interface MailPreviewState {
  accountLabel: string;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  attachments: Array<{ filename: string; source: 'content' | 'path' | 'empty' }>;
  smtp: { host: string; port: number; secure: boolean } | null;
}

const ROUNDABLE_CLASSIFICATIONS = ['decision_letter', 'revision_request'];

/**
 * 投稿通信区（P3）：邮箱账户同步收件、全项目待确认收件的确认/否认、
 * 本 Case 通信时间线，以及「预览 → 确认」两段式发信（operationId 幂等）。
 */
function SubmissionCorrespondenceSection({ projectId, caseItem, onRefresh }: {
  projectId: string;
  caseItem: SubmissionCase;
  onRefresh: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<MailAccountLite[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [pending, setPending] = useState<SubmissionCorrespondence[]>([]);
  const [timeline, setTimeline] = useState<SubmissionCorrespondence[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<'' | 'sync' | 'preview' | 'send' | 'round'>('');
  const [message, setMessage] = useState('');
  const [composeOpen, setComposeOpen] = useState(false);
  const [compose, setCompose] = useState({ to: '', cc: '', bcc: '', subject: '', bodyText: '', attachments: '' });
  const [operationId, setOperationId] = useState('');
  const [preview, setPreview] = useState<MailPreviewState | null>(null);
  const [composeNote, setComposeNote] = useState('');

  const loadData = useCallback(async () => {
    const api = window.metis;
    if (!api?.listSubmissionMailAccounts || !api?.listPendingSubmissionCorrespondence || !api?.listSubmissionCorrespondence) {
      setLoadError(true);
      return;
    }
    try {
      const [accountRows, pendingRows, timelineRows] = await Promise.all([
        api.listSubmissionMailAccounts(),
        api.listPendingSubmissionCorrespondence({ projectId }),
        api.listSubmissionCorrespondence({ projectId, caseId: caseItem.id }),
      ]);
      setAccounts(accountRows);
      setAccountsLoaded(true);
      setAccountId((current) => (accountRows.some((row) => row.id === current) ? current : accountRows[0]?.id ?? ''));
      setPending(pendingRows);
      setTimeline(timelineRows);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [projectId, caseItem.id]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      // 让出微任务，避免在 effect 体内同步 setState 引发级联渲染。
      await Promise.resolve();
      if (alive) await loadData();
    })();
    return () => { alive = false; };
  }, [loadData]);

  async function sync(): Promise<void> {
    if (!window.metis?.syncSubmissionMail || !accountId || busy) return;
    setBusy('sync'); setMessage('');
    const result = await window.metis.syncSubmissionMail({ projectId, accountId });
    if (result?.ok) {
      setMessage(t('submissionHub.mail.syncResult', {
        fetched: result.fetched, recorded: result.recorded, duplicates: result.duplicates, pending: result.pending,
      }));
    } else {
      setMessage(t('submissionHub.mail.syncFailed', {
        code: result && 'code' in result ? result.code : 'failed',
        message: result && 'message' in result ? result.message : '',
      }));
    }
    await loadData();
    setBusy('');
  }

  async function confirmMatch(id: string): Promise<void> {
    if (!window.metis?.confirmSubmissionCorrespondenceMatch) return;
    const result = await window.metis.confirmSubmissionCorrespondenceMatch({ projectId, id, caseId: caseItem.id });
    if (result?.ok) { setMessage(t('submissionHub.mail.matchConfirmed')); await loadData(); }
    else setMessage(t('submissionHub.mail.actionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
  }

  async function rejectMatch(id: string): Promise<void> {
    if (!window.metis?.rejectSubmissionCorrespondenceMatch) return;
    const result = await window.metis.rejectSubmissionCorrespondenceMatch({ projectId, id });
    if (result?.ok) { setMessage(t('submissionHub.mail.matchRejected')); await loadData(); }
    else setMessage(t('submissionHub.mail.actionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
  }

  async function toRound(id: string): Promise<void> {
    if (!window.metis?.createSubmissionRoundFromCorrespondence || busy) return;
    setBusy('round'); setMessage('');
    const result = await window.metis.createSubmissionRoundFromCorrespondence({ projectId, id });
    if (result?.ok) {
      setMessage(t('submissionHub.mail.roundDone'));
      await onRefresh();
    } else {
      setMessage(t('submissionHub.mail.actionFailed', { code: result && 'code' in result ? result.code : 'failed' }));
    }
    setBusy('');
  }

  function openCompose(): void {
    setCompose({ to: '', cc: '', bcc: '', subject: '', bodyText: '', attachments: '' });
    // 幂等键：整个发送会话（含失败重试）共用同一个 operationId。
    setOperationId(crypto.randomUUID());
    setPreview(null);
    setComposeNote('');
    setComposeOpen(true);
  }

  function composeAttachments(): Array<{ filename: string; path: string }> {
    return compose.attachments.split('\n').map((line) => line.trim()).filter(Boolean)
      .map((path) => ({ filename: path.split(/[\\/]/).pop() || path, path }));
  }

  async function previewMail(): Promise<void> {
    if (!window.metis?.previewSubmissionMail || !accountId || busy) return;
    setBusy('preview'); setComposeNote('');
    const result = await window.metis.previewSubmissionMail({
      accountId,
      to: compose.to.trim(),
      cc: compose.cc.trim() || undefined,
      bcc: compose.bcc.trim() || undefined,
      subject: compose.subject,
      bodyText: compose.bodyText,
      attachments: composeAttachments(),
    });
    if (result?.ok) setPreview(result.preview);
    else setComposeNote(t('submissionHub.mail.previewFailed', {
      code: result && 'code' in result ? result.code : 'failed',
      message: result && 'message' in result ? result.message : '',
    }));
    setBusy('');
  }

  async function sendMail(): Promise<void> {
    if (!window.metis?.sendSubmissionMail || !accountId || busy) return;
    setBusy('send'); setComposeNote('');
    const result = await window.metis.sendSubmissionMail({
      projectId,
      caseId: caseItem.id,
      accountId,
      operationId,
      to: compose.to.trim(),
      cc: compose.cc.trim() || undefined,
      bcc: compose.bcc.trim() || undefined,
      subject: compose.subject,
      bodyText: compose.bodyText,
      attachments: composeAttachments(),
      confirmed: true,
    });
    if (result?.ok) {
      setComposeOpen(false);
      setPreview(null);
      setMessage(result.alreadySent ? t('submissionHub.mail.sentDuplicate') : t('submissionHub.mail.sentOk'));
      await loadData();
    } else {
      // 发送失败：保持弹层与 operationId 不变，用户重试不会产生第二封邮件。
      setComposeNote(t('submissionHub.mail.sendFailed', {
        code: result && 'code' in result ? result.code : 'failed',
        message: result && 'message' in result ? result.message : '',
      }));
    }
    setBusy('');
  }

  return (
    <div className="submissions-journal submissions-mail" data-testid="submissions-mail-section">
      <h3>{t('submissionHub.mail.title')}</h3>
      {loadError && <p className="submissions-gap__problem" role="alert">{t('submissionHub.mail.loadFailed')}</p>}
      <div className="submissions-mail__toolbar">
        <label>
          <span>{t('submissionHub.mail.accountLabel')}</span>
          <select value={accountId} aria-label={t('submissionHub.mail.accountLabel')}
            onChange={(event) => setAccountId(event.target.value)}>
            {accounts.length === 0 && <option value="">—</option>}
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>{account.label || account.user}（{account.host}）</option>
            ))}
          </select>
        </label>
        <button type="button" className="submissions-secondary" data-testid="submissions-mail-sync"
          disabled={!accountId || busy !== ''} onClick={() => void sync()}>
          {busy === 'sync' ? t('submissionHub.mail.syncing') : t('submissionHub.mail.syncInbox')}
        </button>
        <button type="button" className="submissions-primary" data-testid="submissions-mail-compose"
          disabled={accounts.length === 0} onClick={openCompose}>
          {t('submissionHub.mail.compose')}
        </button>
      </div>
      {accountsLoaded && accounts.length === 0 && (
        <p className="submissions-notice" role="status">{t('submissionHub.mail.noAccounts')}</p>
      )}
      {message && <p className="submissions-notice" role="status">{message}</p>}

      <h4 className="submissions-mail__subtitle">{t('submissionHub.mail.pendingTitle')}</h4>
      {pending.length === 0 && <p className="submissions-empty">{t('submissionHub.mail.pendingEmpty')}</p>}
      <ul className="submissions-mail__list" data-testid="submissions-mail-pending">
        {pending.map((item) => (
          <li key={item.id} className="submissions-mail__item">
            <div className="submissions-journal__meta">
              <strong>{item.subject || t('submissionHub.mail.noSubject')}</strong>
              <span className="submissions-badge">{t(`submissionHub.mail.classLabels.${item.classification}`)}</span>
            </div>
            <div className="submissions-journal__meta">
              <small>{item.fromAddr}</small>
              <small>{item.receivedAt ? new Date(item.receivedAt).toLocaleString() : '—'}</small>
            </div>
            {item.matchReason && <p><small>{t('submissionHub.mail.matchReason')}：{item.matchReason}</small></p>}
            <div className="submissions-package-actions">
              <button type="button" className="submissions-secondary" data-testid="submissions-mail-confirm"
                onClick={() => void confirmMatch(item.id)}>{t('submissionHub.mail.confirmMatch')}</button>
              <button type="button" className="submissions-secondary" data-testid="submissions-mail-reject"
                onClick={() => void rejectMatch(item.id)}>{t('submissionHub.mail.rejectMatch')}</button>
            </div>
          </li>
        ))}
      </ul>

      <h4 className="submissions-mail__subtitle">{t('submissionHub.mail.timelineTitle')}</h4>
      {timeline.length === 0 && <p className="submissions-empty">{t('submissionHub.mail.timelineEmpty')}</p>}
      <ul className="submissions-mail__list" data-testid="submissions-mail-timeline">
        {timeline.map((item) => (
          <li key={item.id} className="submissions-mail__item">
            <div className="submissions-journal__meta">
              <span className={`submissions-tier ${item.direction === 'out' ? 'ok' : ''}`}>
                {t(item.direction === 'in' ? 'submissionHub.mail.directionIn' : 'submissionHub.mail.directionOut')}
              </span>
              <strong>{item.subject || t('submissionHub.mail.noSubject')}</strong>
              <span className="submissions-badge">{t(`submissionHub.mail.classLabels.${item.classification}`)}</span>
              <small>{(item.receivedAt ?? item.sentAt) ? new Date((item.receivedAt ?? item.sentAt)!).toLocaleString() : '—'}</small>
            </div>
            {item.direction === 'in' && item.matchStatus === 'matched' && ROUNDABLE_CLASSIFICATIONS.includes(item.classification) && (
              <button type="button" className="submissions-secondary" data-testid="submissions-mail-to-round"
                disabled={busy !== ''} onClick={() => void toRound(item.id)}>
                {busy === 'round' ? t('submissionHub.working') : t('submissionHub.mail.toRound')}
              </button>
            )}
          </li>
        ))}
      </ul>

      {composeOpen && (
        <div className="outcomes-modal-backdrop" role="presentation">
          <div className="outcomes-modal submissions-mail__compose" role="dialog" aria-modal="true" aria-label={t('submissionHub.mail.composeTitle')}>
            <header><strong>{t('submissionHub.mail.composeTitle')}</strong><button type="button" onClick={() => setComposeOpen(false)} aria-label="关闭">×</button></header>
            <label>{t('submissionHub.mail.fieldTo')}
              <input className="settings-input" value={compose.to} aria-label={t('submissionHub.mail.fieldTo')}
                onChange={(event) => { setCompose((current) => ({ ...current, to: event.target.value })); setPreview(null); }} />
            </label>
            <label>{t('submissionHub.mail.fieldCc')}
              <input className="settings-input" value={compose.cc} aria-label={t('submissionHub.mail.fieldCc')}
                onChange={(event) => { setCompose((current) => ({ ...current, cc: event.target.value })); setPreview(null); }} />
            </label>
            <label>{t('submissionHub.mail.fieldBcc')}
              <input className="settings-input" value={compose.bcc} aria-label={t('submissionHub.mail.fieldBcc')}
                onChange={(event) => { setCompose((current) => ({ ...current, bcc: event.target.value })); setPreview(null); }} />
            </label>
            <label>{t('submissionHub.mail.fieldSubject')}
              <input className="settings-input" value={compose.subject} aria-label={t('submissionHub.mail.fieldSubject')}
                onChange={(event) => { setCompose((current) => ({ ...current, subject: event.target.value })); setPreview(null); }} />
            </label>
            <label>{t('submissionHub.mail.fieldBody')}
              <textarea rows={6} value={compose.bodyText} aria-label={t('submissionHub.mail.fieldBody')}
                onChange={(event) => { setCompose((current) => ({ ...current, bodyText: event.target.value })); setPreview(null); }} />
            </label>
            <label>{t('submissionHub.mail.fieldAttachments')}
              <textarea rows={2} value={compose.attachments} aria-label={t('submissionHub.mail.fieldAttachments')}
                onChange={(event) => { setCompose((current) => ({ ...current, attachments: event.target.value })); setPreview(null); }} />
            </label>
            <button type="button" className="submissions-secondary" data-testid="submissions-mail-preview-btn"
              disabled={busy !== '' || !compose.to.trim() || !compose.subject.trim()} onClick={() => void previewMail()}>
              {busy === 'preview' ? t('submissionHub.mail.previewing') : t('submissionHub.mail.preview')}
            </button>
            {preview && (
              <div className="submissions-mail__preview" data-testid="submissions-mail-preview">
                <strong>{t('submissionHub.mail.previewTitle')}</strong>
                <p><small>{t('submissionHub.mail.previewFrom')}：{preview.from}（{preview.accountLabel}）</small></p>
                <p><small>{t('submissionHub.mail.previewTo')}：{preview.to}</small></p>
                {preview.cc && <p><small>{t('submissionHub.mail.fieldCc')}：{preview.cc}</small></p>}
                <p><small>{t('submissionHub.mail.previewSmtp')}：{preview.smtp ? `${preview.smtp.host}:${preview.smtp.port}` : t('submissionHub.mail.previewSmtpUnknown')}</small></p>
                {preview.attachments.length > 0 && (
                  <p><small>{t('submissionHub.mail.previewAttachments')}：{preview.attachments.map((item) => item.filename).join('、')}</small></p>
                )}
              </div>
            )}
            {composeNote && <p className="submissions-notice" role="status">{composeNote}</p>}
            <footer>
              <button type="button" onClick={() => setComposeOpen(false)}>{t('submissionHub.mail.cancel')}</button>
              <button className="primary" type="button" data-testid="submissions-mail-send"
                disabled={!preview || busy !== ''} onClick={() => void sendMail()}>
                {busy === 'send' ? t('submissionHub.mail.sending') : t('submissionHub.mail.confirmSend')}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 投稿门户区（P3）：打开投稿页面、生成表单填写计划（auto/review 可执行，
 * 声明/认证/财务/法律/最终提交级只展示不执行）、执行勾选步骤（需确认）、
 * 最终提交登记与状态不明标记。
 */
function SubmissionPortalSection({ projectId, caseItem, onRefresh }: {
  projectId: string;
  caseItem: SubmissionCase;
  onRefresh: () => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [portalUrl, setPortalUrl] = useState('');
  const [session, setSession] = useState<PortalSession | null>(null);
  const [actions, setActions] = useState<PortalFieldAction[] | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Array<{ fieldKey: string; status: 'done' | 'skipped'; detail: string }> | null>(null);
  const [busy, setBusy] = useState<'' | 'open' | 'plan' | 'execute' | 'confirm' | 'uncertain'>('');
  const [message, setMessage] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [remoteId, setRemoteId] = useState('');
  const [receiptNote, setReceiptNote] = useState('');
  const [uncertainOpen, setUncertainOpen] = useState(false);
  const [uncertainReason, setUncertainReason] = useState('');

  const failText = useCallback((key: string, result: { code: string; message: string } | null): string =>
    t(key, { code: result ? result.code : 'failed', message: result ? result.message : '' }), [t]);

  async function openPortal(): Promise<void> {
    if (!window.metis?.openSubmissionPortal || busy) return;
    setBusy('open'); setMessage('');
    const result = await window.metis.openSubmissionPortal({ projectId, caseId: caseItem.id, portalUrl: portalUrl.trim() || undefined });
    if (result?.ok) setSession(result.session);
    else setMessage(failText('submissionHub.portal.openFailed', result ?? null));
    setBusy('');
  }

  async function plan(): Promise<void> {
    if (!window.metis?.planSubmissionPortalFill || busy) return;
    setBusy('plan'); setMessage(''); setResults(null);
    const result = await window.metis.planSubmissionPortalFill({ projectId, caseId: caseItem.id });
    if (result?.ok) {
      setActions(result.actions);
      // auto 级默认勾选；review 级需用户逐条勾选（执行时再整体确认）。
      const initial: Record<string, boolean> = {};
      for (const action of result.actions) {
        if (isPortalActionAutomatable(action.safetyLevel)) initial[action.fieldKey] = action.safetyLevel === 'auto';
      }
      setChecked(initial);
    } else {
      setMessage(failText('submissionHub.portal.planFailed', result && 'code' in result ? result : null));
    }
    setBusy('');
  }

  async function execute(): Promise<void> {
    const selectedActions = (actions ?? []).filter((action) => checked[action.fieldKey] && isPortalActionAutomatable(action.safetyLevel));
    if (!window.metis?.executeSubmissionPortalSteps || selectedActions.length === 0 || busy) return;
    // review 级步骤必须经用户显式确认（confirmed: true）才允许执行。
    if (!window.confirm(t('submissionHub.portal.executeConfirm'))) return;
    setBusy('execute'); setMessage('');
    const result = await window.metis.executeSubmissionPortalSteps({ projectId, caseId: caseItem.id, actions: selectedActions, confirmed: true });
    if (result?.ok) setResults(result.results);
    else setMessage(failText('submissionHub.portal.executeFailed', result ?? null));
    setBusy('');
  }

  async function confirmSubmitted(): Promise<void> {
    if (!window.metis?.confirmSubmissionPortalSubmitted || busy) return;
    setBusy('confirm'); setMessage('');
    const result = await window.metis.confirmSubmissionPortalSubmitted({
      projectId,
      caseId: caseItem.id,
      remoteSubmissionId: remoteId.trim() || undefined,
      receiptNote: receiptNote.trim() || undefined,
    });
    if (result?.ok) {
      setConfirmOpen(false);
      setMessage(t('submissionHub.portal.confirmOk'));
      await onRefresh();
    } else {
      setMessage(failText('submissionHub.portal.confirmFailed', result ?? null));
    }
    setBusy('');
  }

  async function markUncertain(): Promise<void> {
    if (!window.metis?.markSubmissionPortalUncertain || !uncertainReason.trim() || busy) return;
    setBusy('uncertain'); setMessage('');
    const result = await window.metis.markSubmissionPortalUncertain({ projectId, caseId: caseItem.id, reason: uncertainReason.trim() });
    if (result?.ok) {
      setUncertainOpen(false);
      setUncertainReason('');
      setMessage(t('submissionHub.portal.uncertainDone'));
      await onRefresh();
    } else {
      setMessage(failText('submissionHub.portal.uncertainFailed', result ?? null));
    }
    setBusy('');
  }

  const executableCount = (actions ?? []).filter((action) => checked[action.fieldKey] && isPortalActionAutomatable(action.safetyLevel)).length;

  return (
    <div className="submissions-journal submissions-portal" data-testid="submissions-portal-section">
      <h3>{t('submissionHub.portal.title')}</h3>
      <div className="submissions-portal__toolbar">
        <input className="settings-input" value={portalUrl} placeholder={t('submissionHub.portal.portalUrlOptional')}
          aria-label={t('submissionHub.portal.portalUrlOptional')}
          onChange={(event) => setPortalUrl(event.target.value)} />
        <button type="button" className="submissions-primary" data-testid="submissions-portal-open"
          disabled={busy !== ''} onClick={() => void openPortal()}>
          {busy === 'open' ? t('submissionHub.portal.opening') : t('submissionHub.portal.openPortal')}
        </button>
      </div>
      {session && (
        <div className="submissions-portal__session" data-testid="submissions-portal-session">
          <div className="submissions-journal__meta">
            <span className="submissions-badge">{t(`submissionHub.portal.platformLabels.${session.platform}`)}</span>
            <span className={`submissions-tier ${session.loggedIn === true ? 'ok' : session.loggedIn === false ? 'bad' : ''}`}>
              {session.loggedIn === true ? t('submissionHub.portal.loginYes') : session.loggedIn === false ? t('submissionHub.portal.loginNo') : t('submissionHub.portal.loginUnknown')}
            </span>
          </div>
          <p><small>{t('submissionHub.portal.currentUrl')}：{session.currentUrl || session.portalUrl}</small></p>
          {session.pageTitle && <p><small>{t('submissionHub.portal.pageTitleLabel')}：{session.pageTitle}</small></p>}
          {session.loggedIn === false && <p className="submissions-notice">{t('submissionHub.portal.loginHint')}</p>}
        </div>
      )}
      <div className="submissions-package-actions">
        <button type="button" className="submissions-secondary" data-testid="submissions-portal-plan"
          disabled={busy !== ''} onClick={() => void plan()}>
          {busy === 'plan' ? t('submissionHub.portal.planning') : t('submissionHub.portal.plan')}
        </button>
      </div>
      {actions !== null && (
        <div className="submissions-portal__plan" data-testid="submissions-portal-plan-list">
          {actions.length === 0 && <p className="submissions-empty">{t('submissionHub.portal.planEmpty')}</p>}
          <ul className="submissions-portal__list">
            {actions.map((action) => {
              const automatable = isPortalActionAutomatable(action.safetyLevel);
              return (
                <li key={action.fieldKey} className="submissions-portal__item">
                  <div className="submissions-journal__meta">
                    {automatable ? (
                      <label className="submissions-portal__check">
                        <input type="checkbox" data-testid="submissions-portal-check"
                          checked={Boolean(checked[action.fieldKey])}
                          onChange={(event) => setChecked((current) => ({ ...current, [action.fieldKey]: event.target.checked }))} />
                        <strong>{action.label || action.fieldKey}</strong>
                      </label>
                    ) : (
                      <strong>{action.label || action.fieldKey}</strong>
                    )}
                    <span className={`submissions-badge ${automatable ? '' : 'warn'}`}>{t(`submissionHub.portal.safetyLabels.${action.safetyLevel}`)}</span>
                    {!automatable && <small>{t('submissionHub.portal.manualOnly')}</small>}
                  </div>
                  <p className="submissions-portal__value">{action.value || t('submissionHub.portal.valueEmpty')}</p>
                  <p><small>{action.reason}</small></p>
                </li>
              );
            })}
          </ul>
          <button type="button" className="submissions-primary" data-testid="submissions-portal-execute"
            disabled={busy !== '' || executableCount === 0} onClick={() => void execute()}>
            {busy === 'execute' ? t('submissionHub.portal.executing') : t('submissionHub.portal.execute')}
          </button>
        </div>
      )}
      {results && results.length > 0 && (
        <ul className="submissions-portal__results" data-testid="submissions-portal-results">
          {results.map((item) => (
            <li key={item.fieldKey}>
              <span className={`submissions-tier ${item.status === 'done' ? 'ok' : ''}`}>
                {item.status === 'done' ? t('submissionHub.portal.resultDone') : t('submissionHub.portal.resultSkipped')}
              </span>
              <span>{item.fieldKey}</span>
              {item.detail && <small>{item.detail}</small>}
            </li>
          ))}
        </ul>
      )}
      <div className="submissions-package-actions">
        <button type="button" className="submissions-primary" data-testid="submissions-portal-confirm"
          disabled={busy !== ''} onClick={() => setConfirmOpen(true)}>
          {t('submissionHub.portal.confirmSubmitted')}
        </button>
        <button type="button" className="submissions-secondary" data-testid="submissions-portal-uncertain"
          disabled={busy !== ''} onClick={() => setUncertainOpen(true)}>
          {t('submissionHub.portal.markUncertain')}
        </button>
      </div>
      {message && <p className="submissions-notice" role="status">{message}</p>}

      {confirmOpen && (
        <div className="outcomes-modal-backdrop" role="presentation">
          <div className="outcomes-modal" role="dialog" aria-modal="true" aria-label={t('submissionHub.portal.confirmTitle')}>
            <header><strong>{t('submissionHub.portal.confirmTitle')}</strong><button type="button" onClick={() => setConfirmOpen(false)} aria-label="关闭">×</button></header>
            <label>{t('submissionHub.portal.remoteId')}
              <input className="settings-input" value={remoteId} aria-label={t('submissionHub.portal.remoteId')}
                onChange={(event) => setRemoteId(event.target.value)} />
            </label>
            <label>{t('submissionHub.portal.receiptNote')}
              <textarea rows={3} value={receiptNote} aria-label={t('submissionHub.portal.receiptNote')}
                onChange={(event) => setReceiptNote(event.target.value)} />
            </label>
            <footer>
              <button type="button" onClick={() => setConfirmOpen(false)}>{t('submissionHub.portal.cancel')}</button>
              <button className="primary" type="button" data-testid="submissions-portal-confirm-submit"
                disabled={busy !== ''} onClick={() => void confirmSubmitted()}>
                {busy === 'confirm' ? t('submissionHub.working') : t('submissionHub.portal.confirmAction')}
              </button>
            </footer>
          </div>
        </div>
      )}

      {uncertainOpen && (
        <div className="outcomes-modal-backdrop" role="presentation">
          <div className="outcomes-modal" role="dialog" aria-modal="true" aria-label={t('submissionHub.portal.uncertainTitle')}>
            <header><strong>{t('submissionHub.portal.uncertainTitle')}</strong><button type="button" onClick={() => setUncertainOpen(false)} aria-label="关闭">×</button></header>
            <label>{t('submissionHub.portal.uncertainReason')}
              <textarea rows={3} value={uncertainReason} aria-label={t('submissionHub.portal.uncertainReason')}
                onChange={(event) => setUncertainReason(event.target.value)} />
            </label>
            <footer>
              <button type="button" onClick={() => setUncertainOpen(false)}>{t('submissionHub.portal.cancel')}</button>
              <button className="primary" type="button" data-testid="submissions-portal-uncertain-submit"
                disabled={busy !== '' || !uncertainReason.trim()} onClick={() => void markUncertain()}>
                {busy === 'uncertain' ? t('submissionHub.working') : t('submissionHub.portal.uncertainAction')}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

function CreateCaseDialog({ projectId, initialMode = 'specify', seriesId = null, onClose, onCreated }: {
  projectId: string | null;
  /** CASE C 换刊入口会以 match 模式打开并沿用同一 Submission Series。 */
  initialMode?: 'match' | 'specify';
  seriesId?: string | null;
  onClose: () => void;
  onCreated: (caseId: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [outcomes, setOutcomes] = useState<OutcomeSummaryLite[]>([]);
  const [outcomeId, setOutcomeId] = useState('');
  const [mode, setMode] = useState<'match' | 'specify'>(initialMode);
  const [journal, setJournal] = useState('');
  const [articleType, setArticleType] = useState('');
  const [error, setError] = useState('');
  const [categories, setCategories] = useState<SubmissionVenueCategory[]>([]);
  const [language, setLanguage] = useState<'zh' | 'en' | 'any'>('any');
  const criteria: TargetingCriteria | null = mode === 'match' && categories.length > 0
    ? { categories, language, notes: '' }
    : null;

  useEffect(() => {
    void (async () => {
      if (!projectId || !window.metis?.listOutcomes) return;
      const rows = await window.metis.listOutcomes({ projectId, query: '' });
      setOutcomes(rows);
      if (rows.length > 0) setOutcomeId(rows[0]!.id);
    })();
  }, [projectId]);

  async function submit(): Promise<void> {
    if (!projectId || !window.metis?.createSubmissionCase || !outcomeId) return;
    const outcome = outcomes.find((item) => item.id === outcomeId);
    if (!outcome) return;
    if (mode === 'specify' && !journal.trim()) return;
    const result = await window.metis.createSubmissionCase({
      projectId,
      title: outcome.title,
      sourceOutcomeId: outcome.id,
      sourceOutcomeVersion: outcome.currentVersion,
      targetJournalName: mode === 'specify' ? journal.trim() : '',
      articleType: (articleType || null) as SubmissionCase['articleType'],
      initialStatus: mode === 'specify' ? 'JOURNAL_SELECTED' : 'TARGETING',
      targetingCriteria: criteria,
      seriesId,
    });
    if (result && 'ok' in result && result.ok === false && result.code === 'duplicate_active') {
      setError(`${t('submissionHub.duplicateActive')}（${t('submissionHub.duplicateActiveJournal')}: ${result.activeJournal || t('submissionHub.noJournal')}）. ${t('submissionHub.duplicateActiveHint')}`);
      return;
    }
    // createCase resolves with { series, submissionCase } (no `ok` flag); null means rejection.
    if (result && 'submissionCase' in result) {
      await onCreated(result.submissionCase.id);
    }
  }

  return (
    <div className="outcomes-modal-backdrop" role="presentation">
      <form className="outcomes-modal" role="dialog" aria-modal="true" aria-label={t('submissionHub.createTitle')}
        onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <header><strong>{t('submissionHub.createTitle')}</strong><button type="button" onClick={onClose} aria-label="关闭">×</button></header>
        <label>{t('submissionHub.createOutcome')}
          <select value={outcomeId} onChange={(event) => setOutcomeId(event.target.value)}>
            {outcomes.map((item) => <option key={item.id} value={item.id}>{item.title}（{item.kind}）</option>)}
          </select>
        </label>
        <fieldset className="submissions-create-mode">
          <label>
            <input type="radio" name="submission-mode" checked={mode === 'specify'} onChange={() => setMode('specify')} />
            {t('submissionHub.createModeSpecify')}
          </label>
          {mode === 'specify' && (
            <>
              <input className="settings-input" value={journal} placeholder={t('submissionHub.createJournalPlaceholder')}
                aria-label={t('submissionHub.createJournalPlaceholder')}
                onChange={(event) => setJournal(event.target.value)} />
              <label>{t('submissionHub.createArticleType')}
                <select value={articleType} aria-label={t('submissionHub.createArticleType')}
                  onChange={(event) => setArticleType(event.target.value)}>
                  <option value="">{t('submissionHub.articleTypes.none')}</option>
                  {['research_article', 'review', 'short_communication', 'letter', 'case_report', 'conference_paper', 'thesis_chapter', 'other'].map((kind) => (
                    <option key={kind} value={kind}>{t(`submissionHub.articleTypes.${kind}`)}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label>
            <input type="radio" name="submission-mode" checked={mode === 'match'} onChange={() => setMode('match')} />
            {t('submissionHub.createModeMatch')}
          </label>
          {mode === 'match' && <>
            <p className="submissions-create-hint">{t('submissionHub.createModeMatchHint')}</p>
            <div className="submissions-criteria" role="group" aria-label={t('submissionHub.targetingTitle')}>
              {VENUE_CATEGORY_KEYS.map((category) => (
                <label key={category} className="submissions-criteria__item">
                  <input type="checkbox" checked={categories.includes(category)}
                    onChange={(event) => setCategories((current) => event.target.checked ? [...current, category] : current.filter((item) => item !== category))} />
                  {t(`submissionHub.venueCategories.${category}`)}
                </label>
              ))}
            </div>
            <label>{t('submissionHub.targetingLanguage')}
              <select value={language} aria-label={t('submissionHub.targetingLanguage')} onChange={(event) => setLanguage(event.target.value as 'zh' | 'en' | 'any')}>
                <option value="any">{t('submissionHub.languageAny')}</option>
                <option value="zh">{t('submissionHub.languageZh')}</option>
                <option value="en">{t('submissionHub.languageEn')}</option>
              </select>
            </label>
          </>}
        </fieldset>
        {error && <p className="submissions-notice" role="alert">{error}</p>}
        <footer>
          <button type="button" onClick={onClose}>{t('submissionHub.createCancel')}</button>
          <button className="primary" type="submit" disabled={mode === 'specify' && !journal.trim()}>{t('submissionHub.createConfirm')}</button>
        </footer>
      </form>
    </div>
  );
}
