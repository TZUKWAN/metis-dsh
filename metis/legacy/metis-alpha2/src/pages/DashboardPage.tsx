/**
 * Research Dashboard — Academic Instrument Information Architecture.
 *
 * 5 core research metrics + compact secondary data + charts + actionable sections.
 * Restrained academic palette. No rainbow, no capsules, no generic AI copy.
 * Data-first layout: metrics lead, chrome recedes.
 */

import { useMemo, useState, useEffect, useCallback } from 'react';
import { FileText } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
  LineChart, Line, CartesianGrid,
} from 'recharts';
import { useMetisStore, type ReadStatus } from '../store';
import { useTranslation } from '../i18n';
import type { Page } from '../store';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import { SafeMarkdown } from '../presentation/SafeMarkdown';
import { Button } from '../components/ui';
import './DashboardPage.css';

const CHART_VAR_NAMES = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--chart-7', '--chart-8'];
// Initial/pre-read state references the tokens directly so no hex palette is duplicated here.
const CHART_FALLBACKS = CHART_VAR_NAMES.map((name) => `var(${name})`);

function useChartColors(): string[] {
  const [colors, setColors] = useState<string[]>(CHART_FALLBACKS);
  useEffect(() => {
    function readColors() {
      const s = getComputedStyle(document.documentElement);
      setColors(CHART_VAR_NAMES.map((name, i) => {
        const v = s.getPropertyValue(name).trim();
        return v || CHART_FALLBACKS[i]!;
      }));
    }
    readColors();
    const observer = new MutationObserver(readColors);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return colors;
}

/** A single core metric card with accent bar. */
function CoreMetric({
  label, value, sub, accentColor, progress, onClick, clickLabel,
}: {
  label: string; value: React.ReactNode; sub: string;
  accentColor?: string; progress?: number; onClick?: () => void; clickLabel?: string;
}) {
  const pct = Math.max(0, Math.min(1, progress ?? 0));
  return (
    <div
      className={`dash-metric${onClick ? ' dash-metric--clickable' : ''}`}
      onClick={onClick}
      onKeyDown={onClick ? (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? clickLabel : undefined}
    >
      <div className="dash-metric__accent" style={{ background: accentColor ?? 'var(--chart-1)' }} />
      <div className="dash-metric__label">{label}</div>
      <div className="dash-metric__value">{value}</div>
      <div className="dash-metric__sub">{sub}</div>
      {progress !== undefined && (
        <div className="dash-metric__progress" aria-hidden="true">
          <div className="dash-metric__progress-fill stat-card-progress-fill" style={{ width: `${pct * 100}%`, background: accentColor }} />
        </div>
      )}
    </div>
  );
}

/** Compact secondary data cell. */
function SecondaryStat({ label, value, onClick }: { label: string; value: string | number; onClick?: () => void }) {
  return (
    <div className={`dash-stat${onClick ? ' dash-stat--clickable' : ''}`} onClick={onClick}
      onKeyDown={onClick ? (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}>
      <div className="dash-stat__label">{label}</div>
      <div className="dash-stat__value">{value}</div>
    </div>
  );
}

/** Section wrapper with header + body slots.
 *  Keeps the legacy `.chart-card` class so existing page tests can anchor sections.
 */
function DashSection({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`dash-section chart-card ${className ?? ''}`}>
      <div className="dash-section__header"><h3>{title}</h3></div>
      <div className="dash-section__body">{children}</div>
    </div>
  );
}

/** A clickable list item with color marker.
 *  The outer `<li>` keeps its implicit `listitem` role for list semantics;
 *  the inner trigger carries the `button` role and any accessible name.
 */
function ListItem({ markerColor, text, meta, onClick, ariaLabel }: {
  markerColor?: string; text: string; meta?: string; onClick: () => void; ariaLabel?: string;
}) {
  return (
    <li className="dash-list-item" role="listitem">
      <div
        className="dash-list-item__trigger"
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
        aria-label={ariaLabel}
      >
        <span className="dash-list-item__marker" style={{ background: markerColor ?? 'var(--text-muted)' }} />
        <span className="dash-list-item__text">{text}</span>
        {meta && <span className="dash-list-item__meta">{meta}</span>}
      </div>
    </li>
  );
}

export default function DashboardPage({ onNavigate }: { onNavigate?: (page: Page) => void }) {
  const { papers, notes, experiments, setSelectedPaperId, selectNote, setExperimentSearchQuery, setPaperFilter } = useMetisStore();
  const { t, locale } = useTranslation();
  const chartColors = useChartColors();
  const [now] = useState(() => Date.now());
  // AI reading report over the papers read this week (main-process one-shot).
  const [reportResult, setReportResult] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  // Project artifact stats for the overview card (research repository).
  const [artifactStats, setArtifactStats] = useState<{ total: number; pending: number; verified: number } | null>(null);
  const activeProjectId = useResearchWorkspaceStore((state) => state.activeProjectId);

  useEffect(() => {
    if (!activeProjectId || !window.metis?.artifactListByProject) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stats when no project is active
      setArtifactStats(null);
      return;
    }
    let cancelled = false;
    void window.metis.artifactListByProject(activeProjectId).then((result) => {
      if (cancelled) return;
      const items = (result.items ?? []) as Array<{ reviewStatus?: string }>;
      setArtifactStats({
        total: items.length,
        pending: items.filter((i) => i.reviewStatus === 'pending').length,
        verified: items.filter((i) => i.reviewStatus === 'verified').length,
      });
    }).catch(() => { /* stats card is best-effort */ });
    return () => { cancelled = true; };
  }, [activeProjectId]);

  /** Generate a reading report for the papers read this week. */
  const runReadingReport = async () => {
    const metis = window.metis;
    if (reportLoading || !metis?.aiSynthesis) return;
    const weekPapers = papers.filter((p) => !p.archived && p.readStatus === 'read' && p.readAt && p.readAt >= now - 7 * 86400000);
    if (weekPapers.length === 0) return;
    setReportLoading(true);
    setReportResult(null);
    try {
      const result = await metis.aiSynthesis({
        mode: 'report',
        papers: weekPapers.map((p) => ({
          title: p.title,
          authors: p.authors,
          year: p.year,
          venue: p.venue,
          abstract: p.abstract ?? '',
        })),
      });
      if (result.ok && result.text) {
        setReportResult(result.text);
      }
    } catch { /* report generation failure leaves the dashboard untouched */ }
    finally {
      setReportLoading(false);
    }
  };

  /** Save the reading report as a literature note linked to this week's papers. */
  const saveReportAsNote = async () => {
    if (!reportResult) return;
    const weekPapers = papers.filter((p) => !p.archived && p.readStatus === 'read' && p.readAt && p.readAt >= now - 7 * 86400000);
    const noteId = `note_report_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    await useMetisStore.getState().addNote({
      id: noteId,
      title: t('dashboard.readingReportNoteTitle'),
      content: reportResult,
      tags: [t('dashboard.readingReportNoteTitle')],
      linkedPaperIds: weekPapers.map((p) => p.id),
      linkedNoteIds: [],
      starred: false,
      updatedAt: Date.now(),
    });
    setReportResult(null);
  };

  const openPaper = useCallback((paperId: string) => {
    setSelectedPaperId(paperId); onNavigate?.('pdf');
  }, [setSelectedPaperId, onNavigate]);
  const openNote = useCallback((noteId: string) => {
    selectNote(noteId); onNavigate?.('notes');
  }, [selectNote, onNavigate]);
  const openExperiment = useCallback((expName: string) => {
    setExperimentSearchQuery(expName); onNavigate?.('experiments');
  }, [setExperimentSearchQuery, onNavigate]);
  const goPapers = useCallback((filter?: Parameters<typeof setPaperFilter>[0]) => {
    if (filter) setPaperFilter(filter);
    onNavigate?.('pdf');
  }, [setPaperFilter, onNavigate]);
  const goNotes = useCallback(() => onNavigate?.('notes'), [onNavigate]);
  const goExperiments = useCallback(() => onNavigate?.('experiments'), [onNavigate]);

  const statusColors = useMemo(() => {
    const s = getComputedStyle(document.documentElement);
    return {
      unread: s.getPropertyValue('--text-muted').trim() || 'var(--text-muted)',
      reading: s.getPropertyValue('--chart-1').trim() || 'var(--chart-1)',
      read: s.getPropertyValue('--status-completed').trim() || 'var(--status-completed)',
      skimmed: s.getPropertyValue('--accent-warm').trim() || 'var(--accent-warm)',
    };
  }, []);

  const stats = useMemo(() => {
    const activePapers = papers.filter((p) => !p.archived);
    const archivedPapers = papers.length - activePapers.length;
    const totalPapers = activePapers.length;
    const readPapers = activePapers.filter((p) => p.readStatus === 'read').length;
    const unreadPapers = activePapers.filter((p) => p.readStatus === 'unread').length;
    const avgRating = totalPapers > 0 ? (activePapers.reduce((s, p) => s + p.rating, 0) / totalPapers).toFixed(1) : '0.0';
    const totalTags = new Set(activePapers.flatMap((p) => p.tags)).size;
    const totalNotes = notes.length;
    const totalExperiments = experiments.length;
    const completedExperiments = experiments.filter((e) => e.status === 'completed').length;
    const runningExperiments = experiments.filter((e) => e.status === 'running').length;
    const papersReadThisWeek = activePapers.filter((p) => p.readStatus === 'read' && p.readAt && p.readAt >= now - 7 * 86400000).length;
    const recentActivity = papers.filter((p) => p.addedAt >= now - 7 * 86400000).length
      + notes.filter((n) => n.updatedAt >= now - 7 * 86400000).length
      + experiments.filter((e) => (e.createdAt ?? 0) >= now - 7 * 86400000).length;
    const highRatedPapers = activePapers.filter((p) => p.rating >= 4).length;
    const highPriorityPapers = activePapers.filter((p) => p.priority === 'high').length;
    const todayDate = new Date(now).setHours(0, 0, 0, 0);
    const activeTodoPapers = activePapers.filter((p) => p.readStatus !== 'read');
    const todayDeadlines = activeTodoPapers.filter((p) => { if (!p.deadline) return false; return new Date(p.deadline).setHours(0, 0, 0, 0) === todayDate; }).length;
    const upcomingDeadlines = activeTodoPapers.filter((p) => { if (!p.deadline) return false; return new Date(p.deadline).setHours(0, 0, 0, 0) > todayDate; }).length;
    const overdueDeadlines = activeTodoPapers.filter((p) => { if (!p.deadline) return false; return new Date(p.deadline).setHours(0, 0, 0, 0) < todayDate; }).length;
    const starredItems = activePapers.filter((p) => p.starred).length + notes.filter((n) => n.starred).length + experiments.filter((e) => e.starred).length;
    const avgReadingProgress = totalPapers > 0 ? Math.round(activePapers.reduce((s, p) => s + (p.readingProgress ?? 0), 0) / totalPapers) : 0;
    const dateKey = (ts: number) => {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const readDates = new Set(papers.filter((p) => p.readStatus === 'read' && p.readAt).map((p) => dateKey(p.readAt!)));
    const readingCalendar = new Map<string, number>();
    for (const p of papers) { if (p.readStatus === 'read' && p.readAt) readingCalendar.set(dateKey(p.readAt), (readingCalendar.get(dateKey(p.readAt)) ?? 0) + 1); }
    const readingStreak = (() => { let streak = 0; const d = new Date(now); while (readDates.has(dateKey(d.getTime()))) { streak += 1; d.setDate(d.getDate() - 1); } return streak; })();
    return { totalPapers, readPapers, unreadPapers, avgRating, totalTags, totalNotes, totalExperiments, completedExperiments, runningExperiments, papersReadThisWeek, recentActivity, highRatedPapers, highPriorityPapers, todayDeadlines, upcomingDeadlines, overdueDeadlines, starredItems, readingStreak, readingCalendar, avgReadingProgress, archivedPapers };
  }, [papers, notes, experiments, now]);

  const tagData = useMemo(() => {
    const tagCounts = new Map<string, number>();
    for (const paper of papers) for (const tag of paper.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    return [...tagCounts.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 8);
  }, [papers]);

  const tagCloud = useMemo(() => {
    const tagCounts = new Map<string, number>();
    for (const paper of papers) for (const tag of paper.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    const max = Math.max(1, ...tagCounts.values());
    return [...tagCounts.entries()].map(([name, count]) => ({ name, count, weight: count / max })).sort((a, b) => a.name.localeCompare(b.name));
  }, [papers]);

  const readStatusData = useMemo(() => {
    const counts: Record<ReadStatus, number> = { unread: 0, reading: 0, read: 0, skimmed: 0 };
    for (const paper of papers) { if (!paper.archived) counts[paper.readStatus]++; }
    return Object.entries(counts).filter(([, v]) => v > 0).map(([name, value]) => ({ name, value }));
  }, [papers]);

  const yearData = useMemo(() => {
    const yc = new Map<number, number>();
    for (const paper of papers) yc.set(paper.year, (yc.get(paper.year) ?? 0) + 1);
    return [...yc.entries()].sort((a, b) => a[0] - b[0]).map(([year, count]) => ({ year: String(year), count }));
  }, [papers]);

  const activityData = useMemo(() => {
    const last7Days: Array<{ day: string; papers: number; notes: number; experiments: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const ds = now - i * 86400000, de = ds + 86400000;
      last7Days.push({
        day: new Date(ds).toLocaleDateString('en', { weekday: 'short' }),
        papers: papers.filter((p) => p.addedAt >= ds && p.addedAt < de).length,
        notes: notes.filter((n) => n.updatedAt >= ds && n.updatedAt < de).length,
        experiments: experiments.filter((e) => (e.createdAt ?? 0) >= ds && (e.createdAt ?? 0) < de).length,
      });
    }
    return last7Days;
  }, [papers, notes, experiments, now]);

  const readingActivityData = useMemo(() => {
    const last7Days: Array<{ day: string; read: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const ds = now - i * 86400000, de = ds + 86400000;
      last7Days.push({ day: new Date(ds).toLocaleDateString('en', { weekday: 'short' }), read: papers.filter((p) => p.readAt && p.readAt >= ds && p.readAt < de).length });
    }
    return last7Days;
  }, [papers, now]);

  const readingCalendarDays = useMemo(() => {
    const days: { date: string; count: number; label: string }[] = [];
    const today = new Date(now);
    for (let i = 29; i >= 0; i -= 1) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      days.push({ date, count: stats.readingCalendar.get(date) ?? 0, label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) });
    }
    return days;
  }, [stats.readingCalendar, now]);

  const recentPapers = useMemo(() => [...papers].sort((a, b) => b.addedAt - a.addedAt).slice(0, 5), [papers]);
  const unreadPapers = useMemo(() => papers.filter((p) => !p.archived && p.readStatus === 'unread'), [papers]);
  const recentlyReadPapers = useMemo(() => [...papers].filter((p) => p.readStatus === 'read' && p.readAt && p.readAt > 0).sort((a, b) => (b.readAt ?? 0) - (a.readAt ?? 0)).slice(0, 5), [papers]);
  const recentNotes = useMemo(() => [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5), [notes]);
  const recentExperiments = useMemo(() => [...experiments].sort((a, b) => b.createdAt - a.createdAt).slice(0, 5), [experiments]);
  const favoriteItems = useMemo(() => {
    const items: Array<{ id: string; type: 'paper' | 'note' | 'experiment'; title: string; onClick: () => void; ariaLabel: string }> = [];
    for (const p of papers) if (p.starred) items.push({ id: p.id, type: 'paper', title: p.title, onClick: () => openPaper(p.id), ariaLabel: `paper: ${p.title}` });
    for (const n of notes) if (n.starred) items.push({ id: n.id, type: 'note', title: n.title, onClick: () => openNote(n.id), ariaLabel: `note: ${n.title}` });
    for (const e of experiments) if (e.starred) items.push({ id: e.id, type: 'experiment', title: e.name, onClick: () => openExperiment(e.name), ariaLabel: `experiment: ${e.name}` });
    return items.slice(0, 10);
  }, [papers, notes, experiments, openPaper, openNote, openExperiment]);

  const deadlineAlerts = useMemo(() => {
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    return papers.filter((p) => !p.archived && p.deadline && p.readStatus !== 'read')
      .map((p) => { const d = new Date(p.deadline!); d.setHours(0, 0, 0, 0); const diff = Math.round((d.getTime() - today.getTime()) / 86400000); return { paper: p, diff, status: diff < 0 ? 'overdue' as const : diff === 0 ? 'today' as const : 'upcoming' as const }; })
      .filter((a) => a.status !== 'upcoming' || a.diff <= 7).sort((a, b) => a.diff - b.diff).slice(0, 10);
  }, [papers, now]);

  const isEmpty = stats.totalPapers === 0 && stats.totalNotes === 0 && stats.totalExperiments === 0;

  return (
    <div className="dash-page">
      <div className="dash-page-header">
        <h2>{t('dashboard.pageTitle')}</h2>
        {!isEmpty && <p>{t('dashboard.statPapersNeedAttention').replace('{count}', String(stats.unreadPapers))} &middot; {stats.papersReadThisWeek} {t('dashboard.statReadThisWeek')}</p>}
        {stats.papersReadThisWeek > 0 && (
          <Button
            variant="secondary"
            size="sm"
            data-testid="dashboard-reading-report"
            disabled={reportLoading}
            onClick={() => void runReadingReport()}
            style={{ marginTop: 4 }}
          >
            {reportLoading ? t('dashboard.readingReportLoading') : t('dashboard.readingReport')}
          </Button>
        )}
      </div>

      {/* AI reading report result */}
      {reportResult && (
        <div className="modal-overlay" onClick={() => setReportResult(null)}>
          <div className="modal modal-wide" data-testid="reading-report-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t('dashboard.readingReportTitle')}</h3>
            <div style={{ maxHeight: '55vh', overflowY: 'auto', marginTop: 12, fontSize: 13, lineHeight: 1.7 }}>
              <SafeMarkdown content={reportResult} uiMode="normal" locale={locale} />
            </div>
            <div className="modal-actions" style={{ marginTop: 16 }}>
              <Button variant="primary" data-testid="reading-report-save-note" onClick={() => void saveReportAsNote()}>
                {t('dashboard.readingReportSaveNote')}
              </Button>
              <Button variant="secondary" onClick={() => setReportResult(null)}>{t('common.close')}</Button>
            </div>
          </div>
        </div>
      )}

      {isEmpty && (
        <div className="dash-empty">
          <div className="dash-empty__icon">
            <FileText size={22} strokeWidth={1.5} />
          </div>
          <h3>{t('dashboard.emptyTitle')}</h3>
          <p>{t('dashboard.emptyDescription')}</p>
          <div className="dash-actions" style={{ marginTop: 8 }}>
            <Button variant="primary" onClick={() => onNavigate?.('pdf')}>{t('dashboard.actionOpenPapers')}</Button>
            <Button variant="secondary" onClick={() => onNavigate?.('notes')}>{t('dashboard.actionOpenNotes')}</Button>
          </div>
        </div>
      )}

      {/* ── 5 Core Metrics ── */}
      <div className="stat-grid dash-metrics-primary">
            <CoreMetric
              label={t('dashboard.statTotalPapers')} value={stats.totalPapers}
              sub={`${stats.readPapers} ${t('dashboard.statFullyRead', { count: stats.readPapers })} · ${stats.unreadPapers} ${t('dashboard.statPapersNeedAttention')}`}
              accentColor={chartColors[0]} onClick={() => goPapers()} clickLabel={t('dashboard.actionOpenPapers')}
            />
            <CoreMetric
              label={t('dashboard.statReadThisWeek')} value={String(stats.papersReadThisWeek)}
              sub={t('dashboard.statLast7Days')}
              accentColor={chartColors[5]} progress={0}
              onClick={() => goPapers({ readStatus: 'read', readWithinDays: 7 })}
              clickLabel={t('dashboard.statReadThisWeek')}
            />
            <CoreMetric
              label={t('dashboard.statExperiments')} value={stats.totalExperiments}
              sub={`${stats.runningExperiments} ${t('experiments.statusRunning')} · ${stats.completedExperiments} ${t('dashboard.statCompleted', { count: stats.completedExperiments })}`}
              accentColor={chartColors[3]} onClick={stats.totalExperiments > 0 ? goExperiments : undefined}
              clickLabel={t('dashboard.statExperiments')}
            />
            <CoreMetric
              label={t('dashboard.statRecentActivity')} value={stats.recentActivity}
              sub={t('dashboard.statLast7Days')}
              accentColor={chartColors[2]}
            />
            <CoreMetric
              label={t('dashboard.sectionNeedAttention')} value={stats.overdueDeadlines + stats.todayDeadlines}
              sub={`${stats.overdueDeadlines} ${t('dashboard.statOverdueDeadlinesSub')} · ${stats.todayDeadlines} ${t('dashboard.statTodayDeadlinesSub')}`}
              accentColor={stats.overdueDeadlines > 0 ? 'var(--status-failed)' : 'var(--accent-warm)'}
              onClick={() => goPapers({ deadlineStatus: 'overdue' })}
              clickLabel={t('dashboard.sectionNeedAttention')}
            />
          </div>

          {/* ── Secondary Data ── */}
          <div className="dash-metrics-secondary">
            <SecondaryStat label={t('dashboard.statAvgRating')} value={stats.avgRating} onClick={() => goPapers()} />
            <SecondaryStat label={t('dashboard.statUniqueTags')} value={stats.totalTags} onClick={() => goPapers()} />
            <SecondaryStat label={t('dashboard.statNotes')} value={stats.totalNotes} onClick={goNotes} />
            <SecondaryStat label={t('dashboard.statHighRated')} value={stats.highRatedPapers} onClick={() => goPapers({ minRating: 4 })} />
            <SecondaryStat label={t('dashboard.statHighPriority')} value={stats.highPriorityPapers} onClick={() => goPapers({ priority: 'high' })} />
            <SecondaryStat label={t('dashboard.statUnreadPapers')} value={stats.unreadPapers} onClick={() => goPapers({ readStatus: 'unread' })} />
            <SecondaryStat label={t('dashboard.statReadingStreak')} value={stats.readingStreak} onClick={() => goPapers({ readStatus: 'read' })} />
            <SecondaryStat label={t('dashboard.statFavorites')} value={stats.starredItems} onClick={() => goPapers({ starred: true })} />
            <SecondaryStat label={t('dashboard.statOverdueDeadlines')} value={stats.overdueDeadlines} onClick={() => goPapers({ deadlineStatus: 'overdue' })} />
            <SecondaryStat label={t('dashboard.statTodayDeadlines')} value={stats.todayDeadlines} onClick={() => goPapers({ deadlineStatus: 'today' })} />
            <SecondaryStat label={t('dashboard.statUpcomingDeadlines')} value={stats.upcomingDeadlines} onClick={() => goPapers({ deadlineStatus: 'upcoming' })} />
            <SecondaryStat label={t('dashboard.statAvgReadingProgress')} value={`${stats.avgReadingProgress}%`} onClick={() => goPapers()} />
            <SecondaryStat label={t('dashboard.statArchivedPapers')} value={stats.archivedPapers} onClick={() => goPapers({ archived: true })} />
            {artifactStats && (
              <SecondaryStat
                label={t('dashboard.statArtifacts')}
                value={`${artifactStats.total}（${t('dashboard.statArtifactsPending', { count: artifactStats.pending })}）`}
                // 任务4 dead-id 收敛：旧 'artifacts' 页面 id 从未实现路由（点击静默落空），
                // 成果的用户目的地是成果工作台。
                onClick={() => onNavigate?.('outcomes')}
              />
            )}
          </div>

          {/* ── Deadline Alerts ── */}
          {deadlineAlerts.length > 0 && (
            <DashSection title={t('dashboard.sectionDeadlineAlerts')}>
              <ul className="dash-list">
                {deadlineAlerts.map(({ paper, diff, status }) => {
                  const color = status === 'overdue' ? 'var(--status-failed)' : status === 'today' ? 'var(--accent-warm)' : (chartColors[4] ?? 'var(--chart-5)');
                  const label = status === 'overdue' ? t('papers.deadlineOverdue') : status === 'today' ? t('papers.deadlineToday') : t('dashboard.deadlineInDays', { days: diff });
                  return <ListItem key={paper.id} markerColor={color} text={paper.title} meta={`${label} · ${paper.deadline ?? ''}`} onClick={() => openPaper(paper.id)} ariaLabel={`${label}: ${paper.title}`} />;
                })}
              </ul>
            </DashSection>
          )}

          {/* ── Charts ── */}
          <div className="dash-charts-row">
            <div className="dash-chart">
              <h3>{t('dashboard.chartPaperActivity')}</h3>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={activityData}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis dataKey="day" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} /><YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} allowDecimals={false} /><Tooltip /><Bar dataKey="papers" fill={chartColors[0]} radius={[2, 2, 0, 0]} /></BarChart>
              </ResponsiveContainer>
            </div>
            <div className="dash-chart">
              <h3>{t('dashboard.chartReadingActivity')}</h3>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={readingActivityData}><CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis dataKey="day" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} /><YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} allowDecimals={false} /><Tooltip /><Line type="monotone" dataKey="read" stroke={chartColors[5]} strokeWidth={1.5} dot={{ r: 3, fill: chartColors[5] }} /></LineChart>
              </ResponsiveContainer>
            </div>
            <div className="dash-chart">
              <h3>{t('dashboard.chartPapersByYear')}</h3>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={yearData}><XAxis dataKey="year" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} /><YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} allowDecimals={false} /><Tooltip /><Bar dataKey="count" fill={chartColors[1]} radius={[2, 2, 0, 0]} /></BarChart>
              </ResponsiveContainer>
            </div>
            <div className="dash-chart">
              <h3>{t('dashboard.chartTagDistribution')}</h3>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart><Pie data={tagData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={65}>{tagData.map((_, i) => <Cell key={i} fill={chartColors[i % chartColors.length]} />)}</Pie><Tooltip /></PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* ── Reading Calendar ── */}
          <DashSection title={t('dashboard.sectionReadingCalendar')}>
            <div className="dash-calendar-grid">
              {readingCalendarDays.map((day) => {
                const intensity = Math.min(1, day.count / 3);
                return <div key={day.date} className="dash-calendar-cell" title={t('dashboard.readingCalendarCount', { date: day.label, count: day.count })} style={{ background: day.count > 0 ? `color-mix(in srgb, var(--status-completed) ${Math.round(15 + intensity * 85)}%, transparent)` : 'var(--bg-hover)' }} />;
              })}
            </div>
          </DashSection>

          {/* ── Recent Papers ── */}
          <div className="dash-charts-row">
            {recentPapers.length > 0 && (
              <DashSection title={t('dashboard.sectionRecentAdditions')}>
                <ul className="dash-list">
                  {recentPapers.map((p) => <ListItem key={p.id} markerColor={chartColors[1]} text={p.title} meta={String(p.year)} onClick={() => openPaper(p.id)} />)}
                </ul>
              </DashSection>
            )}
            {recentlyReadPapers.length > 0 && (
              <DashSection title={t('dashboard.sectionRecentlyRead')}>
                <ul className="dash-list">
                  {recentlyReadPapers.map((p) => <ListItem key={p.id} markerColor={chartColors[5]} text={p.title} meta={p.year ? String(p.year) : undefined} onClick={() => openPaper(p.id)} />)}
                </ul>
              </DashSection>
            )}
          </div>

          {/* ── Recent Notes + Experiments ── */}
          <div className="dash-charts-row">
            {recentNotes.length > 0 && (
              <DashSection title={t('dashboard.sectionRecentNotes')}>
                <ul className="dash-list">
                  {recentNotes.map((n) => <ListItem key={n.id} markerColor={chartColors[2]} text={n.title} onClick={() => openNote(n.id)} />)}
                </ul>
              </DashSection>
            )}
            {recentExperiments.length > 0 && (
              <DashSection title={t('dashboard.sectionRecentExperiments')}>
                <ul className="dash-list">
                  {recentExperiments.map((e) => <ListItem key={e.id} markerColor={chartColors[3]} text={e.name} meta={e.status} onClick={() => openExperiment(e.name)} />)}
                </ul>
              </DashSection>
            )}
          </div>

          {/* ── Tag Cloud ── */}
          {tagCloud.length > 0 && (
            <DashSection title={t('dashboard.sectionTagCloud')}>
              <div className="dash-tag-cloud">
                {tagCloud.map(({ name, count, weight }) => (
                  <button key={name} className="dash-tag" type="button" style={{ fontSize: `${0.7 + weight * 0.45}rem` }} onClick={() => { setPaperFilter({ tag: name }); onNavigate?.('pdf'); }} title={t('dashboard.tagCount', { count })}>{name}</button>
                ))}
              </div>
            </DashSection>
          )}

          {/* ── Random Pick ── */}
          <DashSection title={t('dashboard.sectionRandomPick')}>
            {unreadPapers.length > 0 ? (
              <div className="dash-random-pick">
                <p>{t('dashboard.randomPickDescription', { count: unreadPapers.length })}</p>
                <Button variant="primary" type="button" onClick={() => {
                  const idx = Math.floor(Math.random() * unreadPapers.length);
                  const p = unreadPapers[idx];
                  if (p) openPaper(p.id);
                }}>{t('dashboard.randomPickButton')}</Button>
              </div>
            ) : (
              <p className="dash-empty-text">{t('dashboard.noUnreadPapers')}</p>
            )}
          </DashSection>

          {/* ── Favorites ── */}
          {favoriteItems.length > 0 && (
            <DashSection title={t('dashboard.sectionFavorites')}>
              <ul className="dash-list">
                {favoriteItems.map((item) => <ListItem key={`${item.type}-${item.id}`} markerColor={item.type === 'paper' ? chartColors[0] : item.type === 'note' ? chartColors[2] : chartColors[3]} text={item.title} meta={item.type} onClick={item.onClick} ariaLabel={item.ariaLabel} />)}
              </ul>
            </DashSection>
          )}

          {/* ── Reading Progress Pie ── */}
          {readStatusData.length > 0 && (
            <div className="dash-charts-row">
              <div className="dash-chart">
                <h3>{t('dashboard.chartReadingProgress')}</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart><Pie data={readStatusData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label={({ name, value }) => `${name}: ${value}`}>{readStatusData.map((entry) => <Cell key={entry.name} fill={statusColors[entry.name as ReadStatus]} />)}</Pie><Tooltip /></PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* ── Quick Actions ── */}
          <div className="dash-actions">
            <Button variant="primary" onClick={() => onNavigate?.('pdf')}>{t('dashboard.actionOpenPapers')}</Button>
            <Button variant="secondary" onClick={() => onNavigate?.('notes')}>{t('dashboard.actionOpenNotes')}</Button>
            <Button variant="secondary" onClick={() => onNavigate?.('timeline')}>{t('dashboard.actionOpenTimeline')}</Button>
          </div>
    </div>
  );
}
