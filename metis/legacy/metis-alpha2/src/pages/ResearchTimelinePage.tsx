/**
 * Research Timeline Page — visualizes research activity over time.
 *
 * Features:
 *   - Chronological timeline of paper additions, notes, and experiments
 *   - Filterable by type (paper, note, experiment) and date range
 *   - Activity heat map (monthly research intensity)
 *   - Milestone markers for key research events
 *   - Recharts-based trend visualization
 *   - All colors use CSS variables for light/dark theme support.
 */

import React, { useMemo, useState, useEffect, Fragment } from 'react';
import {
  XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend,
  BarChart, Bar, CartesianGrid, AreaChart, Area,
} from 'recharts';
import { useMetisStore, type PaperItem, type NoteItem, type ExperimentItem } from '../store';
import { useTranslation } from '../i18n';

// ─── Types ──────────────────────────────────────────────────────

type TimelineEventType = 'paper' | 'note' | 'experiment';

interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  title: string;
  description: string;
  timestamp: number;
  meta?: Record<string, unknown>;
}

type DateRange = '1w' | '1m' | '3m' | '6m' | '1y' | 'all';

// ─── CSS Variable → Resolved Color Hook ─────────────────────────

const CHART_CSS_VARS = ['--chart-1', '--chart-2', '--chart-3'];
const CHART_FALLBACKS = ['#3b82f6', '#8b5cf6', '#22c55e'];

function useChartColors(): string[] {
  const [colors, setColors] = useState<string[]>(CHART_FALLBACKS);

  useEffect(() => {
    function readColors() {
      const s = getComputedStyle(document.documentElement);
      const resolved = CHART_CSS_VARS.map((name, i) => {
        const v = s.getPropertyValue(name).trim();
        return v || CHART_FALLBACKS[i]!;
      });
      setColors(resolved);
    }
    readColors();
    const observer = new MutationObserver(readColors);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return colors;
}

const TYPE_CSS_VARS: Record<TimelineEventType, string> = {
  paper: 'var(--chart-1)',
  note: 'var(--chart-2)',
  experiment: 'var(--status-completed)',
};

const TYPE_ICONS: Record<TimelineEventType, React.ReactNode> = {
  paper: (
    <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </svg>
  ),
  note: (
    <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  ),
  experiment: (
    <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3h6v7l4 8H5l4-8V3z" />
      <line x1="9" y1="3" x2="15" y2="3" />
    </svg>
  ),
};

// ─── Helpers ────────────────────────────────────────────────────

/** Parse a hex/rgb color string to [r, g, b] for dynamic alpha construction */
function parseRgb(color: string): [number, number, number] {
  const hex = color.replace('#', '');
  if (hex.length === 6) {
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return [parseInt(m[1]!), parseInt(m[2]!), parseInt(m[3]!)];
  return [99, 102, 241]; // safe fallback
}

function formatRelativeTime(ts: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  const diff = new Date().getTime() - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t('timeline.relativeJustNow');
  if (minutes < 60) return t('timeline.relativeMinutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('timeline.relativeHoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('timeline.relativeDaysAgo', { count: days });
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return t('timeline.relativeWeeksAgo', { count: weeks });
  return new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getDateRangeMs(range: DateRange, now: number): number {
  switch (range) {
    case '1w': return now - 7 * 86400000;
    case '1m': return now - 30 * 86400000;
    case '3m': return now - 90 * 86400000;
    case '6m': return now - 180 * 86400000;
    case '1y': return now - 365 * 86400000;
    case 'all': return 0;
  }
}

// ─── Build Timeline Events ──────────────────────────────────────

function buildEvents(
  papers: PaperItem[],
  notes: NoteItem[],
  experiments: ExperimentItem[],
  unknownAuthorLabel: string,
  now: number,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const paper of papers) {
    events.push({
      id: `paper-${paper.id}`,
      type: 'paper',
      title: paper.title,
      description: `${paper.authors[0] ?? unknownAuthorLabel} · ${paper.year} · ${paper.venue}`,
      timestamp: paper.addedAt,
      meta: { tags: paper.tags, rating: paper.rating, readStatus: paper.readStatus },
    });
  }

  for (const note of notes) {
    events.push({
      id: `note-${note.id}`,
      type: 'note',
      title: note.title,
      description: note.content.slice(0, 100) + (note.content.length > 100 ? '...' : ''),
      timestamp: note.updatedAt,
      meta: { tags: note.tags, linkedPapers: note.linkedPaperIds.length },
    });
  }

  for (const exp of experiments) {
    events.push({
      id: `exp-${exp.id}`,
      type: 'experiment',
      title: exp.name,
      description: exp.description,
      timestamp: exp.createdAt ?? now,
      meta: { status: exp.status, tags: exp.tags },
    });
  }

  return events.sort((a, b) => b.timestamp - a.timestamp);
}

// ─── Activity Aggregation ───────────────────────────────────────

function aggregateByMonth(events: TimelineEvent[]): Array<{ month: string; papers: number; notes: number; experiments: number; total: number }> {
  const monthMap = new Map<string, { papers: number; notes: number; experiments: number }>();

  for (const event of events) {
    const date = new Date(event.timestamp);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const entry = monthMap.get(key) ?? { papers: 0, notes: 0, experiments: 0 };
    entry[event.type === 'paper' ? 'papers' : event.type === 'note' ? 'notes' : 'experiments']++;
    monthMap.set(key, entry);
  }

  return [...monthMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, counts]) => ({ month, ...counts, total: counts.papers + counts.notes + counts.experiments }));
}

function aggregatePapersByYear(papers: PaperItem[]): Array<{ year: string; count: number }> {
  const map = new Map<string, number>();
  for (const paper of papers) {
    const key = String(paper.year);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([year, count]) => ({ year, count }));
}

function aggregateReadingStatus(papers: PaperItem[]): Array<{ name: string; value: number }> {
  const map = new Map<string, number>();
  for (const paper of papers) {
    map.set(paper.readStatus, (map.get(paper.readStatus) ?? 0) + 1);
  }
  return [...map.entries()].map(([name, value]) => ({ name, value }));
}

function aggregateRatingDistribution(papers: PaperItem[]): Array<{ rating: string; count: number }> {
  const map = new Map<number, number>();
  for (const paper of papers) {
    if (paper.rating > 0) {
      map.set(paper.rating, (map.get(paper.rating) ?? 0) + 1);
    }
  }
  return [...map.entries()].sort(([a], [b]) => a - b).map(([rating, count]) => ({ rating: String(rating), count }));
}

function aggregateTopTags(papers: PaperItem[], limit = 10): Array<{ tag: string; count: number }> {
  const map = new Map<string, number>();
  for (const paper of papers) {
    for (const tag of paper.tags) {
      map.set(tag, (map.get(tag) ?? 0) + 1);
    }
  }
  return [...map.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([tag, count]) => ({ tag, count }));
}

function aggregateByWeek(events: TimelineEvent[], now: number): Array<{ week: string; count: number }> {
  const weekMap = new Map<string, number>();

  // Generate last 12 weeks
  for (let i = 11; i >= 0; i--) {
    const weekStart = now - i * 7 * 86400000;
    const weekEnd = weekStart + 7 * 86400000;
    const label = `W${12 - i}`;
    const count = events.filter((e) => e.timestamp >= weekStart && e.timestamp < weekEnd).length;
    weekMap.set(label, count);
  }

  return [...weekMap.entries()].map(([week, count]) => ({ week, count }));
}

function buildHeatmapData(events: TimelineEvent[]): Array<{ day: string; hour: number; count: number }> {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const cells: Array<{ day: string; hour: number; count: number }> = [];

  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const count = events.filter((e) => {
        const date = new Date(e.timestamp);
        return date.getDay() === d && date.getHours() === h;
      }).length;
      const dayName = dayNames[d];
      if (dayName === undefined) continue;
      cells.push({ day: dayName, hour: h, count });
    }
  }

  return cells;
}

// ─── Timeline Event Card ────────────────────────────────────────

function TimelineCard({ event, t }: { event: TimelineEvent; t: (key: string, params?: Record<string, string | number>) => string }) {
  const color = TYPE_CSS_VARS[event.type];
  const icon = TYPE_ICONS[event.type];

  return (
    <div className="timeline-event">
      <div className="timeline-event-icon" style={{ border: `2px solid ${color}` }}>
        {icon}
      </div>
      <div className="timeline-event-body">
        <div className="timeline-event-top">
          <div className="timeline-event-title">{event.title}</div>
          <div className="timeline-event-time">{formatRelativeTime(event.timestamp, t)}</div>
        </div>
        <div className="timeline-event-desc">{event.description}</div>
        {(() => {
          const tags = event.meta?.tags;
          if (!tags || !Array.isArray(tags) || tags.length === 0) return null;
          return (
            <div className="timeline-event-tags">
              {(tags as string[]).slice(0, 4).map((tag: string) => (
                <span key={tag} className="timeline-tag">{tag}</span>
              ))}
            </div>
          );
        })()}
        {event.type === 'paper' && typeof event.meta?.rating === 'number' && (event.meta as { rating: number }).rating > 0 && (
          <div className="rating-display" style={{ marginTop: 2 }}>
            {Array.from({ length: 5 }, (_, i) => (
              <span key={i} className={`rating-dot ${i < (event.meta as { rating: number }).rating ? 'filled' : ''}`} />
            ))}
          </div>
        )}
        {event.type === 'experiment' && typeof event.meta?.status === 'string' && (
          <span className={`status-mini ${event.meta.status === 'completed' ? 'completed' : event.meta.status === 'running' ? 'running' : 'other'}`}>
            {event.meta.status}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Main Page Component ────────────────────────────────────────

export default function ResearchTimelinePage() {
  const { papers, notes, experiments } = useMetisStore();
  const { t } = useTranslation();
  const [dateRange, setDateRange] = useState<DateRange>('3m');
  const [typeFilter, setTypeFilter] = useState<Set<TimelineEventType>>(new Set(['paper', 'note', 'experiment']));
  const [searchQuery, setSearchQuery] = useState('');
  const chartColors = useChartColors();
  const [now] = useState(() => Date.now());

  const allEvents = useMemo(() => buildEvents(papers, notes, experiments, t('papers.unknownAuthor'), now), [papers, notes, experiments, t, now]);
  const heatmapRgb = useMemo(() => parseRgb(chartColors[0] ?? '#3b82f6'), [chartColors]);

  const filteredEvents = useMemo(() => {
    const rangeStart = getDateRangeMs(dateRange, now);
    return allEvents.filter((e) => {
      if (!typeFilter.has(e.type)) return false;
      if (rangeStart > 0 && e.timestamp < rangeStart) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!e.title.toLowerCase().includes(q) && !e.description.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [allEvents, dateRange, typeFilter, searchQuery, now]);

  // Stats
  const stats = useMemo(() => {
    const rangeStart = getDateRangeMs(dateRange, now);
    const inRange = allEvents.filter((e) => rangeStart === 0 || e.timestamp >= rangeStart);
    const referenceTime = rangeStart > 0 ? rangeStart : (allEvents[allEvents.length - 1]?.timestamp ?? now);
    return {
      total: inRange.length,
      papers: inRange.filter((e) => e.type === 'paper').length,
      notes: inRange.filter((e) => e.type === 'note').length,
      experiments: inRange.filter((e) => e.type === 'experiment').length,
      avgPerWeek: inRange.length > 0
        ? (inRange.length / Math.max(1, Math.ceil((now - referenceTime) / (7 * 86400000)))).toFixed(1)
        : '0',
    };
  }, [allEvents, dateRange, now]);

  // Chart data
  const monthlyData = useMemo(() => aggregateByMonth(allEvents), [allEvents]);
  const weeklyData = useMemo(() => aggregateByWeek(allEvents, now), [allEvents, now]);
  const heatmapData = useMemo(() => buildHeatmapData(allEvents), [allEvents]);
  const papersByYear = useMemo(() => aggregatePapersByYear(papers), [papers]);
  const readingStatusData = useMemo(() => aggregateReadingStatus(papers), [papers]);
  const ratingDistributionData = useMemo(() => aggregateRatingDistribution(papers), [papers]);
  const topTagsData = useMemo(() => aggregateTopTags(papers), [papers]);

  // Find latest activity streak
  const streakDays = useMemo(() => {
    if (allEvents.length === 0) return 0;
    const now = new Date();
    let streak = 0;
    for (let i = 0; i < 365; i++) {
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i).getTime();
      const dayEnd = dayStart + 86400000;
      const hasActivity = allEvents.some((e) => e.timestamp >= dayStart && e.timestamp < dayEnd);
      if (hasActivity) streak++;
      else if (i > 0) break; // allow today to have no activity yet
    }
    return streak;
  }, [allEvents]);

  // Group events by date for timeline display
  const groupedEvents = useMemo(() => {
    const groups = new Map<string, TimelineEvent[]>();
    for (const event of filteredEvents) {
      const dateKey = formatDate(event.timestamp);
      const group = groups.get(dateKey) ?? [];
      group.push(event);
      groups.set(dateKey, group);
    }
    return [...groups.entries()];
  }, [filteredEvents]);

  const toggleType = (type: TimelineEventType) => {
    setTypeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <h2>{t('timeline.pageTitle')}</h2>
        <div className="timeline-filters">
          <input
            type="text"
            className="timeline-filter-search"
            placeholder={t('timeline.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {(['1w', '1m', '3m', '6m', '1y', 'all'] as DateRange[]).map((r) => (
            <button
              key={r}
              className={`btn-toggle ${dateRange === r ? 'active' : ''}`}
              onClick={() => setDateRange(r)}
            >
              {r === 'all' ? t('timeline.dateRangeAll') : r.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Stat Cards */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-card-label">{t('timeline.statActivities')}</div>
          <div className="stat-card-value" style={{ color: 'var(--chart-1)' }}>{stats.total}</div>
          <div className="stat-card-sub">{dateRange === 'all' ? t('timeline.statLastAll') : t('timeline.statLastRange', { range: dateRange })}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">{t('timeline.statPapersAdded')}</div>
          <div className="stat-card-value" style={{ color: 'var(--chart-1)' }}>{stats.papers}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">{t('timeline.statNotesWritten')}</div>
          <div className="stat-card-value" style={{ color: 'var(--chart-2)' }}>{stats.notes}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">{t('timeline.statExperiments')}</div>
          <div className="stat-card-value" style={{ color: 'var(--status-completed)' }}>{stats.experiments}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">{t('timeline.statActivityStreak')}</div>
          <div className="stat-card-value" style={{ color: 'var(--accent-warm)' }}>{streakDays}d</div>
          <div className="stat-card-sub">{t('timeline.statConsecutiveDays')}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-label">{t('timeline.statAvgPerWeek')}</div>
          <div className="stat-card-value" style={{ color: 'var(--accent-cool)' }}>{stats.avgPerWeek}</div>
          <div className="stat-card-sub">{t('timeline.statResearchActivities')}</div>
        </div>
      </div>

      {allEvents.length === 0 ? (
        <div className="empty-state">
          <h3>{t('timeline.emptyTitle')}</h3>
          <p>{t('timeline.emptyDescription')}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 20 }}>
          {/* Left: Charts */}
          <div style={{ flex: '1 1 50%', minWidth: 0 }}>
            {/* Monthly Activity Trend */}
            {monthlyData.length > 0 && (
              <div className="chart-card" style={{ marginBottom: 16 }}>
                <h3>{t('timeline.chartMonthlyActivity')}</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={monthlyData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Area type="monotone" dataKey="papers" stackId="1" stroke={chartColors[0]} fill={`${chartColors[0]}20`} />
                    <Area type="monotone" dataKey="notes" stackId="1" stroke={chartColors[1]} fill={`${chartColors[1]}20`} />
                    <Area type="monotone" dataKey="experiments" stackId="1" stroke={chartColors[2]} fill={`${chartColors[2]}20`} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Papers by Year */}
            {papersByYear.length > 0 && (
              <div className="chart-card" style={{ marginBottom: 16 }}>
                <h3>{t('timeline.chartPapersByYear')}</h3>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={papersByYear}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="year" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Bar dataKey="count" fill={chartColors[0]} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Weekly Activity */}
            <div className="chart-card" style={{ marginBottom: 16 }}>
              <h3>{t('timeline.chartWeeklyActivity')}</h3>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={weeklyData}>
                  <XAxis dataKey="week" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Bar dataKey="count" fill={chartColors[1]} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Reading Status */}
            {papers.length > 0 && (
              <div className="chart-card" style={{ marginBottom: 16 }}>
                <h3>{t('timeline.chartReadingStatus')}</h3>
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie data={readingStatusData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={60} label>
                      {readingStatusData.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={chartColors[index % chartColors.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Rating Distribution */}
            {ratingDistributionData.length > 0 && (
              <div className="chart-card" style={{ marginBottom: 16 }}>
                <h3>{t('timeline.chartRatingDistribution')}</h3>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={ratingDistributionData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="rating" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip />
                    <Bar dataKey="count" fill={chartColors[2]} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Top Tags */}
            {topTagsData.length > 0 && (
              <div className="chart-card" style={{ marginBottom: 16 }}>
                <h3>{t('timeline.chartTopTags')}</h3>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={topTagsData} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" tick={{ fontSize: 10 }} />
                    <YAxis dataKey="tag" type="category" tick={{ fontSize: 10 }} width={100} />
                    <Tooltip />
                    <Bar dataKey="count" fill={chartColors[0]} radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Activity Heatmap */}
            {heatmapData.some((c) => c.count > 0) && (
              <div className="chart-card">
                <h3>{t('timeline.chartActivityHeatmap')}</h3>
                <div className="heatmap-grid">
                  {/* Header: hours */}
                  <div />
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="heatmap-hour-label">{h}</div>
                  ))}
                  {/* Rows: days */}
                  {(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const).map((day) => (
                    <Fragment key={day}>
                      <div className="heatmap-day-label">
                        {t(`timeline.day${day}` as 'timeline.daySun')}
                      </div>
                      {Array.from({ length: 24 }, (_, h) => {
                        const cell = heatmapData.find((c) => c.day === day && c.hour === h);
                        const count = cell?.count ?? 0;
                        const maxCount = Math.max(...heatmapData.map((c) => c.count), 1);
                        const intensity = count / maxCount;
                        return (
                          <div
                            key={`${day}-${h}`}
                            className="heatmap-cell"
                            style={{
                              background: count === 0 ? 'var(--bg-hover)' : `rgba(${heatmapRgb[0]}, ${heatmapRgb[1]}, ${heatmapRgb[2]}, ${0.15 + intensity * 0.85})`,
                              color: intensity > 0.5 ? 'var(--text-on-primary)' : 'var(--text-secondary)',
                            }}
                            title={t('timeline.heatmapCellTitle', { day: t(`timeline.day${day}` as 'timeline.daySun'), hour: h, count })}
                          >
                            {count > 0 ? count : ''}
                          </div>
                        );
                      })}
                    </Fragment>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right: Timeline Feed */}
          <div style={{ flex: '1 1 50%', minWidth: 0 }}>
            {/* Type Filter */}
            <div className="timeline-type-filter">
              {(['paper', 'note', 'experiment'] as TimelineEventType[]).map((type) => (
                <button
                  key={type}
                  className={`btn-toggle ${typeFilter.has(type) ? 'active' : ''}`}
                  onClick={() => toggleType(type)}
                  style={typeFilter.has(type) ? { background: TYPE_CSS_VARS[type], borderColor: 'transparent' } : undefined}
                >
                  {TYPE_ICONS[type]} {t(`timeline.filter${type.charAt(0).toUpperCase()}${type.slice(1)}s` as 'timeline.filterPapers')}
                </button>
              ))}
              <span className="timeline-event-count">
                {t('timeline.eventCount', { count: filteredEvents.length })}
              </span>
            </div>

            {/* Timeline */}
            <div style={{ maxHeight: 'calc(100vh - 380px)', overflowY: 'auto', paddingRight: 8 }}>
              {filteredEvents.length === 0 ? (
                <div className="empty-state">
                  {t('timeline.noFilterResults')}
                </div>
              ) : (
                groupedEvents.map(([date, events]) => (
                  <div key={date} style={{ marginBottom: 16 }}>
                    <div className="timeline-date-header">{date}</div>
                    {events.map((event) => (
                      <TimelineCard key={event.id} event={event} t={t} />
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
